import path from 'node:path';
import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  stat,
  rm,
  realpath,
  readlink,
} from 'node:fs/promises';
import { resolveInside, samePath, toPosix } from '../lib/paths.js';
import { splitLines, sliceLineRange, lineSpan, type Span } from '../lib/lines.js';
import { FileRevisionTracker } from './fileRevisions.js';
import { ASSET_EXT, MAX_BINARY_READ_BYTES } from '../lib/assets.js';
import { changedPath } from '../lib/changeDiff.js';

/** Error thrown when a mutating op would overwrite a file changed on disk since it was last seen. */
export class ExternalChangeError extends Error {
  constructor(relPath: string) {
    super(
      `"${relPath}" changed on disk since it was last read through this server — it was likely ` +
        `edited directly. Re-read it to see the current content before writing, or pass ` +
        `overrideExternalChanges: true to overwrite those changes.`,
    );
    this.name = 'ExternalChangeError';
  }
}

export type FileFilter = 'tex' | 'bib' | 'docs' | 'assets' | 'all';
export type FileType = 'tex' | 'bib' | 'doc' | 'asset' | 'other';

export interface FileEntry {
  path: string;
  type: FileType;
  sizeBytes: number;
}

export interface ReadResult {
  path: string;
  content: string;
  totalLines: number;
  truncated: boolean;
  note?: string;
}

export interface WriteResult {
  path: string;
  bytesWritten: number;
  created: boolean;
}

export interface EditOp {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  /**
   * Skip matches that sit in a comment. `applyEdits` itself has no idea what a comment is — it
   * consults `opts.excludeMatch` for every candidate match of an edit carrying this flag, and
   * **refuses the call outright** when the flag is set and no such filter was supplied, rather
   * than silently replacing the matches the caller asked to be left alone.
   */
  excludeComments?: boolean;
}

/**
 * The other shape an edit can take: replace lines `startLine..endLine` outright, whatever they
 * say. The counterpart to `read_file`'s `startLine`/`endLine`, for a change defined by *where* it
 * is rather than *what* it says — otherwise the caller has to ship the whole block twice, once as
 * `oldString` and once as `newString`.
 *
 * Numbering matches `read_file` exactly: **1-based, `endLine` inclusive**. The replaced span runs
 * from the first character of `startLine` to the last character of `endLine`, and **excludes the
 * line terminator that ends `endLine`** — the range is those lines, not the newline after them
 * (see `lineSpan`, which also notes the one place this differs from `sliceLineRange`).
 *
 * Line numbers are resolved against the file **as it was when the call began** — the content
 * `read_file` handed the caller — never against the intermediate state left by an earlier edit in
 * the same `edits` array. See `applyEdits` for how an overlap between the two is refused instead
 * of applied to shifted text.
 */
export interface RangeEditOp {
  startLine: number;
  endLine: number;
  newString: string;
}

/** Either shape of edit, as `applyEdits` accepts them in one array. */
export type AnyEditOp = EditOp | RangeEditOp;

/** Narrow an edit to the line-range shape. The two shapes share no required field, and the tool
 * layer's schema rejects an object carrying both, so the presence of `startLine` decides. */
export function isRangeEdit(edit: AnyEditOp): edit is RangeEditOp {
  return 'startLine' in edit;
}

/** Per-edit accounting for an edit that set `excludeComments`, so a caller is always told when
 * the server did less than the edit literally asked for. `edit` is 1-based, matching the numbers
 * in this method's error messages. */
export interface CommentMatchReport {
  edit: number;
  replaced: number;
  skippedInComments: number;
}

export interface ApplyEditsResult {
  path: string;
  appliedEdits: number;
  /** One entry per edit that set `excludeComments`, in edit order; absent when no edit did. */
  commentMatches?: CommentMatchReport[];
}

/**
 * The structural shape `applyEdits` needs from a rewrite-preservation hook: a callback that
 * rewrites the replacement text for one match, plus an accessor reporting — for the *most
 * recent* `transform()` call only — whether (and how much of) its returned string begins with a
 * preserved comment block. `src/lib/rewriteMode.ts`'s `PreserveTransform` satisfies this
 * structurally (it carries one more field, `preservedEdits`, that `applyEdits` never looks at).
 *
 * `lastInsertion()` reports only the latest call's result, never a cumulative ledger: the ledger
 * of already-preserved ranges — used to refuse a later edit in the same call that only matches
 * dead, already-commented-out text — is owned entirely by `applyEdits` itself, not by this hook.
 * `applyEdits` is the only code that knows every splice offset a call produces, including every
 * occurrence a `replaceAll` edit touches, so it is the only place that can keep that ledger
 * correctly shifted as edits apply. A hook that owned the ledger itself (an earlier shape of this
 * type did) went stale the moment a `replaceAll` edit spliced text without ever being routed
 * through the hook at all.
 *
 * Defined here — rather than importing `PreserveTransform` itself — so `FileService` never needs
 * to know anything about what a "preserved" block actually is (comment syntax, `%`-prefixing,
 * line alignment, …). It only ever sees a callback and integer offsets; the decision of *what* to
 * preserve and *how* to render it stays entirely in `src/lib/rewriteMode.ts`. Importing the real
 * type would work today, but it would tempt a future change to `PreserveTransform` to add a
 * comment-syntax-flavoured member that `FileService` would then transitively depend on.
 */
export interface EditTransform {
  /** Rewrite the replacement text for one (unique, non-`replaceAll`) match, given its position in
   * the file's *current* content. */
  transform: (edit: EditOp, matchIndex: number, content: string) => string;
  /** Length of the preserved comment block at the start of the string this hook's *most recent*
   * `transform()` call returned, or `undefined` if that call preserved nothing. Must be read
   * immediately after each `transform()` call and before the next one — it is not a ledger. */
  lastInsertion: () => number | undefined;
}
/**
 * Prose formats. Their own type because a document is not always LaTeX: a proposal drafted in
 * markdown still has a reference list to verify and citations to cross-check, and it has to be
 * findable to be worked on.
 */
const DOC_EXT = new Set(['.md', '.markdown', '.txt', '.rst', '.org']);

/**
 * The TEXT read cap. It governs `read`, which returns a note instead of the content above it, and
 * so is the limit the snippet readers over `read` live under: it stays small enough that a whole
 * file at the cap is still something a caller can be handed. (`readText` is deliberately uncapped —
 * it is the append/whole-file helper, and `list_references` reads through it, so neither is bounded
 * by this. Nothing here changes that either way.)
 *
 * Binary reads are capped separately and far more generously by `MAX_BINARY_READ_BYTES`
 * (`src/lib/assets.ts`), because anything `add_asset` was allowed to import has to be readable
 * back out again. The two are different limits, and a refusal names which one fired.
 */
export const MAX_READ_BYTES = 2 * 1024 * 1024;

/**
 * Notified of every mutation this server makes, with the working-tree content either side of it
 * (null meaning the file was absent). Lets the session's shadow of its own uncommitted work be
 * kept up to date without FileService knowing anything about sessions or git.
 *
 * `before`/`after` are `string | Buffer` because a binary file's shadow needs the raw bytes: a
 * UTF-8 round trip through a string would corrupt it (the same corruption `writeBytes` exists to
 * avoid on the write side).
 */
export interface MutationRecorder {
  record(
    projectDir: string,
    relPath: string,
    before: string | Buffer | null,
    after: string | Buffer | null,
  ): Promise<void>;
}

function classify(file: string): FileType {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.tex') return 'tex';
  if (ext === '.bib') return 'bib';
  if (DOC_EXT.has(ext)) return 'doc';
  if (ASSET_EXT.has(ext)) return 'asset';
  return 'other';
}

function matchesFilter(type: FileType, filter: FileFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'tex':
      return type === 'tex';
    case 'bib':
      return type === 'bib';
    case 'docs':
      return type === 'doc';
    case 'assets':
      return type === 'asset';
  }
}

/**
 * One surviving entry of `FileService.walk`: everything `list` needs except the size, which is
 * the one thing that costs a syscall. `sizeBytes` is already filled in for a symlinked file —
 * the walk had to `stat` it anyway to tell a file from a directory — and absent for a regular
 * file, whose `stat` `list` makes once the filter has already let it through.
 */
interface WalkCandidate {
  /** Project-relative, native separators; `list` converts to POSIX. */
  rel: string;
  /** Absolute, so `list` stats it without rebuilding the path. */
  full: string;
  type: FileType;
  sizeBytes?: number;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * Refuse a path that leaves the project **after symlinks are followed**. `resolveInside` compares
 * strings, which a symlink defeats: a `notes.tex` pointing at `~/.ssh/id_rsa` passes the string
 * check and hands back the key. That matters most for the paths the server picks up from a compile
 * log, which the document itself controls.
 *
 * This decides *whether* the file may be read; it deliberately does not decide what the file is
 * **called**. The resolved string stays a file's one identity everywhere — the revision tracker,
 * `write`, `applyEdits` and `delete` all key on it — because a read that filed its baseline under
 * the real path while a write looked it up under the given one silently disarmed the
 * out-of-band-edit guard on macOS (`/var` → `/private/var`) and Windows (8.3 short paths).
 */
async function assertNoSymlinkEscape(
  projectDir: string,
  abs: string,
  relPath: string,
): Promise<void> {
  const [realRoot, target] = await Promise.all([realpath(projectDir), resolveThroughLinks(abs)]);
  const rel = path.relative(realRoot, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the project root through a symlink: "${relPath}"`);
  }
}

/**
 * Where a path really lands, whether or not it exists yet. `realpath` alone cannot answer for a
 * file about to be created, and a **dangling** symlink is the case that matters most: `writeFile`
 * happily follows `notes.tex -> ~/.ssh/authorized_keys` and creates the file at the other end, so
 * the target has to be judged even when nothing is there yet.
 *
 * Resolution is followed all the way down on **both** branches. A link's target is itself a path
 * whose own components can be links: `notes.tex -> sub/pwned` with `sub -> /elsewhere` lands at
 * `/elsewhere/pwned`, and stopping at the literal target reported `<project>/sub/pwned` — inside
 * the project as a string, outside it as a file, which is exactly the confusion the whole check
 * exists to remove. A cycle surfaces as ELOOP from `realpath` and is thrown, not recursed into.
 */
async function resolveThroughLinks(abs: string): Promise<string> {
  try {
    return await realpath(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const link = await readlink(abs).catch(() => null);
  if (link !== null) return resolveThroughLinks(path.resolve(path.dirname(abs), link));
  const parent = path.dirname(abs);
  if (parent === abs) return abs;
  // Nothing at this name: resolve the part that does exist, then re-attach the rest literally.
  // `resolveInside` has already normalized the string, so no component can climb back out.
  return path.join(await resolveThroughLinks(parent), path.basename(abs));
}

/**
 * Turn a raw `ENOENT` from `writeFile` into an actionable error when it's caused by a missing
 * parent directory and the caller didn't pass `createDirs`. A bare `ENOENT: no such file or
 * directory, open '/abs/path/...'` names neither the missing directory nor the flag that fixes
 * it. Only fires when the parent really is missing and `createDirs` was not requested — a
 * different ENOENT (or one under `createDirs: true`, which means something else went wrong) must
 * propagate unchanged.
 */
async function translateMissingParentError(
  err: unknown,
  abs: string,
  projectDir: string,
  relPath: string,
  createDirs: boolean | undefined,
): Promise<never> {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !createDirs) {
    const parent = path.dirname(abs);
    const parentMissing = await stat(parent)
      .then(() => false)
      .catch(() => true);
    if (parentMissing) {
      const relParent = toPosix(path.relative(projectDir, parent));
      throw new Error(
        `cannot write "${relPath}": the parent directory "${relParent}" does not exist. ` +
          'Pass createDirs: true to create it.',
      );
    }
  }
  throw err;
}

/** Sandboxed file access within a project's clone directory. */
export class FileService {
  /** Tracks the last-seen content of each file so mutations can detect out-of-band edits. */
  private readonly revisions = new FileRevisionTracker();

  /** Optional; when absent, mutations simply aren't attributed to a session. */
  private recorder?: MutationRecorder;

  /**
   * Whether a project may follow a symlink its owner placed. Injected, because the answer is about
   * the project rather than the file — see {@link setLinkPolicy}.
   */
  private followsUserLinks: (projectDir: string) => boolean = () => false;

  /**
   * Set after construction because the recorder needs services that are built later (it resolves
   * a clone dir to a project and reads git HEAD). Every mutating method funnels through
   * `notify`, so this is the single seam where session attribution attaches.
   */
  setMutationRecorder(recorder: MutationRecorder): void {
    this.recorder = recorder;
  }

  /**
   * Decide, per project, whether a symlink inside it may be followed.
   *
   * The guard exists for paths the **user did not choose**: a `notes.tex -> ~/.ssh/id_rsa` a
   * collaborator committed into a shared repository (git stores a symlink as mode 120000), or a
   * file named by a compile log, which the document controls. So the default everywhere is to
   * refuse, and the exemption is something the project's owner **asserts** (`followSymlinks` on a
   * `mode: 'local'` project) rather than something inferred from how the directory came to exist —
   * a directory registered in place is usually a working tree with a remote, where the next pull
   * can bring in a link nobody here placed.
   *
   * Reads the server makes on its own initiative pass `strictLinks` and are refused regardless;
   * so is a path the server would hand back as openable — see {@link leavesProjectThroughLink}.
   */
  setLinkPolicy(followsUserLinks: (projectDir: string) => boolean): void {
    this.followsUserLinks = followsUserLinks;
  }

  /**
   * Whether `abs` no longer matches the baseline recorded for it — checked both as raw bytes and
   * as the UTF-8-decoded string, because the two representations record different baselines:
   * `writeBytes`/`readBytes` record a `Buffer` (a PNG is never valid UTF-8 both ways), while
   * `read`/`readText`/`write`/`applyEdits` record the lossily-decoded string. A file is only
   * stale when BOTH comparisons agree — otherwise a binary the server itself just wrote (compared
   * against a decoded-string rehash of its own bytes) or a latin-1 `.tex` it merely read would be
   * reported as edited by a human who never touched it. This is the single place every refusal
   * site (`write`, `writeBytes`, `applyEdits`, `delete`) goes through, so the two representations
   * can never again disagree about whether a file is stale.
   *
   * What this AND still gives up: an out-of-band edit is missed only when a Buffer baseline
   * holds a literal U+FFFD (EF BF BD) and the edit swaps those bytes for an invalid UTF-8
   * sequence, or a string baseline's file has bytes changed only within already-invalid UTF-8
   * sequences — both decode identically either way. Accepted as contrived; the second case was
   * already the behaviour back when only strings were compared.
   */
  private isChangedOnDisk(abs: string, bytes: Buffer): boolean {
    return (
      this.revisions.isStale(abs, bytes) && this.revisions.isStale(abs, bytes.toString('utf8'))
    );
  }

  /**
   * Whether `abs` counts as externally modified — checked both ways, like {@link isChangedOnDisk},
   * but via `isExternal` rather than `isStale`: `isExternal` treats "no baseline at all" as
   * changed, `isStale` does not. Keep that distinction — this is deliberately a separate method,
   * not a flag on `isChangedOnDisk`, so the "no baseline" case is never silently blended into the
   * refusal-site semantics (a file the server has never seen must never throw `ExternalChangeError`
   * on its own).
   */
  private isExternallyModified(abs: string, bytes: Buffer): boolean {
    return (
      this.revisions.isExternal(abs, bytes) &&
      this.revisions.isExternal(abs, bytes.toString('utf8'))
    );
  }

  /**
   * The symlink check, unless this project's owner has said its links are theirs. `strictLinks`
   * overrides that: every method takes it, so a read the *server* initiates and a write it makes
   * on a path it chose can both be held to the strict rule.
   */
  private async guardLinks(
    projectDir: string,
    abs: string,
    relPath: string,
    strictLinks = false,
  ): Promise<void> {
    if (!strictLinks && this.followsUserLinks(projectDir)) return;
    await assertNoSymlinkEscape(projectDir, abs, relPath);
  }

  /**
   * Whether a project-relative path lands **outside** the project once symlinks are followed.
   *
   * The question to ask before handing back a path the *document* named — a compile log, a synctex
   * record — as one the caller can open. Refusing the server's own read is only half the guard: a
   * location it reports is a location the caller reads next, so a guard that stops at the read
   * covers document-controlled *reads* rather than document-controlled *paths*.
   *
   * A path that was never inside the project (absolute, or climbing out with `..`) is not this:
   * every method here refuses it outright whatever the link policy, and a diagnostic in
   * `/usr/share/texlive/…/foo.sty` is still worth reporting. Anything this cannot resolve counts
   * as outside — the safe direction costs a path in the result, the other costs a file.
   */
  async leavesProjectThroughLink(projectDir: string, relPath: string): Promise<boolean> {
    let abs: string;
    try {
      abs = resolveInside(projectDir, relPath);
    } catch {
      return false; // never a project-relative path; not a link taking one out
    }
    try {
      await assertNoSymlinkEscape(projectDir, abs, relPath);
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Where a project-relative path is really called at the far end, once symlinks are followed —
   * `null` when the path lands exactly where its name says (the common case, no link involved).
   *
   * A name-based gate (`isBibFile`, the asset destination allowlist) only ever sees the name the
   * caller supplied. That is fine for a plain file, but a symlink committed *inside* the project
   * — `figures/x.png -> refs.bib` (git stores a symlink as mode 120000, so a collaborator can
   * commit one) — passes `assertNoSymlinkEscape` (it never leaves the project) while landing on a
   * file the gate would have refused had it seen that name. This tells the tool layer what to
   * judge instead: the resolved target, project-relative when it stays inside the project, or
   * absolute when it doesn't (reachable only under a local project's `followSymlinks`, since
   * `guardLinks` below refuses an escaping link outright otherwise).
   *
   * Decides nothing about *whether* the path may be used — `guardLinks` runs first, so an
   * escaping link is refused with the exact error a write would raise. And it does not change the
   * path's one identity for the revision tracker: the `resolveInside` string stays what every
   * read/write keys its baseline on (see `assertNoSymlinkEscape`'s doc comment). What it *does*
   * change is what name the mutation recorder is told — see {@link attributedPath} — so a write
   * through a tracked link is attributed to the file it actually changed, not the link's name.
   */
  async linkTarget(
    projectDir: string,
    relPath: string,
    strictLinks = false,
  ): Promise<string | null> {
    const abs = resolveInside(projectDir, relPath);
    await this.guardLinks(projectDir, abs, relPath, strictLinks);
    return this.resolveLinkTarget(projectDir, abs, relPath);
  }

  /**
   * Shared by {@link linkTarget} (name-based gates judge the far end) and {@link attributedPath}
   * (the mutation recorder is told the far end): where `abs` really lands, `null` when it lands
   * exactly where `relPath` says (no link involved).
   */
  private async resolveLinkTarget(
    projectDir: string,
    abs: string,
    relPath: string,
  ): Promise<string | null> {
    const target = await resolveThroughLinks(abs);
    const realRoot = await realpath(projectDir);
    // `target` comes back from `realpath` (on-disk casing); the expected side is built from the
    // caller's own spelling of `relPath`. A bare string compare mistakes a mere case mismatch
    // (macOS/Windows) for a link pointing somewhere else — samePath judges by where each side
    // actually lands.
    if (samePath(target, path.join(realRoot, relPath))) {
      return null;
    }
    const rel = path.relative(realRoot, target);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return toPosix(rel);
    }
    // Outside the project (only reachable under a local project's followSymlinks) — POSIX-ify so
    // it lands verbatim in tool text the same way every other path does.
    return toPosix(target);
  }

  /**
   * The name the mutation recorder should be told for a write that just happened through `abs`:
   * the in-project link target's project-relative name when `abs` is a link landing somewhere
   * other than `relPath`, else `relPath` itself (POSIX-ified) — the common case, no link
   * involved.
   *
   * `write`/`writeBytes`/`applyEdits` read and write through `abs`, which already followed any
   * link `guardLinks` allowed; without this they told the recorder the *link's* name, so the
   * shadow store three-way-merged the link's own target string (its blob content) against the
   * caller's text — a bogus conflict on every tracked link, and the real edit landing on nobody's
   * shadow at all (issue #66 item 4).
   *
   * When the target lands OUTSIDE the project (reachable only under a local project's
   * `followSymlinks`), this returns `relPath` unchanged: there is no shadow store for a local
   * project anyway (see CLAUDE.md's "Local projects never see git" bullet), and an absolute path
   * must never reach the recorder.
   *
   * `delete` uses a related but distinct helper, {@link attributedDeletePath}: unlike a write,
   * `rm(abs)` removes exactly the entry `abs` names, so when the link is relPath's FINAL
   * component the link itself is what disappears and the literal name is already correct — but an
   * ANCESTOR directory that is itself a link (`linkdir -> realdir`) means the bytes removed live
   * at `realdir/notes.tex`, not `linkdir/notes.tex`, so only the parent is resolved through links.
   */
  private async attributedPath(projectDir: string, abs: string, relPath: string): Promise<string> {
    // Called after the bytes are on disk, so it must not fail the write: for a git project
    // `guardLinks` resolved this same path before the write, but a local `followSymlinks` project
    // skips that, and an ELOOP/EACCES here would be the first resolution attempt — falling back to
    // the given name keeps the recorder call (and, on its failure, `markUnrecorded`) happening.
    let target: string | null;
    try {
      target = await this.resolveLinkTarget(projectDir, abs, relPath);
    } catch (err) {
      console.error(
        `[web-latex-mcp] could not resolve where "${relPath}" lands; attributing the change to ` +
          'that name as given:',
        err instanceof Error ? err.message : err,
      );
      target = null;
    }
    return changedPath(target, relPath);
  }

  /**
   * The name a deletion through `relPath` should be attributed to: the PARENT directory resolved
   * through links, joined with `relPath`'s literal basename — never the basename resolved through
   * a link of its own.
   *
   * `rm(abs)` removes exactly the entry `abs` names. When the link is relPath's *final* component
   * (`link.tex -> main.tex`), that entry is the link, so the correct attribution is the link's own
   * name — the parent resolves to `null` (no link above it) and this falls back to `relPath`. But
   * when an *ancestor* directory is the link (`linkdir -> realdir`), `rm(<project>/linkdir/notes.tex)`
   * removes `<project>/realdir/notes.tex` — a real file the shadow store must key on, or the next
   * session commit tries to stage a path beyond a symlink (`linkdir/notes.tex`), which `git
   * check-ignore`/`update-index` refuse outright, wedging the session (issue #66 item 6).
   *
   * Like {@link attributedPath}, this must never fail the delete: on a resolution error it logs one
   * `console.error` line and falls back to the given name.
   */
  private async attributedDeletePath(
    projectDir: string,
    abs: string,
    relPath: string,
  ): Promise<string> {
    const parentAbs = path.dirname(abs);
    // dirname(abs) for a top-level path is projectDir itself; the matching relative side is "." —
    // resolveLinkTarget treats that as "the root, unresolved" and correctly returns null.
    const relParent = path.posix.dirname(toPosix(relPath));
    let parentTarget: string | null;
    try {
      parentTarget = await this.resolveLinkTarget(projectDir, parentAbs, relParent);
    } catch (err) {
      console.error(
        `[web-latex-mcp] could not resolve where the parent directory of "${relPath}" lands; ` +
          'attributing the deletion to that name as given:',
        err instanceof Error ? err.message : err,
      );
      parentTarget = null;
    }
    if (parentTarget === null) return toPosix(relPath);
    const base = path.posix.basename(toPosix(relPath));
    const full = path.isAbsolute(parentTarget)
      ? parentTarget
      : toPosix(path.posix.join(parentTarget, base));
    return changedPath(full, relPath);
  }

  async list(
    projectDir: string,
    opts: { filter?: FileFilter; subdir?: string } = {},
  ): Promise<FileEntry[]> {
    const filter = opts.filter ?? 'all';
    const base = opts.subdir ? resolveInside(projectDir, opts.subdir) : path.resolve(projectDir);
    const collected: WalkCandidate[] = [];
    await this.walk(projectDir, base, filter, collected);
    const entries = await Promise.all(
      collected.map(async (c) => ({
        path: toPosix(c.rel),
        type: c.type,
        // A link's size came from the `stat` the walk had to make anyway to decide file-vs-dir;
        // a regular file is stat'd here, and only because it survived the filter. `??` (not `||`)
        // so a zero-byte link keeps its own size instead of paying a second syscall.
        sizeBytes: c.sizeBytes ?? (await stat(c.full)).size,
      })),
    );
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Read a file, or a line range of it.
   *
   * `recordBaseline` says whether **the caller could now base a write on this file**, and so
   * defaults to false. Record only when the caller asked for this file and received all of it:
   * `read_file` does, and `list_references` — but the latter only for a bibliography it returned
   * WHOLE. It used to hold this licence outright, on the premise that it hands back every entry
   * verbatim; #147 made `raw` cuttable, #165 the typed fields, and #170 dropped the default
   * `maxResults` to 50, so a 200-entry `.bib` now shows 50 entries. It therefore decides per file,
   * after its budgets have run, and claims only the files that shipped uncut (#171). Nothing else
   * qualifies — not a file the server chose for its own purposes (`detectRootFile` sniffing every
   * `.tex` for `\documentclass`), not five lines of context around a location a *log* named
   * (`compile`, `list_comments`), and not a file read only to answer a question about it
   * (`check_citations`, which returns keys and line numbers and no content at all). Note that
   * "the bytes reached the caller" is not the test: a snippet's bytes do reach them, and recording
   * one would tell the guard the server has seen a file the user is editing by hand, so the next
   * write clobbers those edits with no `ExternalChangeError`. Wrong in the safe direction costs one
   * refusal the caller can override; wrong the other way destroys the user's work.
   */
  async read(
    projectDir: string,
    opts: {
      path: string;
      startLine?: number;
      endLine?: number;
      recordBaseline?: boolean;
      /**
       * Refuse a symlink out of the project even where the project's owner places its own — for a
       * path the server picked up rather than the caller naming it. See {@link setLinkPolicy}.
       */
      strictLinks?: boolean;
    },
  ): Promise<ReadResult> {
    const abs = resolveInside(projectDir, opts.path);
    await this.guardLinks(projectDir, abs, opts.path, opts.strictLinks);
    const info = await stat(abs);
    if (!info.isFile()) {
      throw new Error(`Not a file: "${opts.path}"`);
    }
    const ext = path.extname(opts.path).toLowerCase();
    if (ASSET_EXT.has(ext) || info.size > MAX_READ_BYTES) {
      return {
        path: opts.path,
        content: '',
        totalLines: 0,
        truncated: true,
        // `toPosix` on the interpolation, NOT on `abs`: this is the documented binary/large-file
        // branch of an ordinary `read_file`, so the string reaches a caller who was promised
        // "file paths are always POSIX, on every OS". The binding itself must stay native — it
        // is the `resolveInside` string, which is this path's one identity for `readFile` below
        // and for `this.revisions.record`, and re-spelling it would file a baseline under a key
        // no write ever looks up (the way the symlink guard went quiet on macOS `/var` and on
        // Windows 8.3 names).
        note: `Binary or large file (${info.size} bytes); content not returned. Open directly at ${toPosix(abs)}`,
      };
    }
    const raw = await readFile(abs, 'utf8');
    if (opts.recordBaseline) this.revisions.record(abs, raw);
    const totalLines = splitLines(raw).length;
    if (opts.startLine === undefined && opts.endLine === undefined) {
      return { path: opts.path, content: raw, totalLines, truncated: false };
    }
    const start = Math.max(1, opts.startLine ?? 1);
    const end = Math.min(totalLines, opts.endLine ?? totalLines);
    // Byte-exact, so what comes back can go straight into edit_file's oldString.
    const content = sliceLineRange(raw, start, end);
    return { path: opts.path, content, totalLines, truncated: start > 1 || end < totalLines };
  }

  /**
   * Read a file's full text, returning '' when it does not exist (used for appends).
   * `recordBaseline` carries the same meaning — and the same default — as in {@link read}.
   */
  async readText(
    projectDir: string,
    relPath: string,
    opts: { recordBaseline?: boolean; strictLinks?: boolean } = {},
  ): Promise<string> {
    const abs = resolveInside(projectDir, relPath);
    await this.guardLinks(projectDir, abs, relPath, opts.strictLinks);
    try {
      const raw = await readFile(abs, 'utf8');
      if (opts.recordBaseline) this.revisions.record(abs, raw);
      return raw;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
  }

  /** Create or overwrite a file. */
  async write(
    projectDir: string,
    opts: {
      path: string;
      content: string;
      createDirs?: boolean;
      overrideExternalChanges?: boolean;
      /** As in {@link read}: refuse a link out of the project even where the policy follows one. */
      strictLinks?: boolean;
    },
  ): Promise<WriteResult> {
    const abs = resolveInside(projectDir, opts.path);
    await this.guardLinks(projectDir, abs, opts.path, opts.strictLinks);
    let currentBytes: Buffer | undefined;
    try {
      currentBytes = await readFile(abs);
    } catch {
      currentBytes = undefined; // file does not exist yet
    }
    if (
      !opts.overrideExternalChanges &&
      currentBytes !== undefined &&
      this.isChangedOnDisk(abs, currentBytes)
    ) {
      throw new ExternalChangeError(opts.path);
    }
    const current = currentBytes?.toString('utf8');
    if (opts.createDirs) {
      await mkdir(path.dirname(abs), { recursive: true });
    }
    try {
      await writeFile(abs, opts.content, 'utf8');
    } catch (err) {
      await translateMissingParentError(err, abs, projectDir, opts.path, opts.createDirs);
    }
    this.revisions.record(abs, opts.content);
    await this.notify(
      projectDir,
      await this.attributedPath(projectDir, abs, opts.path),
      current ?? null,
      opts.content,
    );
    return {
      path: opts.path,
      bytesWritten: Buffer.byteLength(opts.content, 'utf8'),
      created: current === undefined,
    };
  }

  /**
   * Read a file's raw bytes, returning null when it does not exist. The binary counterpart of
   * {@link readText}, and capped at the binary cap `MAX_BINARY_READ_BYTES` — not the much smaller
   * text {@link MAX_READ_BYTES} — so a figure `add_asset` was allowed to import can always be read
   * back out again. `recordBaseline` carries the same meaning — and the same false default —
   * as elsewhere: it is a claim that the caller could now base a write on this file.
   */
  async readBytes(
    projectDir: string,
    opts: { path: string; recordBaseline?: boolean; strictLinks?: boolean },
  ): Promise<Buffer | null> {
    const abs = resolveInside(projectDir, opts.path);
    await this.guardLinks(projectDir, abs, opts.path, opts.strictLinks);
    let info;
    try {
      info = await stat(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    if (!info.isFile()) {
      throw new Error(`Not a file: "${opts.path}"`);
    }
    // Deliberately a PRE-read `stat`, not a post-read `buf.length`: the point of a size cap on a
    // binary reader is that the oversized file is never pulled into memory at all, so the refusal
    // has to happen before `readFile`. And it names WHICH cap fired — `readBytes` is capped at the
    // binary cap, the text reader `read` at the much smaller `MAX_READ_BYTES` — so a caller can
    // tell the two refusals apart instead of guessing which limit it just hit.
    if (info.size > MAX_BINARY_READ_BYTES) {
      throw new Error(
        `"${opts.path}" is ${info.size} bytes, over the ${MAX_BINARY_READ_BYTES}-byte binary read ` +
          `cap (the text read cap, ${MAX_READ_BYTES} bytes, is a separate and smaller limit). ` +
          // `toPosix` on the interpolation, NOT on `abs` — exactly as the binary/large-file note
          // in `read` above does it, and for the same two reasons. The sentence is the one thing
          // this refusal is FOR (it hands the caller a path to open instead of the bytes), so it
          // is spelled the way every other path this server returns is; while `abs` itself stays
          // native, because it is the `resolveInside` string that `readFile` and
          // `this.revisions.record` below key on, and re-spelling it would file a baseline under
          // a key no write ever looks up.
          `Open it directly at ${toPosix(abs)}.`,
      );
    }
    const buf = await readFile(abs);
    if (opts.recordBaseline) this.revisions.record(abs, buf);
    return buf;
  }

  /** Create or overwrite a file with raw bytes. The binary counterpart of {@link write}. */
  async writeBytes(
    projectDir: string,
    opts: {
      path: string;
      bytes: Buffer;
      createDirs?: boolean;
      overrideExternalChanges?: boolean;
      strictLinks?: boolean;
    },
  ): Promise<WriteResult> {
    const abs = resolveInside(projectDir, opts.path);
    await this.guardLinks(projectDir, abs, opts.path, opts.strictLinks);
    let current: Buffer | undefined;
    try {
      current = await readFile(abs);
    } catch {
      current = undefined; // file does not exist yet
    }
    if (
      !opts.overrideExternalChanges &&
      current !== undefined &&
      this.isChangedOnDisk(abs, current)
    ) {
      throw new ExternalChangeError(opts.path);
    }
    if (opts.createDirs) {
      await mkdir(path.dirname(abs), { recursive: true });
    }
    try {
      await writeFile(abs, opts.bytes);
    } catch (err) {
      await translateMissingParentError(err, abs, projectDir, opts.path, opts.createDirs);
    }
    this.revisions.record(abs, opts.bytes);
    await this.notify(
      projectDir,
      await this.attributedPath(projectDir, abs, opts.path),
      current ?? null,
      opts.bytes,
    );
    return {
      path: opts.path,
      bytesWritten: opts.bytes.length,
      created: current === undefined,
    };
  }

  /**
   * Apply surgical edits. Each is either a string replacement (whose `oldString` must match
   * uniquely unless `replaceAll` is set) or a line range (`startLine`/`endLine`, 1-based and
   * inclusive — see `RangeEditOp`). All edits are applied in memory and only written if every
   * edit succeeds (atomic) — so a failure leaves the file untouched.
   */
  async applyEdits(
    projectDir: string,
    relPath: string,
    edits: AnyEditOp[],
    opts: {
      overrideExternalChanges?: boolean;
      strictLinks?: boolean;
      /**
       * Consulted for every candidate match of an edit that set `excludeComments`: `true` means
       * "this match is inside a comment — skip it". Same ignorance boundary as `preserve`: this
       * method sees a predicate over integer offsets and never learns what a comment is
       * (`src/lib/rewriteMode.ts`'s `matchIsCommented` is what `edit_file` passes). It is
       * re-asked against the *current* content for every occurrence, not once per edit, because
       * a replacement can change its own line's comment state.
       *
       * An edit setting `excludeComments` with no filter supplied here is a wiring error and is
       * refused, never silently applied as if the flag were absent.
       */
      excludeMatch?: (content: string, start: number, end: number) => boolean;
      /**
       * Optional hook letting a caller rewrite the replacement text for each edit, given the
       * position of the (unique, non-`replaceAll`) match in the file's *current* content. Used by
       * `edit_file`'s rewrite-preservation feature to decide, with the actual match position in
       * hand, whether commenting out the original text is safe (see `src/lib/rewriteMode.ts`) — a
       * decision `FileService` deliberately stays ignorant of, since it knows nothing about
       * comment syntax; it only reads back the reported `commentedLength` as an integer offset.
       * The ledger of already-preserved ranges lives entirely in this method (see the `preserved`
       * array below), not in the hook — `applyEdits` is the only code that knows every splice
       * offset a call produces, `replaceAll` included.
       *
       * Not consulted for a `replaceAll` edit: there is no single match position, so preservation
       * is skipped for those unconditionally, and matching inside an earlier preserved comment
       * under `replaceAll` is documented, intended behaviour (see `edit_file`'s
       * `preserveOriginal` description) — a `replaceAll` edit still shifts the ledger as it
       * splices, it just never adds to it.
       */
      preserve?: EditTransform;
    } = {},
  ): Promise<ApplyEditsResult> {
    if (edits.length === 0) {
      throw new Error('No edits provided.');
    }
    const abs = resolveInside(projectDir, relPath);
    await this.guardLinks(projectDir, abs, relPath, opts.strictLinks);
    const originalBytes = await readFile(abs);
    const original = originalBytes.toString('utf8');
    if (!opts.overrideExternalChanges && this.isChangedOnDisk(abs, originalBytes)) {
      throw new ExternalChangeError(relPath);
    }
    let content = original;
    // [start, end) ranges, in `content`'s *current* coordinate space, of every preserved comment
    // block spliced in so far by this call. Owned here — not by `opts.preserve` — because this is
    // the only place that knows every splice offset a call produces, including each individual
    // occurrence a `replaceAll` edit touches; a hook that owned this ledger itself could only ever
    // shift it for the non-`replaceAll` edits it was actually called for, leaving it stale the
    // moment a `replaceAll` edit spliced text without going through the hook at all.
    const preserved: { start: number; end: number }[] = [];
    /**
     * Adjust every recorded range for a splice of `[spliceStart, spliceEnd)` (pre-splice
     * coordinates) that changed the content's length by `delta`. A `replaceAll` occurrence can
     * land anywhere relative to a preserved range — including, intentionally, *inside* one
     * (rewriting a preserved comment is documented behaviour) — or *straddling* one of its
     * boundaries, which a range can never survive as a single shifted interval: whichever side
     * the splice consumed is gone, replaced by caller-authored text that was never part of the
     * comment this ledger is protecting. So this rebuilds the list rather than mutating each
     * range in place, run unconditionally (a zero-`delta` splice still overwrites bytes and can
     * still straddle a boundary, even though nothing after it needs to move). Cases:
     *
     *  - Entirely after the range (`spliceStart >= range.end`): untouched — nothing before it
     *    moved.
     *  - Entirely before the range (`spliceEnd <= range.start`): the whole range slides by
     *    `delta`, same as any other coordinate after the splice point.
     *  - The splice fully contains the range (`spliceStart <= range.start && spliceEnd >=
     *    range.end`): every byte of the range was overwritten by caller text — drop it, it is no
     *    longer preserved at all.
     *  - The range fully contains the splice (`spliceStart >= range.start && spliceEnd <=
     *    range.end`): a `replaceAll` rewriting part of a preserved comment, kept as one
     *    contiguous span — its `start` is unaffected (the splice began at or after it) and its
     *    `end` grows/shrinks by `delta`.
     *  - The splice straddles the range's *start* (`spliceStart < range.start`, so it must end
     *    at or before `range.end`): it consumed the range's leading bytes (and possibly text
     *    before them too), so no prefix of the original survives — only the suffix after the
     *    splice remains preserved, as `[spliceEnd + delta, range.end + delta)`.
     *  - The splice straddles the range's *end* (the remaining case: it starts inside the range
     *    but ends past it): only the prefix before the splice point is still preserved, as
     *    `[range.start, spliceStart)` — it needs no shift, since it sits entirely before the
     *    splice.
     */
    const shiftPreserved = (spliceStart: number, spliceEnd: number, delta: number) => {
      const next: { start: number; end: number }[] = [];
      for (const range of preserved) {
        if (spliceStart >= range.end) {
          next.push(range);
        } else if (spliceEnd <= range.start) {
          next.push({ start: range.start + delta, end: range.end + delta });
        } else if (spliceStart <= range.start && spliceEnd >= range.end) {
          // Fully overwritten — drop it.
        } else if (spliceStart >= range.start && spliceEnd <= range.end) {
          next.push({ start: range.start, end: range.end + delta });
        } else if (spliceStart < range.start) {
          next.push({ start: spliceEnd + delta, end: range.end + delta });
        } else {
          next.push({ start: range.start, end: spliceStart });
        }
      }
      preserved.length = 0;
      preserved.push(...next);
    };
    /**
     * Every line range in this call, resolved **up front against the content as the call found
     * it** — the bytes `read_file` handed the caller — and thereafter kept in `content`'s current
     * coordinate space by `splice` below, exactly like the preserved-block ledger.
     *
     * Resolving up front is what makes a range mean the same thing wherever it sits in the
     * `edits` array: the caller's line numbers came from a read of the file before this call, so
     * an earlier edit that adds or removes lines must not silently slide a later range onto
     * different text. Keeping the resolved spans shifted (rather than re-deriving line numbers
     * against the mutated content) means a range still covers exactly the original bytes it
     * named, and an earlier edit that *touches* those bytes is refused outright — see `splice`.
     */
    const pendingRanges = new Map<number, Span>();
    edits.forEach((edit, i) => {
      if (!isRangeEdit(edit)) return;
      if (edit.endLine < edit.startLine) {
        throw new Error(
          `Edit ${i + 1}: startLine ${edit.startLine} is after endLine ${edit.endLine}; the range is 1-based and endLine is inclusive.`,
        );
      }
      const span = lineSpan(content, edit.startLine, edit.endLine);
      if (span === null) {
        throw new Error(
          `Edit ${i + 1}: lines ${edit.startLine}-${edit.endLine} are outside ${relPath}, which has ${splitLines(content).length} line(s). Line numbers are 1-based and endLine is inclusive.`,
        );
      }
      pendingRanges.set(i, span);
    });
    /**
     * The one place content is ever spliced, so both ledgers move on **every** splice — the
     * preserved-comment ranges and the not-yet-applied line ranges alike. A `replaceAll` edit
     * runs no preservation hook but still changes the file's length at every occurrence, and a
     * ledger that only moved for the edits that went through the hook was exactly the bug that
     * made preserved ranges go stale; routing every splice through one function is what keeps
     * that structural rather than remembered.
     *
     * It also enforces the no-silent-overlap rule: if this splice would touch bytes some *other*
     * edit's line range covers, the whole call fails. The alternative — applying it and letting
     * the range shift — would rewrite lines the caller never named, which is precisely the
     * silent corruption a range edit invites.
     */
    const splice = (editIndex: number, start: number, end: number, replacement: string) => {
      for (const [j, range] of pendingRanges) {
        if (j === editIndex) continue;
        if (start < range.end && end > range.start) {
          throw new Error(
            `Edit ${editIndex + 1} changes text that edit ${j + 1}'s line range covers. Line numbers refer to ${relPath} as it was before this call, so two edits in one call may not touch the same text; split them into separate calls (and re-read the file in between, since the line numbers move).`,
          );
        }
      }
      content = content.slice(0, start) + replacement + content.slice(end);
      const delta = replacement.length - (end - start);
      shiftPreserved(start, end, delta);
      if (delta !== 0) {
        for (const [j, range] of pendingRanges) {
          // Only a range entirely *after* the splice moves; one entirely before is unaffected,
          // and an overlapping one already threw above, so there is no third case.
          if (j !== editIndex && end <= range.start) {
            pendingRanges.set(j, { start: range.start + delta, end: range.end + delta });
          }
        }
      }
    };
    const commentMatches: CommentMatchReport[] = [];
    edits.forEach((edit, i) => {
      if (isRangeEdit(edit)) {
        // Resolved above and shifted by every splice since, so it still covers exactly the lines
        // the caller named in the file they read. Drop it from the ledger first: it is about to
        // be consumed, and `splice` must not refuse this edit for overlapping its own range.
        const span = pendingRanges.get(i);
        /* c8 ignore next 3 -- unreachable: every range edit got an entry in the pass above. */
        if (span === undefined) {
          throw new Error(`Edit ${i + 1}: internal error — line range was never resolved.`);
        }
        pendingRanges.delete(i);
        const oldString = content.slice(span.start, span.end);
        if (oldString === edit.newString) {
          throw new Error(
            `Edit ${i + 1}: lines ${edit.startLine}-${edit.endLine} and newString are identical.`,
          );
        }
        // A range edit is line-aligned by construction, is never a `replaceAll`, and has exactly
        // one position — so it is preserved through the *same* hook as a unique string edit,
        // with the `oldString` the file actually holds there. Nothing about preservation is
        // re-decided here; `createPreserveTransform` still owns the whole judgment, and this
        // synthesized edit reaches it only after the identical-text guard above, so the hook
        // still never sees a no-op.
        const synthesized: EditOp = { oldString, newString: edit.newString };
        const replacement = opts.preserve
          ? opts.preserve.transform(synthesized, span.start, content)
          : edit.newString;
        const commentedLength = opts.preserve ? opts.preserve.lastInsertion() : undefined;
        splice(i, span.start, span.end, replacement);
        if (commentedLength !== undefined) {
          // No intersection check is needed against `preserved` here: an earlier splice that
          // overlapped this range would have thrown, and one entirely before it inserted its
          // whole replacement (preserved block included) before this range's shifted start.
          preserved.push({ start: span.start, end: span.start + commentedLength });
        }
        return;
      }
      if (edit.oldString === edit.newString) {
        throw new Error(`Edit ${i + 1}: oldString and newString are identical.`);
      }
      // A filter is only consulted for an edit that asked for it. Asking for it with no filter
      // wired in is refused rather than quietly downgraded to "replace everything" — the flag
      // exists to protect text, so ignoring it is the one failure mode that must never be silent.
      let excludeMatch: ((content: string, start: number, end: number) => boolean) | undefined;
      if (edit.excludeComments) {
        if (!opts.excludeMatch) {
          throw new Error(
            `Edit ${i + 1}: excludeComments was requested but this call supplied no comment filter.`,
          );
        }
        excludeMatch = opts.excludeMatch;
      }
      const count = countOccurrences(content, edit.oldString);
      if (count === 0) {
        throw new Error(`Edit ${i + 1}: oldString not found in ${relPath}.`);
      }
      if (count > 1 && !edit.replaceAll && !excludeMatch) {
        // "set replaceAll" is fine advice for plain ambiguity, but if one of the K occurrences
        // sits inside a block an earlier edit in this same call already preserved (commented
        // out), it is the one piece of advice that would silently rewrite that byte-exact block.
        // Find occurrences the same way `countOccurrences` does (non-overlapping, left to right)
        // and check each against the ledger before choosing which message to give.
        let occursInPreserved = false;
        if (preserved.length > 0) {
          let idx = content.indexOf(edit.oldString);
          while (idx !== -1 && !occursInPreserved) {
            const end = idx + edit.oldString.length;
            occursInPreserved = preserved.some((range) => idx < range.end && end > range.start);
            idx = content.indexOf(edit.oldString, idx + edit.oldString.length);
          }
        }
        throw new Error(
          occursInPreserved
            ? `Edit ${i + 1}: oldString matches ${count} times in ${relPath}, at least once inside text preserved (commented out) by an earlier edit in this same call; add more surrounding context so it matches only the live text, if any live occurrence remains.`
            : `Edit ${i + 1}: oldString matches ${count} times in ${relPath}; add more surrounding context for a unique match, or set replaceAll.`,
        );
      }
      if (edit.replaceAll) {
        // Splice one occurrence at a time (never String.prototype.replace / split-join with a
        // pattern-interpreting replacement — see the non-replaceAll branch below for why) so
        // each individual splice's offset is known and the preserved-range ledger can be shifted
        // per occurrence, left to right. A replaceAll edit is never routed through opts.preserve
        // (there is no single match position to comment above, and rewriting inside an earlier
        // preserved comment is documented, intended behaviour), but it still changes the file's
        // length at every occurrence, so the ledger must move regardless.
        let replaced = 0;
        let skippedInComments = 0;
        let from = 0;
        for (;;) {
          const idx = content.indexOf(edit.oldString, from);
          if (idx === -1) break;
          const spliceEnd = idx + edit.oldString.length;
          // Asked per occurrence against the *current* content, not from a mask computed once:
          // an earlier replacement on the same line can introduce (or remove) a comment, and a
          // stale mask would then decide this occurrence on bytes that are no longer there.
          if (excludeMatch?.(content, idx, spliceEnd)) {
            skippedInComments++;
            from = spliceEnd;
            continue;
          }
          splice(i, idx, spliceEnd, edit.newString);
          replaced++;
          from = idx + edit.newString.length;
        }
        if (excludeMatch) {
          if (replaced === 0) {
            throw new Error(
              `Edit ${i + 1}: all ${skippedInComments} occurrence(s) of oldString in ${relPath} are inside comments, and excludeComments is set, so there is nothing to replace.`,
            );
          }
          commentMatches.push({ edit: i + 1, replaced, skippedInComments });
        }
        return;
      }
      let matchIndex: number;
      if (excludeMatch) {
        // Uniqueness is judged over the *live* occurrences only — the whole point of the flag is
        // that the commented ones are not candidates. Enumerated the same way `countOccurrences`
        // counts: non-overlapping, left to right.
        const live: number[] = [];
        let idx = content.indexOf(edit.oldString);
        while (idx !== -1) {
          const end = idx + edit.oldString.length;
          if (!excludeMatch(content, idx, end)) live.push(idx);
          idx = content.indexOf(edit.oldString, end);
        }
        const inComments = count - live.length;
        if (live.length === 0) {
          throw new Error(
            `Edit ${i + 1}: all ${count} occurrence(s) of oldString in ${relPath} are inside comments, and excludeComments is set, so there is nothing to replace.`,
          );
        }
        if (live.length > 1) {
          throw new Error(
            `Edit ${i + 1}: oldString matches ${live.length} times outside comments in ${relPath} (${inComments} further match(es) are inside comments and were not counted); add more surrounding context for a unique match, or set replaceAll.`,
          );
        }
        matchIndex = live[0] as number;
        commentMatches.push({ edit: i + 1, replaced: 1, skippedInComments: inComments });
      } else {
        matchIndex = content.indexOf(edit.oldString);
      }
      const matchEnd = matchIndex + edit.oldString.length;
      if (opts.preserve) {
        const intersectsPreserved = preserved.some(
          (range) => matchIndex < range.end && matchEnd > range.start,
        );
        if (intersectsPreserved) {
          throw new Error(
            `Edit ${i + 1}: oldString only matches text preserved (commented out) by an earlier edit in this same call, not the live document; the live occurrence was already replaced by that edit.`,
          );
        }
      }
      const newString = opts.preserve
        ? opts.preserve.transform(edit, matchIndex, content)
        : edit.newString;
      const commentedLength = opts.preserve ? opts.preserve.lastInsertion() : undefined;
      // Not `content.replace(edit.oldString, newString)`: String.prototype.replace treats a
      // string *replacement* argument specially — $$, $&, $`, $', $1 etc. are substitution
      // patterns, not literal text — and LaTeX is full of literal `$`. That corrupts both a
      // caller-supplied newString containing e.g. `$$100$$` and, since preservation generates
      // the replacement text server-side, text the user never typed at all. Splice at the
      // already-computed matchIndex instead so newString lands byte-exact, unconditionally.
      splice(i, matchIndex, matchEnd, newString);
      if (commentedLength !== undefined) {
        preserved.push({ start: matchIndex, end: matchIndex + commentedLength });
      }
    });
    await writeFile(abs, content, 'utf8');
    this.revisions.record(abs, content);
    await this.notify(
      projectDir,
      await this.attributedPath(projectDir, abs, relPath),
      original,
      content,
    );
    return {
      path: relPath,
      appliedEdits: edits.length,
      ...(commentMatches.length > 0 ? { commentMatches } : {}),
    };
  }

  /** Delete a file (not a directory) from the project. */
  async delete(
    projectDir: string,
    relPath: string,
    opts: { overrideExternalChanges?: boolean; strictLinks?: boolean } = {},
  ): Promise<{ path: string }> {
    const abs = resolveInside(projectDir, relPath);
    await this.guardLinks(projectDir, abs, relPath, opts.strictLinks);
    const info = await stat(abs);
    if (!info.isFile()) {
      throw new Error(`Not a file: "${relPath}"`);
    }
    const currentBytes = await readFile(abs).catch(() => null);
    if (!opts.overrideExternalChanges && this.revisions.hasBaseline(abs)) {
      if (currentBytes !== null && this.isChangedOnDisk(abs, currentBytes)) {
        throw new ExternalChangeError(relPath);
      }
    }
    const current = currentBytes?.toString('utf8') ?? null;
    // Deliberately NOT run through attributedPath: `rm(abs)` removes exactly the entry `abs`
    // names, never resolving relPath's own final component through a link the way a write's
    // target resolution would. But an ANCESTOR directory can itself be a link, and the parent is
    // resolved through links by attributedDeletePath — see its doc comment.
    await rm(abs);
    this.revisions.forget(abs);
    await this.notify(
      projectDir,
      await this.attributedDeletePath(projectDir, abs, relPath),
      current,
      null,
    );
    return { path: relPath };
  }

  /**
   * Forget all recorded baselines under a project dir. Call after git rewrites the working tree
   * (pull, discard) so files that changed on disk aren't mistaken for out-of-band user edits.
   */
  resetBaselines(projectDir: string): void {
    this.revisions.reset(path.resolve(projectDir));
  }

  /**
   * Of the given repo-relative paths, return those whose on-disk content differs from what the
   * tools last read/wrote this session — i.e. files a human changed directly. Paths that no
   * longer exist or can't be read as text are skipped.
   */
  async externalModifications(projectDir: string, relPaths: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const rel of relPaths) {
      const abs = resolveInside(projectDir, rel);
      let content: Buffer;
      try {
        await this.guardLinks(projectDir, abs, rel);
        // Byte-exact: a text read of a binary file (e.g. a PNG) turns invalid UTF-8 sequences
        // into U+FFFD, so its hash would never match the Buffer baseline recorded by writeBytes —
        // every binary file would be reported as externally modified, forever.
        content = await readFile(abs);
      } catch {
        continue;
      }
      // See isExternallyModified: reported only when neither the byte comparison nor the
      // UTF-8-decoded-string comparison matches the recorded baseline.
      if (this.isExternallyModified(abs, content)) out.push(rel);
    }
    return out;
  }

  /**
   * Tell the recorder about a completed mutation. Never allowed to fail the write itself — the
   * file is already on disk, and losing attribution is a far smaller problem than reporting an
   * error for a change that actually landed.
   */
  private async notify(
    projectDir: string,
    relPath: string,
    before: string | Buffer | null,
    after: string | Buffer | null,
  ): Promise<void> {
    if (!this.recorder) return;
    try {
      await this.recorder.record(projectDir, toPosix(relPath), before, after);
    } catch (err) {
      console.error(
        `[web-latex-mcp] could not attribute the change to "${relPath}" to this session:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Collect every file under `dir`, project-relative.
   *
   * A dirent for a symlink is neither `isFile()` nor `isDirectory()`, so a link is skipped unless
   * this project follows its owner's links — and every auto-discovering tool is built on this walk
   * (`list_files`, `detectRootFile`, `list_references`, `check_citations`). Skipping one there
   * while `read` follows it makes the same project both follow and not follow its own links
   * depending on which tool you call: the shared `refs.bib` the exemption exists for would be
   * readable only by someone who already knew it was there.
   *
   * The `filter` is applied **here**, not by the caller, because `classify` is a pure function of
   * the name and `matchesFilter` consults only the type: a path the filter rejects need never be
   * collected, and — the point — need never be `stat`ed. `detectRootFile` runs on every `compile`
   * and asks for `tex`; it used to pay one `stat` for every figure in the tree (#174).
   *
   * What the filter must never do is change **traversal**. A symlink is still `stat`ed before it
   * is classified, because that `stat` is what decides whether it is a file to list or a directory
   * to descend into, and a directory link's own name (`figs -> /shared/figs`) says nothing about
   * what is under it. The `followLinks` opt-in, the `seen` realpath cycle guard, the dangling-link
   * drop and the `.git` skip are untouched: they are sandbox and termination guards, not an
   * optimization's business.
   */
  private async walk(
    root: string,
    dir: string,
    filter: FileFilter,
    out: WalkCandidate[],
    seen: Set<string> = new Set(),
  ): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    const followLinks = this.followsUserLinks(root);
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      // `path.extname` reads only the last path segment, so classifying the dirent's own name is
      // the same answer `classify` gave the project-relative path — without building that path
      // for a file about to be discarded.
      const type = classify(entry.name);
      if (entry.isDirectory()) {
        await this.walk(root, full, filter, out, seen);
      } else if (entry.isFile()) {
        if (matchesFilter(type, filter)) out.push({ rel: path.relative(root, full), full, type });
      } else if (entry.isSymbolicLink() && followLinks) {
        // `stat` follows the link; a dangling one throws and is simply not there to list.
        const target = await stat(full).catch(() => null);
        if (target?.isFile()) {
          if (matchesFilter(type, filter)) {
            out.push({ rel: path.relative(root, full), full, type, sizeBytes: target.size });
          }
        } else if (target?.isDirectory()) {
          // Keyed on the real directory, so `a -> ..` (or any longer cycle) is walked once
          // instead of forever. `realpath` itself fails on a self-referential chain (ELOOP).
          const real = await realpath(full).catch(() => null);
          if (real === null || seen.has(real)) continue;
          seen.add(real);
          await this.walk(root, full, filter, out, seen);
        }
      }
    }
  }
}

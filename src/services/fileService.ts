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
import {
  splitLines,
  sliceLineRange,
  lineSpan,
  terminatorLengthAt,
  terminatorLengthBefore,
  type Span,
} from '../lib/lines.js';
import { FileRevisionTracker } from './fileRevisions.js';
import { ASSET_EXT, MAX_BINARY_READ_BYTES } from '../lib/assets.js';
import { decodeUtf8Exact } from '../lib/utf8.js';
import { changedPath } from '../lib/changeDiff.js';
import { quoteId } from '../lib/projectId.js';

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
 * The one exception is a **deletion**: when `newString` is empty (and still empty after any
 * rewrite-preservation hook — under preservation the lines come back %-commented instead), the
 * terminator after `endLine` goes too, or the one before `startLine` for an unterminated last
 * line, so the lines disappear rather than leaving a blank line (a `\par` in LaTeX). For the
 * overlap check a range always owns the terminator after `endLine`, deletion or not.
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
/**
 * Passed to `EditTransform.transform` for a **line-range** edit, and only for one. The
 * synthesized `oldString` is then whole lines by construction — from the first character of
 * `startLine` to the last of `endLine`, the terminator after it left in the file — which a string
 * edit's `oldString` never promises: `"line0\n"` may be a caller consuming its own newline, or
 * lines 1-2 of `"line0\n\nline2\n"`, the second of them blank. Only this flag tells the hook which,
 * so every line of the range is preserved, the blank last one included.
 *
 * `original` and `start` locate that same `oldString` in the file **as the call found it** (it is
 * `original.slice(start, start + oldString.length)`), the coordinates the caller's line numbers
 * refer to, so anything the hook reads around the range is judged there rather than in content an
 * earlier edit of the same call already changed.
 */
export interface RangeMatch {
  original: string;
  start: number;
}

/**
 * Passed to `EditTransform.transform` for a **string** edit: the file as the call found it, and
 * where the match's first byte and its end sit in it — each `null` when it lies inside text an
 * earlier edit of the same call inserted, which has no place in that file. What the hook reads
 * around the match (whether it starts and ends a line, the line terminator after it, whether
 * anything follows) is then judged there, as a range's is, rather than in content an earlier edit
 * already changed: otherwise a range deletion that took the terminator after the match, left a
 * bare `\r` in front of it, or removed the file's only CRLF, changed the answer with the order of
 * the edits.
 */
export interface MatchOrigin {
  original: string;
  start: number | null;
  end: number | null;
}

export interface EditTransform {
  /** Rewrite the replacement text for one (unique, non-`replaceAll`) match, given its position in
   * the file's *current* content — and, for a line-range edit, where it sat in the original file
   * (see `RangeMatch`), or for a string edit where its end sat there (see `MatchOrigin`). */
  transform: (
    edit: EditOp,
    matchIndex: number,
    content: string,
    range?: RangeMatch,
    origin?: MatchOrigin,
  ) => string;
  /** Length of the preserved comment block at the start of the string this hook's *most recent*
   * `transform()` call returned, or `undefined` if that call preserved nothing. Must be read
   * immediately after each `transform()` call and before the next one — it is not a ledger. */
  lastInsertion: () => number | undefined;
  /** Where, in the string the *most recent* `transform()` call returned, sits a line terminator
   * the hook put back for one the match consumed — `undefined` if it put none back. Read like
   * `lastInsertion`. Those bytes stand in for a terminator the file had, so the fused-pair repair
   * (`unfuse`) may rewrite them as it would the original's; everything else the hook returned
   * stays untouched. Optional: a hook that never puts a terminator back need not report. */
  lastRestoredTerminator?: () => { offset: number; length: number } | undefined;
}

/**
 * One entry of `applyEdits`' preserved-block ledger: `[start, end)` in the current content, plus
 * what the end-of-call check needs to tell whether the block is still a comment — see where the
 * ledger is declared.
 */
interface PreservedBlock {
  start: number;
  end: number;
  edit: number;
  lastTouch: number | undefined;
  rewrittenTo: number | null;
  pairedNl: number | null;
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

/**
 * Whether a splice of `[start, end)` touches a claimed interval `[claimStart, claimEnd)`. Plain
 * half-open overlap misses every EMPTY interval — `a < b && c > d` never holds for `[r, r)` — and
 * both sides can be empty: a blank line's span is `[r, r)`, and so is the splice that fills one.
 * An empty side counts as the point it sits at: an empty splice touches a claim containing that
 * point, an empty claim is touched by a splice covering it, and two empty ones touch only at the
 * same offset (the same blank line, named twice).
 */
function touches(start: number, end: number, claimStart: number, claimEnd: number): boolean {
  if (start === end && claimStart === claimEnd) return start === claimStart;
  if (start === end) return claimStart <= start && start < claimEnd;
  if (claimStart === claimEnd) return start <= claimStart && claimStart < end;
  return start < claimEnd && end > claimStart;
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
    // `resolveInside` compares strings, and `readdir` follows a link: a committed `figs -> $HOME`
    // passed as `subdir` listed every name and size under the home directory (and `search_files`,
    // which walks through here, named them). The walk's own link rule only governs entries it
    // meets INSIDE the tree, never the directory it starts at — so the starting point gets the
    // same guard a read of it would, under the same project link policy.
    if (opts.subdir) await this.guardLinks(projectDir, base, opts.subdir);
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
   * `read_file` does — but only when it asked for the whole file. A `startLine`/`endLine` read is
   * refused the baseline HERE rather than at the call site (#181), because this rule is about the
   * READ, not about what a caller meant by one: the bytes recorded are the whole file's, so a
   * five-line read of a 2000-line document would vouch for 1995 lines nobody has seen, and the
   * next `write_file` replaces them with no `ExternalChangeError`. The test is the REQUEST, never
   * a computed coverage: `startLine: 1` alone does hand back every byte, and is still refused,
   * since a second way to derive "whole" is a second place for this rule to drift — and that
   * costs one re-read to acknowledge a change, where the other direction destroys the user's work.
   * `list_references` may record too — but only for a bibliography it returned WHOLE. It used to hold this licence outright, on the premise that it hands back every entry
   * verbatim; #147 made `raw` cuttable, #165 the typed fields, and #170 dropped the default
   * `maxResults` to 50, so a 200-entry `.bib` now shows 50 entries. It therefore decides per file,
   * after its budgets have run, and claims only the files that shipped uncut (#171) — through
   * {@link recordBaseline}, with the bytes it already holds, rather than by reading them twice.
   * Nothing else
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
    const whole = opts.startLine === undefined && opts.endLine === undefined;
    // What gets recorded is the WHOLE file's bytes, so only a whole-file read may claim it — see
    // this method's doc comment (#181). Enforced here rather than in `read_file`, so no caller can
    // get it wrong and the rule lives in the one place it is written down.
    if (opts.recordBaseline && whole) this.revisions.record(abs, raw);
    const totalLines = splitLines(raw).length;
    if (whole) {
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

  /**
   * {@link readText} for a caller about to write the WHOLE file back: `''` when it does not
   * exist, and `null` when its bytes are not valid UTF-8 (`decodeUtf8Exact`), because a lossy
   * decode written back would rewrite every undecodable byte as U+FFFD, far from the change.
   *
   * Uncapped, exactly as `readText` is — deliberately NOT built on {@link readBytes}, whose cap is
   * the binary one (`MAX_BINARY_READ_BYTES`, sized for figures `add_asset` imports) and whose
   * refusal speaks of opening the file directly. A shared bibliography (`add_citation`'s caller)
   * can run to tens of MB, and an append to it has no reason to fail on a figure limit.
   *
   * Records no baseline, and takes no option to: its one caller reads before an early return
   * that writes nothing, and a path that writes nothing must claim nothing (see {@link read}).
   */
  async readTextExact(
    projectDir: string,
    relPath: string,
    opts: { strictLinks?: boolean } = {},
  ): Promise<string | null> {
    const abs = resolveInside(projectDir, relPath);
    await this.guardLinks(projectDir, abs, relPath, opts.strictLinks);
    let bytes: Buffer;
    try {
      bytes = await readFile(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
    return decodeUtf8Exact(bytes);
  }

  /**
   * Record the out-of-band-edit baseline for bytes the caller ALREADY holds (#182).
   *
   * The seam `read`/`readText`/`readBytes` cannot provide: each of those can only record what it
   * itself just read, so a caller that learns only later that it handed a file over whole had to
   * read that file a second time — which `list_references` did (#171), because whether a
   * bibliography arrives uncut is decided by three budget planners and `maxResults`, all of which
   * run after every candidate has been read.
   *
   * That second read is not merely a cost. A hand edit landing between the two reads is recorded
   * as the baseline, so the guard never fires for it. Recording the bytes in hand closes that
   * window: the baseline is exactly what the caller was shown, not whatever the file says by the
   * time the decision is made.
   *
   * The licence is the one {@link read} documents, unchanged — claim this only for a file the
   * caller asked for and received ALL of. Recording RESETS the guard rather than arming it, so a
   * baseline claimed over bytes the caller never saw tells the guard the server has seen a hand
   * edit it has not, and the next write clobbers it silently.
   *
   * The path is resolved exactly as a read resolves it, and both halves of that matter. The key is
   * the `resolveInside` string, unchanged: re-spelling it files the baseline under a name no write
   * ever looks up, which is how the guard went quiet on macOS (`/var` -> `/private/var`) and on
   * Windows 8.3 short paths. And `strictLinks` keeps the same default as every read (false, i.e.
   * honour the project's link policy), because this seam PAIRS with a read that has already run
   * this guard: a stricter default would refuse to record for exactly the files a
   * `followSymlinks: true` project's read allowed, and a looser one would record for a path no
   * read could reach. It stays a parameter so a record the server makes on its own initiative can
   * be held to the strict rule, as every other method here can.
   */
  async recordBaseline(
    projectDir: string,
    relPath: string,
    content: string | Buffer,
    opts: { strictLinks?: boolean } = {},
  ): Promise<void> {
    const abs = resolveInside(projectDir, relPath);
    await this.guardLinks(projectDir, abs, relPath, opts.strictLinks);
    this.revisions.record(abs, content);
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
    const original = decodeUtf8Exact(originalBytes);
    if (!opts.overrideExternalChanges && this.isChangedOnDisk(abs, originalBytes)) {
      throw new ExternalChangeError(relPath);
    }
    // Every edit here is a read-decode-modify-write of the WHOLE file, and the decode is UTF-8:
    // a byte sequence that is not valid UTF-8 (a Latin-1 `é` is the one byte 0xE9) decodes to
    // U+FFFD and is written back as ef bf bd. So a one-line edit to a Latin-1 `.tex` rewrote every
    // accented character in the file, far from the edit and absent from its diff's intent.
    // Refused before anything is spliced; `write`, whose content is the caller's whole file, is
    // deliberately not held to this — replacing such a file outright is a choice, not a side effect.
    if (original === null) {
      throw new Error(
        `"${relPath}" is not valid UTF-8 (likely Latin-1 or another legacy encoding), and ` +
          'edit_file rewrites the whole file as UTF-8, which would replace every character it ' +
          'cannot decode — not just the edited text — with U+FFFD. Convert the file to UTF-8 ' +
          'first, or replace it deliberately with write_file and its full content.',
      );
    }
    let content = original;
    // The file as the call found it: what every line range, and every judgment about one, refers to.
    const initial: string = original;
    // [start, end) ranges, in `content`'s *current* coordinate space, of every preserved comment
    // block spliced in so far by this call. Owned here — not by `opts.preserve` — because this is
    // the only place that knows every splice offset a call produces, including each individual
    // occurrence a `replaceAll` edit touches; a hook that owned this ledger itself could only ever
    // shift it for the non-`replaceAll` edits it was actually called for, leaving it stale the
    // moment a `replaceAll` edit spliced text without going through the hook at all.
    //
    // Each block also carries what the end-of-call check (`assertBlocksStillComments`) needs: the
    // edit that preserved it (`edit`), the last edit whose splice reached the byte just past it
    // (`lastTouch`), and where the `'\n'` sits that a block ending in its own bare `'\r'` was
    // DESIGNED to pair with (`pairedNl`: a CRLF the match split, or a separator the hook wrote),
    // or `null` — kept in step by every splice, and dropped when a splice removes it.
    const preserved: PreservedBlock[] = [];
    /**
     * Every splice this call has made, in order, as `[start, removed, inserted]` in the
     * coordinates of the content at that moment — enough for `toInitial` to carry an offset in the
     * current content back into `initial`, where a string edit's preservation separator is judged
     * (see `MatchOrigin`).
     */
    const spliceLog: [number, number, number][] = [];
    /**
     * Where offset `p` of the current content sat in `initial`, or `null` when it lies strictly
     * inside text a splice inserted. An offset AT a splice's start stays where it is: for a pure
     * removal that is the side before the removed text — so the end of a match whose terminator a
     * later-listed deletion already took still lands on that terminator in `initial`.
     *
     * With `byte`, `p` names the character at `p` rather than the boundary before it, and one a
     * splice inserted (the first included) is `null`: the answer to "did the file have this byte
     * before the call".
     */
    const toInitial = (p: number, byte = false): number | null => {
      let at = p;
      for (let k = spliceLog.length - 1; k >= 0; k--) {
        const [start, removed, inserted] = spliceLog[k] as [number, number, number];
        if (byte ? at < start : at <= start) continue;
        if (at < start + inserted) return null;
        at += removed - inserted;
      }
      return at;
    };
    /**
     * Where each range deletion in this call cut the text, in current coordinates, kept in step
     * by `splice` (a later splice that removes text on both sides of one drops it). Checked by
     * `unfuse` once every edit has applied — see there for why not at the cut itself.
     */
    const cutPoints: number[] = [];
    /**
     * [start, end) ranges, in current coordinates, of the line terminators a preservation hook
     * put back after a replacement (`lastRestoredTerminator`), kept in step by `splice` (one a
     * later splice overwrites is dropped). They stand in for the terminator the match consumed —
     * an original byte — so `unfuse` may rewrite them too; without that, a deletion leaving a
     * put-back bare `\r` before a blank line's `\n` merged the blank line away, where spelling
     * the same edit without its `\r` (which then stays in the file, original) kept it.
     */
    const restored: { start: number; end: number }[] = [];
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
     *
     * `editIndex` is recorded on every range this splice starts exactly at the end of
     * (`lastTouch`), so the end-of-call check can name the edit that took a block's line break.
     */
    const shiftPreserved = (
      spliceStart: number,
      spliceEnd: number,
      delta: number,
      editIndex: number,
    ) => {
      const next: PreservedBlock[] = [];
      for (const range of preserved) {
        // The paired '\n' is a single byte: gone if the splice removed it, moved if it sat after.
        const pairedNl =
          range.pairedNl === null || range.pairedNl < spliceStart
            ? range.pairedNl
            : range.pairedNl < spliceEnd
              ? null
              : range.pairedNl + delta;
        // A splice starting exactly at the block's end reached the byte just past it: the line
        // break that ends it, unless the block carries its own. One starting inside the block and
        // running to or past its end rewrote the block's own last bytes — only a `replaceAll` can,
        // the documented rewrite-inside-a-comment case — and `rewrittenTo` then marks where that
        // replacement text ends, so the end-of-call check can tell a line break the caller wrote
        // into it from a comment line that now runs on into text after it. Kept in step like any
        // offset: a later splice across it leaves it at the end of that splice's own text.
        const rewrites = spliceStart < range.end && spliceEnd >= range.end;
        const movedTo =
          range.rewrittenTo === null || spliceStart >= range.rewrittenTo
            ? range.rewrittenTo
            : spliceEnd <= range.rewrittenTo
              ? range.rewrittenTo + delta
              : spliceEnd + delta;
        const kept = {
          ...range,
          pairedNl,
          lastTouch: spliceStart === range.end || rewrites ? editIndex : range.lastTouch,
          rewrittenTo: rewrites ? spliceEnd + delta : movedTo,
        };
        if (spliceStart >= range.end) {
          next.push(kept);
        } else if (spliceEnd <= range.start) {
          next.push({ ...kept, start: range.start + delta, end: range.end + delta });
        } else if (spliceStart <= range.start && spliceEnd >= range.end) {
          // Fully overwritten — drop it.
        } else if (spliceStart >= range.start && spliceEnd <= range.end) {
          next.push({ ...kept, end: range.end + delta });
        } else if (spliceStart < range.start) {
          next.push({ ...kept, start: spliceEnd + delta, end: range.end + delta });
        } else {
          next.push({ ...kept, end: spliceStart });
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
     *
     * `term` is the length of the line terminator that ends `endLine` (0 for an unterminated last
     * line). The range **owns** it for the overlap check even though it is not part of the span
     * replaced: a deletion (`newString: ''`, see below) takes it, so an earlier edit that rewrote
     * it would leave the deletion eating someone else's text — and without it a blank line's
     * empty span `[r, r)` owned nothing at all, so a splice starting at `r` slipped past the check
     * and landed the range edit in front of whatever that splice inserted.
     *
     * `origStart` is `start` before any shift: where the range sat in `initial`, handed to the
     * preservation hook (`RangeMatch`) so it judges the range in the file the caller read.
     *
     * `prev` is the length of the terminator that ends `startLine - 1` in `initial` (0 for line
     * 1) — what a deletion of an unterminated last line takes — or `null` once a splice has
     * touched those bytes, after which it is measured in the current content instead. Measuring
     * it there unconditionally was wrong in a file mixing bare `\r` and `\n`: an earlier deletion
     * can leave one line's bare `\r` right before the next line's `\n`, where the two read as a
     * single `\r\n`, and taking "the terminator before" then ate the `\r` of a line nobody
     * deleted — in one order of the edits and not the other.
     *
     * The no-op guard runs here too, against `initial`, never at apply time: whether a deletion
     * is a no-op must not depend on which edit ran first. Deleting an unterminated last line
     * takes the terminator before it — possibly a blank line's own — and a blank-line deletion
     * that ran afterwards found nothing left to take and was refused as "identical", while the
     * same two edits in the other order succeeded. A blank line with an empty `newString` is a
     * deletion of that line and its terminator, so it is identical only when the file is empty
     * (a blank line in any other file is always terminated: `splitLines` counts no phantom last
     * line).
     */
    const pendingRanges = new Map<
      number,
      Span & { term: number; origStart: number; prev: number | null }
    >();
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
      const oldText = initial.slice(span.start, span.end);
      if (oldText === edit.newString && !(oldText === '' && initial !== '')) {
        throw new Error(
          `Edit ${i + 1}: lines ${edit.startLine}-${edit.endLine} and newString are identical.`,
        );
      }
      pendingRanges.set(i, {
        ...span,
        term: terminatorLengthAt(initial, span.end),
        origStart: span.start,
        prev: terminatorLengthBefore(initial, span.start),
      });
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
     * silent corruption a range edit invites. A range covers its span **plus the terminator after
     * it** here (see `term` above), and the test handles empty intervals explicitly — see
     * `touches`.
     *
     * `checkFrom` narrows only the overlap check, never the splice: a deletion of an unterminated
     * last line takes the terminator *before* it, which is the previous line's — possibly owned by
     * a pending range for that line. Taking it is exactly right (deleting the last line leaves the
     * new last line unterminated, as the file's last line was), and that pending range's span is
     * untouched, so the check starts at the deleted line itself; the owner simply loses its `term`.
     *
     * `prevAtStart` is what a range DELETION knows about the bytes just before `start`: the
     * length of the terminator ending there, in `initial` (its own `prev`). Once the deleted
     * lines are gone, those bytes are what precedes the range the deletion ended against, so that
     * range's `prev` is carried over instead of being lost to the fallback measurement.
     */
    const splice = (
      editIndex: number,
      start: number,
      end: number,
      replacement: string,
      checkFrom: number = start,
      prevAtStart: number | null = null,
    ) => {
      for (const [j, range] of pendingRanges) {
        if (j === editIndex) continue;
        if (touches(checkFrom, end, range.start, range.end + range.term)) {
          throw new Error(
            `Edit ${editIndex + 1} changes text that edit ${j + 1}'s line range covers. Line numbers refer to ${relPath} as it was before this call, so two edits in one call may not touch the same text; split them into separate calls (and re-read the file in between, since the line numbers move).`,
          );
        }
      }
      content = content.slice(0, start) + replacement + content.slice(end);
      spliceLog.push([start, end - start, replacement.length]);
      const delta = replacement.length - (end - start);
      shiftPreserved(start, end, delta, editIndex);
      for (let j = cutPoints.length - 1; j >= 0; j--) {
        const point = cutPoints[j] as number;
        if (point <= start) continue;
        if (point >= end) cutPoints[j] = point + delta;
        else cutPoints.splice(j, 1);
      }
      for (let j = restored.length - 1; j >= 0; j--) {
        const range = restored[j] as { start: number; end: number };
        if (start >= range.end) continue;
        if (end <= range.start)
          restored[j] = { start: range.start + delta, end: range.end + delta };
        else restored.splice(j, 1);
      }
      for (const [j, range] of pendingRanges) {
        if (j === editIndex) continue;
        if (end <= range.start) {
          // Only a range entirely *after* the splice moves; one entirely before is unaffected,
          // and an overlapping one already threw above. A splice reaching into the terminator
          // just before the range (the previous line's) makes `prev` unknowable from `initial`.
          const prev =
            replacement === '' && end === range.start
              ? prevAtStart
              : range.prev !== null && end > range.start - range.prev
                ? null
                : range.prev;
          if (delta !== 0 || prev !== range.prev) {
            pendingRanges.set(j, {
              ...range,
              start: range.start + delta,
              end: range.end + delta,
              prev,
            });
          }
        } else if (start < checkFrom && start === range.end) {
          // The one exemption `checkFrom` grants: this splice took the terminator that ended
          // range j's last line. Its span stands; it just no longer has a terminator to own.
          pendingRanges.set(j, { ...range, term: 0 });
        }
      }
    };
    /**
     * Run once every edit has applied, at each point a range deletion cut the text. When a cut
     * leaves a bare `\r` (the end of the line before) right in front of a `\n` (a blank line
     * after), the two read as ONE CRLF: the blank line merges into the line before, so a line
     * nobody deleted disappears with the deleted ones. The `\r` becomes a `\n` instead — the
     * terminator the blank line after it already uses, so never a type the file lacks — and so
     * does every bare `\r` just before it that would in turn fuse with the `\n` it now meets (a
     * run of CR-terminated blank lines). The line count then drops by exactly the lines deleted.
     *
     * Deferred to the end, not run at the cut, because whether the two stay adjacent is up to
     * the edits still pending — a later deletion of the blank line, or of an unterminated last
     * line that takes its `\n`, leaves nothing to fuse with — and deciding early made the bytes
     * depend on the order of the edits. At the end every deletion of a run has happened, so the
     * answer is the same whichever of them completed it. Cut points are visited from the last
     * to the first, since a walk only ever moves left.
     *
     * Only a byte the file had before the call is ever rewritten (`toInitial(k, true)`), or a
     * terminator a preservation hook put back in place of one the match consumed (`restored`):
     * never a preserved block, which must stay the bytes that were there, nor text a caller
     * supplied. An in-place, same-length change, made after the last splice, so no ledger is
     * involved.
     */
    const unfuse = (at: number) => {
      if (content[at - 1] !== '\r' || content[at] !== '\n') return;
      for (let k = at - 1; k >= 0 && content[k] === '\r'; k--) {
        const putBack = restored.some((range) => k >= range.start && k < range.end);
        if (toInitial(k, true) === null && !putBack) return;
        content = content.slice(0, k) + '\n' + content.slice(k + 1);
      }
    };
    /** Record where the hook's latest `transform()` put a terminator back, once its replacement
     * has been spliced in at `at`. Call only right after an edit that ran the hook. */
    const recordRestored = (at: number) => {
      const put = opts.preserve?.lastRestoredTerminator?.();
      if (put !== undefined && put.length > 0) {
        restored.push({ start: at + put.offset, end: at + put.offset + put.length });
      }
    };
    /**
     * Enter a block edit `editIndex` just spliced in at `[start, end)`. `pairedByDesign` says
     * whether a `'\n'` right after it now is one it was meant to meet: inside the replacement the
     * hook returned (a separator), or the byte that followed the match in the file as found — a
     * CRLF whose `'\r'` the match took. Only then is a block ending in its own bare `'\r'`
     * allowed to be followed by a `'\n'` (see `assertBlocksStillComments`).
     */
    const pushPreserved = (
      editIndex: number,
      start: number,
      end: number,
      pairedByDesign: boolean,
    ) => {
      const paired = content[end - 1] === '\r' && content[end] === '\n' && pairedByDesign;
      preserved.push({
        start,
        end,
        edit: editIndex,
        lastTouch: undefined,
        rewrittenTo: null,
        pairedNl: paired ? end : null,
      });
    };
    /**
     * Run once every edit has applied (and `unfuse` has run): refuse the call when a block an edit
     * preserved is no longer a comment of exactly the lines it was. The `%` makes a comment only
     * up to the end of its line, so the line break that ends a block is part of what makes it one
     * — and two later edits could take that away without matching a byte of the block itself,
     * which is all the match-time ledger check can see:
     *
     *  - A block that does not end in its own terminator is ended by the byte after it (the
     *    line's terminator, or a separator the hook wrote). A later edit that removes that byte and
     *    leaves text in its place — `'\nQ'` → `' tail'` after `'P'` was preserved as `% P` — puts
     *    that live text on the comment's line, where LaTeX silently drops it.
     *  - A block that ends in its own bare `'\r'` (the match took its line's terminator) and now
     *    meets a `'\n'` it was not designed to pair with — a deletion of the blank line after it
     *    brought the next blank line's `'\n'` up — reads as one CRLF with it: that blank line (a
     *    `\par`) disappears into the comment. For an original `'\r'` `unfuse` rewrites it to
     *    `'\n'`; a preserved block's bytes are the bytes that were there and are not rewritten.
     *
     * Refused rather than repaired: putting a line break back would be text nobody asked for, and
     * undoing the preservation would silently drop what the caller's mode promised. The refusal
     * is loud, the file is untouched (nothing is written until every edit succeeds), and the way
     * out is one step — the edits in separate calls, where the second sees the comment and the
     * block's bytes are the file's own. Judged on the final content, not per splice, so an edit
     * later in the call that puts a line break back is not refused for the moment in between,
     * and whether the fusion stands does not depend on which of the deletions ran last — the same
     * reason `unfuse` is deferred.
     *
     * A block whose own last bytes a `replaceAll` rewrote (`rewrittenTo`) — rewriting inside a
     * preserved comment is what a `replaceAll` is documented to do — is judged on where its
     * comment line now ends: fine when the caller's replacement text itself carries the line
     * break, or puts nothing on the line at all; refused when the line runs through the end of that
     * text, since whatever the replacement put there (it took live text with it) or whatever
     * follows it is then on the comment line. Only the first rule applies to such a block: its
     * trailing `'\r'`, if any, is the caller's now, not a byte this call must keep.
     */
    const assertBlocksStillComments = () => {
      for (const block of preserved) {
        if (block.end <= block.start) continue;
        const last = content[block.end - 1];
        const next = content[block.end];
        const endsLine = (ch: string | undefined) => ch === '\n' || ch === '\r';
        // Where the comment line the block ends on now ends: the first line break (or EOF) at or
        // after the block's end.
        let lineEnd = block.end;
        while (lineEnd < content.length && !endsLine(content[lineEnd])) lineEnd++;
        const runsOn =
          !endsLine(last) &&
          lineEnd > block.end &&
          (block.rewrittenTo === null || lineEnd >= block.rewrittenTo);
        if (runsOn) {
          const who = block.lastTouch === undefined ? 'An edit' : `Edit ${block.lastTouch + 1}`;
          throw new Error(
            `${who} removes the line break that ends the text edit ${block.edit + 1} preserved (commented out) in this same call, so the text after it would continue on that comment line, where LaTeX ignores it. Make the edits in separate calls (re-read the file in between, so the second one sees the comment), or turn preservation off for this call (preserveOriginal: false).`,
          );
        }
        if (
          block.rewrittenTo === null &&
          last === '\r' &&
          next === '\n' &&
          block.pairedNl !== block.end
        ) {
          throw new Error(
            `Another edit in this same call leaves a line break right after the text edit ${block.edit + 1} preserved (commented out), which ends in a bare carriage return: the two would read as one CRLF, and the blank line after the block (a paragraph break in LaTeX) would disappear into it. Make the edits in separate calls (re-read the file in between), or turn preservation off for this call (preserveOriginal: false).`,
          );
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
        /**
         * What a deletion removes: the lines AND a terminator, so they disappear rather than
         * collapsing into one blank line (a `\par` in LaTeX). The terminator after `endLine` when
         * there is one — owned by this range, so no earlier edit can have rewritten it — else,
         * for an unterminated last line, the one before `startLine`, so the new last line is left
         * unterminated as the old one was. That one is taken only when it is not part of a block
         * an earlier edit preserved: eating a preserved block's newline would make it no longer
         * the bytes that were there, so the lines' text goes and that newline stays.
         */
        const deletion = (): { start: number; end: number } => {
          if (span.term > 0) return { start: span.start, end: span.end + span.term };
          const before = span.prev ?? terminatorLengthBefore(content, span.start);
          const from = span.start - before;
          if (before > 0 && !preserved.some((r) => from < r.end && span.start > r.start)) {
            return { start: from, end: span.end };
          }
          return { start: span.start, end: span.end };
        };
        // A blank line named with an empty newString is a deletion of that line, not a no-op
        // (the one no-op shape, an empty file, was refused when the range was resolved).
        const blankDeletion = oldString === '' && edit.newString === '';
        // A range edit is line-aligned by construction, is never a `replaceAll`, and has exactly
        // one position — so it is preserved through the *same* hook as a unique string edit,
        // with the `oldString` the file actually holds there. Nothing about preservation is
        // re-decided here; `createPreserveTransform` still owns the whole judgment, and this
        // synthesized edit reaches it only after the identical-text guard (run when the range
        // was resolved), so the hook still never sees a no-op — which is also why a blank-line
        // deletion skips it: there is no text on that line to preserve. The `RangeMatch` tells
        // the hook this `oldString` is whole lines — see there for why it cannot tell alone.
        const synthesized: EditOp = { oldString, newString: edit.newString };
        const replacement =
          opts.preserve && !blankDeletion
            ? opts.preserve.transform(synthesized, span.start, content, {
                original: initial,
                start: span.origStart,
              })
            : edit.newString;
        const commentedLength =
          opts.preserve && !blankDeletion ? opts.preserve.lastInsertion() : undefined;
        if (replacement === '') {
          // Only when the replacement is STILL empty after the hook: under preservation the old
          // lines come back %-commented and nothing is deleted, so the terminators stay put.
          // An empty cut is not an error: it is a blank first line whose terminator an earlier
          // deletion in this call already took (deleting the unterminated last line after it), so
          // the line is already gone and there is nothing left to splice. Whether the edit is a
          // no-op was decided against `initial`, where it was not one.
          const cut = deletion();
          if (cut.end > cut.start) {
            splice(i, cut.start, cut.end, '', span.start, span.prev);
            cutPoints.push(cut.start);
          }
          return;
        }
        splice(i, span.start, span.end, replacement);
        // Never read for a blank-line deletion: the hook was not called, so it would report the
        // previous edit's terminator.
        if (!blankDeletion) recordRestored(span.start);
        if (commentedLength !== undefined) {
          // No intersection check is needed against `preserved` here: an earlier splice that
          // touched this range — its span, or the terminator after it, which it owns — would
          // have thrown (a blank line's empty span included, since it owns its terminator), and
          // one entirely before it inserted its whole replacement (preserved block included)
          // before this range's shifted start.
          pushPreserved(i, span.start, span.start + commentedLength, true);
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
      const origin: MatchOrigin = {
        original: initial,
        start: toInitial(matchIndex, true),
        end: toInitial(matchEnd),
      };
      const newString = opts.preserve
        ? opts.preserve.transform(edit, matchIndex, content, undefined, origin)
        : edit.newString;
      const commentedLength = opts.preserve ? opts.preserve.lastInsertion() : undefined;
      // Not `content.replace(edit.oldString, newString)`: String.prototype.replace treats a
      // string *replacement* argument specially — $$, $&, $`, $', $1 etc. are substitution
      // patterns, not literal text — and LaTeX is full of literal `$`. That corrupts both a
      // caller-supplied newString containing e.g. `$$100$$` and, since preservation generates
      // the replacement text server-side, text the user never typed at all. Splice at the
      // already-computed matchIndex instead so newString lands byte-exact, unconditionally.
      splice(i, matchIndex, matchEnd, newString);
      if (opts.preserve) recordRestored(matchIndex);
      if (commentedLength !== undefined) {
        // Whether a '\n' now after the match was the one after it in the file as found — the
        // CRLF a trailing '\r' split, which the hook judges there — or one an earlier edit of
        // this call moved up against it. Judged where the hook judged it (`judgedAt`'s rule).
        const placed =
          origin.start !== null &&
          origin.end !== null &&
          initial.slice(origin.start, origin.end) === edit.oldString;
        pushPreserved(
          i,
          matchIndex,
          matchIndex + commentedLength,
          commentedLength < newString.length || !placed || initial[origin.end as number] === '\n',
        );
      }
    });
    for (const point of [...cutPoints].sort((a, b) => b - a)) unfuse(point);
    assertBlocksStillComments();
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
        `[web-latex-mcp] could not attribute the change to ${quoteId(relPath)} to this session:`,
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

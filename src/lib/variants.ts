/**
 * What-if builds (`compile`'s `overlay`, #205): compile the project with some files edited in
 * memory, without writing a byte of the project.
 *
 * The build runs in a **link farm**: a directory that mirrors the project's directory tree, where
 * every file is a link to its source file except the overlaid ones, which are real files holding
 * the edited text. The backend runs with the farm as its working directory (latexmk keeps `-cd`
 * and the same project-relative `rootFile`) and a private `-outdir`, so `\input{./x}`,
 * `\input{../shared/defs}`, `\include`, `\graphicspath`, a local `.sty` and a `.bib` all resolve
 * as they do in the project — as long as they stay inside it. The limit: a `../` input that LEAVES
 * the project resolves inside the variant's own directory instead (the farm mirrors the project,
 * not its parent), finds nothing there and fails, where a normal compile reads it. A `TEXINPUTS`
 * overlay was tried first and fails on every `./` and `../` name: kpathsea never searches the path
 * for an explicitly relative name.
 *
 * The server itself never reads THROUGH the farm: TeX reads what a normal compile of the project
 * would read, so the farm adds no read surface. The only project files this module reads are the
 * overlaid ones, through `FileService` under the project's link policy (as `read_file` does), and
 * it writes nothing through `FileService` — no shadow record, no baseline.
 *
 * Layout, under the project's build dir: `variants/<handle>/` holding `src/` (the farm, rebuilt
 * from scratch on every overlay compile), `out/` (the `-outdir`, kept so latexmk is incremental),
 * `render/` (this variant's PNGs) and `variant.json` (the manifest). The handle is a hash of
 * everything that decides the build, so recompiling the same overlay reuses its `out/`. At most
 * {@link MAX_VARIANTS} variants are kept per project.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { buildDir, buildPdfPathIn } from '../services/compiler.js';
import type { Engine } from '../services/compiler.js';
import { applyEditsToContent } from '../services/fileService.js';
import type { AnyEditOp } from '../services/fileService.js';
import type { CompilerKind } from '../types.js';
import { childPathInside, quoteId } from './projectId.js';
import { resolveInside, toPosix } from './paths.js';
import { matchIsCommented, supportsLineComments } from './rewriteMode.js';
import type { SnippetReader } from './sourceSnippet.js';

/**
 * Variants kept per project: the most recently compiled (manifest `usedAt`); the rest are removed
 * after each overlay compile.
 */
export const MAX_VARIANTS = 4;
/** Files and directories a link farm may hold — every one of them is a link or a `mkdir`. */
export const MAX_FARM_ENTRIES = 20000;
/**
 * Bytes a farm may COPY rather than link (win32 only: a hard link that failed, a read-only file, a
 * file symlink). Linking costs nothing per byte; a copy of a project with large figures on another
 * drive than the temp directory does, and every overlay compile rebuilds the farm.
 */
export const MAX_FARM_COPY_BYTES = 512 * 1024 * 1024;
/** Overlay entries (files) one compile may carry. */
export const MAX_OVERLAY_FILES = 20;
/** Edits across every overlay entry of one compile. */
export const MAX_OVERLAY_EDITS = 100;

const HANDLE_RE = /^v[0-9a-f]{12}$/;

/**
 * The rc files latexmk reads from its working directory, lowercase: an overlay may not name one
 * (compared under the platform's case fold, like every other overlay name).
 */
const LATEXMK_RC_NAMES = new Set(['latexmkrc', '.latexmkrc']);

/** A caller-supplied handle, validated BEFORE it is ever joined into a path. */
export function isVariantHandle(s: string): boolean {
  return HANDLE_RE.test(s);
}

/** A caller-supplied value for a message: escaped as ids are, and cut so a huge one stays short. */
function quoteValue(s: string): string {
  const chars = [...s];
  return quoteId(chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : s);
}

/** One overlay entry as `compile` receives it: a project file and `edit_file`'s edits for it. */
export interface OverlayEntry {
  file: string;
  edits: AnyEditOp[];
}

/** Everything that decides a variant's build, and so its handle. */
export interface VariantKey {
  rootFile: string;
  engine?: Engine;
  compiler: CompilerKind;
  shellEscape?: boolean;
  restrictedShellEscape?: boolean;
  overlay: OverlayEntry[];
}

/**
 * A name as the platform's default filesystem compares it — case-folded on win32 and darwin, the
 * rule `samePath` applies — with the platform injectable so the fold is testable anywhere.
 */
function foldName(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' || platform === 'darwin' ? name.toLowerCase() : name;
}

/**
 * The on-disk identity of a directory entry (device + inode, exact as bigints), or undefined when
 * it cannot be read or the filesystem reports no inode. `lstat`, so a symbolic link is its own
 * entry: two names are "the same file" here only when they are one directory entry (a case
 * variant on a case-insensitive filesystem) or hard links to one file.
 */
async function entryIdentity(abs: string): Promise<string | undefined> {
  try {
    const st = await lstat(abs, { bigint: true });
    return st.ino === 0n ? undefined : `${st.dev}:${st.ino}`;
  } catch {
    return undefined;
  }
}

/** A relative path spelled with `/`, `.` segments and a leading `./` gone. Pure. */
export function normalizeRelPosix(p: string): string {
  const n = path.posix.normalize(toPosix(p));
  return n.startsWith('./') ? n.slice(2) : n;
}

/**
 * The variant's handle: `v` + 12 hex of SHA-256 over the build's inputs, in a fixed shape.
 * Deterministic, so compiling the same overlay again reuses the variant's `out/` incrementally;
 * sensitive to each input, so two different builds never share a build dir.
 */
export function variantHandle(key: VariantKey): string {
  const canonical = JSON.stringify({
    rootFile: normalizeRelPosix(key.rootFile),
    engine: key.engine ?? 'pdflatex',
    compiler: key.compiler,
    shellEscape: !!key.shellEscape,
    restrictedShellEscape: !!key.restrictedShellEscape,
    overlay: key.overlay.map((o) => ({ file: normalizeRelPosix(o.file), edits: o.edits })),
  });
  return `v${createHash('sha256').update(canonical).digest('hex').slice(0, 12)}`;
}

export interface VariantPaths {
  root: string;
  /** The link farm the backend runs in. */
  src: string;
  /** The backend's `-outdir`. */
  out: string;
  /** Where `render_pages` writes this variant's PNGs. */
  render: string;
  manifest: string;
}

/** The directory every variant of a project sits in. */
function variantsDir(projectDir: string): string {
  return path.join(buildDir(projectDir), 'variants');
}

/**
 * Where a variant lives. The handle is validated first and joined as one directory entry, so a
 * caller-supplied value can never name a path outside the project's `variants/`.
 */
export function variantPaths(projectDir: string, handle: string): VariantPaths {
  if (!isVariantHandle(handle)) {
    throw new Error(
      `Not a variant handle: ${quoteValue(handle)}. A handle is "v" followed by 12 lowercase ` +
        'hex digits, exactly as compile returned it in `variant`.',
    );
  }
  const root = childPathInside(variantsDir(projectDir), handle, 'variant handle');
  return {
    root,
    src: path.join(root, 'src'),
    out: path.join(root, 'out'),
    render: path.join(root, 'render'),
    manifest: path.join(root, 'variant.json'),
  };
}

/** How one entry is linked into a farm. */
type EntryKind = 'dir' | 'file' | 'symlink';

/**
 * What one variant's farm may still create and copy. ONE budget is shared by everything a stage
 * does — {@link buildLinkFarm} and every {@link placeOverlayFile} after it — so
 * {@link MAX_FARM_ENTRIES} and {@link MAX_FARM_COPY_BYTES} are limits per compile, not per call: a
 * placement under a linked directory materialises that directory, linking every child of it.
 */
export interface FarmBudget {
  entries: number;
  maxEntries: number;
  copied: number;
  maxCopyBytes: number;
}

/** A fresh budget for one variant's stage. */
export function newFarmBudget(
  opts: { maxEntries?: number; maxCopyBytes?: number } = {},
): FarmBudget {
  return {
    entries: 0,
    maxEntries: opts.maxEntries ?? MAX_FARM_ENTRIES,
    copied: 0,
    maxCopyBytes: opts.maxCopyBytes ?? MAX_FARM_COPY_BYTES,
  };
}

/** Count one entry the farm is about to create, refusing in words once the cap is passed. */
function chargeEntry(budget: FarmBudget): void {
  if (++budget.entries > budget.maxEntries) {
    throw new Error(
      `This project has more than ${budget.maxEntries} files and directories; an overlay compile ` +
        'links every one of them into a private copy of the tree, so it is refused here. Compile ' +
        'without overlay, or move what the document does not need out of the project.',
    );
  }
}

/** Copy `src` to `dest`, charging the budget first and refusing in words once it is spent. */
async function copyCharged(src: string, dest: string, budget: FarmBudget): Promise<void> {
  const size = (await stat(src)).size;
  if (budget.copied + size > budget.maxCopyBytes) {
    throw new Error(
      `An overlay compile would have to copy more than ${Math.round(budget.maxCopyBytes / 1024 / 1024)} ` +
        "MiB of this project into its private build tree, so it is refused. On Windows a farm's " +
        'files are hard links, and they are copied instead when hard-linking fails — most often ' +
        'because the project is on a different drive than the temp directory — or when a file ' +
        'is read-only or a symbolic link. Move the project (or TEMP) onto one drive, or compile ' +
        'without overlay.',
    );
  }
  budget.copied += size;
  await copyFile(src, dest);
}

/**
 * Link `src` at `dest`. The target is always the ABSOLUTE path of the entry itself, never the
 * entry's own link target, so a project symlink resolves exactly as it does in a normal compile.
 *
 * POSIX: a symlink, whatever the entry is. win32, where a symlink needs a privilege most users do
 * not have: a directory (or a link that resolves to one) becomes a junction, and a regular file a
 * hard link — falling back to a copy on any error (another volume, a filesystem without hard
 * links). A read-only file is copied rather than hard-linked: hard links share their attributes,
 * and deleting a farm's link (libuv's unlink clears FILE_ATTRIBUTE_READONLY first) would strip
 * read-only from the source file. A link to a file becomes a copy of what it points at (a dangling
 * one is left out). Every copy is charged to `budget`.
 */
async function linkEntry(
  src: string,
  dest: string,
  kind: EntryKind,
  platform: NodeJS.Platform,
  budget: FarmBudget,
): Promise<void> {
  if (platform !== 'win32') {
    await symlink(src, dest);
    return;
  }
  if (kind === 'dir') {
    await symlink(src, dest, 'junction');
    return;
  }
  if (kind === 'symlink') {
    let isDir: boolean;
    try {
      isDir = (await stat(src)).isDirectory();
    } catch {
      return; // dangling: nothing a compile could read through it either
    }
    if (isDir) await symlink(src, dest, 'junction');
    else await copyCharged(src, dest, budget);
    return;
  }
  if (((await stat(src)).mode & 0o200) === 0) {
    await copyCharged(src, dest, budget);
    return;
  }
  try {
    await link(src, dest);
  } catch {
    await copyCharged(src, dest, budget);
  }
}

function kindOf(entry: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): EntryKind | undefined {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  return undefined; // a fifo, a socket, a device: nothing TeX reads as a source
}

/**
 * Build a link farm of `projectDir` at `farmDir`: every real directory is recreated and walked,
 * every file and every symlink becomes ONE link to its absolute source path (a symlinked directory
 * is never walked — its link resolves exactly as the project's does). Entries named `.git` are
 * skipped, and so is any directory in `skip` — the workspace root and the build root, since a
 * local project registered at the launch directory contains the workspace. Returns how many
 * entries it created; more than the budget's `maxEntries` is refused, since every one of them is a
 * syscall. Pass `budget` to share it with the {@link placeOverlayFile} calls that follow (a stage
 * does); otherwise a fresh one is made from `maxEntries`/`maxCopyBytes`.
 */
export async function buildLinkFarm(
  projectDir: string,
  farmDir: string,
  opts: {
    skip: string[];
    platform?: NodeJS.Platform;
    maxEntries?: number;
    maxCopyBytes?: number;
    budget?: FarmBudget;
  },
): Promise<number> {
  const skip = new Set(opts.skip.map((p) => path.resolve(p)));
  const platform = opts.platform ?? process.platform;
  const budget =
    opts.budget ?? newFarmBudget({ maxEntries: opts.maxEntries, maxCopyBytes: opts.maxCopyBytes });
  let count = 0;
  const walk = async (srcDir: string, destDir: string): Promise<void> => {
    const entries = await readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const src = path.join(srcDir, entry.name);
      const kind = kindOf(entry);
      if (kind === undefined) continue;
      if (kind === 'dir' && skip.has(path.resolve(src))) continue;
      chargeEntry(budget);
      count++;
      const dest = path.join(destDir, entry.name);
      if (kind === 'dir') {
        await mkdir(dest);
        await walk(src, dest);
      } else {
        await linkEntry(src, dest, kind, platform, budget);
      }
    }
  };
  await mkdir(farmDir, { recursive: true });
  await walk(path.resolve(projectDir), farmDir);
  return count;
}

/**
 * The project's tree as `lstat` sees it, for telling afterwards whether a variant build wrote it:
 * project-relative POSIX path -> a signature of kind, size, mode, inode, mtime and ctime (in ns).
 * The change time is there because it cannot be set back — a rewrite of the same length whose
 * mtime is restored still moves it.
 */
export interface SourceSnapshot {
  entries: Map<string, string>;
}

/**
 * Snapshot the project's tree the way {@link buildLinkFarm} walks it — `.git` and the `skip`
 * directories left out, a linked directory recorded as ONE entry and never walked — reading no
 * file's content. Undefined when the tree has more than `maxEntries` entries, since a walk that
 * stopped part-way cannot vouch for the rest.
 *
 * Why it exists: the farm's links make the variant's build able to write the source, and some of
 * the routes are not the server's to close — the project's own latexmkrc can put `-shell-escape`
 * back after the server's `-no-shell-escape`, lualatex's `io.open` needs no shell escape, and
 * tectonic's `\openout` writes any absolute path (it has no `openout_any`). So `compile` compares a
 * snapshot from before the build with one from after and names what changed, rather than asserting
 * the source is untouched. It observes and reports; it never undoes a write.
 */
export async function snapshotSource(
  projectDir: string,
  opts: { skip: string[]; maxEntries?: number },
): Promise<SourceSnapshot | undefined> {
  const skip = new Set(opts.skip.map((p) => path.resolve(p)));
  const max = opts.maxEntries ?? MAX_FARM_ENTRIES;
  const entries = new Map<string, string>();
  const base = path.resolve(projectDir);
  const walk = async (dir: string, relDir: string): Promise<boolean> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const abs = path.join(dir, entry.name);
      const kind = kindOf(entry);
      if (kind === undefined) continue;
      if (kind === 'dir' && skip.has(path.resolve(abs))) continue;
      if (entries.size >= max) return false;
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (kind === 'dir') {
        entries.set(rel, 'dir');
        if (!(await walk(abs, rel))) return false;
        continue;
      }
      const st = await lstat(abs, { bigint: true });
      entries.set(rel, `${kind}:${st.size}:${st.mode}:${st.ino}:${st.mtimeNs}:${st.ctimeNs}`);
    }
    return true;
  };
  return (await walk(base, '')) ? { entries } : undefined;
}

/** The project-relative paths added, removed or changed between two snapshots, sorted. Pure. */
export function sourceChanges(before: SourceSnapshot, after: SourceSnapshot): string[] {
  const changed = new Set<string>();
  for (const [rel, sig] of before.entries) if (after.entries.get(rel) !== sig) changed.add(rel);
  for (const rel of after.entries.keys()) if (!before.entries.has(rel)) changed.add(rel);
  return [...changed].sort();
}

/**
 * Snapshot the project now and return how to ask, later, what changed since: the sorted changed
 * paths, or undefined when either walk failed or hit the entry cap — "could not check", which a
 * caller must never report as "nothing changed". Never throws: a check that cannot run must not
 * fail the compile it reports on.
 */
export async function watchSource(
  projectDir: string,
  opts: { skip: string[]; maxEntries?: number },
): Promise<() => Promise<string[] | undefined>> {
  const snap = () => snapshotSource(projectDir, opts).catch(() => undefined);
  const before = await snap();
  return async () => {
    if (before === undefined) return undefined;
    const after = await snap();
    return after === undefined ? undefined : sourceChanges(before, after);
  };
}

/** How many changed paths the hint names; the rest are counted. The house figure for a list. */
const SOURCE_CHANGES_NAMED = 20;

/**
 * The `hint` for a variant build that changed project files: which ones (the first
 * {@link SOURCE_CHANGES_NAMED}, the rest counted), what can have written them, and what to do.
 */
export function sourceChangedHint(paths: string[]): string {
  const named = paths.slice(0, SOURCE_CHANGES_NAMED).map(quoteId).join(', ');
  const more = paths.length - SOURCE_CHANGES_NAMED;
  return (
    `This overlay compile changed ${paths.length} project file(s) while it ran: ${named}` +
    (more > 0 ? `, and ${more} more` : '') +
    '. An overlay compile writes nothing to the project itself, but the build can, through the ' +
    "variant's links to the source: shell escape (if you opted in, or the project's own " +
    'latexmkrc turned it back on), Lua code under lualatex (io.open), or \\openout under ' +
    'tectonic, which restricts no path — or the files were edited by hand meanwhile. Review them ' +
    '(status, diff) and restore what you did not mean to change (discard).'
  );
}

/**
 * Put `content` at `relPosix` in the farm as a real file. When an ancestor of that path is a link
 * in the farm (a symlinked directory in the source), it is materialised first: replaced by a real
 * directory whose children are links to `<projectDir>/<prefix>/<child>`, repeating down the path,
 * so writing the file can never write through a link into the source. The file's own link is
 * removed, never written through, and the new file is created exclusively (`wx`). Every entry it
 * creates, and every byte it copies, is charged to `budget` — the stage's one budget, shared with
 * {@link buildLinkFarm}.
 */
export async function placeOverlayFile(
  farmDir: string,
  projectDir: string,
  relPosix: string,
  content: string,
  opts: { platform?: NodeJS.Platform; budget?: FarmBudget } = {},
): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const budget = opts.budget ?? newFarmBudget();
  const parts = relPosix.split('/');
  const name = parts.pop();
  if (name === undefined || name === '')
    throw new Error(`Not a file path: ${quoteValue(relPosix)}`);
  let farmCur = farmDir;
  let srcCur = path.resolve(projectDir);
  for (const part of parts) {
    farmCur = path.join(farmCur, part);
    srcCur = path.join(srcCur, part);
    let isLink: boolean;
    try {
      isLink = (await lstat(farmCur)).isSymbolicLink();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // Not mirrored (under a skipped directory): the overlaid file stands alone there.
      chargeEntry(budget);
      await mkdir(farmCur);
      continue;
    }
    if (!isLink) continue;
    await unlink(farmCur);
    await mkdir(farmCur);
    for (const entry of await readdir(srcCur, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const kind = kindOf(entry);
      if (kind === undefined) continue;
      chargeEntry(budget);
      await linkEntry(
        path.join(srcCur, entry.name),
        path.join(farmCur, entry.name),
        kind,
        platform,
        budget,
      );
    }
  }
  const dest = path.join(farmCur, name);
  await rm(dest, { force: true });
  await writeFile(dest, content, { encoding: 'utf8', flag: 'wx' });
}

/** `variant.json`: what the PDF tools need to read a variant back, and when it was last compiled. */
export interface VariantManifest {
  /** The root file, project-relative POSIX. */
  rootFile: string;
  createdAt: string;
  /** When the variant was last compiled — what retention orders by. */
  usedAt: string;
  /** The overlaid files, project-relative POSIX. */
  files: string[];
  compiler: CompilerKind;
  engine: Engine;
}

function isManifest(v: unknown): v is VariantManifest {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.rootFile === 'string' &&
    typeof m.createdAt === 'string' &&
    typeof m.usedAt === 'string' &&
    Array.isArray(m.files) &&
    m.files.every((f) => typeof f === 'string') &&
    typeof m.compiler === 'string' &&
    typeof m.engine === 'string'
  );
}

/** A manifest, or undefined when it is missing, unparseable or of the wrong shape. */
export async function readManifest(file: string): Promise<VariantManifest | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return isManifest(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function writeManifest(file: string, manifest: VariantManifest): Promise<void> {
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * Keep `keep` variants of the project — `current` always among them, then the most recently
 * compiled by manifest `usedAt` (an unreadable manifest counts as oldest) — and remove the rest. Only
 * directories named like a handle are considered. Removal is `rm -rf`, which unlinks a farm's
 * links without following them, so the source behind them is never touched. Returns the removed
 * handles.
 */
export async function evictVariants(
  projectDir: string,
  keep: number,
  current: string,
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(variantsDir(projectDir));
  } catch {
    return [];
  }
  const others: Array<{ handle: string; usedAt: string }> = [];
  for (const name of names) {
    if (!isVariantHandle(name) || name === current) continue;
    const manifest = await readManifest(variantPaths(projectDir, name).manifest);
    others.push({ handle: name, usedAt: manifest?.usedAt ?? '' });
  }
  others.sort((a, b) => (a.usedAt < b.usedAt ? 1 : a.usedAt > b.usedAt ? -1 : 0));
  const removed = others.slice(Math.max(0, keep - 1)).map((o) => o.handle);
  for (const handle of removed) {
    await rm(variantPaths(projectDir, handle).root, { recursive: true, force: true });
  }
  return removed;
}

/**
 * A variant as the PDF tools read it back: its root file and paths, or undefined when its
 * directory or a valid manifest is missing (evicted, or never compiled).
 */
export async function readVariant(
  projectDir: string,
  handle: string,
): Promise<{ rootFile: string; paths: VariantPaths } | undefined> {
  const paths = variantPaths(projectDir, handle);
  const manifest = await readManifest(paths.manifest);
  if (!manifest) return undefined;
  return { rootFile: manifest.rootFile, paths };
}

/**
 * The variant a PDF tool (`render_pages`, `extract_text`, `pdf_geometry`) was asked to read: its
 * root file and build paths. Refuses an invalid handle, a variant that is gone, and a `rootFile`
 * other than the one it was compiled with. Never falls back to the main build or the surfaced PDF.
 */
export async function resolveVariantBuild(
  projectDir: string,
  projectId: string,
  handle: string,
  rootFile: string | undefined,
): Promise<{ rootFile: string; paths: VariantPaths }> {
  if (!isVariantHandle(handle)) {
    throw new Error(
      `Not a variant handle: ${quoteValue(handle)}. Pass \`variant\` exactly as compile returned ` +
        'it ("v" followed by 12 lowercase hex digits).',
    );
  }
  const variant = await readVariant(projectDir, handle);
  if (!variant) {
    throw new Error(
      `No variant ${quoteValue(handle)} for project ${quoteId(projectId)}: it was evicted — ` +
        `only the ${MAX_VARIANTS} most recently compiled are kept — or never compiled. Compile ` +
        'with the overlay again.',
    );
  }
  if (rootFile !== undefined && normalizeRelPosix(rootFile) !== variant.rootFile) {
    throw new Error(
      `Variant ${quoteValue(handle)} was compiled from ${quoteId(variant.rootFile)}, not ` +
        `${quoteValue(rootFile)}. Omit rootFile to read the variant, or compile the overlay ` +
        'with that root.',
    );
  }
  return variant;
}

/** The slice of `FileService` an overlay reads through — narrow so tests can hand in a stub. */
export interface OverlayReader {
  readTextExact(projectDir: string, relPath: string): Promise<string | null>;
  linkTarget(projectDir: string, relPath: string): Promise<string | null>;
}

/**
 * Apply an overlay in memory: read each named file through `files` (the project's link policy,
 * no baseline) and apply its edits with {@link applyEditsToContent}, exactly as `edit_file`
 * would — `excludeComments` included, never preservation. Nothing is written. Returns the edited
 * content per project-relative POSIX path, in the order given.
 *
 * Refused, before anything is read: more than {@link MAX_OVERLAY_EDITS} edits in total, a path
 * that is empty or leaves the project, a latexmk rc file (`latexmkrc`, `.latexmkrc` — Perl latexmk
 * runs from the farm), and a file named twice — after normalisation, and under the
 * platform's case fold (win32, darwin). Refused per file, naming it: a file that does not exist,
 * one that is the same directory entry or hard-linked file as an earlier entry (`Main.tex` beside
 * `main.tex` on a case-insensitive filesystem, wherever it runs: both would be applied to the
 * original and only the second would reach the farm, silently losing the first one's edits), one
 * that is not valid UTF-8, an `excludeComments` edit on a file with no `%` comment syntax, and
 * any edit `edit_file` would refuse.
 */
export async function applyOverlay(
  files: OverlayReader,
  projectDir: string,
  overlay: OverlayEntry[],
  opts: { platform?: NodeJS.Platform } = {},
): Promise<Map<string, string>> {
  const platform = opts.platform ?? process.platform;
  const sameFile = (i: number, rel: string, j: number, earlier: string) =>
    new Error(
      `Overlay entry ${i + 1} names ${quoteId(rel)}, the same file as entry ${j + 1} ` +
        `(${quoteId(earlier)}): name each file once and list all its edits in that entry.`,
    );
  const total = overlay.reduce((n, o) => n + o.edits.length, 0);
  if (total > MAX_OVERLAY_EDITS) {
    throw new Error(
      `The overlay carries ${total} edits; at most ${MAX_OVERLAY_EDITS} are allowed across all ` +
        'its entries. Split the experiment, or use write_file on a scratch copy.',
    );
  }
  const normalized: string[] = [];
  const seen = new Map<string, number>();
  for (const [i, entry] of overlay.entries()) {
    const abs = resolveInside(projectDir, entry.file);
    const rel = toPosix(path.relative(path.resolve(projectDir), abs));
    if (rel === '') {
      throw new Error(`Overlay entry ${i + 1}: ${quoteValue(entry.file)} does not name a file.`);
    }
    // latexmk reads `latexmkrc`/`.latexmkrc` from the directory it runs in — the farm — and runs
    // it as Perl, whatever the shell-escape flags say, so an overlaid one could write the source
    // through the farm's links. The project's own rc file still runs, as in a normal compile.
    if (LATEXMK_RC_NAMES.has(foldName(path.posix.basename(rel), platform))) {
      throw new Error(
        `Overlay entry ${i + 1} (${quoteId(rel)}) is a latexmk configuration file, which latexmk ` +
          'runs as Perl code, so an overlay may not replace it: the variant builds among links to ' +
          "the project's own files, and that code could write through them. Edit the file itself " +
          '(edit_file) and compile without overlay, or overlay the .tex files instead.',
      );
    }
    const earlier = seen.get(foldName(rel, platform));
    if (earlier !== undefined) throw sameFile(i, rel, earlier, normalized[earlier]!);
    seen.set(foldName(rel, platform), i);
    normalized.push(rel);
  }
  const identities = new Map<string, number>();
  const out = new Map<string, string>();
  for (const [i, entry] of overlay.entries()) {
    const rel = normalized[i]!;
    const where = `Overlay entry ${i + 1} (${quoteId(rel)})`;
    // Same assertion edit_file makes: excludeComments protects commented matches, so a file with
    // no % comment syntax is refused rather than filtered against a character it does not have.
    // Judged on the link-resolved name too, as edit_file judges it.
    const commentFiltered = entry.edits.findIndex(
      (e) => 'excludeComments' in e && e.excludeComments,
    );
    if (commentFiltered !== -1) {
      const target = await files.linkTarget(projectDir, rel);
      const commentSyntax =
        supportsLineComments(rel) && (target === null || supportsLineComments(target));
      if (!commentSyntax) {
        throw new Error(
          `${where}: edit ${commentFiltered + 1} sets excludeComments, but the file has no ` +
            '%-line-comment syntax, so there are no comments to exclude. Drop excludeComments, ' +
            'or target a .tex-family file.',
        );
      }
    }
    let original: string | null;
    try {
      original = await files.readTextExact(projectDir, rel);
    } catch (err) {
      throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
    if (original === null) {
      throw new Error(
        `${where}: the file is not valid UTF-8, and an overlay applies its edits to the text as ` +
          'UTF-8, which would replace every character it cannot decode. Convert it to UTF-8 first.',
      );
    }
    // `readTextExact` answers '' for a missing file (its append caller creates one), so an empty
    // answer is checked: an overlay edits what exists, and a typo must not compile as a new file.
    if (original === '') {
      let isFile: boolean;
      try {
        isFile = (await stat(resolveInside(projectDir, rel))).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) {
        throw new Error(`${where}: no such file in the project. An overlay edits existing files.`);
      }
    }
    // The fold above only knows the platform's DEFAULT; this knows the filesystem. Two names for
    // one directory entry (or one hard-linked file) must not be overlaid twice.
    const identity = await entryIdentity(resolveInside(projectDir, rel));
    if (identity !== undefined) {
      const j = identities.get(identity);
      if (j !== undefined) throw sameFile(i, rel, j, normalized[j]!);
      identities.set(identity, i);
    }
    let content: string;
    try {
      ({ content } = applyEditsToContent(original, rel, entry.edits, {
        excludeMatch: matchIsCommented,
      }));
    } catch (err) {
      throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
    out.set(rel, content);
  }
  return out;
}

/**
 * Refuse an overlay compile whose root file sits under a symbolic link (a junction on win32 —
 * `lstat` reports one as a link) somewhere in its DIRECTORY path within the project.
 *
 * In the farm a linked directory is ONE link to the source's absolute path, and latexmk's `-cd`
 * chdir()s into the root's directory — so the engine would run physically inside the SOURCE
 * directory: it reads none of the overlays placed elsewhere in the farm, and anything it writes by
 * a relative name lands in the source. Materialising the directory (which an overlay under it
 * does) is no cure either: `\input{../common/x}` then resolves against the link's parent, not its
 * target's, and a silently different document compiles. So the root must be named through its
 * real path, which a normal compile treats as the same document.
 *
 * Judged whatever the backend (tectonic has no `-cd`, but the `../` half applies to any engine
 * that resolves relative to the root): simple and conservative. A root at the project root has no
 * directory components and is never refused; a component that does not exist ends the check (the
 * compile reports the missing root). Throws; returns nothing.
 *
 * The check judges the normalised spelling, and the backend is handed the caller's raw one — so
 * first it refuses every spelling for which the two can resolve differently. A `..` segment:
 * normalising `paper/../p1/main.tex` drops `paper` lexically, while latexmk's `-cd` resolves it
 * physically, through the farm's link, into the source (and a root that leaves the project has no
 * farm to build in at all). An ABSOLUTE root: `-cd` goes straight to the source directory, farm or
 * no farm — refused with the project-relative spelling to pass when it lies inside. A
 * drive-qualified name (`C:\p\main.tex`, or drive-relative `C:main.tex`) is refused with them on
 * EVERY platform, not only win32: whether a root is accepted must not depend on where the server
 * runs. What is left (`./`, doubled or trailing separators, backslashes) normalises to what the OS
 * resolves.
 *
 * This is the one check of an overlay's root: `compile` calls it on the caller's raw spelling
 * before the overlay is read, and {@link stageVariant} again before anything is staged.
 */
export async function refuseLinkedRootDir(
  projectDir: string,
  rootFile: string,
  opts: { platform?: NodeJS.Platform } = {},
): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const raw = toPosix(rootFile).replace(/\\/g, '/');
  const posixAbsolute = path.posix.isAbsolute(raw);
  // A drive prefix, on every platform: absolute (`C:/p`) or drive-relative (`C:main.tex`) on win32.
  const driveQualified = /^[A-Za-z]:/.test(raw);
  if (posixAbsolute || driveQualified || path.win32.isAbsolute(rootFile)) {
    // Suggest a relative spelling only for a path absolute on the platform that resolves it here;
    // a drive-relative name resolves against that drive's current directory, which says nothing.
    const inside =
      platform === process.platform && path.isAbsolute(rootFile)
        ? path.relative(path.resolve(projectDir), path.resolve(rootFile))
        : '';
    const relSpelling =
      inside !== '' && !inside.startsWith('..') && !path.isAbsolute(inside)
        ? toPosix(inside)
        : undefined;
    const what =
      driveQualified && !path.win32.isAbsolute(rootFile)
        ? 'is spelled with a drive prefix, which Windows reads as an absolute or drive-relative ' +
          'path (so it is refused on every platform)'
        : 'is an absolute path';
    throw new Error(
      `The root file ${quoteId(rootFile)} ${what}, and an overlay compile builds in a private ` +
        'mirror of the project, which such a root would bypass: the engine would run outside ' +
        'the mirror — in the source directory itself when the root is in the project. ' +
        (relSpelling !== undefined
          ? `Name it relative to the project root — rootFile: ${quoteId(relSpelling)}.`
          : 'Name it relative to the project root.'),
    );
  }
  if (raw.split('/').includes('..')) {
    throw new Error(
      `The root file ${quoteId(rootFile)} is spelled with a ".." segment, and an overlay compile ` +
        'refuses one: the engine resolves ".." physically — through a symbolic link, into the ' +
        "link's target — while the variant is staged from the name as written, so the two can " +
        'name different directories, one of them the source itself. Name the root by its path ' +
        'from the project root, without "..".',
    );
  }
  const rel = normalizeRelPosix(rootFile);
  const dirs = path.posix
    .dirname(rel)
    .split('/')
    .filter((c) => c !== '' && c !== '.');
  const base = path.resolve(projectDir);
  for (let i = 0; i < dirs.length; i++) {
    const linkRel = dirs.slice(0, i + 1).join('/');
    const abs = path.join(base, ...dirs.slice(0, i + 1));
    let isLink: boolean;
    try {
      isLink = (await lstat(abs)).isSymbolicLink();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(
        `Cannot check whether the root file's directory ${quoteId(linkRel)} is a symbolic link, ` +
          'so the overlay compile is refused.',
        { cause: err },
      );
    }
    if (!isLink) continue;
    let realRoot: string | undefined;
    try {
      const target = await realpath(path.join(base, ...dirs));
      const inside = path.relative(await realpath(base), target);
      if (inside !== '' && !inside.startsWith('..') && !path.isAbsolute(inside)) {
        realRoot = path.posix.join(toPosix(inside), path.posix.basename(rel));
      }
    } catch {
      realRoot = undefined;
    }
    throw new Error(
      `The root file ${quoteId(rel)} is reached through ${quoteId(linkRel)}, which is a symbolic ` +
        'link to a directory, and an overlay compile cannot build through one: the variant would ' +
        "compile in the link's target (the source itself) or resolve ../ inputs against the " +
        'wrong directory. ' +
        (realRoot !== undefined
          ? `Pass the root through its real path — rootFile: ${quoteId(realRoot)}, which a ` +
            'normal compile treats as the same document — and name the overlay files by their ' +
            'real paths too.'
          : 'Its target is not a directory inside the project, so it cannot be an overlay root; ' +
            'compile without overlay, or move the document into the project.'),
    );
  }
}

/**
 * Stage a variant for compiling: rebuild its link farm from scratch, place the overlaid files,
 * create its `out/`, and write its manifest (keeping `createdAt` across rebuilds of one handle).
 * Refused, before anything is staged, when the root file's spelling or its directory path cannot
 * be built as a variant ({@link refuseLinkedRootDir}; `compile` has already called it before
 * reading the overlay, and it is called again here so no caller stages around it).
 * The farm and every placement share ONE {@link FarmBudget}, so the entry and copy caps bound the
 * whole stage. Writing the manifest stamps `usedAt`: this is what makes a variant the most
 * recently compiled for {@link evictVariants}.
 */
export async function stageVariant(opts: {
  projectDir: string;
  handle: string;
  rootFile: string;
  engine: Engine;
  compiler: CompilerKind;
  contents: Map<string, string>;
  skip: string[];
  platform?: NodeJS.Platform;
  now?: Date;
  maxFarmEntries?: number;
  maxFarmCopyBytes?: number;
}): Promise<VariantPaths> {
  await refuseLinkedRootDir(opts.projectDir, opts.rootFile, { platform: opts.platform });
  const paths = variantPaths(opts.projectDir, opts.handle);
  await mkdir(paths.root, { recursive: true });
  await rm(paths.src, { recursive: true, force: true });
  const budget = newFarmBudget({
    maxEntries: opts.maxFarmEntries,
    maxCopyBytes: opts.maxFarmCopyBytes,
  });
  await buildLinkFarm(opts.projectDir, paths.src, {
    skip: opts.skip,
    platform: opts.platform,
    budget,
  });
  for (const [rel, content] of opts.contents) {
    await placeOverlayFile(paths.src, opts.projectDir, rel, content, {
      platform: opts.platform,
      budget,
    });
  }
  await mkdir(paths.out, { recursive: true });
  const previous = await readManifest(paths.manifest);
  const now = (opts.now ?? new Date()).toISOString();
  await writeManifest(paths.manifest, {
    rootFile: normalizeRelPosix(opts.rootFile),
    createdAt: previous?.createdAt ?? now,
    usedAt: now,
    files: [...opts.contents.keys()],
    compiler: opts.compiler,
    engine: opts.engine,
  });
  return paths;
}

/**
 * A snippet reader for an overlay compile: an overlaid file's snippet comes from the overlaid
 * text — the text TeX compiled, which the error's line number refers to — and every other file
 * from `files`. The link guard still applies to an overlaid path when the read asks for it.
 *
 * A log may spell an overlaid file differently from the overlay (`sections/b.tex` for an overlay
 * of `Sections/B.tex` on a case-insensitive filesystem). Reading that spelling from disk would
 * number the ORIGINAL file's lines with the variant's line numbers, so a path that is the same
 * directory entry as an overlaid file is served the overlay when the two names are equal under
 * the platform's case fold, and otherwise (a hard link, or a fold this platform does not apply)
 * its snippet is withheld — the read throws, which `readSourceLines` counts as unreadable.
 */
export function overlaySnippetReader(
  files: SnippetReader,
  contents: Map<string, string>,
  opts: { platform?: NodeJS.Platform } = {},
): SnippetReader {
  const platform = opts.platform ?? process.platform;
  const byFold = new Map<string, string>();
  for (const rel of contents.keys()) byFold.set(foldName(rel, platform), rel);
  let identities: Map<string, string> | undefined;
  const overlaidAs = async (projectDir: string, key: string): Promise<string | undefined> => {
    if (contents.has(key)) return key;
    let abs: string;
    try {
      abs = resolveInside(projectDir, key);
    } catch {
      return undefined; // absolute (the TeX tree) or outside: not an overlaid file
    }
    const identity = await entryIdentity(abs);
    if (identity === undefined) return undefined;
    if (identities === undefined) {
      identities = new Map();
      for (const rel of contents.keys()) {
        const id = await entryIdentity(resolveInside(projectDir, rel));
        if (id !== undefined) identities.set(id, rel);
      }
    }
    const same = identities.get(identity);
    if (same === undefined) return undefined;
    if (byFold.get(foldName(key, platform)) === same) return same;
    throw new Error(
      `${quoteId(key)} is the overlaid file ${quoteId(same)} under another name; its snippet is ` +
        'withheld rather than read from the unedited file on disk.',
    );
  };
  return {
    leavesProjectThroughLink: (projectDir, relPath) =>
      files.leavesProjectThroughLink(projectDir, relPath),
    read: async (projectDir, readOpts) => {
      const rel = await overlaidAs(projectDir, normalizeRelPosix(readOpts.path));
      if (rel === undefined) return files.read(projectDir, readOpts);
      if (
        readOpts.strictLinks &&
        (await files.leavesProjectThroughLink(projectDir, readOpts.path))
      ) {
        throw new Error(`${quoteId(readOpts.path)} leaves the project through a symlink.`);
      }
      return { content: contents.get(rel)! };
    },
  };
}

/** The largest `.fls` read to check an overlay was read; a bigger one skips the check. */
export const MAX_FLS_BYTES = 16 * 1024 * 1024;

/**
 * The recorder file's working directory (`PWD`) and every `INPUT` it lists, in order. Paths are
 * as the engine wrote them: relative to `PWD`, or absolute. Pure.
 */
export function parseFls(text: string): { pwd?: string; inputs: string[] } {
  let pwd: string | undefined;
  const inputs: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('PWD ') && pwd === undefined) pwd = line.slice(4);
    else if (line.startsWith('INPUT ')) inputs.push(line.slice(6));
  }
  return { pwd, inputs };
}

/**
 * The source files `.fdb_latexmk` lists for every rule latexmk ran — the dependency lines under
 * each `[rule]` header, `  "<path>" <mtime> <size> <md5> "<from rule>"`. It is where a file the
 * ENGINE never opens is recorded: biber's and bibtex's `.bib`, makeindex's style. Paths are as
 * latexmk wrote them (relative to the directory it ran in, or absolute). Pure.
 */
export function parseFdbSources(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s+"([^"]*)"\s/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

/**
 * A build-dir file read whole; `null` when it does not exist, and `undefined` when it exists but
 * cannot be used — not a regular file, unreadable, or over `max`. The two are kept apart because
 * an absent `.fdb_latexmk` is an answer (latexmk ran no other rule) while an unusable one is not.
 */
async function readWholeBuildFile(file: string, max: number): Promise<string | null | undefined> {
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > max) return undefined;
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await handle.read(buf, 0, st.size, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/**
 * The overlaid files the variant's build never opened, by its `.fls` (what the engine opened) and
 * its `.fdb_latexmk` when there is one (what latexmk's other rules read — a `.bib` goes to biber
 * or bibtex, never to the engine, so the `.fls` alone would call every `.bib` overlay unread) —
 * an overlay reached only
 * through another name (an in-project symlink such as `notes.tex -> sections/real.tex`, or a file
 * the document never inputs) changes nothing, and the variant would otherwise read as identical to
 * the main build without a word. `undefined` when there is no usable `.fls` (tectonic writes none;
 * a missing `PWD`, or one past {@link MAX_FLS_BYTES}), or when a `.fdb_latexmk` exists but cannot
 * be used (past that size, or unreadable) — without it every `.bib` overlay would be reported
 * unread — in which case nothing is claimed. A MISSING `.fdb_latexmk` is not that case: the
 * `.fls` alone is then the whole record.
 */
export async function overlayFilesNeverRead(
  paths: VariantPaths,
  rootFile: string,
  files: string[],
  opts: { platform?: NodeJS.Platform; maxBytes?: number } = {},
): Promise<string[] | undefined> {
  const platform = opts.platform ?? process.platform;
  const stem = path.basename(rootFile).replace(/\.tex$/, '');
  const text = await readWholeBuildFile(
    path.join(paths.out, `${stem}.fls`),
    opts.maxBytes ?? MAX_FLS_BYTES,
  );
  if (text === undefined || text === null) return undefined;
  const { pwd, inputs } = parseFls(text);
  if (pwd === undefined) return undefined;
  const fdb = await readWholeBuildFile(
    path.join(paths.out, `${stem}.fdb_latexmk`),
    opts.maxBytes ?? MAX_FLS_BYTES,
  );
  if (fdb === undefined) return undefined;
  const sources = fdb === null ? [] : parseFdbSources(fdb);
  const read = new Set(
    [...inputs, ...sources].map((input) => foldName(path.resolve(pwd, input), platform)),
  );
  // The engine records its cwd as getcwd() reports it — through any link in the temp dir's own
  // path (macOS: /var -> /private/var) — so both spellings of the farm are tried.
  let realFarm = paths.src;
  try {
    realFarm = await realpath(paths.src);
  } catch {
    // keep the spelling we have
  }
  return files.filter((rel) =>
    [paths.src, realFarm].every(
      (farm) => !read.has(foldName(path.resolve(farm, ...rel.split('/')), platform)),
    ),
  );
}

/**
 * The PDF a variant's compile wrote, for the PDF tools — refused, never substituted, when there is
 * none: the variant's compile failed before writing one, and the main build's PDF is a different
 * document.
 */
export async function locateVariantPdf(
  handle: string,
  variant: { rootFile: string; paths: VariantPaths },
): Promise<string> {
  const pdf = await findVariantPdf(variant);
  if (pdf !== undefined) return pdf;
  throw new Error(
    `Variant ${quoteValue(handle)} has no PDF: its compile did not produce one. Read that ` +
      "compile's errors, fix the overlay and compile it again.",
  );
}

/** A variant's PDF, or undefined when its compile wrote none. */
export async function findVariantPdf(variant: {
  rootFile: string;
  paths: VariantPaths;
}): Promise<string | undefined> {
  const pdf = buildPdfPathIn(variant.paths.out, variant.rootFile);
  try {
    return (await stat(pdf)).isFile() ? pdf : undefined;
  } catch {
    return undefined;
  }
}

/** The `variant` input the PDF tools share, described once. */
export const VARIANT_INPUT_DESCRIPTION =
  'A `variant` handle an overlay compile returned: read that what-if build (its PDF, and its ' +
  '.aux/.log where this tool reads them) instead of the main build — never falling back to the ' +
  "main build or the surfaced PDF. rootFile may be omitted (the variant's own root is used); a " +
  'different one is refused. Refused too once the variant is evicted: only the ' +
  `${MAX_VARIANTS} most recently compiled variants of a project are kept.`;

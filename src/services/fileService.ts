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
import { resolveInside, toPosix } from '../lib/paths.js';
import { splitLines, sliceLineRange } from '../lib/lines.js';
import { FileRevisionTracker } from './fileRevisions.js';

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
}

const ASSET_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.pdf',
  '.eps',
  '.gif',
  '.svg',
  '.tiff',
  '.bmp',
  '.webp',
]);

/**
 * Prose formats. Their own type because a document is not always LaTeX: a proposal drafted in
 * markdown still has a reference list to verify and citations to cross-check, and it has to be
 * findable to be worked on.
 */
const DOC_EXT = new Set(['.md', '.markdown', '.txt', '.rst', '.org']);

const MAX_READ_BYTES = 2 * 1024 * 1024;

/**
 * Notified of every mutation this server makes, with the working-tree content either side of it
 * (null meaning the file was absent). Lets the session's shadow of its own uncommitted work be
 * kept up to date without FileService knowing anything about sessions or git.
 */
export interface MutationRecorder {
  record(
    projectDir: string,
    relPath: string,
    before: string | null,
    after: string | null,
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
 */
async function resolveThroughLinks(abs: string): Promise<string> {
  try {
    return await realpath(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const link = await readlink(abs).catch(() => null);
  if (link !== null) return path.resolve(path.dirname(abs), link);
  const parent = path.dirname(abs);
  if (parent === abs) return abs;
  // Nothing at this name: resolve the part that does exist, then re-attach the rest literally.
  // `resolveInside` has already normalized the string, so no component can climb back out.
  return path.join(await resolveThroughLinks(parent), path.basename(abs));
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
   * file named by a compile log, which the document controls. Neither describes a `mode: 'local'`
   * project — a directory the user registered in place and owns, where one shared `refs.bib`
   * symlinked into each paper is an ordinary layout that worked before this guard existed.
   *
   * Reads the server makes on its own initiative pass `strictLinks` and are refused regardless.
   */
  setLinkPolicy(followsUserLinks: (projectDir: string) => boolean): void {
    this.followsUserLinks = followsUserLinks;
  }

  /** The symlink check, unless this project is one whose owner places its own links. */
  private async guardLinks(
    projectDir: string,
    abs: string,
    relPath: string,
    strictLinks = false,
  ): Promise<void> {
    if (!strictLinks && this.followsUserLinks(projectDir)) return;
    await assertNoSymlinkEscape(projectDir, abs, relPath);
  }

  async list(
    projectDir: string,
    opts: { filter?: FileFilter; subdir?: string } = {},
  ): Promise<FileEntry[]> {
    const filter = opts.filter ?? 'all';
    const base = opts.subdir ? resolveInside(projectDir, opts.subdir) : path.resolve(projectDir);
    const collected: string[] = [];
    await this.walk(projectDir, base, collected);
    const entries = await Promise.all(
      collected.map(async (rel) => {
        const info = await stat(path.join(projectDir, rel));
        return { path: toPosix(rel), type: classify(rel), sizeBytes: info.size };
      }),
    );
    return entries
      .filter((e) => matchesFilter(e.type, filter))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Read a file, or a line range of it.
   *
   * `recordBaseline` says whether **the caller could now base a write on this file**, and so
   * defaults to false. Record only when the caller asked for this file and received all of it:
   * `read_file` does, and `list_references` (which hands back every entry verbatim). Nothing else
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
        note: `Binary or large file (${info.size} bytes); content not returned. Open directly at ${abs}`,
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
    opts: { recordBaseline?: boolean } = {},
  ): Promise<string> {
    const abs = resolveInside(projectDir, relPath);
    await this.guardLinks(projectDir, abs, relPath);
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
    },
  ): Promise<WriteResult> {
    const abs = resolveInside(projectDir, opts.path);
    await this.guardLinks(projectDir, abs, opts.path);
    let current: string | undefined;
    try {
      current = await readFile(abs, 'utf8');
    } catch {
      current = undefined; // file does not exist yet
    }
    if (
      !opts.overrideExternalChanges &&
      current !== undefined &&
      this.revisions.isStale(abs, current)
    ) {
      throw new ExternalChangeError(opts.path);
    }
    if (opts.createDirs) {
      await mkdir(path.dirname(abs), { recursive: true });
    }
    await writeFile(abs, opts.content, 'utf8');
    this.revisions.record(abs, opts.content);
    await this.notify(projectDir, opts.path, current ?? null, opts.content);
    return {
      path: opts.path,
      bytesWritten: Buffer.byteLength(opts.content, 'utf8'),
      created: current === undefined,
    };
  }

  /**
   * Apply surgical string-replacement edits. Each oldString must match uniquely unless
   * replaceAll is set. All edits are applied in memory and only written if every edit
   * succeeds (atomic) — so a failure leaves the file untouched.
   */
  async applyEdits(
    projectDir: string,
    relPath: string,
    edits: EditOp[],
    opts: { overrideExternalChanges?: boolean } = {},
  ): Promise<{ path: string; appliedEdits: number }> {
    if (edits.length === 0) {
      throw new Error('No edits provided.');
    }
    const abs = resolveInside(projectDir, relPath);
    await this.guardLinks(projectDir, abs, relPath);
    const original = await readFile(abs, 'utf8');
    if (!opts.overrideExternalChanges && this.revisions.isStale(abs, original)) {
      throw new ExternalChangeError(relPath);
    }
    let content = original;
    edits.forEach((edit, i) => {
      if (edit.oldString === edit.newString) {
        throw new Error(`Edit ${i + 1}: oldString and newString are identical.`);
      }
      const count = countOccurrences(content, edit.oldString);
      if (count === 0) {
        throw new Error(`Edit ${i + 1}: oldString not found in ${relPath}.`);
      }
      if (count > 1 && !edit.replaceAll) {
        throw new Error(
          `Edit ${i + 1}: oldString matches ${count} times in ${relPath}; add more surrounding context for a unique match, or set replaceAll.`,
        );
      }
      content = edit.replaceAll
        ? content.split(edit.oldString).join(edit.newString)
        : content.replace(edit.oldString, edit.newString);
    });
    await writeFile(abs, content, 'utf8');
    this.revisions.record(abs, content);
    await this.notify(projectDir, relPath, original, content);
    return { path: relPath, appliedEdits: edits.length };
  }

  /** Delete a file (not a directory) from the project. */
  async delete(
    projectDir: string,
    relPath: string,
    opts: { overrideExternalChanges?: boolean } = {},
  ): Promise<{ path: string }> {
    const abs = resolveInside(projectDir, relPath);
    await this.guardLinks(projectDir, abs, relPath);
    const info = await stat(abs);
    if (!info.isFile()) {
      throw new Error(`Not a file: "${relPath}"`);
    }
    const current = await readFile(abs, 'utf8').catch(() => null);
    if (!opts.overrideExternalChanges && this.revisions.hasBaseline(abs)) {
      if (current !== null && this.revisions.isStale(abs, current)) {
        throw new ExternalChangeError(relPath);
      }
    }
    await rm(abs);
    this.revisions.forget(abs);
    await this.notify(projectDir, relPath, current, null);
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
      let content: string;
      try {
        await this.guardLinks(projectDir, abs, rel);
        content = await readFile(abs, 'utf8');
      } catch {
        continue;
      }
      if (this.revisions.isExternal(abs, content)) out.push(rel);
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
    before: string | null,
    after: string | null,
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

  private async walk(root: string, dir: string, out: string[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(root, full, out);
      } else if (entry.isFile()) {
        out.push(path.relative(root, full));
      }
    }
  }
}

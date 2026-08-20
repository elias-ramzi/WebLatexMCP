import path from 'node:path';
import { readdir, readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import { resolveInside, toPosix } from '../lib/paths.js';
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

/** Sandboxed file access within a project's clone directory. */
export class FileService {
  /** Tracks the last-seen content of each file so mutations can detect out-of-band edits. */
  private readonly revisions = new FileRevisionTracker();

  /** Optional; when absent, mutations simply aren't attributed to a session. */
  private recorder?: MutationRecorder;

  /**
   * Set after construction because the recorder needs services that are built later (it resolves
   * a clone dir to a project and reads git HEAD). Every mutating method funnels through
   * `notify`, so this is the single seam where session attribution attaches.
   */
  setMutationRecorder(recorder: MutationRecorder): void {
    this.recorder = recorder;
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

  async read(
    projectDir: string,
    opts: { path: string; startLine?: number; endLine?: number },
  ): Promise<ReadResult> {
    const abs = resolveInside(projectDir, opts.path);
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
    // The whole file is read into memory even for a range request, so this is the content the
    // server now knows to be on disk — record it as the baseline for out-of-band-edit detection.
    this.revisions.record(abs, raw);
    const lines = raw.split('\n');
    const totalLines = lines.length;
    if (opts.startLine === undefined && opts.endLine === undefined) {
      return { path: opts.path, content: raw, totalLines, truncated: false };
    }
    const start = Math.max(1, opts.startLine ?? 1);
    const end = Math.min(totalLines, opts.endLine ?? totalLines);
    const content = lines.slice(start - 1, end).join('\n');
    return { path: opts.path, content, totalLines, truncated: start > 1 || end < totalLines };
  }

  /** Read a file's full text, returning '' when it does not exist (used for appends). */
  async readText(projectDir: string, relPath: string): Promise<string> {
    const abs = resolveInside(projectDir, relPath);
    try {
      const raw = await readFile(abs, 'utf8');
      this.revisions.record(abs, raw);
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

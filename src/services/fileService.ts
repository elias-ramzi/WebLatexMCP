import path from 'node:path';
import { readdir, readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import { resolveInside, toPosix } from '../lib/paths.js';

export type FileFilter = 'tex' | 'bib' | 'assets' | 'all';
export type FileType = 'tex' | 'bib' | 'asset' | 'other';

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

const MAX_READ_BYTES = 2 * 1024 * 1024;

function classify(file: string): FileType {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.tex') return 'tex';
  if (ext === '.bib') return 'bib';
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
      return await readFile(abs, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
  }

  /** Create or overwrite a file. */
  async write(
    projectDir: string,
    opts: { path: string; content: string; createDirs?: boolean },
  ): Promise<WriteResult> {
    const abs = resolveInside(projectDir, opts.path);
    let created = false;
    try {
      await stat(abs);
    } catch {
      created = true;
    }
    if (opts.createDirs) {
      await mkdir(path.dirname(abs), { recursive: true });
    }
    await writeFile(abs, opts.content, 'utf8');
    return { path: opts.path, bytesWritten: Buffer.byteLength(opts.content, 'utf8'), created };
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
  ): Promise<{ path: string; appliedEdits: number }> {
    if (edits.length === 0) {
      throw new Error('No edits provided.');
    }
    const abs = resolveInside(projectDir, relPath);
    const original = await readFile(abs, 'utf8');
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
    return { path: relPath, appliedEdits: edits.length };
  }

  /** Delete a file (not a directory) from the project. */
  async delete(projectDir: string, relPath: string): Promise<{ path: string }> {
    const abs = resolveInside(projectDir, relPath);
    const info = await stat(abs);
    if (!info.isFile()) {
      throw new Error(`Not a file: "${relPath}"`);
    }
    await rm(abs);
    return { path: relPath };
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

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { execCapture } from '../lib/exec.js';
import { synctexEditQuery } from '../lib/synctexReader.js';
import type { ExecResult } from '../lib/exec.js';
import { climbsOut } from '../lib/paths.js';

/**
 * Maps a point on a compiled PDF back to its source `file:line` via the `synctex` CLI (ships with
 * TeX Live). This is the inverse-search half of the comment loop: the viewer reports where the user
 * selected on a page, and this resolves the LaTeX source that produced it. Requires the PDF to have
 * been compiled with `-synctex=1` (a `<job>.synctex.gz` beside it); the compiler enables that.
 *
 * When the CLI is not installed (a tectonic-only machine has no TeX Live), the same question is
 * answered in-process from the `.synctex.gz` beside the PDF (`src/lib/synctexReader.ts`).
 *
 * The subprocess runner is injectable so parsing/normalization is unit-testable without TeX.
 */

const gunzipAsync = promisify(gunzip);

/** Largest decompressed synctex file read in-process: a book's is tens of megabytes. */
export const MAX_SYNCTEX_BYTES = 256 * 1024 * 1024;

/**
 * Answer a `synctex edit` query from the files beside `pdfPath` — `<job>.synctex.gz`, else an
 * uncompressed `<job>.synctex` — without the CLI. `null` when neither exists, cannot be read or
 * decompressed within {@link MAX_SYNCTEX_BYTES}, or maps the point nowhere.
 */
export async function resolveInProcess(
  pdfPath: string,
  projectDir: string,
  page: number,
  x: number,
  y: number,
): Promise<SyncTexLocation | null> {
  const base = pdfPath.replace(/\.pdf$/i, '');
  let text: string | undefined;
  try {
    const zipped = await readFile(`${base}.synctex.gz`);
    text = (await gunzipAsync(zipped, { maxOutputLength: MAX_SYNCTEX_BYTES })).toString('utf8');
  } catch {
    try {
      text = await readFile(`${base}.synctex`, 'utf8');
    } catch {
      return null;
    }
  }
  const hit = synctexEditQuery(text, page, x, y);
  return hit ? { file: normalizeInput(hit.input, projectDir), line: hit.line } : null;
}

export type Runner = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<ExecResult>;

export interface SyncTexLocation {
  /** Source file, project-relative and POSIX. */
  file: string;
  /** 1-based source line. */
  line: number;
}

/**
 * Parse `synctex edit` output. It prints an `Input:` (source path, often absolute with `./`
 * segments) and a `Line:` inside a `SyncTeX result` block. Returns null when either is missing or
 * the line is not positive. `projectDir` is used to make the path project-relative.
 */
export function parseSyncTexEdit(stdout: string, projectDir: string): SyncTexLocation | null {
  let file: string | undefined;
  let line: number | undefined;
  for (const raw of stdout.split(/\r?\n/)) {
    if (file === undefined && raw.startsWith('Input:')) {
      file = raw.slice('Input:'.length).trim();
    } else if (line === undefined && raw.startsWith('Line:')) {
      const n = Number(raw.slice('Line:'.length).trim());
      if (Number.isFinite(n)) line = n;
    }
  }
  if (!file || line === undefined || line < 1) return null;
  return { file: normalizeInput(file, projectDir), line };
}

/** The slice of `node:path` {@link normalizeInput} uses, injectable so win32 rules test anywhere. */
export type PathRules = Pick<
  typeof path,
  'isAbsolute' | 'normalize' | 'resolve' | 'relative' | 'basename' | 'sep'
>;

/**
 * Normalize a synctex `Input:` path to a clean, project-relative POSIX path.
 *
 * Exported only so the win32 branch can be tested on any host (`rules` = `path.win32`).
 */
export function normalizeInput(input: string, projectDir: string, rules: PathRules = path): string {
  const abs = rules.isAbsolute(input) ? rules.normalize(input) : rules.resolve(projectDir, input);
  const native = rules.relative(projectDir, abs);
  const rel = native.split(rules.sep).join('/');
  // Inside the project → relative path; otherwise fall back to the basename. On Windows an input
  // on another drive has no relative form, and `relative` hands back the absolute `D:\…` itself.
  return rel && !climbsOut(rel) && !rules.isAbsolute(native) ? rel : rules.basename(input);
}

export class SyncTexService {
  constructor(private readonly run: Runner = execCapture) {}

  async isAvailable(): Promise<boolean> {
    try {
      // `synctex help` exits non-zero but resolves; rejects only if the binary is absent.
      await this.run('synctex', ['help'], { timeoutMs: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve a PDF point (page + x,y in points from the top-left) to a source location, or null if
   * synctex is unavailable, the PDF has no synctex data, or the point maps nowhere.
   */
  async resolve(
    pdfPath: string,
    projectDir: string,
    page: number,
    x: number,
    y: number,
  ): Promise<SyncTexLocation | null> {
    const spec = `${page}:${Math.round(x)}:${Math.round(y)}:${pdfPath}`;
    let res: ExecResult;
    try {
      res = await this.run('synctex', ['edit', '-o', spec], { timeoutMs: 10_000 });
    } catch {
      // No CLI to run (or it could not start): read the synctex file ourselves.
      return resolveInProcess(pdfPath, projectDir, page, x, y);
    }
    return parseSyncTexEdit(res.stdout, projectDir);
  }
}

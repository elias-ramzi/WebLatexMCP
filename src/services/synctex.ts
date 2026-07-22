import path from 'node:path';
import { execCapture } from '../lib/exec.js';
import type { ExecResult } from '../lib/exec.js';
import { toPosix } from '../lib/paths.js';

/**
 * Maps a point on a compiled PDF back to its source `file:line` via the `synctex` CLI (ships with
 * TeX Live). This is the inverse-search half of the comment loop: the viewer reports where the user
 * selected on a page, and this resolves the LaTeX source that produced it. Requires the PDF to have
 * been compiled with `-synctex=1` (a `<job>.synctex.gz` beside it); the compiler enables that.
 *
 * The subprocess runner is injectable so parsing/normalization is unit-testable without TeX.
 */

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

/** Normalize a synctex `Input:` path to a clean, project-relative POSIX path. */
function normalizeInput(input: string, projectDir: string): string {
  const abs = path.isAbsolute(input) ? path.normalize(input) : path.resolve(projectDir, input);
  const rel = path.relative(projectDir, abs);
  // Inside the project → relative path; otherwise fall back to the basename.
  return toPosix(rel && !rel.startsWith('..') ? rel : path.basename(input));
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
      return null;
    }
    return parseSyncTexEdit(res.stdout, projectDir);
  }
}

import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { execCapture } from '../lib/exec.js';
import type { ExecResult } from '../lib/exec.js';
import type { CompilerKind } from '../types.js';

export type Engine = 'pdflatex' | 'xelatex' | 'lualatex';

export interface CompileRequest {
  /** Absolute path to the project clone. */
  projectDir: string;
  /** Root .tex file, relative to projectDir. */
  rootFile: string;
  engine?: Engine;
  /** Force a full rebuild. */
  clean?: boolean;
  timeoutSec?: number;
}

export interface CompileOutcome {
  success: boolean;
  pdfPath?: string;
  durationSec: number;
  /** Raw log content (the .log file when available, otherwise captured stdout/stderr). */
  log: string;
  logPath?: string;
  timedOut: boolean;
}

export interface LatexCompiler {
  isAvailable(): Promise<boolean>;
  compile(req: CompileRequest): Promise<CompileOutcome>;
}

export type { CompilerKind };

const ENGINE_FLAG: Record<Engine, string> = {
  pdflatex: '-pdf',
  xelatex: '-pdfxe',
  lualatex: '-pdflua',
};

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Per-project build dir under the OS temp root, keeping the clone clean. */
async function buildDirFor(projectDir: string): Promise<string> {
  const dir = path.join(os.tmpdir(), 'web-latex-mcp-build', path.basename(projectDir));
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Resolve the `.log` and `.pdf` a run produced. Both backends write `<jobname>.{log,pdf}`
 * into the build dir, where jobname is the root file's basename. Falls back to captured
 * stdout/stderr when no `.log` was written (e.g. the engine died before opening one).
 */
async function collectOutcome(
  buildDir: string,
  rootFile: string,
  res: ExecResult,
  durationSec: number,
): Promise<CompileOutcome> {
  const rootBase = path.basename(rootFile).replace(/\.tex$/, '');
  const logPath = path.join(buildDir, `${rootBase}.log`);
  const pdfPath = path.join(buildDir, `${rootBase}.pdf`);

  let log: string;
  let resolvedLogPath: string | undefined;
  if (await exists(logPath)) {
    log = await readFile(logPath, 'utf8');
    resolvedLogPath = logPath;
  } else {
    log = `${res.stdout}\n${res.stderr}`;
  }

  const pdfExists = await exists(pdfPath);
  return {
    success: res.code === 0 && pdfExists && !res.timedOut,
    pdfPath: pdfExists ? pdfPath : undefined,
    durationSec,
    log,
    logPath: resolvedLogPath,
    timedOut: res.timedOut,
  };
}

/** Compiles a project locally with latexmk. Build artifacts go to a temp dir, keeping the clone clean. */
export class LatexmkCompiler implements LatexCompiler {
  async isAvailable(): Promise<boolean> {
    try {
      // Resolves regardless of exit code; rejects only if latexmk is not found.
      await execCapture('latexmk', ['-v'], { timeoutMs: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async compile(req: CompileRequest): Promise<CompileOutcome> {
    const engine = req.engine ?? 'pdflatex';
    const buildDir = await buildDirFor(req.projectDir);

    const args = [
      ENGINE_FLAG[engine],
      '-interaction=nonstopmode',
      '-file-line-error',
      `-outdir=${buildDir}`,
    ];
    if (req.clean) args.push('-gg');
    args.push(req.rootFile);

    const start = Date.now();
    const res = await execCapture('latexmk', args, {
      cwd: req.projectDir,
      timeoutMs: (req.timeoutSec ?? 120) * 1000,
    });
    return collectOutcome(buildDir, req.rootFile, res, (Date.now() - start) / 1000);
  }
}

/**
 * Compiles with tectonic. Self-contained (bundles its own TeX and fetches packages on
 * demand into a local cache), so no system TeX install is needed — at the cost of a
 * network round-trip on the first, cold-cache compile.
 *
 * Tectonic is XeTeX-only: it always drives its bundled XeTeX engine and produces a PDF
 * directly, so `req.engine` is not honored (a `pdflatex`/`lualatex` request still runs
 * XeTeX). Tectonic reruns all passes internally every time, so there is no incremental
 * state to force-clean and `req.clean` is a no-op. It only writes a `.log` when asked
 * (`--keep-logs`), which the parser needs.
 */
export class TectonicCompiler implements LatexCompiler {
  async isAvailable(): Promise<boolean> {
    try {
      await execCapture('tectonic', ['--version'], { timeoutMs: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async compile(req: CompileRequest): Promise<CompileOutcome> {
    const buildDir = await buildDirFor(req.projectDir);

    const args = [req.rootFile, '--outdir', buildDir, '--keep-logs', '--chatter', 'minimal'];

    const start = Date.now();
    const res = await execCapture('tectonic', args, {
      cwd: req.projectDir,
      timeoutMs: (req.timeoutSec ?? 120) * 1000,
    });
    return collectOutcome(buildDir, req.rootFile, res, (Date.now() - start) / 1000);
  }
}

/** Build the configured compile backend. */
export function createCompiler(kind: CompilerKind): LatexCompiler {
  return kind === 'tectonic' ? new TectonicCompiler() : new LatexmkCompiler();
}

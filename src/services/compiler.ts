import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { execCapture } from '../lib/exec.js';

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
    const buildDir = path.join(os.tmpdir(), 'overleaf-mcp-build', path.basename(req.projectDir));
    await mkdir(buildDir, { recursive: true });

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
    const durationSec = (Date.now() - start) / 1000;

    const rootBase = path.basename(req.rootFile).replace(/\.tex$/, '');
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
    const success = res.code === 0 && pdfExists && !res.timedOut;

    return {
      success,
      pdfPath: pdfExists ? pdfPath : undefined,
      durationSec,
      log,
      logPath: resolvedLogPath,
      timedOut: res.timedOut,
    };
  }
}

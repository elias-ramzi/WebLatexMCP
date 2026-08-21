import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { execCapture } from '../lib/exec.js';
import type { ExecResult } from '../lib/exec.js';
import type { CompilerKind } from '../types.js';
import { toPosix } from '../lib/paths.js';

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
  /**
   * Pass `-shell-escape`, letting the document run arbitrary shell commands (needed by TikZ
   * externalization). Off by default; never inferred — the caller must opt in per compile.
   */
  shellEscape?: boolean;
  /**
   * Pass `-shell-restricted`: only TeX's allow-listed binaries may run. Safer than full
   * `shellEscape` and sufficient for most externalization setups. Ignored if `shellEscape` is set.
   */
  restrictedShellEscape?: boolean;
}

export interface CompileOutcome {
  success: boolean;
  pdfPath?: string;
  durationSec: number;
  /** Raw log content (the .log file when available, otherwise captured stdout/stderr). */
  log: string;
  logPath?: string;
  timedOut: boolean;
  /**
   * Directory the engine ran in, relative to the project root ('' for the root itself). The log's
   * paths are relative to it, not to the project: latexmk gets `-cd` and chdirs into the root
   * file's directory, so `paper/main.tex` reports its own errors as `./main.tex`. `parseLog` needs
   * it to hand back paths a caller can open.
   */
  logBaseDir: string;
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

/**
 * Per-project build dir under the OS temp root, keeping the project directory clean.
 *
 * Keyed by the *full* path, not just its basename: local projects are directories the user chose,
 * so `~/work/paper` and `~/archive/paper` are entirely different documents that would otherwise
 * share a build dir and surface each other's PDF. The basename is kept as a prefix so the temp
 * directory is still recognisable by eye.
 */
export function buildDir(projectDir: string): string {
  const resolved = path.resolve(projectDir);
  const key = createHash('sha1').update(resolved).digest('hex').slice(0, 8);
  return path.join(os.tmpdir(), 'web-latex-mcp-build', `${path.basename(resolved)}-${key}`);
}

async function buildDirFor(projectDir: string): Promise<string> {
  const dir = buildDir(projectDir);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Mirror the project's subdirectory tree (directories only, never files) into the build dir.
 * The engine compiles into `-output-directory`, but a document's relative write paths resolve
 * against that dir — most notably TikZ externalization's cache (`imgs/tikzmain-figure0.md5`,
 * `.dpth`, `.pdf`). Those subdirectories exist in the source but not in the fresh build dir, so
 * the write fails with "I can't write on file". Recreating every source subdirectory is the
 * simple, robust fix — no preamble parsing, no special-casing `imgs`. `.git` is skipped.
 */
export async function mirrorSubdirs(srcDir: string, buildDir: string): Promise<void> {
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.git') continue;
    const dest = path.join(buildDir, entry.name);
    await mkdir(dest, { recursive: true });
    await mirrorSubdirs(path.join(srcDir, entry.name), dest);
  }
}

/**
 * The engine shell-escape flag for a request, or `undefined` for none. Full `-shell-escape`
 * (arbitrary commands) takes precedence over the safer `-shell-restricted` (allow-list only)
 * when both are set; neither is ever enabled unless the caller explicitly opted in.
 */
function shellEscapeFlag(req: CompileRequest): string | undefined {
  if (req.shellEscape) return '-shell-escape';
  if (req.restrictedShellEscape) return '-shell-restricted';
  return undefined;
}

/**
 * The directory latexmk's `-cd` puts the engine in, relative to the project root: the root file's
 * own directory, or '' when it sits at the root. Exported so the rebasing of log paths is unit
 * testable against the flag that causes it.
 */
export function logBaseDir(rootFile: string): string {
  const dir = path.posix.dirname(toPosix(rootFile));
  return dir === '.' || dir === '/' ? '' : dir;
}

/**
 * The full latexmk argument vector for a request. Pure and exported so the arg construction —
 * in particular that a shell-escape flag is present only when explicitly requested — is unit
 * testable without a TeX install.
 */
export function latexmkArgs(req: CompileRequest, buildDir: string): string[] {
  const engine = req.engine ?? 'pdflatex';
  const args = [
    ENGINE_FLAG[engine],
    '-interaction=nonstopmode',
    '-file-line-error',
    // chdir into the root file's directory before compiling, so a document that lives in a
    // subdirectory of the clone still finds its sibling .sty/.bst/.cls with a bare
    // `\usepackage{local}`. A no-op when the root file is at the clone root. `-outdir` stays
    // absolute (below), so the build artifacts land in the temp build dir regardless.
    '-cd',
    // Emit a .synctex.gz next to the PDF so a click in the viewer maps back to source file:line
    // (powers `list_comments`). Cheap and harmless when unused.
    '-synctex=1',
    `-outdir=${buildDir}`,
  ];
  const shellFlag = shellEscapeFlag(req);
  if (shellFlag) args.push(shellFlag);
  if (req.clean) args.push('-gg');
  args.push(req.rootFile);
  return args;
}

/**
 * The path a compile would write its `.pdf` to (the build-dir `<jobname>.pdf`). Lets the read-only
 * `viewer` tool locate the last build without re-compiling. This is only the temp build
 * copy; a workspace-local compile also surfaces the same PDF beside the clone (`pdfSurface`).
 */
export function buildPdfPath(projectDir: string, rootFile: string): string {
  const rootBase = path.basename(rootFile).replace(/\.tex$/, '');
  return path.join(buildDir(projectDir), `${rootBase}.pdf`);
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
  logBase: string,
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
    logBaseDir: logBase,
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
    const buildDir = await buildDirFor(req.projectDir);
    await mirrorSubdirs(req.projectDir, buildDir);
    const args = latexmkArgs(req, buildDir);

    const start = Date.now();
    const res = await execCapture('latexmk', args, {
      cwd: req.projectDir,
      timeoutMs: (req.timeoutSec ?? 120) * 1000,
    });
    // `-cd` chdirs into the root file's directory: that is what the log's paths are relative to.
    return collectOutcome(
      buildDir,
      req.rootFile,
      res,
      (Date.now() - start) / 1000,
      logBaseDir(req.rootFile),
    );
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
    await mirrorSubdirs(req.projectDir, buildDir);

    const args = [req.rootFile, '--outdir', buildDir, '--keep-logs', '--chatter', 'minimal'];
    // Tectonic has no restricted mode, so `restrictedShellEscape` alone does not widen to full
    // shell escape here; only an explicit `shellEscape` enables system calls.
    if (req.shellEscape) args.push('-Z', 'shell-escape');

    const start = Date.now();
    const res = await execCapture('tectonic', args, {
      cwd: req.projectDir,
      timeoutMs: (req.timeoutSec ?? 120) * 1000,
    });
    // Tectonic takes no `-cd`: it runs in the project root, so its log paths already are.
    return collectOutcome(buildDir, req.rootFile, res, (Date.now() - start) / 1000, '');
  }
}

/** Build the configured compile backend. */
export function createCompiler(kind: CompilerKind): LatexCompiler {
  return kind === 'tectonic' ? new TectonicCompiler() : new LatexmkCompiler();
}

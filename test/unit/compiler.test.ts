import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from 'node:fs/promises';
import {
  latexmkArgs,
  mirrorSubdirs,
  isNotFound,
  probeOnPath,
  collectOutcome,
  engineNotFound,
  engineNotFoundHint,
  LatexmkCompiler,
  TectonicCompiler,
} from '../../src/services/compiler.js';
import type { PdfStat } from '../../src/services/compiler.js';
import type { ExecResult } from '../../src/lib/exec.js';

const BUILD = '/tmp/build';

describe('latexmkArgs (shell escape)', () => {
  const base = { projectDir: '/p', rootFile: 'main.tex' };

  it('never passes a shell-escape flag by default (security default)', () => {
    const args = latexmkArgs(base, BUILD);
    expect(args).not.toContain('-shell-escape');
    expect(args).not.toContain('-shell-restricted');
    expect(args).toContain('-file-line-error');
    expect(args).toContain('-synctex=1');
    expect(args.at(-1)).toBe('main.tex');
  });

  it('passes -cd so a root file in a subdirectory finds its sibling packages', () => {
    const args = latexmkArgs({ projectDir: '/p', rootFile: 'paper/main.tex' }, BUILD);
    expect(args).toContain('-cd');
    // -outdir stays absolute so build artifacts are unaffected by the chdir.
    expect(args).toContain(`-outdir=${BUILD}`);
    expect(args.at(-1)).toBe('paper/main.tex');
  });

  it('passes -shell-escape only when explicitly requested', () => {
    expect(latexmkArgs({ ...base, shellEscape: true }, BUILD)).toContain('-shell-escape');
  });

  it('passes -shell-restricted when restrictedShellEscape is set', () => {
    const args = latexmkArgs({ ...base, restrictedShellEscape: true }, BUILD);
    expect(args).toContain('-shell-restricted');
    expect(args).not.toContain('-shell-escape');
  });

  it('prefers full -shell-escape over restricted when both are set', () => {
    const args = latexmkArgs({ ...base, shellEscape: true, restrictedShellEscape: true }, BUILD);
    expect(args).toContain('-shell-escape');
    expect(args).not.toContain('-shell-restricted');
  });
});

describe('mirrorSubdirs', () => {
  async function isDir(p: string): Promise<boolean> {
    try {
      return (await stat(p)).isDirectory();
    } catch {
      return false;
    }
  }

  it('recreates the source subdirectory tree (dirs only) so relative writes resolve', async () => {
    const src = await mkdtemp(path.join(os.tmpdir(), 'mirror-src-'));
    const dest = await mkdtemp(path.join(os.tmpdir(), 'mirror-dst-'));
    try {
      await mkdir(path.join(src, 'imgs'), { recursive: true });
      await mkdir(path.join(src, 'sections', 'nested'), { recursive: true });
      await writeFile(path.join(src, 'main.tex'), 'x');
      await writeFile(path.join(src, 'imgs', 'fig.pdf'), 'x');

      await mirrorSubdirs(src, dest);

      expect(await isDir(path.join(dest, 'imgs'))).toBe(true);
      expect(await isDir(path.join(dest, 'sections', 'nested'))).toBe(true);
      // Files are not copied — only the directory scaffold.
      await expect(stat(path.join(dest, 'main.tex'))).rejects.toThrow();
      await expect(stat(path.join(dest, 'imgs', 'fig.pdf'))).rejects.toThrow();
    } finally {
      await rm(src, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
    }
  });

  it('skips the .git directory', async () => {
    const src = await mkdtemp(path.join(os.tmpdir(), 'mirror-src-'));
    const dest = await mkdtemp(path.join(os.tmpdir(), 'mirror-dst-'));
    try {
      await mkdir(path.join(src, '.git', 'objects'), { recursive: true });
      await mkdir(path.join(src, 'imgs'), { recursive: true });

      await mirrorSubdirs(src, dest);

      expect(await isDir(path.join(dest, 'imgs'))).toBe(true);
      expect(await isDir(path.join(dest, '.git'))).toBe(false);
    } finally {
      await rm(src, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
    }
  });
});

describe('isNotFound — which spawn errors mean "the binary is not there"', () => {
  // The real `isAvailable()` cannot be driven hermetically (it spawns `latexmk`/`tectonic` by
  // name and `execCapture` is not injectable into the backend classes), so the classification
  // that decides swallow-vs-propagate is unit tested on its own.
  it('is true only for ENOENT', () => {
    expect(isNotFound(Object.assign(new Error('spawn latexmk ENOENT'), { code: 'ENOENT' }))).toBe(
      true,
    );
  });

  it('is false for a binary that exists but cannot be run, or for exhaustion', () => {
    for (const code of ['EACCES', 'EAGAIN', 'EMFILE', 'EPERM']) {
      expect(isNotFound(Object.assign(new Error(`spawn latexmk ${code}`), { code }))).toBe(false);
    }
  });

  it('is false for anything carrying no code at all', () => {
    expect(isNotFound(new Error('boom'))).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
    expect(isNotFound(null)).toBe(false);
    expect(isNotFound('ENOENT')).toBe(false);
  });
});

describe('collectOutcome (rebuilt / pdfMtime)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-collect-outcome-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function fakeExec(overrides: Partial<ExecResult> = {}): ExecResult {
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...overrides };
  }

  async function statPdf(pdfPath: string): Promise<PdfStat> {
    const info = await stat(pdfPath);
    return { mtimeMs: info.mtimeMs, size: info.size };
  }

  it('no PDF existed before the run (before: null): a PDF present after is a rebuild', async () => {
    const pdfPath = path.join(dir, 'main.pdf');
    await writeFile(pdfPath, 'fresh output');

    const outcome = await collectOutcome(dir, 'main.tex', fakeExec(), 0.1, '', null);
    expect(outcome.rebuilt).toBe(true);
    expect(outcome.pdfMtime).toBeDefined();
  });

  it('the PDF is byte-identical to `before`: not a rebuild', async () => {
    const pdfPath = path.join(dir, 'main.pdf');
    await writeFile(pdfPath, 'unchanged output');
    const before = await statPdf(pdfPath);

    const outcome = await collectOutcome(dir, 'main.tex', fakeExec(), 0.1, '', before);
    expect(outcome.rebuilt).toBe(false);
    expect(outcome.pdfMtime).toBe(new Date(Math.round(before.mtimeMs)).toISOString());
  });

  it('the PDF was rewritten with different content (mtime and size both change): rebuilt', async () => {
    const pdfPath = path.join(dir, 'main.pdf');
    await writeFile(pdfPath, 'v1');
    const before = await statPdf(pdfPath);
    // A short pause guards against filesystem mtime resolution coarser than the write gap.
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(pdfPath, 'v2 with different, longer content');

    const outcome = await collectOutcome(dir, 'main.tex', fakeExec(), 0.1, '', before);
    expect(outcome.rebuilt).toBe(true);
  });

  it('only the mtime changed, same size: still rebuilt', async () => {
    const pdfPath = path.join(dir, 'main.pdf');
    await writeFile(pdfPath, 'same size');
    const before = await statPdf(pdfPath);
    const differentMtime = new Date(before.mtimeMs + 5_000);
    await utimes(pdfPath, differentMtime, differentMtime);

    const outcome = await collectOutcome(dir, 'main.tex', fakeExec(), 0.1, '', before);
    expect(outcome.rebuilt).toBe(true);
    expect(outcome.pdfMtime).toBe(differentMtime.toISOString());
  });

  it('no PDF in the build dir at all: not rebuilt, not successful, no path or mtime', async () => {
    // Nothing named main.pdf is ever written to `dir` in this case.
    const outcome = await collectOutcome(dir, 'main.tex', fakeExec(), 0.1, '', null);
    expect(outcome.rebuilt).toBe(false);
    expect(outcome.pdfMtime).toBeUndefined();
    expect(outcome.success).toBe(false);
    expect(outcome.pdfPath).toBeUndefined();
  });
});

describe('probeOnPath — the wiring between isNotFound and the availability answer', () => {
  // isNotFound is unit tested above and the resolver is tested against stubs, so nothing pinned
  // that probeOnPath actually *consults* it: reverting this to a bare `catch { return false }`
  // passed the whole suite. Spawning a name that cannot exist is hermetic on every OS — it is an
  // immediate ENOENT, needs no TeX, and touches no network.
  it('answers false for a binary that is not on PATH, rather than throwing', async () => {
    expect(await probeOnPath('web-latex-mcp-no-such-binary-9f3a2c', '--version')).toBe(false);
  });

  it('answers true for a binary that is there, whatever its exit code', async () => {
    // `node --version` exits 0; the point is that a resolved spawn means "present".
    expect(await probeOnPath(process.execPath, '--version')).toBe(true);
  });

  it('rethrows a spawn failure that is not ENOENT, rather than calling the binary absent', async () => {
    // The branch that matters: swallowing EAGAIN into `false` is what would let fork pressure
    // silently switch a healthy machine's engine — and losing every source snippet with it.
    // Injected, because exhausting the process table to reproduce it for real is not a unit test.
    const exhausted = () =>
      Promise.reject(Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }));
    await expect(probeOnPath('latexmk', '-v', exhausted)).rejects.toThrow(/EAGAIN/);
  });

  it('names the backend and the way out when a present binary cannot be run', async () => {
    // A non-executable latexmk is not "missing", so nothing is substituted and the compile
    // refuses — with a message the caller can act on rather than a bare `spawn latexmk EACCES`.
    const notExecutable = () =>
      Promise.reject(Object.assign(new Error('spawn latexmk EACCES'), { code: 'EACCES' }));
    const err: unknown = await probeOnPath('latexmk', '-v', notExecutable).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/latexmk is on PATH but could not be run/);
    expect(message).toContain('EACCES');
    expect(message).toContain('WEB_LATEX_MCP_COMPILER');
    expect(message).toContain('compiler:');
    // The errno survives the wrap, so nothing downstream can mistake it for ENOENT.
    expect(isNotFound(err)).toBe(false);
    expect((err as { code?: unknown }).code).toBe('EACCES');
  });

  it('still answers false when the injected runner reports ENOENT', async () => {
    const absent = () =>
      Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    expect(await probeOnPath('latexmk', '-v', absent)).toBe(false);
  });
});

/**
 * latexmk's own output when the engine it shells out to is not installed — captured from a real
 * run (latexmk 4.67, dash as /bin/sh, `-pdfxe` on a machine with pdflatex and lualatex but no
 * xelatex), build-dir paths shortened. No `.log` is written: the engine never started.
 */
const LATEXMK_NO_XELATEX_STDOUT = [
  "Latexmk: applying rule 'xelatex'...",
  'Latexmk: Errors, so I did not complete making targets',
].join('\n');
const LATEXMK_NO_XELATEX_STDERR = [
  'Latexmk: This is Latexmk, John Collins, 26 Dec. 2019, version: 4.67.',
  "Latexmk: Changing directory to './'",
  "Rule 'xelatex': The following rules & subrules became out-of-date:",
  "      'xelatex'",
  '------------',
  "Run number 1 of rule 'xelatex'",
  '------------',
  '------------',
  'Running \'xelatex -no-pdf -interaction=nonstopmode -file-line-error -synctex=1 -recorder -output-directory="/tmp/b"  "main.tex"\'',
  '------------',
  'sh: 1: xelatex: not found',
  "Latexmk: fls file doesn't appear to have been made.",
  'Collected error summary (may duplicate other messages):',
  "  xelatex: Command for 'xelatex' gave return code 127",
  "      Refer to '/tmp/b/main.log' for details",
  "Latexmk: Failure in processing file 'main.tex':",
  "   (Pdf)LaTeX didn't generate the expected log file '/tmp/b/main.log'",
].join('\n');

describe("engineNotFound — the shell's not-found shapes, for the engines latexmk runs", () => {
  it('finds the engine in real latexmk output (dash: `sh: 1: xelatex: not found`)', () => {
    expect(engineNotFound(`${LATEXMK_NO_XELATEX_STDOUT}\n${LATEXMK_NO_XELATEX_STDERR}`)).toBe(
      'xelatex',
    );
  });

  it.each([
    ['bash as /bin/sh (macOS)', 'sh: lualatex: command not found', 'lualatex'],
    ['bash, script line', 'bash: line 1: pdflatex: command not found', 'pdflatex'],
    ['bare bash form', 'xelatex: command not found', 'xelatex'],
    ['busybox ash', 'sh: xelatex: not found', 'xelatex'],
    ['absolute shell path', '/bin/sh: 1: lualatex: not found', 'lualatex'],
    [
      'Windows cmd.exe',
      "'xelatex' is not recognized as an internal or external command,\r\noperable program or batch file.",
      'xelatex',
    ],
    ['Windows, CRLF on a POSIX shape', 'sh: 1: pdflatex: not found\r', 'pdflatex'],
  ])('%s', (_label, output, engine) => {
    expect(engineNotFound(`Latexmk: applying rule\n${output}\nLatexmk: Errors`)).toBe(engine);
  });

  it.each([
    ['a bibliography tool, not an engine', 'sh: 1: biber: not found'],
    ['a converter latexmk also runs', 'sh: 1: xdvipdfmx: not found'],
    ['a longer binary name that merely starts with an engine', 'sh: 1: xelatexmk: not found'],
    ['an engine named mid-sentence', 'Package foo Info: sh: 1: xelatex: not found'],
    ['a different spelling', 'sh: 1: XeLaTeX: not found'],
    ['Windows, not an engine', "'biber' is not recognized as an internal or external command,"],
    ['nothing at all', ''],
  ])('ignores %s', (_label, output) => {
    expect(engineNotFound(output)).toBeUndefined();
  });
});

describe('engineNotFoundHint — gated on a failure the log could not explain', () => {
  it('names the engine, the install, and the engine argument as the way out', () => {
    const hint = engineNotFoundHint({ success: false, missingEngine: 'xelatex' }, 0);
    expect(hint).toMatch(/The xelatex engine is not installed \(latexmk could not run it\)/);
    expect(hint).toContain('texlive-xetex');
    expect(hint).toMatch(/engine: "pdflatex" or "lualatex"/);
    expect(hint).toContain('doctor');
  });

  it('never masks a real parsed error', () => {
    expect(engineNotFoundHint({ success: false, missingEngine: 'xelatex' }, 1)).toBeUndefined();
  });

  it('says nothing on a successful compile, whatever the output claimed', () => {
    expect(engineNotFoundHint({ success: true, missingEngine: 'xelatex' }, 0)).toBeUndefined();
  });

  it('says nothing when no engine was reported missing', () => {
    expect(engineNotFoundHint({ success: false }, 0)).toBeUndefined();
  });
});

describe("collectOutcome / the backends — missingEngine is read off latexmk's own output", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-missing-engine-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const notFound: ExecResult = {
    code: 12,
    stdout: LATEXMK_NO_XELATEX_STDOUT,
    stderr: LATEXMK_NO_XELATEX_STDERR,
    timedOut: false,
  };

  it('reports the engine when no .log was written', async () => {
    const outcome = await collectOutcome(dir, 'main.tex', notFound, 0.4, '', null, {
      detectMissingEngine: true,
    });
    expect(outcome.success).toBe(false);
    expect(outcome.logPath).toBeUndefined();
    expect(outcome.missingEngine).toBe('xelatex');
  });

  it('still reports it when a stale .log from an earlier run is in the build dir', async () => {
    // The build dir is stable per project: after a pdflatex compile, a failed xelatex run leaves
    // the pdflatex run's .log (and PDF) in place, and `log` is read from that file — so the
    // matcher must look at what latexmk printed, never at `log`.
    await writeFile(path.join(dir, 'main.log'), 'This is pdfTeX\nOutput written on main.pdf\n');
    const outcome = await collectOutcome(dir, 'main.tex', notFound, 0.4, '', null, {
      detectMissingEngine: true,
    });
    expect(outcome.log).not.toContain('not found');
    expect(outcome.missingEngine).toBe('xelatex');
  });

  it('is not reported on a successful run', async () => {
    await writeFile(path.join(dir, 'main.pdf'), 'pdf');
    const ok: ExecResult = { ...notFound, code: 0 };
    const outcome = await collectOutcome(dir, 'main.tex', ok, 0.4, '', null, {
      detectMissingEngine: true,
    });
    expect(outcome.success).toBe(true);
    expect(outcome.missingEngine).toBeUndefined();
  });

  it('is not reported unless the backend asked for it', async () => {
    const outcome = await collectOutcome(dir, 'main.tex', notFound, 0.4, '', null);
    expect(outcome.missingEngine).toBeUndefined();
  });

  it('LatexmkCompiler asks for it', async () => {
    const run = () => Promise.resolve(notFound);
    const outcome = await new LatexmkCompiler(run).compile({
      projectDir: dir,
      rootFile: 'main.tex',
      engine: 'xelatex',
    });
    expect(outcome.missingEngine).toBe('xelatex');
  });

  it('TectonicCompiler does not: it runs its bundled engine, never an engine binary', async () => {
    // Anything tectonic prints that looks like a shell's not-found line came from the document.
    const run = () => Promise.resolve(notFound);
    const outcome = await new TectonicCompiler(run).compile({
      projectDir: dir,
      rootFile: 'main.tex',
    });
    expect(outcome.success).toBe(false);
    expect(outcome.missingEngine).toBeUndefined();
  });
});

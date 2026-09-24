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

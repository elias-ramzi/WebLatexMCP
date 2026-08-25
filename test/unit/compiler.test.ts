import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import {
  latexmkArgs,
  mirrorSubdirs,
  isNotFound,
  probeOnPath,
} from '../../src/services/compiler.js';

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

  it('still answers false when the injected runner reports ENOENT', async () => {
    const absent = () =>
      Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    expect(await probeOnPath('latexmk', '-v', absent)).toBe(false);
  });
});

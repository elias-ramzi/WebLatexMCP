import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { latexmkArgs, mirrorSubdirs } from '../../src/services/compiler.js';

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

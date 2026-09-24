import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { linkedAncestor } from '../../src/services/gitService.js';

describe('linkedAncestor', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function tmpDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-linkanc-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }

  it('returns null for a plain nested file with real directories', async () => {
    const dir = await tmpDir();
    await mkdir(path.join(dir, 'a', 'b'), { recursive: true });
    await writeFile(path.join(dir, 'a', 'b', 'c.tex'), 'content', 'utf8');
    expect(await linkedAncestor(dir, 'a/b/c.tex')).toBeNull();
  });

  it('returns null when rel has a single component', async () => {
    const dir = await tmpDir();
    await writeFile(path.join(dir, 'main.tex'), 'content', 'utf8');
    expect(await linkedAncestor(dir, 'main.tex')).toBeNull();
  });

  it('returns null when an ancestor is missing entirely', async () => {
    const dir = await tmpDir();
    expect(await linkedAncestor(dir, 'nope/x.tex')).toBeNull();
  });

  describe.skipIf(process.platform === 'win32')('symlink cases (posix only)', () => {
    it('finds a symlinked directory one level up', async () => {
      const dir = await tmpDir();
      const sibling = path.join(dir, 'real');
      await mkdir(sibling, { recursive: true });
      await writeFile(path.join(sibling, 'x.tex'), 'content', 'utf8');
      await symlink(sibling, path.join(dir, 'sub'));
      expect(await linkedAncestor(dir, 'sub/x.tex')).toBe('sub');
    });

    it('returns the first linked prefix for a nested link', async () => {
      const dir = await tmpDir();
      const real = path.join(dir, 'real');
      await mkdir(real, { recursive: true });
      await writeFile(path.join(real, 'c.tex'), 'content', 'utf8');
      await mkdir(path.join(dir, 'a'), { recursive: true });
      await symlink(real, path.join(dir, 'a', 'b'));
      expect(await linkedAncestor(dir, 'a/b/c.tex')).toBe('a/b');
    });

    it('returns null when only the final component is a link (ancestors real)', async () => {
      const dir = await tmpDir();
      await mkdir(path.join(dir, 'sub'), { recursive: true });
      const target = path.join(dir, 'sub', 'real.tex');
      await writeFile(target, 'content', 'utf8');
      await symlink(target, path.join(dir, 'sub', 'x.tex'));
      expect(await linkedAncestor(dir, 'sub/x.tex')).toBeNull();
    });
  });
});

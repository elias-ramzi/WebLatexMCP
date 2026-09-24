import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { simpleGit, type SimpleGit } from 'simple-git';
import { GitService } from '../../src/services/gitService.js';

/**
 * `discard` promises the paths go back "to the last commit". It used to restore from the INDEX
 * (`checkout -- <paths>` / `checkout -- .`), so a STAGED modification survived as the file's
 * content, and `clean` never removes a file the index tracks, so a staged NEW file survived
 * outright — while the call reported `discarded: true`. The revert tool's own recovery text sends
 * callers to `discard` for a revert that may still be staged, which is exactly this shape.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function repo(): Promise<{ dir: string; git: SimpleGit }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-discstaged-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const git = simpleGit(dir, {
    config: ['user.email=t@example.com', 'user.name=T', 'core.autocrlf=false'],
  });
  await git.raw(['init', '-q', '-b', 'master']);
  await writeFile(path.join(dir, 'a.tex'), 'HEAD\n');
  await writeFile(path.join(dir, 'keep.tex'), 'KEEP\n');
  await git.add('.');
  await git.commit('initial');
  return { dir, git };
}

async function stageBoth(dir: string, git: SimpleGit): Promise<void> {
  await writeFile(path.join(dir, 'a.tex'), 'STAGED\n');
  await writeFile(path.join(dir, 'new.tex'), 'NEW STAGED\n');
  await git.raw(['add', '--', 'a.tex', 'new.tex']);
}

describe('discard restores to HEAD, not to the index', () => {
  it('path-limited: a staged modification and a staged new file are both discarded', async () => {
    const { dir, git } = await repo();
    await stageBoth(dir, git);
    // An unrelated staged change must survive a path-limited discard.
    await writeFile(path.join(dir, 'keep.tex'), 'KEEP STAGED\n');
    await git.raw(['add', '--', 'keep.tex']);

    const res = await new GitService().discard(dir, ['a.tex', 'new.tex']);

    expect(res).toEqual({ discarded: true });
    expect(await readFile(path.join(dir, 'a.tex'), 'utf8')).toBe('HEAD\n');
    expect(await exists(path.join(dir, 'new.tex'))).toBe(false);
    expect((await git.raw(['status', '--porcelain'])).split('\n').filter(Boolean)).toEqual([
      'M  keep.tex',
    ]);
  });

  it('path-limited: a staged deletion is restored, not reported missed', async () => {
    const { dir, git } = await repo();
    await git.raw(['rm', '-q', '--', 'a.tex']);

    const res = await new GitService().discard(dir, ['a.tex']);

    expect(res).toEqual({ discarded: true });
    expect(await readFile(path.join(dir, 'a.tex'), 'utf8')).toBe('HEAD\n');
    expect((await git.raw(['status', '--porcelain'])).trim()).toBe('');
  });

  it('path-limited: a path matching nothing anywhere is still reported missed', async () => {
    const { dir, git } = await repo();
    await stageBoth(dir, git);

    const res = await new GitService().discard(dir, ['new.tex', 'ghost.tex']);

    expect(res).toEqual({ discarded: true, missed: ['ghost.tex'] });
    expect(await exists(path.join(dir, 'new.tex'))).toBe(false);
  });

  it('whole tree: a staged modification and a staged new file are both discarded', async () => {
    const { dir, git } = await repo();
    await stageBoth(dir, git);

    const res = await new GitService().discard(dir);

    expect(res).toEqual({ discarded: true });
    expect(await readFile(path.join(dir, 'a.tex'), 'utf8')).toBe('HEAD\n');
    expect(await exists(path.join(dir, 'new.tex'))).toBe(false);
    expect((await git.raw(['status', '--porcelain'])).trim()).toBe('');
  });
});

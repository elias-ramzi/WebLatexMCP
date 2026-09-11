import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { GitService } from '../../src/services/gitService.js';

/**
 * `GitService.commit` (fromHead) and `commitContents` both reset the index to HEAD before
 * staging, so a peer's leftover staged state can never leak into this commit. On a freshly
 * `git init`'d clone with no commits yet — an empty Overleaf/GitHub remote just cloned — HEAD is
 * "unborn": `git read-tree --reset HEAD` fails outright with "fatal: Not a valid object name
 * HEAD", which used to make the very first commit in a brand-new project impossible through
 * either path. No remote is needed to reproduce this: a plain `git init` with zero commits is
 * exactly the unborn-HEAD state.
 */
describe('commit / commitContents on an unborn HEAD', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function initEmptyRepo(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-unborn-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const git = simpleGit(dir);
    await git.raw(['init', '-q']);
    await git.addConfig('user.email', 'test@example.com');
    await git.addConfig('user.name', 'Test');
    await git.addConfig('core.autocrlf', 'false');
    return dir;
  }

  it('commit({ fromHead: true }) succeeds on an unborn HEAD and the commit holds only that file', async () => {
    const dir = await initEmptyRepo();
    await writeFile(path.join(dir, 'f.tex'), 'hello\n', 'utf8');
    // A second, untracked file must NOT ride along — fromHead + explicit paths is the whole point.
    await writeFile(path.join(dir, 'other.tex'), 'other\n', 'utf8');

    const git = new GitService();
    const result = await git.commit(dir, {
      message: 'first commit',
      paths: ['f.tex'],
      fromHead: true,
    });

    expect(result.committed).toBe(true);
    expect(result.files.map((f) => f.path)).toEqual(['f.tex']);

    const raw = simpleGit(dir);
    const tracked = (await raw.raw(['ls-tree', '-r', '--name-only', 'HEAD']))
      .split('\n')
      .filter(Boolean);
    expect(tracked).toEqual(['f.tex']);
  });

  it('commitContents succeeds on an unborn HEAD', async () => {
    const dir = await initEmptyRepo();

    const git = new GitService();
    const result = await git.commitContents(dir, {
      message: 'first commit via commitContents',
      files: [{ path: 'f.tex', content: 'x' }],
    });

    expect(result.committed).toBe(true);
    expect(result.files.map((f) => f.path)).toEqual(['f.tex']);

    const raw = simpleGit(dir);
    const tracked = (await raw.raw(['ls-tree', '-r', '--name-only', 'HEAD']))
      .split('\n')
      .filter(Boolean);
    expect(tracked).toEqual(['f.tex']);
    const sha = (await raw.revparse(['HEAD'])).trim();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

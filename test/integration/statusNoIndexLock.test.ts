import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, stat, utimes } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { createFakeRemote } from './helpers/bareRepo.js';
import { GitService } from '../../src/services/gitService.js';

// `status` takes no project lock, so it must not take git's either. A plain `git status`
// refreshes stale stat data and writes the index back under `.git/index.lock` — an OPTIONAL
// lock — and a peer's `discard` running at that moment failed part way through with "Unable to
// create index.lock: File exists" (macOS CI). Whether the race fires is timing; whether status
// writes the index is not, so that is what this pins.
describe('GitService.status takes no index lock', () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it('leaves a stale index unwritten, where a plain git status rewrites it', async () => {
    const remote = await createFakeRemote({ 'main.tex': 'hello\n' });
    const root = await mkdtemp(path.join(os.tmpdir(), 'ovl-statuslock-'));
    cleanups.push(remote.cleanup, () => rm(root, { recursive: true, force: true }));
    const dir = path.join(root, 'demo');
    const git = new GitService();
    await git.clone(remote.url, dir, { username: 'git' });

    const index = path.join(dir, '.git', 'index');
    // Same bytes, new mtime: the index's cached stat data for main.tex is now stale, so a
    // status that refreshes it has something to write back.
    const stale = async (seconds: number): Promise<Buffer> => {
      const t = new Date(Date.now() + seconds * 1000);
      await utimes(path.join(dir, 'main.tex'), t, t);
      return readFile(index);
    };

    const before = await stale(10);
    const mtimeBefore = (await stat(index)).mtimeMs;
    const result = await git.status(dir);
    expect(result.clean).toBe(true);
    expect((await readFile(index)).equals(before)).toBe(true);
    expect((await stat(index)).mtimeMs).toBe(mtimeBefore);

    // The probe fires: the same stale index IS rewritten by git's own status.
    const control = await stale(20);
    await simpleGit(dir).status();
    expect((await readFile(index)).equals(control)).toBe(false);
  });
});

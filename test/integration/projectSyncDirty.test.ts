import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { createFakeRemote, pushCommit, type FakeRemote } from './helpers/bareRepo.js';
import { GitService, LocalChangesOverwriteError } from '../../src/services/gitService.js';

/**
 * `syncPull` runs `merge --ff-only`, which git refuses (rather than autostashing) when the
 * incoming fast-forward would overwrite a *tracked* file that has uncommitted local
 * modifications. Pre-fix, that raw git stderr — which prescribes `stash`, a command this server
 * doesn't expose — reached the caller verbatim. These tests pin the typed refusal against real
 * git, run against a local bare repo (no network, no secrets), and the complementary case that
 * proves this is a post-hoc translation of git's refusal, not a working-tree-dirty pre-check:
 * a pull that git would happily fast-forward over must still succeed.
 */
describe('syncPull over a dirty tracked file (bare-repo stand-in)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(): Promise<{ remote: FakeRemote; git: GitService; dir: string }> {
    const remote = await createFakeRemote({
      'main.tex': 'one\ntwo\n',
      'other.tex': 'a\nb\n',
    });
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-clone-'));
    cleanups.push(remote.cleanup, () => rm(dir, { recursive: true, force: true }));
    const git = new GitService();
    await git.clone(remote.url, dir, { username: 'git' });
    return { remote, git, dir };
  }

  it('refuses with a typed error when the incoming commit collides with a dirty tracked file, leaving the clone untouched', async () => {
    const { remote, git, dir } = await setup();

    const headBefore = (await simpleGit(dir).revparse(['HEAD'])).trim();

    // Dirty the same file the incoming remote commit will touch, WITHOUT committing.
    await writeFile(path.join(dir, 'main.tex'), 'one\ntwo\nLOCAL EDIT\n');
    await pushCommit(remote, { 'main.tex': 'one\ntwo\nREMOTE EDIT\n' }, 'remote edit to main.tex');

    let caught: unknown;
    try {
      await git.syncPull(remote.url, dir, { username: 'git' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LocalChangesOverwriteError);
    const err = caught as LocalChangesOverwriteError;
    expect(err.paths).toEqual(['main.tex']);
    expect(err.message).not.toMatch(/please stash/i);
    expect(err.message).not.toMatch(/\bstash (it|them|your changes|now)\b/i);

    // Nothing changed: HEAD didn't move, and the local edit is still there untouched.
    const headAfter = (await simpleGit(dir).revparse(['HEAD'])).trim();
    expect(headAfter).toBe(headBefore);
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('one\ntwo\nLOCAL EDIT\n');
  });

  it('still succeeds (no pre-check) when the dirty file and the incoming commit touch different files', async () => {
    const { remote, git, dir } = await setup();

    // Dirty main.tex, but the remote commit only touches other.tex.
    await writeFile(path.join(dir, 'main.tex'), 'one\ntwo\nLOCAL EDIT\n');
    await pushCommit(remote, { 'other.tex': 'a\nb\nc\n' }, 'remote edit to other.tex');

    const result = await git.syncPull(remote.url, dir, { username: 'git' });

    expect(result.action).toBe('pulled');
    // The unrelated dirty modification survives the fast-forward.
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('one\ntwo\nLOCAL EDIT\n');
    expect(await readFile(path.join(dir, 'other.tex'), 'utf8')).toBe('a\nb\nc\n');
  });
});

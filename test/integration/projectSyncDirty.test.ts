import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { createFakeRemote, pushCommit, type FakeRemote } from './helpers/bareRepo.js';
import {
  GitService,
  LocalChangesOverwriteError,
  UntrackedOverwriteError,
} from '../../src/services/gitService.js';

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

  it('refuses with a pull-worded typed error when the incoming commit adds a file that already sits untracked locally, leaving the clone untouched', async () => {
    const { remote, git, dir } = await setup();

    const headBefore = (await simpleGit(dir).revparse(['HEAD'])).trim();

    // An untracked file already sits in the clone; the remote gains a commit ADDING a file at the
    // same path with different content — the sibling refusal to the tracked-modification case
    // above, git's "untracked working tree files would be overwritten" wording.
    await writeFile(path.join(dir, 'new.tex'), 'LOCAL UNTRACKED CONTENT\n');
    await pushCommit(remote, { 'new.tex': 'REMOTE CONTENT\n' }, 'remote adds new.tex');

    let caught: unknown;
    try {
      await git.syncPull(remote.url, dir, { username: 'git' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UntrackedOverwriteError);
    const err = caught as UntrackedOverwriteError;
    expect(err.operation).toBe('pull');
    expect(err.paths).toEqual(['new.tex']);
    expect(err.message).toContain('The pull was refused; nothing changed');
    expect(err.message).toContain('new.tex');
    expect(err.message).not.toMatch(/move or remove/i);

    // Nothing changed: HEAD didn't move, and the untracked file's content is intact.
    const headAfter = (await simpleGit(dir).revparse(['HEAD'])).trim();
    expect(headAfter).toBe(headBefore);
    expect(await readFile(path.join(dir, 'new.tex'), 'utf8')).toBe('LOCAL UNTRACKED CONTENT\n');
  });

  // Defect B: real git's `unpack_trees` accumulates rejects per error type and prints EVERY
  // non-empty block, so a single `merge --ff-only` can refuse over a tracked-modification
  // collision AND an untracked-file collision at once — confirmed against real git 2.x (a bare
  // remote, no network) rather than assumed. Pre-fix, `syncPull`'s `??` chain reported only the
  // untracked group and promised "after which the sync succeeds", which is false: the tracked
  // group refuses the very next sync too.
  it('refuses with ONE typed error naming both the tracked and untracked collision when a merge hits both refusal blocks at once, leaving the clone untouched', async () => {
    const { remote, git, dir } = await setup();

    const headBefore = (await simpleGit(dir).revparse(['HEAD'])).trim();

    // Dirty main.tex (tracked) AND leave new.tex sitting untracked, then have the remote both
    // modify main.tex and add new.tex — colliding on both at once.
    await writeFile(path.join(dir, 'main.tex'), 'one\ntwo\nLOCAL EDIT\n');
    await writeFile(path.join(dir, 'new.tex'), 'LOCAL UNTRACKED CONTENT\n');
    await pushCommit(
      remote,
      { 'main.tex': 'one\ntwo\nREMOTE EDIT\n', 'new.tex': 'REMOTE CONTENT\n' },
      'remote edits main.tex and adds new.tex',
    );

    let caught: unknown;
    try {
      await git.syncPull(remote.url, dir, { username: 'git' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LocalChangesOverwriteError);
    const err = caught as LocalChangesOverwriteError;
    expect(err.paths).toEqual(['main.tex', 'new.tex']);
    expect(err.untrackedPaths).toEqual(['new.tex']);
    expect(err.message).toContain('main.tex');
    expect(err.message).toContain('new.tex');

    // Nothing changed: HEAD didn't move, and both local files are untouched.
    const headAfter = (await simpleGit(dir).revparse(['HEAD'])).trim();
    expect(headAfter).toBe(headBefore);
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('one\ntwo\nLOCAL EDIT\n');
    expect(await readFile(path.join(dir, 'new.tex'), 'utf8')).toBe('LOCAL UNTRACKED CONTENT\n');
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

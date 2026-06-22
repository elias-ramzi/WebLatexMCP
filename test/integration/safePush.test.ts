import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { createFakeRemote, pushCommit, type FakeRemote } from './helpers/bareRepo.js';
import { GitService } from '../../src/services/gitService.js';
import { FileService } from '../../src/services/fileService.js';
import { ProjectManager } from '../../src/services/projectManager.js';
import type { ServerConfig } from '../../src/types.js';

describe('safe push (pull-rebase + branch review) against a bare-repo stand-in', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(
    files: Record<string, string>,
  ): Promise<{ remote: FakeRemote; git: GitService; files: FileService; dir: string }> {
    const remote = await createFakeRemote(files);
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-sp-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));
    const config: ServerConfig = {
      workspaceRoot: workspace,
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
    };
    const pm = new ProjectManager(config);
    const git = new GitService();
    const dir = pm.projectPath('demo');
    await git.clone(remote.url, dir, { username: 'git' });
    return { remote, git, files: new FileService(), dir };
  }

  /** Clone the remote into a throwaway dir and read a file back, to confirm what actually landed. */
  async function readFromRemote(remote: FakeRemote, rel: string): Promise<string> {
    const verify = await mkdtemp(path.join(os.tmpdir(), 'ovl-sp-verify-'));
    cleanups.push(() => rm(verify, { recursive: true, force: true }));
    await simpleGit(verify).clone(remote.url, verify);
    return readFile(path.join(verify, rel), 'utf8');
  }

  const headSha = (dir: string): Promise<string> =>
    simpleGit(dir)
      .revparse(['HEAD'])
      .then((s) => s.trim());

  async function noRebaseInProgress(dir: string): Promise<boolean> {
    for (const d of ['rebase-merge', 'rebase-apply']) {
      try {
        await stat(path.join(dir, '.git', d));
        return false;
      } catch {
        // absent — good
      }
    }
    return true;
  }

  it('pushes a local ahead-only commit (clean push)', async () => {
    const { remote, git, files, dir } = await setup({ 'main.tex': 'one\ntwo\n' });
    await files.applyEdits(dir, 'main.tex', [{ oldString: 'two', newString: 'TWO' }]);
    await git.commit(dir, { message: 'edit two' });

    const res = await git.safePush(dir, remote.url, { username: 'git' });

    expect(res.status).toBe('pushed');
    expect(res.pushed).toBe(true);
    expect(res.pushedCommits).toBe(1);
    expect(await readFromRemote(remote, 'main.tex')).toBe('one\nTWO\n');
  });

  it('reports nothing-to-push on an up-to-date clean clone', async () => {
    const { remote, git, dir } = await setup({ 'main.tex': 'x\n' });
    const res = await git.safePush(dir, remote.url, { username: 'git' });
    expect(res.status).toBe('nothing-to-push');
    expect(res.pushed).toBe(false);
  });

  it('rebases and pushes when concurrent edits do not overlap', async () => {
    const { remote, git, files, dir } = await setup({ 'main.tex': 'alpha\nbeta\ngamma\n' });
    await files.applyEdits(dir, 'main.tex', [{ oldString: 'alpha', newString: 'ALPHA' }]);
    await git.commit(dir, { message: 'edit line 1' });

    // Someone else commits a change to a different line on the remote.
    await pushCommit(remote, { 'main.tex': 'alpha\nbeta\nGAMMA\n' }, 'remote edits line 3');

    const res = await git.safePush(dir, remote.url, { username: 'git' });

    expect(res.status).toBe('pushed');
    // Both edits survive — line-granularity merge.
    expect(await readFromRemote(remote, 'main.tex')).toBe('ALPHA\nbeta\nGAMMA\n');
  });

  it('aborts the rebase and surfaces both sides when edits overlap', async () => {
    const { remote, git, files, dir } = await setup({ 'main.tex': 'alpha\nbeta\ngamma\n' });
    await files.applyEdits(dir, 'main.tex', [{ oldString: 'beta', newString: 'beta-local' }]);
    await git.commit(dir, { message: 'local edits line 2' });

    // Remote edits the SAME line.
    await pushCommit(remote, { 'main.tex': 'alpha\nbeta-remote\ngamma\n' }, 'remote edits line 2');

    const before = await headSha(dir);
    const res = await git.safePush(dir, remote.url, { username: 'git' });

    expect(res.status).toBe('conflict');
    expect(res.pushed).toBe(false);
    expect(res.conflict?.rebasedOnto).toBe('origin/master');

    const file = res.conflict?.files.find((f) => f.path === 'main.tex');
    expect(file).toBeDefined();
    const localText = file!.hunks.flatMap((h) => h.local).join('\n');
    const remoteText = file!.hunks.flatMap((h) => h.remote).join('\n');
    expect(localText).toContain('beta-local');
    expect(remoteText).toContain('beta-remote');

    // Fail safe: rebase aborted, local clone back to its pre-push state, nothing half-merged.
    expect(await headSha(dir)).toBe(before);
    expect((await git.status(dir)).clean).toBe(true);
    expect(await noRebaseInProgress(dir)).toBe(true);

    // The remote was not modified by our failed push.
    expect(await readFromRemote(remote, 'main.tex')).toBe('alpha\nbeta-remote\ngamma\n');
  });

  it('commits pending work first when a message is given', async () => {
    const { remote, git, files, dir } = await setup({ 'main.tex': 'one\ntwo\n' });
    await files.applyEdits(dir, 'main.tex', [{ oldString: 'two', newString: 'TWO' }]);

    // Not committed yet — safePush commits it, then pushes.
    const res = await git.safePush(
      dir,
      remote.url,
      { username: 'git' },
      { commitMessage: 'edit two' },
    );

    expect(res.status).toBe('pushed');
    expect(res.committedSha).toBeDefined();
    expect(await readFromRemote(remote, 'main.tex')).toBe('one\nTWO\n');
  });

  it('refuses to push a dirty tree without a commit message', async () => {
    const { remote, git, files, dir } = await setup({ 'main.tex': 'one\ntwo\n' });
    await files.applyEdits(dir, 'main.tex', [{ oldString: 'two', newString: 'TWO' }]);
    await expect(git.safePush(dir, remote.url, { username: 'git' })).rejects.toThrow(
      /uncommitted changes/,
    );
  });

  describe('branch-review mode', () => {
    it('prepareBranch commits to a local branch and returns the diff (branch stays local)', async () => {
      const { remote, git, files, dir } = await setup({ 'main.tex': 'one\ntwo\n' });
      await files.applyEdits(dir, 'main.tex', [{ oldString: 'two', newString: 'TWO' }]);

      const res = await git.prepareBranch(dir, { branch: 'review/x', message: 'edit two' });

      expect(res.status).toBe('awaiting-approval');
      expect(res.base).toBe('master');
      expect(res.diff).toContain('TWO');
      expect(res.files.some((f) => f.path === 'main.tex')).toBe(true);

      // Remote master is unchanged and never received the feature branch.
      expect(await readFromRemote(remote, 'main.tex')).toBe('one\ntwo\n');
      const verify = await mkdtemp(path.join(os.tmpdir(), 'ovl-sp-rbranch-'));
      cleanups.push(() => rm(verify, { recursive: true, force: true }));
      await simpleGit(verify).clone(remote.url, verify);
      const remoteBranches = await simpleGit(verify).branch(['-r']);
      expect(remoteBranches.all.join(' ')).not.toContain('review/x');
    });

    it('landBranch rebases the reviewed branch onto fresh master and pushes', async () => {
      const { remote, git, files, dir } = await setup({ 'main.tex': 'alpha\nbeta\ngamma\n' });
      await files.applyEdits(dir, 'main.tex', [{ oldString: 'alpha', newString: 'ALPHA' }]);
      const prep = await git.prepareBranch(dir, { branch: 'review/y', message: 'edit line 1' });

      // Remote advances on a different line while the branch awaits approval.
      await pushCommit(remote, { 'main.tex': 'alpha\nbeta\nGAMMA\n' }, 'remote edits line 3');

      const res = await git.landBranch(
        dir,
        remote.url,
        { username: 'git' },
        {
          branch: 'review/y',
          base: prep.base,
        },
      );

      expect(res.status).toBe('pushed');
      expect(await readFromRemote(remote, 'main.tex')).toBe('ALPHA\nbeta\nGAMMA\n');
    });

    it('landBranch aborts and surfaces a conflict, leaving the branch intact', async () => {
      const { remote, git, files, dir } = await setup({ 'main.tex': 'alpha\nbeta\ngamma\n' });
      await files.applyEdits(dir, 'main.tex', [{ oldString: 'beta', newString: 'beta-branch' }]);
      const prep = await git.prepareBranch(dir, { branch: 'review/z', message: 'edit line 2' });

      await pushCommit(
        remote,
        { 'main.tex': 'alpha\nbeta-remote\ngamma\n' },
        'remote edits line 2',
      );

      const branchSha = (await simpleGit(dir).revparse(['review/z'])).trim();
      const res = await git.landBranch(
        dir,
        remote.url,
        { username: 'git' },
        {
          branch: 'review/z',
          base: prep.base,
        },
      );

      expect(res.status).toBe('conflict');
      const file = res.conflict?.files.find((f) => f.path === 'main.tex');
      expect(file!.hunks.flatMap((h) => h.local).join('\n')).toContain('beta-branch');
      expect(file!.hunks.flatMap((h) => h.remote).join('\n')).toContain('beta-remote');

      // Feature branch untouched; clone left on the base branch; remote unchanged.
      expect((await simpleGit(dir).revparse(['review/z'])).trim()).toBe(branchSha);
      expect((await git.status(dir)).branch).toBe('master');
      expect(await readFromRemote(remote, 'main.tex')).toBe('alpha\nbeta-remote\ngamma\n');
    });
  });
});

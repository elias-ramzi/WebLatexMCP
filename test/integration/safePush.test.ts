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
    // The clean push reports the remote commit it rebased over.
    expect(res.rebasedOver?.map((c) => c.message)).toContain('remote edits line 3');
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

  describe('conflict resolution (resolvePush)', () => {
    it('applies merged content, continues the rebase, and pushes', async () => {
      const { remote, git, files, dir } = await setup({ 'main.tex': 'alpha\nbeta\ngamma\n' });
      await files.applyEdits(dir, 'main.tex', [{ oldString: 'beta', newString: 'beta-local' }]);
      await git.commit(dir, { message: 'local edits line 2' });
      await pushCommit(
        remote,
        { 'main.tex': 'alpha\nbeta-remote\ngamma\n' },
        'remote edits line 2',
      );

      // Confirm it conflicts first (nothing pushed, tree clean).
      const conflict = await git.safePush(dir, remote.url, { username: 'git' });
      expect(conflict.status).toBe('conflict');

      // Resolve with a hand-merged line and push.
      const res = await git.resolvePush(
        dir,
        remote.url,
        { username: 'git' },
        {
          resolutions: [{ path: 'main.tex', content: 'alpha\nbeta-local-and-remote\ngamma\n' }],
        },
      );

      expect(res.status).toBe('pushed');
      expect(res.pushedCommits).toBe(1);
      expect(await readFromRemote(remote, 'main.tex')).toBe(
        'alpha\nbeta-local-and-remote\ngamma\n',
      );
      expect(await noRebaseInProgress(dir)).toBe(true);
      expect((await git.status(dir)).clean).toBe(true);
    });

    it('surfaces the still-unresolved files when a resolution is missing (and aborts)', async () => {
      const { remote, git, files, dir } = await setup({ 'main.tex': 'alpha\nbeta\ngamma\n' });
      await files.applyEdits(dir, 'main.tex', [{ oldString: 'beta', newString: 'beta-local' }]);
      await git.commit(dir, { message: 'local edits line 2' });
      await pushCommit(
        remote,
        { 'main.tex': 'alpha\nbeta-remote\ngamma\n' },
        'remote edits line 2',
      );

      const before = await headSha(dir);
      const res = await git.resolvePush(
        dir,
        remote.url,
        { username: 'git' },
        {
          resolutions: [{ path: 'other.tex', content: 'noop\n' }],
        },
      );

      expect(res.status).toBe('conflict');
      // The report names the missing conflicted file and lists the real conflict scope.
      expect(res.conflict?.conflictPaths).toEqual(['main.tex']);
      expect(res.conflict?.guidance).toContain('main.tex');
      // Fail safe: rebase aborted, nothing pushed, clone back to its pre-resolve state.
      expect(await headSha(dir)).toBe(before);
      expect(await noRebaseInProgress(dir)).toBe(true);
      expect(await readFromRemote(remote, 'main.tex')).toBe('alpha\nbeta-remote\ngamma\n');
    });

    it('refuses a .bib resolution without confirmBibEdit', async () => {
      const { remote, git, dir } = await setup({ 'refs.bib': '@article{a,\n title={x}\n}\n' });
      await expect(
        git.resolvePush(
          dir,
          remote.url,
          { username: 'git' },
          {
            resolutions: [{ path: 'refs.bib', content: '@article{a,\n title={merged}\n}\n' }],
          },
        ),
      ).rejects.toThrow(/\.bib/);
    });

    it('rejects an extra (non-conflicted) resolution by name and pushes nothing', async () => {
      const { remote, git, files, dir } = await setup({ 'main.tex': 'alpha\nbeta\ngamma\n' });
      await files.applyEdits(dir, 'main.tex', [{ oldString: 'beta', newString: 'beta-local' }]);
      await git.commit(dir, { message: 'local edits line 2' });
      await pushCommit(
        remote,
        { 'main.tex': 'alpha\nbeta-remote\ngamma\n' },
        'remote edits line 2',
      );

      const before = await headSha(dir);
      // main.tex is the real conflict; also (wrongly) include a bogus path.
      await expect(
        git.resolvePush(
          dir,
          remote.url,
          { username: 'git' },
          {
            resolutions: [
              { path: 'main.tex', content: 'alpha\nMERGED\ngamma\n' },
              { path: 'nope.tex', content: 'x\n' },
            ],
          },
        ),
      ).rejects.toThrow(/nope\.tex/);

      // Fully undone: HEAD restored, nothing pushed.
      expect(await headSha(dir)).toBe(before);
      expect(await noRebaseInProgress(dir)).toBe(true);
      expect((await git.status(dir)).clean).toBe(true);
      expect(await readFromRemote(remote, 'main.tex')).toBe('alpha\nbeta-remote\ngamma\n');
    });

    it('accepts an abbreviated expectedRemoteHead that matches the current remote', async () => {
      const { remote, git, files, dir } = await setup({ 'main.tex': 'alpha\nbeta\ngamma\n' });
      await files.applyEdits(dir, 'main.tex', [{ oldString: 'beta', newString: 'beta-local' }]);
      await git.commit(dir, { message: 'local edits line 2' });
      await pushCommit(
        remote,
        { 'main.tex': 'alpha\nbeta-remote\ngamma\n' },
        'remote edits line 2',
      );

      const conflict = await git.safePush(dir, remote.url, { username: 'git' });
      expect(conflict.status).toBe('conflict');
      const head = conflict.conflict!.remoteHead;

      // Pass back only the 8-char prefix of the reported head — it must not read as "moved to self".
      const res = await git.resolvePush(
        dir,
        remote.url,
        { username: 'git' },
        {
          resolutions: [{ path: 'main.tex', content: 'alpha\nMERGED\ngamma\n' }],
          expectedRemoteHead: head.slice(0, 8),
        },
      );

      expect(res.status).toBe('pushed');
      expect(await readFromRemote(remote, 'main.tex')).toBe('alpha\nMERGED\ngamma\n');
    });

    it('refuses to apply when the remote advanced past expectedRemoteHead', async () => {
      const { remote, git, files, dir } = await setup({ 'main.tex': 'alpha\nbeta\ngamma\n' });
      await files.applyEdits(dir, 'main.tex', [{ oldString: 'beta', newString: 'beta-local' }]);
      await git.commit(dir, { message: 'local edits line 2' });
      await pushCommit(
        remote,
        { 'main.tex': 'alpha\nbeta-remote\ngamma\n' },
        'remote edits line 2',
      );

      // Resolve against a stale head id — the remote has since moved past it.
      await expect(
        git.resolvePush(
          dir,
          remote.url,
          { username: 'git' },
          {
            resolutions: [{ path: 'main.tex', content: 'alpha\nMERGED\ngamma\n' }],
            expectedRemoteHead: '0000000000000000000000000000000000000000',
          },
        ),
      ).rejects.toThrow(/Remote moved/);

      expect(await readFromRemote(remote, 'main.tex')).toBe('alpha\nbeta-remote\ngamma\n');
    });
  });

  describe('conflict report payload', () => {
    it('returns full base/ours/theirs plus remote head and landed commits', async () => {
      const { remote, git, files, dir } = await setup({ 'main.tex': 'alpha\nbeta\ngamma\n' });
      await files.applyEdits(dir, 'main.tex', [{ oldString: 'beta', newString: 'beta-local' }]);
      await git.commit(dir, { message: 'local edits line 2' });
      await pushCommit(
        remote,
        { 'main.tex': 'alpha\nbeta-remote\ngamma\n' },
        'remote edits line 2',
      );

      const res = await git.safePush(dir, remote.url, { username: 'git' });
      expect(res.status).toBe('conflict');
      const report = res.conflict!;

      expect(report.conflictPaths).toEqual(['main.tex']);
      const file = report.files.find((f) => f.path === 'main.tex')!;
      // Full three sides — base is the common ancestor, ours/theirs the two full versions.
      expect(file.base).toBe('alpha\nbeta\ngamma\n');
      expect(file.ours).toBe('alpha\nbeta-local\ngamma\n');
      expect(file.theirs).toBe('alpha\nbeta-remote\ngamma\n');
      // Marker view still present as an addition.
      expect(file.hunks.length).toBeGreaterThan(0);

      // Remote head + the commit that landed.
      const remoteHeadSha = (await simpleGit(dir).revparse(['origin/master'])).trim();
      expect(report.remoteHead).toBe(remoteHeadSha);
      expect(report.remoteCommits.map((c) => c.message)).toContain('remote edits line 2');

      // mergeBase is the common ancestor sha, and `base` is fetchable at that ref.
      const mergeBaseSha = (
        await simpleGit(dir).raw(['merge-base', 'master', 'origin/master'])
      ).trim();
      expect(report.mergeBase).toBe(mergeBaseSha);
      expect(await git.showAtRef(dir, report.mergeBase!, 'main.tex')).toBe('alpha\nbeta\ngamma\n');
    });
  });

  describe('multi-file / multi-hunk conflict (MCP-only acceptance)', () => {
    // a.tex has two far-apart overlapping regions (→ two hunks); b.tex has one. Both conflict.
    const aBase = 'a1\na2\na3\na4\na5\na6\na7\na8\na9\n';
    const bBase = 'b1\nb2\nb3\n';

    async function setUpConflict(
      git: GitService,
      files: FileService,
      dir: string,
      remote: FakeRemote,
    ) {
      await files.applyEdits(dir, 'a.tex', [
        { oldString: 'a2', newString: 'a2-local' },
        { oldString: 'a8', newString: 'a8-local' },
      ]);
      await files.applyEdits(dir, 'b.tex', [{ oldString: 'b2', newString: 'b2-local' }]);
      await git.commit(dir, { message: 'local edits' });
      await pushCommit(
        remote,
        {
          'a.tex': 'a1\na2-remote\na3\na4\na5\na6\na7\na8-remote\na9\n',
          'b.tex': 'b1\nb2-remote\nb3\n',
        },
        'remote edits',
      );
    }

    it('resolves end-to-end using only payload refs + resolutions + expectedRemoteHead', async () => {
      const { remote, git, files, dir } = await setup({ 'a.tex': aBase, 'b.tex': bBase });
      await setUpConflict(git, files, dir, remote);

      const conflict = await git.safePush(dir, remote.url, { username: 'git' });
      expect(conflict.status).toBe('conflict');
      const report = conflict.conflict!;

      // Scope + multi-hunk.
      expect(report.conflictPaths.sort()).toEqual(['a.tex', 'b.tex']);
      const a = report.files.find((f) => f.path === 'a.tex')!;
      expect(a.hunks.length).toBe(2);

      // All three full sides reconstructable from payload refs alone (no shell).
      expect(await git.showAtRef(dir, report.mergeBase!, 'a.tex')).toBe(aBase);
      expect(await git.showAtRef(dir, 'HEAD', 'a.tex')).toBe(
        'a1\na2-local\na3\na4\na5\na6\na7\na8-local\na9\n',
      );
      expect(await git.showAtRef(dir, report.rebasedOnto, 'a.tex')).toBe(
        'a1\na2-remote\na3\na4\na5\na6\na7\na8-remote\na9\n',
      );

      // Resolve both files, guarding with the reported head, and push.
      const aMerged = 'a1\na2-both\na3\na4\na5\na6\na7\na8-both\na9\n';
      const bMerged = 'b1\nb2-both\nb3\n';
      const res = await git.resolvePush(
        dir,
        remote.url,
        { username: 'git' },
        {
          resolutions: [
            { path: 'a.tex', content: aMerged },
            { path: 'b.tex', content: bMerged },
          ],
          expectedRemoteHead: report.remoteHead,
        },
      );

      expect(res.status).toBe('pushed');
      expect(await readFromRemote(remote, 'a.tex')).toBe(aMerged);
      expect(await readFromRemote(remote, 'b.tex')).toBe(bMerged);
    });

    it('omitting a conflicted file re-surfaces the report naming it, pushes nothing', async () => {
      const { remote, git, files, dir } = await setup({ 'a.tex': aBase, 'b.tex': bBase });
      await setUpConflict(git, files, dir, remote);
      const before = await headSha(dir);

      // Provide a.tex but omit b.tex (also conflicted).
      const res = await git.resolvePush(
        dir,
        remote.url,
        { username: 'git' },
        { resolutions: [{ path: 'a.tex', content: aBase }] },
      );

      expect(res.status).toBe('conflict');
      expect(res.conflict?.guidance).toContain('b.tex');
      expect(res.conflict?.conflictPaths.sort()).toEqual(['a.tex', 'b.tex']);
      // Nothing pushed; clone restored.
      expect(await headSha(dir)).toBe(before);
      expect(await noRebaseInProgress(dir)).toBe(true);
      expect(await readFromRemote(remote, 'b.tex')).toBe('b1\nb2-remote\nb3\n');
    });

    it('a non-conflicted resolution path is rejected by name, pushes nothing', async () => {
      const { remote, git, files, dir } = await setup({ 'a.tex': aBase, 'b.tex': bBase });
      await setUpConflict(git, files, dir, remote);
      const before = await headSha(dir);

      await expect(
        git.resolvePush(
          dir,
          remote.url,
          { username: 'git' },
          {
            resolutions: [
              { path: 'a.tex', content: 'a1\na2-both\na3\na4\na5\na6\na7\na8-both\na9\n' },
              { path: 'b.tex', content: 'b1\nb2-both\nb3\n' },
              { path: 'c.tex', content: 'not in conflict\n' },
            ],
          },
        ),
      ).rejects.toThrow(/c\.tex/);

      expect(await headSha(dir)).toBe(before);
      expect(await noRebaseInProgress(dir)).toBe(true);
      expect(await readFromRemote(remote, 'a.tex')).toBe(
        'a1\na2-remote\na3\na4\na5\na6\na7\na8-remote\na9\n',
      );
    });
  });

  describe('read-at-ref (showAtRef)', () => {
    it('reads a committed version at a ref without touching the working tree', async () => {
      const { remote, git, files, dir } = await setup({ 'main.tex': 'alpha\nbeta\ngamma\n' });
      await files.applyEdits(dir, 'main.tex', [{ oldString: 'beta', newString: 'beta-local' }]);
      await git.commit(dir, { message: 'local edits line 2' });
      await pushCommit(
        remote,
        { 'main.tex': 'alpha\nbeta-remote\ngamma\n' },
        'remote edits line 2',
      );
      await simpleGit(dir).fetch(['origin']);

      // Working tree still has our version; the ref read reaches the remote side.
      expect(await git.showAtRef(dir, 'origin/master', 'main.tex')).toBe(
        'alpha\nbeta-remote\ngamma\n',
      );
      expect(await git.showAtRef(dir, 'HEAD', 'main.tex')).toBe('alpha\nbeta-local\ngamma\n');
      await expect(git.showAtRef(dir, 'origin/master', 'missing.tex')).rejects.toThrow(
        /does not exist/,
      );
    });
  });

  describe('status divergence', () => {
    it('lists ahead and behind commits', async () => {
      const { remote, git, files, dir } = await setup({ 'main.tex': 'alpha\nbeta\ngamma\n' });
      await files.applyEdits(dir, 'main.tex', [{ oldString: 'alpha', newString: 'ALPHA' }]);
      await git.commit(dir, { message: 'my local commit' });
      await pushCommit(remote, { 'main.tex': 'alpha\nbeta\nGAMMA\n' }, 'their remote commit');
      await simpleGit(dir).fetch(['origin']);

      const status = await git.status(dir);
      expect(status.ahead).toBe(1);
      expect(status.behind).toBe(1);
      expect(status.aheadCommits.map((c) => c.message)).toContain('my local commit');
      expect(status.behindCommits.map((c) => c.message)).toContain('their remote commit');
    });
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

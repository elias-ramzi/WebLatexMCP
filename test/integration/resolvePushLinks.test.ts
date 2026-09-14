import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, writeFile, stat, symlink, lstat } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { createFakeRemote, pushCommit, type FakeRemote } from './helpers/bareRepo.js';
import { GitService } from '../../src/services/gitService.js';
import { FileService } from '../../src/services/fileService.js';
import { ProjectManager } from '../../src/services/projectManager.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * PR #67 review finding B's regression test needs `writeFile` (as `GitService.resolvePush` calls
 * it, via `node:fs/promises`) to reject exactly once, for exactly one path, mid-resolution — a
 * real permission error on the conflicted file itself doesn't work here because the internal
 * `pull --rebase` that pauses on the conflict re-checks-out that file fresh (default mode bits)
 * as part of resolving, so any chmod applied before calling `resolvePush` is undone before the
 * loop's own `writeFile` runs. `vi.hoisted` state + a partial `vi.mock` of `node:fs/promises`
 * (delegating to the real implementation for everything else, and for `writeFile` itself once
 * `failWriteFileOnce` is unset) lets the test arm a single failure at the exact moment it's
 * needed instead.
 */
const writeFileMockState = vi.hoisted(() => ({ failPath: null as string | null }));
/**
 * T8 (issue #66): a conflicted path lying beneath a working-tree symlink (`linkedAncestor` in
 * gitService.ts) is a branch `resolvePush` refuses on, but git itself never actually produces the
 * layout through an ordinary conflict (a side that turns a directory into a link gets the file
 * moved aside as its own unmerged 120000 entry, which the sibling stage check already refuses) —
 * so the branch that composes the "lies under … a symbolic link" message had no reaching test.
 * Arming `lstatMockState.linkPath` makes exactly one `lstat` call, for exactly that path, report a
 * symlink once, then disarms — the same shape as `writeFileMockState` above.
 */
const lstatMockState = vi.hoisted(() => ({ linkPath: null as string | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (
      filePath: Parameters<typeof actual.writeFile>[0],
      data: Parameters<typeof actual.writeFile>[1],
      options?: Parameters<typeof actual.writeFile>[2],
    ) => {
      if (writeFileMockState.failPath !== null && filePath === writeFileMockState.failPath) {
        writeFileMockState.failPath = null;
        const err = new Error(
          `EACCES: permission denied, open '${String(filePath)}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return actual.writeFile(filePath, data, options);
    },
    lstat: async (filePath: Parameters<typeof actual.lstat>[0]) => {
      if (lstatMockState.linkPath !== null && filePath === lstatMockState.linkPath) {
        lstatMockState.linkPath = null;
        return {
          isSymbolicLink: () => true,
          isDirectory: () => false,
        } as unknown as Awaited<ReturnType<typeof actual.lstat>>;
      }
      return actual.lstat(filePath);
    },
  };
});

describe('resolvePush refuses to write a resolution through a symlink', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(
    files: Record<string, string>,
  ): Promise<{ remote: FakeRemote; git: GitService; files: FileService; dir: string }> {
    const remote = await createFakeRemote(files);
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-rpl-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));
    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: 'test',
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
    };
    const pm = new ProjectManager(config);
    const git = new GitService();
    const dir = pm.projectPath('demo');
    await git.clone(remote.url, dir, { username: 'git' });
    return { remote, git, files: new FileService(), dir };
  }

  async function readFromRemote(remote: FakeRemote, rel: string): Promise<string> {
    const verify = await mkdtemp(path.join(os.tmpdir(), 'ovl-rpl-verify-'));
    cleanups.push(() => rm(verify, { recursive: true, force: true }));
    await simpleGit(verify).clone(remote.url, verify);
    return readFile(path.join(verify, rel), 'utf8');
  }

  const headSha = (dir: string): Promise<string> =>
    simpleGit(dir)
      .revparse(['HEAD'])
      .then((s) => s.trim());

  /** The bare remote's own `<branch>` tip via `ls-remote` — never a clone's remote-tracking ref. */
  async function remoteTip(fromClone: string, url: string, branch: string): Promise<string> {
    const out = await simpleGit(fromClone).listRemote([url, `refs/heads/${branch}`]);
    return out.trim().split(/\s+/)[0] ?? '';
  }

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

  describe.skipIf(process.platform === 'win32')('symlinked conflicts (posix only)', () => {
    it('refuses when upstream retargeted the conflicted path to a symlink outside the clone', async () => {
      const { remote, git, files, dir } = await setup({
        'main.tex': 'root\n',
        'notes.tex': 'alpha\n',
      });

      // Outside secret the link will point at — outside both clones entirely.
      const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-rpl-outside-'));
      cleanups.push(() => rm(outsideDir, { recursive: true, force: true }));
      const outsideFile = path.join(outsideDir, 'secret.txt');
      await writeFile(outsideFile, 'SECRET', 'utf8');

      // Clone B: replace notes.tex with a symlink to the outside file, commit, push.
      const cloneB = await mkdtemp(path.join(os.tmpdir(), 'ovl-rpl-b-'));
      cleanups.push(() => rm(cloneB, { recursive: true, force: true }));
      const gitB = simpleGit(cloneB);
      await gitB.clone(remote.url, cloneB);
      await gitB.addConfig('user.email', 'other@example.com');
      await gitB.addConfig('user.name', 'Other');
      await gitB.addConfig('core.autocrlf', 'false');
      await rm(path.join(cloneB, 'notes.tex'));
      await symlink(outsideFile, path.join(cloneB, 'notes.tex'));
      await gitB.add(['notes.tex']);
      await gitB.commit('retarget notes.tex to an outside symlink');
      await gitB.push('origin', remote.branch);
      const pushedByB = (await gitB.revparse(['HEAD'])).trim();

      // Our clone A: change notes.tex as a regular file, commit.
      await files.applyEdits(dir, 'notes.tex', [{ oldString: 'alpha', newString: 'alpha-local' }]);
      await git.commit(dir, { message: 'local edits to notes' });

      const before = await headSha(dir);
      const conflict = await git.safePush(dir, remote.url, { username: 'git' });
      expect(conflict.status).toBe('conflict');
      expect(conflict.conflict?.conflictPaths).toContain('notes.tex');

      await expect(
        git.resolvePush(
          dir,
          remote.url,
          { username: 'git' },
          { resolutions: [{ path: 'notes.tex', content: 'RESOLVED' }] },
        ),
      ).rejects.toThrow(/symbolic link/);

      // The outside file was never touched.
      expect(await readFile(outsideFile, 'utf8')).toBe('SECRET');
      // Clone fully restored: same HEAD, no rebase in progress, nothing pushed.
      expect(await headSha(dir)).toBe(before);
      expect(await noRebaseInProgress(dir)).toBe(true);
      expect((await git.status(dir)).clean).toBe(true);
      // Ask the bare remote itself (not a clone's stale remote-tracking ref) what it holds.
      expect(await remoteTip(cloneB, remote.url, remote.branch)).toBe(pushedByB);
    });

    it('refuses when OUR side has the symlink, in-project target', async () => {
      const { remote, git, files, dir } = await setup({
        'main.tex': 'root\n',
        'refs.bib': '@article{a,\n title={original}\n}\n',
        'notes.tex': 'alpha\n',
      });

      // Our clone: replace notes.tex with a symlink to refs.bib, commit.
      await rm(path.join(dir, 'notes.tex'));
      await symlink(path.join(dir, 'refs.bib'), path.join(dir, 'notes.tex'));
      await git.commit(dir, { message: 'link notes.tex to refs.bib' });

      // Upstream: edit notes.tex as a regular file.
      await pushCommit(remote, { 'notes.tex': 'alpha-remote\n' }, 'remote edits notes.tex');

      const before = await headSha(dir);
      const conflict = await git.safePush(dir, remote.url, { username: 'git' });
      expect(conflict.status).toBe('conflict');
      expect(conflict.conflict?.conflictPaths).toContain('notes.tex');

      await expect(
        git.resolvePush(
          dir,
          remote.url,
          { username: 'git' },
          { resolutions: [{ path: 'notes.tex', content: 'merged content' }] },
        ),
      ).rejects.toThrow(/symbolic link/);

      expect(await readFile(path.join(dir, 'refs.bib'), 'utf8')).toBe(
        '@article{a,\n title={original}\n}\n',
      );
      expect(await headSha(dir)).toBe(before);
      expect(await noRebaseInProgress(dir)).toBe(true);
      expect((await git.status(dir)).clean).toBe(true);
      void files;
    });

    it('refuses a link-vs-link retarget — the case with no synthetic ~HEAD path', async () => {
      // Both sides of the conflict are symlinks: base has a tracked `notes.tex -> main.tex`,
      // upstream retargets it to a file outside the clone, we retarget it to another in-project
      // file. Unlike a regular-file-vs-link type change, git invents no `notes.tex~HEAD` second
      // unmerged path here, so `conflictPaths` is exactly ["notes.tex"] and the missing-resolution
      // check passes — pre-fix the resolution was written straight through the link into the
      // outside file and the call returned `status: "nothing-to-push"`.
      const { remote, git, dir } = await setup({ 'main.tex': 'root\n', 'other.tex': 'o\n' });

      const cloneB = await mkdtemp(path.join(os.tmpdir(), 'ovl-rpl-b-'));
      cleanups.push(() => rm(cloneB, { recursive: true, force: true }));
      const gitB = simpleGit(cloneB);
      await gitB.clone(remote.url, cloneB);
      await gitB.addConfig('user.email', 'other@example.com');
      await gitB.addConfig('user.name', 'Other');
      await gitB.addConfig('core.autocrlf', 'false');
      // Seed the tracked link through clone B, then bring it into ours.
      await symlink('main.tex', path.join(cloneB, 'notes.tex'));
      await gitB.add(['notes.tex']);
      await gitB.commit('seed link');
      await gitB.push('origin', remote.branch);
      await git.syncPull(remote.url, dir, { username: 'git' });

      const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-rpl-outside-'));
      cleanups.push(() => rm(outsideDir, { recursive: true, force: true }));
      const outsideFile = path.join(outsideDir, 'secret.txt');
      await writeFile(outsideFile, 'SECRET', 'utf8');

      // Upstream retargets the link to the outside file.
      await rm(path.join(cloneB, 'notes.tex'));
      await symlink(outsideFile, path.join(cloneB, 'notes.tex'));
      await gitB.add(['notes.tex']);
      await gitB.commit('retarget outward');
      await gitB.push('origin', remote.branch);

      // We retarget the same link to other.tex.
      await rm(path.join(dir, 'notes.tex'));
      await symlink('other.tex', path.join(dir, 'notes.tex'));
      await git.commit(dir, { message: 'retarget inward' });

      const before = await headSha(dir);
      const conflict = await git.safePush(dir, remote.url, { username: 'git' });
      expect(conflict.status).toBe('conflict');
      expect(conflict.conflict?.conflictPaths).toEqual(['notes.tex']);

      await expect(
        git.resolvePush(
          dir,
          remote.url,
          { username: 'git' },
          { resolutions: [{ path: 'notes.tex', content: 'PWNED\n' }] },
        ),
      ).rejects.toThrow(/symbolic link/);

      expect(await readFile(outsideFile, 'utf8')).toBe('SECRET');
      expect(await headSha(dir)).toBe(before);
      expect(await noRebaseInProgress(dir)).toBe(true);
      expect((await git.status(dir)).clean).toBe(true);
    });
  });

  describe.skipIf(process.platform === 'win32')(
    'a link only in the BASE stage is not a link (posix only)',
    () => {
      it('accepts a resolution when both sides replaced a tracked link with a regular file', async () => {
        // Base has `notes.tex -> main.tex`; upstream and we each replace the link with a regular
        // file carrying different text. Every side a resolution could land on is now a file, so the
        // conflict is an ordinary content conflict — only the BASE stage (1) still shows mode
        // 120000. Judging "is a link" on any stage refused this with "symbolic link", leaving a
        // caller no way to resolve a conflict that has no link left in it.
        const { remote, git, dir } = await setup({ 'main.tex': 'root\n' });

        const cloneB = await mkdtemp(path.join(os.tmpdir(), 'ovl-rpl-b-'));
        cleanups.push(() => rm(cloneB, { recursive: true, force: true }));
        const gitB = simpleGit(cloneB);
        await gitB.clone(remote.url, cloneB);
        await gitB.addConfig('user.email', 'other@example.com');
        await gitB.addConfig('user.name', 'Other');
        await gitB.addConfig('core.autocrlf', 'false');
        await symlink('main.tex', path.join(cloneB, 'notes.tex'));
        await gitB.add(['notes.tex']);
        await gitB.commit('seed link');
        await gitB.push('origin', remote.branch);
        await git.syncPull(remote.url, dir, { username: 'git' });

        // Upstream: the link becomes a regular file.
        await rm(path.join(cloneB, 'notes.tex'));
        await writeFile(path.join(cloneB, 'notes.tex'), 'remote text\n', 'utf8');
        await gitB.add(['notes.tex']);
        await gitB.commit('unlink upstream');
        await gitB.push('origin', remote.branch);

        // Ours: the same link becomes a different regular file.
        await rm(path.join(dir, 'notes.tex'));
        await writeFile(path.join(dir, 'notes.tex'), 'our text\n', 'utf8');
        await git.commit(dir, { message: 'unlink locally' });

        const conflict = await git.safePush(dir, remote.url, { username: 'git' });
        expect(conflict.status).toBe('conflict');
        expect(conflict.conflict?.conflictPaths).toEqual(['notes.tex']);

        const res = await git.resolvePush(
          dir,
          remote.url,
          { username: 'git' },
          { resolutions: [{ path: 'notes.tex', content: 'merged text\n' }] },
        );
        expect(res.status).toBe('pushed');
        expect(await readFromRemote(remote, 'notes.tex')).toBe('merged text\n');
        expect((await lstat(path.join(dir, 'notes.tex'))).isSymbolicLink()).toBe(false);
        expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('root\n');
        expect(await noRebaseInProgress(dir)).toBe(true);
      });
    },
  );

  it('resolves a non-ASCII conflicted path without C-quoting it', async () => {
    const { remote, git, files, dir } = await setup({ 'é.tex': 'alpha\nbeta\ngamma\n' });
    await files.applyEdits(dir, 'é.tex', [{ oldString: 'beta', newString: 'beta-local' }]);
    await git.commit(dir, { message: 'local edit to é.tex' });
    await pushCommit(remote, { 'é.tex': 'alpha\nbeta-remote\ngamma\n' }, 'remote edit to é.tex');

    const conflict = await git.safePush(dir, remote.url, { username: 'git' });
    expect(conflict.status).toBe('conflict');
    expect(conflict.conflict?.conflictPaths).toEqual(['é.tex']);
    const detail = conflict.conflict?.files.find((f) => f.path === 'é.tex');
    expect(detail).toBeDefined();
    expect(detail?.ours).toContain('beta-local');
    expect(detail?.theirs).toContain('beta-remote');

    const res = await git.resolvePush(
      dir,
      remote.url,
      { username: 'git' },
      { resolutions: [{ path: 'é.tex', content: 'merged\n' }] },
    );
    expect(res.status).toBe('pushed');
    expect(await readFromRemote(remote, 'é.tex')).toBe('merged\n');
  });

  // A plain regular-file conflict resolving and pushing through `resolvePush` is already covered
  // by "applies merged content, continues the rebase, and pushes" in test/integration/safePush.test.ts —
  // not duplicated here.

  describe.skipIf(process.platform === 'win32')(
    'a directory replaced by a symlink upstream (posix only)',
    () => {
      // NOTE: this is a characterisation test, not regression coverage for `linkedAncestor`. When
      // upstream turns a tracked directory into a symlink, git's rebase moves the *symlink* side
      // aside to a synthetic `sub~HEAD` unmerged path and leaves `sub` itself as a real directory
      // in the working tree (verified empirically: `git diff --name-only --diff-filter=U` reports
      // exactly `sub/x.tex` and `sub~HEAD`, and `sub` on disk is a plain directory). So
      // `sub/x.tex`'s ancestor `sub` is never actually a symlink at resolution time — this layout
      // is already refused by the existing stage-2/3 check (`hasSymlinkMode`) on the synthetic
      // `sub~HEAD` path, which is itself a symlink. It passes identically before and after this
      // change; `test/unit/linkedAncestor.test.ts` is what actually exercises `linkedAncestor`.
      it('refuses via the existing stage-2/3 link check on the synthetic sub~HEAD path', async () => {
        const { remote, git, dir } = await setup({
          'main.tex': 'root\n',
          'sub/x.tex': 'alpha\n',
        });

        // Outside dir the retargeted symlink will point at — outside both clones entirely.
        const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-rpl-outside-'));
        cleanups.push(() => rm(outsideDir, { recursive: true, force: true }));
        await writeFile(path.join(outsideDir, 'secret.txt'), 'SECRET', 'utf8');

        // Clone B (remote side): replace the tracked directory `sub` with a symlink to `outside`.
        const cloneB = await mkdtemp(path.join(os.tmpdir(), 'ovl-rpl-b-'));
        cleanups.push(() => rm(cloneB, { recursive: true, force: true }));
        const gitB = simpleGit(cloneB);
        await gitB.clone(remote.url, cloneB);
        await gitB.addConfig('user.email', 'other@example.com');
        await gitB.addConfig('user.name', 'Other');
        await gitB.addConfig('core.autocrlf', 'false');
        await rm(path.join(cloneB, 'sub'), { recursive: true, force: true });
        await symlink(outsideDir, path.join(cloneB, 'sub'));
        await gitB.add(['-A']);
        await gitB.commit('retarget sub to an outside symlink');
        await gitB.push('origin', remote.branch);
        const pushedByB = (await gitB.revparse(['HEAD'])).trim();

        // Our clone A: edit sub/x.tex as a regular file, commit.
        await writeFile(path.join(dir, 'sub', 'x.tex'), 'alpha-local\n', 'utf8');
        await git.commit(dir, { message: 'local edit to sub/x.tex' });

        const before = await headSha(dir);
        const conflict = await git.safePush(dir, remote.url, { username: 'git' });
        expect(conflict.status).toBe('conflict');
        // What the tool's normal conflict path actually reports for this layout.
        // The synthetic name git gives the moved-aside link (`sub~HEAD` here) is the merge
        // backend's label and has varied across git versions, so only its shape is asserted.
        const paths = conflict.conflict?.conflictPaths ?? [];
        expect(paths).toContain('sub/x.tex');
        expect(paths.some((p) => p.startsWith('sub~'))).toBe(true);

        await expect(
          git.resolvePush(
            dir,
            remote.url,
            { username: 'git' },
            { resolutions: [{ path: 'sub/x.tex', content: 'merged content' }] },
          ),
        ).rejects.toThrow(/symbolic link/);

        // Nothing was written through the symlink.
        expect(await readFile(path.join(outsideDir, 'secret.txt'), 'utf8')).toBe('SECRET');
        try {
          await stat(path.join(outsideDir, 'x.tex'));
          expect.fail('x.tex should not have been written into the outside directory');
        } catch {
          // ENOENT — good.
        }
        expect(await headSha(dir)).toBe(before);
        expect(await noRebaseInProgress(dir)).toBe(true);
        expect((await git.status(dir)).clean).toBe(true);
        // Ask the bare remote itself (not a clone's stale remote-tracking ref) what it holds.
        expect(await remoteTip(cloneB, remote.url, remote.branch)).toBe(pushedByB);
      });
    },
  );

  // PR #67 review finding B: the paused-rebase loop in `resolvePush` used to abort the rebase
  // explicitly only before its two deliberate refusal throws (the symlink check above, and the
  // "did not converge" bound). `hasSymlinkMode`'s `ls-files` spawn, `linkedAncestor`'s `lstat`s,
  // `writeFile`, and the `git add` spawn were unprotected: any of THEM throwing left the clone
  // mid-rebase (conflict markers on disk, detached HEAD) — contradicting "the clone is back to
  // where it was before it started" that CLAUDE.md and this method's own doc comment promise.
  // Not posix-gated: no symlink and no `[` is involved, and a spawn failure is likeliest on the
  // Windows CI leg — the one platform the other suites in this file cannot cover.
  describe('a throw mid-loop (not one of the two deliberate refusals) still aborts the rebase', () => {
    afterEach(() => {
      // Backstop for the in-test `finally`: an armed failure must never leak into another test.
      writeFileMockState.failPath = null;
    });
    it('a writeFile failure while applying a resolution leaves the clone exactly as it was', async () => {
      const { remote, git, dir } = await setup({ 'notes.tex': 'alpha\n' });

      await writeFile(path.join(dir, 'notes.tex'), 'alpha-local\n', 'utf8');
      await git.commit(dir, { message: 'local edit to notes.tex' });
      await pushCommit(remote, { 'notes.tex': 'alpha-remote\n' }, 'remote edit to notes.tex');

      const before = await headSha(dir);
      const remoteBefore = await remoteTip(dir, remote.url, remote.branch);
      const conflict = await git.safePush(dir, remote.url, { username: 'git' });
      expect(conflict.status).toBe('conflict');
      expect(conflict.conflict?.conflictPaths).toEqual(['notes.tex']);

      // Arm a single `writeFile` failure for exactly the conflicted path, disarmed again the
      // instant it fires (see the `vi.mock` above) so it can't affect any later write in this
      // or another test.
      writeFileMockState.failPath = path.join(dir, 'notes.tex');
      try {
        await expect(
          git.resolvePush(
            dir,
            remote.url,
            { username: 'git' },
            { resolutions: [{ path: 'notes.tex', content: 'merged\n' }] },
          ),
        ).rejects.toThrow(/EACCES/);
      } finally {
        writeFileMockState.failPath = null;
      }

      // The clone is back to exactly where it was: no rebase in progress, clean status, same
      // HEAD, and the bare remote's tip untouched (nothing pushed).
      expect(await noRebaseInProgress(dir)).toBe(true);
      expect((await git.status(dir)).clean).toBe(true);
      expect(await headSha(dir)).toBe(before);
      expect(await remoteTip(dir, remote.url, remote.branch)).toBe(remoteBefore);
    });
  });

  // Issue #66 (T5): the loop-priming rebase step, `let step = await this.runRebaseStep(...)`
  // before the `for (...!step.ok...)` loop in `resolvePush`, sits OUTSIDE the loop body's own
  // catch-everything try/catch (the one the "throw mid-loop" describe above exercises). If
  // `runRebaseStep`'s own catch throws while trying to answer "is this a conflict?" (its
  // `unmergedPaths` call spawns `git diff`, which can itself fail — e.g. EAGAIN under process
  // pressure), nothing aborted the paused rebase and the error propagated with the clone left
  // mid-rebase, contradicting the same guarantee the mid-loop describe protects for every step
  // after the first.
  describe('a throw from the priming rebase step (before the loop) still aborts the rebase', () => {
    it('unmergedPaths failing on the very first pull --rebase leaves the clone exactly as it was', async () => {
      const { remote, git, dir } = await setup({ 'notes.tex': 'alpha\n' });

      await writeFile(path.join(dir, 'notes.tex'), 'alpha-local\n', 'utf8');
      await git.commit(dir, { message: 'local edit to notes.tex' });
      await pushCommit(remote, { 'notes.tex': 'alpha-remote\n' }, 'remote edit to notes.tex');

      const before = await headSha(dir);
      const remoteBefore = await remoteTip(dir, remote.url, remote.branch);
      // `safePush` runs its own rebase attempt, hits the same conflict, and aborts back to this
      // pre-push state — leaving `resolvePush`'s own fetch + priming `pull --rebase` (the call
      // under test) to hit that same conflict fresh a moment later.
      const conflict = await git.safePush(dir, remote.url, { username: 'git' });
      expect(conflict.status).toBe('conflict');
      expect(conflict.conflict?.conflictPaths).toEqual(['notes.tex']);

      const spy = vi
        .spyOn(
          GitService.prototype as unknown as {
            unmergedPaths: (...a: unknown[]) => Promise<string[]>;
          },
          'unmergedPaths',
        )
        .mockRejectedValueOnce(new Error('EAGAIN: spawn failed'));
      try {
        await expect(
          git.resolvePush(
            dir,
            remote.url,
            { username: 'git' },
            { resolutions: [{ path: 'notes.tex', content: 'merged\n' }] },
          ),
        ).rejects.toThrow(/EAGAIN/);
      } finally {
        spy.mockRestore();
      }

      // Pre-fix: this is false — the priming call's own catch propagated the EAGAIN failure
      // without ever calling `abortRebaseIfInProgress`, leaving `pull --rebase`'s conflict paused
      // (conflict markers on disk, rebase-merge state directory present).
      expect(await noRebaseInProgress(dir)).toBe(true);
      expect((await git.status(dir)).clean).toBe(true);
      expect(await headSha(dir)).toBe(before);
      expect(await remoteTip(dir, remote.url, remote.branch)).toBe(remoteBefore);
    });
  });

  // The same class in `safePush`'s own rebase attempt (`tryRebase`): its catch lists the unmerged
  // paths and builds the conflict report BEFORE `rebase --abort`, so a throw from either left the
  // clone mid-rebase.
  describe("a throw inside safePush's own rebase attempt still aborts the rebase", () => {
    it('unmergedPaths failing during the push rebase leaves the clone exactly as it was', async () => {
      const { remote, git, dir } = await setup({ 'notes.tex': 'alpha\n' });

      await writeFile(path.join(dir, 'notes.tex'), 'alpha-local\n', 'utf8');
      await git.commit(dir, { message: 'local edit to notes.tex' });
      await pushCommit(remote, { 'notes.tex': 'alpha-remote\n' }, 'remote edit to notes.tex');

      const before = await headSha(dir);
      const remoteBefore = await remoteTip(dir, remote.url, remote.branch);

      const spy = vi
        .spyOn(
          GitService.prototype as unknown as {
            unmergedPaths: (...a: unknown[]) => Promise<string[]>;
          },
          'unmergedPaths',
        )
        .mockRejectedValueOnce(new Error('EAGAIN: spawn failed'));
      try {
        await expect(git.safePush(dir, remote.url, { username: 'git' })).rejects.toThrow(/EAGAIN/);
      } finally {
        spy.mockRestore();
      }

      // Pre-fix: false — `tryRebase`'s catch propagated the failure with the rebase still paused.
      expect(await noRebaseInProgress(dir)).toBe(true);
      expect((await git.status(dir)).clean).toBe(true);
      expect(await headSha(dir)).toBe(before);
      expect(await remoteTip(dir, remote.url, remote.branch)).toBe(remoteBefore);
    });
  });

  // Issue #66 (T8): see the `lstatMockState` doc comment at the top of this file. This exercises
  // the `linkedAncestor` refusal branch of `resolvePush` that, per the PR that added it, has no
  // way to be reached through git alone.
  describe('a conflicted path lying under a symlinked ancestor directory (mocked lstat)', () => {
    afterEach(() => {
      // Backstop, mirroring `writeFileMockState`'s: an armed failure must never leak into another
      // test even if this one fails before it fires.
      lstatMockState.linkPath = null;
    });

    it("refuses via linkedAncestor when the conflicted path's ancestor directory is (mocked as) a symlink", async () => {
      const { remote, git, files, dir } = await setup({ 'sub/notes.tex': 'alpha\n' });
      await files.applyEdits(dir, 'sub/notes.tex', [
        { oldString: 'alpha', newString: 'alpha-local' },
      ]);
      await git.commit(dir, { message: 'local edit to sub/notes.tex' });
      await pushCommit(
        remote,
        { 'sub/notes.tex': 'alpha-remote\n' },
        'remote edit to sub/notes.tex',
      );

      const before = await headSha(dir);
      const remoteBefore = await remoteTip(dir, remote.url, remote.branch);
      const conflict = await git.safePush(dir, remote.url, { username: 'git' });
      expect(conflict.status).toBe('conflict');
      expect(conflict.conflict?.conflictPaths).toEqual(['sub/notes.tex']);

      // Without arming the mock, this resolution would simply succeed (there is no actual
      // symlink anywhere in this layout) — proving the message is unreachable through git alone,
      // and that the mock is what makes the branch fire. This is characterisation of a
      // previously-untested branch, not a regression fix for prior behaviour.
      lstatMockState.linkPath = path.join(dir, 'sub');
      await expect(
        git.resolvePush(
          dir,
          remote.url,
          { username: 'git' },
          { resolutions: [{ path: 'sub/notes.tex', content: 'merged\n' }] },
        ),
      ).rejects.toThrow(/"sub\/notes\.tex" lies under "sub", a symbolic link/);

      expect(await noRebaseInProgress(dir)).toBe(true);
      expect((await git.status(dir)).clean).toBe(true);
      expect(await headSha(dir)).toBe(before);
      expect(await remoteTip(dir, remote.url, remote.branch)).toBe(remoteBefore);
    });
  });
});

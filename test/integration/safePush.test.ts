import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { createFakeRemote, pushCommit, type FakeRemote } from './helpers/bareRepo.js';
import { GitService, UntrackedOverwriteError } from '../../src/services/gitService.js';
import { FileService } from '../../src/services/fileService.js';
import { ProjectManager } from '../../src/services/projectManager.js';
import type { ServerConfig } from '../../src/types.js';
import { planConflictPayload, CONFLICT_SIDE_CAP } from '../../src/lib/conflictBudget.js';
import { renderConflictText, buildConflictFilePayload } from '../../src/lib/conflictText.js';

describe('safe push (pull-rebase + branch review) against a bare-repo stand-in', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(
    files: Record<string, string>,
    hooks?: { beforePush?: (attempt: number) => Promise<void> },
  ): Promise<{ remote: FakeRemote; git: GitService; files: FileService; dir: string }> {
    const remote = await createFakeRemote(files);
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-sp-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));
    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: 'test',
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
    };
    const pm = new ProjectManager(config);
    const git = hooks ? new GitService(undefined, hooks) : new GitService();
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
    // That commit's payload names the file it touched.
    expect(res.rebasedOver?.[0]?.files[0]?.path).toBe('main.tex');
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

  describe('conflict payload budget (large sides do not blow past a tool result cap)', () => {
    // A single file whose base/ours/theirs are each well past CONFLICT_SIDE_CAP (12000 chars) —
    // the shape of the real-world failure: one conflicted file's sides alone produced a
    // 67,485-character tool result, past the client's cap, so it was never delivered.
    function bigContent(lines: number): string {
      return (
        Array.from({ length: lines }, (_, i) => `line ${i} of the document body`).join('\n') + '\n'
      );
    }

    async function setupBigConflict(): Promise<{
      remote: FakeRemote;
      git: GitService;
      dir: string;
    }> {
      const original = bigContent(600); // ~18k chars — comfortably over CONFLICT_SIDE_CAP
      const { remote, git, files, dir } = await setup({ 'main.tex': original });
      await files.applyEdits(dir, 'main.tex', [
        { oldString: 'line 10 of the document body', newString: 'line 10 LOCAL' },
      ]);
      await git.commit(dir, { message: 'local edits line 10' });

      // Remote edits the SAME line, so this stays a genuine (small) overlap — only the sides
      // (the whole file, on each side) are large, not the hunk itself.
      const remoteEdited = original.replace('line 10 of the document body', 'line 10 REMOTE');
      await pushCommit(remote, { 'main.tex': remoteEdited }, 'remote edits line 10');

      return { remote, git, dir };
    }

    it('bounds both channels, keeps the essential fields, and restores full sides on request', async () => {
      const { remote, git, dir } = await setupBigConflict();
      const before = await headSha(dir);

      const res = await git.safePush(dir, remote.url, { username: 'git' });
      expect(res.status).toBe('conflict');
      const conflict = res.conflict!;
      // Sanity: this really is the large-sides shape the budget exists for.
      const f = conflict.files.find((x) => x.path === 'main.tex')!;
      expect(f.base!.length).toBeGreaterThan(CONFLICT_SIDE_CAP);
      expect(f.ours!.length).toBeGreaterThan(CONFLICT_SIDE_CAP);
      expect(f.theirs!.length).toBeGreaterThan(CONFLICT_SIDE_CAP);

      // --- auto (default): both channels bounded well under the 67,485 chars that failed. ---
      // (A raw size ceiling here would be vacuous either way: this shape — one file, three huge
      // sides, zero/tiny hunks — was already bounded by CONFLICT_SIDE_CAP alone before the
      // rendered-size budgeting fix, so a `text.length < N` assertion would pass whether or not
      // that fix is present. What genuinely distinguishes "budgeted" from "not" for THIS shape is
      // the elision metadata itself: every oversized side must be marked `elided`, with its TRUE
      // size, and a working `read_file(path, ref)` pointer — see the worst-case shapes in
      // `conflictText.test.ts` for the rendered-size regression coverage this fix is really for.
      const plan = planConflictPayload(conflict.files, {
        detail: 'auto',
        refs: { mergeBase: conflict.mergeBase, rebasedOnto: conflict.rebasedOnto },
      });
      const text = renderConflictText(res.summary, conflict, { detail: 'auto' });
      const structuredFiles = buildConflictFilePayload(conflict, plan);
      expect(plan.truncated).toBe(true);
      const entry = structuredFiles.find((sf) => sf.path === 'main.tex')!;
      expect(entry.elided?.base).toBeDefined();
      expect(entry.elided?.ours).toBeDefined();
      expect(entry.elided?.theirs).toBeDefined();
      expect(entry.elided?.base?.chars).toBe(f.base!.length);
      expect(entry.elided?.ours?.chars).toBe(f.ours!.length);
      expect(entry.elided?.theirs?.chars).toBe(f.theirs!.length);
      expect(entry.base).toBeNull();
      expect(entry.ours).toBeNull();
      expect(entry.theirs).toBeNull();

      // --- the ~3% a caller needs to act must never be what gets cut. ---
      expect(conflict.conflictPaths).toEqual(['main.tex']);
      expect(conflict.remoteHead).toBeTruthy();
      expect(conflict.mergeBase).toBeTruthy();
      expect(conflict.remoteCommits.map((c) => c.message)).toContain('remote edits line 10');
      expect(text).toContain(conflict.remoteHead);
      expect(text).toContain('remote edits line 10');

      // --- conflictDetail: 'full' restores the complete sides. ---
      const fullPlan = planConflictPayload(conflict.files, {
        detail: 'full',
        refs: { mergeBase: conflict.mergeBase, rebasedOnto: conflict.rebasedOnto },
      });
      const fullText = renderConflictText(res.summary, conflict, { detail: 'full' });
      const fullStructured = buildConflictFilePayload(conflict, fullPlan);
      expect(fullPlan.truncated).toBe(false);
      expect(fullText).toContain(f.base!);
      expect(fullText).toContain(f.ours!);
      expect(fullText).toContain(f.theirs!);
      expect(fullStructured[0]!.base).toBe(f.base);
      expect(fullStructured[0]!.ours).toBe(f.ours);
      expect(fullStructured[0]!.theirs).toBe(f.theirs);
      expect(fullStructured[0]!.elided).toBeUndefined();

      // --- the clone is still at its pre-push state after the aborted conflict. ---
      expect(await headSha(dir)).toBe(before);
      expect((await git.status(dir)).clean).toBe(true);
      expect(await noRebaseInProgress(dir)).toBe(true);
    });
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
      /uncommitted changes.*main\.tex/is,
    );
  });

  it('refuses a dirty tree with both a modified tracked file and an untracked file, naming each', async () => {
    const { remote, git, files, dir } = await setup({ 'main.tex': 'one\ntwo\n' });
    await files.applyEdits(dir, 'main.tex', [{ oldString: 'two', newString: 'TWO' }]);
    await writeFile(path.join(dir, 'main.pdf'), 'binary-stub', 'utf8');

    let message: string;
    try {
      await git.safePush(dir, remote.url, { username: 'git' });
      throw new Error('expected safePush to reject');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/uncommitted changes/i);
    // main.tex is named as the blocking (tracked, modified) file...
    expect(message).toMatch(/tracked file\(s\):\s*main\.tex/i);
    // ...while main.pdf is named only in the untracked reassurance, never as a reason to block.
    expect(message).toMatch(/untracked.*never block.*main\.pdf/is);
  });

  it('pushes over untracked files nobody owns and leaves them in place', async () => {
    const { remote, git, files, dir } = await setup({ 'main.tex': 'one\ntwo\n' });
    await files.applyEdits(dir, 'main.tex', [{ oldString: 'two', newString: 'TWO' }]);
    await git.commit(dir, { message: 'edit two' });

    await writeFile(path.join(dir, 'main.pdf'), 'binary-stub', 'utf8');
    await mkdir(path.join(dir, 'notes'), { recursive: true });
    await writeFile(path.join(dir, 'notes', 'scratch.txt'), 'scratch notes\n', 'utf8');

    const res = await git.safePush(dir, remote.url, { username: 'git' });

    expect(res.status).toBe('pushed');
    expect(await readFile(path.join(dir, 'main.pdf'), 'utf8')).toBe('binary-stub');
    expect(await readFile(path.join(dir, 'notes', 'scratch.txt'), 'utf8')).toBe('scratch notes\n');
    await expect(readFromRemote(remote, 'main.pdf')).rejects.toThrow();
    await expect(readFromRemote(remote, 'notes/scratch.txt')).rejects.toThrow();
  });

  it('reports by name an untracked file the incoming commit would overwrite, clone intact', async () => {
    const { remote, git, files, dir } = await setup({ 'main.tex': 'one\ntwo\n' });
    await files.applyEdits(dir, 'main.tex', [{ oldString: 'two', newString: 'TWO' }]);
    await git.commit(dir, { message: 'edit two' });

    await pushCommit(remote, { 'figs/new.tex': 'remote\n' }, 'adds figure');

    await mkdir(path.join(dir, 'figs'), { recursive: true });
    await writeFile(path.join(dir, 'figs', 'new.tex'), 'local\n', 'utf8');

    const before = await headSha(dir);
    let caught: unknown;
    try {
      await git.safePush(dir, remote.url, { username: 'git' });
      throw new Error('expected safePush to reject');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UntrackedOverwriteError);
    expect((caught as UntrackedOverwriteError).paths).toContain('figs/new.tex');
    expect(await noRebaseInProgress(dir)).toBe(true);
    expect(await headSha(dir)).toBe(before);
    expect(await readFile(path.join(dir, 'figs', 'new.tex'), 'utf8')).toBe('local\n');
  });

  describe('push retry on a lost fast-forward race', () => {
    it('retries the pull-rebase when the remote moves between fetch and push', async () => {
      const remoteBox: { remote?: FakeRemote } = {};
      let calls = 0;
      const { remote, git, files, dir } = await setup(
        { 'main.tex': 'one\ntwo\nthree\n' },
        {
          beforePush: async (attempt) => {
            calls++;
            if (attempt === 1) {
              await pushCommit(remoteBox.remote!, { 'other.tex': 'x\n' }, 'landed mid-push');
            }
          },
        },
      );
      remoteBox.remote = remote;
      await files.applyEdits(dir, 'main.tex', [{ oldString: 'one', newString: 'ONE' }]);
      await git.commit(dir, { message: 'edit line 1' });

      const res = await git.safePush(dir, remote.url, { username: 'git' });

      expect(res.status).toBe('pushed');
      expect(res.rebasedOver?.map((c) => c.message)).toContain('landed mid-push');
      expect(await readFromRemote(remote, 'main.tex')).toBe('ONE\ntwo\nthree\n');
      expect(await readFromRemote(remote, 'other.tex')).toBe('x\n');
      expect(calls).toBe(2);
    });

    it('carries the fresh ahead count and the post-rebase HEAD as pushedSha on a real retry', async () => {
      const remoteBox: { remote?: FakeRemote } = {};
      let calls = 0;
      const { remote, git, files, dir } = await setup(
        { 'main.tex': 'one\ntwo\nthree\n' },
        {
          beforePush: async (attempt) => {
            calls++;
            if (attempt === 1) {
              await pushCommit(remoteBox.remote!, { 'other.tex': 'x\n' }, 'landed mid-push');
            }
          },
        },
      );
      remoteBox.remote = remote;
      await files.applyEdits(dir, 'main.tex', [{ oldString: 'one', newString: 'ONE' }]);
      await git.commit(dir, { message: 'edit line 1' });
      const preHead = await headSha(dir);

      const res = await git.safePush(dir, remote.url, { username: 'git' });

      expect(res.status).toBe('pushed');
      // The rebase replays a real (non-empty) commit, so the fresh post-rebase ahead count is
      // still 1 — and pushedSha is the HEAD *after* that rebase, not the pre-push HEAD.
      expect(res.pushedCommits).toBe(1);
      const postRebaseHead = await headSha(dir);
      expect(postRebaseHead).not.toBe(preHead);
      expect(res.pushedSha).toBe(postRebaseHead);
      expect(calls).toBe(2);
    });

    it('reports nothing-to-push, not a phantom pushed result, when a retry round drops our commit as empty (identical remote change)', async () => {
      // Regression for the finding: pushWithRetry used to push (attempt 2) without re-reading
      // ahead/behind after the round-1 rebase. When a collaborator lands a change IDENTICAL to
      // ours, that rebase drops our replayed commit as empty (already-applied), so there is
      // nothing left to send — but the stale pre-read `ab.ahead` (from before the retry) still
      // said "1", and `git push` on an up-to-date branch is a silent no-op success, so the old
      // code reported `status: "pushed"` with the collaborator's own sha as `pushedSha`.
      const remoteBox: { remote?: FakeRemote } = {};
      let calls = 0;
      const { remote, git, files, dir } = await setup(
        { 'main.tex': 'one\ntwo\nthree\n' },
        {
          beforePush: async (attempt) => {
            calls++;
            if (attempt === 1) {
              // A collaborator lands the exact same edit we're about to push.
              await pushCommit(
                remoteBox.remote!,
                { 'main.tex': 'one\nTWO\nthree\n' },
                'identical edit landed',
              );
            }
          },
        },
      );
      remoteBox.remote = remote;
      await files.applyEdits(dir, 'main.tex', [{ oldString: 'two', newString: 'TWO' }]);
      await git.commit(dir, { message: 'edit line 2' });

      const res = await git.safePush(dir, remote.url, { username: 'git' });

      const collaboratorSha = (await simpleGit(remote.bareDir).revparse(['master'])).trim();
      expect(res.status).toBe('nothing-to-push');
      expect(res.pushed).toBe(false);
      // nothing-to-push never carries a pushedSha; in particular it must never be the
      // collaborator's sha the old buggy code reported it as.
      expect(res.pushedSha).toBeUndefined();
      expect(res.pushedSha).not.toBe(collaboratorSha);
      // The retry round's landing still shows up as something we rebased over.
      expect(res.rebasedOver?.map((c) => c.message)).toContain('identical edit landed');
      expect(await readFromRemote(remote, 'main.tex')).toBe('one\nTWO\nthree\n');
      // Only attempt 1's push was ever tried; attempt 2 was skipped once the fresh ahead-count
      // came back zero, so its beforePush hook never fired.
      expect(calls).toBe(1);
      // The generic "already up to date" wording doesn't tell the caller their own just-made
      // commit was the thing that got replayed empty and dropped — say so explicitly.
      expect(res.summary).toMatch(/dropped/i);
      expect(res.summary).toMatch(/already there|identical change/i);
    });

    it('gives up with remote-moved after 3 rounds, clone intact, nothing pushed', async () => {
      const remoteBox: { remote?: FakeRemote } = {};
      let calls = 0;
      const { remote, git, files, dir } = await setup(
        { 'main.tex': 'one\ntwo\nthree\n' },
        {
          beforePush: async (attempt) => {
            calls++;
            await pushCommit(
              remoteBox.remote!,
              { [`other-${attempt}.tex`]: 'x\n' },
              `landed ${attempt}`,
            );
          },
        },
      );
      remoteBox.remote = remote;
      await files.applyEdits(dir, 'main.tex', [{ oldString: 'one', newString: 'ONE' }]);
      await git.commit(dir, { message: 'edit line 1' });

      const res = await git.safePush(dir, remote.url, { username: 'git' });

      expect(res.status).toBe('remote-moved');
      expect(res.pushed).toBe(false);
      const remoteTip = (await simpleGit(remote.bareDir).revparse(['master'])).trim();
      expect(res.remoteHead).toBe(remoteTip);
      expect(res.rebasedOver?.length ?? 0).toBeGreaterThanOrEqual(1);
      // `rebasedOver` accounts for the *final* landing too — the one whose commit is what
      // `remoteHead` actually names — not just the ones from earlier retry rounds.
      const finalLanding = res.rebasedOver?.find((c) => c.message === 'landed 3');
      expect(finalLanding).toBeDefined();
      expect(finalLanding?.hash).toBe(res.remoteHead);
      expect(await noRebaseInProgress(dir)).toBe(true);
      expect((await git.aheadBehind(dir)).ahead).toBeGreaterThanOrEqual(1);
      expect(calls).toBe(3);
      await expect(readFromRemote(remote, 'main.tex')).resolves.not.toContain('ONE');
    });

    it('a conflict during a retry round is reported as conflict, not retried', async () => {
      const remoteBox: { remote?: FakeRemote } = {};
      let calls = 0;
      const { remote, git, files, dir } = await setup(
        { 'main.tex': 'alpha\nbeta\ngamma\n' },
        {
          beforePush: async (attempt) => {
            calls++;
            if (attempt === 1) {
              await pushCommit(
                remoteBox.remote!,
                { 'main.tex': 'alpha\nbeta-remote\ngamma\n' },
                'remote edits line 2',
              );
            }
          },
        },
      );
      remoteBox.remote = remote;
      await files.applyEdits(dir, 'main.tex', [{ oldString: 'beta', newString: 'beta-local' }]);
      await git.commit(dir, { message: 'local edits line 2' });

      const res = await git.safePush(dir, remote.url, { username: 'git' });

      expect(res.status).toBe('conflict');
      expect(res.conflict?.files[0]?.path).toBe('main.tex');
      expect(calls).toBe(1);
      expect(await noRebaseInProgress(dir)).toBe(true);
    });

    it('resolvePush: resolves, then retries when the remote moves before the push', async () => {
      const remoteBox: { remote?: FakeRemote } = {};
      let calls = 0;
      const { remote, git, files, dir } = await setup(
        { 'main.tex': 'alpha\nbeta\ngamma\n' },
        {
          beforePush: async (attempt) => {
            calls++;
            if (attempt === 1) {
              await pushCommit(remoteBox.remote!, { 'other.tex': 'x\n' }, 'landed mid-resolve');
            }
          },
        },
      );
      remoteBox.remote = remote;
      await files.applyEdits(dir, 'main.tex', [{ oldString: 'beta', newString: 'beta-local' }]);
      await git.commit(dir, { message: 'local edits line 2' });
      await pushCommit(
        remote,
        { 'main.tex': 'alpha\nbeta-remote\ngamma\n' },
        'remote edits line 2',
      );

      const conflict = await git.safePush(dir, remote.url, { username: 'git' });
      expect(conflict.status).toBe('conflict');

      const res = await git.resolvePush(
        dir,
        remote.url,
        { username: 'git' },
        {
          resolutions: [{ path: 'main.tex', content: 'alpha\nbeta-local-and-remote\ngamma\n' }],
        },
      );

      expect(res.status).toBe('pushed');
      expect(await readFromRemote(remote, 'main.tex')).toBe(
        'alpha\nbeta-local-and-remote\ngamma\n',
      );
      expect(await readFromRemote(remote, 'other.tex')).toBe('x\n');
      expect(calls).toBeGreaterThanOrEqual(2);
    });

    it('resolvePush with expectedRemoteHead refuses (remote-moved) instead of retrying past it', async () => {
      const remoteBox: { remote?: FakeRemote } = {};
      let calls = 0;
      const { remote, git, files, dir } = await setup(
        { 'main.tex': 'alpha\nbeta\ngamma\n' },
        {
          beforePush: async (attempt) => {
            calls++;
            if (attempt === 1) {
              await pushCommit(remoteBox.remote!, { 'other.tex': 'x\n' }, 'landed mid-resolve');
            }
          },
        },
      );
      remoteBox.remote = remote;
      await files.applyEdits(dir, 'main.tex', [{ oldString: 'beta', newString: 'beta-local' }]);
      await git.commit(dir, { message: 'local edits line 2' });
      await pushCommit(
        remote,
        { 'main.tex': 'alpha\nbeta-remote\ngamma\n' },
        'remote edits line 2',
      );

      const conflict = await git.safePush(dir, remote.url, { username: 'git' });
      expect(conflict.status).toBe('conflict');
      const expectedRemoteHead = conflict.conflict!.remoteHead;

      const res = await git.resolvePush(
        dir,
        remote.url,
        { username: 'git' },
        {
          resolutions: [{ path: 'main.tex', content: 'alpha\nbeta-local-and-remote\ngamma\n' }],
          expectedRemoteHead,
        },
      );

      // The pin means "refuse rather than rebase over a second remote move": the beforePush hook
      // pushes a non-overlapping commit on attempt 1, and there is no attempt 2 — one round only.
      expect(res.status).toBe('remote-moved');
      expect(res.pushed).toBe(false);
      expect(calls).toBe(1);
      expect(await noRebaseInProgress(dir)).toBe(true);
      await expect(readFromRemote(remote, 'main.tex')).resolves.not.toContain(
        'beta-local-and-remote',
      );
    });
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

    it('resolves and pushes with an untracked file left on disk, untouched and unpushed', async () => {
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

      // An untracked build artifact nobody owns, present before we resolve.
      await writeFile(path.join(dir, 'main.pdf'), 'binary-stub', 'utf8');

      const res = await git.resolvePush(
        dir,
        remote.url,
        { username: 'git' },
        {
          resolutions: [{ path: 'main.tex', content: 'alpha\nbeta-local-and-remote\ngamma\n' }],
        },
      );

      expect(res.status).toBe('pushed');
      expect(await readFile(path.join(dir, 'main.pdf'), 'utf8')).toBe('binary-stub');
      await expect(readFromRemote(remote, 'main.pdf')).rejects.toThrow();
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
      // The landed-upstream commit names the file it touched.
      const landed = report.remoteCommits.find((c) => c.message === 'remote edits line 2');
      expect(landed?.files.map((f) => f.path)).toContain('main.tex');

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

      // Each reported commit also lists the file(s) it touched, with line counts.
      const ahead = status.aheadCommits.find((c) => c.message === 'my local commit');
      expect(ahead?.files).toEqual([{ path: 'main.tex', added: 1, removed: 1 }]);
      const behind = status.behindCommits.find((c) => c.message === 'their remote commit');
      expect(behind?.files).toEqual([{ path: 'main.tex', added: 1, removed: 1 }]);
    });
  });

  describe('reset to remote (conflict recovery)', () => {
    it('rewinds to the remote head after a conflict, then re-edit + push lands cleanly', async () => {
      const { remote, git, files, dir } = await setup({ 'main.tex': 'alpha\nbeta\ngamma\n' });
      await files.applyEdits(dir, 'main.tex', [{ oldString: 'beta', newString: 'beta-local' }]);
      await git.commit(dir, { message: 'local edits line 2' });
      await pushCommit(
        remote,
        { 'main.tex': 'alpha\nbeta-remote\ngamma\n' },
        'remote edits line 2',
      );

      // The push conflicts (same line touched on both sides).
      const conflict = await git.safePush(dir, remote.url, { username: 'git' });
      expect(conflict.status).toBe('conflict');

      // Rewind the clone to the current remote head instead of dropping to raw git. The tool resets
      // FileService baselines after this (the reset rewrote the tree); mirror that here.
      const reset = await git.resetToRemote(dir, remote.url, { username: 'git' });
      files.resetBaselines(dir);
      expect(reset.reset).toBe(true);
      expect(reset.hadUncommittedChanges).toBe(false);
      expect(reset.discardedCommits.map((c) => c.message)).toContain('local edits line 2');
      const remoteSha = (await simpleGit(dir).revparse(['origin/master'])).trim();
      expect(reset.remoteHead).toBe(remoteSha);

      // Clean working tree at exactly the remote head; the remote's content is what's on disk.
      expect(await headSha(dir)).toBe(remoteSha);
      expect((await git.status(dir)).clean).toBe(true);
      expect(await noRebaseInProgress(dir)).toBe(true);
      expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe(
        'alpha\nbeta-remote\ngamma\n',
      );

      // Re-apply the edit onto the fresh remote and push — no conflict this time.
      await files.applyEdits(dir, 'main.tex', [
        { oldString: 'beta-remote', newString: 'beta-merged' },
      ]);
      await git.commit(dir, { message: 'redo edit onto fresh remote' });
      const res = await git.safePush(dir, remote.url, { username: 'git' });
      expect(res.status).toBe('pushed');
      expect(await readFromRemote(remote, 'main.tex')).toBe('alpha\nbeta-merged\ngamma\n');
    });

    it('discards uncommitted changes too and reports them', async () => {
      const { remote, git, files, dir } = await setup({ 'main.tex': 'one\ntwo\n' });
      await pushCommit(remote, { 'main.tex': 'one\nTWO-remote\n' }, 'remote change');
      // A local edit that was never committed.
      await files.applyEdits(dir, 'main.tex', [{ oldString: 'two', newString: 'two-local' }]);

      const reset = await git.resetToRemote(dir, remote.url, { username: 'git' });
      expect(reset.hadUncommittedChanges).toBe(true);
      expect(reset.discardedCommits).toHaveLength(0);
      expect((await git.status(dir)).clean).toBe(true);
      expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('one\nTWO-remote\n');
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

    it('landBranch remote-moved recovers via a direct-mode safePush (base is already fast-forwarded)', async () => {
      const remoteBox: { remote?: FakeRemote } = {};
      let landed = false;
      const { remote, git, files, dir } = await setup(
        { 'main.tex': 'alpha\nbeta\ngamma\n' },
        {
          beforePush: async () => {
            // Fires once: landBranch always calls with attempt 1, and the later recovery
            // safePush must push cleanly with no further interference.
            if (landed) return;
            landed = true;
            await pushCommit(remoteBox.remote!, { 'other.tex': 'x\n' }, 'landed during land');
          },
        },
      );
      remoteBox.remote = remote;
      await files.applyEdits(dir, 'main.tex', [{ oldString: 'alpha', newString: 'ALPHA' }]);
      const prep = await git.prepareBranch(dir, { branch: 'review/w', message: 'edit line 1' });

      const res = await git.landBranch(
        dir,
        remote.url,
        { username: 'git' },
        { branch: 'review/w', base: prep.base },
      );

      expect(res.status).toBe('remote-moved');
      expect(res.summary).toContain('direct mode');
      // Local base was already fast-forwarded onto the feature branch tip before the push failed.
      expect((await git.status(dir)).branch).toBe(prep.base);
      expect((await simpleGit(dir).revparse(['review/w'])).trim()).toBe(
        (await simpleGit(dir).revparse([prep.base])).trim(),
      );

      // The prescribed recovery: run push in direct mode (plain safePush) to pull-rebase base
      // onto the new remote tip and push.
      const recovered = await git.safePush(dir, remote.url, { username: 'git' });

      expect(recovered.status).toBe('pushed');
      expect(await readFromRemote(remote, 'main.tex')).toBe('ALPHA\nbeta\ngamma\n');
      expect(await readFromRemote(remote, 'other.tex')).toBe('x\n');
    });
  });
});

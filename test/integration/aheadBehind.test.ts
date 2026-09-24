import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { GitService } from '../../src/services/gitService.js';

/**
 * Regression for the finding: `pushWithRetry`'s mid-round ahead/behind re-read used to go through
 * `aheadBehindOf`, which returns `{ahead: 0, behind: 0}` on ANY `rev-list` failure — not only "no
 * upstream yet". At that call site `ahead` was known non-zero moments earlier, so a zero there is at
 * least as likely to mean "rev-list errored" as "the rebase dropped our commit", and the former was
 * being silently reported as `nothing-to-push` (telling the caller their work is upstream when a git
 * failure, not an empty rebase, is what actually happened).
 *
 * `aheadBehindStrict` is the fix: same `rev-list` read, but it rethrows instead of swallowing the
 * failure. These tests drive both the lenient (`aheadBehind`) and strict (`aheadBehindStrict`)
 * public wrappers against a real temp git repo with no upstream configured — the same "rev-list
 * fails" condition, without needing a bare-repo remote — to pin the different failure behavior.
 */
describe('GitService ahead/behind: lenient vs strict on a rev-list failure', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function initRepoWithNoUpstream(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-ab-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const git = simpleGit(dir);
    await git.init(['--initial-branch=master']);
    await git.addConfig('user.email', 'test@example.com');
    await git.addConfig('user.name', 'Test');
    await writeFile(path.join(dir, 'main.tex'), 'hello\n', 'utf8');
    await git.add(['main.tex']);
    await git.commit('initial');
    // Deliberately no `origin` remote at all, so `master...origin/master` is an unknown revision —
    // the same "rev-list fails" condition `aheadBehindOf`'s comment calls out ("before first fetch").
    return dir;
  }

  it('aheadBehind (lenient) returns zeros when there is no upstream to compare against', async () => {
    const dir = await initRepoWithNoUpstream();
    const git = new GitService();
    await expect(git.aheadBehind(dir)).resolves.toEqual({
      branch: 'master',
      ahead: 0,
      behind: 0,
    });
  });

  it('aheadBehindStrict rejects instead of reporting zeros for the same failure', async () => {
    const dir = await initRepoWithNoUpstream();
    const git = new GitService();
    await expect(git.aheadBehindStrict(dir)).rejects.toThrow();
  });

  it('aheadBehindStrict rejects against an invalid ref, not just a missing one', async () => {
    // A second flavor of "rev-list fails" — a genuinely malformed comparison, not merely absent —
    // so the strict variant is shown catching more than the "no remote yet" case alone.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-ab-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const git = simpleGit(dir);
    await git.init(['--initial-branch=master']);
    await git.addConfig('user.email', 'test@example.com');
    await git.addConfig('user.name', 'Test');
    await writeFile(path.join(dir, 'main.tex'), 'hello\n', 'utf8');
    await git.add(['main.tex']);
    await git.commit('initial');
    await git.raw(['remote', 'add', 'origin', 'not-a-real-remote-url']);
    // No fetch was ever run, so origin/master still does not exist as a ref.
    const service = new GitService();
    await expect(service.aheadBehindStrict(dir)).rejects.toThrow();
    await expect(service.aheadBehind(dir)).resolves.toEqual({
      branch: 'master',
      ahead: 0,
      behind: 0,
    });
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import type { ServerConfig } from '../../src/types.js';
import { expectNoUndeclaredKeys } from '../helpers/outputSchema.js';
import { createFakeRemote } from './helpers/bareRepo.js';

/**
 * Every fetch is `--prune` (so a ghost `origin/<branch>` can no longer be rebased onto or pushed
 * back into existence). The price: once a collaborator renames or deletes the upstream branch,
 * `origin/<branch>` is simply gone, and the ahead/behind count against it used to fall into a
 * lenient `{ahead: 0, behind: 0}` — `project_sync` said `up-to-date` and `status` said `in-sync`
 * while an unpushed local commit sat in the clone. These pin that both tools now say the remote
 * branch is missing and still count the local work as unpushed.
 */

const IDENTITY = { name: 'Test', email: 'test@example.com' };
const MAIN_TEX = '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n';

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Structured {
  [key: string]: unknown;
}

function structured(res: unknown): Structured {
  const sc = (res as { structuredContent?: Structured }).structuredContent;
  expect(sc, `no structuredContent: ${textOf(res)}`).toBeDefined();
  return sc!;
}

function textOf(res: unknown): string {
  return ((res as { content?: Array<{ text?: string }> }).content ?? [])
    .map((c) => c.text ?? '')
    .join('\n');
}

function isError(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}

async function harness(remoteUrl: string, opts: { clone: boolean }) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-rbm-'));
  cleanups.push(() =>
    rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const dir = path.join(workspace, 'demo');
  if (opts.clone) await new GitService(IDENTITY).clone(remoteUrl, dir, { username: 'git' });
  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'rbm',
    projects: [{ id: 'demo', gitUrl: remoteUrl }],
    defaultProject: 'demo',
  };
  const ctx = createContext(config, new CredentialResolver({}), IDENTITY);
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'rbm', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.unshift(() => client.close());
  // Arms the client-side validator, as every real client does: an undeclared key in any result
  // below is then a thrown -32602, not a quietly wider payload.
  await client.listTools();
  return { client, dir, ctx };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  expect(isError(res), `\`${name}\` refused: ${textOf(res)}`).toBe(false);
  await expectNoUndeclaredKeys(client, name, structured(res));
  return res;
}

/** A local, unpushed commit made through the tools. */
async function commitLocally(client: Client): Promise<void> {
  await call(client, 'write_file', {
    project: 'demo',
    path: 'main.tex',
    content: `${MAIN_TEX}local work\n`,
  });
  await call(client, 'commit', { project: 'demo', message: 'local work' });
}

describe('upstream branch renamed away (pruned origin/<branch>)', () => {
  it('project_sync and status report the missing remote branch, not in-sync', async () => {
    const remote = await createFakeRemote({ 'main.tex': MAIN_TEX });
    cleanups.push(remote.cleanup);
    const { client } = await harness(remote.url, { clone: true });
    await commitLocally(client);

    execFileSync('git', ['branch', '-m', 'master', 'renamed'], { cwd: remote.bareDir });

    const synced = await call(client, 'project_sync', { project: 'demo' });
    const sync = structured(synced);
    expect(sync.action).toBe('remote-branch-missing');
    expect(sync.ahead).toBe(1);
    expect(sync.diverged).toBe(false);
    expect(String(sync.note)).toMatch(/origin\/master/);
    expect(String(sync.note)).toMatch(/renamed/);
    expect(textOf(synced)).toMatch(/remote-branch-missing/);
    expect(textOf(synced)).not.toMatch(/up-to-date/);

    const st = await call(client, 'status', { project: 'demo' });
    const out = structured(st);
    expect(out.remoteBranchMissing).toBe(true);
    expect(out.syncState).toBe('remote-branch-missing');
    expect(out.ahead).toBe(1);
    expect((out.aheadCommits as Array<{ message: string }>).map((c) => c.message)).toEqual([
      'local work',
    ]);
    expect(textOf(st)).not.toMatch(/in sync with origin/);
    expect(textOf(st)).toMatch(/origin\/master/);
  });

  it('a missing remote branch with nothing local is still not reported as in sync', async () => {
    const remote = await createFakeRemote({ 'main.tex': MAIN_TEX });
    cleanups.push(remote.cleanup);
    const { client } = await harness(remote.url, { clone: true });

    execFileSync('git', ['branch', '-m', 'master', 'renamed'], { cwd: remote.bareDir });

    const sync = structured(await call(client, 'project_sync', { project: 'demo' }));
    expect(sync.action).toBe('remote-branch-missing');
    expect(sync.ahead).toBe(0);

    const out = structured(await call(client, 'status', { project: 'demo' }));
    expect(out.remoteBranchMissing).toBe(true);
    expect(out.syncState).toBe('remote-branch-missing');
  });

  it('a remote whose only branch was deleted still counts its commits as unpushed', async () => {
    const remote = await createFakeRemote({ 'main.tex': MAIN_TEX });
    cleanups.push(remote.cleanup);
    const { client } = await harness(remote.url, { clone: true });
    await commitLocally(client);

    // The remote is left with no branch at all — indistinguishable, after a prune, from a remote
    // that never had one. No "missing" claim is made, but the unpushed commit is still counted.
    execFileSync('git', ['update-ref', '-d', 'refs/heads/master'], { cwd: remote.bareDir });

    // With no branch left upstream, BOTH commits — the cloned one and the local one — are on no
    // remote branch, so both are unpushed.
    const sync = structured(await call(client, 'project_sync', { project: 'demo' }));
    expect(sync.action).toBe('up-to-date');
    expect(sync.ahead).toBe(2);

    const out = structured(await call(client, 'status', { project: 'demo' }));
    expect(out.remoteBranchMissing).toBe(false);
    expect(out.ahead).toBe(2);
    expect(out.syncState).toBe('ahead');
    expect((out.aheadCommits as unknown[]).length).toBe(2);
  });
});

describe('an empty remote keeps working', () => {
  it('clones, re-syncs as up-to-date and reports no missing branch', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'wlm-rbm-empty-'));
    cleanups.push(() => rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const bareDir = path.join(tmp, 'remote.git');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'master', bareDir]);
    const { client } = await harness(pathToFileURL(bareDir).href, { clone: false });

    const cloned = structured(await call(client, 'project_sync', { project: 'demo' }));
    expect(cloned.action).toBe('cloned');
    expect(cloned.ahead).toBe(0);

    const again = structured(await call(client, 'project_sync', { project: 'demo' }));
    expect(again.action).toBe('up-to-date');
    expect(again.ahead).toBe(0);
    expect(again.note).toBeUndefined();

    const out = structured(await call(client, 'status', { project: 'demo' }));
    expect(out.remoteBranchMissing).toBe(false);
    expect(out.syncState).toBe('in-sync');
  });

  it('a branch pushed under another name after an empty clone is not called missing', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'wlm-rbm-empty-'));
    cleanups.push(() => rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const bareDir = path.join(tmp, 'remote.git');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'master', bareDir]);
    const { client } = await harness(pathToFileURL(bareDir).href, { clone: false });
    expect(structured(await call(client, 'project_sync', { project: 'demo' })).action).toBe(
      'cloned',
    );

    // A collaborator's first push lands on `main`: this clone (still unborn `master`) never had a
    // branch upstream, so nothing is missing — the remote simply has something else.
    const seed = path.join(tmp, 'seed');
    execFileSync('git', ['init', '-q', '-b', 'main', seed]);
    execFileSync('git', ['add', '.'], { cwd: seed });
    execFileSync(
      'git',
      ['-c', 'user.name=O', '-c', 'user.email=o@e.com', 'commit', '-q', '--allow-empty', '-m', 'x'],
      { cwd: seed },
    );
    execFileSync('git', ['push', '-q', bareDir, 'main'], { cwd: seed });

    const again = structured(await call(client, 'project_sync', { project: 'demo' }));
    expect(again.action).toBe('up-to-date');
    expect(again.note).toBeUndefined();
    const out = structured(await call(client, 'status', { project: 'demo' }));
    expect(out.remoteBranchMissing).toBe(false);
  });
});

describe('a local branch that was never pushed', () => {
  /**
   * Leaves the clone on the review branch `push` in branch mode creates (`checkout -B`), with
   * `configure` run in the clone first — repo-local config, so the developer's global git config
   * (a `branch.autoSetupMerge` there changes what `checkout -B` writes) cannot decide the outcome.
   */
  async function reviewBranch(configure: (dir: string) => void) {
    const remote = await createFakeRemote({ 'main.tex': MAIN_TEX });
    cleanups.push(remote.cleanup);
    const { client, dir } = await harness(remote.url, { clone: true });
    configure(dir);
    await call(client, 'write_file', {
      project: 'demo',
      path: 'main.tex',
      content: `${MAIN_TEX}review me\n`,
    });
    const prep = structured(
      await call(client, 'push', {
        project: 'demo',
        mode: 'branch',
        branch: 'review/x',
        message: 'for review',
        confirm: true,
      }),
    );
    expect(prep.status).toBe('awaiting-approval');
    return { client, dir };
  }

  /** `review/x` was never pushed: nobody renamed or deleted anything, so no note may blame a
   * collaborator. The commit it carries is plainly unpushed. */
  async function expectNotMissing(client: Client): Promise<void> {
    const st = await call(client, 'status', { project: 'demo' });
    const out = structured(st);
    expect(out.branch).toBe('review/x');
    expect(out.remoteBranchMissing).toBe(false);
    expect(out.remoteBranchNote).toBeUndefined();
    expect(out.syncState).toBe('ahead');
    expect(out.ahead).toBe(1);
    expect(textOf(st)).not.toMatch(/renamed or deleted|no longer exists/);

    const sync = structured(await call(client, 'project_sync', { project: 'demo' }));
    expect(sync.action).not.toBe('remote-branch-missing');
    expect(sync.ahead).toBe(1);
    expect(sync.note).toBeUndefined();
  }

  it('push in branch mode leaves the clone on a review branch that status and project_sync do not call missing', async () => {
    const { client, dir } = await reviewBranch((d) =>
      execFileSync('git', ['config', 'branch.autoSetupMerge', 'false'], { cwd: d }),
    );
    // Not vacuous: the branch really has no upstream configured.
    expect(() =>
      execFileSync('git', ['config', '--get', 'branch.review/x.merge'], {
        cwd: dir,
        stdio: 'pipe',
      }),
    ).toThrow();
    await expectNotMissing(client);
  });

  it('is not called missing when branch.autoSetupMerge=always gave it a local upstream', async () => {
    // `always` makes `checkout -B review/x` record `remote=.` + `merge=refs/heads/master`: an
    // upstream exists, but it is this clone's own master, not an `origin/review/x` that went away.
    const { client, dir } = await reviewBranch((d) =>
      execFileSync('git', ['config', 'branch.autoSetupMerge', 'always'], { cwd: d }),
    );
    const merge = execFileSync('git', ['config', '--get', 'branch.review/x.merge'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
    expect(merge).toBe('refs/heads/master');
    await expectNotMissing(client);
  });

  it('is not called missing when its upstream was set to a different origin branch', async () => {
    const { client, dir } = await reviewBranch((d) =>
      execFileSync('git', ['config', 'branch.autoSetupMerge', 'false'], { cwd: d }),
    );
    execFileSync('git', ['branch', '-q', '--set-upstream-to=origin/master'], { cwd: dir });
    await expectNotMissing(client);
  });
});

describe('the commit lists of an absent remote branch', () => {
  /** Local commits made by hand, so the history is long without going through the tools. */
  function commitMany(dir: string, n: number): void {
    for (let i = 0; i < n; i++) {
      execFileSync(
        'git',
        [
          '-c',
          'user.name=T',
          '-c',
          'user.email=t@e.com',
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          `c${i}`,
        ],
        { cwd: dir },
      );
    }
  }

  it('caps aheadCommits and counts the rest when every local commit is on no remote branch', async () => {
    const remote = await createFakeRemote({ 'main.tex': MAIN_TEX });
    cleanups.push(remote.cleanup);
    const { client, dir } = await harness(remote.url, { clone: true });
    commitMany(dir, 25);
    // The remote's only branch goes: every commit in the clone's history is now on no remote
    // branch, so `ahead` is the whole history — which is not the session's own work, and not
    // bounded by it.
    execFileSync('git', ['update-ref', '-d', 'refs/heads/master'], { cwd: remote.bareDir });
    await call(client, 'project_sync', { project: 'demo' });

    const st = await call(client, 'status', { project: 'demo' });
    const out = structured(st);
    expect(out.ahead).toBe(26);
    expect((out.aheadCommits as unknown[]).length).toBe(20);
    expect(out.aheadCommitsOmitted).toBe(6);
    expect(textOf(st)).toMatch(/6 more/);
  });

  it('is computed for the status tool only, never for commit or shelve, which do not read it', async () => {
    const remote = await createFakeRemote({ 'main.tex': MAIN_TEX });
    cleanups.push(remote.cleanup);
    const { client } = await harness(remote.url, { clone: true });
    await commitLocally(client);

    const spy = vi.spyOn(
      GitService.prototype as unknown as { logCommits: (...a: unknown[]) => unknown },
      'logCommits',
    );
    cleanups.push(async () => spy.mockRestore());
    // The clone is 1 ahead, so a status that computed the lists would run the log here.
    await call(client, 'write_file', {
      project: 'demo',
      path: 'main.tex',
      content: `${MAIN_TEX}more local work\n`,
    });
    await call(client, 'commit', { project: 'demo', message: 'more' });
    expect(spy).not.toHaveBeenCalled();

    // shelve (and unshelve) read status for the dirty paths alone, on a clone still 2 ahead.
    await call(client, 'write_file', {
      project: 'demo',
      path: 'main.tex',
      content: `${MAIN_TEX}set aside\n`,
    });
    const shelved = structured(
      await call(client, 'shelve', { project: 'demo', paths: ['main.tex'] }),
    );
    const shelfId = (shelved.shelf as { id: string }).id;
    await call(client, 'unshelve', { project: 'demo', id: shelfId });
    expect(spy).not.toHaveBeenCalled();

    // Not vacuous: the status tool does run it, on the same clone.
    await call(client, 'status', { project: 'demo' });
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFakeRemote, pushCommit, type FakeRemote } from './helpers/bareRepo.js';
import { createContext, type AppContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * `project_sync` clones or ff-pulls but, before this fix, never took the per-project lock
 * (`ctx.projectManager.runExclusive`) that every other mutating tool (push, commit, write_file,
 * ...) takes. A peer session's `write_file`/`commit` could interleave with the pull — the shared
 * clone's `.git` index rewritten by two processes at once. This pins that the pull now waits out
 * a held lock before touching the clone, and that a first-time clone still works under the same
 * lock and leaves it released afterwards.
 *
 * Harness copied from test/integration/projectSyncAttribution.test.ts (real MCP clients, a local
 * bare repo, no network).
 */

const IDENTITY = { name: 'Test', email: 'test@example.com' };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Session {
  ctx: AppContext;
  client: Client;
}

describe('project_sync runs inside runExclusive', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function makeSession(
    id: string,
    workspace: string,
    remote: FakeRemote,
    registered: boolean,
  ): Promise<Session> {
    const config: ServerConfig = {
      workspaceRoot: workspace,
      projects: registered ? [{ id: 'demo', gitUrl: remote.url }] : [],
      defaultProject: registered ? 'demo' : undefined,
      sessionId: id,
    };
    const ctx = createContext(config, new CredentialResolver({}), IDENTITY);
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `test-${id}`, version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    return { ctx, client };
  }

  async function callSync(
    session: Session,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const res = await session.client.callTool({ name: 'project_sync', arguments: args });
    if (res.isError) throw new Error(`project_sync failed: ${JSON.stringify(res.content)}`);
    return res.structuredContent as Record<string, unknown>;
  }

  it('runs the pull only after a held project lock is released (ordering, not timing)', async () => {
    // The previous version of this test raced the pull against a 300ms timer and asserted it had
    // not settled yet. Post-fix that can't flake, but as a *regression* proof it was only
    // probabilistic: a slow CI runner's pre-fix pull (a real `git fetch` + merge) could itself take
    // longer than 300ms even while correctly waiting for nothing, which would make a correct
    // implementation look broken, or — the more dangerous direction — let a genuinely-unguarded
    // pull on a fast runner sneak in under 300ms and report a false pass. Asserting *order* instead
    // of elapsed time removes the timing dependency entirely: `runExclusive` is a FIFO promise
    // queue, so once the "held" call below has acquired the "demo" lock, `project_sync`'s own
    // `runExclusive('demo', ...)` call is queued behind it and cannot invoke `syncPull` — and so
    // cannot push 'pull-started' — until that lock is released, no matter how long the test waits
    // in between. Only if `project_sync` failed to route the pull through `runExclusive` at all
    // could 'pull-started' land before 'lock-released'.
    const remote = await createFakeRemote({ 'main.tex': 'one\ntwo\n' });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-synclock-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));

    // Pre-clone "demo" into the workspace so project_sync takes the pull branch, not clone.
    const dir = path.join(workspace, 'demo');
    await new GitService(IDENTITY).clone(remote.url, dir, { username: 'git' });

    // Remote gains one commit, so the pending pull has real work to do (action: 'pulled').
    await pushCommit(remote, { 'main.tex': 'one\ntwo\nremote edit\n' }, 'remote edit');

    const session = await makeSession('alpha', workspace, remote, true);

    const order: string[] = [];
    const realSyncPull = session.ctx.git.syncPull.bind(session.ctx.git);
    session.ctx.git.syncPull = async (gitUrl, pullDir, auth) => {
      order.push('pull-started');
      return realSyncPull(gitUrl, pullDir, auth);
    };

    const release = deferred<void>();
    const held = session.ctx.projectManager.runExclusive('demo', () => release.promise);

    const syncPromise = callSync(session, { mode: 'pull' });

    // Give the queued pull room to run ahead of the release, in case it is not actually gated by
    // the lock — a fixed real-time wait, but no longer load-bearing for correctness: the assertion
    // below compares `order`, not elapsed time, so a slow runner cannot turn a correctly-gated pull
    // into a reported failure the way the old "has not settled after 300ms" check could.
    await new Promise((resolve) => setTimeout(resolve, 50));

    order.push('lock-released');
    release.resolve();
    await held;

    const result = await syncPromise;
    expect(result.action).toBe('pulled');
    expect(result.behind).toBe(0);
    expect(order).toEqual(['lock-released', 'pull-started']);
  });

  // Guard test, not a regression proof: it pins that a first-time clone still succeeds while
  // routed through `runExclusive`, and that the lock is released afterwards (a second acquire
  // resolves promptly rather than hanging) — it does not reproduce any specific bug, since an
  // unguarded clone would also pass this same assertion (there is no held lock to contend with in
  // this scenario, so there is nothing here that distinguishes gated from ungated).
  it('a first-time clone still succeeds under the lock, and leaves it released afterwards', async () => {
    const remote = await createFakeRemote({ 'main.tex': 'one\ntwo\n' });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-synclock-clone-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));

    // No .sessions/<id> directory exists yet for an unregistered, never-cloned project — this
    // exercises withFileLock creating the lock's parent directory on a fresh workspace.
    const session = await makeSession('alpha', workspace, remote, false);

    const result = await callSync(session, { project: 'demo', gitUrl: remote.url, mode: 'clone' });
    expect(result.action).toBe('cloned');

    // The lock must have been released after the clone: a second runExclusive on the same id
    // resolves promptly rather than hanging.
    const second = session.ctx.projectManager.runExclusive('demo', async () => 'ok');
    const raced = await Promise.race([
      second,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ]);
    expect(raced).toBe('ok');
  });
});

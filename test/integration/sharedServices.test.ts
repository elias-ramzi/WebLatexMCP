import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { simpleGit } from 'simple-git';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import {
  createSessionContext,
  createSharedServices,
  type SessionScope,
  type SharedServices,
} from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { sessionDir } from '../../src/lib/sessionPaths.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * Several session scopes over ONE set of shared services, as a daemon will run them
 * (docs/design/shared-server.md §5.1, §6, milestone 2). The multi-session suites build one
 * context per session — one process each, in effect; these share the lock table, the registry,
 * git and the viewer, and must keep every guarantee those suites pin.
 */

const REL = 'main.tex';
const BASE = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Alpha.',
  '',
  'Beta.',
  '\\end{document}',
  '',
].join('\n');
const IDENTITY = { name: 'Test', email: 'test@example.com' };

interface Session {
  client: Client;
  scope: SessionScope;
}

describe('session scopes sharing one set of services', () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function setup(): Promise<{
    remote: FakeRemote;
    workspace: string;
    dir: string;
    shared: SharedServices;
    session: (id: string) => Promise<Session>;
  }> {
    const remote = await createFakeRemote({ [REL]: BASE });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-shared-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));
    const dir = path.join(workspace, 'demo');
    await new GitService(IDENTITY).clone(remote.url, dir, { username: 'git' });

    const config: ServerConfig = {
      workspaceRoot: workspace,
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
      sessionId: 'process',
    };
    const shared = createSharedServices(
      config,
      new CredentialResolver({}),
      IDENTITY,
      new ProjectRegistry(workspace),
    );
    const session = async (id: string): Promise<Session> => {
      const scope = createSessionContext(shared, { sessionId: id });
      const server = createServer(scope.ctx);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: `test-${id}`, version: '0.0.0' });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      cleanups.push(
        () => client.close(),
        () => scope.close(),
      );
      return { client, scope };
    };
    return { remote, workspace, dir, shared, session };
  }

  async function call<T = Record<string, unknown>>(
    s: Session,
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const res = await s.client.callTool({ name, arguments: args });
    if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.content)}`);
    return res.structuredContent as T;
  }

  async function callError(
    s: Session,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const res = await s.client.callTool({ name, arguments: args });
    expect(res.isError, `${name} was expected to fail`).toBe(true);
    return JSON.stringify(res.content);
  }

  it("refuses A's write over B's edit: revision baselines are each session's own", async () => {
    const { session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');

    await call(a, 'read_file', { path: REL });
    await call(b, 'read_file', { path: REL });
    await call(b, 'write_file', { path: REL, content: BASE.replace('Beta.', 'Beta, by B.') });

    // With one FileService for both, B's write would have moved the baseline A relies on and this
    // write would silently drop B's edit.
    const refusal = await callError(a, 'write_file', {
      path: REL,
      content: BASE.replace('Alpha.', 'Alpha, by A.'),
    });
    expect(refusal).toContain('changed on disk since it was last read through this server');
  });

  it('commits each session its own lines, and a closed scope stops being a peer', async () => {
    const { session, workspace, dir } = await setup();
    const a = await session('alpha');
    const b = await session('beta');
    await call(a, 'edit_file', {
      path: REL,
      edits: [{ oldString: 'Alpha.', newString: 'Alpha, by A.' }],
    });
    await call(b, 'edit_file', {
      path: REL,
      edits: [{ oldString: 'Beta.', newString: 'Beta, by B.' }],
    });

    await call(a, 'commit', { message: 'A only', scope: 'session' });
    const committed = await simpleGit(dir).show(['HEAD:main.tex']);
    expect(committed).toContain('Alpha, by A.');
    expect(committed).not.toContain('Beta, by B.');

    // B's record is there while its scope is open, and gone once it closes.
    const record = path.join(sessionDir(workspace, 'demo', 'beta'), 'session.json');
    await expect(access(record)).resolves.toBeUndefined();
    await b.scope.close();
    await expect(access(record)).rejects.toThrow();
  });

  it('keeps a session-only registration to the session that made it', async () => {
    const { session, remote } = await setup();
    const a = await session('alpha');
    const b = await session('beta');

    await call(a, 'project_sync', { project: 'side', gitUrl: remote.url });
    const listedByA = await call<{ projects: Array<{ project: string }> }>(a, 'list_projects', {});
    expect(listedByA.projects.map((p) => p.project)).toContain('side');

    const listedByB = await call<{ projects: Array<{ project: string }> }>(b, 'list_projects', {});
    expect(listedByB.projects.map((p) => p.project)).not.toContain('side');
    expect(await callError(b, 'status', { project: 'side' })).toMatch(/Unknown project/);
  });

  it('serializes two scopes on one project through the shared mutex, naming the holder', async () => {
    const { session, shared } = await setup();
    const a = await session('alpha');
    const b = await session('beta');

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let aEntered!: () => void;
    const entered = new Promise<void>((r) => (aEntered = r));
    const order: string[] = [];

    const first = a.scope.ctx.projectManager.runExclusive('demo', async () => {
      order.push('a:start');
      aEntered();
      await held;
      order.push('a:end');
    });
    await entered;
    // A holds the process's one mutex for the project — the table every scope's manager queues on.
    expect(shared.locks.entry('demo').mutex.isLocked()).toBe(true);
    const second = b.scope.ctx.projectManager.runExclusive('demo', async (lock) => {
      order.push('b:start');
      return lock;
    });
    await new Promise((r) => setTimeout(r, 120));
    release();
    const [, lock] = await Promise.all([first, second]);

    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
    expect(lock.waitedOn).toBe('alpha');
  });

  it('shares the viewer, comments and other process-wide services across scopes', async () => {
    const { session, shared } = await setup();
    const a = await session('alpha');
    const b = await session('beta');
    for (const key of [
      'viewer',
      'comments',
      'git',
      'compiler',
      'references',
      'rewriteModes',
    ] as const) {
      expect(a.scope.ctx[key]).toBe(shared[key]);
      expect(b.scope.ctx[key]).toBe(shared[key]);
    }
    expect(a.scope.ctx.files).not.toBe(b.scope.ctx.files);
    expect(a.scope.ctx.projectManager).not.toBe(b.scope.ctx.projectManager);
    expect(a.scope.ctx.config.sessionId).toBe('alpha');
    expect(shared.config.sessionId).toBe('process');
  });

  it('refuses a session id that would not be a safe, unreserved directory name', async () => {
    const { shared } = await setup();
    for (const bad of ['', '  ', '../up', 'a b', 'shelves', 'Project.Lock']) {
      expect(() => createSessionContext(shared, { sessionId: bad }), bad).toThrow();
    }
    expect(() => createSessionContext(shared, { sessionId: 'agent-2.b_c' })).not.toThrow();
  });

  it('re-creates the record when a write lands after the scope closed, and a second close retracts it', async () => {
    const { session, workspace } = await setup();
    const a = await session('alpha');
    const record = path.join(sessionDir(workspace, 'demo', 'alpha'), 'session.json');
    await call(a, 'edit_file', { path: REL, edits: [{ oldString: 'Alpha.', newString: 'A1.' }] });
    await a.scope.close();
    await expect(access(record)).rejects.toThrow();

    // Within the heartbeat throttle: without the reset on release, this write would leave no record.
    await call(a, 'edit_file', { path: REL, edits: [{ oldString: 'A1.', newString: 'A2.' }] });
    await expect(access(record)).resolves.toBeUndefined();
    await a.scope.close();
    await expect(access(record)).rejects.toThrow();
  });
});

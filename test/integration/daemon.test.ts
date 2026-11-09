import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { access, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { simpleGit } from 'simple-git';
import { createFakeRemote } from './helpers/bareRepo.js';
import {
  DaemonAlreadyRunningError,
  startDaemon,
  type DaemonOptions,
  type RunningDaemon,
} from '../../src/daemon/daemon.js';
import { daemonInfoPath, readDaemonInfo } from '../../src/daemon/daemonFiles.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { projectLockPath, sessionDir } from '../../src/lib/sessionPaths.js';
import { withFileLock } from '../../src/lib/fileLock.js';
import { isScopeOpen } from '../../src/lib/openScopes.js';
import { readFile } from 'node:fs/promises';
import type { ServerConfig } from '../../src/types.js';

/**
 * The daemon end to end (docs/design/shared-server.md §12, milestone 4): real MCP clients over
 * Streamable HTTP to one in-process daemon, real git against a local bare repo. No network.
 */

const REL = 'main.tex';
const BASE = '\\documentclass{article}\n\\begin{document}\nAlpha.\n\nBeta.\n\\end{document}\n';
const IDENTITY = { name: 'Test', email: 'test@example.com' };

interface Conn {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

describe('the daemon', () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
  });

  async function setup(extra: Partial<DaemonOptions> = {}): Promise<{
    daemon: RunningDaemon;
    workspace: string;
    dir: string;
    connect: (headers?: Record<string, string>) => Promise<Conn>;
  }> {
    const remote = await createFakeRemote({ [REL]: BASE });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-daemon-it-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));
    const dir = path.join(workspace, 'demo');
    await new GitService(IDENTITY).clone(remote.url, dir, { username: 'git' });
    const config: ServerConfig = {
      workspaceRoot: workspace,
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
      sessionId: 'daemon',
      surfacePdf: true,
    };
    const daemon = await startDaemon({
      config,
      env: {},
      credentials: new CredentialResolver({}),
      identity: IDENTITY,
      registry: new ProjectRegistry(workspace),
      log: () => {},
      ...extra,
    });
    cleanups.push(() => daemon.stop('test over'));
    const connect = async (headers: Record<string, string> = {}): Promise<Conn> => {
      const transport = new StreamableHTTPClientTransport(new URL(daemon.url), {
        requestInit: { headers: { authorization: `Bearer ${daemon.token}`, ...headers } },
      });
      const client = new Client({ name: 'test', version: '0.0.0' });
      await client.connect(transport);
      cleanups.push(() => client.close());
      return { client, transport };
    };
    return { daemon, workspace, dir, connect };
  }

  async function call<T = Record<string, unknown>>(
    c: Conn,
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const res = await c.client.callTool({ name, arguments: args });
    if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.content)}`);
    return res.structuredContent as T;
  }

  async function callError(c: Conn, name: string, args: Record<string, unknown>): Promise<string> {
    const res = await c.client.callTool({ name, arguments: args });
    expect(res.isError, `${name} was expected to fail`).toBe(true);
    return JSON.stringify(res.content);
  }

  /** A raw request, to set headers the SDK client would not. */
  function raw(
    port: number,
    opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: opts.method ?? 'GET',
          path: opts.path ?? '/health',
          headers: opts.headers,
        },
        (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end(opts.body);
    });
  }

  const INIT = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'raw', version: '0' },
    },
  });
  const initHeaders = (daemon: RunningDaemon): Record<string, string> => ({
    authorization: `Bearer ${daemon.token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  });

  it('publishes itself in daemon.json and guards every request, /health included', async () => {
    const { daemon, workspace } = await setup();
    const info = await readDaemonInfo(workspace);
    expect(info).toMatchObject({ port: daemon.port, token: daemon.token, pid: process.pid });

    const auth = { authorization: `Bearer ${daemon.token}` };
    expect((await raw(daemon.port, { headers: auth })).status).toBe(200);
    expect((await raw(daemon.port, {})).status).toBe(401);
    expect(
      (await raw(daemon.port, { headers: { authorization: `Bearer ${daemon.token}x` } })).status,
    ).toBe(401);
    expect(
      (await raw(daemon.port, { headers: { ...auth, origin: 'http://example.com' } })).status,
    ).toBe(403);
    expect(
      (await raw(daemon.port, { headers: { ...auth, host: `localhost:${daemon.port + 1}` } }))
        .status,
    ).toBe(421);
    expect((await raw(daemon.port, { headers: { ...auth, host: 'rebind.example' } })).status).toBe(
      421,
    );
  });

  it("refuses A's write over B's edit: each HTTP session keeps its own baselines", async () => {
    const { connect } = await setup();
    const a = await connect({ 'x-web-latex-mcp-session': 'alpha' });
    const b = await connect({ 'x-web-latex-mcp-session': 'beta' });
    await call(a, 'read_file', { path: REL });
    await call(b, 'read_file', { path: REL });
    await call(b, 'write_file', { path: REL, content: BASE.replace('Beta.', 'B.') });
    expect(
      await callError(a, 'write_file', { path: REL, content: BASE.replace('Alpha.', 'A.') }),
    ).toContain('changed on disk since it was last read through this server');
  });

  it('commits each session its own lines, and two sessions editing at once both land', async () => {
    const { connect, dir } = await setup();
    const a = await connect({ 'x-web-latex-mcp-session': 'alpha' });
    const b = await connect({ 'x-web-latex-mcp-session': 'beta' });
    await Promise.all([
      call(a, 'edit_file', {
        path: REL,
        edits: [{ oldString: 'Alpha.', newString: 'Alpha, by A.' }],
      }),
      call(b, 'edit_file', {
        path: REL,
        edits: [{ oldString: 'Beta.', newString: 'Beta, by B.' }],
      }),
    ]);
    await call(a, 'commit', { message: 'A only', scope: 'session' });
    const committed = await simpleGit(dir).show(['HEAD:main.tex']);
    expect(committed).toContain('Alpha, by A.');
    expect(committed).not.toContain('Beta, by B.');
  });

  it('gives a second session asking for an open id a suffixed one, and says so', async () => {
    const { connect } = await setup();
    await connect({ 'x-web-latex-mcp-session': 'beta' });
    const second = await connect({ 'x-web-latex-mcp-session': 'beta' });
    const info = await call<{ mode: string; sessionId: string; sessionIdRequested?: string }>(
      second,
      'server_info',
      {},
    );
    expect(info).toMatchObject({ mode: 'daemon', sessionId: 'beta-2', sessionIdRequested: 'beta' });
  });

  it('refuses an initialize with an unusable session header, saying why', async () => {
    const { daemon } = await setup();
    const res = await raw(daemon.port, {
      method: 'POST',
      path: '/mcp',
      headers: { ...initHeaders(daemon), 'x-web-latex-mcp-session': 'shelves' },
      body: INIT,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatch(/reserved/);
  });

  it('suffixes an id differing only in case: on macOS and Windows both name one directory', async () => {
    const { connect } = await setup();
    await connect({ 'x-web-latex-mcp-session': 'Alice' });
    const second = await connect({ 'x-web-latex-mcp-session': 'alice' });
    expect(await call(second, 'server_info', {})).toMatchObject({
      sessionId: 'alice-2',
      sessionIdRequested: 'alice',
    });
  });

  it('keeps a scope open after DELETE until its running write lands', async () => {
    const { connect, workspace, dir } = await setup();
    const a = await connect({ 'x-web-latex-mcp-session': 'alpha' });
    let release!: () => void;
    const holding = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const lockHeld = new Promise<void>((r) => (held = r));
    // Another holder of the project lock keeps alpha's edit waiting inside runExclusive.
    const holder = withFileLock(projectLockPath(workspace, 'demo'), async () => {
      held();
      await holding;
    });
    await lockHeld;
    const edit = a.client
      .callTool({
        name: 'edit_file',
        arguments: { path: REL, edits: [{ oldString: 'Alpha.', newString: 'Alpha, late.' }] },
      })
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 200));
    await a.transport.terminateSession().catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    expect(isScopeOpen(workspace, 'alpha')).toBe(true);

    release();
    await holder;
    await expect.poll(() => isScopeOpen(workspace, 'alpha'), { timeout: 5000 }).toBe(false);
    expect(await readFile(path.join(dir, REL), 'utf8')).toContain('Alpha, late.');
    // The call's answer never reaches the client: its session was deleted. Closing it rejects it.
    void edit;
  });

  it('closes a session whose call was cancelled once the call ends and the client is gone', async () => {
    const { connect, workspace, daemon } = await setup({ sessionIdleMs: 150 });
    const a = await connect({ 'x-web-latex-mcp-session': 'alpha' });
    let release!: () => void;
    const holding = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const lockHeld = new Promise<void>((r) => (held = r));
    const holder = withFileLock(projectLockPath(workspace, 'demo'), async () => {
      held();
      await holding;
    });
    await lockHeld;
    const abort = new AbortController();
    const edit = a.client
      .callTool(
        {
          name: 'edit_file',
          arguments: { path: REL, edits: [{ oldString: 'Alpha.', newString: 'A.' }] },
        },
        undefined,
        { signal: abort.signal },
      )
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 200));
    abort.abort();
    await edit;
    await a.transport.close();
    // Still writing: not idle, however long.
    await new Promise((r) => setTimeout(r, 400));
    expect(daemon.sessionIds()).toEqual(['alpha']);
    release();
    await holder;
    await expect.poll(() => daemon.sessionIds(), { timeout: 5000 }).toEqual([]);
  });

  it('frees the slot of an initialize the transport rejected', async () => {
    const { daemon, connect } = await setup({ maxSessions: 1 });
    const bad = await raw(daemon.port, {
      method: 'POST',
      path: '/mcp',
      headers: { ...initHeaders(daemon), accept: 'text/plain' },
      body: INIT,
    });
    expect(bad.status).toBe(406);
    const ok = await connect();
    expect(await call(ok, 'server_info', {})).toMatchObject({ mode: 'daemon' });
  });

  it('closes the scope on DELETE: its record goes, and it stops blocking a default commit', async () => {
    const { connect, workspace, daemon } = await setup();
    const a = await connect({ 'x-web-latex-mcp-session': 'alpha' });
    const b = await connect({ 'x-web-latex-mcp-session': 'beta' });
    await call(b, 'edit_file', {
      path: REL,
      edits: [{ oldString: 'Beta.', newString: 'Beta, by B.' }],
    });
    expect(await callError(a, 'commit', { message: 'all' })).toMatch(/beta/);

    const bTransportId = b.transport.sessionId;
    await b.transport.terminateSession();
    await expect.poll(() => daemon.sessionIds()).toEqual(['alpha']);
    const record = path.join(sessionDir(workspace, 'demo', 'beta'), 'session.json');
    await expect
      .poll(() =>
        access(record).then(
          () => 'present',
          () => 'gone',
        ),
      )
      .toBe('gone');
    expect((await call<{ committed: boolean }>(a, 'commit', { message: 'all' })).committed).toBe(
      true,
    );
    // The closed session's id no longer routes.
    const late = await raw(daemon.port, {
      method: 'POST',
      path: '/mcp',
      headers: {
        authorization: `Bearer ${daemon.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': bTransportId ?? '',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    });
    expect(late.status).toBe(404);
  });

  it('keeps a connected session open, and closes one whose client vanished once idle', async () => {
    // A long idle timeout: B goes because it dropped its stream, after the short grace.
    const { connect, daemon } = await setup({ sessionIdleMs: 60_000, streamLossMs: 150 });
    const a = await connect({ 'x-web-latex-mcp-session': 'alpha' });
    const b = await connect({ 'x-web-latex-mcp-session': 'beta' });
    await call(a, 'server_info', {});
    // B's client goes away without a DELETE (a crash): its event stream closes, nothing else.
    await b.transport.close();
    await expect.poll(() => daemon.sessionIds(), { timeout: 3000 }).toEqual(['alpha']);
    // A holds its event stream open, so it is never idle however long it stays quiet.
    await new Promise((r) => setTimeout(r, 400));
    expect(daemon.sessionIds()).toEqual(['alpha']);
  });

  it('exits once idle with no session, removing daemon.json, unless kept alive', async () => {
    const { daemon, workspace } = await setup({ idleExitMs: 100 });
    await daemon.stopped;
    await expect(access(daemonInfoPath(workspace))).rejects.toThrow();

    const kept = await setup({ idleExitMs: 100, keepAlive: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(await readDaemonInfo(kept.workspace)).toBeDefined();
  });

  it('refuses a second daemon on one workspace', async () => {
    const { workspace } = await setup();
    await expect(
      startDaemon({
        config: { workspaceRoot: workspace, projects: [], sessionId: 'x' },
        env: {},
        credentials: new CredentialResolver({}),
        identity: IDENTITY,
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
  });

  it('shuts down on request only when idle, or when forced', async () => {
    const { daemon, connect } = await setup();
    await connect();
    const auth = { authorization: `Bearer ${daemon.token}` };
    expect(
      (await raw(daemon.port, { method: 'POST', path: '/shutdown', headers: auth })).status,
    ).toBe(409);
    expect(
      (await raw(daemon.port, { method: 'POST', path: '/shutdown?force=1', headers: auth })).status,
    ).toBe(200);
    await daemon.stopped;
  });

  it('refuses a body over the cap', async () => {
    const { daemon } = await setup({ maxBodyBytes: 1000 });
    const res = await raw(daemon.port, {
      method: 'POST',
      path: '/mcp',
      headers: {
        authorization: `Bearer ${daemon.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { pad: 'x'.repeat(2000) },
      }),
    });
    expect(res.status).toBe(413);
  });

  it('reads the writing guide for each new session, so a new rule reaches the next one', async () => {
    const guideDir = await mkdtemp(path.join(os.tmpdir(), 'wlm-guide-'));
    cleanups.push(() => rm(guideDir, { recursive: true, force: true }));
    const guide = path.join(guideDir, 'extra.md');
    await writeFile(guide, '- Use British spelling.\n');
    const second = await setupWithGuide(guide);
    const first = await second.connect();
    expect(first.client.getInstructions()).toContain('British spelling');
    await appendFile(guide, '- Never use the passive voice.\n');
    const next = await second.connect();
    expect(next.client.getInstructions()).toContain('passive voice');
    expect(first.client.getInstructions()).not.toContain('passive voice');
  });

  async function setupWithGuide(guide: string): Promise<{ connect: () => Promise<Conn> }> {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-daemon-guide-'));
    cleanups.push(() => rm(workspace, { recursive: true, force: true }));
    const daemon = await startDaemon({
      config: {
        workspaceRoot: workspace,
        projects: [],
        sessionId: 'x',
        extraWritingGuidePath: guide,
      },
      env: {},
      credentials: new CredentialResolver({}),
      identity: IDENTITY,
      log: () => {},
    });
    cleanups.push(() => daemon.stop('test over'));
    return {
      connect: async () => {
        const transport = new StreamableHTTPClientTransport(new URL(daemon.url), {
          requestInit: { headers: { authorization: `Bearer ${daemon.token}` } },
        });
        const client = new Client({ name: 'test', version: '0.0.0' });
        await client.connect(transport);
        cleanups.push(() => client.close());
        return { client, transport };
      },
    };
  }
});

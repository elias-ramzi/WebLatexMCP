import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createFakeRemote } from './helpers/bareRepo.js';
import { startDaemon, type DaemonOptions, type RunningDaemon } from '../../src/daemon/daemon.js';
import { HEADER_CONNECTION, HEADER_SESSION } from '../../src/daemon/sessionHeaders.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { isScopeOpen } from '../../src/lib/openScopes.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * Protocol revision 2026-07-28 through the shared server (#288): a 2026 client has no
 * `Mcp-Session-Id`, so the daemon serves its requests one by one through `createMcpHandler`, in
 * the session the proxy's connection id names. Real v2 clients negotiating the era themselves
 * (`versionNegotiation: 'auto'`), real git against a local bare repo. No network.
 */

const IDENTITY = { name: 'Test', email: 'test@example.com' };

describe('protocol 2026-07-28 through the daemon', () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
  });

  async function setup(extra: Partial<DaemonOptions> = {}): Promise<{
    daemon: RunningDaemon;
    workspace: string;
    connect: (headers?: Record<string, string>, name?: string) => Promise<Client>;
  }> {
    const remote = await createFakeRemote({ 'main.tex': '\\documentclass{article}\n' });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-2026-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));
    await new GitService(IDENTITY).clone(remote.url, path.join(workspace, 'demo'), {
      username: 'git',
    });
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
    const connect = async (headers: Record<string, string> = {}, name = 'claude-code') => {
      const transport = new StreamableHTTPClientTransport(new URL(daemon.url), {
        requestInit: { headers: { authorization: `Bearer ${daemon.token}`, ...headers } },
      });
      const client = new Client(
        { name, version: '0.0.0' },
        { versionNegotiation: { mode: 'auto' } },
      );
      await client.connect(transport);
      cleanups.push(() => client.close());
      return client;
    };
    return { daemon, workspace, connect };
  }

  const del = (daemon: RunningDaemon, connection: string): Promise<Response> =>
    fetch(daemon.url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${daemon.token}`, [HEADER_CONNECTION]: connection },
    });

  it('serves a 2026 client in the session its connection names, and ends it on DELETE', async () => {
    const { daemon, workspace, connect } = await setup();
    const connection = randomUUID();
    const client = await connect({ [HEADER_CONNECTION]: connection, [HEADER_SESSION]: 'writer' });
    expect(client.getProtocolEra()).toBe('modern');
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');

    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name === 'status')).toBe(true);
    // Every schema dialect-free, and output schemas advertised for this client.
    expect(tools.filter((t) => '$schema' in t.inputSchema)).toEqual([]);
    expect(tools.some((t) => t.outputSchema !== undefined)).toBe(true);

    // Two calls, one session: the second sees the scope the first opened.
    const first = await client.callTool({ name: 'server_info', arguments: {} });
    const second = await client.callTool({ name: 'status', arguments: {} });
    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    expect((first.structuredContent as { mode?: string }).mode).toBe('daemon');
    expect(daemon.sessionIds()).toEqual(['writer']);
    expect(isScopeOpen(workspace, 'writer')).toBe(true);

    const res = await del(daemon, connection);
    expect(res.status).toBe(200);
    await expect.poll(() => daemon.sessionIds()).toEqual([]);
    expect(isScopeOpen(workspace, 'writer')).toBe(false);
  });

  it('keeps two connections apart, each in a session of its own', async () => {
    const { daemon, connect } = await setup();
    const a = await connect({ [HEADER_CONNECTION]: randomUUID() });
    const b = await connect({ [HEADER_CONNECTION]: randomUUID() });
    await a.callTool({ name: 'status', arguments: {} });
    await b.callTool({ name: 'status', arguments: {} });
    expect(daemon.sessionIds()).toHaveLength(2);
  });

  it('builds the server for the client each request names: no outputSchema for claude-ai', async () => {
    const { connect } = await setup();
    const desktop = await connect({ [HEADER_CONNECTION]: randomUUID() }, 'claude-ai');
    const { tools } = await desktop.listTools();
    expect(tools.every((t) => t.outputSchema === undefined)).toBe(true);
    const info = await desktop.callTool({ name: 'server_info', arguments: {} });
    expect(info.structuredContent).toBeUndefined();
  });

  it('reopens a session closed for idleness under the same id', async () => {
    const { daemon, connect } = await setup({ sessionIdleMs: 150 });
    const client = await connect({ [HEADER_CONNECTION]: randomUUID() });
    await client.callTool({ name: 'status', arguments: {} });
    const [id] = daemon.sessionIds();
    expect(id).toMatch(/^session-/);
    await expect.poll(() => daemon.sessionIds(), { timeout: 5_000 }).toEqual([]);
    await client.callTool({ name: 'status', arguments: {} });
    expect(daemon.sessionIds()).toEqual([id]);
  });

  it('never idles out a session while its proxy holds the connection open', async () => {
    const { daemon, connect } = await setup({ sessionIdleMs: 150 });
    const connection = randomUUID();
    const hold = new AbortController();
    const held = await fetch(new URL('/hold', daemon.url), {
      headers: { authorization: `Bearer ${daemon.token}`, [HEADER_CONNECTION]: connection },
      signal: hold.signal,
    });
    expect(held.status).toBe(200);
    const client = await connect({ [HEADER_CONNECTION]: connection });
    await client.callTool({ name: 'status', arguments: {} });
    await new Promise((r) => setTimeout(r, 600));
    expect(daemon.sessionIds()).toHaveLength(1);
    hold.abort();
  });

  it('sends a keep-alive on a hold, which fetch would otherwise drop after 5 silent minutes', async () => {
    const { daemon } = await setup({ holdKeepAliveMs: 50 });
    const hold = new AbortController();
    cleanups.push(async () => hold.abort());
    const held = await fetch(new URL('/hold', daemon.url), {
      headers: { authorization: `Bearer ${daemon.token}`, [HEADER_CONNECTION]: randomUUID() },
      signal: hold.signal,
    });
    expect(held.status).toBe(200);
    const reader = held.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toMatch(/^\n+$/);
    hold.abort();
  });

  it('asks the user before a guarded change, the client retrying with the answer (#289)', async () => {
    const { daemon, workspace } = await setup();
    const transport = new StreamableHTTPClientTransport(new URL(daemon.url), {
      requestInit: {
        headers: { authorization: `Bearer ${daemon.token}`, [HEADER_CONNECTION]: randomUUID() },
      },
    });
    const client = new Client(
      { name: 'claude-code', version: '0.0.0' },
      { versionNegotiation: { mode: 'auto' }, capabilities: { elicitation: { form: {} } } },
    );
    const asked: string[] = [];
    client.setRequestHandler('elicitation/create', async (request) => {
      asked.push(String((request.params as { message?: unknown }).message));
      return { action: 'accept', content: { approve: true } };
    });
    await client.connect(transport);
    cleanups.push(() => client.close());
    expect(client.getProtocolEra()).toBe('modern');

    const res = await client.callTool({
      name: 'write_file',
      arguments: { path: 'refs.bib', content: '@misc{a, title = {A}}\n', confirmBibEdit: true },
    });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('"refs.bib"');
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(path.join(workspace, 'demo', 'refs.bib'), 'utf8')).toContain('{A}');
  });

  it('serves a client that names only its session (the web UI) in that one session, run after run', async () => {
    const { daemon, connect } = await setup();
    const first = await connect({ [HEADER_SESSION]: 'ui-paper' });
    expect(first.getProtocolEra()).toBe('modern');
    await first.callTool({ name: 'status', arguments: {} });
    await first.close();
    const second = await connect({ [HEADER_SESSION]: 'ui-paper' });
    await second.callTool({ name: 'status', arguments: {} });
    expect(daemon.sessionIds()).toEqual(['ui-paper']);
  });

  it('falls back to the 2025 handshake for a client that names no connection or session', async () => {
    const { daemon, connect } = await setup();
    const client = await connect();
    expect(client.getProtocolEra()).toBe('legacy');
    await client.callTool({ name: 'status', arguments: {} });
    expect(daemon.sessionIds()).toHaveLength(1);
  });

  it('refuses a connection id the proxy would never send', async () => {
    const { daemon } = await setup();
    const res = await fetch(new URL('/hold', daemon.url), {
      headers: { authorization: `Bearer ${daemon.token}`, [HEADER_CONNECTION]: '../x' },
    });
    expect(res.status).toBe(400);
  });
});

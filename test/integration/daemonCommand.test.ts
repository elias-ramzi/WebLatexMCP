import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startDaemon, type RunningDaemon } from '../../src/daemon/daemon.js';
import { runDaemonCommand } from '../../src/daemon/daemonCommand.js';
import { CredentialResolver } from '../../src/services/auth.js';

/**
 * `web-latex-mcp daemon status | stop | headers` against an in-process daemon. `restart` spawns a
 * process and is exercised by the spawned-proxy suite's auto-start path.
 */

describe('the daemon command', () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
  });

  async function setup(): Promise<{ workspace: string; daemon: RunningDaemon }> {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-daemoncmd-'));
    cleanups.push(() => rm(workspace, { recursive: true, force: true }));
    const daemon = await startDaemon({
      config: { workspaceRoot: workspace, projects: [], sessionId: 'x' },
      env: {},
      credentials: new CredentialResolver({}),
      identity: { name: 'Test', email: 'test@example.com' },
      log: () => {},
    });
    cleanups.push(() => daemon.stop('test over'));
    return { workspace, daemon };
  }

  async function run(
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<{ status: number; out: string; err: string }> {
    let out = '';
    let err = '';
    const status = await runDaemonCommand(args, {
      env,
      cwd: os.tmpdir(),
      out: (t) => (out += t),
      err: (t) => (err += t),
    });
    return { status, out, err };
  }

  it('prints the headers a direct HTTP client needs, and they open a session', async () => {
    const { workspace, daemon } = await setup();
    const got = await run(['headers'], {
      WEB_LATEX_MCP_WORKSPACE: workspace,
      WEB_LATEX_MCP_SESSION: 'direct',
    });
    expect(got.status).toBe(0);
    const headers = JSON.parse(got.out) as Record<string, string>;
    expect(headers).toEqual({
      Authorization: `Bearer ${daemon.token}`,
      'x-web-latex-mcp-session': 'direct',
    });

    const transport = new StreamableHTTPClientTransport(new URL(daemon.url), {
      requestInit: { headers },
    });
    const client = new Client({ name: 'direct', version: '0' });
    await client.connect(transport);
    cleanups.push(() => client.close());
    const info = (await client.callTool({ name: 'server_info', arguments: {} }))
      .structuredContent as Record<string, unknown>;
    expect(info).toMatchObject({ mode: 'daemon', sessionId: 'direct' });
  });

  it('reports status, and stops only an idle daemon unless forced', async () => {
    const { workspace, daemon } = await setup();
    const env = { WEB_LATEX_MCP_WORKSPACE: workspace };
    const status = await run(['status'], env);
    expect(status.status).toBe(0);
    expect(status.out).toContain(`pid ${process.pid}`);
    expect(status.out).not.toContain(daemon.token);

    const transport = new StreamableHTTPClientTransport(new URL(daemon.url), {
      requestInit: { headers: { authorization: `Bearer ${daemon.token}` } },
    });
    const client = new Client({ name: 'busy', version: '0' });
    await client.connect(transport);
    cleanups.push(() => client.close());

    const refused = await run(['stop'], env);
    expect(refused.status).toBe(1);
    expect(refused.err).toMatch(/1 open session.*--force/s);

    expect((await run(['stop', '--force'], env)).status).toBe(0);
    await daemon.stopped;
    const after = await run(['status'], env);
    expect(after.status).toBe(1);
    expect((await run(['headers'], env)).status).toBe(1);
  });

  it('refuses an unknown action', async () => {
    expect((await run(['reboot'], {})).status).toBe(2);
    expect((await run(['stop', '--now'], {})).status).toBe(2);
  });
});

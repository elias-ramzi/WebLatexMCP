import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { findDaemon, shutdownDaemon, waitGone } from '../../src/proxy/discovery.js';

/**
 * The real thing (docs/design/shared-server.md §12): `web-latex-mcp` spawned as an MCP client
 * would spawn it, run from source through tsx. Two clients started at once auto-start ONE daemon
 * (the lock decides the race), both relay to it, and `daemon.json` names it. With no daemon
 * possible, the proxy serves in-process. No network, no TeX.
 */

const ENTRY = fileURLToPath(new URL('../../src/index.ts', import.meta.url));

// Each spawn starts node with tsx compiling the server from source: slow, so a generous budget.
describe('the spawned proxy', { timeout: 90_000 }, () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
  });

  /**
   * The developer's environment without this server's settings or anything secret-looking, so a
   * local `WEB_LATEX_MCP_STANDALONE=1` or a real token never shapes (or leaks into) the test.
   */
  function hermeticEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || k.startsWith('WEB_LATEX_MCP_')) continue;
      if (/(^|_)(TOKEN|SECRET|PASSWORD|CREDENTIALS?|API_?KEY|AUTH)(_|$)/i.test(k)) continue;
      env[k] = v;
    }
    return env;
  }

  /** Every line the proxy wrote to stdout that was not JSON-RPC (the SDK only reports them). */
  const strayStdout: Error[] = [];

  async function client(
    workspace: string,
    env: Record<string, string> = {},
  ): Promise<{ c: Client; transport: StdioClientTransport }> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', ENTRY],
      env: { ...hermeticEnv(), WEB_LATEX_MCP_WORKSPACE: workspace, ...env },
      stderr: 'pipe',
    });
    const c = new Client({ name: 'spawned', version: '0.0.0' });
    c.onerror = (err) => strayStdout.push(err);
    await c.connect(transport);
    cleanups.push(() => c.close());
    return { c, transport };
  }

  afterEach(() => {
    expect(strayStdout.splice(0).map((e) => e.message)).toEqual([]);
  });

  async function stopDaemonOf(workspace: string): Promise<void> {
    const found = await findDaemon(workspace);
    if (found) {
      await shutdownDaemon(found, { force: true });
      await waitGone(workspace, 15_000);
    }
  }

  const info = async (c: Client): Promise<Record<string, unknown>> =>
    (await c.callTool({ name: 'server_info', arguments: {} })).structuredContent as Record<
      string,
      unknown
    >;

  it('auto-starts one daemon for two clients racing, and both relay to it', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-spawn-'));
    cleanups.push(() => rm(workspace, { recursive: true, force: true }));
    cleanups.push(() => stopDaemonOf(workspace));

    const [{ c: a }, { c: b }] = await Promise.all([
      client(workspace, { WEB_LATEX_MCP_SESSION: 'alpha' }),
      client(workspace, { WEB_LATEX_MCP_SESSION: 'beta' }),
    ]);
    expect(await info(a)).toMatchObject({ mode: 'daemon', sessionId: 'alpha' });
    expect(await info(b)).toMatchObject({ mode: 'daemon', sessionId: 'beta' });
    const found = await findDaemon(workspace);
    expect(found?.health.sessions).toBe(2);
    expect(found?.health.pid).not.toBe(process.pid);
  });

  it('serves in-process when no daemon can be started, saying why', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-spawn-'));
    cleanups.push(() => rm(workspace, { recursive: true, force: true }));
    await mkdir(workspace, { recursive: true });
    // A file where the daemon's directory must go: no daemon can start here.
    await writeFile(path.join(workspace, '.daemon'), 'not a directory');
    const { c } = await client(workspace, { WEB_LATEX_MCP_SESSION: 'solo' });
    const got = await info(c);
    expect(got).toMatchObject({ mode: 'stdio', sessionId: 'solo' });
    expect(String(got.daemonUnavailable)).toMatch(/not a directory/);
  });

  it('serves in-process when asked to', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-spawn-'));
    cleanups.push(() => rm(workspace, { recursive: true, force: true }));
    const { c } = await client(workspace, { WEB_LATEX_MCP_STANDALONE: '1' });
    expect(await info(c)).toMatchObject({ mode: 'stdio' });
    expect((await info(c)).daemonUnavailable).toBeUndefined();
    expect(await findDaemon(workspace)).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'ends its session on the daemon when killed with SIGTERM',
    async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-spawn-'));
      cleanups.push(() => rm(workspace, { recursive: true, force: true }));
      cleanups.push(() => stopDaemonOf(workspace));
      const { c, transport } = await client(workspace, { WEB_LATEX_MCP_SESSION: 'alpha' });
      await info(c);
      expect((await findDaemon(workspace))?.health.sessions).toBe(1);
      process.kill(transport.pid as number, 'SIGTERM');
      await expect
        .poll(async () => (await findDaemon(workspace))?.health.sessions, { timeout: 10_000 })
        .toBe(0);
      // The id is free at once, so a new proxy takes over its own session's changes.
      const { c: again } = await client(workspace, { WEB_LATEX_MCP_SESSION: 'alpha' });
      expect(await info(again)).toMatchObject({ sessionId: 'alpha' });
    },
  );
});

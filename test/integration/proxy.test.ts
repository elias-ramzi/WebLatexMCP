import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createFakeRemote } from './helpers/bareRepo.js';
import { streamPair } from '../helpers/streamTransport.js';
import { startDaemon, type RunningDaemon } from '../../src/daemon/daemon.js';
import { runProxy, type ProxyOutcome } from '../../src/proxy/proxyCommand.js';
import { findDaemon, type FoundDaemon } from '../../src/proxy/discovery.js';
import { RESTARTED_MESSAGE } from '../../src/proxy/relay.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { currentBuildId } from '../../src/lib/buildId.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * The stdio proxy in-process (docs/design/shared-server.md §9, milestone 5): `runProxy` over a
 * pair of streams, relaying to an in-process daemon over real HTTP. Auto-start is a test seam
 * that starts another in-process daemon, so a restart can be observed without spawning.
 * test/integration/proxySpawn.test.ts covers the real spawned path.
 */

const REL = 'main.tex';
const BASE = '\\documentclass{article}\n\\begin{document}\nAlpha.\n\\end{document}\n';
const IDENTITY = { name: 'Test', email: 'test@example.com' };

describe('the stdio proxy', () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
  });

  async function workspaceWithClone(): Promise<{ workspace: string; config: ServerConfig }> {
    const remote = await createFakeRemote({ [REL]: BASE });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-proxy-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));
    await new GitService(IDENTITY).clone(remote.url, path.join(workspace, 'demo'), {
      username: 'git',
    });
    return {
      workspace,
      config: {
        workspaceRoot: workspace,
        projects: [{ id: 'demo', gitUrl: remote.url }],
        defaultProject: 'demo',
        sessionId: 'daemon',
        surfacePdf: true,
      },
    };
  }

  async function workspaceWithCloneAndDir(): Promise<{
    workspace: string;
    config: ServerConfig;
    dir: string;
  }> {
    const got = await workspaceWithClone();
    return { ...got, dir: path.join(got.workspace, 'demo') };
  }

  /** An in-process daemon on `config`'s workspace, with `env` as its own environment. */
  async function daemonOn(
    config: ServerConfig,
    env: NodeJS.ProcessEnv = {},
    buildPath?: string,
  ): Promise<RunningDaemon> {
    const daemon = await startDaemon({
      config,
      env,
      credentials: new CredentialResolver(env),
      identity: IDENTITY,
      registry: new ProjectRegistry(config.workspaceRoot),
      log: () => {},
      ...(buildPath !== undefined ? { buildPath } : {}),
    });
    cleanups.push(() => daemon.stop('test over'));
    return daemon;
  }

  interface Proxied {
    client: Client;
    outcome: Promise<ProxyOutcome>;
    end: () => Promise<void>;
  }

  /** Start `runProxy` with `env` and connect a client to its stdio. */
  async function proxied(
    workspace: string,
    env: NodeJS.ProcessEnv,
    autostart: (ws: string, env: NodeJS.ProcessEnv) => Promise<FoundDaemon>,
    buildId?: string,
  ): Promise<Proxied> {
    const { toServer, fromServer, transport } = streamPair();
    const outcome = runProxy({
      env: { ...env, WEB_LATEX_MCP_WORKSPACE: workspace },
      cwd: workspace,
      stdin: toServer,
      stdout: fromServer,
      log: () => {},
      autostart,
      ...(buildId !== undefined ? { buildId } : {}),
    });
    const client = new Client({ name: 'proxied', version: '0.0.0' });
    await client.connect(transport);
    const end = async (): Promise<void> => {
      await client.close();
      await outcome;
    };
    cleanups.push(end);
    return { client, outcome, end };
  }

  const info = async (c: Client): Promise<Record<string, unknown>> =>
    (await c.callTool({ name: 'server_info', arguments: {} })).structuredContent as Record<
      string,
      unknown
    >;

  it('starts one daemon for two clients, relays to it, and ends each session on exit', async () => {
    const { workspace, config } = await workspaceWithClone();
    const started: RunningDaemon[] = [];
    const spawnEnvs: NodeJS.ProcessEnv[] = [];
    const autostart = async (ws: string, env: NodeJS.ProcessEnv): Promise<FoundDaemon> => {
      spawnEnvs.push(env);
      started.push(await daemonOn(config));
      return (await findDaemon(ws)) as FoundDaemon;
    };
    const clientEnv = { WEB_LATEX_MCP_SESSION: 'alpha', GITHUB_TOKEN: 'ghp_from_client_env' };
    const a = await proxied(workspace, clientEnv, autostart);
    const b = await proxied(workspace, { WEB_LATEX_MCP_SESSION: 'beta' }, autostart);

    expect(started).toHaveLength(1); // the second proxy found the first one's daemon
    expect(await info(a.client)).toMatchObject({ mode: 'daemon', sessionId: 'alpha' });
    expect(await info(b.client)).toMatchObject({ mode: 'daemon', sessionId: 'beta' });
    // Tokens and per-connection settings never reach the daemon's own environment.
    expect(spawnEnvs[0]).not.toHaveProperty('GITHUB_TOKEN');
    expect(spawnEnvs[0]).not.toHaveProperty('WEB_LATEX_MCP_SESSION');
    expect(spawnEnvs[0]?.WEB_LATEX_MCP_WORKSPACE).toBe(workspace);

    const read = await a.client.callTool({ name: 'read_file', arguments: { path: REL } });
    expect(JSON.stringify(read.content)).toContain('Alpha.');

    await a.end();
    expect(await a.outcome).toEqual({ kind: 'relayed' });
    await expect.poll(() => started[0]?.sessionIds()).toEqual(['beta']);
  });

  it("names a daemon-wide setting the client's environment set differently", async () => {
    const { workspace, config } = await workspaceWithClone();
    await daemonOn(config, { WEB_LATEX_MCP_REWRITE_MODE: 'prose' });
    const a = await proxied(
      workspace,
      { WEB_LATEX_MCP_COMPILER: 'tectonic', WEB_LATEX_MCP_REWRITE_MODE: 'prose' },
      () => Promise.reject(new Error('not expected')),
      // The daemon's own build, so the proxy connects rather than replacing it.
      currentBuildId(process.argv[1]),
    );
    expect((await info(a.client)).ignoredClientEnv).toEqual(['WEB_LATEX_MCP_COMPILER']);
  });

  it('restarts a lost daemon once, keeping the session id', async () => {
    const { workspace, config } = await workspaceWithClone();
    const daemons: RunningDaemon[] = [];
    const autostart = async (ws: string): Promise<FoundDaemon> => {
      daemons.push(await daemonOn(config));
      return (await findDaemon(ws)) as FoundDaemon;
    };
    const a = await proxied(workspace, { WEB_LATEX_MCP_SESSION: 'alpha' }, autostart);
    expect(await info(a.client)).toMatchObject({ sessionId: 'alpha' });

    await daemons[0]?.stop('killed by the test');
    // The next call either rides the restart or is told to retry; the one after works.
    const next = await a.client.callTool({ name: 'server_info', arguments: {} }).then(
      () => 'ok',
      (err: Error) => err.message,
    );
    expect(next === 'ok' || next.includes(RESTARTED_MESSAGE)).toBe(true);
    await expect.poll(() => daemons.length, { timeout: 10_000 }).toBe(2);
    expect(await info(a.client)).toMatchObject({ mode: 'daemon', sessionId: 'alpha' });
    expect(daemons[1]?.sessionIds()).toEqual(['alpha']);
  });

  it('reports the daemon unavailable before reading anything, so the caller serves in-process', async () => {
    const { workspace } = await workspaceWithClone();
    const { toServer, fromServer } = streamPair();
    // The client has already written its initialize: it must still be there for the fallback.
    toServer.write('{"jsonrpc":"2.0","id":0,"method":"initialize"}\n');
    const before = toServer.readableLength;
    const outcome = await runProxy({
      env: { WEB_LATEX_MCP_WORKSPACE: workspace },
      cwd: workspace,
      stdin: toServer,
      stdout: fromServer,
      log: () => {},
      autostart: () => Promise.reject(new Error('port refused')),
    });
    expect(outcome).toEqual({ kind: 'unavailable', reason: 'port refused' });
    expect(before).toBeGreaterThan(0);
    expect(toServer.readableLength).toBe(before);
  });

  it('passes a request the live daemon refuses back as an error, keeping the session', async () => {
    const { workspace, config } = await workspaceWithClone();
    const daemons: RunningDaemon[] = [];
    const autostart = async (ws: string): Promise<FoundDaemon> => {
      daemons.push(
        await startDaemon({
          config,
          env: {},
          credentials: new CredentialResolver({}),
          identity: IDENTITY,
          log: () => {},
          maxBodyBytes: 20_000,
        }),
      );
      cleanups.push(() => daemons[daemons.length - 1]!.stop('test over'));
      return (await findDaemon(ws)) as FoundDaemon;
    };
    const a = await proxied(workspace, { WEB_LATEX_MCP_SESSION: 'alpha' }, autostart);
    const big = await a.client
      .callTool({ name: 'write_file', arguments: { path: 'big.tex', content: 'x'.repeat(50_000) } })
      .then(
        () => 'ok',
        (err: Error) => err.message,
      );
    expect(big).toMatch(/refused this request/);
    // Same daemon, same session: nothing was re-opened under another id.
    expect(await info(a.client)).toMatchObject({ sessionId: 'alpha' });
    expect(daemons).toHaveLength(1);
    expect(daemons[0]?.sessionIds()).toEqual(['alpha']);
  });

  it('sends a request made during a restart to the new daemon, never asking for a retry', async () => {
    const { workspace, config, dir } = await workspaceWithCloneAndDir();
    const daemons: RunningDaemon[] = [];
    const autostart = async (ws: string): Promise<FoundDaemon> => {
      await new Promise((r) => setTimeout(r, 300)); // a restart that takes a moment
      daemons.push(await daemonOn(config));
      return (await findDaemon(ws)) as FoundDaemon;
    };
    const a = await proxied(workspace, { WEB_LATEX_MCP_SESSION: 'alpha' }, autostart);
    await a.client.callTool({ name: 'read_file', arguments: { path: REL } });
    await daemons[0]?.stop('killed by the test');

    const first = a.client.callTool({ name: 'server_info', arguments: {} }).then(
      () => 'ok',
      (err: Error) => err.message,
    );
    await new Promise((r) => setTimeout(r, 100)); // the restart is under way
    const edit = await a.client.callTool({
      name: 'edit_file',
      arguments: { path: REL, edits: [{ oldString: 'Alpha.', newString: 'Alpha, once.' }] },
    });
    expect(edit.isError).toBeFalsy();
    const got = await first;
    expect(got === 'ok' || got.includes(RESTARTED_MESSAGE)).toBe(true);
    expect(await readFile(path.join(dir, REL), 'utf8')).toContain('Alpha, once.\n');
    expect(await readFile(path.join(dir, REL), 'utf8')).not.toContain('once., once');
  });

  it('ends the session on the daemon when the proxy is stopped by a signal', async () => {
    const { workspace, config } = await workspaceWithClone();
    const daemon = await daemonOn(config, {}, process.argv[1]);
    const { toServer, fromServer, transport } = streamPair();
    let stop!: () => void;
    const outcome = runProxy({
      env: { WEB_LATEX_MCP_WORKSPACE: workspace, WEB_LATEX_MCP_SESSION: 'alpha' },
      cwd: workspace,
      stdin: toServer,
      stdout: fromServer,
      log: () => {},
      onStop: (s) => (stop = s),
      buildId: currentBuildId(process.argv[1]),
      autostart: () => Promise.reject(new Error('not expected')),
    });
    const client = new Client({ name: 'proxied', version: '0.0.0' });
    await client.connect(transport);
    expect(daemon.sessionIds()).toEqual(['alpha']);
    stop(); // what SIGTERM does
    expect(await outcome).toEqual({ kind: 'relayed' });
    await expect.poll(() => daemon.sessionIds()).toEqual([]);
  });

  it('replaces an idle daemon of another build, and asks a busy one to make way later', async () => {
    const { workspace, config } = await workspaceWithClone();
    const old = await daemonOn(config, {}, '/old/build/index.js');
    const daemons: RunningDaemon[] = [];
    const autostart = async (ws: string): Promise<FoundDaemon> => {
      daemons.push(await daemonOn(config));
      return (await findDaemon(ws)) as FoundDaemon;
    };
    // A newer version: no session is open on the old daemon, so it is replaced now.
    const a = await proxied(
      workspace,
      { WEB_LATEX_MCP_SESSION: 'alpha' },
      autostart,
      '99.0.0|/new|1',
    );
    await old.stopped;
    expect(daemons).toHaveLength(1);
    expect(await info(a.client)).toMatchObject({ sessionId: 'alpha' });

    // A third build while alpha is open: connect, and the daemon stops once its sessions end.
    const b = await proxied(
      workspace,
      { WEB_LATEX_MCP_SESSION: 'beta' },
      autostart,
      '99.0.1|/newer|2',
    );
    expect(daemons).toHaveLength(1);
    expect((await findDaemon(workspace))?.health.replaceRequested).toBe(true);
    expect(await info(a.client)).toMatchObject({ restartPending: true });
    await a.end();
    await b.end();
    await daemons[0]?.stopped;
  });
});

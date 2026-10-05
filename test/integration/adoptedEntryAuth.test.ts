import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import type { ExecResult } from '../../src/lib/exec.js';
import type { GitProjectConfig, ServerConfig } from '../../src/types.js';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import { serveWithAuth, type AuthHttpRemote } from './helpers/authHttpRemote.js';

/**
 * A peer's re-registration carries its CREDENTIAL with it, end to end (#247).
 *
 * `project_sync` (without `gitUrl`) and `push` adopt the registry's current entry
 * (`ProjectManager.refreshedGitConfig`) before resolving the credential, so a peer that re-registers
 * `p` with a new `tokenEnv` changes which env var this process's next remote operation reads — not
 * only which URL `origin` follows. The unit test (`test/unit/refreshedGitConfig.test.ts`) pins the
 * adoption; this one pins that the adopted `tokenEnv` is what reaches git, against a smart-HTTP
 * remote that really demands Basic auth (`helpers/authHttpRemote.ts`).
 *
 * Each case first watches the very same call fail on auth while this process's snapshot names an
 * env var that holds nothing, so a success afterwards can only come from the peer's entry.
 *
 * Git runs hermetically (see `gitUrlCredentialEcho.test.ts`): with no token resolved git falls
 * through to the developer's own credential helpers, which must neither answer nor be written to.
 * The token lives only in the `CredentialResolver`'s injected env, never in `process.env`.
 */

const HERMETIC_ENV = [
  'GIT_TERMINAL_PROMPT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_ASKPASS',
];
const prevEnv = new Map<string, string | undefined>();
let gitHome = '';
beforeAll(async () => {
  for (const key of HERMETIC_ENV) prevEnv.set(key, process.env[key]);
  gitHome = await mkdtemp(path.join(os.tmpdir(), 'wlm-adopted-auth-git-'));
  const globalConfig = path.join(gitHome, 'gitconfig');
  await writeFile(globalConfig, '[user]\n\tname = Test\n\temail = test@example.com\n');
  process.env.GIT_TERMINAL_PROMPT = '0';
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_ASKPASS = '';
});
afterAll(async () => {
  for (const [key, value] of prevEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(gitHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const TOKEN = 'tok-5e2aADOPTEDb91c';
const USERNAME = 'peer-user';
const BAD_VAR = 'WLM_TEST_UNSET_TOKEN';
const GOOD_VAR = 'WLM_TEST_GOOD_TOKEN';

/** No `gh`, no credential helper: the resolver finds only what its env gives it. */
const noHelpers = async (): Promise<ExecResult> => ({
  code: 1,
  stdout: '',
  stderr: '',
  timedOut: false,
});

interface Setup {
  client: Client;
  workspace: string;
  remote: FakeRemote;
  server: AuthHttpRemote;
  /** Stand-in for a peer process writing the shared registry. */
  peer: ProjectRegistry;
  /** This process's own registration of `p`: `tokenEnv` names a variable that holds nothing. */
  stale: GitProjectConfig;
}

async function setup(): Promise<Setup> {
  const remote = await createFakeRemote({ 'main.tex': 'alpha\n' });
  cleanups.push(remote.cleanup);
  // A username other than the resolver's fallback `git`, so the peer's `username` must be adopted
  // alongside its `tokenEnv` for the credential to match.
  const server = await serveWithAuth(remote, { username: USERNAME, password: TOKEN });
  cleanups.push(server.close);
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlm-adopted-auth-'));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const workspace = path.join(root, 'ws');
  await mkdir(workspace, { recursive: true });

  const stale: GitProjectConfig = { id: 'p', gitUrl: server.url, tokenEnv: BAD_VAR };
  const peer = new ProjectRegistry(workspace);
  // The registry holds what this process loaded at startup; the peer rewrites it later.
  await peer.upsert(stale);

  const config: ServerConfig = { workspaceRoot: workspace, sessionId: 'a', projects: [stale] };
  // BAD_VAR is deliberately absent; only the peer's variable holds the token.
  const ctx = createContext(
    config,
    new CredentialResolver({ [GOOD_VAR]: TOKEN }, noHelpers),
    { name: 'Test', email: 'test@example.com' },
    new ProjectRegistry(workspace),
  );
  const mcp = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return { client, workspace, remote, server, peer, stale };
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

describe("a peer's re-registration with a new tokenEnv authenticates this process's next remote call", () => {
  it('project_sync (no gitUrl) clones with the token from the adopted entry', async () => {
    const { client, workspace, server, peer, stale } = await setup();

    // Control: the snapshot's tokenEnv holds nothing, so the clone is refused by the remote.
    const before = await client.callTool({ name: 'project_sync', arguments: { project: 'p' } });
    expect(before.isError, textOf(before)).toBe(true);
    expect(server.counts.refused).toBeGreaterThan(0);
    expect(server.counts.authorized).toBe(0);

    await peer.upsert({ ...stale, tokenEnv: GOOD_VAR, username: USERNAME });

    const after = await client.callTool({ name: 'project_sync', arguments: { project: 'p' } });
    expect(after.isError, textOf(after)).toBeFalsy();
    expect((after.structuredContent as { action: string }).action).toBe('cloned');
    expect(server.counts.authorized).toBeGreaterThan(0);
    const head = await simpleGit(path.join(workspace, 'p')).raw(['show', 'HEAD:main.tex']);
    expect(head).toBe('alpha\n');
    expect(JSON.stringify(after)).not.toContain(TOKEN);
  });

  it('push pushes with the token from the adopted entry', async () => {
    const { client, workspace, remote, server, peer, stale } = await setup();

    // A clone already on disk, made straight from the bare repo (no auth), then pointed at the
    // auth-demanding URL this process holds — what an earlier, authenticated sync would leave.
    const dir = path.join(workspace, 'p');
    await simpleGit().raw(['clone', '-c', 'core.autocrlf=false', remote.url, dir]);
    await simpleGit(dir).raw(['remote', 'set-url', 'origin', server.url]);
    await writeFile(path.join(dir, 'main.tex'), 'alpha\nbeta\n');
    const committed = await client.callTool({
      name: 'commit',
      arguments: { project: 'p', message: 'beta', scope: 'all' },
    });
    expect(committed.isError, textOf(committed)).toBeFalsy();

    // Control: same push, snapshot credential — refused by the remote, nothing lands.
    const before = await client.callTool({
      name: 'push',
      arguments: { project: 'p', confirm: true },
    });
    expect(before.isError, textOf(before)).toBe(true);
    expect(server.counts.refused).toBeGreaterThan(0);
    expect(server.counts.authorized).toBe(0);

    await peer.upsert({ ...stale, tokenEnv: GOOD_VAR, username: USERNAME });

    const after = await client.callTool({
      name: 'push',
      arguments: { project: 'p', confirm: true },
    });
    expect(after.isError, textOf(after)).toBeFalsy();
    expect((after.structuredContent as { status: string }).status).toBe('pushed');
    expect(server.counts.authorized).toBeGreaterThan(0);
    const landed = await simpleGit().raw([
      '--git-dir',
      remote.bareDir,
      'log',
      '--format=%s',
      remote.branch,
    ]);
    expect(landed.split('\n')[0]).toBe('beta');
    expect(JSON.stringify(after)).not.toContain(TOKEN);
  });
});

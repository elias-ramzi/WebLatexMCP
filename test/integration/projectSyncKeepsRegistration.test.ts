import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext, type AppContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import type { ExecResult } from '../../src/lib/exec.js';
import { isLocalProject } from '../../src/lib/projectMode.js';
import type { GitProjectConfig, ProjectConfig, ServerConfig } from '../../src/types.js';
import { createFakeRemote } from './helpers/bareRepo.js';
import { serveWithAuth } from './helpers/authHttpRemote.js';

/**
 * `project_sync { gitUrl }` re-registers the project in process before it clones or pulls. It used
 * to register `{ id, gitUrl }` and nothing else, REPLACING whatever the id held — so a project
 * configured with `rootFile`/`branch`/`username`/`tokenEnv` silently lost them for the rest of the
 * process, which changes what `compile`, the PDF tools and the viewer build (rootFile), what is
 * synced (branch), and which token authenticates (tokenEnv/username).
 *
 * The fix carries those fields forward when the call re-states the SAME remote — compared after
 * the credential strip registration itself applies, so a URL that differs only by a pasted token
 * is the same remote — and keeps the replace when the URL is a re-point, naming what it dropped.
 *
 * Git runs hermetically (as in gitUrlCredentialEcho.test.ts): the auth-demanding HTTP remote must
 * not be answered from the developer's own credential helpers, nor have a token approved into them.
 */

const HERMETIC_ENV = [
  'GIT_TERMINAL_PROMPT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_ASKPASS',
  'NO_PROXY',
  'no_proxy',
];
const prevEnv = new Map<string, string | undefined>();
let gitHome = '';
beforeAll(async () => {
  for (const key of HERMETIC_ENV) prevEnv.set(key, process.env[key]);
  gitHome = await mkdtemp(path.join(os.tmpdir(), 'wlm-synckeep-git-'));
  const globalConfig = path.join(gitHome, 'gitconfig');
  await writeFile(globalConfig, '');
  process.env.GIT_TERMINAL_PROMPT = '0';
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_ASKPASS = '';
  // Every remote here is loopback or file://: a developer's proxy must not answer for one.
  process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost';
});

/** A loopback port nothing listens on: bound by the OS, then released. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
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

const TOKEN = 'tok-5b2eSECRETc91f';

/** No `gh`, no credential helper: the resolver finds only what `env` gives it. */
const noHelpers = async (): Promise<ExecResult> => ({
  code: 1,
  stdout: '',
  stderr: '',
  timedOut: false,
});

/**
 * A server over `projects` (or what `projectsFor` builds from the workspace root, for a project
 * whose directory sits inside it). With `registry`, a `ProjectRegistry` over the workspace is wired and
 * seeded with those entries first, and `projects` are treated as env-configured
 * (`envProjectIds`), as `loadConfig` reports a `WEB_LATEX_MCP_PROJECTS` entry.
 */
async function session(
  projectsFor: ProjectConfig[] | ((workspaceRoot: string) => ProjectConfig[]),
  env: NodeJS.ProcessEnv = {},
  registry?: ProjectConfig[],
): Promise<{ ctx: AppContext; client: Client }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlm-synckeep-'));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const workspaceRoot = path.join(root, 'ws');
  const projects = typeof projectsFor === 'function' ? projectsFor(workspaceRoot) : projectsFor;
  const config: ServerConfig = {
    workspaceRoot,
    sessionId: 'test',
    projects,
    ...(registry ? { envProjectIds: projects.map((p) => p.id) } : {}),
  };
  let store: ProjectRegistry | undefined;
  if (registry) {
    await mkdir(workspaceRoot, { recursive: true });
    store = new ProjectRegistry(workspaceRoot);
    for (const entry of registry) await store.upsert(entry);
  }
  const ctx = createContext(
    config,
    new CredentialResolver(env, noHelpers),
    { name: 'Test', email: 'test@example.com' },
    store,
  );
  const mcp = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return { ctx, client };
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

function gitConfig(ctx: AppContext, id: string): GitProjectConfig {
  const cfg = ctx.projectManager.getProjectConfig(id);
  if (isLocalProject(cfg)) throw new Error(`expected a git project, got a local one: ${id}`);
  return cfg;
}

describe('project_sync { gitUrl } keeps a registration it only re-states', () => {
  it('the same gitUrl keeps rootFile and branch', async () => {
    const remote = await createFakeRemote({ 'paper.tex': 'alpha\n' });
    cleanups.push(remote.cleanup);
    const { ctx, client } = await session([
      { id: 'paper', gitUrl: remote.url, rootFile: 'paper.tex', branch: 'master' },
    ]);

    const res = await client.callTool({
      name: 'project_sync',
      arguments: { project: 'paper', gitUrl: remote.url },
    });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect((res.structuredContent as { action: string }).action).toBe('cloned');

    const cfg = gitConfig(ctx, 'paper');
    expect(cfg.rootFile).toBe('paper.tex');
    expect(cfg.branch).toBe('master');
    expect(cfg.gitUrl).toBe(remote.url);
    // The note project_sync emits on a re-point (see the last test) names what it dropped; a
    // re-stated remote drops nothing, so neither word may appear.
    expect(textOf(res)).not.toMatch(/dropping|replaced/i);
  });

  it('a gitUrl differing only by a pasted token is the same remote: tokenEnv and the rest survive, and the clone authenticates with it', async () => {
    const remote = await createFakeRemote({ 'paper.tex': 'alpha\n' });
    cleanups.push(remote.cleanup);
    const server = await serveWithAuth(remote, { username: 'git', password: TOKEN });
    cleanups.push(server.close);
    // Stored as registration would store it (a login name kept, no secret); the caller then
    // pastes the same remote with a token after the login name.
    const storedUrl = server.url.replace('http://', 'http://git@');
    const tokenUrl = server.url.replace('http://', `http://git:${TOKEN}@`);
    const { ctx, client } = await session(
      [
        {
          id: 'paper',
          gitUrl: storedUrl,
          rootFile: 'paper.tex',
          branch: 'master',
          username: 'git',
          tokenEnv: 'PAPER_TOKEN',
        },
      ],
      // Only the project's own tokenEnv holds the token: drop it and the clone fails on auth.
      { PAPER_TOKEN: TOKEN },
    );

    const res = await client.callTool({
      name: 'project_sync',
      arguments: { project: 'paper', gitUrl: tokenUrl },
    });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect((res.structuredContent as { action: string }).action).toBe('cloned');
    expect(JSON.stringify(res)).not.toContain(TOKEN);

    const cfg = gitConfig(ctx, 'paper');
    expect(cfg.rootFile).toBe('paper.tex');
    expect(cfg.branch).toBe('master');
    expect(cfg.username).toBe('git');
    expect(cfg.tokenEnv).toBe('PAPER_TOKEN');
    // Held tokenless, exactly as registration stores it.
    expect(cfg.gitUrl).toBe(storedUrl);
    expect(cfg.gitUrl).not.toContain(TOKEN);
  });

  it('a different gitUrl is a re-point: the registration is replaced, and the text names what was dropped', async () => {
    const before = await createFakeRemote({ 'paper.tex': 'alpha\n' });
    const after = await createFakeRemote({ 'main.tex': 'beta\n' });
    cleanups.push(before.cleanup, after.cleanup);
    const { ctx, client } = await session([
      { id: 'paper', gitUrl: before.url, rootFile: 'paper.tex', branch: 'master' },
    ]);

    const res = await client.callTool({
      name: 'project_sync',
      arguments: { project: 'paper', gitUrl: after.url },
    });
    expect(res.isError, textOf(res)).toBeFalsy();

    const cfg = gitConfig(ctx, 'paper');
    expect(cfg.gitUrl).toBe(after.url);
    expect(cfg.rootFile).toBeUndefined();
    expect(cfg.branch).toBeUndefined();
    const text = textOf(res);
    expect(text).toContain('rootFile="paper.tex"');
    expect(text).toContain('branch="master"');
    // project_sync takes none of those fields, so the remedy names the tool that does; and it
    // says the gitUrl differs, never that it is another remote (a login name alone differs too).
    expect(text).toMatch(/differs from the one "paper" was registered with/);
    expect(text).toContain('register_project');
    expect(text).not.toMatch(/not the remote|another remote/);
  });

  it('a re-point whose sync then fails still names what it dropped, in the error', async () => {
    const before = await createFakeRemote({ 'paper.tex': 'alpha\n' });
    cleanups.push(before.cleanup);
    const nowhere = await mkdtemp(path.join(os.tmpdir(), 'wlm-synckeep-nowhere-'));
    cleanups.push(() => rm(nowhere, { recursive: true, force: true }));
    // A typo'd URL: a file:// remote that is no repository, so the clone fails.
    const typo = pathToFileURL(path.join(nowhere, 'no-such-repo.git')).href;
    const { ctx, client } = await session([
      { id: 'paper', gitUrl: before.url, rootFile: 'paper.tex', branch: 'master' },
    ]);

    const res = await client.callTool({
      name: 'project_sync',
      arguments: { project: 'paper', gitUrl: typo },
    });
    expect(res.isError).toBe(true);
    // The registration was replaced before the clone ran (unchanged), so the caller must hear
    // what that dropped here — a retry with the right URL compares against the typo config and
    // could never report it again.
    expect(gitConfig(ctx, 'paper').rootFile).toBeUndefined();
    const text = textOf(res);
    expect(text).toMatch(/differs from the one "paper" was registered with/);
    expect(text).toContain('rootFile="paper.tex"');
    expect(text).toContain('branch="master"');
    // The URL may be why the sync failed, so the remedy is conditional on fixing it, never
    // "call register_project with this gitUrl".
    expect(text).toContain('once the gitUrl is right, call register_project with it');
    expect(text).not.toContain('with this gitUrl');
  });

  it('a re-point refused for a reason other than its URL keeps the plain remedy', async () => {
    const before = await createFakeRemote({ 'paper.tex': 'alpha\n' });
    const after = await createFakeRemote({ 'main.tex': 'beta\n' });
    cleanups.push(before.cleanup, after.cleanup);
    const { client } = await session([
      { id: 'paper', gitUrl: before.url, rootFile: 'paper.tex', branch: 'master' },
    ]);
    const first = await client.callTool({ name: 'project_sync', arguments: { project: 'paper' } });
    expect(first.isError, textOf(first)).toBeFalsy();

    // Already cloned: the mode is the problem, never the URL, so nothing hedges on the URL.
    const res = await client.callTool({
      name: 'project_sync',
      arguments: { project: 'paper', gitUrl: after.url, mode: 'clone' },
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('already cloned');
    expect(text).toContain('rootFile="paper.tex"');
    expect(text).toContain('call register_project with this gitUrl and those fields');
    expect(text).not.toContain('once the gitUrl is right');
  });

  it('a failed re-point names the dropped fields before the stripped-credentials note, as on success', async () => {
    const before = await createFakeRemote({ 'paper.tex': 'alpha\n' });
    cleanups.push(before.cleanup);
    // A pasted token, to a port nothing listens on: the clone fails fast, after both notes apply.
    const typo = `http://git:${TOKEN}@127.0.0.1:${await closedPort()}/no-such-repo.git`;
    const { client } = await session([
      { id: 'paper', gitUrl: before.url, rootFile: 'paper.tex', branch: 'master' },
    ]);

    const res = await client.callTool({
      name: 'project_sync',
      arguments: { project: 'paper', gitUrl: typo },
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).not.toContain(TOKEN);
    const dropped = text.indexOf('rootFile="paper.tex"');
    const credentials = text.indexOf('it was removed and NOT stored');
    expect(dropped, text).toBeGreaterThan(-1);
    expect(credentials, text).toBeGreaterThan(-1);
    expect(dropped).toBeLessThan(credentials);
    // Each note once: the outer handler must not append the dropped fields a second time.
    expect(text.split('rootFile="paper.tex"')).toHaveLength(2);
  });

  it('a registration refused inside project_sync claims no replacement and keeps the held config', async () => {
    const before = await createFakeRemote({ 'paper.tex': 'alpha\n' });
    const after = await createFakeRemote({ 'main.tex': 'beta\n' });
    cleanups.push(before.cleanup, after.cleanup);
    const paper: ProjectConfig = {
      id: 'paper',
      gitUrl: before.url,
      rootFile: 'paper.tex',
      branch: 'master',
    };
    // A local project sitting at paper's clone directory: re-registering paper is then refused by
    // `assertDirUnclaimed`, inside `registerProject`, after the plan computed what it would drop.
    const { ctx, client } = await session(
      (ws) => [paper, { id: 'squatter', mode: 'local', path: path.join(ws, 'paper') }],
      {},
      [paper],
    );

    const res = await client.callTool({
      name: 'project_sync',
      arguments: { project: 'paper', gitUrl: after.url },
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/Project "squatter" already uses /);
    // Nothing was replaced, so nothing may be reported dropped.
    expect(text).not.toMatch(/dropping|replaced|differs|rootFile|branch=/);
    const cfg = gitConfig(ctx, 'paper');
    expect(cfg.gitUrl).toBe(before.url);
    expect(cfg.rootFile).toBe('paper.tex');
    expect(cfg.branch).toBe('master');
  });

  it('a local project synced as a git one says it replaced a local project', async () => {
    const remote = await createFakeRemote({ 'paper.tex': 'alpha\n' });
    cleanups.push(remote.cleanup);
    const localDir = await mkdtemp(path.join(os.tmpdir(), 'wlm-synckeep-local-'));
    cleanups.push(() => rm(localDir, { recursive: true, force: true }));
    const { ctx, client } = await session([
      { id: 'paper', mode: 'local', path: localDir, rootFile: 'paper.tex', followSymlinks: true },
    ]);

    const res = await client.callTool({
      name: 'project_sync',
      arguments: { project: 'paper', gitUrl: remote.url },
    });
    expect(res.isError, textOf(res)).toBeFalsy();

    const cfg = gitConfig(ctx, 'paper');
    expect(cfg.gitUrl).toBe(remote.url);
    expect(cfg.rootFile).toBeUndefined();
    const text = textOf(res);
    expect(text).toMatch(/"paper" was a local project; syncing it as a git project replaced/);
    expect(text).toContain('rootFile="paper.tex", followSymlinks=true');
    expect(text).toContain('register_project');
    expect(text).not.toMatch(/gitUrl differs|not the remote/);
  });

  it('an env-configured project keeps its env fields over a stale registry entry for the same remote', async () => {
    const remote = await createFakeRemote({ 'paper.tex': 'alpha\n' });
    cleanups.push(remote.cleanup);
    const env: ProjectConfig = {
      id: 'paper',
      gitUrl: remote.url,
      rootFile: 'env.tex',
      tokenEnv: 'ENV_TOKEN',
    };
    const stale: ProjectConfig = {
      id: 'paper',
      gitUrl: remote.url,
      rootFile: 'old.tex',
      tokenEnv: 'REGISTRY_TOKEN',
    };
    const { ctx, client } = await session([env], {}, [stale]);

    const res = await client.callTool({
      name: 'project_sync',
      arguments: { project: 'paper', gitUrl: remote.url },
    });
    expect(res.isError, textOf(res)).toBeFalsy();

    // The config project_sync replaced was the env one this process held — env wins over the
    // registry — so that is what carries forward, not the registry's stale entry.
    const cfg = gitConfig(ctx, 'paper');
    expect(cfg.rootFile).toBe('env.tex');
    expect(cfg.tokenEnv).toBe('ENV_TOKEN');
    expect(ctx.projectManager.registeredRootFile('paper')).toBe('env.tex');
    expect(textOf(res)).not.toMatch(/dropping|replaced/i);
  });

  it('an env-configured project re-stating its own remote is not a re-point, whatever remote the registry names', async () => {
    const remote = await createFakeRemote({ 'paper.tex': 'alpha\n' });
    const elsewhere = await createFakeRemote({ 'other.tex': 'beta\n' });
    cleanups.push(remote.cleanup, elsewhere.cleanup);
    const env: ProjectConfig = {
      id: 'paper',
      gitUrl: remote.url,
      rootFile: 'env.tex',
      tokenEnv: 'ENV_TOKEN',
    };
    const stale: ProjectConfig = { id: 'paper', gitUrl: elsewhere.url, rootFile: 'old.tex' };
    const { ctx, client } = await session([env], {}, [stale]);

    const res = await client.callTool({
      name: 'project_sync',
      arguments: { project: 'paper', gitUrl: remote.url },
    });
    expect(res.isError, textOf(res)).toBeFalsy();

    const cfg = gitConfig(ctx, 'paper');
    expect(cfg.gitUrl).toBe(remote.url);
    expect(cfg.rootFile).toBe('env.tex');
    expect(cfg.tokenEnv).toBe('ENV_TOKEN');
    expect(textOf(res)).not.toMatch(/dropping|replaced|differs/i);
  });
});

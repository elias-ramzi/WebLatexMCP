import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { simpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { quoteId } from '../../src/lib/projectId.js';
import { toPosix } from '../../src/lib/paths.js';
import type { ExecResult } from '../../src/lib/exec.js';
import type { ProjectConfig, ServerConfig } from '../../src/types.js';
import { createFakeRemote, pushCommit, type FakeRemote } from './helpers/bareRepo.js';
import { serveWithAuth } from './helpers/authHttpRemote.js';

/**
 * A cloned project's `origin` follows the URL the session holds — but only while the server owns
 * it (`src/lib/originRepoint.ts`).
 *
 * Every remote operation runs against `origin`; the held URL only keys the injected credential.
 * Re-pointing a project used to change the held config and never `origin`, so fetch, pull and push
 * kept going to the old remote. Moving `origin` at registration went wrong whenever the held URL
 * and the clone parted ways later (a session-only `project_sync { gitUrl }`, an env URL after a
 * restart, a peer); comparing URLs for "same repository" broke relative clone URLs and SSH host
 * aliases. So the server records what it wrote (`webLatexMcp.heldUrl`/`.originUrl` in the clone's
 * `.git/config`), reconciles before every remote operation, and rewrites `origin` only while it is
 * still exactly what it wrote. A hand-set origin is never rewritten; it is named.
 *
 * Git runs hermetically: no developer config or credential helper may answer for a remote here.
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
  gitHome = await mkdtemp(path.join(os.tmpdir(), 'wlm-repoint-git-'));
  const globalConfig = path.join(gitHome, 'gitconfig');
  // An identity, since a push that rebases onto a fetched commit writes a commit of its own.
  await writeFile(globalConfig, '[user]\n\tname = Test\n\temail = test@example.com\n');
  process.env.GIT_TERMINAL_PROMPT = '0';
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_ASKPASS = '';
  process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost';
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

const noHelpers = async (): Promise<ExecResult> => ({
  code: 1,
  stdout: '',
  stderr: '',
  timedOut: false,
});

// Not global: `toMatch` calls `RegExp.test`, which advances a global regex's `lastIndex`, so a
// later `not.toMatch` could pass vacuously. Occurrences are counted by `count()`.
const REPOINTED = 'origin was re-pointed';
// In every wording of the note for an origin the server does not own (`unownedOriginNote`).
const UNOWNED = 'leaves it as it is';
const count = (text: string, needle: string): number => text.split(needle).length - 1;

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

async function remote(files: Record<string, string> = { 'main.tex': 'alpha\n' }) {
  const r = await createFakeRemote(files);
  cleanups.push(r.cleanup);
  return r;
}

/** A second bare repo sharing `base`'s history, plus one extra commit `base` does not have. */
async function forkWithCommit(base: FakeRemote): Promise<FakeRemote> {
  const root = await tmp('wlm-repoint-fork-');
  const bareDir = path.join(root, 'fork.git');
  await simpleGit().raw(['clone', '--bare', base.url, bareDir]);
  const fork: FakeRemote = {
    url: pathToFileURL(bareDir).href,
    bareDir,
    branch: base.branch,
    cleanup: async () => {},
  };
  await pushCommit(fork, { 'extra.tex': 'only on the fork\n' }, 'fork-only commit');
  return fork;
}

async function newWorkspace(): Promise<string> {
  const root = await tmp('wlm-repoint-');
  const workspaceRoot = path.join(root, 'ws');
  await mkdir(workspaceRoot, { recursive: true });
  return workspaceRoot;
}

/**
 * One server process over `workspaceRoot` (a fresh one by default). Several sessions may share a
 * workspace — a restart, or a peer — each with its own `sessionId`. `env: true` treats `projects`
 * as env-configured (`WEB_LATEX_MCP_PROJECTS`).
 */
async function session(
  opts: {
    projects?: ProjectConfig[];
    workspaceRoot?: string;
    sessionId?: string;
    env?: boolean;
  } = {},
): Promise<{ client: Client; workspaceRoot: string; dir: string }> {
  const workspaceRoot = opts.workspaceRoot ?? (await newWorkspace());
  const projects = opts.projects ?? [];
  const config: ServerConfig = {
    workspaceRoot,
    sessionId: opts.sessionId ?? 'test',
    projects,
    ...(opts.env ? { envProjectIds: projects.map((p) => p.id) } : {}),
  };
  const ctx = createContext(
    config,
    new CredentialResolver({}, noHelpers),
    { name: 'Test', email: 'test@example.com' },
    new ProjectRegistry(workspaceRoot),
  );
  const mcp = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return { client, workspaceRoot, dir: path.join(workspaceRoot, 'paper') };
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

async function configAll(dir: string, key: string): Promise<string[]> {
  try {
    const out = await simpleGit(dir).raw(['config', '-z', '--get-all', key]);
    return out.split('\0').filter((v) => v !== '');
  } catch {
    return [];
  }
}

async function originUrl(dir: string): Promise<string> {
  return (await configAll(dir, 'remote.origin.url')).join(' | ');
}

/** The ownership record, as the clone's own `.git/config` holds it. */
async function record(dir: string): Promise<{ heldUrl: string; originUrl: string } | undefined> {
  const out = await simpleGit(dir)
    .raw(['config', '--local', '-z', '--get-regexp', '^weblatexmcp\\.'])
    .catch(() => '');
  const entries = out
    .split('\0')
    .filter(Boolean)
    .map((e) => [e.slice(0, e.indexOf('\n')), e.slice(e.indexOf('\n') + 1)]);
  const get = (k: string) => entries.find(([key]) => key === k)?.[1];
  const heldUrl = get('weblatexmcp.heldurl');
  const origin = get('weblatexmcp.originurl');
  return heldUrl === undefined || origin === undefined ? undefined : { heldUrl, originUrl: origin };
}

async function dropRecord(dir: string): Promise<void> {
  await simpleGit(dir).raw(['config', '--local', '--remove-section', 'webLatexMcp']);
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

async function ok(client: Client, name: string, args: Record<string, unknown>) {
  const res = await call(client, name, args);
  expect(res.isError, textOf(res)).toBeFalsy();
  return res;
}

const sc = (res: unknown) =>
  (res as { structuredContent: { action: string; ahead: number; behind: number } })
    .structuredContent;

/** A cloned project `paper` at remote `a`, through `project_sync`. */
async function clonedAt(a: FakeRemote, sessionId = 's1') {
  const s = await session({ projects: [{ id: 'paper', gitUrl: a.url }], sessionId });
  await ok(s.client, 'project_sync', { project: 'paper' });
  return s;
}

/** Edit, commit and push from `client`; the push result. */
async function editCommitPush(client: Client, file: string, message: string) {
  await ok(client, 'write_file', { project: 'paper', path: file, content: `${message}\n` });
  await ok(client, 'commit', { project: 'paper', message });
  return ok(client, 'push', { project: 'paper', confirm: true });
}

async function log(r: FakeRemote): Promise<string> {
  return simpleGit().raw(['--git-dir', r.bareDir, 'log', '--format=%s', r.branch]);
}

describe('clone records that the server owns origin', () => {
  it('writes webLatexMcp.heldUrl and .originUrl after a clone', async () => {
    const a = await remote();
    const { dir } = await clonedAt(a);
    expect(await record(dir)).toEqual({ heldUrl: a.url, originUrl: a.url });
  });

  it('writes no record for a clone whose origin carries a credential: the server never owns one', async () => {
    const a = await remote();
    const server = await serveWithAuth(a, { username: 'git', password: SECRET });
    cleanups.push(server.close);
    const dir = path.join(await tmp('wlm-repoint-http-'), 'clone');
    const tokened = server.url.replace('http://', `http://git:${SECRET}@`);
    await new GitService().clone(tokened, dir, { username: 'git' });
    expect(await record(dir)).toBeUndefined();
  });
});

describe('project_sync: an origin the server owns follows the held URL', () => {
  it('a re-point fetches from the new remote: the commit only it has arrives, and the note names both URLs once', async () => {
    const a = await remote();
    const b = await forkWithCommit(a);
    const { client, dir } = await clonedAt(a);

    const res = await ok(client, 'project_sync', { project: 'paper', gitUrl: b.url });
    expect(sc(res).action).toBe('pulled');
    expect(await originUrl(dir)).toBe(b.url);
    expect(await record(dir)).toEqual({ heldUrl: b.url, originUrl: b.url });
    const text = textOf(res);
    expect(count(text, REPOINTED)).toBe(1);
    expect(text).toContain(quoteId(a.url));
    expect(text).toContain(quoteId(b.url));
    expect(Object.keys(res.structuredContent as object)).not.toContain('note');
  });

  it('a re-point to a repository that does not exist is an error, not up-to-date, and says origin moved once', async () => {
    const a = await remote();
    const { client, dir } = await clonedAt(a);
    const nowhere = await tmp('wlm-repoint-nowhere-');
    const missing = pathToFileURL(path.join(nowhere, 'no-such-repo.git')).href;

    const res = await call(client, 'project_sync', { project: 'paper', gitUrl: missing });
    expect(res.isError, textOf(res)).toBe(true);
    expect(await originUrl(dir)).toBe(missing);
    const text = textOf(res);
    expect(count(text, REPOINTED)).toBe(1);
    expect(text).toContain(quoteId(missing));
  });

  it('a mode "clone" refusal after the re-point still says origin moved, once', async () => {
    const a = await remote();
    const b = await forkWithCommit(a);
    const { client, dir } = await clonedAt(a);

    const res = await call(client, 'project_sync', {
      project: 'paper',
      gitUrl: b.url,
      mode: 'clone',
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/already cloned/);
    expect(count(text, REPOINTED)).toBe(1);
    expect(await originUrl(dir)).toBe(b.url);
  });

  it("a token added by hand to an owned origin makes it not the server's: a re-point is refused, redacted, the token left on disk", async () => {
    const a = await remote();
    const b = await forkWithCommit(a);
    const { client, dir } = await clonedAt(a);
    const tokened = `https://user:${SECRET}@git.example/x.git`;
    await simpleGit(dir).raw(['config', 'remote.origin.url', tokened]);
    // Even a record naming that URL tokenless does not make the token-bearing origin owned.
    await simpleGit(dir).raw(['config', 'webLatexMcp.originUrl', 'https://user@git.example/x.git']);

    const res = await call(client, 'project_sync', { project: 'paper', gitUrl: b.url });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).not.toContain(SECRET);
    // errorResult scrubs the whole userinfo of a URL in an error, login name included.
    expect(textOf(res)).toContain('@git.example/x.git');
    expect(textOf(res)).toMatch(/changed by hand/);
    expect(await originUrl(dir)).toBe(tokened);
  });
  it('names a pushurl that still decides where push goes, redacted', async () => {
    const a = await remote();
    const b = await forkWithCommit(a);
    const { client, dir } = await clonedAt(a);
    await simpleGit(dir).raw([
      'config',
      'remote.origin.pushurl',
      `https://user:${SECRET}@git.example/p.git`,
    ]);

    const res = await ok(client, 'project_sync', { project: 'paper', gitUrl: b.url });
    const text = textOf(res);
    expect(text).toMatch(/pushurl/);
    expect(text).toContain(quoteId('https://user:***@git.example/p.git'));
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });

  it('a session-only re-point does not outlive the session: a restart holding the registered URL fetches from it again', async () => {
    const a = await remote();
    const b = await forkWithCommit(a);
    const s1 = await session({ sessionId: 's1' });
    await ok(s1.client, 'register_project', { project: 'paper', gitUrl: a.url });
    await ok(s1.client, 'project_sync', { project: 'paper', gitUrl: b.url });
    expect(await originUrl(s1.dir)).toBe(b.url);

    const s2 = await session({ workspaceRoot: s1.workspaceRoot, sessionId: 's2' });
    const res = await ok(s2.client, 'project_sync', { project: 'paper' });
    expect(await originUrl(s2.dir)).toBe(a.url);
    // Judged against A, the commit pulled from B is one A does not have.
    expect(sc(res).ahead).toBe(1);
    expect(count(textOf(res), REPOINTED)).toBe(1);
  });

  it('an env-configured URL wins again after a restart, and origin follows it', async () => {
    const a = await remote();
    const b = await forkWithCommit(a);
    const projects = [{ id: 'paper', gitUrl: a.url }];
    const s1 = await session({ projects, env: true, sessionId: 's1' });
    await ok(s1.client, 'project_sync', { project: 'paper' });
    await ok(s1.client, 'register_project', { project: 'paper', gitUrl: b.url });
    await ok(s1.client, 'project_sync', { project: 'paper' });
    expect(await originUrl(s1.dir)).toBe(b.url);

    const s2 = await session({
      projects,
      env: true,
      workspaceRoot: s1.workspaceRoot,
      sessionId: 's2',
    });
    await ok(s2.client, 'project_sync', { project: 'paper' });
    expect(await originUrl(s2.dir)).toBe(a.url);
  });

  it('a relative gitUrl: git records origin absolutised, and every later sync still works', async (t) => {
    const a = await remote();
    const rel = path.relative(process.cwd(), a.bareDir);
    // On Windows a temp dir on another drive has no relative path.
    if (path.isAbsolute(rel)) t.skip();
    const s = await session({ projects: [{ id: 'paper', gitUrl: rel }] });
    await ok(s.client, 'project_sync', { project: 'paper' });
    const origin = await originUrl(s.dir);

    for (let i = 0; i < 2; i++) {
      const res = await ok(s.client, 'project_sync', { project: 'paper' });
      expect(textOf(res)).not.toContain(REPOINTED);
      expect(textOf(res)).not.toContain(UNOWNED);
      expect(await originUrl(s.dir)).toBe(origin);
    }
    expect(await record(s.dir)).toEqual({ heldUrl: rel, originUrl: origin });

    // A clone from before the record existed is adopted: git's absolutised form of the held path.
    await dropRecord(s.dir);
    const res = await ok(s.client, 'project_sync', { project: 'paper' });
    expect(textOf(res)).not.toContain(UNOWNED);
    expect(await record(s.dir)).toEqual({ heldUrl: rel, originUrl: origin });
    expect(await originUrl(s.dir)).toBe(origin);
  });
});

describe('project_sync: relative held paths are written as git clone writes them', () => {
  it('re-pointing an owned clone to a relative held path writes the absolute path, so fetch works and the sync pulls; its absolute form is no re-point', async (t) => {
    const a = await remote();
    const b = await forkWithCommit(a);
    const rel = path.relative(process.cwd(), b.bareDir);
    // On Windows a temp dir on another drive has no relative path.
    if (path.isAbsolute(rel)) t.skip();
    const { client, dir } = await clonedAt(a);

    const res = await ok(client, 'project_sync', { project: 'paper', gitUrl: rel });
    expect(sc(res).action).toBe('pulled');
    expect(count(textOf(res), REPOINTED)).toBe(1);
    expect(await originUrl(dir)).toBe(path.resolve(rel));
    await expect(simpleGit(dir).fetch('origin')).resolves.toBeDefined();
    const again = await ok(client, 'project_sync', { project: 'paper' });
    expect(sc(again).action).toBe('up-to-date');

    const abs = await ok(client, 'project_sync', { project: 'paper', gitUrl: path.resolve(rel) });
    expect(textOf(abs)).not.toContain(REPOINTED);
    expect(textOf(abs)).not.toContain(UNOWNED);
    expect(await record(dir)).toEqual({
      heldUrl: path.resolve(rel),
      originUrl: path.resolve(rel),
    });
  });
});

describe('a push mirror (several origin URLs) keeps working', () => {
  it('syncs and pushes with no refusal and no note while the first URL is the held one', async () => {
    const a = await remote();
    const root = await tmp('wlm-repoint-mirror-');
    const mirrorDir = path.join(root, 'mirror.git');
    await simpleGit().raw(['clone', '--bare', a.url, mirrorDir]);
    const mirror: FakeRemote = {
      url: pathToFileURL(mirrorDir).href,
      bareDir: mirrorDir,
      branch: a.branch,
      cleanup: async () => {},
    };
    const { client, dir } = await clonedAt(a);
    await simpleGit(dir).raw(['remote', 'set-url', '--add', 'origin', mirror.url]);

    const res = await ok(client, 'project_sync', { project: 'paper' });
    expect(textOf(res)).not.toMatch(/re-pointed|leaves it as it is|has 2 URLs/);
    const pushed = await editCommitPush(client, 'mirrored.tex', 'mirrored commit');
    expect(textOf(pushed)).not.toMatch(/re-pointed|leaves it as it is|has 2 URLs/);
    expect(await log(a)).toContain('mirrored commit');
    expect(await log(mirror)).toContain('mirrored commit');
    expect(await configAll(dir, 'remote.origin.url')).toEqual([a.url, mirror.url]);
    expect(await record(dir)).toEqual({ heldUrl: a.url, originUrl: a.url });
  });
});

describe('project_sync: an origin the server did not set is never rewritten', () => {
  it('a clone the old bug left at the old remote (no record) is named with the remedy, untouched; once the user re-points it, the next sync adopts it and pulls', async () => {
    const a = await remote();
    const b = await forkWithCommit(a);
    const workspaceRoot = await newWorkspace();
    const dir = path.join(workspaceRoot, 'paper');
    // Cloned by an older version: no record. The project now holds B; origin still says A.
    await simpleGit().clone(a.url, dir);
    const s = await session({ projects: [{ id: 'paper', gitUrl: b.url }], workspaceRoot });

    const res = await ok(s.client, 'project_sync', { project: 'paper' });
    const text = textOf(res);
    expect(count(text, UNOWNED)).toBe(1);
    expect(text).toContain(quoteId(a.url));
    expect(text).toContain(quoteId(b.url));
    expect(text).toContain('git remote set-url origin');
    expect(text).toContain(quoteId(toPosix(dir)));
    expect(sc(res).action).toBe('up-to-date');
    expect(await originUrl(dir)).toBe(a.url);
    expect(await record(dir)).toBeUndefined();

    await simpleGit(dir).raw(['remote', 'set-url', 'origin', b.url]);
    const after = await ok(s.client, 'project_sync', { project: 'paper' });
    expect(sc(after).action).toBe('pulled');
    expect(textOf(after)).not.toContain(UNOWNED);
    expect(await record(dir)).toEqual({ heldUrl: b.url, originUrl: b.url });
  });

  it('an env token URL the server cloned from: the note blames the configured URL, never offers a *** command, and names the way out', async () => {
    const a = await remote();
    const server = await serveWithAuth(a, { username: 'me', password: SECRET });
    cleanups.push(server.close);
    const tokened = server.url.replace('http://', `http://me:${SECRET}@`);
    const s = await session({ projects: [{ id: 'paper', gitUrl: tokened }], env: true });
    await ok(s.client, 'project_sync', { project: 'paper' });
    expect(await originUrl(s.dir)).toBe(tokened);

    const res = await ok(s.client, 'project_sync', { project: 'paper' });
    const text = textOf(res);
    expect(count(text, UNOWNED)).toBe(1);
    expect(text).toMatch(/configured URL embeds/);
    expect(text).toContain('WEB_LATEX_MCP_PROJECTS');
    expect(text).toContain('register_project');
    expect(text).not.toMatch(/older version|did not set/);
    const command = /`git remote set-url origin ([^`]*)`/.exec(text)?.[1];
    expect(command).toBe(quoteId(server.url.replace('http://', 'http://me@')));
    expect(JSON.stringify(res)).not.toContain(SECRET);
    expect(await originUrl(s.dir)).toBe(tokened);
  });

  it('an error after the reconcile carries a remedy the error scrubber cannot turn into a *** command; success shows the exact one', async () => {
    const a = await remote();
    const workspaceRoot = await newWorkspace();
    const dir = path.join(workspaceRoot, 'paper');
    await simpleGit().clone(a.url, dir);
    const held = 'https://org@dev.azure.com/org/p/_git/r';
    const s = await session({ projects: [{ id: 'paper', gitUrl: held }], workspaceRoot });

    const ok1 = await ok(s.client, 'project_sync', { project: 'paper' });
    expect(/`git remote set-url origin ([^`]*)`/.exec(textOf(ok1))?.[1]).toBe(quoteId(held));

    const res = await call(s.client, 'project_sync', { project: 'paper', mode: 'clone' });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/already cloned/);
    expect(count(text, UNOWNED)).toBe(1);
    expect(/`git remote set-url origin ([^`]*)`/.exec(text)?.[1]).toBe('<url>');
    expect(text).toContain('list_projects');
    expect(text).toContain(quoteId('org'));
  });

  it('a PAT the user put in origin is left on disk and named redacted, with the remedy, on every sync', async () => {
    const a = await remote();
    const server = await serveWithAuth(a, { username: 'me', password: SECRET });
    cleanups.push(server.close);
    const workspaceRoot = await newWorkspace();
    const dir = path.join(workspaceRoot, 'paper');
    const pat = server.url.replace('http://', `http://me:${SECRET}@`);
    await simpleGit().clone(pat, dir);
    const s = await session({ projects: [{ id: 'paper', gitUrl: server.url }], workspaceRoot });

    for (let i = 0; i < 2; i++) {
      const res = await ok(s.client, 'project_sync', { project: 'paper' });
      const text = textOf(res);
      expect(count(text, UNOWNED)).toBe(1);
      expect(text).toMatch(/holds a password or token/);
      expect(text).toContain(quoteId(server.url.replace('http://', 'http://me:***@')));
      expect(text).toContain('git remote set-url origin');
      expect(JSON.stringify(res)).not.toContain(SECRET);
      expect(await originUrl(dir)).toBe(pat);
      expect(await record(dir)).toBeUndefined();
    }
  });
});

describe('push and reset_to_remote report what they did to origin', () => {
  it('a peer session holding A pushes to A after another session pointed the clone at B, and says so', async () => {
    const a = await remote();
    const b = await forkWithCommit(a);
    const projects = [{ id: 'paper', gitUrl: a.url }];
    const s1 = await session({ projects, sessionId: 's1' });
    await ok(s1.client, 'project_sync', { project: 'paper' });
    const s2 = await session({ projects, workspaceRoot: s1.workspaceRoot, sessionId: 's2' });
    await ok(s1.client, 'project_sync', { project: 'paper', gitUrl: b.url });
    expect(await originUrl(s1.dir)).toBe(b.url);

    const pushed = await editCommitPush(s2.client, 'peer.tex', 'peer commit');
    expect(count(textOf(pushed), REPOINTED)).toBe(1);
    expect(await log(a)).toContain('peer commit');
    expect(await log(b)).not.toContain('peer commit');
    expect(await originUrl(s2.dir)).toBe(a.url);
  });

  it('a push with no sync first goes where the held URL says, and says origin moved', async () => {
    const a = await remote();
    const b = await forkWithCommit(a);
    const old = await clonedAt(a);
    const { client, dir } = await session({
      projects: [{ id: 'paper', gitUrl: b.url }],
      workspaceRoot: old.workspaceRoot,
      sessionId: 's2',
    });

    const pushed = await editCommitPush(client, 'direct.tex', 'pushed without a sync');
    expect(count(textOf(pushed), REPOINTED)).toBe(1);
    expect(await log(b)).toContain('pushed without a sync');
    expect(await log(a)).not.toContain('pushed without a sync');
    expect(await originUrl(dir)).toBe(b.url);
  });

  it('reset_to_remote re-points an owned origin, resets to the new remote, and says so', async () => {
    const a = await remote();
    const b = await forkWithCommit(a);
    const old = await clonedAt(a);
    const { client, dir } = await session({
      projects: [{ id: 'paper', gitUrl: b.url }],
      workspaceRoot: old.workspaceRoot,
      sessionId: 's2',
    });

    const res = await ok(client, 'reset_to_remote', { project: 'paper', confirm: true });
    expect(count(textOf(res), REPOINTED)).toBe(1);
    expect(await originUrl(dir)).toBe(b.url);
    expect(await readFile(path.join(dir, 'extra.tex'), 'utf8')).toBe('only on the fork\n');
  });
});

describe('a refused call writes nothing, and every remote operation reconciles on its own', () => {
  it('push refused on its arguments leaves an owned origin as it was', async () => {
    const a = await remote();
    const b = await forkWithCommit(a);
    const old = await clonedAt(a);
    const { client, dir } = await session({
      projects: [{ id: 'paper', gitUrl: b.url }],
      workspaceRoot: old.workspaceRoot,
      sessionId: 's2',
    });
    for (const [args, refusal] of [
      [
        { mode: 'branch', resolutions: [{ path: 'main.tex', content: 'x\n' }] },
        /only supported in direct mode/,
      ],
      [{ mode: 'branch' }, /requires a "branch" name/],
      [{ mode: 'branch', branch: 'review' }, /requires a commit "message"/],
    ] as const) {
      const res = await call(client, 'push', { project: 'paper', confirm: true, ...args });
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(textOf(res)).toMatch(refusal);
      expect(await originUrl(dir)).toBe(a.url);
      expect(await record(dir)).toEqual({ heldUrl: a.url, originUrl: a.url });
    }
  });

  it('GitService.syncPull alone — no explicit reconcile first — goes to the held URL of a server-owned clone', async () => {
    const a = await remote();
    const b = await forkWithCommit(a);
    const dir = path.join(await tmp('wlm-repoint-direct-'), 'clone');
    const git = new GitService();
    await git.clone(a.url, dir, { username: 'git' });
    const res = await git.syncPull(b.url, dir, { username: 'git' });
    expect(res.action).toBe('pulled');
    expect(await originUrl(dir)).toBe(b.url);
  });
});

describe('register_project writes nothing to a clone and previews the next operation', () => {
  it('says where the next operation will go; a sync then re-points and a push lands on the new remote', async () => {
    const a = await remote();
    const b = await forkWithCommit(a);
    const { client, dir } = await session();
    const first = await ok(client, 'register_project', { project: 'paper', gitUrl: a.url });
    expect(textOf(first)).not.toMatch(/re-points it/);

    const res = await ok(client, 'register_project', { project: 'paper', gitUrl: b.url });
    expect(textOf(res)).toContain(
      `The existing clone's origin is ${quoteId(a.url)}; the next project_sync, push or ` +
        `reset_to_remote re-points it to ${quoteId(b.url)}.`,
    );
    expect(await originUrl(dir)).toBe(a.url);

    const synced = await ok(client, 'project_sync', { project: 'paper' });
    expect(count(textOf(synced), REPOINTED)).toBe(1);
    expect(await originUrl(dir)).toBe(b.url);
    await editCommitPush(client, 'new.tex', 'after repoint');
    expect(await log(b)).toContain('after repoint');
    expect(await log(a)).not.toContain('after repoint');
  });

  it('re-stating the same URL adds no note', async () => {
    const a = await remote();
    const { client } = await session();
    await ok(client, 'register_project', { project: 'paper', gitUrl: a.url });
    const same = await ok(client, 'register_project', { project: 'paper', gitUrl: a.url });
    expect(textOf(same)).not.toMatch(
      /re-points it|no origin remote|leaves it as it is|will refuse/,
    );
  });

  it('a clone whose git config cannot be read still registers, with a note and every other note intact', async () => {
    const a = await remote();
    const { client, dir } = await session();
    await ok(client, 'register_project', { project: 'paper', gitUrl: a.url });
    await appendFile(path.join(dir, '.git', 'config'), '\n[[[ not git config\n');

    const res = await ok(client, 'register_project', {
      project: 'paper',
      gitUrl: `https://${SECRET}@git.example/paper.git`,
    });
    const text = textOf(res);
    expect(text).toMatch(/git config in .* could not be read/);
    // The credentials note survives (#245's lesson for a failed clone, here for a failed read).
    expect(text).toMatch(/removed and NOT stored/);
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });
});

describe('GitService.reconcileOrigin', () => {
  const git = new GitService();

  async function repo(): Promise<string> {
    const dir = await tmp('wlm-setorigin-');
    await simpleGit(dir).init();
    return dir;
  }

  /** A repo whose origin the server added (record written). */
  async function owned(url: string): Promise<string> {
    const dir = await repo();
    expect((await git.reconcileOrigin(dir, url)).kind).toBe('repointed');
    return dir;
  }

  it('adds origin, with a fetch refspec and the record, to a repository that has none', async () => {
    const dir = await repo();
    const out = await git.reconcileOrigin(dir, 'https://git.example/a.git');
    expect(out).toEqual({ kind: 'repointed', previous: undefined, pushUrls: [] });
    expect(await originUrl(dir)).toBe('https://git.example/a.git');
    expect(await configAll(dir, 'remote.origin.fetch')).toEqual([
      '+refs/heads/*:refs/remotes/origin/*',
    ]);
    expect(await record(dir)).toEqual({
      heldUrl: 'https://git.example/a.git',
      originUrl: 'https://git.example/a.git',
    });
  });

  it('adds origin to a repository whose remote.origin.url was removed but whose fetch refspec stayed, where `git remote add` says "already exists"', async () => {
    const dir = await repo();
    await simpleGit(dir).raw([
      'config',
      '--local',
      'remote.origin.fetch',
      '+refs/heads/*:refs/remotes/origin/*',
    ]);
    const out = await git.reconcileOrigin(dir, 'https://git.example/a.git');
    expect(out).toEqual({ kind: 'repointed', previous: undefined, pushUrls: [] });
    expect(await originUrl(dir)).toBe('https://git.example/a.git');
    expect(await configAll(dir, 'remote.origin.fetch')).toEqual([
      '+refs/heads/*:refs/remotes/origin/*',
    ]);
    expect(await record(dir)).toEqual({
      heldUrl: 'https://git.example/a.git',
      originUrl: 'https://git.example/a.git',
    });
  });

  it('adds origin beside a remote named `origin.foo`, whose keys are not leftovers of origin', async () => {
    const dir = await repo();
    await simpleGit(dir).raw(['remote', 'add', 'origin.foo', 'https://git.example/foo.git']);
    const out = await git.reconcileOrigin(dir, 'https://git.example/a.git');
    expect(out).toEqual({ kind: 'repointed', previous: undefined, pushUrls: [] });
    expect(await originUrl(dir)).toBe('https://git.example/a.git');
    expect(await configAll(dir, 'remote.origin.foo.url')).toEqual(['https://git.example/foo.git']);
    expect(await configAll(dir, 'remote.origin.foo.fetch')).toEqual([
      '+refs/heads/*:refs/remotes/origin.foo/*',
    ]);
  });

  it('never rewrites a hand-set SSH alias; refuses when the registration changed too; adopts once the user points it at the held URL', async () => {
    const a = 'https://git.example/o/r.git';
    const b = 'https://git.example/o/other.git';
    const dir = await owned(a);
    await simpleGit(dir).raw(['remote', 'set-url', 'origin', 'git@github-work:o/r.git']);

    expect(await git.reconcileOrigin(dir, a)).toEqual({
      kind: 'unowned',
      previous: 'git@github-work:o/r.git',
      pushUrls: [],
    });
    expect(await originUrl(dir)).toBe('git@github-work:o/r.git');
    expect(await record(dir)).toEqual({ heldUrl: a, originUrl: a });

    const err = await git.reconcileOrigin(dir, b).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toContain(quoteId('git@github-work:o/r.git'));
    expect(err?.message).toContain(quoteId(b));
    expect(err?.message).toContain('git remote set-url origin');
    expect(await originUrl(dir)).toBe('git@github-work:o/r.git');
    expect(await record(dir)).toEqual({ heldUrl: a, originUrl: a });

    await simpleGit(dir).raw(['remote', 'set-url', 'origin', b]);
    expect((await git.reconcileOrigin(dir, b)).kind).toBe('unchanged');
    expect(await record(dir)).toEqual({ heldUrl: b, originUrl: b });
  });

  it('adopts a clone with no record whose origin is the held URL — a UNC file URL included, with no phantom re-point', async () => {
    const dir = await repo();
    const unc = 'file://server/share/r.git';
    await simpleGit(dir).raw(['remote', 'add', 'origin', unc]);
    expect((await git.reconcileOrigin(dir, unc)).kind).toBe('unchanged');
    expect(await record(dir)).toEqual({ heldUrl: unc, originUrl: unc });
    expect((await git.reconcileOrigin(dir, unc)).kind).toBe('unchanged');
    expect(await originUrl(dir)).toBe(unc);
  });

  it('never adopts or writes a token-bearing origin; adding origin for a held URL carrying a token is refused, naming WEB_LATEX_MCP_PROJECTS', async () => {
    const dir = await repo();
    const tokened = `https://user:${SECRET}@git.example/o/r.git`;
    await simpleGit(dir).raw(['remote', 'add', 'origin', tokened]);
    // An env-configured token URL, cloned from as-is: origin equals the held URL, token and all.
    expect(await git.reconcileOrigin(dir, tokened)).toEqual({
      kind: 'unowned',
      previous: tokened,
      pushUrls: [],
      credentialOnDisk: true,
    });
    expect(await record(dir)).toBeUndefined();
    expect(
      (await git.reconcileOrigin(dir, `https://user:${SECRET}@git.example/o/other.git`)).kind,
    ).toBe('unowned');
    expect(await originUrl(dir)).toBe(tokened);

    const bare = await repo();
    const err = await git.reconcileOrigin(bare, tokened).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/carries a password or token/);
    expect(err?.message).toContain('WEB_LATEX_MCP_PROJECTS');
    expect(err?.message).not.toContain(SECRET);
    expect(await configAll(bare, 'remote.origin.url')).toEqual([]);
    expect(await record(bare)).toBeUndefined();
  });
  it('a hand-set PAT in origin (no record) is never written or adopted: the token stays on disk', async () => {
    const held = 'https://github.example/o/r.git';
    for (const pat of [
      `https://me:${SECRET}@github.example/o/r.git`,
      `https://${SECRET}@github.example/o/r.git`,
    ]) {
      const dir = await repo();
      await simpleGit(dir).raw(['remote', 'add', 'origin', pat]);
      expect(await git.reconcileOrigin(dir, held)).toEqual({
        kind: 'unowned',
        previous: pat,
        pushUrls: [],
        credentialOnDisk: true,
      });
      expect(await originUrl(dir)).toBe(pat);
      expect(await record(dir)).toBeUndefined();
    }
  });

  it('alice:TOKEN@ whose stripped form is the held alice@ URL is not adopted: no record written', async () => {
    const dir = await repo();
    const pat = `https://alice:${SECRET}@git.example/o/r.git`;
    await simpleGit(dir).raw(['remote', 'add', 'origin', pat]);
    const out = await git.reconcileOrigin(dir, 'https://alice@git.example/o/r.git');
    expect(out.kind).toBe('unowned');
    expect(out.credentialOnDisk).toBe(true);
    expect(await record(dir)).toBeUndefined();
    expect(await originUrl(dir)).toBe(pat);
  });

  it('a token added by hand to a server-owned origin: unowned while the registration is unchanged, refused when it changed — nothing written either way', async () => {
    const a = 'https://git.example/o/r.git';
    const dir = await owned(a);
    const pat = `https://me:${SECRET}@git.example/o/r.git`;
    await simpleGit(dir).raw(['remote', 'set-url', 'origin', pat]);

    const out = await git.reconcileOrigin(dir, a);
    expect(out).toEqual({ kind: 'unowned', previous: pat, pushUrls: [], credentialOnDisk: true });
    expect(await originUrl(dir)).toBe(pat);

    const err = await git.reconcileOrigin(dir, 'https://git.example/o/other.git').then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/changed by hand/);
    expect(err?.message).not.toContain(SECRET);
    expect(await originUrl(dir)).toBe(pat);
    expect(await record(dir)).toEqual({ heldUrl: a, originUrl: a });
  });

  it.skipIf(process.platform === 'win32')(
    'adopts an origin git recorded through a symlinked launch directory ($PWD), judged by realpath',
    async () => {
      const root = await tmp('wlm-repoint-link-');
      const real = path.join(root, 'real');
      await mkdir(path.join(real, 'r.git'), { recursive: true });
      const link = path.join(root, 'link');
      await symlink(real, link);
      const dir = await repo();
      // What `git clone r.git` records when $PWD is the symlinked launch dir.
      await simpleGit(dir).raw(['remote', 'add', 'origin', path.join(link, 'r.git')]);
      expect((await git.reconcileOrigin(dir, path.join(real, 'r.git'))).kind).toBe('unchanged');
      expect(await record(dir)).toEqual({
        heldUrl: path.join(real, 'r.git'),
        originUrl: path.join(link, 'r.git'),
      });
    },
  );
  it('an empty or valueless record key is no record: a hand-set origin is not rewritten through it', async () => {
    const alias = 'git@github-work:o/r.git';
    const held = 'https://git.example/o/other.git';
    for (const plant of [
      async (dir: string) => {
        await simpleGit(dir).raw(['config', 'webLatexMcp.heldUrl', '']);
        await simpleGit(dir).raw(['config', 'webLatexMcp.originUrl', alias]);
      },
      async (dir: string) => {
        await appendFile(path.join(dir, '.git', 'config'), '[webLatexMcp]\n\theldUrl\n');
        await simpleGit(dir).raw(['config', 'webLatexMcp.originUrl', alias]);
      },
      async (dir: string) => {
        await simpleGit(dir).raw(['config', '--add', 'webLatexMcp.heldUrl', 'x']);
        await simpleGit(dir).raw(['config', '--add', 'webLatexMcp.heldUrl', 'y']);
        await simpleGit(dir).raw(['config', 'webLatexMcp.originUrl', alias]);
      },
      async (dir: string) => {
        await simpleGit(dir).raw(['config', 'webLatexMcp.originUrl', alias]);
      },
    ]) {
      const dir = await repo();
      await simpleGit(dir).raw(['remote', 'add', 'origin', alias]);
      await plant(dir);
      expect((await git.reconcileOrigin(dir, held)).kind).toBe('unowned');
      expect(await originUrl(dir)).toBe(alias);
    }
  });

  it('takes values beginning with "-" as values, never as options, in origin and in the record', async () => {
    // scp-like (a ":" before any "/"), so written verbatim: a scheme-less value with no ":" is a
    // relative path git would resolve, and is written resolved (tested above).
    const dir = await repo();
    await git.reconcileOrigin(dir, '--upload-pack=touch:pwned');
    expect(await originUrl(dir)).toBe('--upload-pack=touch:pwned');
    expect(await record(dir)).toEqual({
      heldUrl: '--upload-pack=touch:pwned',
      originUrl: '--upload-pack=touch:pwned',
    });
    expect((await git.reconcileOrigin(dir, '-x:y')).kind).toBe('repointed');
    expect(await originUrl(dir)).toBe('-x:y');
    expect(await record(dir)).toEqual({ heldUrl: '-x:y', originUrl: '-x:y' });
  });

  it('refuses an origin with several URLs in fixed words that echo none of them, and works once fixed', async () => {
    const dir = await owned('https://git.example/one.git');
    await simpleGit(dir).raw([
      'config',
      '--add',
      'remote.origin.url',
      `https://user:${SECRET}@git.example/two.git`,
    ]);
    const err = await git.reconcileOrigin(dir, 'https://git.example/held.git').then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/has 2 URLs/);
    expect(err?.message).not.toContain(SECRET);
    expect(err?.message).not.toContain('one.git');

    await simpleGit(dir).raw(['config', '--unset-all', 'remote.origin.url']);
    await simpleGit(dir).raw(['config', 'remote.origin.url', 'https://git.example/one.git']);
    expect((await git.reconcileOrigin(dir, 'https://git.example/held.git')).kind).toBe('repointed');
    expect(await originUrl(dir)).toBe('https://git.example/held.git');
  });

  it('a failed write is reported in server words and leaves the record, so a retry re-points', async () => {
    const dir = await owned('https://git.example/old.git');
    const lock = path.join(dir, '.git', 'config.lock');
    await writeFile(lock, '');
    const err = await git.reconcileOrigin(dir, 'https://git.example/new.git').then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toContain(quoteId('https://git.example/new.git'));
    expect(err?.message).toMatch(/config\.lock/);
    expect(err?.message).not.toMatch(/fatal|error:/);
    expect(await record(dir)).toEqual({
      heldUrl: 'https://git.example/old.git',
      originUrl: 'https://git.example/old.git',
    });
    await rm(lock);
    expect((await git.reconcileOrigin(dir, 'https://git.example/new.git')).kind).toBe('repointed');
  });

  it('refuses to rewrite an origin defined in an included config file, writing nothing', async () => {
    const dir = await owned('https://git.example/old.git');
    // The user moved origin's URL into an included file; the record still matches it.
    await simpleGit(dir).raw(['config', '--unset', 'remote.origin.url']);
    const included = path.join(dir, '.git', 'remotes.inc');
    await writeFile(included, '[remote "origin"]\n\turl = https://git.example/old.git\n');
    await simpleGit(dir).raw(['config', 'include.path', 'remotes.inc']);
    expect(await configAll(dir, 'remote.origin.url')).toEqual(['https://git.example/old.git']);

    const err = await git.reconcileOrigin(dir, 'https://git.example/new.git').then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/defined outside its own \.git\/config/);
    // Nothing was written: origin still has exactly the one included URL, none in .git/config.
    expect(await configAll(dir, 'remote.origin.url')).toEqual(['https://git.example/old.git']);
    expect(
      await simpleGit(dir)
        .raw(['config', '--local', '--get-all', 'remote.origin.url'])
        .catch(() => ''),
    ).toBe('');
  });
});

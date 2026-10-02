import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { simpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import type { AppContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import type { ExecResult } from '../../src/lib/exec.js';
import type { ServerConfig } from '../../src/types.js';
import { createFakeRemote, pushCommit, type FakeRemote } from './helpers/bareRepo.js';

/**
 * Two server processes over one workspace converge on the latest PERSISTED registration
 * (`ProjectManager.refreshedGitConfig`).
 *
 * Every remote operation reconciles the shared clone's `origin` to the URL the calling process
 * holds, while the server owns it. A peer that loaded `paper` before another session re-registered
 * it at a new remote used to keep the old URL in its snapshot, so its next push re-pointed the
 * shared `origin` BACK and pushed there. Now `project_sync` (without `gitUrl`), `push` and
 * `reset_to_remote` adopt the registry's current entry first. A session-only
 * `project_sync { gitUrl }` still pins this session's URL — that one is the session's own choice —
 * unless it restates the registry's entry, which pins nothing.
 *
 * Two `createContext`s over one workspace stand in for two processes. Git runs hermetically.
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
  gitHome = await mkdtemp(path.join(os.tmpdir(), 'wlm-peer-repoint-git-'));
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

const noHelpers = async (): Promise<ExecResult> => ({
  code: 1,
  stdout: '',
  stderr: '',
  timedOut: false,
});

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

async function remote(): Promise<FakeRemote> {
  const r = await createFakeRemote({ 'main.tex': 'alpha\n' });
  cleanups.push(r.cleanup);
  return r;
}

/** A second bare repo sharing `base`'s history, plus one commit `base` does not have. */
async function fork(base: FakeRemote, file: string): Promise<FakeRemote> {
  const root = await tmp('wlm-peer-repoint-fork-');
  const bareDir = path.join(root, 'fork.git');
  await simpleGit().raw(['clone', '--bare', base.url, bareDir]);
  const f: FakeRemote = {
    url: pathToFileURL(bareDir).href,
    bareDir,
    branch: base.branch,
    cleanup: async () => {},
  };
  await pushCommit(f, { [file]: `only on ${file}\n` }, `${file} commit`);
  return f;
}

/** One server process over `workspaceRoot`, with the real registry and no projects of its own. */
async function session(workspaceRoot: string, sessionId: string): Promise<Client> {
  return (await sessionWithContext(workspaceRoot, sessionId)).client;
}

async function sessionWithContext(
  workspaceRoot: string,
  sessionId: string,
): Promise<{ client: Client; ctx: AppContext }> {
  const config: ServerConfig = { workspaceRoot, sessionId, projects: [] };
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
  return { client, ctx };
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

async function ok(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError, textOf(res)).toBeFalsy();
  return res;
}

async function originUrl(dir: string): Promise<string> {
  return (await simpleGit(dir).raw(['config', '--get-all', 'remote.origin.url'])).trim();
}

async function log(r: FakeRemote): Promise<string> {
  return simpleGit().raw(['--git-dir', r.bareDir, 'log', '--format=%s', r.branch]);
}

/**
 * Sessions A and B both hold `paper` at `a` (registered and cloned by A, loaded by B through a
 * sync of its own); then A re-registers it at `b` — persisted — and syncs, so `origin` is `b`.
 */
async function peersAfterRepoint() {
  const a = await remote();
  const b = await fork(a, 'b-only.tex');
  const workspaceRoot = path.join(await tmp('wlm-peer-repoint-'), 'ws');
  await mkdir(workspaceRoot, { recursive: true });
  const dir = path.join(workspaceRoot, 'paper');

  const sA = await session(workspaceRoot, 'sA');
  await ok(sA, 'register_project', { project: 'paper', gitUrl: a.url });
  await ok(sA, 'project_sync', { project: 'paper' });
  const sB = await session(workspaceRoot, 'sB');
  // B now holds `paper` at `a` in its snapshot.
  await ok(sB, 'project_sync', { project: 'paper' });

  await ok(sA, 'register_project', { project: 'paper', gitUrl: b.url });
  await ok(sA, 'project_sync', { project: 'paper' });
  expect(await originUrl(dir)).toBe(b.url);
  return { a, b, sA, sB, dir, workspaceRoot };
}

describe('a peer follows the persisted re-registration instead of flipping origin back', () => {
  it('push: B pushes to the re-registered remote, and origin stays there', async () => {
    const { a, b, sB, dir } = await peersAfterRepoint();

    await ok(sB, 'write_file', { project: 'paper', path: 'peer.tex', content: 'peer\n' });
    await ok(sB, 'commit', { project: 'paper', message: 'peer commit' });
    await ok(sB, 'push', { project: 'paper', confirm: true });

    expect(await originUrl(dir)).toBe(b.url);
    expect(await log(b)).toContain('peer commit');
    expect(await log(a)).not.toContain('peer commit');
  });

  it('project_sync without gitUrl: B fetches from the re-registered remote', async () => {
    const { b, sB, dir } = await peersAfterRepoint();
    await pushCommit(b, { 'later.tex': 'later\n' }, 'later on b');

    const res = await ok(sB, 'project_sync', { project: 'paper' });

    expect(await originUrl(dir)).toBe(b.url);
    expect((res.structuredContent as { action: string }).action).toBe('pulled');
    expect(await readFile(path.join(dir, 'later.tex'), 'utf8')).toBe('later\n');
  });

  it('reset_to_remote: B resets to the re-registered remote', async () => {
    const { sB, dir, b } = await peersAfterRepoint();

    await ok(sB, 'reset_to_remote', { project: 'paper', confirm: true });

    expect(await originUrl(dir)).toBe(b.url);
    expect(await readFile(path.join(dir, 'b-only.tex'), 'utf8')).toBe('only on b-only.tex\n');
  });

  it('restating the registered URL through project_sync { gitUrl } does not pin it', async () => {
    // B restates the very URL the registry holds; A then re-points `paper` and syncs. B's next
    // push must follow A's persisted registration, not flip `origin` back to the restated URL.
    const a = await remote();
    const b = await fork(a, 'b-only.tex');
    const workspaceRoot = path.join(await tmp('wlm-peer-repoint-'), 'ws');
    await mkdir(workspaceRoot, { recursive: true });
    const dir = path.join(workspaceRoot, 'paper');

    const sA = await session(workspaceRoot, 'sA');
    await ok(sA, 'register_project', { project: 'paper', gitUrl: a.url });
    await ok(sA, 'project_sync', { project: 'paper' });
    const sB = await session(workspaceRoot, 'sB');
    await ok(sB, 'project_sync', { project: 'paper', gitUrl: a.url });

    await ok(sA, 'register_project', { project: 'paper', gitUrl: b.url });
    await ok(sA, 'project_sync', { project: 'paper' });
    expect(await originUrl(dir)).toBe(b.url);

    await ok(sB, 'write_file', { project: 'paper', path: 'restated.tex', content: 'restated\n' });
    await ok(sB, 'commit', { project: 'paper', message: 'restated commit' });
    await ok(sB, 'push', { project: 'paper', confirm: true });

    expect(await originUrl(dir)).toBe(b.url);
    expect(await log(b)).toContain('restated commit');
    expect(await log(a)).not.toContain('restated commit');
  });

  it("restating through project_sync { gitUrl } from a stale snapshot takes the registry's fields", async () => {
    // B loaded `paper` at `a`; A re-registers it at `b` WITH a branch. B restates `b` from its
    // stale snapshot: planned from that snapshot it carried no branch, differed from the
    // registry's entry and pinned, so after A re-pointed again, B's push went back to `b`.
    const { a, b, sA, sB, dir } = await peersAfterRepoint();
    await ok(sA, 'register_project', { project: 'paper', gitUrl: b.url, branch: b.branch });
    await ok(sB, 'project_sync', { project: 'paper', gitUrl: b.url });

    const c = await fork(b, 'c-only.tex');
    await ok(sA, 'register_project', { project: 'paper', gitUrl: c.url });
    await ok(sA, 'project_sync', { project: 'paper' });
    expect(await originUrl(dir)).toBe(c.url);

    await ok(sB, 'write_file', { project: 'paper', path: 'stale.tex', content: 'stale\n' });
    await ok(sB, 'commit', { project: 'paper', message: 'stale commit' });
    await ok(sB, 'push', { project: 'paper', confirm: true });

    expect(await originUrl(dir)).toBe(c.url);
    expect(await log(c)).toContain('stale commit');
    expect(await log(b)).not.toContain('stale commit');
    expect(await log(a)).not.toContain('stale commit');
  });

  it('returning to the registered URL after a session-only re-point clears the pin', async () => {
    // B pins `paper` to `c` for itself, then restates the registry's `b` (registered WITH a
    // branch). Adopting the registry before planning would not help here — B's pinned config is
    // what it holds — so the restatement must be planned from the registry's entry to unpin.
    const { b, sA, sB, dir } = await peersAfterRepoint();
    const c = await fork(b, 'c-only.tex');
    await ok(sB, 'project_sync', { project: 'paper', gitUrl: c.url });
    expect(await originUrl(dir)).toBe(c.url);
    await ok(sA, 'register_project', { project: 'paper', gitUrl: b.url, branch: b.branch });
    await ok(sB, 'project_sync', { project: 'paper', gitUrl: b.url });
    expect(await originUrl(dir)).toBe(b.url);

    const d = await fork(c, 'd-only.tex');
    await ok(sA, 'register_project', { project: 'paper', gitUrl: d.url });
    await ok(sA, 'project_sync', { project: 'paper' });
    expect(await originUrl(dir)).toBe(d.url);

    await ok(sB, 'write_file', { project: 'paper', path: 'back.tex', content: 'back\n' });
    await ok(sB, 'commit', { project: 'paper', message: 'back commit' });
    await ok(sB, 'push', { project: 'paper', confirm: true });

    expect(await originUrl(dir)).toBe(d.url);
    expect(await log(d)).toContain('back commit');
    expect(await log(b)).not.toContain('back commit');
  });

  // A guard, not a regression test: it passes with and without the fix, since a session-only
  // registration is exactly what the snapshot already held. It pins that adoption never
  // overrides a URL this session chose for itself.
  it('a session-only project_sync { gitUrl } keeps its URL even after a peer re-registers', async () => {
    const { a, b, sA, sB, dir } = await peersAfterRepoint();
    const c = await fork(b, 'c-only.tex');
    await ok(sB, 'project_sync', { project: 'paper', gitUrl: c.url });
    expect(await originUrl(dir)).toBe(c.url);
    // A peer persists yet another registration; B's session-only choice still wins for B.
    await ok(sA, 'register_project', { project: 'paper', gitUrl: a.url });

    await ok(sB, 'write_file', { project: 'paper', path: 'pinned.tex', content: 'pinned\n' });
    await ok(sB, 'commit', { project: 'paper', message: 'pinned commit' });
    await ok(sB, 'push', { project: 'paper', confirm: true });

    expect(await originUrl(dir)).toBe(c.url);
    expect(await log(c)).toContain('pinned commit');
    expect(await log(a)).not.toContain('pinned commit');
  });
});

/**
 * A remote operation resolves its config (and credential) BEFORE it takes the project lock. A
 * peer's re-registration and sync that land in that window must not be undone by this call
 * reconciling `origin` back to the URL it captured: inside the lock the registration is re-read
 * (`ProjectManager.assertRegistrationUnchanged`) and the call refuses, touching nothing.
 *
 * The window is made deterministic by wrapping B's `runExclusive`: the peer's work runs after B's
 * pre-lock refresh and credential resolution and before B asks for the lock.
 */
describe('a registration that changed while the call waited for the lock is refused', () => {
  async function setup() {
    const a = await remote();
    const b = await fork(a, 'b-only.tex');
    const workspaceRoot = path.join(await tmp('wlm-peer-repoint-'), 'ws');
    await mkdir(workspaceRoot, { recursive: true });
    const dir = path.join(workspaceRoot, 'paper');

    const sA = await session(workspaceRoot, 'sA');
    await ok(sA, 'register_project', { project: 'paper', gitUrl: a.url });
    await ok(sA, 'project_sync', { project: 'paper' });
    const { client: sB, ctx: ctxB } = await sessionWithContext(workspaceRoot, 'sB');
    await ok(sB, 'project_sync', { project: 'paper' });

    /** Run A's re-registration to `b` (and its sync) once, just before B's next lock request. */
    function repointBeforeBLocks(): void {
      const pm = ctxB.projectManager;
      const original = pm.runExclusive.bind(pm);
      let fired = false;
      pm.runExclusive = (async (id: string, fn: Parameters<typeof original>[1]) => {
        if (!fired) {
          fired = true;
          await ok(sA, 'register_project', { project: 'paper', gitUrl: b.url });
          await ok(sA, 'project_sync', { project: 'paper' });
        }
        return original(id, fn);
      }) as typeof pm.runExclusive;
    }
    return { a, b, sA, sB, dir, repointBeforeBLocks };
  }

  async function refused(client: Client, name: string, args: Record<string, unknown>) {
    const res = await client.callTool({ name, arguments: args });
    expect(res.isError, textOf(res)).toBe(true);
    return textOf(res);
  }

  function expectRefusal(text: string, a: FakeRemote, b: FakeRemote): void {
    expect(text).toContain('"paper"');
    expect(text).toContain('changed while this call waited for the project lock');
    expect(text).toContain(`gitUrl "${a.url}" → "${b.url}"`);
    expect(text).toContain('nothing was fetched or pushed');
  }

  it('push', async () => {
    const { a, b, sB, dir, repointBeforeBLocks } = await setup();
    await ok(sB, 'write_file', { project: 'paper', path: 'race.tex', content: 'race\n' });
    await ok(sB, 'commit', { project: 'paper', message: 'race commit' });
    const aBefore = await log(a);
    const bBefore = await log(b);

    repointBeforeBLocks();
    const text = await refused(sB, 'push', { project: 'paper', confirm: true });

    expectRefusal(text, a, b);
    expect(await originUrl(dir)).toBe(b.url);
    expect(await log(a)).toBe(aBefore);
    expect(await log(b)).toBe(bBefore);
    // The retry follows the new registration.
    await ok(sB, 'push', { project: 'paper', confirm: true });
    expect(await originUrl(dir)).toBe(b.url);
    expect(await log(b)).toContain('race commit');
    expect(await log(a)).not.toContain('race commit');
  });

  it('project_sync without gitUrl', async () => {
    const { a, b, sB, dir, repointBeforeBLocks } = await setup();
    repointBeforeBLocks();
    const text = await refused(sB, 'project_sync', { project: 'paper' });
    expectRefusal(text, a, b);
    expect(await originUrl(dir)).toBe(b.url);
  });

  it('reset_to_remote', async () => {
    const { a, b, sB, dir, repointBeforeBLocks } = await setup();
    repointBeforeBLocks();
    const text = await refused(sB, 'reset_to_remote', { project: 'paper', confirm: true });
    expectRefusal(text, a, b);
    expect(await originUrl(dir)).toBe(b.url);
    // Still where the peer's sync left it — `b`'s head — not reset to `a`'s.
    const bHead = (await simpleGit().raw(['--git-dir', b.bareDir, 'rev-parse', b.branch])).trim();
    expect((await simpleGit(dir).revparse(['HEAD'])).trim()).toBe(bHead);
    expect(await readFile(path.join(dir, 'b-only.tex'), 'utf8')).toBe('only on b-only.tex\n');
  });
});

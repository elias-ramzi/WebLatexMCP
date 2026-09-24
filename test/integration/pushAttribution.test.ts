import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { simpleGit } from 'simple-git';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import { createContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import { sessionDir } from '../../src/lib/sessionPaths.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * Push-refusal attribution and status freshness (issue #61, Task C): when a live peer's
 * uncommitted work blocks a push, the refusal names which peer owns which disputed file and how
 * long ago it last wrote — and `status` surfaces the same per-peer freshness. Copied harness from
 * test/integration/multiSession.test.ts (real MCP clients over a local bare repo, no network).
 */

const REL = 'sections/method.tex';

const BASE = [
  '\\section{Method}',
  'The first paragraph opens the method.',
  'It then states the assumption.',
  '',
  'The second paragraph defines the loss.',
  'It closes with the optimisation detail.',
  '',
].join('\n');

const IDENTITY = { name: 'Test', email: 'test@example.com' };

interface Session {
  client: Client;
  close: () => Promise<void>;
}

describe('push refusal attribution and status freshness', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(): Promise<{
    remote: FakeRemote;
    dir: string;
    workspace: string;
    session: (id: string) => Promise<Session>;
  }> {
    const remote = await createFakeRemote({ [REL]: BASE });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-pushattr-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));

    const baseConfig = {
      workspaceRoot: workspace,
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
    };
    const dir = path.join(workspace, 'demo');
    await new GitService(IDENTITY).clone(remote.url, dir, { username: 'git' });

    const session = async (id: string): Promise<Session> => {
      const config: ServerConfig = { ...baseConfig, sessionId: id };
      const ctx = createContext(config, new CredentialResolver({}), IDENTITY);
      const server = createServer(ctx);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: `test-${id}`, version: '0.0.0' });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const close = (): Promise<void> => client.close();
      cleanups.push(close);
      return { client, close };
    };

    return { remote, dir, workspace, session };
  }

  async function call<T = Record<string, unknown>>(
    session: Session,
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const res = await session.client.callTool({ name, arguments: args });
    if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.content)}`);
    return res.structuredContent as T;
  }

  async function callExpectingError(
    session: Session,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const res = await session.client.callTool({ name, arguments: args });
    expect(res.isError, `${name} was expected to fail`).toBe(true);
    return JSON.stringify(res.content);
  }

  const editA = (s: Session): Promise<unknown> =>
    call(s, 'edit_file', {
      path: REL,
      edits: [
        {
          oldString: 'It then states the assumption.',
          newString: 'It states the assumption, per A.',
        },
      ],
    });

  const editB = (s: Session): Promise<unknown> =>
    call(s, 'edit_file', {
      path: REL,
      edits: [
        {
          oldString: 'The second paragraph defines the loss.',
          newString: 'The second paragraph defines the loss, per B.',
        },
      ],
    });

  it('names the owning peer and dates its last write in a push refusal', async () => {
    const { session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');

    await editA(a);
    await editB(b);
    await call(a, 'commit', { message: 'A: revise the assumption' });

    const err = await callExpectingError(a, 'push', { message: 'push A', confirm: true });
    // err is a JSON.stringify of the MCP content array, so a literal `"` inside the message text
    // comes back escaped as `\"`.
    expect(err).toContain('beta\\" owns sections/method.tex');
    expect(err).toContain('last write');
    expect(err).toContain('ago');
    expect(err).not.toContain('No live session owns');
  });

  it('reports a disputed file as unowned when the live peer has no shadow entry for it', async () => {
    const { dir, session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');
    // Get beta to register itself as a live session, without editing anything.
    await call(b, 'status', {});

    // A change made outside the server entirely — nobody's shadow claims it.
    await writeFile(path.join(dir, 'notes.txt'), 'hand written\n', 'utf8');

    const err = await callExpectingError(a, 'push', { message: 'push A', confirm: true });
    expect(err).toContain('No live session owns notes.txt');
    expect(err).toContain('beta\\" owns nothing here');
  });

  it('refuses a push over a path staged by hand only — dirty in the index, not the working tree', async () => {
    // `status.staged` must join the peer guard's dirty set the same way it joins `status`'s own
    // `otherChanges`: a path modified only in the index (someone ran `git add` by hand, or an
    // interrupted `commitContents`) is invisible to git's unstaged/untracked lists, but it is
    // still uncommitted work a push's rebase would have to sweep up or overwrite. Before this fix,
    // `guardPeerWork` never saw it, so push proceeded straight into `GitService.safePush`, whose
    // own pre-rebase check (`trackedModifiedPaths`) then refused it with a differently-worded,
    // unattributed message — never naming beta as a possible owner.
    const { dir, session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');
    // Register beta as a live session, without editing anything through the server.
    await call(b, 'status', {});

    // A brand-new file staged directly with git, bypassing the server entirely: `git status`
    // reports it neither unstaged nor untracked, only staged.
    await writeFile(path.join(dir, 'notes.txt'), 'hand staged\n', 'utf8');
    await simpleGit(dir).add(['notes.txt']);

    // No `message`: a push that auto-commits the whole working tree (message given) would just
    // silently sweep the staged file into alpha's commit rather than fail — this scenario is
    // about the guard refusing *before* any commit/rebase is attempted at all.
    const err = await callExpectingError(a, 'push', { confirm: true });
    expect(err).toContain('No live session owns notes.txt');
  });

  it('flags an unreadable peer index in the refusal rather than treating it as owning nothing', async () => {
    const { workspace, session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');

    await editA(a);
    await editB(b);
    await call(a, 'commit', { message: 'A: revise the assumption' });

    // Corrupt beta's shadow index directly, as if it were left in a bad state.
    await writeFile(
      path.join(sessionDir(workspace, 'demo', 'beta'), 'shadow.json'),
      'not json',
      'utf8',
    );

    const err = await callExpectingError(a, 'push', { message: 'push A', confirm: true });
    expect(err).toContain('unreadable');
  });

  it("status reports a peer's changes and a parseable last-write timestamp", async () => {
    const { session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');

    await editA(a);
    await editB(b);
    await call(a, 'commit', { message: 'A: revise the assumption' });

    const statusA = await call<{
      activeSessions: Array<{
        session: string;
        changes: string[] | null;
        lastWriteAt: string | null;
      }>;
    }>(a, 'status', {});

    const beta = statusA.activeSessions.find((s) => s.session === 'beta');
    expect(beta).toBeDefined();
    expect(beta?.changes).toContain(REL);
    expect(beta?.lastWriteAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(beta?.lastWriteAt as string))).toBe(false);

    const res = await a.client.callTool({ name: 'status', arguments: {} });
    const text = (res.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('\n');
    expect(text).toContain('last write');
  });

  it("status reports a peer's index as unreadable rather than as no changes", async () => {
    const { workspace, session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');

    await editA(a);
    await editB(b);
    await call(a, 'commit', { message: 'A: revise the assumption' });

    await writeFile(
      path.join(sessionDir(workspace, 'demo', 'beta'), 'shadow.json'),
      'not json',
      'utf8',
    );

    const statusA = await call<{
      activeSessions: Array<{ session: string; changes: string[] | null }>;
    }>(a, 'status', {});
    const beta = statusA.activeSessions.find((s) => s.session === 'beta');
    expect(beta?.changes).toBeNull();

    const res = await a.client.callTool({ name: 'status', arguments: {} });
    const text = (res.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('\n');
    expect(text).toContain('index unreadable');
  });

  it("caps a peer's paths in status's text line but keeps the structured `changes` complete", async () => {
    const { workspace, session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');
    // Register beta as live without going through edit_file, then write its shadow index by hand
    // with more entries than the text line should show.
    await call(b, 'status', {});

    const paths = Array.from({ length: 7 }, (_, i) => `sections/part${i}.tex`);
    const entries = Object.fromEntries(
      paths.map((p, i) => [
        p,
        {
          deleted: false,
          baseExists: true,
          touchedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        },
      ]),
    );
    await writeFile(
      path.join(sessionDir(workspace, 'demo', 'beta'), 'shadow.json'),
      JSON.stringify({ entries }, null, 2),
      'utf8',
    );

    const statusA = await call<{
      activeSessions: Array<{ session: string; changes: string[] | null }>;
    }>(a, 'status', {});
    const beta = statusA.activeSessions.find((s) => s.session === 'beta');
    expect(beta?.changes).toHaveLength(7);

    const res = await a.client.callTool({ name: 'status', arguments: {} });
    const text = (res.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('\n');
    expect(text).toContain('and 2 more');
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import { createContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * Two agent sessions, two servers, one shared clone — the case this whole mechanism exists for.
 *
 * Each session gets its own `AppContext` over the same workspace, exactly as two Claude sessions
 * launched in the same directory would. The tools are driven through a real MCP client so the
 * wiring (tool schemas, session scoping, result shape) is exercised, not just the services.
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

describe('two sessions sharing one clone', () => {
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
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-multi-'));
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

  /** Call a tool and return its structured result, failing loudly on a tool error. */
  async function call<T = Record<string, unknown>>(
    session: Session,
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const res = await session.client.callTool({ name, arguments: args });
    if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.content)}`);
    return res.structuredContent as T;
  }

  /** Call a tool expecting it to fail, returning the error text. */
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

  it("commits one session's paragraph and leaves the other's in the working tree", async () => {
    const { dir, session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');

    await editA(a);
    await editB(b);

    // Both edits are on disk — the document really does contain both.
    const onDisk = await readFile(path.join(dir, REL), 'utf8');
    expect(onDisk).toContain('per A.');
    expect(onDisk).toContain('per B.');

    const committed = await call<{
      files: Array<{ path: string }>;
      scope: string;
      session: string;
      leftUncommitted: string[];
      sha: string;
    }>(a, 'commit', { message: 'A: revise the assumption' });

    expect(committed.scope).toBe('session');
    expect(committed.session).toBe('alpha');
    expect(committed.files.map((f) => f.path)).toEqual([REL]);

    // The commit holds A's line only.
    const inCommit = await simpleGit(dir).show([`${committed.sha}:${REL}`]);
    expect(inCommit).toContain('per A.');
    expect(inCommit).not.toContain('per B.');

    // B's edit is untouched on disk, and reported as deliberately left behind.
    expect(await readFile(path.join(dir, REL), 'utf8')).toBe(onDisk);
    expect(committed.leftUncommitted).toEqual([REL]);

    // B can then commit its own line, on top of A's.
    const second = await call<{ sha: string; leftUncommitted: string[] }>(b, 'commit', {
      message: 'B: revise the loss',
    });
    expect(second.leftUncommitted).toEqual([]);
    const final = await simpleGit(dir).show([`${second.sha}:${REL}`]);
    expect(final).toContain('per A.');
    expect(final).toContain('per B.');
    expect((await simpleGit(dir).status()).isClean()).toBe(true);
  });

  it('reports who owns which uncommitted change, and who else is active', async () => {
    const { session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');
    await editA(a);
    await editB(b);

    const statusA = await call<{
      session: string;
      sessionChanges: string[];
      otherChanges: string[];
      activeSessions: Array<{ session: string; live: boolean }>;
    }>(a, 'status', {});

    expect(statusA.session).toBe('alpha');
    expect(statusA.sessionChanges).toEqual([REL]);
    // The file is dirty for both reasons, so it is A's — `otherChanges` lists only what A did not
    // touch at all.
    expect(statusA.otherChanges).toEqual([]);
    expect(statusA.activeSessions.map((s) => s.session)).toContain('beta');
    expect(statusA.activeSessions.every((s) => s.live)).toBe(true);

    const statusB = await call<{ session: string; sessionChanges: string[] }>(b, 'status', {});
    expect(statusB.session).toBe('beta');
    expect(statusB.sessionChanges).toEqual([REL]);
  });

  it('does not let a session commit a file it never touched', async () => {
    const { session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');
    await editA(a);
    await editB(b);

    // B asks to commit by path — but names a file only it did not create a change for.
    const err = await callExpectingError(b, 'commit', {
      message: 'B: everything',
      paths: ['sections/other.tex'],
    });
    expect(err).toContain('Not changed by this session');
  });

  it('flags a same-line collision between sessions instead of guessing whose it is', async () => {
    const { dir, session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');

    // A rewrites a sentence; B then rewrites the very same sentence.
    await call(a, 'edit_file', {
      path: REL,
      edits: [
        {
          oldString: 'It then states the assumption.',
          newString: 'It states the assumption, per A.',
        },
      ],
    });
    await call(b, 'edit_file', {
      path: REL,
      edits: [
        {
          oldString: 'It states the assumption, per A.',
          newString: 'It states the assumption, per B.',
        },
      ],
    });

    // B's shadow cannot be maintained through that, so the file is flagged rather than guessed at.
    const statusB = await call<{ conflictedChanges: string[] }>(b, 'status', {});
    expect(statusB.conflictedChanges).toEqual([REL]);

    const err = await callExpectingError(b, 'commit', { message: 'B: revise the assumption' });
    expect(err).toContain('same lines');

    // The documented way out: deliberately take the working tree as it stands.
    const taken = await call<{ scope: string; sha: string }>(b, 'commit', {
      message: 'B: take the current text',
      scope: 'all',
    });
    expect(taken.scope).toBe('all');
    const inCommit = await simpleGit(dir).show([`${taken.sha}:${REL}`]);
    expect(inCommit).toContain('per B.');
    expect((await simpleGit(dir).status()).isClean()).toBe(true);
  });

  it('falls back to committing everything when the session has no tracked changes', async () => {
    const { dir, session } = await setup();
    const a = await session('alpha');

    // A change made outside the server entirely — nobody's session owns it.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'notes.txt'), 'hand written\n', 'utf8');

    const res = await call<{ scope: string; files: Array<{ path: string }> }>(a, 'commit', {
      message: 'sweep up',
    });
    expect(res.scope).toBe('all');
    expect(res.files.map((f) => f.path)).toEqual(['notes.txt']);
  });

  it('refuses to push while a live peer has uncommitted work', async () => {
    const { session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');
    await editA(a);
    await editB(b);
    await call(a, 'commit', { message: 'A: revise the assumption' });

    // A's work is committed, but B's paragraph is still in flight — pushing would have to rebase
    // over it.
    const err = await callExpectingError(a, 'push', { message: 'push A', confirm: true });
    expect(err).toContain('not this session');
    expect(err).toContain('beta');
  });

  it('pushes once the peer has committed', async () => {
    const { remote, dir, session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');
    await editA(a);
    await editB(b);
    await call(a, 'commit', { message: 'A: revise the assumption' });
    await call(b, 'commit', { message: 'B: revise the loss' });

    const pushed = await call<{ status: string }>(a, 'push', { confirm: true });
    expect(pushed.status).toBe('pushed');

    const verify = await mkdtemp(path.join(os.tmpdir(), 'wlm-verify-'));
    cleanups.push(() => rm(verify, { recursive: true, force: true }));
    await simpleGit().clone(remote.url, verify);
    const remoteContent = await readFile(path.join(verify, REL), 'utf8');
    expect(remoteContent).toContain('per A.');
    expect(remoteContent).toContain('per B.');
    expect(await readFile(path.join(dir, REL), 'utf8')).toBe(remoteContent);
  });

  it("drops every session's tracked work when discard rewrites the tree", async () => {
    const { session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');
    await editA(a);
    await editB(b);

    await call(a, 'discard', { confirm: true });

    // Both sessions' changes are gone from disk, so neither may still claim them.
    const statusA = await call<{ sessionChanges: string[]; clean: boolean }>(a, 'status', {});
    const statusB = await call<{ sessionChanges: string[] }>(b, 'status', {});
    expect(statusA.clean).toBe(true);
    expect(statusA.sessionChanges).toEqual([]);
    expect(statusB.sessionChanges).toEqual([]);
  });
});

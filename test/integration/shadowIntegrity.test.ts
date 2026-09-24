import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFakeRemote } from './helpers/bareRepo.js';
import { createContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import { sessionDir } from '../../src/lib/sessionPaths.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * The shadow store's integrity under the two ways it was found to lose a session's claim on its
 * own lines — so a live peer's `commit scope: "paths"` could take them, or they were never
 * committed by anyone:
 *
 *  - a conflicted entry whose shadow is MISSING one of this session's writes (a record-time
 *    collision, or a write that landed while the entry was already conflicted) being cleared by
 *    a later `refresh` once a peer's commit made the stale shadow merge cleanly;
 *  - `status` (read-only, no lock) persisting its refresh of the shadow index, overwriting a
 *    concurrent `record` from this session's own write and resurrecting entries a peer's
 *    `discard` had just settled.
 *
 * Plus the reverted-to-HEAD entry `refresh` never dropped (so it wedged a peer's `scope: "paths"`),
 * and a malformed peer `session.json` that broke `status` for every session.
 *
 * Real MCP clients over one shared clone of a local bare repo, one `AppContext` per session.
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
}

describe('shadow store integrity across sessions', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(): Promise<{
    dir: string;
    workspace: string;
    session: (id: string) => Promise<Session>;
  }> {
    const remote = await createFakeRemote({ [REL]: BASE });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-shadowint-'));
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
      cleanups.push(() => client.close());
      return { client };
    };

    return { dir, workspace, session };
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

  const edit = (s: Session, oldString: string, newString: string): Promise<unknown> =>
    call(s, 'edit_file', {
      path: REL,
      overrideExternalChanges: true,
      edits: [{ oldString, newString }],
    });

  /**
   * B edits one line; A edits another; B then rewrites A's (still uncommitted) line — a
   * record-time collision, so that write never reaches B's shadow — and edits a third line while
   * the entry is conflicted, which never reaches it either. B's shadow therefore holds only its
   * first line. When A's commit lands, that incomplete shadow merges cleanly onto the new HEAD.
   */
  async function collide(a: Session, b: Session): Promise<void> {
    await edit(
      b,
      'The second paragraph defines the loss.',
      'The second paragraph defines the loss, per B.',
    );
    await edit(a, 'It then states the assumption.', 'It states the assumption, per A.');
    await edit(b, 'It states the assumption, per A.', 'It states the assumption, per B.');
    await edit(b, 'It closes with the optimisation detail.', 'It closes, per B-late.');
  }

  it('a record-time collision stays conflicted after a peer commit makes the stale shadow merge cleanly', async () => {
    const { session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');
    await collide(a, b);

    const before = await call<{ conflictedChanges: string[] }>(b, 'status', {});
    expect(before.conflictedChanges).toEqual([REL]);

    await call(a, 'commit', { message: 'A' });

    // Pre-fix, refresh merged B's one-line shadow onto A's commit, cleared the flag, and B's
    // colliding and later writes were owned by nobody.
    const after = await call<{ conflictedChanges: string[] }>(b, 'status', {});
    expect(after.conflictedChanges).toEqual([REL]);
  });

  it('the colliding session\'s lines are never committed without them, nor taken by a live peer\'s scope "paths"', async () => {
    const { dir, session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');
    await collide(a, b);
    const landedA = await call<{ sha: string }>(a, 'commit', { message: 'A' });

    // B's session commit must not land its incomplete shadow (which lacks "per B" on A's line
    // and "per B-late"): the entry is excluded, so there is nothing of B's to commit.
    const resB = await b.client.callTool({ name: 'commit', arguments: { message: 'B' } });
    expect(resB.isError).toBe(true);
    expect(await simpleGit(dir).revparse(['HEAD'])).toBe(landedA.sha);

    // And B still owns the file, so A (a live peer) cannot sweep B's lines up by naming it.
    const resA = await a.client.callTool({
      name: 'commit',
      arguments: { message: 'A takes', scope: 'paths', paths: [REL] },
    });
    expect(resA.isError).toBe(true);
    expect(await simpleGit(dir).revparse(['HEAD'])).toBe(landedA.sha);
    const onDisk = await readFile(path.join(dir, REL), 'utf8');
    expect(onDisk).toContain('It closes, per B-late.');
  });

  it("status racing this session's own write_file never loses the write's shadow entry", async () => {
    const { session } = await setup();
    const a = await session('alpha');
    // Seed entries so a refresh has work between reading and writing the index.
    for (let i = 0; i < 4; i++) {
      await call(a, 'write_file', { path: `seed${i}.tex`, content: `seed ${i}\n` });
    }
    const lost: string[] = [];
    for (let i = 0; i < 8; i++) {
      const rel = `race${i}.tex`;
      await Promise.all([
        call(a, 'status', {}),
        new Promise((r) => setTimeout(r, (i % 5) * 3)).then(() =>
          call(a, 'write_file', { path: rel, content: `race ${i}\n` }),
        ),
      ]);
      const st = await call<{ sessionChanges: string[] }>(a, 'status', {});
      if (!st.sessionChanges.includes(rel)) lost.push(rel);
    }
    expect(lost).toEqual([]);
  });

  it("status racing a peer's path-limited discard never resurrects the settled entry", async () => {
    const { dir, workspace, session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');
    for (let i = 0; i < 4; i++) {
      await call(a, 'write_file', { path: `seed${i}.tex`, content: `seed ${i}\n` });
    }
    const index = path.join(sessionDir(workspace, 'demo', 'alpha'), 'shadow.json');
    let resurrected = 0;
    for (let i = 0; i < 8; i++) {
      await edit(
        a,
        'The first paragraph opens the method.',
        `The first paragraph opens the method, v${i}.`,
      );
      // Stagger the discard across the status call's refresh window.
      await Promise.all([
        call(b, 'discard', { paths: [REL], confirm: true }),
        new Promise((r) => setTimeout(r, (i % 8) * 15)).then(() => call(a, 'status', {})),
      ]);
      const onDisk = await readFile(path.join(dir, REL), 'utf8');
      expect(onDisk).toBe(BASE);
      const raw = JSON.parse(await readFile(index, 'utf8')) as {
        entries: Record<string, unknown>;
      };
      if (REL in raw.entries) resurrected++;
    }
    expect(resurrected).toBe(0);
  });

  it('two concurrent status calls in one session both succeed', async () => {
    const { session } = await setup();
    const a = await session('alpha');
    for (let i = 0; i < 4; i++) {
      await call(a, 'write_file', { path: `seed${i}.tex`, content: `seed ${i}\n` });
    }
    for (let i = 0; i < 4; i++) {
      const results = await Promise.all(
        [0, 1, 2].map(() => a.client.callTool({ name: 'status', arguments: {} })),
      );
      for (const r of results) expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    }
  });

  it('an edit reverted by hand to HEAD\'s text is dropped, so it never wedges a peer\'s scope "paths"', async () => {
    const { dir, session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');
    await edit(a, 'It then states the assumption.', 'It states the assumption, per A.');
    await edit(a, 'It states the assumption, per A.', 'It then states the assumption.');
    expect(await readFile(path.join(dir, REL), 'utf8')).toBe(BASE);

    // A's commit refreshes its shadow under the lock: the entry equals HEAD, so it is settled
    // rather than kept forever. (There is genuinely nothing to commit, so it still refuses.)
    const resA = await a.client.callTool({ name: 'commit', arguments: { message: 'A' } });
    expect(resA.isError).toBe(true);

    // B now edits the file and takes it by name. A holds nothing there, so this must not be
    // refused as a live peer's work.
    await edit(b, 'The second paragraph defines the loss.', 'The loss, per B.');
    const resB = await call<{ committed: boolean }>(b, 'commit', {
      message: 'B',
      scope: 'paths',
      paths: [REL],
    });
    expect(resB.committed).toBe(true);
  });

  it('a peer session.json missing its heartbeat does not break status', async () => {
    const { workspace, session } = await setup();
    const a = await session('alpha');
    await call(a, 'write_file', { path: 'x.tex', content: 'x\n' });
    const broken = sessionDir(workspace, 'demo', 'broken');
    await mkdir(broken, { recursive: true });
    await writeFile(path.join(broken, 'session.json'), JSON.stringify({ pid: 1 }), 'utf8');

    const res = await a.client.callTool({ name: 'status', arguments: {} });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  });
});

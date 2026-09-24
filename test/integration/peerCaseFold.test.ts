import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, link } from 'node:fs/promises';
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
 * The one by-name lookup PR #67 left byte-exact: the `scope: "paths"` peer-ownership check and
 * push's peer attribution compare shadow index keys (the caller's spelling) against requested or
 * git-reported paths without folding case. On a `core.ignorecase = true` clone (git's default on
 * macOS/Windows) `Notes.txt` and `notes.txt` are one file, so a live peer whose shadow lists
 * `notes.txt` did not protect a `commit scope:"paths" paths:["Notes.txt"]` — which then staged the
 * peer's lines — and a push refusal attributed git's `Notes.txt` to nobody.
 *
 * Same fixture as sessionCaseFold.test.ts: `core.ignorecase` forced explicitly, and the two
 * spellings hard-linked onto one inode so an in-place write through either name changes the one
 * shared file, the way a case-insensitive filesystem would. The fold is applied only when the
 * repository says it is case-insensitive, so each case has its `core.ignorecase=false` twin,
 * where every comparison must stay byte-exact.
 */

const BASE = 'a\nb\nc\n';
const IDENTITY = { name: 'Test', email: 'test@example.com' };

interface Session {
  client: Client;
}

describe('peer ownership and attribution fold case only on an ignorecase clone', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  class HardLinkUnavailable extends Error {}

  async function setup(ignorecase: boolean): Promise<{
    remote: FakeRemote;
    dir: string;
    session: (id: string) => Promise<Session>;
  }> {
    const remote = await createFakeRemote({ 'Notes.txt': BASE, 'other.tex': 'x\n' });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-peercase-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));

    const dir = path.join(workspace, 'demo');
    await new GitService(IDENTITY).clone(remote.url, dir, { username: 'git' });
    await simpleGit(dir).raw(['config', 'core.ignorecase', ignorecase ? 'true' : 'false']);
    try {
      await link(path.join(dir, 'Notes.txt'), path.join(dir, 'notes.txt'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new HardLinkUnavailable(String(err));
      }
    }

    const baseConfig = {
      workspaceRoot: workspace,
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
    };
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
    return { remote, dir, session };
  }

  async function fixture(ignorecase: boolean): Promise<Awaited<ReturnType<typeof setup>> | null> {
    try {
      return await setup(ignorecase);
    } catch (err) {
      if (err instanceof HardLinkUnavailable) {
        console.error(`hard link unavailable (${err.message}); the layout cannot be modelled here`);
        return null;
      }
      throw err;
    }
  }

  async function call(session: Session, name: string, args: Record<string, unknown>) {
    const res = await session.client.callTool({ name, arguments: args });
    return {
      isError: res.isError === true,
      text: (res.content as Array<{ type: string; text?: string }>)
        .map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
        .join('\n'),
      sc: (res.structuredContent ?? {}) as Record<string, unknown>,
    };
  }

  async function peerEditsThroughOtherSpelling(peer: Session): Promise<void> {
    const res = await call(peer, 'edit_file', {
      path: 'notes.txt',
      edits: [{ oldString: 'a\n', newString: 'PEER\n' }],
    });
    expect(res.isError, res.text).toBe(false);
  }

  it('commit scope "paths" naming HEAD\'s spelling is refused when a live peer owns the other spelling (ignorecase=true)', async ({
    skip,
  }) => {
    const f = await fixture(true);
    if (!f) {
      skip();
      return;
    }
    const peer = await f.session('peer');
    const mine = await f.session('mine');
    await peerEditsThroughOtherSpelling(peer);
    const before = (await simpleGit(f.dir).revparse(['HEAD'])).trim();

    const res = await call(mine, 'commit', {
      message: 'take Notes.txt',
      scope: 'paths',
      paths: ['Notes.txt'],
    });
    // Pre-fix: not refused — the peer's PEER line was committed under this session's name.
    expect(res.isError, res.text).toBe(true);
    expect(res.text).toMatch(/Owned by a live session/);
    expect(res.text).toMatch(/"peer"/);
    expect((await simpleGit(f.dir).revparse(['HEAD'])).trim()).toBe(before);
  });

  it('just outside: with core.ignorecase=false the ownership check stays byte-exact', async ({
    skip,
  }) => {
    const f = await fixture(false);
    if (!f) {
      skip();
      return;
    }
    const peer = await f.session('peer');
    const mine = await f.session('mine');
    await peerEditsThroughOtherSpelling(peer);

    // On a case-sensitive repository `Notes.txt` and `notes.txt` are two names; the peer's
    // `notes.txt` entry says nothing about `Notes.txt`, exactly as before.
    const res = await call(mine, 'commit', {
      message: 'take Notes.txt',
      scope: 'paths',
      paths: ['Notes.txt'],
    });
    expect(res.isError, res.text).toBe(false);
    expect(res.sc.committed).toBe(true);
  });

  it("a push refusal attributes git's spelling of a dirty file to the peer that spelled it otherwise (ignorecase=true)", async ({
    skip,
  }) => {
    const f = await fixture(true);
    if (!f) {
      skip();
      return;
    }
    const peer = await f.session('peer');
    const mine = await f.session('mine');
    await peerEditsThroughOtherSpelling(peer);
    // Something of ours to push, in an unrelated file.
    const wrote = await call(mine, 'write_file', { path: 'other.tex', content: 'y\n' });
    expect(wrote.isError, wrote.text).toBe(false);
    const committed = await call(mine, 'commit', { message: 'mine: other.tex' });
    expect(committed.isError, committed.text).toBe(false);

    const res = await call(mine, 'push', { confirm: true });
    expect(res.isError, res.text).toBe(true);
    // Pre-fix: `No live session owns Notes.txt` — the peer's `notes.txt` entry did not match.
    expect(res.text).toMatch(/Live session "peer" owns Notes\.txt/);
    expect(res.text).not.toMatch(/No live session owns/);
  });

  it("the session scope's own `paths` filter folds too: naming HEAD's spelling commits this session's entry keyed otherwise (ignorecase=true)", async ({
    skip,
  }) => {
    const f = await fixture(true);
    if (!f) {
      skip();
      return;
    }
    const mine = await f.session('mine');
    const edited = await call(mine, 'edit_file', {
      path: 'notes.txt',
      edits: [{ oldString: 'c\n', newString: 'MINE\n' }],
    });
    expect(edited.isError, edited.text).toBe(false);

    const res = await call(mine, 'commit', {
      message: 'mine',
      scope: 'session',
      paths: ['Notes.txt'],
    });
    // Pre-fix: "Not changed by this session" — the shadow key `notes.txt` never matched.
    expect(res.isError, res.text).toBe(false);
    expect(res.sc.committed).toBe(true);
    expect((res.sc.files as Array<{ path: string }>).map((x) => x.path)).toEqual(['Notes.txt']);
  });

  it('a session-scope refusal names the spelling the caller typed, never the folded one (ignorecase=true)', async ({
    skip,
  }) => {
    const f = await fixture(true);
    if (!f) {
      skip();
      return;
    }
    const mine = await f.session('mine');
    const res = await call(mine, 'commit', { message: 'x', scope: 'session', paths: ['Nope.txt'] });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Not changed by this session: Nope\.txt/);
    expect(res.text).not.toMatch(/nope\.txt/);
  });

  it("status splits this session's own edit as its own, whatever spelling git reports (ignorecase=true)", async ({
    skip,
  }) => {
    const f = await fixture(true);
    if (!f) {
      skip();
      return;
    }
    const mine = await f.session('mine');
    const edited = await call(mine, 'edit_file', {
      path: 'notes.txt',
      edits: [{ oldString: 'c\n', newString: 'MINE\n' }],
    });
    expect(edited.isError, edited.text).toBe(false);
    const res = await call(mine, 'status', {});
    expect(res.isError, res.text).toBe(false);
    // Pre-fix: the reverse — git's `Notes.txt` did not match the shadow key `notes.txt`.
    expect(res.sc.sessionChanges).toEqual(['Notes.txt']);
    expect(res.sc.otherChanges).toEqual([]);
  });

  it('just outside: with core.ignorecase=false push attribution stays byte-exact', async ({
    skip,
  }) => {
    const f = await fixture(false);
    if (!f) {
      skip();
      return;
    }
    const peer = await f.session('peer');
    const mine = await f.session('mine');
    await peerEditsThroughOtherSpelling(peer);
    const wrote = await call(mine, 'write_file', { path: 'other.tex', content: 'y\n' });
    expect(wrote.isError, wrote.text).toBe(false);
    const committed = await call(mine, 'commit', { message: 'mine: other.tex' });
    expect(committed.isError, committed.text).toBe(false);

    const res = await call(mine, 'push', { confirm: true });
    expect(res.isError, res.text).toBe(true);
    // Case-sensitive: git reports the tracked `Notes.txt` as modified, and no peer entry names
    // that spelling.
    expect(res.text).toMatch(/No live session owns Notes\.txt/);
  });
});

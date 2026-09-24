import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, writeFile, chmod } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFakeRemote } from './helpers/bareRepo.js';
import { createContext } from '../../src/context.js';
import type { AppContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import { sessionStateDir } from '../../src/lib/sessionPaths.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * The shelf's integrity guarantees, end to end: a shelf whose bytes cannot be read never turns
 * into a deletion, the bytes it holds reach a commit exactly (non-UTF-8 text included), a
 * crash-recovery unshelve still gives this session its lines, and a shelve whose tree reset
 * fails says where the work went.
 */

const REL = 'sections/method.tex';
const BASE = ['\\section{Method}', 'The opening line.', ''].join('\n');
const IDENTITY = { name: 'Test', email: 'test@example.com' };

/** "Résumé: café.\n" in ISO-8859-1 — no NUL, and not valid UTF-8. */
const LATIN1 = Buffer.concat([
  Buffer.from(BASE, 'utf8'),
  Buffer.from([0x52, 0xe9, 0x73, 0x75, 0x6d, 0xe9, 0x3a, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x2e, 0x0a]),
]);

const noChmod =
  process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

interface Session {
  client: Client;
  ctx: AppContext;
}

describe('shelf integrity', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(files: Record<string, string> = { [REL]: BASE }) {
    const remote = await createFakeRemote(files);
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-shelf-int-'));
    cleanups.push(remote.cleanup, () =>
      rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    );
    const dir = path.join(workspace, 'demo');
    const git = new GitService(IDENTITY);
    await git.clone(remote.url, dir, { username: 'git' });
    const session = async (id: string): Promise<Session> => {
      const config: ServerConfig = {
        workspaceRoot: workspace,
        projects: [{ id: 'demo', gitUrl: remote.url }],
        defaultProject: 'demo',
        sessionId: id,
      };
      const ctx = createContext(config, new CredentialResolver({}), IDENTITY);
      const server = createServer(ctx);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: `test-${id}`, version: '0.0.0' });
      await Promise.all([server.connect(st), client.connect(ct)]);
      cleanups.unshift(() => client.close());
      return { client, ctx };
    };
    const shelfDir = (shelfId: string): string =>
      path.join(sessionStateDir(workspace, 'demo'), 'shelves', shelfId);
    return { dir, git, session, shelfDir };
  }

  async function call<T = Record<string, unknown>>(
    s: Session,
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const res = await s.client.callTool({ name, arguments: args });
    if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.content)}`);
    return res.structuredContent as T;
  }

  async function callExpectingError(
    s: Session,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const res = await s.client.callTool({ name, arguments: args });
    expect(res.isError, `${name} was expected to fail`).toBe(true);
    return ((res.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');
  }

  const listed = async (s: Session): Promise<string[]> =>
    (await call<{ shelves: Array<{ id: string }> }>(s, 'list_shelves', {})).shelves.map(
      (x) => x.id,
    );

  describe('an unreadable or missing side is never read as "the shelf recorded a deletion"', () => {
    it.skipIf(noChmod)(
      'refuses when a content side cannot be read (EACCES): the file survives, the shelf stays',
      async () => {
        const { dir, session, shelfDir } = await setup();
        const s = await session('a');
        await call(s, 'write_file', { path: REL, content: `${BASE}shelved edit\n` });
        const shelf = (await call<{ shelf: { id: string } }>(s, 'shelve', { paths: [REL] })).shelf;
        const contentFile = path.join(shelfDir(shelf.id), 'content', REL);
        await chmod(contentFile, 0o000);
        try {
          await callExpectingError(s, 'unshelve', { id: shelf.id });
          // The tracked file is still there, untouched — not deleted as a "restored deletion".
          expect(await readFile(path.join(dir, REL), 'utf8')).toBe(BASE);
          // And the shelf, with its intact-but-unreadable bytes, was not removed.
          expect(await listed(s)).toEqual([shelf.id]);
        } finally {
          // Tolerant: pre-fix, the shelf (and this file) was removed by the "successful" unshelve.
          await chmod(contentFile, 0o600).catch(() => {});
        }
        // Once readable again, every byte comes back.
        expect((await call<{ restored: boolean }>(s, 'unshelve', { id: shelf.id })).restored).toBe(
          true,
        );
        expect(await readFile(path.join(dir, REL), 'utf8')).toBe(`${BASE}shelved edit\n`);
      },
    );

    it('refuses as corrupt when a "modified" entry has lost its content side', async () => {
      const { dir, session, shelfDir } = await setup();
      const s = await session('a');
      await call(s, 'write_file', { path: REL, content: `${BASE}shelved edit\n` });
      const shelf = (await call<{ shelf: { id: string } }>(s, 'shelve', { paths: [REL] })).shelf;
      await rm(path.join(shelfDir(shelf.id), 'content', REL));

      const text = await callExpectingError(s, 'unshelve', { id: shelf.id });
      expect(text).toMatch(/corrupt/i);
      expect(text).toContain(shelf.id);
      expect(await readFile(path.join(dir, REL), 'utf8')).toBe(BASE);
      expect(await listed(s)).toEqual([shelf.id]);
    });
  });

  describe('bytes reach the commit exactly', () => {
    it('shelve + unshelve + session commit of a latin-1 file commits its bytes unchanged', async () => {
      const { dir, git, session } = await setup();
      const s = await session('a');
      await writeFile(path.join(dir, REL), LATIN1);
      const shelf = (await call<{ shelf: { id: string } }>(s, 'shelve', { paths: [REL] })).shelf;
      await call(s, 'unshelve', { id: shelf.id });
      const committed = await call<{ committed: boolean; scope: string }>(s, 'commit', {
        message: 'latin-1 section',
      });
      expect(committed.scope).toBe('session');
      expect(committed.committed).toBe(true);
      const blob = await git.readAtRefBytes(dir, 'HEAD', REL);
      // Byte for byte: a lossy UTF-8 decode would have staged ef bf bd where the file has e9.
      expect(blob?.toString('hex')).toBe(LATIN1.toString('hex'));
    });

    it('revert + session commit of a latin-1 file commits its bytes unchanged', async () => {
      const { dir, git, session } = await setup();
      const s = await session('a');
      const L2 = Buffer.concat([LATIN1, Buffer.from([0x4e, 0xe9, 0x0a])]);
      await writeFile(path.join(dir, REL), LATIN1);
      await git.commit(dir, { message: 'latin-1 v1', paths: [REL] });
      await writeFile(path.join(dir, REL), L2);
      const second = await git.commit(dir, { message: 'latin-1 v2', paths: [REL] });

      await call(s, 'revert', { commits: [second.sha], confirm: true });
      const committed = await call<{ committed: boolean; scope: string }>(s, 'commit', {
        message: 'undo v2',
      });
      expect(committed.scope).toBe('session');
      expect(committed.committed).toBe(true);
      const blob = await git.readAtRefBytes(dir, 'HEAD', REL);
      expect(blob?.toString('hex')).toBe(LATIN1.toString('hex'));
    });
  });

  describe('a shelve whose tree reset fails says where the work is', () => {
    it('names the shelf, and the work is recoverable from it', async () => {
      const { dir, session } = await setup();
      const s = await session('a');
      await writeFile(path.join(dir, REL), `${BASE}mid-sentence\n`);
      s.ctx.git.discard = async () => {
        throw new Error(
          'The discard failed PART WAY THROUGH: boom. ... that content is gone and cannot be ' +
            'recovered here ...',
        );
      };

      const text = await callExpectingError(s, 'shelve', { paths: [REL] });
      const ids = await listed(s);
      expect(ids).toHaveLength(1);
      // The caller is told the work is safe in that shelf — not only discard's "gone" text.
      expect(text).toContain(ids[0]!);
      expect(text).toMatch(/nothing is lost/i);
      expect(text).toContain('boom');
    });
  });

  describe('a crash-recovery (no-op) unshelve still gives this session its lines', () => {
    it('tree already holds the shelved bytes: the session commit includes them', async () => {
      const { dir, git, session } = await setup();
      const s = await session('a');
      const edited = `${BASE}recovered line\n`;
      await writeFile(path.join(dir, REL), edited);
      // Simulate a crash between the shelf landing and the tree being reset: the discard never
      // ran, so the tree still holds exactly the shelved bytes.
      const realDiscard = s.ctx.git.discard.bind(s.ctx.git);
      s.ctx.git.discard = async () => {
        throw new Error('simulated crash');
      };
      await callExpectingError(s, 'shelve', { paths: [REL] });
      s.ctx.git.discard = realDiscard;
      const [shelfId] = await listed(s);
      expect(await readFile(path.join(dir, REL), 'utf8')).toBe(edited);

      expect((await call<{ restored: boolean }>(s, 'unshelve', { id: shelfId })).restored).toBe(
        true,
      );
      const committed = await call<{ committed: boolean; scope: string }>(s, 'commit', {
        message: 'recovered',
      });
      expect(committed.scope).toBe('session');
      expect(committed.committed).toBe(true);
      expect((await git.readAtRefBytes(dir, 'HEAD', REL))?.toString('utf8')).toBe(edited);
    });

    it('and when HEAD moved under it meanwhile, the shelved change is merged onto HEAD, not reverting it', async () => {
      const { dir, git, session } = await setup();
      const s = await session('a');
      const edited = `${BASE}recovered line\n`;
      await writeFile(path.join(dir, REL), edited);
      const realDiscard = s.ctx.git.discard.bind(s.ctx.git);
      s.ctx.git.discard = async () => {
        throw new Error('simulated crash');
      };
      await callExpectingError(s, 'shelve', { paths: [REL] });
      s.ctx.git.discard = realDiscard;
      const [shelfId] = await listed(s);

      // Upstream changes the FIRST line of the same file while the tree still holds the shelved
      // bytes (a peer's session commit can do exactly this).
      const upstream = BASE.replace('\\section{Method}', '\\section{Methods}');
      await writeFile(path.join(dir, REL), upstream);
      await git.commit(dir, { message: 'upstream rename', paths: [REL] });
      await writeFile(path.join(dir, REL), edited);

      expect((await call<{ restored: boolean }>(s, 'unshelve', { id: shelfId })).restored).toBe(
        true,
      );
      await call(s, 'commit', { message: 'recovered' });
      // This session's line lands, and upstream's rename is KEPT: the change recorded is the
      // shelf's (base -> shelved), three-way merged onto HEAD, not "HEAD -> shelved".
      expect((await git.readAtRefBytes(dir, 'HEAD', REL))?.toString('utf8')).toBe(
        `${upstream}recovered line\n`,
      );
    });
  });
});

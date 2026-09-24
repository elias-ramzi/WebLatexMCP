import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, appendFile, writeFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFakeRemote } from './helpers/bareRepo.js';
import { createContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * What `commit` does when no `scope` is passed.
 *
 * The default used to be `hasChanges ? "session" : "all"`, decided afresh on every call. Two ways
 * that handed a session `git add -A` over a live peer's in-flight work, with nobody having asked
 * for scope "all":
 *
 *  - a session that has tracked nothing yet (fresh, or everything it wrote already committed)
 *    calls `commit` while a peer is mid-edit; and
 *  - the ignored-only refusal. `commitSession` settles an entry git ignores BEFORE refusing
 *    ("every change this session made is to a file git ignores"), so the identical retry finds
 *    the session tracking nothing and silently widens to "all" — the refusal itself changed which
 *    scope the next call got.
 *
 * Both are the same hole, and the fix is in the default: with a live peer on the clone, a session
 * tracking nothing refuses and says to pass scope "all" explicitly. Alone on the clone it still
 * falls back to "all" (`ignoredCommit.test.ts` pins that half).
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

describe('commit with no scope', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(): Promise<{ dir: string; session: (id: string) => Promise<Session> }> {
    const remote = await createFakeRemote({ [REL]: BASE });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-defscope-'));
    cleanups.push(remote.cleanup, () =>
      rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    );
    const dir = path.join(workspace, 'demo');
    await new GitService(IDENTITY).clone(remote.url, dir, { username: 'git' });

    const session = async (id: string): Promise<Session> => {
      const config: ServerConfig = {
        workspaceRoot: workspace,
        projects: [{ id: 'demo', gitUrl: remote.url }],
        defaultProject: 'demo',
        sessionId: id,
      };
      const ctx = createContext(config, new CredentialResolver({}), IDENTITY);
      const server = createServer(ctx);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: `test-${id}`, version: '0.0.0' });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      cleanups.push(() => client.close());
      return { client };
    };
    return { dir, session };
  }

  async function call(
    s: Session,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const res = await s.client.callTool({ name, arguments: args });
    if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.content)}`);
    return res.structuredContent as Record<string, unknown>;
  }

  const textOf = (res: unknown): string =>
    JSON.stringify((res as { content?: unknown }).content ?? '');

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

  it('a retry after the ignored-only refusal does not widen to "all" and take a live peer\'s edit', async () => {
    const { dir, session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), '\nnotes/\n');
    const git = simpleGit(dir);
    const head = (await git.revparse(['HEAD'])).trim();

    await call(a, 'write_file', {
      path: 'notes/summary.md',
      content: 'private note\n',
      createDirs: true,
    });
    await editB(b);

    const first = await a.client.callTool({ name: 'commit', arguments: { message: 'A: mine' } });
    expect(first.isError, textOf(first)).toBe(true);
    expect(textOf(first)).toMatch(/ignores/);

    // The identical call. Before the fix this silently ran `git add -A` and committed B's line.
    const second = await a.client.callTool({ name: 'commit', arguments: { message: 'A: mine' } });
    expect(second.isError, textOf(second)).toBe(true);
    expect(textOf(second)).toMatch(/scope \\"all\\"/);
    expect(textOf(second)).toMatch(/beta/);

    expect((await git.revparse(['HEAD'])).trim()).toBe(head);
    // B's edit is still in the working tree, uncommitted.
    expect(await readFile(path.join(dir, REL), 'utf8')).toMatch(/per B\./);
    expect(await git.show([`HEAD:${REL}`])).not.toMatch(/per B\./);
  });

  it("a session that tracks nothing refuses rather than committing a live peer's edit", async () => {
    const { dir, session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');
    const git = simpleGit(dir);
    const head = (await git.revparse(['HEAD'])).trim();

    await editB(b);
    const res = await a.client.callTool({ name: 'commit', arguments: { message: 'A: nothing' } });
    expect(res.isError, textOf(res)).toBe(true);
    expect(textOf(res)).toMatch(/scope \\"all\\"/);
    expect((await git.revparse(['HEAD'])).trim()).toBe(head);

    // Passing scope "all" explicitly is the deliberate act, and it still works.
    const taken = await call(a, 'commit', { message: 'A: take all', scope: 'all' });
    expect(taken.committed).toBe(true);
    expect(taken.scope).toBe('all');
    expect(await git.show([`HEAD:${REL}`])).toMatch(/per B\./);
  });

  it('an edit reverted to its original text does not widen the default to "all" and take a hand edit', async () => {
    // Alone on the clone. The session tracked a change when the call began (an edit, then its
    // reverse), and `commit`'s opening refresh settles that entry because its shadow equals an
    // unmoved HEAD. Deciding the default AFTER that refresh found the session tracking nothing and
    // fell back to "all" — `git add -A` over a hand edit the user never offered. The scope must be
    // decided on what the session tracked when the call began, so the call refuses instead.
    const { dir, session } = await setup();
    await writeFile(path.join(dir, 'other.tex'), 'o\n');
    const git = simpleGit(dir);
    await git.add(['other.tex']);
    await git.commit('add other.tex');
    const head = (await git.revparse(['HEAD'])).trim();
    const a = await session('solo');

    await call(a, 'edit_file', {
      path: REL,
      edits: [{ oldString: 'It then states the assumption.', newString: 'It assumes.' }],
    });
    await call(a, 'edit_file', {
      path: REL,
      edits: [{ oldString: 'It assumes.', newString: 'It then states the assumption.' }],
    });
    await writeFile(path.join(dir, 'other.tex'), 'hand edit by the user, in progress\n');

    const res = await a.client.callTool({ name: 'commit', arguments: { message: 'A: nothing' } });
    expect(res.isError, textOf(res)).toBe(true);
    expect(textOf(res)).toMatch(/Nothing to commit/);
    // The reason is the right one — this session DID make changes, and they are already at HEAD —
    // and scope "all" is named only as what it would do, never as the way to commit this
    // session's work (which is exactly the widening the refusal exists to prevent).
    expect(textOf(res)).toMatch(/already at HEAD/);
    expect(textOf(res)).not.toMatch(/has made no changes/);
    expect(textOf(res)).not.toMatch(/Use scope/);
    expect(textOf(res)).toMatch(/scope \\"all\\" would commit OTHER changes/);
    expect((await git.revparse(['HEAD'])).trim()).toBe(head);
    // The hand edit is still in the working tree, uncommitted.
    expect(await git.show(['HEAD:other.tex'])).toBe('o\n');
    expect(await readFile(path.join(dir, 'other.tex'), 'utf8')).toMatch(/hand edit/);

    // Taking the whole tree is still one deliberate argument away.
    const taken = await call(a, 'commit', { message: 'take all', scope: 'all' });
    expect(taken.committed).toBe(true);
    expect(taken.scope).toBe('all');
  });

  it('an explicit scope "session" gives the same "already at HEAD" refusal for a reverted edit', async () => {
    // The wording is read from what the session tracked before the opening refresh for an explicit
    // "session" as well as an omitted scope; this pins the explicit half.
    const { dir, session } = await setup();
    const git = simpleGit(dir);
    const head = (await git.revparse(['HEAD'])).trim();
    const a = await session('solo');

    await call(a, 'edit_file', {
      path: REL,
      edits: [{ oldString: 'It then states the assumption.', newString: 'It assumes.' }],
    });
    await call(a, 'edit_file', {
      path: REL,
      edits: [{ oldString: 'It assumes.', newString: 'It then states the assumption.' }],
    });

    const res = await a.client.callTool({
      name: 'commit',
      arguments: { message: 'A: nothing', scope: 'session' },
    });
    expect(res.isError, textOf(res)).toBe(true);
    expect(textOf(res)).toMatch(/Nothing to commit/);
    expect(textOf(res)).toMatch(/already at HEAD/);
    expect(textOf(res)).not.toMatch(/has made no changes/);
    expect(textOf(res)).not.toMatch(/Use scope/);
    expect((await git.revparse(['HEAD'])).trim()).toBe(head);
  });

  it('session scope accepts a leading "./" in paths, as the other scopes do', async () => {
    const { dir, session } = await setup();
    const a = await session('alpha');
    await call(a, 'edit_file', {
      path: REL,
      edits: [
        {
          oldString: 'It then states the assumption.',
          newString: 'It states the assumption, per A.',
        },
      ],
    });
    const res = await call(a, 'commit', {
      message: 'A: dotted path',
      scope: 'session',
      paths: [`./${REL}`],
    });
    expect(res.committed).toBe(true);
    expect(res.files).toEqual([{ path: REL, added: 1, removed: 1 }]);
    expect(await simpleGit(dir).show([`HEAD:${REL}`])).toMatch(/per A\./);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
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
 * Issue #70 coverage gap — the case fold `uncoveredPaths` takes.
 *
 * (a) WHICH FOLD. `commitPaths` (`src/tools/commit.ts`, the `scope: "paths"` implementation) asks
 * `uncoveredPaths(normalized, dirty, fold)` which requested paths cover nothing dirty in the
 * working tree, with `fold` being git's own ASCII-only case fold (`foldCase`, `src/lib/caseFold.ts`)
 * — passed exactly when `GitService.isCaseInsensitive(dir)` says the clone has `core.ignorecase`
 * set, and `undefined` (byte-exact) otherwise. Nothing exercised this one. `commitPaths` has five
 * fold call sites; this test covers `uncoveredPaths` and, through it, the rescue's own `coversPath`,
 * and `peerOwnership` is covered by `peerCaseFold.test.ts`. The remaining two —
 * `ignoredUnderRequestedDirs` and `mergeIgnored`, both of which only *widen the `ignored` report*
 * and decide nothing about what is staged or owned — are **still uncovered**: this test runs them
 * folded, but their result is `[]` either way here, so nothing here would fail if their fold were
 * dropped. Do not read this file as closing them. The clone's `core.ignorecase` is set explicitly
 * below with `git config` rather than inherited from the host filesystem, because CI runs ubuntu +
 * windows + macOS and the setting — not the disk — is the server's single source of truth.
 *
 * (b) THE FIXTURE is a single real file on disk (`Notes.txt`); only the *name strings* handed to
 * the tools differ in case. It deliberately does NOT use the hard-linked two-spellings fixture of
 * `peerCaseFold.test.ts`: the bug under test is a pure string-level comparison inside
 * `uncoveredPaths`, it never needs a real directory entry spelled `notes.txt`, and on a genuinely
 * case-sensitive filesystem a second hard-linked name would show up in `git status` as an untracked
 * file in its own right — which would make the `ignorecase=false` twin below stage and commit it
 * instead of refusing, the exact opposite of what that twin is for. Same reasoning, and the same
 * harness, as `settleCaseFold.test.ts`.
 *
 * (c) WHAT FAILURE LOOKS LIKE. Drop the `fold` argument from that one `uncoveredPaths` call and the
 * first test below fails — but NOT by raising a "nothing to commit" error at that line. Byte-exact,
 * `notes.txt` covers nothing dirty, so it falls through to the *rescue* branch, whose own
 * `coversPath` call still folds and so finds this session's shadow entry keyed `Notes.txt`. The path
 * is therefore "rescued" rather than refused — and a rescued path is deliberately excluded from
 * `stageable` (`const stageable = notIgnored.filter((p) => !rescuedSet.has(p))`), because a rescued
 * path is one with nothing on disk to stage. `stageable` empties, `NothingToCommitError` is thrown,
 * the handler's catch settles the entry and returns `committed: false` — a quiet, non-error
 * "settled it for you" for an edit that is still sitting uncommitted in the working tree. The
 * assertions are written to catch exactly that: `committed === true` plus real git state (HEAD moved
 * and now holds the edited bytes, working tree clean), not merely "no error".
 */

const BASE = 'a\nb\nc\n';
const EDITED = 'MINE\nb\nc\n';
const IDENTITY = { name: 'Test', email: 'test@example.com' };

interface Session {
  client: Client;
}

interface Harness {
  remote: FakeRemote;
  dir: string;
  session: (id: string) => Promise<Session>;
  cleanups: Array<() => Promise<void>>;
}

async function setup(files: Record<string, string>, ignorecase: boolean | null): Promise<Harness> {
  const cleanups: Array<() => Promise<void>> = [];
  const remote = await createFakeRemote(files);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-rescuecase-'));
  cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));

  const dir = path.join(workspace, 'demo');
  await new GitService(IDENTITY).clone(remote.url, dir, { username: 'git' });
  if (ignorecase !== null) {
    await simpleGit(dir).raw(['config', 'core.ignorecase', ignorecase ? 'true' : 'false']);
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
  return { remote, dir, session, cleanups };
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

const committedPaths = (sc: Record<string, unknown>): string[] =>
  (sc.files as Array<{ path: string }>).map((f) => f.path);

/** Contents of `rel` as HEAD holds it — the proof that a commit really landed. */
const atHead = (dir: string, rel: string): Promise<string> =>
  simpleGit(dir).raw(['show', `HEAD:${rel}`]);

describe('commit scope "paths" covers a case-differing dirty file (issue #70 coverage gap)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('ignorecase=true: "notes.txt" covers the dirty "Notes.txt", so it stages and the commit lands', async () => {
    const h = await setup({ 'Notes.txt': BASE }, true);
    cleanups.push(...h.cleanups);
    const mine = await h.session('mine');

    // The edit goes in under the spelling HEAD uses, so both the shadow entry and `git status`
    // name it "Notes.txt" — only the commit request below differs in case.
    const edited = await call(mine, 'edit_file', {
      path: 'Notes.txt',
      edits: [{ oldString: 'a\n', newString: 'MINE\n' }],
    });
    expect(edited.isError, edited.text).toBe(false);
    expect((await simpleGit(h.dir).status()).isClean()).toBe(false);

    const before = await simpleGit(h.dir).revparse(['HEAD']);
    const res = await call(mine, 'commit', {
      message: 'take notes.txt',
      scope: 'paths',
      paths: ['notes.txt'],
    });

    // Without the fold this is not an error either — it is `committed: false` with the entry
    // settled and the edit left uncommitted (see the file header). So assert the commit, not
    // merely the absence of an error.
    expect(res.isError, res.text).toBe(false);
    expect(res.sc.committed, res.text).toBe(true);
    expect(committedPaths(res.sc)).toEqual(['Notes.txt']);

    // …and against real git: HEAD moved, it holds the edited bytes under HEAD's own spelling,
    // and nothing is left dirty.
    const after = await simpleGit(h.dir).revparse(['HEAD']);
    expect(after).not.toBe(before);
    expect(res.sc.sha).toBe(after);
    expect(await atHead(h.dir, 'Notes.txt')).toBe(EDITED);
    expect((await simpleGit(h.dir).status()).isClean()).toBe(true);
  });

  it('just outside: ignorecase=false, the same call is refused in server words and HEAD does not move', async () => {
    const h = await setup({ 'Notes.txt': BASE }, false);
    cleanups.push(...h.cleanups);
    const mine = await h.session('mine');

    const edited = await call(mine, 'edit_file', {
      path: 'Notes.txt',
      edits: [{ oldString: 'a\n', newString: 'MINE\n' }],
    });
    expect(edited.isError, edited.text).toBe(false);

    const before = await simpleGit(h.dir).revparse(['HEAD']);
    // Byte-exact on a case-sensitive clone: "notes.txt" covers nothing dirty, and the rescue's own
    // byte-exact `coversPath` finds nothing this session tracks under that spelling either — so the
    // call is refused by the server, never handed to git.
    const res = await call(mine, 'commit', {
      message: 'take notes.txt',
      scope: 'paths',
      paths: ['notes.txt'],
    });
    expect(res.isError, res.text).toBe(true);
    expect(res.text).toMatch(/Nothing to commit at: notes\.txt/);
    expect(res.text).not.toMatch(/fatal/i);

    expect(await simpleGit(h.dir).revparse(['HEAD'])).toBe(before);
    expect(await atHead(h.dir, 'Notes.txt')).toBe(BASE);
  });

  it('ignorecase=true: the same fold through coversPath\'s directory branch — "sub" covers the dirty "Sub/a.tex"', async () => {
    const h = await setup({ 'Sub/a.tex': BASE }, true);
    cleanups.push(...h.cleanups);
    const mine = await h.session('mine');

    const edited = await call(mine, 'edit_file', {
      path: 'Sub/a.tex',
      edits: [{ oldString: 'a\n', newString: 'MINE\n' }],
    });
    expect(edited.isError, edited.text).toBe(false);

    const before = await simpleGit(h.dir).revparse(['HEAD']);
    const res = await call(mine, 'commit', {
      message: 'take everything under sub',
      scope: 'paths',
      paths: ['sub'],
    });

    expect(res.isError, res.text).toBe(false);
    expect(res.sc.committed, res.text).toBe(true);
    expect(committedPaths(res.sc)).toEqual(['Sub/a.tex']);

    const after = await simpleGit(h.dir).revparse(['HEAD']);
    expect(after).not.toBe(before);
    expect(await atHead(h.dir, 'Sub/a.tex')).toBe(EDITED);
    expect((await simpleGit(h.dir).status()).isClean()).toBe(true);
  });
});

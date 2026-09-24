import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
 * Issue #66, findings A and B — same two-session harness as peerCaseFold.test.ts (a fake bare
 * remote, one server-and-client pair per session id, sharing one workspace/clone).
 *
 * Finding A does NOT reuse peerCaseFold's hard-linked-alias fixture: that fixture models a real
 * case-insensitive filesystem (macOS/Windows), where `notes.txt` and `Notes.txt` are the same
 * directory entry. Finding A's bug is a pure string-level mismatch inside
 * `ShadowStore.settle`/`coversPath` — it never touches a real path spelled `notes.txt` on disk —
 * and creating that second name turns out to invalidate the very scenario the `ignorecase=false`
 * twin needs: on a genuinely case-sensitive filesystem with `core.ignorecase=false`, a hard-linked
 * `notes.txt` is *permanently* reported by `git status` as an untracked file in its own right
 * (confirmed by hand with plain git — `git status --porcelain` prints `?? notes.txt` the moment
 * the link exists, before any edit), which would make `commit scope:"paths" paths:["notes.txt"]`
 * actually stage and commit it as a new file instead of refusing — the opposite of what that twin
 * is supposed to show. So finding A's fixture below is a single real file; only the *name strings*
 * passed to the tools differ in case.
 *
 * Finding B needs neither case-insensitivity nor a second name at all — it is about which
 * sessions' shadow *records* a path-limited `discard` settles, so its fixture (further down) is
 * plainer still.
 */

const BASE = 'a\nb\nc\n';
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
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-settlecase-'));
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

describe('commit scope "paths" settles a case-differing stale entry (issue #66 finding A)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('ignorecase=true: settles the entry keyed Notes.txt when asked to take notes.txt, with no error', async () => {
    const h = await setup({ 'Notes.txt': BASE }, true);
    cleanups.push(...h.cleanups);
    const mine = await h.session('mine');

    // This session's shadow entry is keyed exactly "Notes.txt" (the spelling the tool call used).
    const edited = await call(mine, 'edit_file', {
      path: 'Notes.txt',
      edits: [{ oldString: 'a\n', newString: 'MINE\n' }],
    });
    expect(edited.isError, edited.text).toBe(false);

    // Hand-revert the working tree back to HEAD's content directly (bypassing the tool, as a
    // hand edit or an out-of-band script would) — nothing is dirty any more, but this session's
    // shadow record of "Notes.txt" is now stale.
    await writeFile(path.join(h.dir, 'Notes.txt'), BASE, 'utf8');
    expect((await simpleGit(h.dir).status()).isClean()).toBe(true);

    // Pre-fix: `ShadowStore.settle` compared byte-exact, so the request "notes.txt" never
    // matched the entry keyed "Notes.txt" — `dropped.length === 0` rethrew the underlying
    // NothingToCommitError, leaving the stale record wedged permanently instead of settling it.
    const res = await call(mine, 'commit', {
      message: 'take notes.txt',
      scope: 'paths',
      paths: ['notes.txt'],
    });
    expect(res.isError, res.text).toBe(false);
    expect(res.sc.committed).toBe(false);
    expect(res.sc.settled).toEqual(['Notes.txt']);
  });

  it('just outside: ignorecase=false, the same call is an error (nothing dirty, and nothing tracked under that spelling)', async () => {
    const h = await setup({ 'Notes.txt': BASE }, false);
    cleanups.push(...h.cleanups);
    const mine = await h.session('mine');

    const edited = await call(mine, 'edit_file', {
      path: 'Notes.txt',
      edits: [{ oldString: 'a\n', newString: 'MINE\n' }],
    });
    expect(edited.isError, edited.text).toBe(false);
    await writeFile(path.join(h.dir, 'Notes.txt'), BASE, 'utf8');
    expect((await simpleGit(h.dir).status()).isClean()).toBe(true);

    const res = await call(mine, 'commit', {
      message: 'take notes.txt',
      scope: 'paths',
      paths: ['notes.txt'],
    });
    expect(res.isError, res.text).toBe(true);
    expect(res.sc.settled ?? []).toEqual([]);
  });
});

describe('a path-limited discard settles only the named paths, in every session (issue #66 finding B)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it("leaves a peer's unrelated in-flight record intact, so their path still refuses a later steal", async () => {
    const h = await setup({ 'main.tex': '\\documentclass{article}\n' }, false);
    cleanups.push(...h.cleanups);
    const peer = await h.session('peer');
    const mine = await h.session('mine');

    // Peer has an in-flight, uncommitted edit to a file unrelated to what "mine" is about to
    // discard.
    const peerWrote = await call(peer, 'write_file', {
      path: 'chapter.tex',
      content: 'peer content\n',
    });
    expect(peerWrote.isError, peerWrote.text).toBe(false);

    // "mine" creates its own untracked scratch file, then discards exactly that path.
    const mineWrote = await call(mine, 'write_file', {
      path: 'scratch.txt',
      content: 'scratch\n',
    });
    expect(mineWrote.isError, mineWrote.text).toBe(false);

    const discarded = await call(mine, 'discard', {
      paths: ['scratch.txt'],
      confirm: true,
    });
    expect(discarded.isError, discarded.text).toBe(false);

    // Pre-fix: the path-limited discard called `clearAll` regardless of `paths`, dropping the
    // peer's chapter.tex record too — after which "mine" committing chapter.tex under scope
    // "paths" would land the peer's uncommitted lines instead of being refused as owned.
    const res = await call(mine, 'commit', {
      message: 'steal chapter.tex',
      scope: 'paths',
      paths: ['chapter.tex'],
    });
    expect(res.isError, res.text).toBe(true);
    expect(res.text).toMatch(/Owned by a live session/);
    expect(res.text).toMatch(/"peer"/);
  });
});

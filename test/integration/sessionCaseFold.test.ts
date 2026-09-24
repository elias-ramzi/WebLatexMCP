import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, link } from 'node:fs/promises';
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
 * Regression test for issue #66's severe (session-isolation) defect: on a case-insensitive
 * clone (`core.ignorecase = true`, git's own default on macOS/Windows clones), `readAtRef`/
 * `readAtRefBytes` did no case-fold at all. `ShadowStore.readHead` calls those to seed a new
 * shadow entry's base — so a session that spells a tracked `Notes.txt` as `notes.txt` got a
 * `null` base, and its shadow became the *whole working-tree file* (peer lines included) rather
 * than `HEAD + only this session's edit`. `commitContents`'s own (separately fixed) case fold
 * then landed that on the real `Notes.txt`, so a peer's uncommitted line leaked into this
 * session's commit — violating "a commit contains one session's lines and nobody else's".
 *
 * Two sessions (two `AppContext`s, two MCP servers) share one clone, mirroring
 * multiSession.test.ts's setup exactly, but on a clone forced to `core.ignorecase=true` and with
 * the two sessions spelling the same tracked file in different case.
 *
 * The host filesystem here (Linux CI) is normally case-*sensitive*, so "Notes.txt" and
 * "notes.txt" are two distinct directory entries by default — unlike on the macOS/Windows
 * clones `core.ignorecase=true` models, where they are the same file. A hard link between the
 * two names closes that gap for the test without depending on the host filesystem's own case
 * sensitivity: both directory entries then share one inode, so a plain in-place `fs.writeFile`
 * (which this server's `FileService` uses — open-write-close, no rename) through either name
 * mutates the same bytes, exactly as a case-insensitive filesystem would. On a host where the
 * filesystem is *already* case-insensitive (a macOS/Windows CI runner), `notes.txt` already
 * names `Notes.txt`, and `link` fails `EEXIST` — caught below and skipped.
 */

const REL_HEAD_SPELLING = 'Notes.txt';
const BASE = 'a\nb\nc\n';

const IDENTITY = { name: 'Test', email: 'test@example.com' };

interface Session {
  client: Client;
  close: () => Promise<void>;
}

describe('session isolation survives a case-folded spelling on an ignorecase clone', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  /** Thrown by `setup` when the host cannot hard-link; the test skips itself on it. */
  class HardLinkUnavailable extends Error {}

  async function setup(): Promise<{
    remote: FakeRemote;
    dir: string;
    session: (id: string) => Promise<Session>;
  }> {
    const remote = await createFakeRemote({ [REL_HEAD_SPELLING]: BASE });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-case-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));

    const dir = path.join(workspace, 'demo');
    await new GitService(IDENTITY).clone(remote.url, dir, { username: 'git' });
    // git's own default on macOS/Windows clones — forced explicitly here so the test is
    // deterministic on Linux CI too.
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);
    // See the class doc comment: alias "notes.txt" onto the same inode as tracked "Notes.txt" so
    // an in-place write through either name mutates the one shared file, the way a genuinely
    // case-insensitive filesystem would.
    try {
      await link(path.join(dir, 'Notes.txt'), path.join(dir, 'notes.txt'));
    } catch (err) {
      // `EEXIST`: the host filesystem already folds case, so the alias is the file itself and
      // the test proceeds. Any other failure means hard links are unavailable here (a Windows
      // work disk without them, a policy) — the layout cannot be modelled, so skip, not fail.
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
      const close = (): Promise<void> => client.close();
      cleanups.push(close);
      return { client, close };
    };

    return { remote, dir, session };
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

  it("a peer's line spelled in HEAD's case does not leak into this session's commit, spelled in another case", async () => {
    let fixture: Awaited<ReturnType<typeof setup>>;
    try {
      fixture = await setup();
    } catch (err) {
      if (err instanceof HardLinkUnavailable) {
        console.error(`hard link unavailable (${err.message}); the layout cannot be modelled here`);
        return;
      }
      throw err;
    }
    const { dir, session } = fixture;
    const peer = await session('peer');
    const mine = await session('mine');

    // Peer edits line 1, spelled exactly as HEAD tracks it.
    await call(peer, 'edit_file', {
      path: 'Notes.txt',
      edits: [{ oldString: 'a\n', newString: 'PEER\n' }],
    });
    // This session edits line 3, spelled in a different case — the same file on disk.
    await call(mine, 'edit_file', {
      path: 'notes.txt',
      edits: [{ oldString: 'c\n', newString: 'MINE\n' }],
    });

    // Both edits really did land in the one shared working-tree file.
    const onDisk = await readFile(path.join(dir, 'Notes.txt'), 'utf8');
    expect(onDisk).toBe('PEER\nb\nMINE\n');

    const committed = await call<{ sha: string; files: Array<{ path: string }> }>(mine, 'commit', {
      message: 'mine: revise line 3',
    });

    // The commit holds only this session's line — the peer's uncommitted PEER line must not be
    // in it, however the tree entry was reached.
    const git = simpleGit(dir);
    const committedText = await git.show([`${committed.sha}:Notes.txt`]);
    expect(committedText).toBe('a\nb\nMINE\n');

    // Exactly one tree entry — no second, case-differing "notes.txt" entry was created.
    const tree = (await git.raw(['ls-tree', '-r', '--name-only', committed.sha]))
      .split('\n')
      .filter(Boolean);
    expect(tree).toContain('Notes.txt');
    expect(tree).not.toContain('notes.txt');

    // The peer's edit is still sitting, uncommitted, in the shared working tree.
    expect(await readFile(path.join(dir, 'Notes.txt'), 'utf8')).toBe('PEER\nb\nMINE\n');
  });
});

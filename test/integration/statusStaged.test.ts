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
 * `status`'s `otherChanges`/`sessionChanges` split used to be built from `unstaged + untracked`
 * only (`src/tools/status.ts`), so a path dirty only in the index — someone ran `git add` by hand,
 * or an interrupted `commitContents` left it staged and nothing since touched the working tree —
 * was invisible to both. `commit.ts`'s `commitPaths` already rescues exactly this case for its own
 * dirty set (`status.staged` joins it, with the same reasoning), and the peer-refusal guard
 * (`guardPeerWork`, in `src/lib/peerRefusal.ts`, used by push) is documented as building its
 * disputed set "exactly as otherChanges is" — so the two had already drifted apart before this
 * fix. Harness copied from test/integration/pushAttribution.test.ts (real MCP client, a local bare
 * repo, no network).
 */

const REL = 'sections/method.tex';

const BASE = ['\\section{Method}', 'The first paragraph opens the method.', ''].join('\n');

const IDENTITY = { name: 'Test', email: 'test@example.com' };

interface Session {
  client: Client;
  close: () => Promise<void>;
}

describe('status includes index-only (staged) changes', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(): Promise<{
    remote: FakeRemote;
    dir: string;
    session: (id: string) => Promise<Session>;
  }> {
    const remote = await createFakeRemote({ [REL]: BASE });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-statusstaged-'));
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

  interface StatusOut {
    otherChanges: string[];
    sessionChanges: string[];
  }

  it('reports a path staged by hand only (no unstaged diff) under otherChanges', async () => {
    const { dir, session } = await setup();
    const alpha = await session('alpha');

    // Modify a tracked file directly on disk, bypassing the server, and stage it with a plain
    // `git add` — nothing since touched the working tree, so `git status` shows it staged only.
    await writeFile(
      path.join(dir, REL),
      BASE.replace('opens the method.', 'opens the method, hand-edited.'),
      'utf8',
    );
    await simpleGit(dir).add([REL]);

    const status = await call<StatusOut>(alpha, 'status', {});

    expect(status.otherChanges).toContain(REL);
    expect(status.sessionChanges).not.toContain(REL);
  });

  it("attributes a staged-only path to sessionChanges when this session's own shadow owns it", async () => {
    const { dir, session } = await setup();
    const alpha = await session('alpha');

    // alpha edits the file through the server (its shadow now owns REL), then the same content is
    // staged by hand — moving it from "unstaged" to "staged only" in git's status, exactly the
    // case that was previously invisible to the split.
    await call(alpha, 'edit_file', {
      path: REL,
      edits: [
        {
          oldString: 'The first paragraph opens the method.',
          newString: 'The first paragraph opens the method, per alpha.',
        },
      ],
    });
    await simpleGit(dir).add([REL]);

    const status = await call<StatusOut>(alpha, 'status', {});

    expect(status.sessionChanges).toContain(REL);
    expect(status.otherChanges).not.toContain(REL);
  });

  it('dedupes a path that is both staged and unstaged (staged once, then edited again)', async () => {
    const { dir, session } = await setup();
    const alpha = await session('alpha');

    // Stage a hand edit, then make a further hand edit on top without staging it — the same path
    // is now both staged (git's index vs HEAD) and unstaged (working tree vs index).
    await writeFile(
      path.join(dir, REL),
      BASE.replace('opens the method.', 'opens the method, staged edit.'),
      'utf8',
    );
    await simpleGit(dir).add([REL]);
    await writeFile(
      path.join(dir, REL),
      BASE.replace('opens the method.', 'opens the method, staged edit, then unstaged edit.'),
      'utf8',
    );

    const status = await call<StatusOut>(alpha, 'status', {});

    const occurrences = status.otherChanges.filter((p) => p === REL);
    expect(occurrences).toHaveLength(1);
  });
});

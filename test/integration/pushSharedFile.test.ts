import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { simpleGit } from 'simple-git';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import { createContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * `push`'s live-peer guard over a file BOTH sessions edited. The guard used to subtract every path
 * in this session's own shadow before looking at peers, so a file alpha and beta had each edited
 * (different lines) was "alpha's" and never disputed — and a `push` carrying a `message` commits
 * via `git add -A`, so beta's uncommitted line was committed and pushed under alpha's name.
 * `commit scope: "paths"` already refuses any path a live peer lists, even one both own
 * (`peerOwnership`, `src/lib/commitPaths.ts`); `push` must hold the same line. Real MCP clients
 * over a local bare repo, no network — the harness of `pushAttribution.test.ts`.
 */

const REL = 'sections/method.tex';
const OTHER = 'sections/intro.tex';

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

describe('push guard over a file both live sessions edited', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(): Promise<{
    remote: FakeRemote;
    session: (id: string) => Promise<Session>;
  }> {
    const remote = await createFakeRemote({ [REL]: BASE, [OTHER]: 'Intro.\n' });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-pushshared-'));
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

    return { remote, session };
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
    const content = res.content as Array<{ type: string; text?: string }>;
    return content.map((c) => c.text ?? '').join('\n');
  }

  const edit = (s: Session, rel: string, oldString: string, newString: string): Promise<unknown> =>
    call(s, 'edit_file', { path: rel, edits: [{ oldString, newString }] });

  const remoteFile = (remote: FakeRemote, rel: string): Promise<string> =>
    simpleGit(remote.bareDir).raw(['show', `master:${rel}`]);

  it("refuses a push with message that would sweep a live peer's lines in a co-edited file", async () => {
    const { remote, session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');
    await edit(a, REL, 'It then states the assumption.', 'It states the assumption, per A.');
    await edit(
      b,
      REL,
      'The second paragraph defines the loss.',
      'The second paragraph defines the loss, per B.',
    );

    const refusal = await callExpectingError(a, 'push', { message: 'push A', confirm: true });

    // Nothing reached the remote — neither beta's line nor alpha's.
    const shown = await remoteFile(remote, REL);
    expect(shown).not.toContain('per B');
    expect(shown).not.toContain('per A');

    // The refusal names the file, attributes it to beta, and says it is this session's too.
    expect(refusal).toContain(REL);
    expect(refusal).toContain(`"beta" owns ${REL}`);
    expect(refusal).toMatch(/also carries this session's own edits/);
    // It names the way out: commit this session's own lines with the session scope, and push
    // without a message once the owner has committed.
    expect(refusal).toMatch(/scope "session"/);
    expect(refusal).toMatch(/without a `message`/);

    // And that way out actually works: alpha commits its own lines (session scope), beta commits
    // its own, then alpha pushes without a message — both lines land, each in its own commit.
    await call(a, 'commit', { message: 'A only' });
    // Until beta commits, its line is still uncommitted in the tree, so even a message-less push
    // waits for it — the refusal said "once the owner has committed", and means it.
    const waiting = await callExpectingError(a, 'push', { confirm: true });
    expect(waiting).toContain(`"beta" owns ${REL}`);
    expect(await remoteFile(remote, REL)).not.toContain('per A');
    await call(b, 'commit', { message: 'B only' });
    const pushed = await call<{ status: string }>(a, 'push', { confirm: true });
    expect(pushed.status).toBe('pushed');
    const after = await remoteFile(remote, REL);
    expect(after).toContain('per A');
    expect(after).toContain('per B');
    const log = await simpleGit(remote.bareDir).raw(['log', '--format=%s', 'master']);
    expect(log).toMatch(/B only/);
    expect(log).toMatch(/A only/);
  });

  it('still lets a push with message through when the live peer never touched the file', async () => {
    const { remote, session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');
    // beta is live and has a readable change index — it edited and committed a different file,
    // so its record is settled and the tree holds only alpha's work.
    await edit(b, OTHER, 'Intro.', 'Intro, per B.');
    await call(b, 'commit', { message: 'B intro' });
    await edit(a, REL, 'It then states the assumption.', 'It states the assumption, per A.');

    const pushed = await call<{ status: string }>(a, 'push', { message: 'push A', confirm: true });
    expect(pushed.status).toBe('pushed');
    expect(await remoteFile(remote, REL)).toContain('per A');
    expect(await remoteFile(remote, OTHER)).toContain('per B');
  });
});

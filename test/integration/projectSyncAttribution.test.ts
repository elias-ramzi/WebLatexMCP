import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFakeRemote, pushCommit, type FakeRemote } from './helpers/bareRepo.js';
import { createContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * `project_sync`'s pull-refusal attribution (finding 2, issue review on #60-62): when
 * `LocalChangesOverwriteError` names a tracked file blocking the fast-forward, the tool used to
 * attribute EVERY named path to a live peer without first subtracting this session's own edits —
 * so a file this very session had just edited (via `edit_file`) was reported as "not this
 * session's", which is false. The fix mirrors `push.ts`'s `guardPeerWork`: subtract this session's
 * own shadow paths before attributing, and append nothing when nothing foreign remains.
 *
 * Harness copied from test/integration/pushAttribution.test.ts (real MCP clients, a local bare
 * repo, no network).
 */

const REL = 'sections/method.tex';

const BASE = [
  '\\section{Method}',
  'The first paragraph opens the method.',
  'It then states the assumption.',
  '',
].join('\n');

const IDENTITY = { name: 'Test', email: 'test@example.com' };

interface Session {
  client: Client;
  close: () => Promise<void>;
}

describe('project_sync pull-refusal attribution', () => {
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
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-syncattr-'));
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

  async function callExpectingError(
    session: Session,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const res = await session.client.callTool({ name, arguments: args });
    expect(res.isError, `${name} was expected to fail`).toBe(true);
    return JSON.stringify(res.content);
  }

  const editMethod = (s: Session, newString: string): Promise<unknown> =>
    call(s, 'edit_file', {
      path: REL,
      edits: [{ oldString: 'It then states the assumption.', newString }],
    });

  it("does not claim this session's own uncommitted edit is not its own", async () => {
    const { remote, session } = await setup();
    const alpha = await session('alpha');
    const beta = await session('beta');

    // alpha edits the file itself (uncommitted) — this is its own in-flight work.
    await editMethod(alpha, 'It states the assumption, per alpha.');
    // beta registers as a live peer without touching the file.
    await call(beta, 'status', {});

    // The remote gains a commit on the same file, so alpha's pull will be refused.
    await pushCommit(
      remote,
      { [REL]: BASE.replace('opens the method.', 'opens it, remotely.') },
      'remote edit',
    );

    const err = await callExpectingError(alpha, 'project_sync', {});

    // The plain typed LocalChangesOverwriteError message names the file...
    expect(err).toContain(REL);
    // ...but since the only colliding path is alpha's own edit, no peer-attribution block should
    // have been appended: it must not say the change "is not this session's", and must not name
    // beta as an owner of it.
    expect(err).not.toContain("not this session's");
    expect(err).not.toContain('beta');
  });

  it("attributes the colliding path to a live peer when it is that peer's uncommitted edit", async () => {
    const { remote, session } = await setup();
    const alpha = await session('alpha');
    const beta = await session('beta');

    // beta edits the file itself (uncommitted) — alpha never touches it.
    await editMethod(beta, 'It states the assumption, per beta.');

    await pushCommit(
      remote,
      { [REL]: BASE.replace('opens the method.', 'opens it, remotely.') },
      'remote edit',
    );

    const err = await callExpectingError(alpha, 'project_sync', {});

    expect(err).toContain(REL);
    expect(err).toContain("not this session's");
    expect(err).toContain('beta\\" owns');
    expect(err).toContain(REL);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { simpleGit } from 'simple-git';
import { createFakeRemote, pushCommit, type FakeRemote } from './helpers/bareRepo.js';
import { expectNoUndeclaredKeys } from '../helpers/outputSchema.js';
import { createContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * `project_sync` mode "rebase": the rebase `push` runs before pushing, minus the push. Before it
 * existed, an ff-only sync could only report "diverged", so a session that committed locally while
 * co-authors edited on Overleaf ran `git pull --rebase` by hand, past every peer guard. Real MCP
 * clients over a local bare repo, no network.
 */

const REL = 'sections/method.tex';
const OTHER = 'sections/intro.tex';
const BASE = 'Line one.\nLine two.\nLine three.\n';
const IDENTITY = { name: 'Test', email: 'test@example.com' };

interface Session {
  client: Client;
}

interface SyncOut {
  action: string;
  ahead: number;
  behind: number;
  diverged: boolean;
  replayedCommits?: number;
  incomingCommits?: number;
  conflictPaths?: string[];
  remoteHead?: string;
  conflictFiles?: Array<{ path: string; ours: string | null; theirs: string | null }>;
}

describe('project_sync mode "rebase"', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(): Promise<{
    remote: FakeRemote;
    dir: string;
    session: (id: string) => Promise<Session>;
  }> {
    const remote = await createFakeRemote({ [REL]: BASE, [OTHER]: 'Intro.\n' });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-syncrebase-'));
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
    return { remote, dir, session };
  }

  async function callRaw(
    s: Session,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ structured: unknown; text: string; isError: boolean }> {
    const res = await s.client.callTool({ name, arguments: args });
    const content = res.content as Array<{ type: string; text?: string }>;
    return {
      structured: res.structuredContent,
      text: content.map((c) => c.text ?? '').join('\n'),
      isError: res.isError === true,
    };
  }

  async function call<T = Record<string, unknown>>(
    s: Session,
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const res = await callRaw(s, name, args);
    if (res.isError) throw new Error(`${name} failed: ${res.text}`);
    return res.structured as T;
  }

  const edit = (s: Session, rel: string, oldString: string, newString: string): Promise<unknown> =>
    call(s, 'edit_file', { path: rel, edits: [{ oldString, newString }] });

  const remoteHead = async (remote: FakeRemote): Promise<string> =>
    (await simpleGit(remote.bareDir).revparse(['master'])).trim();

  const headOf = async (dir: string): Promise<string> =>
    (await simpleGit(dir).revparse(['HEAD'])).trim();

  it('replays a local commit onto a diverged remote and pushes nothing', async () => {
    const { remote, dir, session } = await setup();
    const a = await session('alpha');
    await edit(a, REL, 'Line two.', 'Line two, edited locally.');
    await call(a, 'commit', { message: 'local edit' });
    await pushCommit(remote, { [OTHER]: 'Intro, from Overleaf.\n' }, 'Update on Overleaf.');
    const bareBefore = await remoteHead(remote);

    // The ff-only default reports the divergence and points at mode "rebase".
    const plain = await callRaw(a, 'project_sync', {});
    expect((plain.structured as SyncOut).action).toBe('diverged');
    expect(plain.text).toContain('mode "rebase"');

    const res = await callRaw(a, 'project_sync', { mode: 'rebase' });
    expect(res.isError, res.text).toBe(false);
    const out = res.structured as SyncOut;
    expect(out.action).toBe('rebased');
    expect(out.replayedCommits).toBe(1);
    expect(out.incomingCommits).toBe(1);
    expect(out.ahead).toBe(1);
    expect(out.behind).toBe(0);
    expect(out.diverged).toBe(false);
    await expectNoUndeclaredKeys(a.client, 'project_sync', res.structured);

    // The local commit now sits on top of the remote's, and both edits are in the tree.
    const git = simpleGit(dir);
    expect((await git.raw(['log', '-1', '--format=%s'])).trim()).toBe('local edit');
    expect((await git.raw(['rev-parse', 'HEAD~1'])).trim()).toBe(bareBefore);
    expect(await readFile(path.join(dir, REL), 'utf8')).toContain('edited locally');
    expect(await readFile(path.join(dir, OTHER), 'utf8')).toBe('Intro, from Overleaf.\n');
    // Nothing was pushed.
    expect(await remoteHead(remote)).toBe(bareBefore);
  });

  it('aborts on a conflict, returns push’s conflict payload, and leaves the clone exactly as it was', async () => {
    const { remote, dir, session } = await setup();
    const a = await session('alpha');
    await edit(a, REL, 'Line two.', 'Line two, ours.');
    await call(a, 'commit', { message: 'local edit' });
    await pushCommit(remote, { [REL]: 'Line one.\nLine two, theirs.\nLine three.\n' }, 'Overleaf');
    const bareBefore = await remoteHead(remote);
    const headBefore = await headOf(dir);
    const fileBefore = await readFile(path.join(dir, REL), 'utf8');
    const statusBefore = await simpleGit(dir).raw(['status', '--porcelain']);

    const res = await callRaw(a, 'project_sync', { mode: 'rebase' });
    expect(res.isError, res.text).toBe(false);
    const out = res.structured as SyncOut;
    expect(out.action).toBe('conflict');
    expect(out.conflictPaths).toEqual([REL]);
    expect(out.remoteHead).toBe(bareBefore);
    expect(out.conflictFiles?.[0]?.ours).toContain('Line two, ours.');
    expect(out.conflictFiles?.[0]?.theirs).toContain('Line two, theirs.');
    await expectNoUndeclaredKeys(a.client, 'project_sync', res.structured);
    // The text carries the payload and the route out, and says that route pushes.
    expect(res.text).toContain(REL);
    expect(res.text).toContain(bareBefore);
    expect(res.text).toContain('resolutions');
    expect(res.text).toContain('expectedRemoteHead');
    expect(res.text).toMatch(/PUSHES/);

    // Clone unchanged: same HEAD, same file, same status, no rebase left in progress.
    expect(await headOf(dir)).toBe(headBefore);
    expect(await readFile(path.join(dir, REL), 'utf8')).toBe(fileBefore);
    expect(await simpleGit(dir).raw(['status', '--porcelain'])).toBe(statusBefore);
    await expect(stat(path.join(dir, '.git', 'rebase-merge'))).rejects.toThrow();
    await expect(stat(path.join(dir, '.git', 'rebase-apply'))).rejects.toThrow();
    expect(await remoteHead(remote)).toBe(bareBefore);

    // And the route it names works: push with resolutions + expectedRemoteHead lands the merge.
    const pushed = await call<{ status: string }>(a, 'push', {
      resolutions: [{ path: REL, content: 'Line one.\nLine two, ours and theirs.\nLine three.\n' }],
      expectedRemoteHead: out.remoteHead,
      confirm: true,
    });
    expect(pushed.status).toBe('pushed');
  });

  it('refuses while a live peer has uncommitted lines in a file the rebase rewrites', async () => {
    const { remote, dir, session } = await setup();
    const a = await session('alpha');
    const b = await session('beta');
    await edit(a, REL, 'Line one.', 'Line one, per A.');
    await call(a, 'commit', { message: 'A commit' });
    await pushCommit(remote, { [OTHER]: 'Intro, from Overleaf.\n' }, 'Overleaf');
    await edit(b, REL, 'Line three.', 'Line three, per B (in flight).');
    const headBefore = await headOf(dir);

    const res = await callRaw(a, 'project_sync', { mode: 'rebase' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain(REL);
    expect(res.text).toContain('"beta"');
    // Nothing moved, and beta's line is still in the tree.
    expect(await headOf(dir)).toBe(headBefore);
    expect(await readFile(path.join(dir, REL), 'utf8')).toContain('per B (in flight)');
  });

  it('fast-forwards a clone that is only behind ("pulled")', async () => {
    const { remote, dir, session } = await setup();
    const a = await session('alpha');
    await pushCommit(remote, { [OTHER]: 'Intro, from Overleaf.\n' }, 'Overleaf');
    const res = await call<SyncOut>(a, 'project_sync', { mode: 'rebase' });
    expect(res.action).toBe('pulled');
    expect(res.behind).toBe(0);
    expect(await headOf(dir)).toBe(await remoteHead(remote));
  });

  it('does nothing when the clone is only ahead', async () => {
    const { remote, session } = await setup();
    const a = await session('alpha');
    await edit(a, REL, 'Line two.', 'Line two, edited locally.');
    await call(a, 'commit', { message: 'local edit' });
    const bareBefore = await remoteHead(remote);
    const res = await call<SyncOut>(a, 'project_sync', { mode: 'rebase' });
    expect(res.action).toBe('up-to-date');
    expect(res.ahead).toBe(1);
    expect(await remoteHead(remote)).toBe(bareBefore);
  });
});

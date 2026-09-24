import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, appendFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext, type AppContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * Regression tests for the PR #67 review findings on `commit`'s scope "paths"/"all" routes:
 *
 * - Finding 1 (HIGH): a rescued path (this session's shadow still tracks it, but nothing in the
 *   working tree is dirty at it any more — e.g. it was written then deleted) used to reach
 *   `git add` verbatim and fatal raw ("did not match any files") for a path that no longer exists
 *   anywhere. `commitPaths` must settle it instead, the way it already settles a rescued path whose
 *   content merely reverted to HEAD (see ignoredCommit.test.ts / unrecordedCommit.test.ts).
 * - Finding 2 (MEDIUM): when some requested paths are ignored by git and the rest merely have
 *   nothing to stage, `ctx.git.commit`'s bare `NothingToCommitError()` used to overwrite the
 *   `ignored` list computed earlier with `[]`, so the tool reported no ignored paths at all even
 *   though one was skipped for exactly that reason.
 * - Finding 3 (MEDIUM): `commitEverything` handed `git add` the caller's raw path strings, unlike
 *   `commitPaths`, which normalises to POSIX first — asserted here only as the assertable half (dot
 *   prefix), since the backslash half is Windows-only.
 *
 * Follows the setup style of ignoredCommit.test.ts, which drives the real MCP tools end to end
 * against a local bare-repo remote.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function structured(res: unknown): Record<string, unknown> {
  return (res as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}
function isError(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}
function textOf(res: unknown): string {
  return JSON.stringify((res as { content?: unknown }).content ?? '');
}

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

async function setup(
  seed: Record<string, string>,
): Promise<{ client: Client; ctx: AppContext; remote: FakeRemote; dir: string }> {
  const remote = await createFakeRemote(seed);
  cleanups.push(remote.cleanup);
  const workspace = await tmp('ovl-rescue-ws-');
  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'test',
    projects: [{ id: 'demo', gitUrl: remote.url }],
    defaultProject: 'demo',
  };
  const ctx = createContext(
    config,
    new CredentialResolver({}),
    { name: 'Test', email: 'test@example.com' },
    new ProjectRegistry(workspace),
  );
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  await client.callTool({ name: 'project_sync', arguments: { project: 'demo', mode: 'clone' } });
  const { dir } = await ctx.projectManager.requireProjectDir('demo');
  return { client, ctx, remote, dir };
}

const MAIN_TEX = '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n';

describe('commit scope "paths" rescues a stale record without reaching git add for it', () => {
  // A file this session created and then deleted through the tools no longer reaches the rescue:
  // its shadow (absent) equals HEAD (absent), so the refresh `commit` runs first under the lock
  // settles it outright — before, it stayed tracked forever and every session-scope commit threw
  // "nothing to commit". Naming it is then naming a path nobody tracks and nothing dirtied, which
  // refuses in server words like any other such path. The rescue itself is still exercised by the
  // hand-`rm` cases below, whose shadow does NOT equal HEAD.
  it('write then delete_file, then commit scope "paths": no fatal, the record is already settled', async () => {
    const { client, ctx } = await setup({ 'main.tex': MAIN_TEX });

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'new.tex', content: 'draft\n' },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);

    const deleted = await client.callTool({
      name: 'delete_file',
      arguments: { project: 'demo', path: 'new.tex' },
    });
    expect(isError(deleted), textOf(deleted)).toBe(false);

    const result = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'rescue a deleted stale record',
        scope: 'paths',
        paths: ['new.tex'],
      },
    });
    // Originally (pre-#67): isError true, with git's raw "fatal: pathspec 'new.tex' did not match
    // any files". Now a refusal in server words: the refresh settled the record first.
    expect(isError(result), textOf(result)).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/Nothing to commit at: new\.tex/);
    expect(text).not.toMatch(/fatal/);
    expect(text).not.toMatch(/pathspec/);
    expect(await ctx.shadows.hasChanges('demo')).toBe(false);

    // The record is gone: a further scope "session" commit says there is nothing to commit.
    const second = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'nothing left', scope: 'session' },
    });
    expect(isError(second)).toBe(true);
    expect(textOf(second)).toMatch(/Nothing to commit \(this session has made no changes\)/);
    expect(await ctx.shadows.hasChanges('demo')).toBe(false);
  });

  it('write then a hand `fs.rm`, then commit scope "paths": no fatal, settles the record', async () => {
    const { client, ctx, dir } = await setup({ 'main.tex': MAIN_TEX });

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'new.tex', content: 'draft\n' },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);

    await rm(path.join(dir, 'new.tex'));

    const result = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'rescue a hand-removed stale record',
        scope: 'paths',
        paths: ['new.tex'],
      },
    });
    expect(isError(result), textOf(result)).toBe(false);
    const sc = structured(result);
    expect(sc.committed).toBe(false);
    expect(sc.settled).toEqual(['new.tex']);
    const text = textOf(result);
    expect(text).not.toMatch(/fatal/);
    expect(text).not.toMatch(/pathspec/);
    expect(await ctx.shadows.hasChanges('demo')).toBe(false);
  });

  it('mixed: an ignored file plus a path reverted to HEAD both settle; only the ignored one is reported ignored', async () => {
    const { client, ctx, dir } = await setup({ 'main.tex': MAIN_TEX });
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), 'ignored-note.md\n');

    const wroteNote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'ignored-note.md', content: 'local note\n' },
    });
    expect(isError(wroteNote), textOf(wroteNote)).toBe(false);

    const wroteMain = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited.\n' },
    });
    expect(isError(wroteMain), textOf(wroteMain)).toBe(false);

    // Revert main.tex to HEAD's content by hand — nothing dirty there any more, but this
    // session's shadow still tracks it as an (unrecorded-less) change.
    await writeFile(path.join(dir, 'main.tex'), MAIN_TEX, 'utf8');

    const result = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'mixed ignored + reverted',
        scope: 'paths',
        paths: ['ignored-note.md', 'main.tex'],
      },
    });
    expect(isError(result), textOf(result)).toBe(false);
    const sc = structured(result);
    expect(sc.committed).toBe(false);
    expect(sc.ignored).toEqual(['ignored-note.md']);
    expect((sc.settled as string[]).sort()).toEqual(['ignored-note.md', 'main.tex']);
    const text = textOf(result);
    expect(text).toMatch(/ignored-note\.md/);
    expect(text).not.toMatch(/every requested path is ignored/);
    expect(await ctx.shadows.hasChanges('demo')).toBe(false);
  });

  it('mixed, scope "all" with paths: same as above, one commit call', async () => {
    const { client, ctx, dir } = await setup({ 'main.tex': MAIN_TEX });
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), 'ignored-note.md\n');

    const wroteNote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'ignored-note.md', content: 'local note\n' },
    });
    expect(isError(wroteNote), textOf(wroteNote)).toBe(false);

    const wroteMain = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited.\n' },
    });
    expect(isError(wroteMain), textOf(wroteMain)).toBe(false);

    await writeFile(path.join(dir, 'main.tex'), MAIN_TEX, 'utf8');

    const result = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'mixed ignored + reverted, scope all',
        scope: 'all',
        paths: ['ignored-note.md', 'main.tex'],
      },
    });
    expect(isError(result), textOf(result)).toBe(false);
    const sc = structured(result);
    expect(sc.committed).toBe(false);
    expect(sc.ignored).toEqual(['ignored-note.md']);
    const text = textOf(result);
    expect(text).toMatch(/ignored-note\.md/);
    expect(await ctx.shadows.hasChanges('demo')).toBe(false);
  });

  it('one dirty path plus one rescued stale path: the commit lands with the dirty file only', async () => {
    const { client, ctx, dir } = await setup({ 'main.tex': MAIN_TEX });

    // stale.tex: written by this session, then removed by hand — a rescued, stale record. (By
    // hand, not `delete_file`: a tool deletion is recorded, so the shadow equals HEAD and the
    // commit's own refresh settles it before the rescue — see the first test.)
    const wroteStale = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'stale.tex', content: 'draft\n' },
    });
    expect(isError(wroteStale), textOf(wroteStale)).toBe(false);
    await rm(path.join(dir, 'stale.tex'));

    // main.tex: genuinely dirty.
    const wroteMain = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited.\n' },
    });
    expect(isError(wroteMain), textOf(wroteMain)).toBe(false);

    const result = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'dirty plus rescued stale',
        scope: 'paths',
        paths: ['main.tex', 'stale.tex'],
      },
    });
    expect(isError(result), textOf(result)).toBe(false);
    const sc = structured(result);
    expect(sc.committed).toBe(true);
    expect((sc.files as Array<{ path: string }>).map((f) => f.path)).toEqual(['main.tex']);
    expect((sc.settled as string[]).sort()).toEqual(['main.tex', 'stale.tex']);
    expect(await ctx.shadows.hasChanges('demo')).toBe(false);
  });

  it('a requested directory whose only session change beneath it is ignored: reported ignored, not "matches HEAD"', async () => {
    // The directory itself covers nothing dirty (an ignored file never shows in `git status`), so
    // `notes` is a rescued path. The nested-ignored report must still run over it: before the fix
    // it was fed the post-rescue list, so `ignored` came back empty and the headline claimed the
    // working tree already matched HEAD for a file that was skipped because git ignores it.
    const { client, ctx, dir } = await setup({ 'main.tex': MAIN_TEX });
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), 'notes/ig.md\n');

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: {
        project: 'demo',
        path: 'notes/ig.md',
        content: 'local note\n',
        createDirs: true,
      },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);

    const result = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'take notes/', scope: 'paths', paths: ['notes'] },
    });
    expect(isError(result), textOf(result)).toBe(false);
    const sc = structured(result);
    expect(sc.committed).toBe(false);
    expect(sc.ignored).toEqual(['notes/ig.md']);
    expect(sc.settled).toEqual(['notes/ig.md']);
    const text = textOf(result);
    expect(text).toMatch(/notes\/ig\.md/);
    expect(text).not.toMatch(/already matches HEAD/);
    expect(await ctx.shadows.hasChanges('demo')).toBe(false);
  });

  it('scope "all" with paths: ["./main.tex"] normalises and commits main.tex', async () => {
    // Windows-only backslash normalisation (the actual bug in finding 3) cannot be asserted on
    // this host; this checks the assertable half (a leading "./"). Recorded whether it already
    // passed pre-fix in the implementer's report — `git add -- ./main.tex` tolerates a leading
    // "./" on its own regardless of `--literal-pathspecs`, so this is characterisation, not a
    // failing-pre-fix regression test.
    const { client } = await setup({ 'main.tex': MAIN_TEX });

    const wroteMain = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited.\n' },
    });
    expect(isError(wroteMain), textOf(wroteMain)).toBe(false);

    const result = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'dot-prefixed path normalises',
        scope: 'all',
        paths: ['./main.tex'],
      },
    });
    expect(isError(result), textOf(result)).toBe(false);
    const sc = structured(result);
    expect(sc.committed).toBe(true);
    expect((sc.files as Array<{ path: string }>).map((f) => f.path)).toEqual(['main.tex']);
  });
});

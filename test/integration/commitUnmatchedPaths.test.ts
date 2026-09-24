import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext, type AppContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * Regression tests for issue #66 T6: `commit { scope: "all", paths: [...] }` hands the (case-fold
 * resolved) paths straight to `git --literal-pathspecs add -- <paths>`. A path that matches
 * nothing — not in the index, not on disk — makes `git add` exit 128 with a raw
 * `fatal: pathspec '…' did not match any files`, which reached the caller unfiltered (`scope:
 * "paths"` rarely reaches this, since it pre-checks dirtiness itself before ever calling
 * `GitService.commit`). `GitService.commit` now refuses such paths itself, in server words, before
 * `git add` ever sees them.
 *
 * Follows the MCP-driven setup style of commitPathsRescue.test.ts (read, not edited, per this
 * task's file list).
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
  const workspace = await tmp('ovl-unmatched-ws-');
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

describe('commit scope "all" with a path matching nothing refuses in server words', () => {
  it('a single unmatched path: refused, names it, no raw git fatal', async () => {
    const { client, ctx } = await setup({ 'main.tex': MAIN_TEX });
    const before = await ctx.git.headSha((await ctx.projectManager.requireProjectDir('demo')).dir);

    const result = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'nothing to see here',
        scope: 'all',
        paths: ['nope.tex'],
      },
    });

    // Pre-fix: isError true, but the text carries git's raw
    // `fatal: pathspec 'nope.tex' did not match any files`.
    expect(isError(result), textOf(result)).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/nope\.tex/);
    expect(text).not.toMatch(/fatal/);
    expect(text).not.toMatch(/did not match/);

    const dir = (await ctx.projectManager.requireProjectDir('demo')).dir;
    expect(await ctx.git.headSha(dir)).toBe(before);
  });

  it('mixed: an edited tracked file plus an unmatched path both refuse, and nothing commits', async () => {
    const { client, ctx, dir } = await setup({ 'main.tex': MAIN_TEX });
    const before = await ctx.git.headSha(dir);

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited.\n' },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);

    const result = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'mixed real + unmatched',
        scope: 'all',
        paths: ['main.tex', 'nope.tex'],
      },
    });

    expect(isError(result), textOf(result)).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/nope\.tex/);
    expect(text).not.toMatch(/fatal/);
    expect(text).not.toMatch(/did not match/);

    // Nothing committed at all — not even main.tex, which was genuinely dirty.
    expect(await ctx.git.headSha(dir)).toBe(before);
    const status = await ctx.git.status(dir);
    expect(status.clean).toBe(false);
  });

  // Just-outside case, expected to pass both before and after the fix: a path that IS tracked
  // (present in the index) but no longer exists on disk still matches "in the index", so it
  // reaches `git add`, which stages the deletion exactly as before. Labeled per this task's
  // report requirement — this is characterisation, not new coverage.
  it('[characterisation, passes before and after] a tracked file removed on disk still commits its deletion', async () => {
    const { client, ctx, dir } = await setup({ 'main.tex': MAIN_TEX });
    const before = await ctx.git.headSha(dir);

    await rm(path.join(dir, 'main.tex'));

    const result = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'commit a hand-removed tracked file',
        scope: 'all',
        paths: ['main.tex'],
      },
    });

    expect(isError(result), textOf(result)).toBe(false);
    const sc = structured(result);
    expect(sc.committed).toBe(true);
    expect((sc.files as Array<{ path: string }>).map((f) => f.path)).toEqual(['main.tex']);
    expect(await ctx.git.headSha(dir)).not.toBe(before);
  });
});

/**
 * Issue #66 finding 2: `canonicalNames.resolve` folded a full name and a directory *prefix*, but a
 * request that IS a tracked directory in another case (`sub` while the tree tracks `Sub/a.tex`)
 * came back unchanged — so on a `core.ignorecase` clone this unmatched-path check's own `ls-files
 * -- sub` found nothing, and reached `git add -- sub` (a raw fatal) on a filesystem whose own case
 * folding makes `lstat('sub')` succeed. On this host the underlying filesystem stays
 * case-*sensitive* regardless of `core.ignorecase` (see `caseFoldCommit.test.ts`'s file comment for
 * why that's fine for this class of defect — it lives in what GIT resolves the pathspec onto), so
 * pre-fix `lstat('sub')` itself fails and the call is refused in server words rather than reaching
 * git — still a bug, since `"sub"` is a name the caller gave in good faith for a directory that is
 * genuinely tracked, just spelled differently.
 */
describe('commit scope "all" with a directory pathspec in another case (issue #66 finding 2)', () => {
  it('core.ignorecase=true: "sub" folds onto the tracked "Sub" directory and the edit lands', async () => {
    const { client, dir } = await setup({ 'Sub/a.tex': 'sub a\n' });
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'Sub/a.tex', content: 'sub a, edited\n' },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);

    const result = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'edit under a differently-cased directory pathspec',
        scope: 'all',
        paths: ['sub'],
      },
    });

    // Pre-fix (on this Linux host): refused in server words ("Nothing at: sub"), never even
    // reaching git — the finding's own raw-fatal outcome needs a filesystem whose OWN case
    // folding makes `lstat('sub')` succeed, which this host's ext4 does not provide.
    expect(isError(result), textOf(result)).toBe(false);
    const text = textOf(result);
    expect(text).not.toMatch(/fatal/i);
    const sc = structured(result);
    expect(sc.committed).toBe(true);
    expect((sc.files as Array<{ path: string }>).map((f) => f.path)).toEqual(['Sub/a.tex']);
  });

  // Twin, just outside the fix: `isCaseInsensitive` is false, so the path is never resolved at
  // all — same as before the fix. "sub" does not exist on disk on this (case-sensitive) host
  // either, so the unmatched-path check's own `lstat` fails and the refusal fires in server words.
  // Labeled per this task: the Linux-observable half of "refused, never a raw fatal".
  it('core.ignorecase=false: "sub" is refused in server words, never folded, no raw fatal', async () => {
    const { client, dir } = await setup({ 'Sub/a.tex': 'sub a\n' });
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'false']);

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'Sub/a.tex', content: 'sub a, edited\n' },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);

    const result = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'edit under a differently-cased directory pathspec',
        scope: 'all',
        paths: ['sub'],
      },
    });

    expect(isError(result), textOf(result)).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/Nothing at: sub/);
    expect(text).not.toMatch(/fatal/i);
  });
});

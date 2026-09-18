import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext, type AppContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * Issue #93: `commit`'s handler computes the case fold once (`nameFold`, over the one source of
 * truth `GitService.isCaseInsensitive`) under a comment saying exactly that — but
 * `commitEverything`'s `paths` branch re-derived it twice more, so a `scope: "all"` commit WITH
 * `paths` resolved `core.ignorecase` three times per call. The answer cannot change within one
 * commit, so asserting on the OUTPUT proves nothing about the fix: these tests assert the CALL
 * COUNT, which is the only thing that changes — plus, in the last case below, that the value
 * threaded into the branch is still the RIGHT one.
 *
 * `core.ignorecase` is forced explicitly on the clone in each test — as in
 * `caseFoldCommit.test.ts`, so the result is deterministic on Linux CI too, where git would
 * otherwise leave it unset.
 */

const IDENTITY = { name: 'Test', email: 'test@example.com' };

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
function committedPaths(res: unknown): string[] {
  return ((structured(res).files as Array<{ path: string }>) ?? []).map((f) => f.path).sort();
}

async function setup(
  seed: Record<string, string>,
): Promise<{ client: Client; ctx: AppContext; remote: FakeRemote; dir: string }> {
  const remote = await createFakeRemote(seed);
  cleanups.push(remote.cleanup);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-fold-once-ws-'));
  cleanups.push(() => rm(workspace, { recursive: true, force: true, maxRetries: 10 }));
  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'test',
    projects: [{ id: 'demo', gitUrl: remote.url }],
    defaultProject: 'demo',
  };
  const ctx = createContext(config, new CredentialResolver({}), IDENTITY);
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  // unshift, not push: close the client before the directories it was pointed at are removed.
  // `afterEach` drains in order, so pushing this last tore the workspace down under a live
  // server — harmless on Linux, a handle-holding flake on the Windows leg. Matches
  // `toolPathsPosixProjects.test.ts`, which does the same for the same reason.
  cleanups.unshift(() => client.close());
  await client.callTool({ name: 'project_sync', arguments: { project: 'demo', mode: 'clone' } });
  const { dir } = await ctx.projectManager.requireProjectDir('demo');
  return { client, ctx, remote, dir };
}

async function write(client: Client, p: string, content: string): Promise<void> {
  const wrote = await client.callTool({
    name: 'write_file',
    arguments: { project: 'demo', path: p, content, createDirs: true },
  });
  expect(isError(wrote), textOf(wrote)).toBe(false);
}

interface FoldSpy {
  /**
   * One entry per `isCaseInsensitive` call made by `commit.ts`'s `nameFold`, holding the answer
   * that call resolved to — so the length proves how often the tool layer asked, and the values
   * prove it genuinely asked the repository rather than a "fix" that stopped resolving the fold
   * at all.
   */
  fromNameFold: boolean[];
  /**
   * Every call to the method, whoever made it. `GitService` also asks itself (`ignoredPaths`,
   * `commit`, `canonicalAtRef`) and `ShadowStore` asks through the hook `context.ts` injects, so
   * a raw total can never tell the tool layer's own resolutions apart from git's internal ones —
   * hence the frame attribution below. Kept only so a `fromNameFold` of 0 cannot read as "fixed"
   * when in truth the spy was never reached at all.
   */
  total: number;
}

/**
 * Counts `GitService.isCaseInsensitive` calls made **by `commit.ts`'s `nameFold`**, preserving the
 * real implementation and its answer — the fold must still be genuinely resolved, so this proves
 * the call count, never a stubbed answer.
 *
 * Attribution is by stack frame because the method is shared (see `FoldSpy.total`): `nameFold` is
 * the tool layer's only resolver of the fold and calls `isCaseInsensitive` directly, so it is the
 * immediate caller frame whenever the tool layer asks, while every other call has no `nameFold`
 * frame at all.
 */
function spyOnFold(ctx: AppContext): FoldSpy {
  const spy: FoldSpy = { fromNameFold: [], total: 0 };
  const real = ctx.git.isCaseInsensitive.bind(ctx.git);
  ctx.git.isCaseInsensitive = async (dir: string): Promise<boolean> => {
    spy.total += 1;
    const viaNameFold = /\bnameFold\b/.test(new Error().stack ?? '');
    const answer = await real(dir);
    if (viaNameFold) spy.fromNameFold.push(answer);
    return answer;
  };
  cleanups.push(async () => {
    ctx.git.isCaseInsensitive = real;
  });
  return spy;
}

describe('commit resolves the case fold once per call (issue #93)', () => {
  for (const ignorecase of [true, false]) {
    it(`scope "all" WITH paths resolves core.ignorecase exactly once (ignorecase=${ignorecase})`, async () => {
      const { client, ctx, dir } = await setup({ 'main.tex': 'one\n', 'other.tex': 'two\n' });
      await simpleGit(dir).raw(['config', 'core.ignorecase', String(ignorecase)]);
      await write(client, 'main.tex', 'main changed\n');
      await write(client, 'other.tex', 'other changed\n');

      const spy = spyOnFold(ctx);
      const res = await client.callTool({
        name: 'commit',
        arguments: {
          project: 'demo',
          message: 'commit main only',
          scope: 'all',
          paths: ['main.tex'],
        },
      });

      // Pre-fix this is 3: the handler's own `nameFold`, plus `commitEverything`'s two.
      expect(spy.fromNameFold, `total isCaseInsensitive calls: ${spy.total}`).toEqual([ignorecase]);
      // The commit still did the work — a "fix" that short-circuited the `paths` branch would
      // either fail here or commit `other.tex` along with it.
      expect(isError(res), textOf(res)).toBe(false);
      expect(structured(res).committed).toBe(true);
      expect(committedPaths(res)).toEqual(['main.tex']);
      expect(await simpleGit(dir).show(['HEAD:main.tex'])).toBe('main changed\n');
      expect((await simpleGit(dir).status()).modified).toEqual(['other.tex']);
    });

    it(`just outside — scope "all" WITHOUT paths resolves it exactly once too (ignorecase=${ignorecase})`, async () => {
      const { client, ctx, dir } = await setup({ 'main.tex': 'one\n', 'other.tex': 'two\n' });
      await simpleGit(dir).raw(['config', 'core.ignorecase', String(ignorecase)]);
      await write(client, 'main.tex', 'main changed\n');
      await write(client, 'other.tex', 'other changed\n');

      const spy = spyOnFold(ctx);
      const res = await client.callTool({
        name: 'commit',
        arguments: { project: 'demo', message: 'commit the whole clone', scope: 'all' },
      });

      // The `git add -A` route never entered the re-deriving branch, so this was already 1 before
      // the fix: it is here so the assertion above discriminates the branch that changed rather
      // than merely counting low everywhere.
      expect(spy.fromNameFold, `total isCaseInsensitive calls: ${spy.total}`).toEqual([ignorecase]);
      expect(isError(res), textOf(res)).toBe(false);
      expect(structured(res).committed).toBe(true);
      expect(committedPaths(res)).toEqual(['main.tex', 'other.tex']);
    });
  }

  /**
   * The value, not just the count: `commitEverything`'s `paths` branch uses the fold to decide
   * which of this session's shadow entries a requested DIRECTORY swallows
   * (`ignoredUnderRequestedDirs` → `coversPath`). With `core.ignorecase = true`, requesting
   * `Notes` must cover the session's `notes/ig.md` and report it as ignored; threading a
   * byte-exact (`undefined`) fold instead would silently drop it from `ignored`, which the call
   * count alone could never catch.
   */
  it('scope "all" with paths threads the RIGHT fold: a case-differing nested ignored entry is still reported', async () => {
    const { client, ctx, dir } = await setup({
      'Notes/keep.tex': 'keep\n',
      'notes/other.tex': 'other\n',
    });
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), 'notes/ig.md\n');
    await write(client, 'Notes/keep.tex', 'keep changed\n');
    await write(client, 'notes/ig.md', 'ignored note\n');

    const spy = spyOnFold(ctx);
    const res = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'commit the Notes directory',
        scope: 'all',
        paths: ['Notes'],
      },
    });

    expect(spy.fromNameFold, `total isCaseInsensitive calls: ${spy.total}`).toEqual([true]);
    expect(isError(res), textOf(res)).toBe(false);
    const sc = structured(res);
    expect(sc.committed).toBe(true);
    expect(committedPaths(res)).toEqual(['Notes/keep.tex']);
    expect(sc.ignored).toEqual(['notes/ig.md']);
  });
});

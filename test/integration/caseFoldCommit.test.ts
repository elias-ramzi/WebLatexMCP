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
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import type { ServerConfig } from '../../src/types.js';
import { pathToFileURL } from 'node:url';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';

/**
 * Regression tests for issue #66 items 2, 3 and 4 — three ways `core.ignorecase = true` (git's
 * own default on macOS/Windows clones) can produce a case-differing tree entry, or a raw git
 * error, that a case-sensitive repository never sees. Each `core.ignorecase` is forced explicitly
 * on the clone so the result is deterministic on Linux CI too (the host filesystem here stays
 * case-*sensitive* regardless — see `sessionCaseFold.test.ts`'s comment for why that's fine for
 * these particular defects, which live in what GIT resolves a path onto, not in what the
 * filesystem does with it).
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

async function setup(
  seed: Record<string, string>,
): Promise<{ client: Client; ctx: AppContext; remote: FakeRemote; dir: string }> {
  const remote = await createFakeRemote(seed);
  cleanups.push(remote.cleanup);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-casefold-commit-ws-'));
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
  cleanups.push(() => client.close());
  await client.callTool({ name: 'project_sync', arguments: { project: 'demo', mode: 'clone' } });
  const { dir } = await ctx.projectManager.requireProjectDir('demo');
  return { client, ctx, remote, dir };
}

async function tree(dir: string): Promise<string[]> {
  return (await simpleGit(dir).raw(['ls-tree', '-r', '--name-only', 'HEAD']))
    .split('\n')
    .filter(Boolean);
}

/**
 * Issue #66 item 2: `GitService.commit(dir, {paths, fromHead})` (`scope: "paths"`/`"all"` with
 * `paths`) ran `git --literal-pathspecs add -- <paths>`. A literal pathspec never folds case, so
 * on an ignorecase clone where HEAD tracks `Notes.txt`, naming the deletion as `notes.txt` hit
 * git's raw `fatal: pathspec 'notes.txt' did not match any files` instead of committing it.
 */
describe('commit "paths"/"all" folds a deleted file onto its tracked spelling (issue #66 item 2)', () => {
  it('scope "paths": deleting the tracked file and naming it in another case commits the deletion', async () => {
    const { client, dir } = await setup({ 'Notes.txt': 'notes\n' });
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);
    await rm(path.join(dir, 'Notes.txt'));

    const res = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'delete notes (paths, other case)',
        scope: 'paths',
        paths: ['notes.txt'],
      },
    });
    expect(isError(res), textOf(res)).toBe(false);
    expect(textOf(res)).not.toMatch(/fatal|pathspec/i);
    expect(structured(res).committed).toBe(true);

    expect(await tree(dir)).not.toContain('Notes.txt');
  });

  it('scope "all" with paths: same delete-under-another-case lands too', async () => {
    const { client, dir } = await setup({ 'Notes.txt': 'notes\n' });
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);
    await rm(path.join(dir, 'Notes.txt'));

    const res = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'delete notes (all, other case)',
        scope: 'all',
        paths: ['notes.txt'],
      },
    });
    expect(isError(res), textOf(res)).toBe(false);
    expect(textOf(res)).not.toMatch(/fatal|pathspec/i);
    expect(structured(res).committed).toBe(true);

    expect(await tree(dir)).not.toContain('Notes.txt');
  });

  it('just outside — core.ignorecase=false: the differently-cased name is refused, never folded', async () => {
    const { client, dir } = await setup({ 'Notes.txt': 'notes\n' });
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'false']);
    await rm(path.join(dir, 'Notes.txt'));

    const res = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'delete notes (paths, other case)',
        scope: 'paths',
        paths: ['notes.txt'],
      },
    });
    expect(isError(res)).toBe(true);
    expect(await tree(dir)).toContain('Notes.txt');
  });
});

/**
 * Issue #66 item 3: `commitContents` resolved each shadow path through `canonicalNames.resolve`,
 * which folds only a FULL name the listing holds. A *new* file `sub/new.tex` written while HEAD
 * tracks `Sub/a.tex` resolved to itself, so the committed tree gained a second, case-differing
 * directory `sub/` beside `Sub/` — one directory on disk, two in the tree on the ignorecase clone
 * this targets. `canonicalNames` must also fold onto the longest tracked directory prefix.
 */
describe('commitContents folds a new file under a case-differing tracked directory (issue #66 item 3)', () => {
  it('a new file under "sub/" lands under the tracked "Sub/" in the committed tree', async () => {
    const { client, dir } = await setup({ 'Sub/a.tex': 'sub a\n' });
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'sub/new.tex', content: 'new\n', createDirs: true },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);

    const committed = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'add new file under sub' },
    });
    expect(isError(committed), textOf(committed)).toBe(false);

    const t = await tree(dir);
    expect(t).toContain('Sub/new.tex');
    expect(t).not.toContain('sub/new.tex');
  });

  it('just outside — core.ignorecase=false: the new file lands under its own spelling', async () => {
    const { client, dir } = await setup({ 'Sub/a.tex': 'sub a\n' });
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'false']);

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'sub/new.tex', content: 'new\n', createDirs: true },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);

    const committed = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'add new file under sub' },
    });
    expect(isError(committed), textOf(committed)).toBe(false);

    const t = await tree(dir);
    expect(t).toContain('sub/new.tex');
    expect(t).not.toContain('Sub/new.tex');
  });
});

/**
 * Issue #66 item 4: with the fold in place, a session that edits a tracked file under two
 * spellings (`Notes.txt` and `notes.txt`, two shadow entries) resolves both onto the one tree
 * entry `commitContents` folds them to — so the second `update-index --cacheinfo` silently won
 * over the first, and the commit landed missing one of the session's own edits with no error at
 * all. `commitContents` must refuse the whole commit instead, before any index write.
 */
describe('two spellings of one tracked file in one session are one entry (issue #66 item 4)', () => {
  it('ignorecase=true: the second spelling folds into the first entry and the commit carries its content', async () => {
    const { client, ctx, dir } = await setup({ 'Notes.txt': 'a\nb\nc\n' });
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);
    const git = simpleGit(dir);

    const w1 = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'Notes.txt', content: 'AAA\n' },
    });
    expect(isError(w1), textOf(w1)).toBe(false);
    const w2 = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'notes.txt', content: 'BBB\n' },
    });
    expect(isError(w2), textOf(w2)).toBe(false);

    // One entry, keyed by the first spelling: on a case-insensitive filesystem the two names are
    // one file AND one on-disk shadow file, so a second entry used to overwrite the first's
    // shadow with HEAD's bytes and the commit found nothing staged (macOS/Windows CI).
    const changes = await ctx.shadows.changes('demo');
    expect(changes.map((c) => c.path)).toEqual(['Notes.txt']);
    expect(changes[0]?.content).toBe('BBB\n');

    const committed = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'edit both spellings' },
    });
    expect(isError(committed), textOf(committed)).toBe(false);
    const sha = structured(committed).sha as string;
    expect(await git.show([`${sha}:Notes.txt`])).toBe('BBB\n');
    const t = await tree(dir);
    expect(t).toContain('Notes.txt');
    expect(t).not.toContain('notes.txt');
  });

  it('commitContents still refuses a legacy index that spells one file two ways (ignorecase=true)', async () => {
    const { ctx, dir } = await setup({ 'Notes.txt': 'a\nb\nc\n' });
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);
    const git = simpleGit(dir);
    const headBefore = (await git.revparse(['HEAD'])).trim();
    await expect(
      ctx.git.commitContents(dir, {
        message: 'both',
        files: [
          { path: 'Notes.txt', content: 'AAA\n' },
          { path: 'notes.txt', content: 'BBB\n' },
        ],
      }),
    ).rejects.toThrow(/"Notes\.txt" and "notes\.txt"/);
    expect((await git.revparse(['HEAD'])).trim()).toBe(headBefore);
    expect((await git.status()).staged).toEqual([]);
  });

  it('just outside — core.ignorecase=false: both spellings commit as two separate tree entries', async () => {
    const { client, dir } = await setup({ 'Notes.txt': 'a\nb\nc\n' });
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'false']);

    const w1 = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'Notes.txt', content: 'AAA\n' },
    });
    expect(isError(w1), textOf(w1)).toBe(false);
    const w2 = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'notes.txt', content: 'BBB\n' },
    });
    expect(isError(w2), textOf(w2)).toBe(false);

    const committed = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'edit both spellings' },
    });
    expect(isError(committed), textOf(committed)).toBe(false);

    const t = await tree(dir);
    expect(t).toContain('Notes.txt');
    expect(t).toContain('notes.txt');
  });
});

/**
 * Issue #66 finding 3: `commitContents` keyed its two-spellings collision check on
 * `canonical.resolve(...)`, which returns a name unchanged whenever nothing in the tracked
 * listing folds onto it — including when NEITHER spelling is tracked yet. A session that writes
 * two brand-new files whose names fold together (`New.tex` and `new.tex`) resolved to two
 * different, unchanged keys, so the collision went uncaught and both staged as two separate tree
 * entries for what this filesystem treats as one file.
 */
describe('commitContents refuses two brand-new spellings colliding in one session (issue #66 finding 3)', () => {
  it('two spellings of one NEW file fold into one entry too; the legacy refusal covers an old index', async () => {
    const { client, ctx, dir } = await setup({ 'main.tex': 'orig\n' });
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);
    const git = simpleGit(dir);

    const w1 = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'New.tex', content: 'AAA\n' },
    });
    expect(isError(w1), textOf(w1)).toBe(false);
    const w2 = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'new.tex', content: 'BBB\n' },
    });
    expect(isError(w2), textOf(w2)).toBe(false);

    expect((await ctx.shadows.changes('demo')).map((c) => c.path)).toEqual(['New.tex']);
    const committed = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'add both spellings of one new file' },
    });
    expect(isError(committed), textOf(committed)).toBe(false);
    const t = await tree(dir);
    expect(t).toContain('New.tex');
    expect(t).not.toContain('new.tex');
    expect(await git.show(['HEAD:New.tex'])).toBe('BBB\n');

    // A legacy index (written before keys folded) can still spell one new file two ways:
    // `commitContents` refuses it by name rather than staging two tree entries for one file.
    const headBefore = (await git.revparse(['HEAD'])).trim();
    await expect(
      ctx.git.commitContents(dir, {
        message: 'legacy',
        files: [
          { path: 'Other.tex', content: 'x\n' },
          { path: 'other.tex', content: 'y\n' },
        ],
      }),
    ).rejects.toThrow(/"Other\.tex" and "other\.tex"/);
    expect((await git.revparse(['HEAD'])).trim()).toBe(headBefore);
    expect((await git.status()).staged).toEqual([]);
  });

  it('just outside — core.ignorecase=false: both new spellings commit as two separate tree entries', async () => {
    const { client, dir } = await setup({ 'main.tex': 'orig\n' });
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'false']);

    const w1 = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'New.tex', content: 'AAA\n' },
    });
    expect(isError(w1), textOf(w1)).toBe(false);
    const w2 = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'new.tex', content: 'BBB\n' },
    });
    expect(isError(w2), textOf(w2)).toBe(false);

    const committed = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'add both spellings of one new file' },
    });
    expect(isError(committed), textOf(committed)).toBe(false);

    const t = await tree(dir);
    expect(t).toContain('New.tex');
    expect(t).toContain('new.tex');
  });
});

describe('two spellings on an unborn HEAD (issue #66 item 4, re-verify)', () => {
  it('ignorecase=true, empty remote: the second spelling folds into the first entry; the legacy refusal still holds', async () => {
    const remoteTmp = await mkdtemp(path.join(os.tmpdir(), 'ovl-casefold-empty-'));
    cleanups.push(() => rm(remoteTmp, { recursive: true, force: true }));
    const bareDir = path.join(remoteTmp, 'empty.git');
    await simpleGit().raw(['init', '--bare', '-b', 'master', bareDir]);
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-casefold-ws-'));
    cleanups.push(() => rm(workspace, { recursive: true, force: true }));
    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: 'test',
      projects: [{ id: 'demo', gitUrl: pathToFileURL(bareDir).href }],
      defaultProject: 'demo',
    };
    const ctx = createContext(
      config,
      new CredentialResolver({}),
      IDENTITY,
      new ProjectRegistry(workspace),
    );
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    const synced = await client.callTool({
      name: 'project_sync',
      arguments: { project: 'demo', mode: 'clone' },
    });
    expect(isError(synced), textOf(synced)).toBe(false);
    const { dir } = await ctx.projectManager.requireProjectDir('demo');
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);

    for (const [p, content] of [
      ['New.tex', 'one\n'],
      ['new.tex', 'two\n'],
    ]) {
      const wrote = await client.callTool({
        name: 'write_file',
        arguments: { project: 'demo', path: p, content },
      });
      expect(isError(wrote), textOf(wrote)).toBe(false);
    }
    // The store folds the second spelling into the first entry, so one tree entry lands with the
    // later content; the `commitContents` refusal stays as a backstop for a legacy index.
    expect((await ctx.shadows.changes('demo')).map((c) => c.path)).toEqual(['New.tex']);
    const committed = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'both spellings' },
    });
    expect(isError(committed), textOf(committed)).toBe(false);
    const listed = (await simpleGit(dir).raw(['ls-tree', '-r', '--name-only', 'HEAD']))
      .split('\n')
      .filter(Boolean);
    expect(listed).toEqual(['New.tex']);
    expect(await simpleGit(dir).show(['HEAD:New.tex'])).toBe('two\n');
    await expect(
      ctx.git.commitContents(dir, {
        message: 'legacy',
        files: [
          { path: 'Old.tex', content: 'x\n' },
          { path: 'old.tex', content: 'y\n' },
        ],
      }),
    ).rejects.toThrow(/"Old\.tex" and "old\.tex"/);
  });
});

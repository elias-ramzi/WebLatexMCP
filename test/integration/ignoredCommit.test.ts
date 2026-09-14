import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, appendFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { simpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext, type AppContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { GitService } from '../../src/services/gitService.js';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * Regression tests for issue #66 item 1: `commit` with the default/"session" scope stages via
 * `GitService.commitContents` (`hash-object` + `update-index --add --cacheinfo`), which — unlike
 * `git add` — never consults `.gitignore`/`.git/info/exclude`. So a file this server wrote that
 * git would never stage (e.g. the `summarize-paper` skill's `PAPER-SUMMARY.md`, kept out of git
 * via `.git/info/exclude`) was committed and pushed anyway under the default scope, even though
 * scope "all" (`git add -A`) already respected exclusion. `commit` must now consult
 * `GitService.ignoredPaths` and skip session-scope paths git ignores.
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
  const workspace = await tmp('ovl-ignored-ws-');
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

describe('commit skips files git ignores', () => {
  it('skips the excluded file, commits the rest', async () => {
    const { client, ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), 'PAPER-SUMMARY.md\n');

    const wroteSummary = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'PAPER-SUMMARY.md', content: '# summary\n' },
    });
    expect(isError(wroteSummary), textOf(wroteSummary)).toBe(false);

    const wroteMain = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited.\n' },
    });
    expect(isError(wroteMain), textOf(wroteMain)).toBe(false);

    const committed = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'skip ignored file' },
    });
    expect(isError(committed), textOf(committed)).toBe(false);
    const sc = structured(committed);
    expect(sc.committed).toBe(true);
    expect((sc.files as Array<{ path: string }>).map((f) => f.path)).toEqual(['main.tex']);
    expect(sc.ignored).toEqual(['PAPER-SUMMARY.md']);
    expect(textOf(committed)).toMatch(/ignored by git/);

    const { simpleGit } = await import('simple-git');
    const git = simpleGit(dir);
    const tracked = await git.raw(['ls-tree', '-r', '--name-only', 'HEAD']);
    expect(tracked).not.toMatch(/PAPER-SUMMARY\.md/);

    const { readFile, stat } = await import('node:fs/promises');
    await expect(stat(path.join(dir, 'PAPER-SUMMARY.md'))).resolves.toBeDefined();
    const onDisk = await readFile(path.join(dir, 'PAPER-SUMMARY.md'), 'utf8');
    expect(onDisk).toBe('# summary\n');

    const remaining = await ctx.shadows.changes('demo');
    expect(remaining.map((c) => c.path)).not.toContain('PAPER-SUMMARY.md');
  });

  it('refuses when only an ignored file was written, then settles it', async () => {
    const { client, ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), 'PAPER-SUMMARY.md\n');

    const wroteSummary = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'PAPER-SUMMARY.md', content: '# summary\n' },
    });
    expect(isError(wroteSummary), textOf(wroteSummary)).toBe(false);

    const blocked = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'only ignored' },
    });
    expect(isError(blocked), textOf(blocked)).toBe(true);
    expect(textOf(blocked)).toMatch(/PAPER-SUMMARY\.md/);
    expect(textOf(blocked)).toMatch(/ignores/);

    expect(await ctx.shadows.changes('demo')).toEqual([]);

    // A second commit call falls through to scope "all" behaviour since the session has no more
    // tracked changes — nothing staged there either, so it errors with the *other* message.
    const second = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'second try' },
    });
    expect(isError(second), textOf(second)).toBe(true);
    expect(textOf(second)).toMatch(/Nothing to commit \(no staged changes\)/);
    expect(textOf(second)).not.toMatch(/ignores/);
    void dir;
  });

  it('a tracked file matching an ignore pattern still commits', async () => {
    const { client, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      'notes.txt': 'original\n',
    });
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), 'notes.txt\n');

    const wroteNotes = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'notes.txt', content: 'edited\n' },
    });
    expect(isError(wroteNotes), textOf(wroteNotes)).toBe(false);

    const committed = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'tracked-but-ignored still commits' },
    });
    expect(isError(committed), textOf(committed)).toBe(false);
    const sc = structured(committed);
    expect(sc.committed).toBe(true);
    expect((sc.files as Array<{ path: string }>).map((f) => f.path)).toEqual(['notes.txt']);
    expect(sc.ignored).toEqual([]);
  });

  it('a file tracked in HEAD but hand-removed from the index (`git rm --cached`) still commits', async () => {
    // `git check-ignore` decides "tracked" by the INDEX, but `commitContents` resets the index to
    // HEAD before staging — so what matters is whether HEAD tracks the file. A hand
    // `git rm --cached` on a file matching an ignore pattern left the two disagreeing: the file
    // was reported ignored (and the session's edit dropped from its record), while the reset
    // put it straight back into the index and it stayed tracked at HEAD's content.
    const { client, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      'notes.txt': 'original\n',
    });
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), 'notes.txt\n');
    await simpleGit(dir).raw(['rm', '--cached', '--', 'notes.txt']);

    const wroteNotes = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'notes.txt', content: 'edited\n' },
    });
    expect(isError(wroteNotes), textOf(wroteNotes)).toBe(false);

    const committed = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'still tracked at HEAD' },
    });
    expect(isError(committed), textOf(committed)).toBe(false);
    const sc = structured(committed);
    expect(sc.committed).toBe(true);
    expect((sc.files as Array<{ path: string }>).map((f) => f.path)).toEqual(['notes.txt']);
    expect(sc.ignored).toEqual([]);
    expect(await simpleGit(dir).show(['HEAD:notes.txt'])).toBe('edited\n');
  });

  it('scope "all" with paths judges "tracked" by the index, as its `git add` does: a `git rm --cached` file is reported ignored, never as git\'s raw "Use -f"', async () => {
    const { client, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      'notes.txt': 'original\n',
    });
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), 'notes.txt\n');
    await simpleGit(dir).raw(['rm', '--cached', '--', 'notes.txt']);
    await writeFile(path.join(dir, 'notes.txt'), 'edited by hand\n', 'utf8');

    const res = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'x', scope: 'all', paths: ['notes.txt'] },
    });
    expect(isError(res), textOf(res)).toBe(true);
    expect(textOf(res)).toMatch(/notes\.txt/);
    expect(textOf(res)).toMatch(/ignored by git/);
    expect(textOf(res)).not.toMatch(/Use -f/);
  });

  it('scope "all" with paths still commits a file force-added to the index (`git add -f`)', async () => {
    const { client, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), 'notes.txt\n');
    await writeFile(path.join(dir, 'notes.txt'), 'forced\n', 'utf8');
    await simpleGit(dir).raw(['add', '-f', '--', 'notes.txt']);

    const res = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'x', scope: 'all', paths: ['notes.txt'] },
    });
    expect(isError(res), textOf(res)).toBe(false);
    const sc = structured(res);
    expect(sc.committed).toBe(true);
    expect((sc.files as Array<{ path: string }>).map((f) => f.path)).toEqual(['notes.txt']);
    expect(sc.ignored).toEqual([]);
  });

  it('a clone with no commits yet says so, rather than printing "HEAD unborn"', async () => {
    // An empty remote (a GitHub repository created without a README) clones to an unborn HEAD.
    // `GitService.headSha` reports that as the sentinel "unborn"; the tool's text must not
    // present the sentinel as if it were a commit id.
    const remoteTmp = await tmp('ovl-ignored-empty-');
    const bareDir = path.join(remoteTmp, 'empty.git');
    await simpleGit().raw(['init', '--bare', '-b', 'master', bareDir]);
    const workspace = await tmp('ovl-ignored-ws-');
    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: 'test',
      projects: [{ id: 'demo', gitUrl: pathToFileURL(bareDir).href }],
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
    const synced = await client.callTool({
      name: 'project_sync',
      arguments: { project: 'demo', mode: 'clone' },
    });
    expect(isError(synced), textOf(synced)).toBe(false);
    const { dir } = await ctx.projectManager.requireProjectDir('demo');
    // `status` used to fail outright here: `rev-parse --abbrev-ref HEAD` cannot name an unborn
    // branch, and every tool that starts from `git.status` failed with the raw git message.
    const status = await client.callTool({ name: 'status', arguments: { project: 'demo' } });
    expect(isError(status), textOf(status)).toBe(false);
    expect(structured(status).branch).toBe('master');
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), 'PAPER-SUMMARY.md\n');

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'PAPER-SUMMARY.md', content: '# summary\n' },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);

    const res = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'x', scope: 'paths', paths: ['PAPER-SUMMARY.md'] },
    });
    expect(isError(res), textOf(res)).toBe(false);
    const sc = structured(res);
    expect(sc.committed).toBe(false);
    expect(sc.ignored).toEqual(['PAPER-SUMMARY.md']);
    expect(sc.sha).toBe('unborn');
    expect(textOf(res)).toMatch(/no commits yet/);
    expect(textOf(res)).not.toMatch(/HEAD unborn/);
  });

  it('names both the ignore and the conflict when a default-scope commit is left with only those', async () => {
    // Regression test for the `ignored.length > 0 ? `${ignoredSentence} ${baseMessage}` :
    // baseMessage` arm in `commitSession` — never exercised before this test: it fires only when
    // every remaining committable change is ignored AND something else is conflicted, so neither
    // the plain "nothing changed" nor the plain "every change is conflicted" message applies.
    const { client, ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), 'PAPER-SUMMARY.md\n');

    const wroteSummary = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'PAPER-SUMMARY.md', content: '# summary\n' },
    });
    expect(isError(wroteSummary), textOf(wroteSummary)).toBe(false);

    const wroteMain = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited.\n' },
    });
    expect(isError(wroteMain), textOf(wroteMain)).toBe(false);
    await ctx.shadows.markUnrecorded('demo', 'main.tex');

    const blocked = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'try default' },
    });
    expect(isError(blocked), textOf(blocked)).toBe(true);
    const text = textOf(blocked);
    expect(text).toMatch(/PAPER-SUMMARY\.md/);
    expect(text).toMatch(/ignore[sd]/);
    expect(text).toMatch(/could not be recorded/);

    // The ignored entry is settled immediately (never committable by any scope); the conflicted
    // entry stays flagged — a refusal never drops what it did not take.
    const remaining = await ctx.shadows.changes('demo');
    expect(remaining.map((c) => c.path)).toEqual(['main.tex']);
  });

  it('scope "paths" naming only an ignored file this session wrote settles it, without a raw git error', async () => {
    // F5/F6 regression: before the fix, `commitPaths`'s `coversPath` fallback let this
    // tracked-but-ignored path past the uncovered-paths refusal, and `git add -- PAPER-SUMMARY.md`
    // then failed outright with git's raw "The following paths are ignored… Use -f" text.
    const { client, ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), 'PAPER-SUMMARY.md\n');

    const wroteSummary = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'PAPER-SUMMARY.md', content: '# summary\n' },
    });
    expect(isError(wroteSummary), textOf(wroteSummary)).toBe(false);

    const result = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'only the ignored path',
        scope: 'paths',
        paths: ['PAPER-SUMMARY.md'],
      },
    });
    expect(isError(result), textOf(result)).toBe(false);
    const sc = structured(result);
    expect(sc.committed).toBe(false);
    expect(sc.settled).toEqual(['PAPER-SUMMARY.md']);
    // Structured, not only in the text: a client that drops the text must still see why nothing
    // was committed — and the headline must not claim the tree "matches HEAD" for a dirty file.
    expect(sc.ignored).toEqual(['PAPER-SUMMARY.md']);
    expect(textOf(result)).toContain('ignored by git');
    expect(textOf(result)).not.toContain('already matches HEAD');
    const text = textOf(result);
    expect(text).toMatch(/ignored by git/);
    expect(text).not.toMatch(/Use -f/);
    expect(await ctx.shadows.hasChanges('demo')).toBe(false);
  });

  it('scope "paths" naming an ignored file plus a dirty file commits the dirty one and reports the ignore', async () => {
    const { client, ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), 'PAPER-SUMMARY.md\n');

    const wroteSummary = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'PAPER-SUMMARY.md', content: '# summary\n' },
    });
    expect(isError(wroteSummary), textOf(wroteSummary)).toBe(false);
    const wroteMain = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited.\n' },
    });
    expect(isError(wroteMain), textOf(wroteMain)).toBe(false);

    const result = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'ignored plus dirty',
        scope: 'paths',
        paths: ['PAPER-SUMMARY.md', 'main.tex'],
      },
    });
    expect(isError(result), textOf(result)).toBe(false);
    const sc = structured(result);
    expect(sc.committed).toBe(true);
    expect((sc.files as Array<{ path: string }>).map((f) => f.path)).toEqual(['main.tex']);
    expect(sc.ignored).toEqual(['PAPER-SUMMARY.md']);
    void ctx;
  });

  it('scope "all" naming only an ignored, session-untracked path errors with "ignored by git", not a raw git hint', async () => {
    // Spec named this case as scope "paths"; it is unreachable there. `commitPaths`'s
    // uncovered-paths check runs *before* `withoutIgnored` and has no way to see this path as
    // "changed" at all: plain `git status` never lists an ignored path as untracked (confirmed
    // against real git — see the sibling coversPath-fallback tests above for the one case that
    // *does* pass the uncovered check, where this session tracked the path itself), and this
    // session never wrote it, so there is no shadow entry for the `coversPath` fallback to match
    // either. Every route into `commitPaths` for this path is refused earlier, with "Nothing to
    // commit at: ... not changed in the working tree" — never reaching `withoutIgnored`. The
    // `withoutIgnored` guard this test is for is real (see F5/F6 above) and is exercised the same
    // way by `commitEverything` when `paths` is given, which has no such pre-filter — that is the
    // path this test actually drives.
    const { client, ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), 'ignored-note.md\n');
    // Written directly to disk, bypassing the MCP server entirely, so neither git nor this
    // session's shadow store has ever heard of it.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'ignored-note.md'), 'never tracked\n', 'utf8');

    const result = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'only an untracked ignored path',
        scope: 'all',
        paths: ['ignored-note.md'],
      },
    });
    expect(isError(result), textOf(result)).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/ignored by git/);
    expect(text).not.toMatch(/Use -f/);
    expect(await ctx.shadows.hasChanges('demo')).toBe(false);
  });

  it('a .gitignore inside the tree counts too', async () => {
    const { client, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      '.gitignore': 'build/\n',
    });

    const wroteBuild = await client.callTool({
      name: 'write_file',
      arguments: {
        project: 'demo',
        path: 'build/out.log',
        content: 'log output\n',
        createDirs: true,
      },
    });
    expect(isError(wroteBuild), textOf(wroteBuild)).toBe(false);

    const wroteMain = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited.\n' },
    });
    expect(isError(wroteMain), textOf(wroteMain)).toBe(false);

    const committed = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: '.gitignore honoured too' },
    });
    expect(isError(committed), textOf(committed)).toBe(false);
    const sc = structured(committed);
    expect(sc.ignored).toEqual(['build/out.log']);
    expect((sc.files as Array<{ path: string }>).map((f) => f.path)).toEqual(['main.tex']);
    void dir;
  });
});

const IDENTITY = { name: 'Test', email: 'test@example.com' };

/**
 * Two sessions sharing one clone (mirrors `unrecordedCommit.test.ts`'s `setupTwoSessions`) — needed
 * to force a genuine record-time collision on a git-ignored file, which a single session cannot.
 */
async function setupTwoSessions(
  seed: Record<string, string>,
): Promise<{ session: (id: string) => Promise<{ client: Client; ctx: AppContext }>; dir: string }> {
  const remote = await createFakeRemote(seed);
  cleanups.push(remote.cleanup);
  const workspace = await tmp('ovl-ignored-multi-ws-');
  const dir = path.join(workspace, 'demo');
  await new GitService(IDENTITY).clone(remote.url, dir, { username: 'git' });

  const session = async (id: string): Promise<{ client: Client; ctx: AppContext }> => {
    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: id,
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
    };
    const ctx = createContext(config, new CredentialResolver({}), IDENTITY);
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `test-${id}`, version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    return { client, ctx };
  };

  return { session, dir };
}

/**
 * Regression tests for the PR #67 review finding 1: `commitSession` used to compute
 * `committableAll = selected.filter(c => !c.conflicted)` and check `ignoredPaths` only over that —
 * so an entry that was BOTH `conflicted` (or `unrecorded`) and git-ignored (this session wrote an
 * excluded file, a peer collided with it on the same lines) was never settled and never listed
 * under `ignored`. The refusal said "every change is conflicted (note.md) … Commit with scope
 * 'all'" — but scope "all" can never commit an ignored file either, so the only way out was
 * `discard`, throwing away the session's other in-flight edits along with it.
 */
describe('a conflicted-and-ignored session entry settles and reports as ignored (finding 1)', () => {
  it('settles the ignored+conflicted entry, commits the rest, and a second commit finds nothing left', async () => {
    const { session, dir } = await setupTwoSessions({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), 'note.md\n');
    const alpha = await session('alpha');
    const beta = await session('beta');

    // alpha creates the excluded file first, establishing its own shadow for it.
    const wroteNote = await alpha.client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'note.md', content: 'A sentence to collide on.\n' },
    });
    expect(isError(wroteNote), textOf(wroteNote)).toBe(false);

    // beta rewrites the same line on the shared working tree — beta's own shadow for this
    // (untracked, git-ignored) path has no HEAD counterpart, so its first touch applies its edit
    // directly (see ShadowStore.record's `shadowStr === null` branch).
    const editBeta = await beta.client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'demo',
        path: 'note.md',
        edits: [
          { oldString: 'A sentence to collide on.', newString: 'Beta rewrites the sentence.' },
        ],
      },
    });
    expect(isError(editBeta), textOf(editBeta)).toBe(false);

    // alpha then edits the very same line, on the tree beta already changed: alpha's shadow still
    // expects its own original content as the base, so the mutation recorder's three-way merge
    // against beta's edit conflicts, and alpha's entry for note.md is flagged — exactly the
    // sequence unrecordedCommit.test.ts's collision test uses.
    // `overrideExternalChanges` is needed here for an unrelated reason: alpha's OWN FileService
    // baseline for note.md (set when it wrote the file above) no longer matches the disk once
    // beta's edit landed, so the ordinary out-of-band-edit guard would refuse first. That guard is
    // not what this test is about — the shadow-level collision below fires regardless.
    const editAlpha = await alpha.client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'demo',
        path: 'note.md',
        edits: [
          { oldString: 'Beta rewrites the sentence.', newString: 'Alpha rewrites the sentence.' },
        ],
        overrideExternalChanges: true,
      },
    });
    expect(isError(editAlpha), textOf(editAlpha)).toBe(false);

    // Confirm the setup actually produced a conflicted, git-ignored entry before proving the fix.
    const beforeCommit = await alpha.ctx.shadows.changes('demo');
    const noteEntry = beforeCommit.find((c) => c.path === 'note.md');
    expect(noteEntry?.conflicted, JSON.stringify(beforeCommit)).toBe(true);

    // alpha also makes a normal, committable edit.
    const wroteMain = await alpha.client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited.\n' },
    });
    expect(isError(wroteMain), textOf(wroteMain)).toBe(false);

    const committed = await alpha.client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'settle the ignored-and-conflicted entry' },
    });
    expect(isError(committed), textOf(committed)).toBe(false);
    const sc = structured(committed);
    expect(sc.committed).toBe(true);
    expect((sc.files as Array<{ path: string }>).map((f) => f.path)).toEqual(['main.tex']);
    // Pre-fix: `ignored` is `[]` here (only checked over the non-conflicted subset) and
    // `conflicted` contains "note.md" — this is the assertion that fails before the fix.
    expect(sc.ignored).toEqual(['note.md']);
    expect(sc.conflicted).toEqual([]);
    expect(sc.unrecorded).toEqual([]);
    const text = textOf(committed);
    expect(text).not.toMatch(/note\.md.*conflicted|conflicted.*note\.md/);

    // A second commit from alpha finds nothing left wedged — the ignored+conflicted entry was
    // actually settled, not merely hidden from this result.
    const second = await alpha.client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'nothing left' },
    });
    expect(isError(second), textOf(second)).toBe(true);
    expect(textOf(second)).toMatch(/Nothing to commit \(no staged changes\)/);
    expect(textOf(second)).not.toMatch(/conflicted/);
    expect(textOf(second)).not.toMatch(/ignore/);
    expect(await alpha.ctx.shadows.hasChanges('demo')).toBe(false);
  });
});

/**
 * Regression tests for the PR #67 review finding 2: scope "paths" (and scope "all" with `paths`)
 * naming a DIRECTORY silently settles a this-session ignored entry underneath it. `git add --
 * notes` skips `notes/ig.md` without complaint (unlike naming it directly, which git refuses
 * outright), the commit lands, and `settle(["notes"])` drops the `notes/ig.md` shadow record —
 * never committed, never reported under `ignored`.
 */
describe('scope "paths"/"all" naming a directory reports a nested ignored entry (finding 2)', () => {
  it('scope "paths" naming the directory reports the nested ignored file', async () => {
    const { client, ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), 'notes/ig.md\n');

    const wroteA = await client.callTool({
      name: 'write_file',
      arguments: {
        project: 'demo',
        path: 'notes/a.tex',
        content: 'a note\n',
        createDirs: true,
      },
    });
    expect(isError(wroteA), textOf(wroteA)).toBe(false);
    const wroteIg = await client.callTool({
      name: 'write_file',
      arguments: {
        project: 'demo',
        path: 'notes/ig.md',
        content: 'ignored note\n',
        createDirs: true,
      },
    });
    expect(isError(wroteIg), textOf(wroteIg)).toBe(false);

    const result = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'commit the notes directory',
        scope: 'paths',
        paths: ['notes'],
      },
    });
    expect(isError(result), textOf(result)).toBe(false);
    const sc = structured(result);
    expect(sc.committed).toBe(true);
    expect((sc.files as Array<{ path: string }>).map((f) => f.path)).toEqual(['notes/a.tex']);
    // Pre-fix: `ignored` is `[]` here even though `notes/ig.md` was silently skipped by `git add`.
    expect(sc.ignored).toEqual(['notes/ig.md']);
    expect(sc.settled).toContain('notes/ig.md');
    void ctx;
  });

  it('scope "all" with paths naming the directory reports the nested ignored file too', async () => {
    const { client, ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), 'notes/ig.md\n');

    const wroteA = await client.callTool({
      name: 'write_file',
      arguments: {
        project: 'demo',
        path: 'notes/a.tex',
        content: 'a note\n',
        createDirs: true,
      },
    });
    expect(isError(wroteA), textOf(wroteA)).toBe(false);
    const wroteIg = await client.callTool({
      name: 'write_file',
      arguments: {
        project: 'demo',
        path: 'notes/ig.md',
        content: 'ignored note\n',
        createDirs: true,
      },
    });
    expect(isError(wroteIg), textOf(wroteIg)).toBe(false);

    const result = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'commit the notes directory, scope all',
        scope: 'all',
        paths: ['notes'],
      },
    });
    expect(isError(result), textOf(result)).toBe(false);
    const sc = structured(result);
    expect(sc.committed).toBe(true);
    expect((sc.files as Array<{ path: string }>).map((f) => f.path)).toEqual(['notes/a.tex']);
    expect(sc.ignored).toEqual(['notes/ig.md']);
    expect(sc.settled).toContain('notes/ig.md');
    void ctx;
  });
});

/**
 * Regression tests for issue #66 item 2: `GitService.ignoredPaths` with `tracked: 'head'`
 * subtracts what `trackedAtHead` finds via a *literal* pathspec (`--literal-pathspecs
 * ls-tree ... -- <rels>`), intersected with the caller's spelling by exact string equality.
 * On a case-insensitive repository (`core.ignorecase = true`, which git sets on clone/init on
 * macOS and Windows) HEAD can track `Notes.txt` while the caller — and the file on disk — spell
 * it `notes.txt`; a literal pathspec `notes.txt` never matches the tree entry `Notes.txt`, so a
 * tracked file was reported ignored. Exercises `ctx.git.ignoredPaths` directly against a clone
 * whose `core.ignorecase` is set explicitly in each test, so the result is deterministic on
 * Linux, macOS and Windows CI alike regardless of the host filesystem's own case sensitivity.
 */
describe('ignored vs tracked on a case-insensitive repository', () => {
  async function commitTracked(dir: string, relPath: string, content: string): Promise<void> {
    const full = path.join(dir, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    const git = simpleGit(dir);
    await git.raw(['add', '-f', '--', relPath]);
    await git.raw(['commit', '-m', `add ${relPath}`]);
  }

  it('(a) folds case when core.ignorecase=true: a tracked "Notes.txt" is not reported ignored for "notes.txt"', async () => {
    const { ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      '.gitignore': '*.txt\n',
    });
    await commitTracked(dir, 'Notes.txt', 'notes\n');
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);

    const result = await ctx.git.ignoredPaths(dir, ['notes.txt'], { tracked: 'head' });
    expect(result).toEqual([]);
  });

  it('(b) core.ignorecase=false: "notes.txt" stays ignored (it is a different file from tracked "Notes.txt")', async () => {
    const { ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      '.gitignore': '*.txt\n',
    });
    await commitTracked(dir, 'Notes.txt', 'notes\n');
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'false']);

    const result = await ctx.git.ignoredPaths(dir, ['notes.txt'], { tracked: 'head' });
    expect(result).toEqual(['notes.txt']);
  });

  it('(c) core.ignorecase=true: the fold does not over-match a name tracked in no spelling', async () => {
    const { ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      '.gitignore': '*.txt\n',
    });
    await commitTracked(dir, 'Notes.txt', 'notes\n');
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);

    const result = await ctx.git.ignoredPaths(dir, ['other.txt'], { tracked: 'head' });
    expect(result).toEqual(['other.txt']);
  });

  it('(d) core.ignorecase=true: directory components fold too ("Sub/Notes.txt" vs "sub/notes.txt")', async () => {
    const { ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      '.gitignore': '*.txt\n',
    });
    await commitTracked(dir, 'Sub/Notes.txt', 'notes\n');
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);

    const result = await ctx.git.ignoredPaths(dir, ['sub/notes.txt'], { tracked: 'head' });
    expect(result).toEqual([]);
  });

  it('(e) core.ignorecase=true: the exact tracked spelling still works', async () => {
    const { ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      '.gitignore': '*.txt\n',
    });
    await commitTracked(dir, 'Notes.txt', 'notes\n');
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);

    const result = await ctx.git.ignoredPaths(dir, ['Notes.txt'], { tracked: 'head' });
    expect(result).toEqual([]);
  });
});

/**
 * Regression tests for issue #66 item 3: `commitContents` stages via `update-index --cacheinfo`
 * / `--force-remove`, neither of which does the case-alias lookup `git add` does. On a
 * case-insensitive repository (`core.ignorecase = true`) a session that spells a tracked file
 * differently from HEAD (`notes.txt` vs tracked `Notes.txt` — the same file on disk) must stage
 * under HEAD's spelling, or the tree ends up with both names for what is one file on that
 * filesystem, and a deletion under the caller's spelling removes nothing.
 */
describe("commitContents stages under HEAD's spelling on a case-insensitive repository", () => {
  async function commitTracked(dir: string, relPath: string, content: string): Promise<void> {
    const full = path.join(dir, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    const git = simpleGit(dir);
    await git.raw(['add', '-f', '--', relPath]);
    await git.raw(['commit', '-m', `add ${relPath}`]);
  }

  it('(f) core.ignorecase=true: editing "notes.txt" stages under tracked "Notes.txt", not as a second entry', async () => {
    const { ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      '.gitignore': '*.txt\n',
    });
    await commitTracked(dir, 'Notes.txt', 'notes\n');
    await commitTracked(dir, 'Sub/Notes.txt', 'sub notes\n');
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);

    const res = await ctx.git.commitContents(dir, {
      message: 'edit under caller spelling',
      files: [{ path: 'notes.txt', content: 'changed\n' }],
    });
    expect(res.committed).toBe(true);

    const git = simpleGit(dir);
    const tree = (await git.raw(['ls-tree', '-r', '--name-only', 'HEAD']))
      .split('\n')
      .filter(Boolean);
    expect(tree).toContain('Notes.txt');
    expect(tree).not.toContain('notes.txt');
    expect(await git.show(['HEAD:Notes.txt'])).toBe('changed\n');
  });

  it('(g) core.ignorecase=true: deleting "sub/notes.txt" removes tracked "Sub/Notes.txt"', async () => {
    const { ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      '.gitignore': '*.txt\n',
    });
    await commitTracked(dir, 'Notes.txt', 'notes\n');
    await commitTracked(dir, 'Sub/Notes.txt', 'sub notes\n');
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);

    const res = await ctx.git.commitContents(dir, {
      message: 'delete under caller spelling',
      files: [{ path: 'sub/notes.txt', content: null }],
    });
    expect(res.committed).toBe(true);

    const git = simpleGit(dir);
    const tree = (await git.raw(['ls-tree', '-r', '--name-only', 'HEAD']))
      .split('\n')
      .filter(Boolean);
    expect(tree).not.toContain('Sub/Notes.txt');
    expect(tree).not.toContain('sub/notes.txt');
    expect(tree).toContain('Notes.txt');
  });

  it('(h) core.ignorecase=false: editing "notes.txt" against tracked "Notes.txt" creates a second, case-differing entry', async () => {
    const { ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      '.gitignore': '*.txt\n',
    });
    await commitTracked(dir, 'Notes.txt', 'notes\n');
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'false']);

    const res = await ctx.git.commitContents(dir, {
      message: 'edit under caller spelling, case-sensitive repo',
      files: [{ path: 'notes.txt', content: 'new\n' }],
    });
    expect(res.committed).toBe(true);

    const git = simpleGit(dir);
    const tree = (await git.raw(['ls-tree', '-r', '--name-only', 'HEAD']))
      .split('\n')
      .filter(Boolean);
    expect(tree).toContain('Notes.txt');
    expect(tree).toContain('notes.txt');
  });

  it("(i) core.ignorecase=true: a brand-new file with no HEAD counterpart stages under the caller's spelling", async () => {
    const { ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);

    const res = await ctx.git.commitContents(dir, {
      message: 'new file',
      files: [{ path: 'fresh.txt', content: 'f\n' }],
    });
    expect(res.committed).toBe(true);

    const git = simpleGit(dir);
    const tree = (await git.raw(['ls-tree', '-r', '--name-only', 'HEAD']))
      .split('\n')
      .filter(Boolean);
    expect(tree).toContain('fresh.txt');
  });
});

/**
 * Regression tests for issue #66's remaining case-fold defects:
 *  (j)/(k): `readAtRef`/`readAtRefBytes` did no case-fold at all, whatever `core.ignorecase`
 *   says, so a caller spelling a tracked `Notes.txt` as `notes.txt` got `null` back — which is
 *   how `ShadowStore.readHead` seeded a null base and a session's shadow became the whole
 *   working-tree file, peer lines included (see sessionCaseFold.test.ts for the end-to-end case).
 *  (l): the fold must be exact-first, not last-wins, when a tree holds both spellings.
 *  (m): the fold must be ASCII-only, never over-matching a non-ASCII case pair (Kelvin sign).
 *  (n): `ignoredPaths(..., { tracked: 'index' })` did no fold either.
 */
describe('case-fold defects in readAtRef/readAtRefBytes/ignoredPaths (index)', () => {
  async function commitTracked(dir: string, relPath: string, content: string): Promise<void> {
    const full = path.join(dir, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    const git = simpleGit(dir);
    await git.raw(['add', '-f', '--', relPath]);
    await git.raw(['commit', '-m', `add ${relPath}`]);
  }

  it('(j) core.ignorecase=true: readAtRef/readAtRefBytes resolve "notes.txt" to tracked "Notes.txt"', async () => {
    const { ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });
    await commitTracked(dir, 'Notes.txt', 'notes\n');
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);

    const text = await ctx.git.readAtRef(dir, 'HEAD', 'notes.txt');
    expect(text).toBe('notes\n');
    const bytes = await ctx.git.readAtRefBytes(dir, 'HEAD', 'notes.txt');
    expect(bytes).not.toBeNull();
    expect((bytes as Buffer).equals(Buffer.from('notes\n', 'utf8'))).toBe(true);
  });

  it('(j2) showAtRef (the read_file ref route) folds under core.ignorecase=true, not false', async () => {
    const { ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });
    await commitTracked(dir, 'Notes.txt', 'notes\n');
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);
    expect(await ctx.git.showAtRef(dir, 'HEAD', 'notes.txt')).toBe('notes\n');
  });

  it('(k2) core.ignorecase=false: showAtRef("notes.txt") fails against tracked "Notes.txt"', async () => {
    const { ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });
    await commitTracked(dir, 'Notes.txt', 'notes\n');
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'false']);
    await expect(ctx.git.showAtRef(dir, 'HEAD', 'notes.txt')).rejects.toThrow(/does not exist/);
  });

  it('(k) core.ignorecase=false: readAtRef("notes.txt") stays null against tracked "Notes.txt"', async () => {
    const { ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });
    await commitTracked(dir, 'Notes.txt', 'notes\n');
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'false']);

    const text = await ctx.git.readAtRef(dir, 'HEAD', 'notes.txt');
    expect(text).toBeNull();
  });

  // A case-insensitive host filesystem cannot hold both `Notes.txt` and `notes.txt` on disk at
  // once, so this setup (which needs both committed) only runs on Linux.
  describe.skipIf(process.platform !== 'linux')(
    'both spellings tracked (Linux only, needs a case-sensitive host filesystem)',
    () => {
      it('(l) core.ignorecase=true, both "Notes.txt" and "notes.txt" tracked: exact spelling wins', async () => {
        const { ctx, dir } = await setup({
          'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
        });
        // Alphabetically, "Notes.txt" (ASCII 'N' = 0x4E) sorts before "notes.txt" ('n' = 0x6E), so
        // a naive `new Map([...].map(name => [name.toLowerCase(), name]))` over `ls-tree`'s sorted
        // output always keeps the *lowercase* entry — the uppercase one is silently overwritten
        // regardless of which one the caller actually asked for. Ask for "Notes.txt" (the exact,
        // already-lowercase-losing spelling) to catch that, rather than "notes.txt" which the bug
        // happens to resolve correctly by the same accident of sort order.
        // Three spellings, not two: `ls-tree` sorts by byte, so with only `Notes.txt` and
        // `notes.txt` a first-wins fold map answers `Notes.txt` by accident of sort order. With
        // `NOTES.txt` sorting first, only an exact-first lookup lands on `Notes.txt`.
        await commitTracked(dir, 'NOTES.txt', 'shout\n');
        await commitTracked(dir, 'Notes.txt', 'upper\n');
        await commitTracked(dir, 'notes.txt', 'lower\n');
        await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);

        const text = await ctx.git.readAtRef(dir, 'HEAD', 'Notes.txt');
        expect(text).toBe('upper\n');
        expect(await ctx.git.showAtRef(dir, 'HEAD', 'Notes.txt')).toBe('upper\n');

        const res = await ctx.git.commitContents(dir, {
          message: 'edit exact spelling',
          files: [{ path: 'Notes.txt', content: 'upper-changed\n' }],
        });
        expect(res.committed).toBe(true);
        const git = simpleGit(dir);
        expect(await git.show(['HEAD:Notes.txt'])).toBe('upper-changed\n');
        expect(await git.show(['HEAD:notes.txt'])).toBe('lower\n');
        expect(await git.show(['HEAD:NOTES.txt'])).toBe('shout\n');
      });
    },
  );

  it('(m) core.ignorecase=true: commitContents does not over-fold a non-ASCII case pair (Kelvin sign)', async () => {
    const { ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });
    await commitTracked(dir, 'k.tex', 'lower k\n');
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);

    // U+212A KELVIN SIGN, which JS's `toLowerCase()` folds to ASCII 'k' but git's ASCII-only
    // `core.ignorecase` folding never would.
    const kelvinPath = '\u212A.tex';
    const res = await ctx.git.commitContents(dir, {
      message: 'new file with a look-alike name',
      files: [{ path: kelvinPath, content: 'kelvin\n' }],
    });
    expect(res.committed).toBe(true);

    const git = simpleGit(dir);
    const tree = (await git.raw(['ls-tree', '-r', '-z', '--name-only', 'HEAD']))
      .split('\0')
      .filter(Boolean);
    expect(tree).toContain(kelvinPath);
    expect(tree).toContain('k.tex');
    expect(await git.show(['HEAD:k.tex'])).toBe('lower k\n');
  });

  it('(n) core.ignorecase=true: ignoredPaths with tracked "index" folds too', async () => {
    const { ctx, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      '.gitignore': '*.txt\n',
    });
    await commitTracked(dir, 'Notes.txt', 'notes\n');
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);

    const result = await ctx.git.ignoredPaths(dir, ['notes.txt'], { tracked: 'index' });
    expect(result).toEqual([]);

    await simpleGit(dir).raw(['rm', '--cached', '--', 'Notes.txt']);
    const afterRm = await ctx.git.ignoredPaths(dir, ['notes.txt'], { tracked: 'index' });
    expect(afterRm).toEqual(['notes.txt']);
  });
});

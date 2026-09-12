import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext, type AppContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
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

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext, type AppContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { sessionStateDir } from '../../src/lib/sessionPaths.js';
import type { ServerConfig } from '../../src/types.js';
import { SEARCH_CONTENT_BUDGET } from '../../src/lib/searchBudget.js';

/**
 * `search_files` end to end, through a real MCP client, on a `mode: 'local'` project — the case
 * the tool is most useful for (a draft with no remote) and the one a `requireGitProject` slip
 * would break.
 *
 * The three guard tests here are the ones a future refactor can quietly undo:
 *
 *  - it takes NO project lock (asserted twice: no session state directory is created, and a call
 *    completes while a peer holds the lock),
 *  - it records NO revision baseline (asserted by a later `write_file` over a hand edit still
 *    succeeding — a recorded baseline turns that into an `ExternalChangeError`),
 *  - a file it could not search is reported as such rather than as containing nothing.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/**
 * A NESTED directory, so every reported path has a separator in it. An ordinary name on every
 * platform — see the POSIX-paths test below for why the backslash-in-a-filename trick that
 * `toolPathsPosix.test.ts` uses cannot apply to a tool that reads files back by the path it
 * reports.
 */
const SEGMENT = 'sections';

interface Harness {
  client: Client;
  ctx: AppContext;
  workspace: string;
  userDir: string;
}

const MAIN_TEX = [
  '\\documentclass{article}',
  '\\begin{document}',
  'see \\Cref{tab:sota} for the numbers',
  '% see \\Cref{tab:sota} (retired, keep for provenance)',
  '50\\% of runs cite \\Cref{tab:sota}',
  '\\end{document}',
  '',
].join('\n');

async function setup(): Promise<Harness> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-searchws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-searchdir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
  );
  await writeFile(path.join(userDir, 'main.tex'), MAIN_TEX);
  await mkdir(path.join(userDir, SEGMENT), { recursive: true });
  await writeFile(path.join(userDir, SEGMENT, 'intro.tex'), 'intro cites \\Cref{tab:sota}\n');
  await writeFile(path.join(userDir, 'figure.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(
    path.join(userDir, 'blob.tex'),
    Buffer.from('\\Cref{tab:sota}\u0000junk', 'utf8'),
  );

  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'test',
    projects: [{ id: 'paper', mode: 'local', path: userDir }],
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
  cleanups.unshift(() => client.close());
  return { client, ctx, workspace, userDir };
}

interface SearchOut {
  matches: Array<{ path: string; line: number; text: string; before?: string[]; after?: string[] }>;
  totalMatches: number;
  filesSearched: number;
  commentMatches: number;
  skipped: Array<{ path: string; reason: string }>;
  skippedByReason: Record<string, number>;
  omittedByCap: number;
  omittedBySize: number;
  note?: string;
}

function out(res: unknown): SearchOut {
  return (res as { structuredContent: SearchOut }).structuredContent;
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

describe('search_files on a local project', () => {
  it('searches content across the project without a git remote', async () => {
    const { client } = await setup();

    const res = await client.callTool({
      name: 'search_files',
      arguments: { project: 'paper', pattern: '\\Cref{tab:sota}' },
    });

    expect(res.isError ?? false).toBe(false);
    const r = out(res);
    expect(r.matches.map((m) => m.line)).toEqual([3, 4, 5, 1]);
    expect(r.totalMatches).toBe(4);
    // The text channel carries the same findings, for a client that drops structuredContent.
    expect(textOf(res)).toContain('main.tex');
    expect(textOf(res)).toContain('3:');
  });

  it('excludes % comments on request and reports the count either way', async () => {
    const { client } = await setup();

    const all = out(
      await client.callTool({
        name: 'search_files',
        arguments: { project: 'paper', pattern: '\\Cref{tab:sota}' },
      }),
    );
    expect(all.commentMatches).toBe(1);

    const live = out(
      await client.callTool({
        name: 'search_files',
        arguments: { project: 'paper', pattern: '\\Cref{tab:sota}', excludeComments: true },
      }),
    );
    // Line 4 is the commented one; line 5's `50\%` is a literal percent and stays.
    expect(live.matches.filter((m) => m.path === 'main.tex').map((m) => m.line)).toEqual([3, 5]);
    expect(live.commentMatches).toBe(1);
  });

  it('returns context lines when asked', async () => {
    const { client } = await setup();

    const r = out(
      await client.callTool({
        name: 'search_files',
        arguments: { project: 'paper', pattern: 'for the numbers', contextLines: 1 },
      }),
    );

    expect(r.matches[0]?.before).toEqual(['\\begin{document}']);
    expect(r.matches[0]?.after).toEqual(['% see \\Cref{tab:sota} (retired, keep for provenance)']);
  });

  it('reports the files it did NOT search, with the reason', async () => {
    const { client } = await setup();

    const res = await client.callTool({
      name: 'search_files',
      arguments: { project: 'paper', pattern: '\\Cref{tab:sota}' },
    });

    const r = out(res);
    // blob.tex contains the pattern and a NUL byte: reported as not searched, never as clean.
    expect(r.skipped).toEqual(
      expect.arrayContaining([
        { path: 'blob.tex', reason: 'binary' },
        { path: 'figure.png', reason: 'asset' },
      ]),
    );
    expect(r.skippedByReason['binary']).toBe(1);
    expect(textOf(res)).toContain('NOT searched');
  });

  it('refuses a pathological regex with an explanation instead of hanging', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'evil.tex'), `${'a'.repeat(60)}!\n`);

    const started = Date.now();
    const res = await client.callTool({
      name: 'search_files',
      arguments: { project: 'paper', pattern: '(a+)+$', regex: true },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('regex: false');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('treats the same pattern as literal text by default', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'evil.tex'), 'a literal (a+)+$ here\n');

    const r = out(
      await client.callTool({
        name: 'search_files',
        arguments: { project: 'paper', pattern: '(a+)+$' },
      }),
    );

    expect(r.matches.map((m) => m.path)).toEqual(['evil.tex']);
  });
});

describe('search_files: the guards', () => {
  it('takes no project lock — no session state directory is created', async () => {
    const { client, workspace } = await setup();

    await client.callTool({
      name: 'search_files',
      arguments: { project: 'paper', pattern: '\\Cref{tab:sota}' },
    });

    // runExclusive would have created <workspace>/.sessions/paper/ for its lock file. A
    // read-only tool must not: it is the observable trace of taking the lock.
    await expect(stat(sessionStateDir(workspace, 'paper'))).rejects.toThrow();
  });

  it('completes while a peer holds the project lock', async () => {
    const { client, ctx } = await setup();

    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const peer = ctx.projectManager.runExclusive('paper', async () => {
      await held;
    });

    const res = await Promise.race([
      client.callTool({
        name: 'search_files',
        arguments: { project: 'paper', pattern: '\\Cref{tab:sota}' },
      }),
      new Promise((_unused, reject) =>
        setTimeout(() => reject(new Error('search waited on the peer’s lock')), 5000),
      ),
    ]);

    expect(out(res).totalMatches).toBe(4);
    release();
    await peer;
  });

  it('records no read baseline, so a later write over a hand edit is not refused', async () => {
    const { client, userDir } = await setup();

    await client.callTool({
      name: 'search_files',
      arguments: { project: 'paper', pattern: '\\Cref{tab:sota}' },
    });
    // The user edits the file directly, as they would in their editor.
    await writeFile(path.join(userDir, 'main.tex'), `${MAIN_TEX}edited by hand\n`);

    const res = await client.callTool({
      name: 'write_file',
      arguments: { project: 'paper', path: 'main.tex', content: 'rewritten\n' },
    });

    // Had the search recorded a baseline, this would be an ExternalChangeError: the guard would
    // believe the caller had seen main.tex and could safely base a write on it.
    expect(res.isError ?? false).toBe(false);
    expect(textOf(res)).not.toContain('changed on disk');
  });

  /**
   * POSIX paths, deliberately NOT driven through the stubbed-`path.sep` harness that
   * `toolPathsPosix.test.ts` uses — and the reason is worth stating so nobody "fixes" it back.
   * That harness works by giving a directory a name that CONTAINS a backslash, so a POSIX run
   * has something real to convert. This tool reads every file back by the very path it reports,
   * and under the stub `sec\tions/intro.tex` would convert to `sec/tions/intro.tex`, a path
   * nothing is at: the trick is sound for a tool that only prints paths and wrong for one that
   * round-trips them.
   *
   * So on Windows the assertion below is the real thing (the separators between real segments
   * are genuinely backslashes, and `FileService.list`'s `toPosix` plus the tool's own conversion
   * at the response boundary are what make them `/`), while on Linux and macOS it characterizes
   * the contract rather than being able to fail. Said out loud rather than dressed up.
   */
  it("bounds what the CLIENT actually receives, not just the planner's own plan", async () => {
    // The unit tests bound `plan.matches`. That is a bound on an internal accounting object;
    // this is the one on the payload the caller gets, and they are not the same claim — the
    // whole lesson of #68 is that a budget charged against the wrong thing reads like a bound
    // and is not one. Asserted through a real tool call, on the real structuredContent.
    const { client, userDir } = await setup();
    // Document-controlled content, well past the 20000-character budget: 400 matching lines of
    // ~200 characters each is ~80k before any JSON escaping.
    const fat = Array.from(
      { length: 400 },
      (_, i) => `\\Cref{tab:sota} ${'x'.repeat(180)} ${i}`,
    ).join('\n');
    await writeFile(path.join(userDir, 'fat.tex'), `${fat}\n`);

    const res = await client.callTool({
      name: 'search_files',
      arguments: { project: 'paper', pattern: 'Cref{tab:sota}' },
    });
    const r = out(res);
    expect(JSON.stringify(r.matches).length).toBeLessThanOrEqual(SEARCH_CONTENT_BUDGET);
    // Cut, not silently truncated: the caller is told how much it did not get, and by WHICH
    // bound — the size budget here, not the match cap.
    expect(r.omittedBySize + r.omittedByCap).toBeGreaterThan(0);
  });

  it('charges the budget for BOTH channels — the text renders every kept match again', async () => {
    // The text channel is not a summary: it renders each kept match (path header, line, context)
    // a second time. A budget charged on the JSON alone let the whole result reach ~2x the
    // budget (39,675 characters observed for a 20000 budget), which is the #68 blowup halved.
    const { client, userDir } = await setup();
    const fat = Array.from(
      { length: 400 },
      (_, i) => `\\Cref{tab:sota} ${'x'.repeat(180)} ${i}`,
    ).join('\n');
    await writeFile(path.join(userDir, 'fat.tex'), `${fat}\n`);

    const res = await client.callTool({
      name: 'search_files',
      arguments: { project: 'paper', pattern: 'Cref{tab:sota}', contextLines: 1 },
    });
    const r = out(res);
    // Everything outside the matches in the text (the header line, the skipped-files line and the
    // notes) is bounded prose, a few hundred characters each; 2500 covers it with room to spare.
    const NON_MATCH_TEXT_ALLOWANCE = 2500;
    expect(JSON.stringify(r.matches).length + textOf(res).length).toBeLessThanOrEqual(
      SEARCH_CONTENT_BUDGET + NON_MATCH_TEXT_ALLOWANCE,
    );
    expect(r.omittedBySize).toBeGreaterThan(0);
  });

  it('reports every path with forward slashes, from a nested directory', async () => {
    const { client } = await setup();

    const res = await client.callTool({
      name: 'search_files',
      arguments: { project: 'paper', pattern: 'intro cites' },
    });

    const r = out(res);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.path).toBe(`${posixSegment()}/intro.tex`);
    expect(r.matches[0]?.path).not.toContain('\\');
    expect(textOf(res)).toContain(`${posixSegment()}/intro.tex`);
  });
});

/** What SEGMENT must look like once separators are POSIX. */
function posixSegment(): string {
  return SEGMENT.split('\\').join('/');
}

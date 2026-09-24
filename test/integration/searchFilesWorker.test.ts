import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * The backstop behind `searchPattern.ts`' analyzer: a regex the analyzer MISJUDGES must still
 * not hang the server.
 *
 * `RegExp.prototype.exec` cannot be interrupted from the thread running it, and this is a stdio
 * server with one event loop — so one catastrophic `exec` on the main thread stalls every tool
 * call, every peer heartbeat, everything, for as long as the match takes. The analyzer is the
 * first line; this test pins the second: regex matching runs in a worker the search terminates at
 * its deadline.
 *
 * The analyzer is bypassed here ON PURPOSE, with `vi.mock`, rather than by hunting for a pattern
 * it happens to accept today: whichever pattern that is, the analyzer's next tightening refuses
 * it and the test turns into a test of the refusal. Simulating "the analyzer got it wrong" is
 * the exact scenario the backstop exists for. The time budget is lowered the same way, so the
 * test costs one second rather than the production five.
 */

vi.mock('../../src/lib/searchPattern.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/lib/searchPattern.js')>();
  return {
    ...orig,
    // Compiles exactly as the real one does, minus the static analysis.
    buildSearchMatcher: (pattern: string, opts: { regex?: boolean; caseInsensitive?: boolean }) =>
      new RegExp(
        opts.regex ? pattern : orig.escapeLiteral(pattern),
        opts.caseInsensitive ? 'gi' : 'g',
      ),
  };
});

const BUDGET_MS = 1000;

vi.mock('../../src/lib/searchFiles.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/lib/searchFiles.js')>();
  return {
    ...orig,
    searchProject: (...args: Parameters<typeof orig.searchProject>) =>
      orig.searchProject(args[0], args[1], { ...args[2], budgetMs: BUDGET_MS }),
  };
});

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(): Promise<{ client: Client; userDir: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-searchwk-ws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-searchwk-dir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
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
  return { client, userDir };
}

describe('search_files: a regex the analyzer misjudged', () => {
  it('is cut off at the deadline, and the server keeps answering meanwhile', async () => {
    const { client, userDir } = await setup();
    // `(a+)+$` against 28 `a`s and a `!` is ~2^28 backtracking steps in ONE exec: 7.6s measured
    // on the main thread. Finite on purpose — should the backstop regress, this test fails in
    // seconds instead of hanging the run — yet several times the budget, so a main-thread exec
    // cannot finish inside the bounds asserted below.
    await writeFile(path.join(userDir, 'a.tex'), 'fine\n');
    await writeFile(path.join(userDir, 'evil.tex'), `${'a'.repeat(28)}!\n`);
    await writeFile(path.join(userDir, 'z.tex'), 'never reached\n');

    const started = Date.now();
    let searchDoneAt = 0;
    const search = client
      .callTool({
        name: 'search_files',
        arguments: { project: 'paper', pattern: '(a+)+$', regex: true },
      })
      .then((res) => {
        searchDoneAt = Date.now();
        return res;
      });

    // Give the search time to reach the catastrophic exec, then ask something unrelated. On a
    // blocked main thread even this timer fires late, so the time is measured from `started`.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const info = await client.callTool({ name: 'server_info', arguments: {} });
    const infoAt = Date.now();
    expect(info.isError ?? false).toBe(false);

    const res = await search;
    expect(res.isError ?? false).toBe(false);
    const r = res.structuredContent as {
      timedOut: boolean;
      filesNotReached: number;
      filesPartiallySearched: number;
      note?: string;
    };

    // The server answered an unrelated call while the search was still running.
    expect(infoAt - started).toBeLessThan(BUDGET_MS);
    expect(infoAt).toBeLessThan(searchDoneAt);
    // And the search itself came back at its deadline, with a partial answer that says so.
    expect(searchDoneAt - started).toBeLessThan(BUDGET_MS + 1500);
    expect(r.timedOut).toBe(true);
    expect(r.filesPartiallySearched).toBe(1);
    expect(r.filesNotReached).toBe(1);
    expect(r.note).toContain('evil.tex');
  });
});

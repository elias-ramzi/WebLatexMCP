import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, stat, readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext, type AppContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { sessionDir } from '../../src/lib/sessionPaths.js';
import { createFakeRemote } from './helpers/bareRepo.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * Pins the ONE thing `settleTakenPaths`' own unit tests structurally cannot see: which
 * `requireTracked` value each call site passes.
 *
 * The helper's two behaviours are discriminated at the lib level (a unit case each way), but the
 * *wiring* — `commit.ts`'s post-commit take passing `requireTracked: false` — had nothing pinning
 * it, so flipping that one argument to `true` left the whole suite green. That is the exact shape
 * of "simplification" the asymmetry exists to survive: unifying the two call sites rather than the
 * helper.
 *
 * **This has to be a probe on the call, not on the tree**, and the reason is worth stating because
 * the obvious test does not work. The flag's only effect is whether `ShadowStore.clear` runs for a
 * session holding no entries, and `clear` unlinks `shadow.json` — but `commit` calls
 * `shadows.refresh` one line later (`src/tools/commit.ts`, right after the settle), and `refresh`
 * ends in an unconditional `writeIndex`. So the index file is back on disk before the handler
 * returns, whichever way the flag goes, and an "is `shadow.json` absent afterwards" assertion
 * passes under both. Nothing about the resulting tree, the result payload or the store's contents
 * distinguishes them today.
 *
 * That makes the argument a *defensive* preservation rather than a behavioural one — it keeps the
 * post-commit take doing what the pre-refactor handler did, so that the day something downstream
 * starts telling an unlinked index from an empty one (issue #78 finding 3 proposes exactly that for
 * `peerEntries`, which maps ENOENT and an empty index to the same `[]` today) the refactor has not
 * quietly moved the behaviour underneath it. A counting delegate is the only honest way to hold
 * that line, so that is what this does.
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

async function setup(): Promise<{
  client: Client;
  ctx: AppContext;
  dir: string;
  workspace: string;
}> {
  const remote = await createFakeRemote({
    'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
  });
  cleanups.push(remote.cleanup);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-settle-wiring-'));
  cleanups.push(() =>
    rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'solo',
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
  return { client, ctx, dir, workspace };
}

describe('the post-commit take is wired unconditionally (requireTracked: false)', () => {
  it('a scope "all" commit clears the shadow even when this session holds no entries', async () => {
    const { client, ctx, dir, workspace } = await setup();
    const shadowFile = path.join(sessionDir(workspace, 'demo', 'solo'), 'shadow.json');

    // Count `clear` without stubbing it: the real method still runs, so nothing downstream is
    // faked out and the test fails for a real reason if the store changes underneath it.
    let clearCalls = 0;
    const realClear = ctx.shadows.clear.bind(ctx.shadows);
    ctx.shadows.clear = async (projectId: string): Promise<void> => {
      clearCalls += 1;
      await realClear(projectId);
    };

    // Reach the state the guard discriminates on: an index that EXISTS but holds no entries.
    // A server write creates it; a session-scope commit settles that entry and leaves the file
    // behind, empty. Absent-before/absent-after would make the whole exercise vacuous.
    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited by this session.\n' },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);
    await expect(stat(shadowFile)).resolves.toBeDefined();

    const first = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'this session lands its own edit' },
    });
    expect(isError(first), textOf(first)).toBe(false);
    expect(structured(first).committed).toBe(true);

    // The session-scope commit settles what landed: the index survives, holding nothing. That is
    // the precondition — `hasChanges()` is now false, which is the only input the flag reads.
    expect(await ctx.shadows.changes('demo')).toEqual([]);
    const emptied = JSON.parse(await readFile(shadowFile, 'utf8')) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(emptied.entries)).toEqual([]);
    expect(clearCalls).toBe(0);

    // Something for `scope: "all"` to take that this session did not author — a hand edit in the
    // clone, exactly the case that scope exists for.
    await writeFile(path.join(dir, 'notes.tex'), 'A paragraph typed straight into the clone.\n');

    const all = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'take the whole tree', scope: 'all' },
    });
    expect(isError(all), textOf(all)).toBe(false);
    expect(structured(all).committed).toBe(true);
    expect(structured(all).settled).toEqual([]);

    // The assertion this file exists for. Under `requireTracked: true` the `hasChanges` guard
    // short-circuits and `clear` is never reached; the tree, the payload and the store all look
    // identical either way, so this call count is the only witness.
    expect(
      clearCalls,
      'the post-commit "all" take must clear unconditionally, as the pre-refactor handler did',
    ).toBe(1);
  });
});

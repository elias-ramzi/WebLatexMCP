import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext, type AppContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * Regression test for the "an unrecorded entry never settles" finding: `ShadowStore.markUnrecorded`
 * writes no base/shadow, and `record`'s conflicted early return means the shadow can never be
 * updated again while the flag is set — so once a further edit lands on disk (the session keeps
 * working, unaware its record failed), the shadow is permanently desynced from whatever eventually
 * reaches HEAD. `refresh`'s natural settle check (`bytesEqual(head, shadow)`) can then never fire,
 * so the entry lingers in the shadow store forever. `commit`'s default (session) scope refuses with
 * "could not be recorded"; the *documented* remedy, `scope: "all"`, commits the working tree — but
 * before this fix nothing ever told the shadow store that the taken path was settled, so the entry
 * stayed there, still `conflicted`, and the very next default-scope commit refused the exact same
 * way — permanently wedging the session out of its own default commit path for that project.
 * `ShadowStore.settle` (called by `commit` after a "all"/"paths" commit lands) fixes this: those
 * scopes take the working tree deliberately, so whatever the entry said is superseded by that act.
 *
 * Driven through the MCP client (real write_file/commit tools), with `ctx.shadows.markUnrecorded`
 * called directly to simulate the one failure mode this targets: a mutation whose bytes reached the
 * working tree but whose shadow record itself threw (see `src/lib/mutationRecorder.ts`, and its own
 * tests, for that failure path in isolation).
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
): Promise<{ client: Client; ctx: AppContext; remote: FakeRemote }> {
  const remote = await createFakeRemote(seed);
  cleanups.push(remote.cleanup);
  const workspace = await tmp('ovl-unrecorded-ws-');
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
  return { client, ctx, remote };
}

describe('an unrecorded shadow entry settles once deliberately taken', () => {
  it('scope "all" unwedges the default commit path (main.tex)', async () => {
    const { client, ctx } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited.\n' },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);

    // Simulate the recorder's own failure path (touch/record threw after the write already
    // landed) — see mutationRecorder.test.ts for that path in isolation.
    await ctx.shadows.markUnrecorded('demo', 'main.tex');

    // A further edit lands on disk after the entry is flagged: `record`'s conflicted early return
    // (see ShadowStore.record) never updates the shadow while `conflicted` is set, so the shadow
    // is now permanently desynced from what actually ends up in HEAD once "all" commits the
    // *current* working tree. Without this second write the shadow happens to already equal what
    // gets committed and the bug does not reproduce (refresh's own bytesEqual check settles it by
    // coincidence) — this step is what makes the reproduction real.
    const wroteAfterFail = await client.callTool({
      name: 'write_file',
      arguments: {
        project: 'demo',
        path: 'main.tex',
        content: 'Hello, edited after the failure.\n',
      },
    });
    expect(isError(wroteAfterFail), textOf(wroteAfterFail)).toBe(false);

    // 1. Default scope refuses: every change is unrecorded, so it cannot be staged from the shadow.
    const blocked = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'try default' },
    });
    expect(isError(blocked), textOf(blocked)).toBe(true);
    expect(textOf(blocked)).toMatch(/could not be recorded/);

    // 2. The documented remedy: take the working tree as it stands with scope "all".
    const taken = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'take it', scope: 'all' },
    });
    expect(isError(taken), textOf(taken)).toBe(false);
    expect(structured(taken).committed).toBe(true);

    // The direct proof, and the one that actually distinguishes pre-/post-fix: does the shadow
    // store still hold *anything* for this session on this project after the deliberate take?
    // Pre-fix it does — main.tex's entry, still conflicted, never dropped — because nothing ever
    // told the store the taken path was settled; the only thing that could have cleared it,
    // `refresh`'s own `bytesEqual(head, shadow)` check, can never fire once the shadow is
    // permanently stale (see the comment on the second write above). Post-fix, `commit` calls
    // `ctx.shadows.clear(id)` for scope "all" with no `paths`, so nothing is left.
    expect(await ctx.shadows.hasChanges('demo')).toBe(false);

    // 3. The wedge, made concrete: a *fresh* edit should commit normally through the default
    // (session) scope. Pre-fix, main.tex's entry is still sitting in the store (still conflicted),
    // so this refuses exactly the same way step 1 did — permanently, for every future commit on
    // this project by this session.
    const wroteAgain = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited again.\n' },
    });
    expect(isError(wroteAgain), textOf(wroteAgain)).toBe(false);

    const committedAgain = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'now it works' },
    });
    expect(isError(committedAgain), textOf(committedAgain)).toBe(false);
    expect(structured(committedAgain).committed).toBe(true);
  });

  it('scope "all" with a "."-shaped paths list settles what git committed', async () => {
    // `git add -- .` / `./figures` commit everything under them, but `coversPath` treats "." as
    // covering nothing — so without normalisation the entry survived a deliberate take.
    const { client, ctx } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      'figures/a.tex': 'original\n',
    });
    for (const [spelling, file] of [
      ['.', 'main.tex'],
      ['./figures', 'figures/a.tex'],
    ] as const) {
      const wrote = await client.callTool({
        name: 'write_file',
        arguments: { project: 'demo', path: file, content: `edited for ${spelling}\n` },
      });
      expect(isError(wrote), textOf(wrote)).toBe(false);
      await ctx.shadows.markUnrecorded('demo', file);
      const again = await client.callTool({
        name: 'write_file',
        arguments: { project: 'demo', path: file, content: `edited again for ${spelling}\n` },
      });
      expect(isError(again), textOf(again)).toBe(false);

      const taken = await client.callTool({
        name: 'commit',
        arguments: {
          project: 'demo',
          message: `take ${spelling}`,
          scope: 'all',
          paths: [spelling],
        },
      });
      expect(isError(taken), textOf(taken)).toBe(false);
      expect(structured(taken).conflicted).toEqual([]);
      expect(await ctx.shadows.hasChanges('demo'), spelling).toBe(false);
    }
  });

  it('scope "paths" settles an unrecorded entry under the covering directory', async () => {
    const { client, ctx } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      'figures/a.tex': 'original\n',
    });

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'figures/a.tex', content: 'edited\n' },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);

    await ctx.shadows.markUnrecorded('demo', 'figures/a.tex');

    // See the sibling test above: a further edit after the flag is what actually desyncs the
    // shadow from what "paths" ends up committing (the shadow can no longer be updated while
    // `conflicted` is set — ShadowStore.record's early return).
    const wroteAfterFail = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'figures/a.tex', content: 'edited after failure\n' },
    });
    expect(isError(wroteAfterFail), textOf(wroteAfterFail)).toBe(false);

    const taken = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'take figures directory',
        scope: 'paths',
        paths: ['figures'],
      },
    });
    expect(isError(taken), textOf(taken)).toBe(false);
    expect(structured(taken).committed).toBe(true);
    expect(structured(taken).conflicted).toEqual([]);
    expect(textOf(taken)).not.toMatch(/excluded/);

    // Directory coverage: settle drops the entry even though `paths` named the directory, not the
    // exact file the entry tracks.
    expect(await ctx.shadows.hasChanges('demo')).toBe(false);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readdir, access } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import type { ServerConfig } from '../../src/types.js';
import { DEFAULT_REWRITE_MODE } from '../../src/lib/rewriteMode.js';

const DOC = ['\\documentclass{article}', '\\begin{document}', 'Hello', '\\end{document}', ''].join(
  '\n',
);

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Harness {
  client: Client;
  workspace: string;
  userDir: string;
}

async function setup(rewriteMode?: ServerConfig['rewriteMode']): Promise<Harness> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-rwmode-ws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-rwmode-dir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
  );
  await writeFile(path.join(userDir, 'main.tex'), DOC);

  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'test',
    projects: [],
    rewriteMode: rewriteMode ?? DEFAULT_REWRITE_MODE,
    // The distinction the text line turns on: `rewriteMode` is populated either way, so only
    // this says whether the user named a mode. Mirrors what `loadConfig` produces.
    rewriteModeExplicit: rewriteMode !== undefined,
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
  await client.callTool({
    name: 'register_project',
    arguments: { project: 'draft', path: userDir },
  });
  return { client, workspace, userDir };
}

function structured(res: unknown): Record<string, unknown> {
  return (res as { structuredContent: Record<string, unknown> }).structuredContent;
}

/** The human-readable half of a tool result — what a text-only MCP client actually renders. */
function textOf(res: unknown): string {
  return ((res as { content: Array<{ text?: string }> }).content ?? [])
    .map((c) => c.text ?? '')
    .join('\n');
}

/**
 * The mode is settable and reportable on a **local** project. That is the whole reason it is not
 * reported through `status`, which calls `requireGitProject` first: an in-place draft with no
 * remote — the case rewrite preservation suits best — would never have seen its own setting.
 */
describe('set_rewrite_mode on a local (in-place) project', () => {
  it('reports the default without storing anything, then stores a choice', async () => {
    const { client, workspace } = await setup();

    const reported = structured(
      await client.callTool({ name: 'set_rewrite_mode', arguments: { project: 'draft' } }),
    );
    expect(reported.mode).toBe('off');
    expect(reported.source).toBe('default');
    expect(reported.changed).toBe(false);
    // Nothing was configured via setup() (no rewriteMode argument), so envConfigured must say so
    // even though `mode` still reports the built-in "off" default — the two are orthogonal.
    expect(reported.envConfigured).toBe(false);
    // Reporting must not create state — "nothing stored" has to stay distinguishable from
    // "stored, and it happens to equal the default", or the env default could never move. The
    // *directory* is not the assertion: the session registry creates that for its own heartbeat.
    await expect(
      access(path.join(workspace, '.sessions', 'draft', 'rewrite-mode.json')),
    ).rejects.toThrow();

    const set = structured(
      await client.callTool({
        name: 'set_rewrite_mode',
        arguments: { project: 'draft', mode: 'always' },
      }),
    );
    expect(set).toMatchObject({ mode: 'always', source: 'project', changed: true });

    const after = structured(
      await client.callTool({ name: 'set_rewrite_mode', arguments: { project: 'draft' } }),
    );
    expect(after).toMatchObject({ mode: 'always', source: 'project' });
  });

  it('stores the mode beside the clones, never inside the user’s own directory', async () => {
    const { client, workspace, userDir } = await setup();
    await client.callTool({
      name: 'set_rewrite_mode',
      arguments: { project: 'draft', mode: 'off' },
    });

    expect(await readdir(path.join(workspace, '.sessions', 'draft'))).toContain(
      'rewrite-mode.json',
    );
    // The invariant, not an incidental path: nothing this feature writes may land in a directory
    // the user could commit.
    expect(await readdir(userDir)).toEqual(['main.tex']);
  });

  it('survives a restart, because it is how the project is worked on and not a session detail', async () => {
    const { client, workspace, userDir } = await setup();
    await client.callTool({
      name: 'set_rewrite_mode',
      arguments: { project: 'draft', mode: 'always' },
    });
    await client.close();

    // A second server over the same workspace — a different session id, as a peer agent would be.
    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: 'other',
      projects: [{ id: 'draft', mode: 'local', path: userDir }],
    };
    const ctx = createContext(
      config,
      new CredentialResolver({}),
      { name: 'Test', email: 'test@example.com' },
      new ProjectRegistry(workspace),
    );
    const server = createServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const peer = new Client({ name: 'peer', version: '0.0.0' });
    await Promise.all([server.connect(st), peer.connect(ct)]);
    cleanups.push(() => peer.close());

    const seen = structured(
      await peer.callTool({ name: 'set_rewrite_mode', arguments: { project: 'draft' } }),
    );
    expect(seen).toMatchObject({ mode: 'always', source: 'project' });
  });

  it('reports the mode it moved away from, so a caller can name the transition', async () => {
    const { client } = await setup();

    const first = structured(
      await client.callTool({
        name: 'set_rewrite_mode',
        arguments: { project: 'draft', mode: 'always' },
      }),
    );
    // Moving off the unstored default: `previous` is what was in effect, not what was stored.
    expect(first).toMatchObject({ previous: 'off', mode: 'always', changed: true });

    const second = structured(
      await client.callTool({
        name: 'set_rewrite_mode',
        arguments: { project: 'draft', mode: 'off' },
      }),
    );
    expect(second).toMatchObject({ previous: 'always', mode: 'off', changed: true });

    // A report-only call is not a transition, and must not be dressed up as one.
    const reported = structured(
      await client.callTool({ name: 'set_rewrite_mode', arguments: { project: 'draft' } }),
    );
    expect(reported).toMatchObject({ previous: 'off', mode: 'off', changed: false });
  });

  it('falls back to the env default when nothing is stored', async () => {
    const { client } = await setup('always');
    const reported = structured(
      await client.callTool({ name: 'set_rewrite_mode', arguments: { project: 'draft' } }),
    );
    expect(reported).toMatchObject({ mode: 'always', source: 'default', envConfigured: true });
  });

  it('reports envConfigured alongside source on the setting branch too, not just report-only', async () => {
    // set_rewrite_mode's "storing" branch builds structuredContent separately from the
    // report-only branch — this pins that envConfigured reaches both, not just one.
    const { client } = await setup('always');
    const set = structured(
      await client.callTool({
        name: 'set_rewrite_mode',
        arguments: { project: 'draft', mode: 'off' },
      }),
    );
    expect(set).toMatchObject({ mode: 'off', source: 'project', envConfigured: true });
  });

  it('refuses an unknown mode at the schema, rather than storing it', async () => {
    const { client, workspace } = await setup();
    const refused = (await client.callTool({
      name: 'set_rewrite_mode',
      arguments: { project: 'draft', mode: 'comment' },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(refused.isError).toBe(true);
    // The refusal names the vocabulary, so a caller who guessed "comment" is told what to say.
    expect(refused.content[0]?.text).toContain('always');
    await expect(
      access(path.join(workspace, '.sessions', 'draft', 'rewrite-mode.json')),
    ).rejects.toThrow();
  });
});

describe('set_rewrite_mode concurrency', () => {
  it('serialises concurrent set_rewrite_mode calls, so no two report the same previous', async () => {
    // Protects the schema's advertised guarantee (outputSchema.previous in
    // src/tools/setRewriteMode.ts): "Read inside the same lock as the write, so it can never be
    // a stale value from a peer session racing this one." The existing "reports the mode it
    // moved away from" test above calls set_rewrite_mode sequentially, so it would pass
    // identically even if the `previous` read were hoisted outside runExclusive — it does not
    // pin the concurrency claim at all.
    //
    // Here three calls fire together (Promise.all), each setting a different mode. Under real
    // serialization inside the lock, exactly one call sees the pre-existing "off" default as its
    // `previous`, and the other two each see the mode set by whichever call ran immediately
    // before it — forming one consistent serial chain with no two calls reporting the same
    // `previous`. If the `previous` read were hoisted outside the lock, two racers could both
    // read "off" before either write lands, and this test would see a duplicate `previous`
    // value — see the mutation drill in the task report for the observed failure.
    const { client } = await setup();

    const modes = ['always', 'prose', 'off'] as const;
    const results = await Promise.all(
      modes.map((mode) =>
        client
          .callTool({ name: 'set_rewrite_mode', arguments: { project: 'draft', mode } })
          .then((res) => structured(res)),
      ),
    );

    const previousValues = results.map((r) => r.previous as string);
    const setValues = results.map((r) => r.mode as string);

    // No two calls may report the same previous — the assertion that actually catches a hoisted
    // read: two racers reading the same pre-write value would both report "off".
    expect(new Set(previousValues).size).toBe(previousValues.length);

    // Exactly one call reports the pre-existing starting state ("off", the default with nothing
    // stored) as its previous — the call that acquired the lock first. "off" is also one of the
    // three modes being set, so a call could legitimately report previous: "off" because a peer
    // just set it to off too; the chain built below disambiguates the two cases rather than just
    // counting occurrences of "off".

    // Build the serial chain: start at "off" (the pre-existing default), and repeatedly find the
    // call whose `previous` matches the current head, extending the chain by that call's `mode`.
    // A correct serialization produces a chain of exactly modes.length links with no leftovers.
    let current = 'off';
    const consumed = new Set<number>();
    const chain: string[] = [current];
    for (let step = 0; step < modes.length; step++) {
      const idx = results.findIndex(
        (r, i) => !consumed.has(i) && (r.previous as string) === current,
      );
      expect(idx).toBeGreaterThanOrEqual(0);
      consumed.add(idx);
      const nextMode = setValues[idx];
      if (nextMode === undefined) throw new Error('unreachable: idx was just found in results');
      current = nextMode;
      chain.push(current);
    }
    // Every call was consumed into the chain — none left over reporting a `previous` nobody ever
    // set (which would mean the chain forked or a value came from nowhere).
    expect(consumed.size).toBe(modes.length);

    // The final persisted state equals the mode set by whichever call ran last in the chain.
    const finalReport = structured(
      await client.callTool({ name: 'set_rewrite_mode', arguments: { project: 'draft' } }),
    );
    expect(finalReport.mode).toBe(chain[chain.length - 1]);
  });
});

describe('list_projects reports the effective rewrite mode', () => {
  it('says nothing in the text about a mode nobody chose, and names one that was', async () => {
    // The built-in default is not a setting: announcing it on every line of a fresh install is
    // noise, and labelling it "(env default)" states a configuration the user never made.
    const plain = await setup();
    expect(
      textOf(await plain.client.callTool({ name: 'list_projects', arguments: {} })),
    ).not.toContain('rewrites:');

    // A mode the env really named must reach a text-only client, with nothing stored per project.
    const configured = await setup('always');
    expect(
      textOf(await configured.client.callTool({ name: 'list_projects', arguments: {} })),
    ).toContain('rewrites: always (env default)');

    // And a stored mode is reported as the project's own, not as the environment's.
    await configured.client.callTool({
      name: 'set_rewrite_mode',
      arguments: { project: 'draft', mode: 'off' },
    });
    const stored = textOf(
      await configured.client.callTool({ name: 'list_projects', arguments: {} }),
    );
    expect(stored).toContain('rewrites: off');
    expect(stored).not.toContain('(env default)');
  });

  it('names the mode and where it came from, for a project git tools never see', async () => {
    const { client } = await setup();

    const before = structured(await client.callTool({ name: 'list_projects', arguments: {} }));
    expect((before.projects as Array<Record<string, unknown>>)[0]).toMatchObject({
      project: 'draft',
      mode: 'local',
      rewriteMode: 'off',
      rewriteModeSource: 'default',
      envConfigured: false,
    });

    await client.callTool({
      name: 'set_rewrite_mode',
      arguments: { project: 'draft', mode: 'always' },
    });
    const after = structured(await client.callTool({ name: 'list_projects', arguments: {} }));
    expect((after.projects as Array<Record<string, unknown>>)[0]).toMatchObject({
      rewriteMode: 'always',
      rewriteModeSource: 'project',
    });
  });

  it('carries envConfigured in structuredContent even when the text suffix is suppressed', async () => {
    // The text line's "(env default)" suffix and structuredContent.envConfigured must read the
    // same underlying value (ctx.config.rewriteModeExplicit) — this is the one the text-only
    // rendering logic in list_projects.ts is not allowed to diverge from.
    const configured = await setup('always');
    const result = structured(
      await configured.client.callTool({ name: 'list_projects', arguments: {} }),
    );
    expect((result.projects as Array<Record<string, unknown>>)[0]).toMatchObject({
      rewriteModeSource: 'default',
      envConfigured: true,
    });
  });
});

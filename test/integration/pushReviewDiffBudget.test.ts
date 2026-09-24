import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { createFakeRemote } from './helpers/bareRepo.js';
import { expectNoUndeclaredKeys } from '../helpers/outputSchema.js';
import {
  DIFF_CONTENT_BUDGET,
  DIFF_MAX_FILES,
  PUSH_REVIEW_SCAFFOLD_OVERHEAD,
} from '../../src/lib/diffBudget.js';
import type { ServerConfig } from '../../src/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * `push`'s branch-mode review payload, measured end to end on what a client actually receives
 * (issue #160).
 *
 * `test/unit/pushReviewDiffBudget.test.ts` pins the planner. This file pins the thing the planner
 * exists for and that a unit test structurally cannot reach: the size of the REAL tool result off
 * a real MCP round trip over a real git clone, and the schema the server actually advertises.
 * Before this fix the assertion below measured ~118k characters — the shape of payload a client
 * rejected outright in #68, delivering nothing at all — and none of the counters existed.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/**
 * A long file whose every twentieth line differs — spaced well past `git diff`'s 3 lines of
 * context, so the change comes back as ~100 SEPARATE hunks. That spacing is load-bearing: at every
 * fifth line git merges the lot into one 47k hunk, and since there is deliberately no
 * keep-at-least-one rule (a single hunk can be an entire regenerated .bbl) the planner correctly
 * drops it whole — which would leave the "the budget is actually spent" assertion below measuring
 * an empty patch.
 */
const LINES = 2000;
const filler = (i: number): string => `line ${i} ${'lorem ipsum dolor sit amet '.repeat(2)}`;
const original = Array.from({ length: LINES }, (_, i) => filler(i)).join('\n') + '\n';
const edited =
  Array.from({ length: LINES }, (_, i) => (i % 20 === 0 ? `${filler(i)} CHANGED` : filler(i))).join(
    '\n',
  ) + '\n';

async function setup(files: Record<string, string>): Promise<Client> {
  const remote = await createFakeRemote(files);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-pushreview-'));
  cleanups.push(remote.cleanup, () =>
    rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
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
  return client;
}

/** Everything the caller receives: the model-visible text AND the JSON it is handed beside it. */
function receivedChars(res: CallToolResult): number {
  return textOf(res).length + JSON.stringify(res.structuredContent ?? {}).length;
}

function textOf(res: CallToolResult): string {
  return (res.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('');
}

interface ReviewStructured {
  status: string;
  summary: string;
  branch: string;
  base: string;
  diff: string;
  diffFiles: Array<{ path: string; added: number; removed: number }>;
  diffChars: number;
  diffTruncated: boolean;
  diffHunksOmitted: number;
  diffPatchFilesOmitted: number;
  diffFilesOmitted: number;
  diffNote?: string;
}

async function stageReviewBranch(
  client: Client,
  branch: string,
  files: Record<string, string>,
): Promise<CallToolResult> {
  for (const [p, content] of Object.entries(files)) {
    await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: p, content },
    });
  }
  return (await client.callTool({
    name: 'push',
    arguments: {
      project: 'demo',
      mode: 'branch',
      branch,
      message: 'review me',
      confirm: true,
    },
  })) as CallToolResult;
}

describe('push branch mode budgets its review diff', () => {
  it('fits a large real review patch inside the budget, cut at hunk boundaries', async () => {
    const client = await setup({ 'main.tex': original });
    const res = await stageReviewBranch(client, 'review/big', { 'main.tex': edited });
    const s = res.structuredContent as unknown as ReviewStructured;

    expect(s.status).toBe('awaiting-approval');
    // The claim of the whole issue. Pre-fix this was ~118k characters.
    expect(receivedChars(res)).toBeLessThanOrEqual(DIFF_CONTENT_BUDGET);
    // And not so far under it that the budget is being wasted: the patch is charged once here,
    // because it ships in one channel, so most of the budget must reach the reviewer.
    expect(receivedChars(res)).toBeGreaterThan(DIFF_CONTENT_BUDGET / 2);

    expect(s.diffTruncated).toBe(true);
    expect(s.diffHunksOmitted).toBeGreaterThan(0);
    expect(s.diffChars).toBeGreaterThan(DIFF_CONTENT_BUDGET);
    expect(s.diffNote).toBeDefined();

    // Cut at hunk boundaries, with the file still named: a patch that stops mid-hunk looks like a
    // diff and is not one.
    expect(s.diff).toContain('diff --git a/main.tex b/main.tex');
    expect(s.diff).toContain('+++ b/main.tex');
    const lines = s.diff.trimEnd().split('\n');
    expect(lines[lines.length - 1]).toMatch(
      /^\.\.\. \d+ of \d+ hunk\(s\) of main\.tex omitted \(\d+ chars\)$/,
    );

    // Never cut silently: the note reaches the TEXT channel too, so a client that drops
    // structuredContent still learns the patch was cut and how to read the rest.
    expect(textOf(res)).toContain(s.diffNote!);
    expect(textOf(res)).toContain(`diff, ref: "${s.base}...${s.branch}"`);

    // The patch itself deliberately does NOT ship in the text channel — that is why it is charged
    // once (structuredOnlyCost). If this assertion is ever "fixed" by rendering the patch into
    // the text, the charge must become renderCost in the same commit or the result overruns by 2x.
    expect(textOf(res)).not.toContain('diff --git');
  });

  it('declares every key it returns, in the schema it advertises', async () => {
    const client = await setup({ 'main.tex': original });
    const res = await stageReviewBranch(client, 'review/schema', { 'main.tex': edited });
    const s = res.structuredContent as unknown as ReviewStructured;

    // Non-vacuous: the counters have to be PRESENT for this to say anything, and an undeclared
    // key is not a wide payload — the SDK Client compiles an ajv validator per advertised schema
    // at listTools() with additionalProperties: false, so the caller gets -32602 and no result at
    // all (#137, #146).
    expect(s.diffTruncated).toBe(true);
    expect(s.diffChars).toBeGreaterThan(0);
    expect(s.diffNote).toBeDefined();
    await expectNoUndeclaredKeys(client, 'push', res.structuredContent);
  });

  it('caps diffFiles and counts what the cap dropped', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < DIFF_MAX_FILES + 5; i += 1) many[`sec${i}.tex`] = `new file ${i}\n`;
    const client = await setup({ 'main.tex': 'hello\n' });
    const res = await stageReviewBranch(client, 'review/many', many);
    const s = res.structuredContent as unknown as ReviewStructured;

    expect(s.diffFiles).toHaveLength(DIFF_MAX_FILES);
    expect(s.diffFilesOmitted).toBe(5);
    expect(s.diffTruncated).toBe(true);
    expect(s.diffNote).toContain('diffFiles[]');
    expect(receivedChars(res)).toBeLessThanOrEqual(DIFF_CONTENT_BUDGET);
    await expectNoUndeclaredKeys(client, 'push', res.structuredContent);
  });

  it('leaves a small review diff whole and reports it untruncated', async () => {
    const client = await setup({ 'main.tex': original });
    const res = await stageReviewBranch(client, 'review/small', {
      'main.tex': original.replace(filler(3), `${filler(3)} tweaked`),
    });
    const s = res.structuredContent as unknown as ReviewStructured;

    expect(s.diffTruncated).toBe(false);
    expect(s.diffHunksOmitted).toBe(0);
    expect(s.diffPatchFilesOmitted).toBe(0);
    expect(s.diffFilesOmitted).toBe(0);
    expect(s.diffNote).toBeUndefined();
    expect(s.diff).toContain('tweaked');
    expect(s.diff.length).toBe(s.diffChars);
    expect(s.diff).not.toContain('hunk(s) of');
    // No cut, so the text channel is the bare summary, exactly as before this change.
    expect(textOf(res)).toBe(s.summary);
    await expectNoUndeclaredKeys(client, 'push', res.structuredContent);
  });

  it('pins the scaffold reserve against the JSON the tool really sends', async () => {
    const client = await setup({ 'main.tex': original });
    const res = await stageReviewBranch(client, 'review/scaffold', { 'main.tex': edited });
    const s = res.structuredContent as unknown as ReviewStructured;

    // The scaffold has to account for the counter KEYS as well as the fixed ones, so assert they
    // are actually in the payload being measured — otherwise this passes against a result that
    // carries none of them and pins nothing.
    expect(s.diffTruncated).toBe(true);
    expect(s.diffNote).toBeDefined();

    // Everything the planner charges exactly, removed — what is left is the scaffold the constant
    // stands in for. Bounded from BOTH sides, so it can neither under-charge (which makes the
    // budget above a lie) nor be padded into meaninglessness.
    const scaffold =
      JSON.stringify(s).length -
      JSON.stringify(s.diff).length -
      JSON.stringify(s.diffFiles).length -
      JSON.stringify(s.summary).length -
      JSON.stringify(s.diffNote ?? '').length -
      s.branch.length -
      s.base.length;
    expect(scaffold).toBeLessThanOrEqual(PUSH_REVIEW_SCAFFOLD_OVERHEAD);
    expect(scaffold).toBeGreaterThan(PUSH_REVIEW_SCAFFOLD_OVERHEAD / 4);
  });
});

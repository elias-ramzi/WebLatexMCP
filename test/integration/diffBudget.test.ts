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
import { CHANGE_DIFF_BUDGET, DIFF_CONTENT_BUDGET } from '../../src/lib/diffBudget.js';
import type { ServerConfig } from '../../src/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * The `diff` budget (issue #153), measured end to end on what a client actually receives.
 *
 * `test/unit/diffBudget.test.ts` pins the planner. This file pins the thing the planner exists
 * for and that a unit test structurally cannot reach: the size of the REAL tool result, text
 * channel plus JSON-encoded structured channel, off a real MCP round trip over a real git clone.
 * Before this fix, the two assertions below returned ~114k and ~34k characters respectively — the
 * shape of payload a client rejected outright in #68, delivering nothing at all.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A long file whose every fifth line differs between the two versions — many separate hunks. */
const LINES = 600;
const filler = (i: number): string => `line ${i} ${'lorem ipsum dolor sit amet '.repeat(2)}`;
const original = Array.from({ length: LINES }, (_, i) => filler(i)).join('\n') + '\n';
const edited =
  Array.from({ length: LINES }, (_, i) => (i % 5 === 0 ? `${filler(i)} CHANGED` : filler(i))).join(
    '\n',
  ) + '\n';

async function setup(files: Record<string, string>) {
  const remote = await createFakeRemote(files);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-diffbudget-'));
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
  const text = (res.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? '')
    .join('');
  return text.length + JSON.stringify(res.structuredContent ?? {}).length;
}

function textOf(res: CallToolResult): string {
  return (res.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('');
}

interface DiffStructured {
  diff: string;
  files: Array<{ path: string; added: number; removed: number }>;
  truncated: boolean;
  diffChars: number;
  hunksOmitted: number;
  patchFilesOmitted: number;
  filesOmitted: number;
  note?: string;
}

describe('diff is budgeted across both channels', () => {
  it('fits a large real patch inside the budget, cut at hunk boundaries', async () => {
    const client = await setup({ 'main.tex': original });
    await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: edited },
    });

    const res = (await client.callTool({
      name: 'diff',
      arguments: { project: 'demo' },
    })) as CallToolResult;
    const structured = res.structuredContent as unknown as DiffStructured;

    // The claim of the whole issue. Pre-fix this was ~114k characters.
    expect(receivedChars(res)).toBeLessThanOrEqual(DIFF_CONTENT_BUDGET);

    expect(structured.truncated).toBe(true);
    expect(structured.hunksOmitted).toBeGreaterThan(0);
    expect(structured.diffChars).toBeGreaterThan(DIFF_CONTENT_BUDGET);
    expect(structured.note).toBeDefined();

    // Cut at hunk boundaries, with the file still named: a patch that stops mid-hunk looks like a
    // diff and is not one.
    expect(structured.diff).toContain('diff --git a/main.tex b/main.tex');
    expect(structured.diff).toContain('+++ b/main.tex');
    expect(structured.diff).toMatch(
      /\n\.\.\. \d+ of \d+ hunk\(s\) of main\.tex omitted \(\d+ chars\)/,
    );
    // The marker is the LAST line: nothing of the cut hunks trails behind it.
    const lines = structured.diff.trimEnd().split('\n');
    expect(lines[lines.length - 1]).toMatch(/^\.\.\. \d+ of \d+ hunk\(s\) of main\.tex omitted/);

    // Both channels come off ONE plan: the text carries the budgeted patch, never the full one.
    expect(textOf(res)).toContain(structured.diff);
    expect(textOf(res)).toContain(structured.note!);
  });

  it('detail: "full" is the escape hatch, and shows what the budget was holding back', async () => {
    const client = await setup({ 'main.tex': original });
    await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: edited },
    });

    const full = (await client.callTool({
      name: 'diff',
      arguments: { project: 'demo', detail: 'full' },
    })) as CallToolResult;
    const structured = full.structuredContent as unknown as DiffStructured;

    expect(structured.truncated).toBe(false);
    expect(structured.hunksOmitted).toBe(0);
    expect(structured.diff.length).toBe(structured.diffChars);
    expect(structured.diff).not.toContain('... ');
    // If this ever stops being far over the budget, the "auto" assertion above has stopped
    // proving anything: the patch would simply have got small.
    expect(receivedChars(full)).toBeGreaterThan(DIFF_CONTENT_BUDGET * 2);
  });

  it('declares every key it returns, in the schema it advertises', async () => {
    const client = await setup({ 'main.tex': original });
    await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: edited },
    });
    // An undeclared key is not a wide payload: the SDK Client compiles an ajv validator per
    // advertised schema at listTools() with additionalProperties: false, so the caller gets
    // -32602 and NO result at all (#137, #146). These four counters and the note are new.
    const res = (await client.callTool({
      name: 'diff',
      arguments: { project: 'demo' },
    })) as CallToolResult;
    await expectNoUndeclaredKeys(client, 'diff', res.structuredContent);
  });
});

describe('the write-confirmation diff is budgeted harder', () => {
  it('cuts a whole-file overwrite down and says it did', async () => {
    const client = await setup({ 'main.tex': original });
    const res = (await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: edited },
    })) as CallToolResult;
    const structured = res.structuredContent as unknown as { diff: string; diffTruncated: boolean };

    expect(structured.diffTruncated).toBe(true);
    // Nobody asked for this patch; it rides along on a call whose answer is "written". The slack
    // over the budget is the headline and the JSON scaffolding around it, not patch content.
    expect(receivedChars(res)).toBeLessThan(CHANGE_DIFF_BUDGET * 2);
    expect(structured.diff).toContain('diff --git a/main.tex b/main.tex');
    expect(structured.diff).toContain('call diff for the full patch');
    expect(textOf(res)).toContain('wrote main.tex');
    expect(textOf(res)).toContain(structured.diff);
    await expectNoUndeclaredKeys(client, 'write_file', res.structuredContent);
  });

  it('leaves a small edit_file confirmation diff whole, and reports it untruncated', async () => {
    const client = await setup({ 'main.tex': original });
    const res = (await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'demo',
        path: 'main.tex',
        edits: [{ oldString: filler(7), newString: `${filler(7)} tweaked` }],
      },
    })) as CallToolResult;
    const structured = res.structuredContent as unknown as { diff: string; diffTruncated: boolean };

    expect(structured.diffTruncated).toBe(false);
    expect(structured.diff).toContain('tweaked');
    expect(structured.diff).not.toContain('hunk(s) of');
    await expectNoUndeclaredKeys(client, 'edit_file', res.structuredContent);
  });
});

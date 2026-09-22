import { describe, it, expect, afterEach } from 'vitest';
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
 * `check_citations` used to return all four finding lists whole, in BOTH channels (#154). The
 * case that bites is ordinary rather than hostile: a group `.bib` carried in the project, most of
 * whose entries this paper does not cite. These run the real tool through a real MCP `Client`, so
 * the cut is proved where the caller actually sees it — text included.
 *
 * The client calls `listTools()` first, deliberately. The SDK compiles an ajv validator per
 * advertised output schema at that point and checks every later result against it, with every
 * object node `additionalProperties: false` — so a counter added to `structuredContent` but not
 * declared in `outputSchema` makes the call fail with `-32602` and return nothing at all
 * (#137, #146). A client that never lists tools caches no validator and proves nothing here.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Report {
  undefinedCitations: Array<{ key: string; uses: unknown[]; usesOmitted?: number }>;
  uncitedEntries: Array<{ key: string }>;
  duplicateKeys: Array<{ key: string; occurrences: unknown[]; occurrencesOmitted?: number }>;
  incompleteEntries: Array<{ key: string; missing: string[]; missingOmitted?: number }>;
  undefinedCitationsOmitted: number;
  uncitedEntriesOmitted: number;
  duplicateKeysOmitted: number;
  incompleteEntriesOmitted: number;
  note?: string;
}

async function setup(files: Record<string, string>): Promise<Client> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-citebudget-ws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-citebudget-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
  );
  for (const [rel, body] of Object.entries(files)) {
    await writeFile(path.join(userDir, rel), body, 'utf8');
  }

  const config: ServerConfig = { workspaceRoot: workspace, sessionId: 'test', projects: [] };
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
  // Arms the per-tool ajv validator — see the header.
  await client.listTools();
  await client.callTool({ name: 'register_project', arguments: { project: 'p', path: userDir } });
  return client;
}

async function check(
  client: Client,
  args: Record<string, unknown> = {},
): Promise<{
  report: Report;
  text: string;
}> {
  const res = await client.callTool({
    name: 'check_citations',
    arguments: { project: 'p', ...args },
  });
  const content = (res as { content: Array<{ type: string; text?: string }> }).content;
  return {
    report: res.structuredContent as unknown as Report,
    text: content.map((c) => c.text ?? '').join('\n'),
  };
}

/** A complete entry, so it never lands in `incompleteEntries` and muddies the counts. */
function entry(key: string): string {
  return `@article{${key},\n  author = {A. Author},\n  title = {A Title for ${key}},\n  journal = {J},\n  year = {2020}\n}\n`;
}

function bib(n: number, prefix = 'e'): string {
  return Array.from({ length: n }, (_, i) => entry(`${prefix}${String(i).padStart(3, '0')}`)).join(
    '\n',
  );
}

describe('check_citations bounds its report (#154)', () => {
  it('caps uncitedEntries at 20 and counts the rest, in BOTH channels', async () => {
    // The ordinary case: a shared .bib in the project, only a couple of its entries cited.
    const client = await setup({
      'refs.bib': bib(25),
      'main.tex': '\\cite{e000}\n\\cite{e001}\n',
    });
    const { report, text } = await check(client);

    expect(report.uncitedEntries).toHaveLength(20);
    expect(report.uncitedEntriesOmitted).toBe(3); // 25 entries - 2 cited - 20 shown
    expect(report.uncitedEntries.length + report.uncitedEntriesOmitted).toBe(23);
    expect(report.note).toContain('uncitedEntries: showing 20 of 23');

    // The text channel is rendered from the already-cut payload, so it cannot disagree.
    expect(text).toContain('Defined but never cited (showing 20 of 23):');
    expect(text).toContain('e002');
    expect(text).not.toContain('e024');
    expect(text).toContain(report.note!);
  });

  it('cuts the nested uses of one over-cited missing key, and says how many', async () => {
    // One missing key cited 30 times is a single finding carrying 30 {path,line} objects; capping
    // the outer list alone leaves every one of them in the payload.
    const client = await setup({
      'refs.bib': entry('kept'),
      'main.tex': Array.from({ length: 30 }, () => '\\cite{ghost}').join('\n') + '\n',
    });
    const { report, text } = await check(client);

    expect(report.undefinedCitations).toHaveLength(1);
    expect(report.undefinedCitations[0]!.uses).toHaveLength(20);
    expect(report.undefinedCitations[0]!.usesOmitted).toBe(10);
    expect(text).toContain('+10 more');
  });

  it('maxResults narrows each list, and the counters follow', async () => {
    const client = await setup({ 'refs.bib': bib(25), 'main.tex': '\\cite{e000}\n' });
    const { report, text } = await check(client, { maxResults: 3 });

    expect(report.uncitedEntries).toHaveLength(3);
    expect(report.uncitedEntriesOmitted).toBe(21);
    expect(text).toContain('Defined but never cited (showing 3 of 24):');
  });

  it('a small, clean report is unchanged: no counters fire and no note is added', async () => {
    const client = await setup({
      'refs.bib': bib(3),
      'main.tex': '\\cite{e000}\n\\cite{e001}\n\\cite{e002}\n',
    });
    const { report, text } = await check(client);

    expect(report.uncitedEntries).toEqual([]);
    expect(report.undefinedCitations).toEqual([]);
    expect(report.uncitedEntriesOmitted).toBe(0);
    expect(report.undefinedCitationsOmitted).toBe(0);
    expect(report.duplicateKeysOmitted).toBe(0);
    expect(report.incompleteEntriesOmitted).toBe(0);
    expect(report.note).toBeUndefined();
    expect(text).toContain('No problems found.');
  });

  it('keeps `bibliographyProject` read-only, two-sandboxed, and its uncitedEntries empty', async () => {
    // The budget must not disturb the cross-project rule: findings are limited to cited keys and
    // `uncitedEntries` stays empty by design, not by a cap that happened to fire.
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-citebudget-ws2-'));
    const draftDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-citebudget-draft-'));
    const groupDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-citebudget-group-'));
    cleanups.push(
      () => rm(workspace, { recursive: true, force: true }),
      () => rm(draftDir, { recursive: true, force: true }),
      () => rm(groupDir, { recursive: true, force: true }),
    );
    await writeFile(path.join(draftDir, 'main.tex'), '\\cite{g000}\n\\cite{nowhere}\n', 'utf8');
    await writeFile(path.join(groupDir, 'group.bib'), bib(40, 'g'), 'utf8');

    const config: ServerConfig = { workspaceRoot: workspace, sessionId: 'test', projects: [] };
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
    await client.listTools();
    await client.callTool({
      name: 'register_project',
      arguments: { project: 'draft', path: draftDir },
    });
    await client.callTool({
      name: 'register_project',
      arguments: { project: 'group', path: groupDir },
    });

    const res = await client.callTool({
      name: 'check_citations',
      arguments: { project: 'draft', bibliographyProject: 'group' },
    });
    const report = res.structuredContent as unknown as Report & { bibliographyProject?: string };
    expect(report.bibliographyProject).toBe('group');
    expect(report.uncitedEntries).toEqual([]);
    expect(report.uncitedEntriesOmitted).toBe(0);
    expect(report.undefinedCitations.map((u) => u.key)).toEqual(['nowhere']);
  });
});

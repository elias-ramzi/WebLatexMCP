import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { FILE_LIST_CONTENT_BUDGET } from '../../src/lib/fileListBudget.js';
import { expectDeclaredField, expectNoUndeclaredKeys } from '../helpers/outputSchema.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * `list_files` returned the whole listing in BOTH channels with no bound of any kind (#164) — on
 * the tool an agent calls first to orient itself in a project it has never seen. These run the
 * real tool through a real MCP `Client`, so the cut is proved where the caller actually sees it,
 * text included.
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

interface Listing {
  files: Array<{ path: string; type: string; sizeBytes: number }>;
  totalFiles: number;
  omittedByCap: number;
  omittedBySize: number;
  omittedByType?: Record<string, number>;
  note?: string;
}

async function setup(files: Record<string, string>): Promise<Client> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-listbudget-ws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-listbudget-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
  );
  await Promise.all(
    Object.entries(files).map(async ([rel, body]) => {
      const abs = path.join(userDir, ...rel.split('/'));
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, body, 'utf8');
    }),
  );

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

async function list(
  client: Client,
  args: Record<string, unknown> = {},
): Promise<{ listing: Listing; text: string }> {
  const res = await client.callTool({
    name: 'list_files',
    arguments: { project: 'p', ...args },
  });
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  const text = (res.content as Array<{ type: string; text: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  return { listing: res.structuredContent as unknown as Listing, text };
}

/**
 * The ordinary shape that blows this up: one plot per seed per ablation. Every path starts with
 * `assets/`, which sorts before `main.tex` — so a budget spent in walk order returns figures and
 * not one source file.
 */
function figureTree(n: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < n; i += 1) {
    const dir = `assets/experiments/ablation-${String(i).padStart(4, '0')}/seed-${i % 7}`;
    out[`${dir}/curve-precision-recall-final.pdf`] = 'x';
  }
  return out;
}

describe('list_files is bounded in both channels', () => {
  it('cuts a large figure tree, counts it, and keeps the whole result under the budget', async () => {
    const client = await setup({
      ...figureTree(400),
      'main.tex': '\\documentclass{article}\\begin{document}hi\\end{document}\n',
      'refs.bib': '@article{a, title={t}}\n',
    });

    const { listing, text } = await list(client);

    // The whole claim, asserted FIRST so that on the pre-#164 tool this test fails for the reason
    // it exists for — the unbounded payload — rather than on a counter that was not there yet.
    const rendered = JSON.stringify(listing).length + text.length;
    expect(rendered).toBeLessThanOrEqual(FILE_LIST_CONTENT_BUDGET);

    expect(listing.totalFiles).toBe(402);
    expect(listing.files.length).toBeLessThan(listing.totalFiles);
    expect(listing.omittedBySize).toBe(listing.totalFiles - listing.files.length);
    expect(listing.omittedByCap).toBe(0);
    expect(listing.note).toBeDefined();

    // The text channel is built from the already-cut listing, not the full one.
    expect(text.split('\n')).toHaveLength(listing.files.length + 1);
    expect(text.endsWith(listing.note!)).toBe(true);

    await expectNoUndeclaredKeys(client, 'list_files', listing);
  });

  it('keeps the .tex and .bib an alphabetically earlier assets/ tree would have starved', async () => {
    const client = await setup({
      ...figureTree(400),
      'main.tex': 'a\n',
      'sections/method.tex': 'b\n',
      'refs.bib': '@article{a}\n',
      'NOTES.md': 'c\n',
      'conference.sty': 'd\n',
    });

    const { listing } = await list(client);
    const kept = new Set(listing.files.map((f) => f.path));
    for (const p of ['main.tex', 'sections/method.tex', 'refs.bib', 'NOTES.md', 'conference.sty']) {
      expect(kept.has(p), `${p} should have survived the cut`).toBe(true);
    }
    expect(listing.omittedByType).toMatchObject({ tex: 0, bib: 0, doc: 0, other: 0 });
    expect(listing.omittedByType!.asset).toBeGreaterThan(0);
  });

  it('brings the omitted entries back whole under the remedy the note names', async () => {
    const client = await setup({
      ...figureTree(400),
      'main.tex': 'a\n',
    });
    const { listing } = await list(client);
    expect(listing.note).toContain('subdir');
    expect(listing.note).toContain('filter');

    // `subdir` narrows the walk itself, so a directory that fits comes back uncut.
    const narrowed = await list(client, { subdir: 'assets/experiments/ablation-0000' });
    expect(narrowed.listing.totalFiles).toBe(1);
    expect(narrowed.listing.files).toHaveLength(1);
    expect(narrowed.listing.note).toBeUndefined();
  });

  it('honours maxResults and reports it apart from the size budget', async () => {
    const client = await setup({ ...figureTree(30), 'main.tex': 'a\n' });
    const { listing } = await list(client, { maxResults: 3 });

    expect(listing.files).toHaveLength(3);
    expect(listing.omittedByCap).toBe(28);
    expect(listing.omittedBySize).toBe(0);
    expect(listing.note).toContain('maxResults is 3');
    expect(listing.files.some((f) => f.path === 'main.tex')).toBe(true);
  });
});

describe('list_files leaves an ordinary project exactly as it was', () => {
  it('returns every entry, with the pre-#164 text, no note and zero counters', async () => {
    const client = await setup({
      'main.tex': '\\documentclass{article}\n',
      'sections/intro.tex': 'intro\n',
      'refs.bib': '@article{a}\n',
      'README.md': 'readme\n',
      'figures/overview.pdf': 'pdf\n',
    });

    const { listing, text } = await list(client);

    expect(listing.files.map((f) => f.path).sort()).toEqual([
      'README.md',
      'figures/overview.pdf',
      'main.tex',
      'refs.bib',
      'sections/intro.tex',
    ]);
    expect(listing.totalFiles).toBe(5);
    expect(listing.omittedByCap).toBe(0);
    expect(listing.omittedBySize).toBe(0);
    expect(listing.omittedByType).toBeUndefined();
    expect(listing.note).toBeUndefined();
    // The text channel is the formula `listFiles.ts` used before the budget existed, over the
    // returned entries, with nothing prepended or appended.
    expect(text).toBe(
      listing.files.map((f) => `${f.path} (${f.type}, ${f.sizeBytes}B)`).join('\n'),
    );
  });

  it('still says `No matching files.` for an empty listing, and files: [] still means that', async () => {
    const client = await setup({ 'main.tex': 'a\n' });
    const { listing, text } = await list(client, { filter: 'bib' });

    expect(listing.files).toEqual([]);
    expect(listing.totalFiles).toBe(0);
    expect(listing.omittedByCap + listing.omittedBySize).toBe(0);
    expect(listing.note).toBeUndefined();
    expect(text).toBe('No matching files.');
  });
});

describe('list_files declares every counter it returns', () => {
  it('advertises them off a real listTools() round trip', async () => {
    const client = await setup({ 'main.tex': 'a\n' });

    await expectDeclaredField(client, 'list_files', 'totalFiles', { required: true });
    await expectDeclaredField(client, 'list_files', 'omittedByCap', { required: true });
    await expectDeclaredField(client, 'list_files', 'omittedBySize', { required: true });
    await expectDeclaredField(client, 'list_files', 'omittedByType', { required: false });
    await expectDeclaredField(client, 'list_files', 'omittedByType.asset', { required: true });
    await expectDeclaredField(client, 'list_files', 'note', { required: false });
    // The remedy is stated where a model reads it, not only in the note.
    await expectDeclaredField(client, 'list_files', 'files', { description: /EMPTY array/ });
  });
});

/**
 * `pdf_geometry`'s page payload against its rendered-size budget, through a real MCP round trip.
 *
 * Every text box carries a document-controlled `text` label (up to 160 characters) plus roughly a
 * hundred characters of JSON around it, and the pages lane used to be bounded by COUNT alone —
 * `MAX_GEOMETRY_PAGES` x `MAX_TEXT_LINES_PER_PAGE` boxes, i.e. up to 1200 of them. A default call
 * on an ordinary six-page two-column paper returned ~76k characters of `structuredContent`, past
 * the ~67k a client rejected undelivered in #68, with `textOmitted: 0` — nothing said anything had
 * gone wrong, because nothing had been cut.
 *
 * The PDF here is hand-built (no TeX): four tall pages, each carrying far more long lines than the
 * budget can hold, so the only thing that can keep the result deliverable is the size budget.
 */
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
import { buildDir, buildPdfPath } from '../../src/services/compiler.js';
import { GEOMETRY_CONTENT_BUDGET } from '../../src/lib/geometryBudget.js';
import { minimalPdf } from '../helpers/minimalPdf.js';
import { expectNoUndeclaredKeys, expectDeclaredField } from '../helpers/outputSchema.js';
import type { ServerConfig } from '../../src/types.js';

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(): Promise<{ client: Client; userDir: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-geombudws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-geombuddir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
    () => rm(buildDir(userDir), { recursive: true, force: true }),
  );
  await writeFile(
    path.join(userDir, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n',
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
  await client.callTool({ name: 'register_project', arguments: { project: 'doc', path: userDir } });
  return { client, userDir };
}

/** 120 lines of ~150 characters per page, 14pt apart on a page tall enough to hold them. */
const LINES_PER_PAGE = 120;
function denseText(page: number): string {
  return Array.from(
    { length: LINES_PER_PAGE },
    (_, i) => `p${page} l${i} ` + 'The quick brown fox jumps over the lazy dog. '.repeat(4),
  ).join('\n');
}

async function stageDensePdf(userDir: string, pages: number): Promise<void> {
  const pdfPath = buildPdfPath(userDir, 'main.tex');
  await mkdir(path.dirname(pdfPath), { recursive: true });
  await writeFile(
    pdfPath,
    minimalPdf(pages, 600, 40 + LINES_PER_PAGE * 14, { text: (p) => denseText(p) }),
  );
}

interface PageOut {
  page: number;
  text?: Array<{ text?: string }>;
  images?: unknown[];
  textOmitted: number;
  textOmittedBySize: number;
  imagesOmittedBySize: number;
}

describe('pdf_geometry — rendered-size budget on the page payload', () => {
  it('keeps the pages payload within the budget, counts what it cut, and declares the counter', async () => {
    const { client, userDir } = await setup();
    await stageDensePdf(userDir, 4);

    const res = (await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'doc' },
    })) as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: unknown[] };
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    const sc = res.structuredContent!;
    const pages = sc.pages as PageOut[];
    expect(pages).toHaveLength(4);

    // The whole pages array, as it goes on the wire, fits the budget.
    expect(JSON.stringify(pages).length).toBeLessThanOrEqual(GEOMETRY_CONTENT_BUDGET);
    // And the whole result is deliverable, far below the ~67k #68 saw rejected.
    expect(JSON.stringify(res).length).toBeLessThan(GEOMETRY_CONTENT_BUDGET + 3000);

    // Cut, counted, and never confusable with "absent": every page still HAS a text array.
    const cut = pages.reduce((n, p) => n + p.textOmittedBySize, 0);
    expect(cut).toBeGreaterThan(0);
    for (const p of pages) {
      expect(Array.isArray(p.text)).toBe(true);
      // The size cut is counted apart from the per-page COUNT cap, which never fired here.
      expect(p.textOmitted).toBe(0);
      expect(p.text!.length + p.textOmittedBySize).toBe(LINES_PER_PAGE);
      // Share guarantee: pages are lanes of one cause, so no page is starved by the ones before it.
      expect(p.text!.length).toBeGreaterThan(0);
    }
    // The cut is a suffix: the kept lines are the first ones in drawing order.
    expect(pages[3]!.text![0]!.text).toMatch(/^p4 l0 /);

    // Said in the text channel and in the note, not only in a counter.
    const text = (res.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
    expect(text).toMatch(/past the size budget/);
    expect(typeof sc.note).toBe('string');

    await expectNoUndeclaredKeys(client, 'pdf_geometry', sc);
    await expectDeclaredField(client, 'pdf_geometry', 'pages[].textOmittedBySize');
    await expectDeclaredField(client, 'pdf_geometry', 'pages[].imagesOmittedBySize');
  });

  it('cuts nothing and says nothing when the payload fits', async () => {
    const { client, userDir } = await setup();
    const pdfPath = buildPdfPath(userDir, 'main.tex');
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, minimalPdf(2, 200, 100, { text: () => 'one\ntwo' }));

    const res = (await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'doc' },
    })) as { structuredContent?: Record<string, unknown> };
    const sc = res.structuredContent!;
    const pages = sc.pages as PageOut[];
    for (const p of pages) {
      expect(p.text).toHaveLength(2);
      expect(p.textOmittedBySize).toBe(0);
      expect(p.imagesOmittedBySize).toBe(0);
    }
    expect(sc.note).toBeUndefined();
    await expectNoUndeclaredKeys(client, 'pdf_geometry', sc);
  });
});

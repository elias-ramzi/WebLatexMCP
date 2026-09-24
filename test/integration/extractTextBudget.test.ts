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
import { EXTRACT_TEXT_CONTENT_BUDGET } from '../../src/lib/extractTextBudget.js';
import { minimalPdf } from '../helpers/minimalPdf.js';
import { expectNoUndeclaredKeys } from '../helpers/outputSchema.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * extract_text's payload is bounded per CALL, across both channels (PB2a).
 *
 * The bug: the only budget was 20000 characters held on ONE page, over `line.text.length`, so four
 * dense pages shipped ~80k characters of lines, and every one of them shipped twice — joined into
 * the text channel and JSON-escaped into `structuredContent` — for a ~160k-character result with
 * every counter at 0. A client caps results well below that (#68) and delivers nothing.
 */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/**
 * Everything in a result that is not the budgeted page payload: the header line, the pdfPath (in
 * both channels), `pageCount`, `skippedPages`, the note (in both channels) and the JSON keys that
 * hold them. Fixed-size, not document-controlled — a few hundred characters, bounded generously.
 */
const FRAMING = 2000;

const LINES = 150;
const LEN = 130;
// Quotes and backslashes, so the JSON side costs more than the raw text and a raw-length charge
// would under-count it.
const FILLER = ' "quoted" back\\slash ' + 'lorem ipsum dolor sit amet '.repeat(10);
// Ends in a non-space: the text layer trims a merged line's trailing whitespace.
const lineOf = (p: number, n: number): string => `p${p} l${n}${FILLER}`.slice(0, LEN - 1) + '.';

async function setup(pdf: Buffer): Promise<Client> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-textbudget-ws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-textbudget-dir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
    () => rm(buildDir(userDir), { recursive: true, force: true }),
  );
  await writeFile(
    path.join(userDir, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n',
  );
  const pdfPath = buildPdfPath(userDir, 'main.tex');
  await mkdir(path.dirname(pdfPath), { recursive: true });
  await writeFile(pdfPath, pdf);

  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'test',
    projects: [{ id: 'doc', mode: 'local', path: userDir }],
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
  return client;
}

interface Out {
  pages: Array<{ page: number; lines: string[]; linesOmitted: number; charsOmitted: number }>;
  note?: string;
}

function textOf(res: unknown): string {
  return ((res as { content?: Array<{ text?: string }> }).content ?? [])
    .map((b) => b.text ?? '')
    .join('\n');
}

describe('extract_text call-wide payload budget', () => {
  it('bounds four dense pages across BOTH channels and counts every cut line', async () => {
    const pdf = minimalPdf(4, 2000, LINES * 14 + 60, {
      text: (p) => Array.from({ length: LINES }, (_, n) => lineOf(p, n)).join('\n'),
    });
    const client = await setup(pdf);

    const res = await client.callTool({ name: 'extract_text', arguments: { project: 'doc' } });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    const out = res.structuredContent as unknown as Out;
    const text = textOf(res);

    // The whole point: what reaches the client, summed over the two channels it ships in.
    const rendered = text.length + JSON.stringify(res.structuredContent).length;
    expect(rendered).toBeLessThanOrEqual(EXTRACT_TEXT_CONTENT_BUDGET + FRAMING);

    expect(out.pages).toHaveLength(4);
    for (const p of out.pages) {
      // Every page got a share — one dense page cannot starve the others.
      expect(p.lines.length).toBeGreaterThan(0);
      // A suffix cut: the kept lines are exactly the page's first k lines, in order.
      expect(p.lines).toEqual(Array.from({ length: p.lines.length }, (_, n) => lineOf(p.page, n)));
      // The counters account for every line and every character of the gap.
      expect(p.linesOmitted).toBeGreaterThan(0);
      expect(p.lines.length + p.linesOmitted).toBe(LINES);
      expect(p.charsOmitted).toBe(p.linesOmitted * LEN);
      // The text channel is rendered from the CUT payload, never the full one.
      expect(text).toContain(p.lines[p.lines.length - 1]!);
      expect(text).not.toContain(lineOf(p.page, p.lines.length));
    }
    expect(out.note).toMatch(/budget/);

    await expectNoUndeclaredKeys(client, 'extract_text', res.structuredContent);
  });

  it('leaves an ordinary page whole, with zero counters and no budget note', async () => {
    const client = await setup(
      minimalPdf(2, 600, 40 * 14 + 60, {
        text: (p) => Array.from({ length: 40 }, (_, n) => `page ${p} line ${n}`).join('\n'),
      }),
    );
    const res = await client.callTool({ name: 'extract_text', arguments: { project: 'doc' } });
    const out = res.structuredContent as unknown as Out;
    for (const p of out.pages) {
      expect(p.lines).toHaveLength(40);
      expect(p.linesOmitted).toBe(0);
      expect(p.charsOmitted).toBe(0);
    }
    expect(out.note).toBeUndefined();
    await expectNoUndeclaredKeys(client, 'extract_text', res.structuredContent);
  });

  it('counts an over-long line at its true length, not at an extractor cap plus its ellipsis', async () => {
    // PB3. The PDF service used to truncate each merged line to 20000 characters and append "…"
    // before this budget ever saw it, so one 30000-character line was reported as 20001 omitted
    // characters — a gap under-stated by a third, with the ellipsis counted as a document
    // character. The page is made absurdly wide because pdf.js drops glyphs that fall off the
    // page: on a 200pt page this line comes back as ~27 characters.
    const LONG = 30_000;
    const line = 'a'.repeat(LONG - 1) + '.';
    const client = await setup(minimalPdf(1, 300_000, 100, { text: () => line }));

    const res = await client.callTool({ name: 'extract_text', arguments: { project: 'doc' } });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    const out = res.structuredContent as unknown as Out;
    expect(out.pages).toEqual([{ page: 1, lines: [], linesOmitted: 1, charsOmitted: LONG }]);
    expect(textOf(res)).toContain(`1 further line(s) (${LONG} chars)`);
    expect(out.note).toContain(`page 1 (1 line(s), ${LONG} chars)`);
    // One cut, one cause: nothing upstream of the call budget cut anything.
    expect(out.note).not.toMatch(/extractor|per-page cap/);
    await expectNoUndeclaredKeys(client, 'extract_text', res.structuredContent);
  });
});

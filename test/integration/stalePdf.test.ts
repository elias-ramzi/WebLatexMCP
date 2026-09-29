import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { buildDir, buildPdfPath, buildAuxPath } from '../../src/services/compiler.js';
import { minimalPdf } from '../helpers/minimalPdf.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * #220 end to end, through the tools: a build whose PDF is the EARLIER run's, beside the `.aux`
 * and `.log` of a later run that stopped without writing one (xelatex, stopped by an error in
 * the body — xdvipdfmx never runs). The `.log` is the real one that run wrote; the PDF stands in
 * for the earlier 3-page build, whose pages print "A 1", "B 2", "C 3". Before this, every label
 * tool resolved `a` (printed page 2 in the new `.aux`) to PDF page 2, which shows "B".
 */
const FATAL_LOG = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../fixtures/label-folio/shipouts/bodyFatal-xelatex.log.txt',
  ),
  'latin1',
);
const FATAL_AUX = '\\relax \n\\newlabel{x}{{}{1}{}{}{}}\n\\newlabel{a}{{}{2}{}{}{}}\n';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(): Promise<{ client: Client; userDir: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-stalews-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-staledir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
    () => rm(buildDir(userDir), { recursive: true, force: true }),
  );
  await writeFile(
    path.join(userDir, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n',
  );
  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'test',
    projects: [{ id: 'doc', mode: 'local', path: userDir, rootFile: 'main.tex' }],
    defaultProject: 'doc',
  };
  const ctx = createContext(config, new CredentialResolver({}), {
    name: 'Test',
    email: 'test@example.com',
  });
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return { client, userDir };
}

/**
 * Stage the earlier run's 3-page PDF and the later run's `.aux` and `.log`, with the PDF's
 * modification time `pdfAgeMs` before the `.aux`'s (negative: after it, as a finished compile
 * leaves them).
 */
async function stage(userDir: string, pdfAgeMs: number): Promise<void> {
  const pdfPath = buildPdfPath(userDir, 'main.tex');
  const auxPath = buildAuxPath(userDir, 'main.tex');
  await mkdir(path.dirname(pdfPath), { recursive: true });
  await writeFile(pdfPath, minimalPdf(3, 300, 200, { text: (n) => `${'ABC'[n - 1]}\n${n}` }));
  await writeFile(auxPath, FATAL_AUX);
  await writeFile(`${auxPath.slice(0, -'.aux'.length)}.log`, FATAL_LOG, 'latin1');
  const auxTime = new Date('2026-09-28T12:00:00Z');
  await utimes(auxPath, auxTime, auxTime);
  const pdfTime = new Date(auxTime.getTime() - pdfAgeMs);
  await utimes(pdfPath, pdfTime, pdfTime);
}

function textOf(res: unknown): string {
  return ((res as { content?: Array<{ text?: string }> }).content ?? [])
    .map((b) => b.text ?? '')
    .join('\n');
}

/** Exact text, so the staged gap is 10 s — whole, even seconds, which read back unchanged on a
 *  filesystem with 1-second or 2-second timestamps (a 1.4 s gap reads back as 2.0 s there). */
const RECORDS =
  'the PDF beside it is not the output of the last compile: the .aux was written ' +
  '10.0 s after the PDF, while a compile that finishes writes its .aux before its PDF; and the ' +
  "engine's closing line in the .log says that run wrote 2 page(s) to its .xdv file, while the " +
  'PDF has 3 page(s). No page was assumed.';

describe('a stale PDF beside a newer .aux, through the tools (#220)', () => {
  it('extract_text refuses the label instead of returning the old page 2 ("B")', async () => {
    const { client, userDir } = await setup();
    await stage(userDir, 10_000);
    const res = await client.callTool({
      name: 'extract_text',
      arguments: { project: 'doc', labels: ['a'] },
    });
    expect(res.isError, textOf(res)).toBe(true);
    expect(textOf(res)).toContain(`"a": the .aux records it on printed page "2", but ${RECORDS}`);
    expect(textOf(res)).toContain('The last compile did not produce the PDF on disk');

    // The same kind of files in the order a finished compile leaves them — the .aux older than
    // the PDF, and a closing record agreeing with it (the log closes on 2 pages, so this PDF has
    // 2) — resolve, and pdf_geometry says nothing about them: every finished build looks so.
    await stage(userDir, -300);
    await writeFile(
      buildPdfPath(userDir, 'main.tex'),
      minimalPdf(2, 300, 200, { text: (n) => `${'XY'[n - 1]}\n${n}` }),
    );
    const t = new Date(new Date('2026-09-28T12:00:00Z').getTime() + 300);
    await utimes(buildPdfPath(userDir, 'main.tex'), t, t);
    const finished = await client.callTool({
      name: 'extract_text',
      arguments: { project: 'doc', labels: ['a'] },
    });
    expect(finished.isError ?? false, textOf(finished)).toBe(false);
    expect((finished.structuredContent as { resolvedLabels?: unknown }).resolvedLabels).toEqual([
      { label: 'a', printedPage: '2', page: 2 },
    ]);
    const geo = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'doc', kinds: ['floats', 'text'] },
    });
    // No note at all: the finished build carries none of the floats notes, so the stale one
    // ("…is not the output of the last compile…") cannot hide behind another's text.
    expect(geo.isError ?? false, textOf(geo)).toBe(false);
    expect((geo.structuredContent as { note?: string }).note).toBeUndefined();
  });

  it('render_pages refuses it too, before anything is rendered', async () => {
    const { client, userDir } = await setup();
    await stage(userDir, 10_000);
    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'doc', labels: ['a'], inline: false },
    });
    expect(res.isError, textOf(res)).toBe(true);
    expect(textOf(res)).toContain(RECORDS);
  });

  it('pdf_geometry kinds: ["floats"] returns the index with a note that the PDF is not its run', async () => {
    const { client, userDir } = await setup();
    await stage(userDir, 10_000);
    const res = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'doc', kinds: ['floats'] },
    });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    const out = res.structuredContent as {
      floats?: Array<{ label: string; page: string }>;
      floatsPagesShifted?: boolean;
      note?: string;
    };
    expect(out.floats?.map((f) => f.label)).toEqual(['x', 'a']);
    expect(out.floatsPagesShifted).toBeUndefined();
    // With floats alone the PDF is never opened, so its page count is unknown and only the
    // timestamps speak (a written count has nothing to be compared with).
    expect(out.note).toContain(
      'The PDF beside the .aux is not the output of the last compile: the .aux was ' +
        'written 10.0 s after the PDF, while a compile that finishes writes its .aux before its ' +
        'PDF. That compile stopped without writing a PDF',
    );
    expect(textOf(res)).toContain('is not the output of the last compile');

    // With a page-level kind the PDF is opened, and its page count joins the evidence.
    const both = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'doc', kinds: ['floats', 'text'] },
    });
    expect((both.structuredContent as { note?: string }).note).toContain(
      "the engine's closing line in the .log says that run wrote 2 page(s) to its .xdv file, " +
        'while the PDF has 3 page(s)',
    );
  });
});

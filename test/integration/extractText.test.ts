import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, readdir, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { buildDir, buildPdfPath, buildAuxPath } from '../../src/services/compiler.js';
import { MAX_TEXT_PAGES } from '../../src/services/pdfRender.js';
import { minimalPdf } from '../helpers/minimalPdf.js';
import { toPosix } from '../../src/lib/paths.js';
import type { MinimalPdfOptions } from '../helpers/minimalPdf.js';
import type { ServerConfig } from '../../src/types.js';

const MAIN_TEX = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Hi',
  '\\end{document}',
  '',
].join('\n');

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Harness {
  client: Client;
  workspace: string;
  userDir: string;
}

async function setup(): Promise<Harness> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-textws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-textdir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
    () => rm(buildDir(userDir), { recursive: true, force: true }),
  );
  await writeFile(path.join(userDir, 'main.tex'), MAIN_TEX);

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

  await client.callTool({
    name: 'register_project',
    arguments: { project: 'poster', path: userDir },
  });

  return { client, workspace, userDir };
}

/** Stage a "compiled" PDF at the path `compile` would have left one, without running latexmk. */
async function stagePdf(userDir: string, pages: number, opts?: MinimalPdfOptions): Promise<void> {
  const pdfPath = buildPdfPath(userDir, 'main.tex');
  await mkdir(path.dirname(pdfPath), { recursive: true });
  await writeFile(pdfPath, minimalPdf(pages, 300, 200, opts));
}

/**
 * Stage the `.aux` the last compile would have left, without running latexmk — and the `.log`
 * beside it, since every compile leaves one and a build with neither `.log` nor `.fls` has every
 * label refused (`'pgfpagesUnknown'`). `log: null` stages that unreadable-records state.
 */
async function stageAux(
  userDir: string,
  content: string,
  log: string | null = 'This is pdfTeX, Version 3.141592653\n',
): Promise<void> {
  const auxPath = buildAuxPath(userDir, 'main.tex');
  await mkdir(path.dirname(auxPath), { recursive: true });
  await writeFile(auxPath, content);
  if (log !== null) await writeFile(`${auxPath.slice(0, -'.aux'.length)}.log`, log);
}

function textOf(res: unknown): string {
  return ((res as { content?: Array<{ text?: string }> }).content ?? [])
    .map((b) => b.text ?? '')
    .join('\n');
}

interface ExtractTextOut {
  pdfPath: string;
  pageCount: number;
  pages: Array<{ page: number; lines: string[]; linesOmitted: number; charsOmitted: number }>;
  skippedPages: number[];
  resolvedLabels?: Array<{ label: string; printedPage: string; page: number }>;
  note?: string;
}

function structuredOf(res: unknown): ExtractTextOut {
  return (res as { structuredContent: ExtractTextOut }).structuredContent;
}

async function listAllEntries(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map(toPosix).sort();
}

describe('extract_text', () => {
  it('returns each page’s typeset lines, in both channels', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 2, { text: (n) => `page ${n} alpha\npage ${n} beta` });

    const res = await client.callTool({ name: 'extract_text', arguments: { project: 'poster' } });
    expect(res.isError ?? false).toBe(false);

    const out = structuredOf(res);
    expect(out.pageCount).toBe(2);
    expect(out.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(out.pages[0]?.lines).toEqual(['page 1 alpha', 'page 1 beta']);
    expect(out.pages[1]?.lines).toEqual(['page 2 alpha', 'page 2 beta']);
    // A client that only reads text must get the content too, not just a summary of it.
    const text = textOf(res);
    expect(text).toContain('page 1 alpha');
    expect(text).toContain('page 2 beta');
    expect(text).toContain('--- page 2 ---');
  });

  it('answers the spurious-space question a render cannot', async () => {
    // Finding 5's actual case: an \\xspace macro next to a \\textsubscript leaves a space that is
    // a few pixels wide at subscript size. The text layer says so outright.
    const { client, userDir } = await setup();
    await stagePdf(userDir, 1, { text: () => 'CO 2 emissions rose' });

    const res = await client.callTool({ name: 'extract_text', arguments: { project: 'poster' } });
    expect(structuredOf(res).pages[0]?.lines).toEqual(['CO 2 emissions rose']);
  });

  it('extracts exactly the requested page', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3, { text: (n) => `body of page ${n}` });

    const res = await client.callTool({
      name: 'extract_text',
      arguments: { project: 'poster', pages: [2] },
    });
    const out = structuredOf(res);
    expect(out.pages).toHaveLength(1);
    expect(out.pages[0]?.lines).toEqual(['body of page 2']);
  });

  it(`caps the call at ${MAX_TEXT_PAGES} pages and names the rest rather than dropping them`, async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, MAX_TEXT_PAGES + 2, { text: (n) => `p${n}` });

    const out = structuredOf(
      await client.callTool({ name: 'extract_text', arguments: { project: 'poster' } }),
    );
    expect(out.pages).toHaveLength(MAX_TEXT_PAGES);
    expect(out.skippedPages).toEqual([MAX_TEXT_PAGES + 1, MAX_TEXT_PAGES + 2]);
  });

  it('reads the page a \\label landed on, through the same resolution render_pages uses', async () => {
    const { client, userDir } = await setup();
    // A footer folio under the caption: without /PageLabels the printed page is accepted only
    // when that page's own folio reads it.
    await stagePdf(userDir, 3, { text: (n) => `Table 1 caption on page ${n}\n${n}` });
    await stageAux(userDir, '\\newlabel{tab:results}{{1}{3}}\n');

    const res = await client.callTool({
      name: 'extract_text',
      arguments: { project: 'poster', labels: ['tab:results'] },
    });
    expect(res.isError ?? false).toBe(false);
    const out = structuredOf(res);
    expect(out.pages.map((p) => p.page)).toEqual([3]);
    expect(out.pages[0]?.lines).toEqual(['Table 1 caption on page 3', '3']);
    expect(out.resolvedLabels).toEqual([{ label: 'tab:results', printedPage: '3', page: 3 }]);
    expect(out.note).toContain('LAST COMPILE');
  });

  it('refuses a label when neither the .fls nor the .log could be read beside the .aux', async () => {
    // Same resolution as render_pages, so the same refusal: with no record of what the build
    // read, a pgfpages layout that shifted every label a page late cannot be ruled out.
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3, { text: (n) => `Table 1 caption on page ${n}\n${n}` });
    await stageAux(userDir, '\\newlabel{tab:results}{{1}{3}}\n', null);

    const res = await client.callTool({
      name: 'extract_text',
      arguments: { project: 'poster', labels: ['tab:results'] },
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('tab:results');
    expect(text).toMatch(/neither the build's recorder file \(\.fls\) nor its \.log could be read/);
    expect(text).toContain('pages:');
    expect(text).not.toMatch(/name pgfpages\.sty/);
    expect(text).not.toContain('Table 1 caption');
  });

  it('resolves a renumbered document’s label through /PageLabels here too', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 5, {
      pageLabels: ['i', 'ii', '1', '2', '3'],
      text: (n) => `text of pdf page ${n}`,
    });
    await stageAux(userDir, '\\newlabel{sec:preface}{{1}{ii}}\n');

    const out = structuredOf(
      await client.callTool({
        name: 'extract_text',
        arguments: { project: 'poster', labels: ['sec:preface'] },
      }),
    );
    expect(out.pages[0]?.lines).toEqual(['text of pdf page 2']);
  });

  it('refuses an unresolvable label rather than reading page 1', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3, { text: (n) => `page ${n}` });
    await stageAux(userDir, '\\newlabel{fig:known}{{1}{2}}\n');

    const res = await client.callTool({
      name: 'extract_text',
      arguments: { project: 'poster', labels: ['tab:brand-new'] },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('tab:brand-new');
    expect(textOf(res)).not.toContain('page 1');
  });

  it('rejects labels and pages together instead of letting one silently win', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3, { text: (n) => `page ${n}` });
    await stageAux(userDir, '\\newlabel{tab:a}{{1}{2}}\n');

    const res = await client.callTool({
      name: 'extract_text',
      arguments: { project: 'poster', labels: ['tab:a'], pages: [1] },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/either `pages` or `labels`/);
  });

  it('rejects an empty pages array instead of silently extracting nothing', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3, { text: (n) => `page ${n}` });

    const res = await client.callTool({
      name: 'extract_text',
      arguments: { project: 'poster', pages: [] },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/empty array|Omit pages/i);
  });

  it('errors naming compile when nothing has been compiled yet', async () => {
    const { client } = await setup();
    const res = await client.callTool({ name: 'extract_text', arguments: { project: 'poster' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('compile');
  });

  it('never writes inside the project directory (in-place invariant)', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 2, { text: (n) => `page ${n}` });

    const before = await listAllEntries(userDir);
    const res = await client.callTool({ name: 'extract_text', arguments: { project: 'poster' } });
    expect(res.isError ?? false).toBe(false);
    expect(await listAllEntries(userDir)).toEqual(before);
  });

  it('creates only the project lock directory under the workspace, and no lock file', async () => {
    // "Writes nothing" is not true of this tool without the caveat its description carries: it
    // takes the per-project lock, and withFileLock's mkdir leaves <workspace>/.sessions/<id>/
    // behind. Supplying the project via server config rather than register_project is what makes
    // the before-snapshot genuinely empty — register_project takes that same lock itself.
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-textws-lock-'));
    const localUserDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-textdir-lock-'));
    cleanups.push(
      () => rm(workspace, { recursive: true, force: true }),
      () => rm(localUserDir, { recursive: true, force: true }),
      () => rm(buildDir(localUserDir), { recursive: true, force: true }),
    );
    await writeFile(path.join(localUserDir, 'main.tex'), MAIN_TEX);
    await stagePdf(localUserDir, 1, { text: () => 'hello' });

    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: 'test',
      projects: [{ id: 'poster', mode: 'local', path: localUserDir }],
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

    expect(await listAllEntries(workspace)).toEqual([]);

    const res = await client.callTool({ name: 'extract_text', arguments: { project: 'poster' } });
    expect(res.isError ?? false).toBe(false);
    expect(await listAllEntries(workspace)).toEqual(['.sessions', '.sessions/poster']);
  });
});

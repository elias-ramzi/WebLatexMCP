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
import { minimalPdf } from '../helpers/minimalPdf.js';
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
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-renderws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-renderdir-'));
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

/**
 * Stage a "compiled" PDF at the path `compile` would have left one, without running latexmk.
 * `pageLabels` writes a `/PageLabels` tree with that printed label per page — the thing a real
 * `\frontmatter` document (or any `hyperref` document) carries and a plain `article` does not.
 */
async function stagePdf(userDir: string, pages: number, pageLabels?: string[]): Promise<void> {
  const pdfPath = buildPdfPath(userDir, 'main.tex');
  await mkdir(path.dirname(pdfPath), { recursive: true });
  await writeFile(pdfPath, minimalPdf(pages, 200, 100, { pageLabels }));
}

/** Stage the `.aux` the last compile would have left, without running latexmk. */
async function stageAux(userDir: string, content: string): Promise<void> {
  const auxPath = buildAuxPath(userDir, 'main.tex');
  await mkdir(path.dirname(auxPath), { recursive: true });
  await writeFile(auxPath, content);
}

interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

function contentOf(res: unknown): ContentBlock[] {
  return (res as { content?: ContentBlock[] }).content ?? [];
}

function textOf(res: unknown): string {
  return contentOf(res)
    .map((b) => b.text ?? '')
    .join('\n');
}

interface RenderedPageOut {
  page: number;
  pngPath: string;
  widthPx: number;
  heightPx: number;
  dpi: number;
  clamped: boolean;
  pageWidthPt: number;
  pageHeightPt: number;
  bytes: number;
  inlined: boolean;
}

interface RenderPagesOut {
  pdfPath: string;
  pageCount: number;
  outDir: string;
  pages: RenderedPageOut[];
  skippedPages: number[];
  resolvedLabels?: Array<{ label: string; printedPage: string; page: number }>;
  note?: string;
}

function structuredOf(res: unknown): RenderPagesOut {
  return (res as { structuredContent: RenderPagesOut }).structuredContent;
}

/** Every entry (file or directory) under `dir`, relative paths, recursively. */
async function listAllEntries(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.sort();
}

describe('render_pages', () => {
  it('renders every page by default', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3);

    const res = await client.callTool({ name: 'render_pages', arguments: { project: 'poster' } });
    expect(res.isError ?? false).toBe(false);

    const out = structuredOf(res);
    expect(out.pageCount).toBe(3);
    expect(out.pages).toHaveLength(3);
    expect(out.pages.map((p) => p.page)).toEqual([1, 2, 3]);

    const fs = await import('node:fs/promises');
    for (const p of out.pages) {
      await expect(fs.stat(p.pngPath)).resolves.toBeDefined();
    }

    const blocks = contentOf(res);
    expect(blocks[0]?.type).toBe('text');
    const images = blocks.filter((b) => b.type === 'image');
    expect(images).toHaveLength(3);
    for (const img of images) {
      expect(img.mimeType).toBe('image/png');
      expect(img.data && img.data.length > 0).toBe(true);
    }
  });

  it('never writes inside the project directory (in-place invariant)', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3);

    const before = await listAllEntries(userDir);
    await client.callTool({ name: 'render_pages', arguments: { project: 'poster' } });
    const after = await listAllEntries(userDir);

    expect(after).toEqual(before);
    expect(after.some((f) => f.endsWith('.png'))).toBe(false);
  });

  it('inline: false returns no image blocks but keeps paths in structuredContent and text', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3);

    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', inline: false },
    });
    expect(res.isError ?? false).toBe(false);

    const blocks = contentOf(res);
    expect(blocks.filter((b) => b.type === 'image')).toHaveLength(0);

    const out = structuredOf(res);
    expect(out.pages).toHaveLength(3);
    for (const p of out.pages) {
      expect(p.inlined).toBe(false);
    }

    const text = textOf(res);
    for (const p of out.pages) {
      expect(text).toContain(p.pngPath);
    }
  });

  it('pages: [2] renders exactly one page', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3);

    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', pages: [2] },
    });
    expect(res.isError ?? false).toBe(false);

    const out = structuredOf(res);
    expect(out.pages).toHaveLength(1);
    expect(out.pages[0]?.page).toBe(2);
    expect(contentOf(res).filter((b) => b.type === 'image')).toHaveLength(1);
  });

  it('rejects a zero-width clip just outside the valid range, and accepts the boundary just inside', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3);

    const zeroWidth = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', clip: { x0: 0.5, y0: 0, x1: 0.5, y1: 1 } },
    });
    expect(zeroWidth.isError).toBe(true);
    expect(textOf(zeroWidth)).toContain('clip');

    const fullBoundary = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', clip: { x0: 0, y0: 0, x1: 1, y1: 1 } },
    });
    expect(fullBoundary.isError ?? false).toBe(false);
  });

  it('rejects a clip fraction above 1 via the zod schema', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3);

    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', clip: { x0: 0, y0: 0, x1: 1.5, y1: 1 } },
    });
    expect(res.isError).toBe(true);
  });

  it('errors on an out-of-range page, naming both the requested and the actual page count', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3);

    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', pages: [4] },
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('4');
    expect(text).toContain('3');
  });

  it('rejects an empty pages array instead of silently rendering nothing', async () => {
    // The value just outside: `pages` omitted means every page, but `[]` is not nullish, so
    // without the schema guard it selects zero pages and the call reports success with no images
    // — a caller who built the array programmatically and got an empty one is told it worked.
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3);

    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', pages: [] },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/empty array|Omit pages/i);
  });

  it('errors naming compile when nothing has been compiled yet', async () => {
    const { client } = await setup();
    // Deliberately no stagePdf call.

    const res = await client.callTool({ name: 'render_pages', arguments: { project: 'poster' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('compile');
  });

  it('clip actually crops: half-width clip yields ~half the unclipped width at the same dpi', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 1);

    const full = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', pages: [1], dpi: 150 },
    });
    const fullOut = structuredOf(full);
    const fullWidth = fullOut.pages[0]?.widthPx;
    expect(fullWidth).toBeDefined();

    const half = await client.callTool({
      name: 'render_pages',
      arguments: {
        project: 'poster',
        pages: [1],
        dpi: 150,
        clip: { x0: 0, y0: 0, x1: 0.5, y1: 1 },
      },
    });
    const halfOut = structuredOf(half);
    const halfWidth = halfOut.pages[0]?.widthPx;
    expect(halfWidth).toBeDefined();

    expect(Math.abs((halfWidth as number) - (fullWidth as number) / 2)).toBeLessThanOrEqual(1);
  });
  it('labels: renders the page the .aux records and echoes the label -> page mapping', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 5);
    await stageAux(userDir, '\\newlabel{fig:one}{{1}{2}}\n\\newlabel{tab:results}{{2}{4}}\n');

    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', labels: ['tab:results'] },
    });
    expect(res.isError ?? false).toBe(false);

    const out = structuredOf(res);
    expect(out.pages.map((p) => p.page)).toEqual([4]);
    // The echo is the point of the feature: the caller asked about a label, not a number, and
    // must be able to see which page it actually got.
    expect(out.resolvedLabels).toEqual([{ label: 'tab:results', printedPage: '4', page: 4 }]);
    expect(out.note).toContain('LAST COMPILE');
    // Pinned as its own line, not merely somewhere in the text: the provenance note also names
    // the mapping, so a looser assertion passes with the scannable summary line deleted.
    expect(textOf(res)).toMatch(/labels \(from the last compile's \.aux\): tab:results -> page 4/);
    expect(contentOf(res).filter((b) => b.type === 'image')).toHaveLength(1);
  });

  it('labels: two labels on one page render it once, and both are echoed', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3);
    await stageAux(userDir, '\\newlabel{tab:a}{{1}{2}}\n\\newlabel{fig:b}{{1}{2}}\n');

    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', labels: ['tab:a', 'fig:b'] },
    });
    expect(res.isError ?? false).toBe(false);

    const out = structuredOf(res);
    expect(out.pages.map((p) => p.page)).toEqual([2]);
    expect(out.resolvedLabels?.map((r) => r.label)).toEqual(['tab:a', 'fig:b']);
    expect(contentOf(res).filter((b) => b.type === 'image')).toHaveLength(1);
  });

  it('rejects labels and pages together instead of letting one silently win', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3);
    await stageAux(userDir, '\\newlabel{tab:a}{{1}{2}}\n');

    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', labels: ['tab:a'], pages: [1] },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/either `pages` or `labels`/);
    expect(contentOf(res).filter((b) => b.type === 'image')).toHaveLength(0);
  });

  it('refuses an unresolvable label rather than rendering page 1', async () => {
    // The failure this feature exists to prevent: a label the last compile never saw must not
    // quietly become "here is a page" — of all the wrong answers, the default first page is the
    // most plausible-looking one.
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3);
    await stageAux(userDir, '\\newlabel{fig:known}{{1}{2}}\n');

    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', labels: ['tab:brand-new'] },
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('tab:brand-new');
    expect(text).toMatch(/Rerun to get cross-references right/);
    expect(text).toContain('pdf_geometry');
    expect(contentOf(res).filter((b) => b.type === 'image')).toHaveLength(0);
  });

  it('refuses the whole call when only one of several labels is unresolvable', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3);
    await stageAux(userDir, '\\newlabel{fig:known}{{1}{2}}\n');

    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', labels: ['fig:known', 'tab:brand-new'] },
    });
    expect(res.isError).toBe(true);
    expect(contentOf(res).filter((b) => b.type === 'image')).toHaveLength(0);
  });

  it('refuses a roman printed page instead of rendering PDF page "iv" as page 4', async () => {
    // \pagenumbering{roman} front matter: the .aux records "iv", which is not an offset into the
    // PDF at all. Mapping it onto page 4 would render a plausible page that is not the one asked
    // for — silently.
    const { client, userDir } = await setup();
    await stagePdf(userDir, 5);
    await stageAux(userDir, '\\newlabel{sec:preface}{{1}{iv}}\n');

    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', labels: ['sec:preface'] },
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('"iv"');
    expect(text).toContain('not a decimal page number');
    expect(contentOf(res).filter((b) => b.type === 'image')).toHaveLength(0);
  });

  it('refuses a printed page that is neither decimal nor roman, rather than falling back', async () => {
    // A thesis/report scheme (\pagenumbering via \renewcommand{\thepage}{A-\arabic{page}}) prints
    // "A-3". There is no roman evidence to fall back on here, so this test is what stands between
    // a non-decimal printed page and a silently-rendered wrong page.
    const { client, userDir } = await setup();
    await stagePdf(userDir, 5);
    await stageAux(userDir, '\\newlabel{tab:appendix}{{1}{A-3}}\n');

    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', labels: ['tab:appendix'] },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('"A-3"');
    expect(contentOf(res).filter((b) => b.type === 'image')).toHaveLength(0);
  });

  it('refuses an arabic label too once the same .aux shows roman pages', async () => {
    // The subtler half: in a document with roman front matter, printed arabic page 3 is NOT PDF
    // page 3, and nothing in the .aux says by how much it is offset.
    const { client, userDir } = await setup();
    await stagePdf(userDir, 8);
    await stageAux(userDir, '\\newlabel{sec:preface}{{1}{iii}}\n\\newlabel{tab:results}{{1}{3}}\n');

    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', labels: ['tab:results'] },
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('renumbers its pages');
    expect(text).toContain('sec:preface');
    expect(contentOf(res).filter((b) => b.type === 'image')).toHaveLength(0);
  });

  it('names the stale .aux when a resolved page is past the end of the PDF on disk', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3);
    await stageAux(userDir, '\\newlabel{tab:results}{{1}{9}}\n');

    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', labels: ['tab:results'] },
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('out of range');
    expect(text).toContain('tab:results -> page 9');
    expect(text).toMatch(/stale/);
  });

  it('says there is no .aux at all rather than calling the label undefined', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3);
    // Deliberately no stageAux: a PDF surfaced by a previous run, with the build dir's .aux gone.

    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', labels: ['tab:results'] },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/No \.aux found in the build directory/);
  });

  it('rejects an empty labels array instead of rendering every page', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3);
    await stageAux(userDir, '\\newlabel{tab:a}{{1}{2}}\n');

    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', labels: [] },
    });
    expect(res.isError).toBe(true);
    expect(contentOf(res).filter((b) => b.type === 'image')).toHaveLength(0);
  });

  it('resolves a label past the floats REPORTING cap (a real manuscript has >200 labels)', async () => {
    // pdf_geometry's floats index is capped at 200 entries because it PRINTS them. A lookup only
    // searches, and every section, equation and subfigure of a real paper is a \newlabel, so
    // reusing that cap would answer "no such label" for a label plainly in the file — a wrong
    // answer, not a truncated one. LABEL_LOOKUP_MAX is why this resolves.
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3);
    const filler = Array.from({ length: 250 }, (_, i) => `\\newlabel{sec:${i}}{{1}{1}}`);
    await stageAux(userDir, [...filler, '\\newlabel{tab:results}{{1}{3}}'].join('\n') + '\n');

    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', labels: ['tab:results'] },
    });
    expect(res.isError ?? false).toBe(false);
    expect(structuredOf(res).pages.map((p) => p.page)).toEqual([3]);
  });

  it("renders a roman front-matter label through the PDF's own /PageLabels instead of refusing", async () => {
    // #112: with the tree in hand there is nothing to infer. The same .aux against a PDF with no
    // tree is refused two tests above ("refuses a roman printed page…") — that pair is the whole
    // change, and neither half is redundant.
    const { client, userDir } = await setup();
    await stagePdf(userDir, 6, ['i', 'ii', 'iii', 'iv', '1', '2']);
    await stageAux(userDir, '\\newlabel{sec:preface}{{1}{iv}}\n');

    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', labels: ['sec:preface'] },
    });
    expect(res.isError ?? false).toBe(false);

    const out = structuredOf(res);
    expect(out.pages.map((p) => p.page)).toEqual([4]);
    expect(out.resolvedLabels).toEqual([{ label: 'sec:preface', printedPage: 'iv', page: 4 }]);
    expect(out.note).toContain('/PageLabels');
  });

  it('renders the OFFSET page for an arabic label in a renumbered document', async () => {
    // The silently-wrong-page case issue #112 filed, end to end: a thesis scheme prints "A-3",
    // which is no evidence the inferred route recognises, so printed page "2" resolved to PDF
    // page 2 and rendered a plausible wrong page. The tree puts it on page 5.
    const { client, userDir } = await setup();
    await stagePdf(userDir, 6, ['A-1', 'A-2', 'A-3', '1', '2', '3']);
    await stageAux(
      userDir,
      '\\newlabel{tab:appendix}{{1}{A-3}}\n\\newlabel{tab:results}{{1}{2}}\n',
    );

    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', labels: ['tab:results'] },
    });
    expect(res.isError ?? false).toBe(false);
    expect(structuredOf(res).pages.map((p) => p.page)).toEqual([5]);
    expect(textOf(res)).toContain('tab:results -> page 5');
  });

  it('refuses a printed page the PDF prints twice rather than rendering the first one', async () => {
    // A restarted \pagenumbering prints "1" on two pages. Rendering the lower index shows the
    // front matter for a body-text label — a coin flip presented as an answer.
    const { client, userDir } = await setup();
    await stagePdf(userDir, 4, ['1', '2', '1', '2']);
    await stageAux(userDir, '\\newlabel{tab:results}{{1}{1}}\n');

    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', labels: ['tab:results'] },
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('PDF pages 1, 3');
    expect(text).toMatch(/pagenumbering/);
    expect(contentOf(res).filter((b) => b.type === 'image')).toHaveLength(0);
  });

  it('calls a printed page the PDF never prints a stale .aux, not an unknown label', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3, ['1', '2', '3']);
    await stageAux(userDir, '\\newlabel{tab:results}{{1}{9}}\n');

    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', labels: ['tab:results'] },
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('/PageLabels');
    expect(text).toMatch(/stale/);
    // The wrong diagnosis it must not give: the \newlabel is right there in the .aux.
    expect(text).not.toContain('no \\newlabel');
    expect(contentOf(res).filter((b) => b.type === 'image')).toHaveLength(0);
  });

  it('never writes inside the project directory when resolving labels', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 3);
    await stageAux(userDir, '\\newlabel{tab:a}{{1}{2}}\n');

    const before = await listAllEntries(userDir);
    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', labels: ['tab:a'] },
    });
    expect(res.isError ?? false).toBe(false);
    expect(await listAllEntries(userDir)).toEqual(before);
  });
});

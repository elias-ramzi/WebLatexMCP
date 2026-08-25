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
import { buildDir, buildPdfPath } from '../../src/services/compiler.js';
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

/** Stage a "compiled" PDF at the path `compile` would have left one, without running latexmk. */
async function stagePdf(userDir: string, pages: number): Promise<void> {
  const pdfPath = buildPdfPath(userDir, 'main.tex');
  await mkdir(path.dirname(pdfPath), { recursive: true });
  await writeFile(pdfPath, minimalPdf(pages));
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
});

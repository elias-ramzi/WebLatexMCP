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
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-geomws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-geomdir-'));
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

async function stageAux(userDir: string, content: string): Promise<void> {
  const auxPath = buildAuxPath(userDir, 'main.tex');
  await mkdir(path.dirname(auxPath), { recursive: true });
  await writeFile(auxPath, content);
}

interface ContentBlock {
  type: string;
  text?: string;
}

function textOf(res: unknown): string {
  return ((res as { content?: ContentBlock[] }).content ?? []).map((b) => b.text ?? '').join('\n');
}

interface GeometryBoxOut {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  text?: string;
  source?: 'image' | 'form';
}

interface GeometryPageOut {
  page: number;
  pageWidthPt: number;
  pageHeightPt: number;
  text?: GeometryBoxOut[];
  images?: GeometryBoxOut[];
  textOmitted: number;
  imagesOmitted: number;
}

interface GeometryOut {
  pdfPath: string;
  pageCount?: number;
  pages: GeometryPageOut[];
  skippedPages: number[];
  floats?: Array<{ label: string; number: string; page: string }>;
  floatsOmitted?: number;
  note?: string;
}

function structuredOf(res: unknown): GeometryOut {
  return (res as { structuredContent: GeometryOut }).structuredContent;
}

/** Every entry (file or directory) under `dir`, relative paths, recursively. */
async function listAllEntries(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.sort();
}

describe('pdf_geometry', () => {
  it('fails naming compile when nothing has been compiled yet', async () => {
    const { client } = await setup();
    const res = await client.callTool({ name: 'pdf_geometry', arguments: { project: 'poster' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('compile');
    expect(textOf(res)).toContain('pdf_geometry');
  });

  it('reports a plausible shape for a staged PDF with no text or images', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 1);

    const res = await client.callTool({ name: 'pdf_geometry', arguments: { project: 'poster' } });
    expect(res.isError ?? false).toBe(false);

    const out = structuredOf(res);
    expect(out.pageCount).toBe(1);
    expect(out.pages).toHaveLength(1);
    const page = out.pages[0]!;
    expect(page.page).toBe(1);
    // minimalPdf's default page box is 200x100pt (see test/helpers/minimalPdf.ts).
    expect(page.pageWidthPt).toBeCloseTo(200, 5);
    expect(page.pageHeightPt).toBeCloseTo(100, 5);
    expect(Array.isArray(page.text)).toBe(true);
    expect(Array.isArray(page.images)).toBe(true);
    expect(out.skippedPages).toEqual([]);
    expect(out.floats).toBeUndefined();
  });

  it('parses floats from a staged .aux, and reports none with a note when there is no .aux', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 1);

    const withoutAux = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['floats'] },
    });
    expect(withoutAux.isError ?? false).toBe(false);
    const withoutOut = structuredOf(withoutAux);
    expect(withoutOut.floats).toEqual([]);
    expect(withoutOut.note).toMatch(/\.aux/);

    await stageAux(userDir, '\\newlabel{fig:one}{{1}{3}}\n\\newlabel{tab:two}{{1}{4}}\n');
    const withAux = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['floats'] },
    });
    expect(withAux.isError ?? false).toBe(false);
    const withOut = structuredOf(withAux);
    expect(withOut.floats).toEqual([
      { label: 'fig:one', number: '1', page: '3' },
      { label: 'tab:two', number: '1', page: '4' },
    ]);
    expect(withOut.floatsOmitted).toBe(0);
    expect(withOut.note).toBeUndefined();
    // kinds: ['floats'] alone requests no per-page geometry, and (FIX8) never opens the PDF at
    // all — pages comes back empty (not one entry with text/images undefined), and pageCount is
    // honestly absent rather than a number that was never actually computed.
    expect(withOut.pages).toEqual([]);
    expect(withOut.pageCount).toBeUndefined();
  });

  it('kinds: ["floats"] alone never opens the compiled PDF (FIX8)', async () => {
    const { client, userDir } = await setup();
    // Deliberately NOT a real PDF: opening this would fail (no @napi-rs/canvas DOM globals aside,
    // this content isn't even parseable as a PDF at all). locateProjectPdf only stats the path, so
    // this still counts as "something has been compiled" for the purposes of finding it.
    const pdfPath = buildPdfPath(userDir, 'main.tex');
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, Buffer.from('this is not a pdf at all'));
    await stageAux(userDir, '\\newlabel{fig:one}{{1}{3}}\n');

    const floatsOnly = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['floats'] },
    });
    expect(floatsOnly.isError ?? false).toBe(false);
    const floatsOut = structuredOf(floatsOnly);
    expect(floatsOut.floats).toEqual([{ label: 'fig:one', number: '1', page: '3' }]);
    expect(floatsOut.pages).toEqual([]);
    expect(floatsOut.pageCount).toBeUndefined();

    // Contrast: asking for page geometry on the SAME (unopenable) PDF really does try to open it
    // and fails — proving the floats-only call above genuinely skipped opening the document,
    // rather than opening it and happening not to use the result.
    const withText = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['text'] },
    });
    expect(withText.isError).toBe(true);
  });

  it('works for a mode: local project (requireProjectDir, not requireGitProject)', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-geomws-local-'));
    const localDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-geomdir-local-'));
    cleanups.push(
      () => rm(workspace, { recursive: true, force: true }),
      () => rm(localDir, { recursive: true, force: true }),
      () => rm(buildDir(localDir), { recursive: true, force: true }),
    );
    await writeFile(path.join(localDir, 'main.tex'), MAIN_TEX);

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

    // No gitUrl — registering with only `path` makes this a mode:'local' project (a directory
    // the user already has, used in place, never git-backed).
    await client.callTool({
      name: 'register_project',
      arguments: { project: 'localpaper', path: localDir },
    });
    await stagePdf(localDir, 2);

    const res = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'localpaper' },
    });
    expect(res.isError ?? false).toBe(false);
    const out = structuredOf(res);
    expect(out.pageCount).toBe(2);
    expect(out.pages).toHaveLength(2);
  });

  it('never writes into the project directory, the build dir, or the workspace root (in-place invariant)', async () => {
    const { client, userDir, workspace } = await setup();
    await stagePdf(userDir, 1);
    await stageAux(userDir, '\\newlabel{fig:one}{{1}{3}}\n');

    // Widened beyond the project dir (FIX12): buildDir() resolves under os.tmpdir(), outside the
    // project entirely, so a regression that scratches a file there — exactly what render_pages,
    // the tool this one was copied from, legitimately does — would pass a project-dir-only check.
    const projectBefore = await listAllEntries(userDir);
    const buildBefore = await listAllEntries(buildDir(userDir));
    const workspaceBefore = await listAllEntries(workspace);

    const res = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['text', 'images', 'floats'] },
    });
    expect(res.isError ?? false).toBe(false);

    const after = await listAllEntries(userDir);
    expect(after).toEqual(projectBefore);
    expect(await listAllEntries(buildDir(userDir))).toEqual(buildBefore);
    expect(await listAllEntries(workspace)).toEqual(workspaceBefore);
  });
});

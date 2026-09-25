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
import { buildDir, buildPdfPath, buildAuxPath } from '../../src/services/compiler.js';
import { toPosix } from '../../src/lib/paths.js';
import { minimalPdf } from '../helpers/minimalPdf.js';
import type { ServerConfig } from '../../src/types.js';

/*
 * Which PDF the three read-only PDF tools open in workspace-local mode.
 *
 * `compile` copies whatever root it just built to `<workspace>/<id>.pdf` — ONE file per project,
 * so it holds whichever root compiled LAST. The build dir, by contrast, keeps one PDF (and one
 * .aux) per root. These tools resolve `labels`/`floats` through the REQUESTED root's .aux, so
 * reading the surfaced copy paired one root's page numbers with another root's pages: a label
 * on main.tex's page 3 came back as the supplement's page 3, with no refusal.
 */

const MAIN_TEX = '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n';
const MAIN_AUX = '\\relax\n\\newlabel{fig:x}{{1}{3}{A caption}{figure.1}{}}\n';

/**
 * Stage main.tex's `.aux` — and the `.log` a compile always leaves beside it: a build with
 * neither `.log` nor `.fls` has every label refused (`'pgfpagesUnknown'`).
 */
async function stageMainAux(userDir: string): Promise<void> {
  const auxPath = buildAuxPath(userDir, 'main.tex');
  await writeFile(auxPath, MAIN_AUX);
  await writeFile(
    `${auxPath.slice(0, -'.aux'.length)}.log`,
    'This is pdfTeX, Version 3.141592653\n',
  );
}

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Harness {
  client: Client;
  workspace: string;
  userDir: string;
  surfaced: string;
  mainPdf: string;
}

async function setup(opts: { stageMain: boolean }): Promise<Harness> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-rootsel-ws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-rootsel-dir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
    () => rm(buildDir(userDir), { recursive: true, force: true }),
  );
  await writeFile(path.join(userDir, 'main.tex'), MAIN_TEX);

  const mainPdf = buildPdfPath(userDir, 'main.tex');
  await mkdir(path.dirname(mainPdf), { recursive: true });
  if (opts.stageMain) {
    // The build of the root being asked about: 3 pages, and its .aux puts fig:x on page 3.
    // A footer folio under the text: this PDF has no /PageLabels, so fig:x's printed page is
    // accepted only when that page's own folio reads it.
    await writeFile(
      mainPdf,
      minimalPdf(3, 300, 200, { text: (n) => `MAIN page ${n}, Figure 1 caption\n${n}` }),
    );
    await stageMainAux(userDir);
  }
  // The surfaced copy, left by a later compile of a DIFFERENT root (a 5-page supplement).
  const surfaced = path.join(workspace, 'poster.pdf');
  await writeFile(surfaced, minimalPdf(5, 300, 200, { text: (n) => `SUPP page ${n}` }));

  const config: ServerConfig = {
    workspaceRoot: workspace,
    workspaceIsLocal: true,
    sessionId: 'test',
    projects: [{ id: 'poster', mode: 'local', path: userDir }],
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
  return { client, workspace, userDir, surfaced, mainPdf };
}

interface Out {
  pdfPath?: string;
  pageCount?: number;
  pages: Array<{ page: number; lines?: string[] }>;
  resolvedLabels?: Array<{ label: string; printedPage: string; page: number }>;
  floats?: Array<{ label: string; number: string; page: string }>;
}

function structuredOf(res: unknown): Out {
  return (res as { structuredContent: Out }).structuredContent;
}

function textOf(res: unknown): string {
  return ((res as { content?: Array<{ text?: string }> }).content ?? [])
    .map((b) => b.text ?? '')
    .join('\n');
}

describe('PDF tools read the requested root’s build, not the last-surfaced copy', () => {
  it('extract_text resolves a label and reads the page from the SAME root’s build', async () => {
    const { client, mainPdf } = await setup({ stageMain: true });
    const res = await client.callTool({
      name: 'extract_text',
      arguments: { project: 'poster', rootFile: 'main.tex', labels: ['fig:x'] },
    });
    expect(res.isError ?? false).toBe(false);
    const out = structuredOf(res);
    expect(out.pages[0]?.lines).toEqual(['MAIN page 3, Figure 1 caption', '3']);
    expect(out.pdfPath).toBe(toPosix(mainPdf));
    expect(out.pageCount).toBe(3);
  });

  it('render_pages renders the label’s page out of the SAME root’s build', async () => {
    const { client, mainPdf } = await setup({ stageMain: true });
    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', rootFile: 'main.tex', labels: ['fig:x'], inline: false },
    });
    expect(res.isError ?? false).toBe(false);
    const out = structuredOf(res);
    expect(out.pdfPath).toBe(toPosix(mainPdf));
    expect(out.pageCount).toBe(3);
    expect(out.resolvedLabels).toEqual([{ label: 'fig:x', printedPage: '3', page: 3 }]);
  });

  it('pdf_geometry measures the same root whose .aux it reports floats from', async () => {
    const { client, mainPdf } = await setup({ stageMain: true });
    const res = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', rootFile: 'main.tex', kinds: ['text', 'floats'] },
    });
    expect(res.isError ?? false).toBe(false);
    const out = structuredOf(res);
    expect(out.pdfPath).toBe(toPosix(mainPdf));
    expect(out.pageCount).toBe(3);
    expect(out.floats).toEqual([{ label: 'fig:x', number: '1', page: '3' }]);
  });

  it('with no rootFile, reads the detected root’s build — the same answer as a non-local workspace', async () => {
    const { client, mainPdf } = await setup({ stageMain: true });
    const res = await client.callTool({
      name: 'extract_text',
      arguments: { project: 'poster', pages: [1] },
    });
    expect(res.isError ?? false).toBe(false);
    const out = structuredOf(res);
    expect(out.pdfPath).toBe(toPosix(mainPdf));
    expect(out.pages[0]?.lines).toEqual(['MAIN page 1, Figure 1 caption', '1']);
  });

  it('refuses rather than reading the surfaced copy when the NAMED root has no build', async () => {
    const { client } = await setup({ stageMain: false });
    const res = await client.callTool({
      name: 'extract_text',
      arguments: { project: 'poster', rootFile: 'main.tex', pages: [1] },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('compile');
    expect(textOf(res)).not.toContain('SUPP');
  });

  it('refuses rather than pairing the .aux with the surfaced copy when the root has no build', async () => {
    const { client, userDir } = await setup({ stageMain: false });
    // A compile that died after writing main.aux but before producing main.pdf.
    await stageMainAux(userDir);
    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', labels: ['fig:x'], inline: false },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('compile');
  });

  it('keeps the surfaced copy as the fallback for a plain no-root, no-.aux read', async () => {
    // Retained behaviour, not a regression test: with nothing tying the call to one root, the
    // surfaced copy IS "the last compiled PDF" the description promises, and it outlives a
    // wiped temp build dir.
    const { client, surfaced } = await setup({ stageMain: false });
    const res = await client.callTool({
      name: 'extract_text',
      arguments: { project: 'poster', pages: [1] },
    });
    expect(res.isError ?? false).toBe(false);
    expect(structuredOf(res).pdfPath).toBe(toPosix(surfaced));
  });
});

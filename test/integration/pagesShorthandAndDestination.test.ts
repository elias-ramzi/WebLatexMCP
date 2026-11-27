import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { buildDir, buildPdfPath, buildAuxPath } from '../../src/services/compiler.js';
import { minimalPdf } from '../helpers/minimalPdf.js';
import { ROUTES_ONLY_LOG } from '../helpers/stagedLog.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * Over the wire, with the client's advertised-schema validation armed by `listTools()`:
 *  - `pages` takes a single page number as well as an array, and the advertised JSON Schema says
 *    so (both forms, `anyOf`) for render_pages, extract_text and pdf_geometry;
 *  - a label in a supplement that restarts its numbering resolves through its hyperref
 *    destination, and the `via` key that says so is declared (an undeclared key fails the call
 *    client-side).
 */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(): Promise<{ client: Client; userDir: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'pages-ws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'pages-dir-'));
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
  // Arms the client's per-tool output validators: an undeclared structuredContent key now fails.
  await client.listTools();
  await client.callTool({
    name: 'register_project',
    arguments: { project: 'poster', path: userDir },
  });
  return { client, userDir };
}

/** 24 pages: a 12-page paper and a 12-page supplement numbered 1..12 again. */
const PAGE_LABELS = Array.from({ length: 24 }, (_, i) => String((i % 12) + 1));

async function stage(userDir: string, aux?: string): Promise<void> {
  const pdfPath = buildPdfPath(userDir, 'main.tex');
  await mkdir(path.dirname(pdfPath), { recursive: true });
  await writeFile(
    pdfPath,
    minimalPdf(24, 200, 100, {
      pageLabels: PAGE_LABELS,
      text: (p) => `body\n${PAGE_LABELS[p - 1]}`,
      destinations: { 'figure.caption.40': 24 },
    }),
  );
  if (aux === undefined) return;
  const auxPath = buildAuxPath(userDir, 'main.tex');
  await writeFile(auxPath, aux);
  await writeFile(`${auxPath.slice(0, -'.aux'.length)}.log`, ROUTES_ONLY_LOG);
  const past = new Date(Date.now() - 60_000);
  await utimes(auxPath, past, past);
}

function textOf(res: unknown): string {
  return ((res as { content?: Array<{ text?: string }> }).content ?? [])
    .map((b) => b.text ?? '')
    .join('\n');
}

describe('pages: a single number or an array', () => {
  it('is advertised in both forms by every tool that takes it', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    for (const name of ['render_pages', 'extract_text', 'pdf_geometry']) {
      const tool = tools.find((t) => t.name === name);
      const pages = (tool?.inputSchema.properties as Record<string, unknown>).pages as {
        anyOf?: Array<{ type?: string; minItems?: number }>;
      };
      expect(pages.anyOf?.map((s) => s.type).sort(), name).toEqual(['array', 'integer']);
      expect(pages.anyOf?.find((s) => s.type === 'array')?.minItems, name).toBe(1);
    }
  });

  it('accepts pages: 2 as [2] in render_pages, extract_text and pdf_geometry', async () => {
    const { client, userDir } = await setup();
    await stage(userDir);
    const render = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', pages: 2, inline: false },
    });
    expect(render.isError, textOf(render)).toBeFalsy();
    expect(
      (render.structuredContent as { pages: Array<{ page: number }> }).pages.map((p) => p.page),
    ).toEqual([2]);
    const text = await client.callTool({
      name: 'extract_text',
      arguments: { project: 'poster', pages: 2 },
    });
    expect(text.isError, textOf(text)).toBeFalsy();
    expect(
      (text.structuredContent as { pages: Array<{ page: number }> }).pages.map((p) => p.page),
    ).toEqual([2]);
    const geometry = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', pages: 2, kinds: ['text'] },
    });
    expect(geometry.isError, textOf(geometry)).toBeFalsy();
    expect(
      (geometry.structuredContent as { pages: Array<{ page: number }> }).pages.map((p) => p.page),
    ).toEqual([2]);
  });

  it('still refuses an empty array, and a zero', async () => {
    const { client, userDir } = await setup();
    await stage(userDir);
    for (const pages of [[], 0]) {
      const res = await client.callTool({
        name: 'render_pages',
        arguments: { project: 'poster', pages },
      });
      expect(res.isError).toBe(true);
      if (Array.isArray(pages)) expect(textOf(res)).toMatch(/Omit pages/);
    }
  });
});

describe('labels in a restarted supplement resolve through the hyperref destination', () => {
  const AUX =
    '\\relax\n' +
    '\\newlabel{fig:teaser}{{1}{1}{Teaser}{figure.caption.1}{}}\n' +
    '\\newlabel{fig:backbone_scaling}{{9}{12}{Scaling}{figure.caption.40}{}}\n';

  it('render_pages resolves printed "12" to PDF page 24 and says so with via', async () => {
    const { client, userDir } = await setup();
    await stage(userDir, AUX);
    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', labels: ['fig:backbone_scaling'], inline: false },
    });
    expect(res.isError, textOf(res)).toBeFalsy();
    const out = res.structuredContent as {
      resolvedLabels: unknown[];
      note: string;
    };
    expect(out.resolvedLabels).toEqual([
      { label: 'fig:backbone_scaling', printedPage: '12', page: 24, via: 'destination' },
    ]);
    expect(out.note).toContain('hyperref link target');
  });

  it('extract_text does the same', async () => {
    const { client, userDir } = await setup();
    await stage(userDir, AUX);
    const res = await client.callTool({
      name: 'extract_text',
      arguments: { project: 'poster', labels: ['fig:backbone_scaling'] },
    });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect((res.structuredContent as { resolvedLabels: unknown[] }).resolvedLabels).toEqual([
      { label: 'fig:backbone_scaling', printedPage: '12', page: 24, via: 'destination' },
    ]);
  });

  it('still refuses a label with no destination, naming both pages', async () => {
    const { client, userDir } = await setup();
    await stage(userDir, AUX);
    const res = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'poster', labels: ['fig:teaser'] },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('PDF pages 1, 13');
  });
});

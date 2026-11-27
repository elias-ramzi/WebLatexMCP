import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { LatexmkCompiler, buildDir } from '../../src/services/compiler.js';
import { readAuxFloats } from '../../src/lib/auxFloats.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * The destination route against REAL pdflatex + hyperref output: a main paper and a supplement
 * in one PDF, the supplement restarting at page 1 (`\setcounter{page}{1}`), as a CVPR submission
 * with its supplementary material appended does. hyperref writes /PageLabels "1","2","1","2", so
 * each figure's printed page "2" names PDF pages 2 and 4 — refused as ambiguous before. Each
 * figure's own named destination picks the copy, and the tree (and the .log's shipout marks)
 * confirm it. Gated on latexmk like every smoke.
 */
const compiler = new LatexmkCompiler();
const available = await compiler.isAvailable();

const TEX = [
  '\\documentclass{article}',
  '\\usepackage{hyperref}',
  '\\begin{document}',
  'Main page one.',
  '\\clearpage',
  'Main page two.',
  '\\begin{figure}[h]\\centering MKmain\\caption{Main}\\label{fig:main}\\end{figure}',
  '\\clearpage',
  '\\setcounter{page}{1}',
  'Supplement page one.',
  '\\clearpage',
  'Supplement page two.',
  '\\begin{figure}[h]\\centering MKsupp\\caption{Supp}\\label{fig:supp}\\end{figure}',
  '\\end{document}',
  '',
].join('\n');

interface Out {
  pages: Array<{ page: number; lines?: string[] }>;
  resolvedLabels?: Array<{ label: string; printedPage: string; page: number; via?: string }>;
}

function textOf(res: unknown): string {
  return ((res as { content?: Array<{ text?: string }> }).content ?? [])
    .map((b) => b.text ?? '')
    .join('\n');
}

describe.skipIf(!available)(
  'labels in a restarted supplement, through hyperref destinations',
  () => {
    const cleanups: Array<() => Promise<unknown>> = [];
    let lastUserDir = '';
    afterEach(async () => {
      for (const c of cleanups.splice(0)) await c();
    });

    async function compiled(tex: string): Promise<Client> {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'dest-smoke-ws-'));
      const userDir = await mkdtemp(path.join(os.tmpdir(), 'dest-smoke-src-'));
      cleanups.push(
        () => rm(workspace, { recursive: true, force: true }),
        () => rm(userDir, { recursive: true, force: true }),
        () => rm(buildDir(userDir), { recursive: true, force: true }),
      );
      lastUserDir = userDir;
      await writeFile(path.join(userDir, 'main.tex'), tex);
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
      await client.listTools();
      const res = await client.callTool({ name: 'compile', arguments: { project: 'doc' } });
      const structured = res.structuredContent as Record<string, unknown>;
      expect(
        structured.success,
        `${JSON.stringify(res.content)}\n${String(structured.logTail)}`,
      ).toBe(true);
      return client;
    }

    it('resolves each figure to its own copy of printed page "2"', async () => {
      const client = await compiled(TEX);

      const text = await client.callTool({
        name: 'extract_text',
        arguments: { project: 'doc', labels: ['fig:main', 'fig:supp'] },
      });
      expect(text.isError ?? false, textOf(text)).toBe(false);
      const out = text.structuredContent as unknown as Out;
      expect(out.resolvedLabels).toEqual([
        { label: 'fig:main', printedPage: '2', page: 2, via: 'destination' },
        { label: 'fig:supp', printedPage: '2', page: 4, via: 'destination' },
      ]);
      const page4 = out.pages.find((p) => p.page === 4)?.lines?.join('\n') ?? '';
      expect(page4).toContain('MKsupp');
      expect(textOf(text)).toContain('link target');

      const render = await client.callTool({
        name: 'render_pages',
        arguments: { project: 'doc', labels: ['fig:supp'], inline: false },
      });
      expect(render.isError ?? false, textOf(render)).toBe(false);
      const rendered = render.structuredContent as unknown as Out;
      expect(rendered.pages.map((p) => p.page)).toEqual([4]);
      expect(rendered.resolvedLabels?.[0]?.via).toBe('destination');
    }, 120_000);

    it('refuses a supplement label whose counter reset reuses the main figure’s anchor', async () => {
      // \setcounter{figure}{0} gives the supplement's first figure hyperref's anchor figure.1
      // again; pdfTeX keeps the main figure's destination ("duplicate ignored"), whose page
      // prints "2" and was shipped with counter 2 too. Resolving through it rendered the MAIN
      // figure for fig:supp.
      const tex = TEX.replace(
        '\\setcounter{page}{1}',
        '\\setcounter{page}{1}\\setcounter{figure}{0}' +
          '\\renewcommand{\\thefigure}{S\\arabic{figure}}',
      );
      const client = await compiled(tex);
      const aux = await readAuxFloats(lastUserDir, 'main.tex', { shipouts: true });
      expect(aux.floats.map((f) => f.anchor)).toEqual(['figure.1', 'figure.1']);
      expect(aux.duplicateDestinations?.has('figure.1')).toBe(true);

      for (const label of ['fig:supp', 'fig:main']) {
        const res = await client.callTool({
          name: 'extract_text',
          arguments: { project: 'doc', labels: [label] },
        });
        expect(res.isError, `${label}: ${textOf(res)}`).toBe(true);
        expect(textOf(res)).toContain('"figure.1"');
        expect(textOf(res)).toContain('pass pages: explicitly');
      }
    }, 120_000);
  },
);

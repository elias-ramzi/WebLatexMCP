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
import { logBaseDir } from '../../src/services/compiler.js';
import { CompilerResolver } from '../../src/services/compilerResolver.js';
import { minimalPdf } from '../helpers/minimalPdf.js';
import type { CompileOutcome, CompileRequest } from '../../src/services/compiler.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * `compile` reports how many pages the PDF has.
 *
 * This is the cheap half of "the model cannot see what it compiled": a restructured column that
 * silently pushes a four-column row onto a second page is not an error and not a warning — TeX has
 * no opinion about it — so the log cannot report it and neither could this tool. One number can.
 *
 * The count is read from the PDF rather than from the log's "Output written on … (N pages" line,
 * so these run against a stub engine that produces a real (hand-written) PDF and no TeX at all.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A stand-in engine that "produces" whatever PDF the test staged, so no TeX is needed. */
function stubCompiler(pdfPath: string | undefined) {
  return {
    isAvailable: async () => true,
    compile: async (req: CompileRequest): Promise<CompileOutcome> => ({
      success: pdfPath !== undefined,
      pdfPath,
      durationSec: 0.1,
      log: 'Output written on main.pdf',
      timedOut: false,
      logBaseDir: logBaseDir(req.rootFile),
    }),
  };
}

async function setup(pdfBytes: Buffer | undefined) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-pcws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-pcdir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
  );
  await writeFile(
    path.join(userDir, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}\n',
    'utf8',
  );

  let pdfPath: string | undefined;
  if (pdfBytes) {
    const outDir = path.join(workspace, 'build');
    await mkdir(outDir, { recursive: true });
    pdfPath = path.join(outDir, 'main.pdf');
    await writeFile(pdfPath, pdfBytes);
  }

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
  // `ctx.compiler` is the backend *resolver*; hand it a factory that always yields the stub, so
  // no TeX is involved and the outcome (including whether a PDF exists) is ours to choose.
  ctx.compiler = new CompilerResolver('latexmk', false, () => stubCompiler(pdfPath));
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return { client };
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

function structured(res: unknown): Record<string, unknown> {
  return ((res as { structuredContent?: Record<string, unknown> }).structuredContent ??
    {}) as Record<string, unknown>;
}

describe('compile: pageCount', () => {
  it('reports how many pages the compiled PDF has', async () => {
    const { client } = await setup(minimalPdf(2));

    const res = await client.callTool({ name: 'compile', arguments: { project: 'doc' } });

    expect(structured(res).pageCount).toBe(2);
    // A client that strips structuredContent (Claude Desktop — see lib/outputSchemaCompat) has to
    // see it too, so it goes in the headline as well.
    expect(textOf(res)).toMatch(/2 page\(s\)/);
  });

  it('distinguishes a one-page document from the two-page overflow it is meant to catch', async () => {
    // The whole point: nothing about a spill onto page 2 is an error or a warning, so the only
    // thing that separates these two results is the number. A test that only ever saw one document
    // could not tell the count from a constant.
    const { client } = await setup(minimalPdf(1));

    const res = await client.callTool({ name: 'compile', arguments: { project: 'doc' } });

    expect(structured(res).pageCount).toBe(1);
    expect(textOf(res)).toMatch(/1 page\(s\)/);
  });

  it('omits the count when no PDF was produced, and still reports the failure', async () => {
    const { client } = await setup(undefined);

    const res = await client.callTool({ name: 'compile', arguments: { project: 'doc' } });

    expect(structured(res).pageCount).toBeUndefined();
    expect(structured(res).success).toBe(false);
    expect(textOf(res)).not.toMatch(/page\(s\)/);
  });

  it('never fails a compile that produced a document just because the count could not be read', async () => {
    // The guard just outside: a PDF the counter cannot open (truncated here; in the wild, the
    // optional native canvas backend is absent). A compile that produced a document must still be
    // reported as a success — the count is an extra, never a precondition.
    const { client } = await setup(Buffer.from('%PDF-1.4\nnot really a pdf\n', 'latin1'));

    const res = await client.callTool({ name: 'compile', arguments: { project: 'doc' } });

    expect(structured(res).success).toBe(true);
    expect(structured(res).pageCount).toBeUndefined();
    expect(structured(res).pdfPath).toBeDefined();
  });
});

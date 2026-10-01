import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { buildDir, buildPdfPath, logBaseDir } from '../../src/services/compiler.js';
import { CompilerResolver } from '../../src/services/compilerResolver.js';
import { toPosix } from '../../src/lib/paths.js';
import { minimalPdf } from '../helpers/minimalPdf.js';
import type { CompileOutcome, CompileRequest } from '../../src/services/compiler.js';
import type { ServerConfig } from '../../src/types.js';

/*
 * A project's registered `rootFile` is the root every tool uses when a call names none: `compile`,
 * and the three PDF readers (`render_pages`, `extract_text`, `pdf_geometry`). For the PDF readers
 * a registered root also counts as NAMING a root — it ties the call to that root's build, so a
 * missing build is refused rather than answered from the surfaced `<workspace>/<id>.pdf`, which
 * holds whichever root compiled last.
 *
 * The layout makes the registered root and the detected one DIFFERENT files: a top-level
 * `main.tex` (what detection picks) and a top-level `paper.tex` (what the project registers).
 * Where the two coincide, a tool that ignored the registration would pass every assertion.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const PDF_TOOLS = [
  { name: 'render_pages', args: { pages: [1], inline: false } },
  { name: 'extract_text', args: { pages: [1] } },
  { name: 'pdf_geometry', args: { pages: [1], kinds: ['text'] } },
] as const;

/** A stand-in engine that writes a one-page PDF where latexmk would, and records each root. */
function stubCompiler(compiled: string[]) {
  return {
    isAvailable: async () => true,
    compile: async (req: CompileRequest): Promise<CompileOutcome> => {
      compiled.push(req.rootFile);
      const pdfPath = buildPdfPath(req.projectDir, req.rootFile);
      await mkdir(path.dirname(pdfPath), { recursive: true });
      await writeFile(pdfPath, minimalPdf(1, 300, 200, { text: () => `BUILD OF ${req.rootFile}` }));
      return {
        success: true,
        pdfPath,
        durationSec: 0.1,
        log: '',
        timedOut: false,
        logBaseDir: logBaseDir(req.rootFile),
        rebuilt: true,
      };
    },
  };
}

async function setup(opts: { workspaceIsLocal: boolean }) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-regroot-ws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-regroot-dir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
    () => rm(buildDir(userDir), { recursive: true, force: true }),
  );
  const doc = (body: string) =>
    `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
  await writeFile(path.join(userDir, 'main.tex'), doc('Main'));
  await writeFile(path.join(userDir, 'paper.tex'), doc('Paper'));

  const config: ServerConfig = {
    workspaceRoot: workspace,
    workspaceIsLocal: opts.workspaceIsLocal,
    sessionId: 'test',
    projects: [{ id: 'paper', mode: 'local', path: userDir, rootFile: 'paper.tex' }],
  };
  const ctx = createContext(
    config,
    new CredentialResolver({}),
    { name: 'Test', email: 'test@example.com' },
    new ProjectRegistry(workspace),
  );
  const compiled: string[] = [];
  ctx.compiler = new CompilerResolver('latexmk', false, () => stubCompiler(compiled));
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  // Round-trip the advertised schemas, so every result below is validated as a real client does.
  await client.listTools();
  return { client, workspace, userDir, compiled };
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

function structuredOf(res: unknown): Record<string, unknown> {
  return (res as { structuredContent: Record<string, unknown> }).structuredContent;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('a registered rootFile is the root a call without one uses', () => {
  it('compile builds the registered root, and the PDF tools read its build', async () => {
    const { client, userDir, compiled } = await setup({ workspaceIsLocal: false });

    const res = await client.callTool({ name: 'compile', arguments: { project: 'paper' } });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    expect(structuredOf(res).rootFile).toBe('paper.tex');
    expect(compiled).toEqual(['paper.tex']);
    // Only paper.tex has a build: a tool that fell back to detection (main.tex) finds nothing.
    expect(await exists(buildPdfPath(userDir, 'main.tex'))).toBe(false);

    const paperPdf = toPosix(buildPdfPath(userDir, 'paper.tex'));
    for (const tool of PDF_TOOLS) {
      const out = await client.callTool({
        name: tool.name,
        arguments: { project: 'paper', ...tool.args },
      });
      expect(out.isError ?? false, `${tool.name}: ${textOf(out)}`).toBe(false);
      expect(structuredOf(out).pdfPath, tool.name).toBe(paperPdf);
    }
  });

  it('a registered root counts as named: no fallback to the surfaced copy of another root', async () => {
    const { client, workspace, userDir } = await setup({ workspaceIsLocal: true });

    // Compile the OTHER root explicitly: its PDF is surfaced as <workspace>/paper.pdf, and the
    // registered root (paper.tex) has no build at all.
    const res = await client.callTool({
      name: 'compile',
      arguments: { project: 'paper', rootFile: 'main.tex' },
    });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    expect(await exists(path.join(workspace, 'paper.pdf'))).toBe(true);
    expect(await exists(buildPdfPath(userDir, 'paper.tex'))).toBe(false);

    for (const tool of PDF_TOOLS) {
      const out = await client.callTool({
        name: tool.name,
        arguments: { project: 'paper', ...tool.args },
      });
      expect(out.isError, `${tool.name} answered instead of refusing: ${textOf(out)}`).toBe(true);
      expect(textOf(out), tool.name).toContain('paper.tex');
    }
  });

  it('an explicit rootFile still reads that root’s build beside the registered one', async () => {
    const { client, userDir } = await setup({ workspaceIsLocal: true });
    await client.callTool({
      name: 'compile',
      arguments: { project: 'paper', rootFile: 'main.tex' },
    });

    const mainPdf = toPosix(buildPdfPath(userDir, 'main.tex'));
    for (const tool of PDF_TOOLS) {
      const out = await client.callTool({
        name: tool.name,
        arguments: { project: 'paper', rootFile: 'main.tex', ...tool.args },
      });
      expect(out.isError ?? false, `${tool.name}: ${textOf(out)}`).toBe(false);
      expect(structuredOf(out).pdfPath, tool.name).toBe(mainPdf);
    }
  });
});

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
import { buildDir, buildPdfPath, logBaseDir } from '../../src/services/compiler.js';
import { CompilerResolver } from '../../src/services/compilerResolver.js';
import { minimalPdf } from '../helpers/minimalPdf.js';
import type { CompileOutcome, CompileRequest } from '../../src/services/compiler.js';
import type { ServerConfig } from '../../src/types.js';

/*
 * The live viewer shows ONE root's build: the auto-detected root's (main.tex, else the first .tex
 * with a \documentclass — `locateViewerPdf`). `compile` of any other root leaves the viewer on
 * main.tex, yet the compile result used to say "Live viewer: … it just refreshed with this build"
 * after every compile, sending the caller to a tab that shows a different document.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A stand-in engine that writes a real PDF where latexmk would, so the viewer can find it. */
function stubCompiler() {
  return {
    isAvailable: async () => true,
    compile: async (req: CompileRequest): Promise<CompileOutcome> => {
      const pdfPath = buildPdfPath(req.projectDir, req.rootFile);
      await mkdir(path.dirname(pdfPath), { recursive: true });
      await writeFile(pdfPath, minimalPdf(1));
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
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-vhint-ws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-vhint-dir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
    () => rm(buildDir(userDir), { recursive: true, force: true }),
  );
  const doc = (body: string) =>
    `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
  await writeFile(path.join(userDir, 'main.tex'), doc('Main'));
  await writeFile(path.join(userDir, 'supp.tex'), doc('Supp'));

  const config: ServerConfig = {
    workspaceRoot: workspace,
    workspaceIsLocal: opts.workspaceIsLocal,
    sessionId: 'test',
    projects: [{ id: 'paper', mode: 'local', path: userDir }],
  };
  const ctx = createContext(
    config,
    new CredentialResolver({}),
    { name: 'Test', email: 'test@example.com' },
    new ProjectRegistry(workspace),
  );
  ctx.compiler = new CompilerResolver('latexmk', false, () => stubCompiler());
  const url = await ctx.viewer.start(0);
  if (!url) throw new Error('viewer did not start');
  cleanups.push(() => ctx.viewer.close());
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return { client, userDir };
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

function viewerLine(res: unknown): string {
  const line = textOf(res)
    .split('\n')
    .find((l) => l.startsWith('Live viewer:'));
  if (line === undefined) throw new Error(`no viewer line in:\n${textOf(res)}`);
  return line;
}

describe('compile: the live-viewer line says which build the viewer shows', () => {
  it('says the viewer refreshed when the compiled root is the one it shows', async () => {
    const { client } = await setup({ workspaceIsLocal: false });
    const res = await client.callTool({ name: 'compile', arguments: { project: 'paper' } });
    expect(viewerLine(res)).toMatch(/refreshed with this build/);
  });

  it('does not claim a refresh after compiling another root, and names the one it shows', async () => {
    const { client } = await setup({ workspaceIsLocal: false });
    // main.tex's build exists, so that is what the viewer keeps showing.
    await client.callTool({ name: 'compile', arguments: { project: 'paper' } });
    const res = await client.callTool({
      name: 'compile',
      arguments: { project: 'paper', rootFile: 'supp.tex' },
    });
    const line = viewerLine(res);
    expect(line).not.toMatch(/refreshed with this build/);
    expect(line).toContain('main.tex');
    // …and says where to look at the build it did make.
    expect(line).toMatch(/render_pages/);
    expect(line).toContain('supp.tex');
  });

  it('says the viewer shows this build through the surfaced copy when the detected root has none', async () => {
    // Workspace-local: compile surfaces supp's PDF as <workspace>/<id>.pdf, and with no main.tex
    // build the viewer falls back to that copy — so it DOES show this build, but a comment made on
    // it maps to no source line. Neither "refreshed with this build" nor "shows main.tex" is true.
    const { client } = await setup({ workspaceIsLocal: true });
    const res = await client.callTool({
      name: 'compile',
      arguments: { project: 'paper', rootFile: 'supp.tex' },
    });
    const line = viewerLine(res);
    expect(line).not.toMatch(/refreshed with this build/);
    expect(line).toMatch(/surfaced copy/);
    expect(line).toMatch(/no source location/);
  });
});

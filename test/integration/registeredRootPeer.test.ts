import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { loadConfig } from '../../src/config.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { buildDir, buildPdfPath, logBaseDir } from '../../src/services/compiler.js';
import { CompilerResolver } from '../../src/services/compilerResolver.js';
import { toPosix } from '../../src/lib/paths.js';
import { minimalPdf } from '../helpers/minimalPdf.js';
import type { CompileOutcome, CompileRequest } from '../../src/services/compiler.js';

/*
 * Two sessions (two contexts, as two server processes would be) over ONE workspace and its
 * registry. Session A loads project `paper` at startup with no `rootFile`; peer session B then
 * re-registers it with `rootFile: 'paper.tex'`. A's in-process snapshot never refreshes an id it
 * already holds, so before the fix A kept building the detected root (`main.tex`) until a restart —
 * and the hints' advice to "register the project again with rootFile" did nothing for A.
 *
 * The layout makes the registered root and the detected one DIFFERENT files: a top-level
 * `main.tex` (what detection picks) and a top-level `paper.tex` (what B registers).
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

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

/** One session: its own context and server, over the shared workspace, configured as at startup. */
async function startSession(workspace: string, sessionId: string) {
  const config = loadConfig(
    { WEB_LATEX_MCP_WORKSPACE: workspace, WEB_LATEX_MCP_SESSION: sessionId },
    workspace,
    () => false,
  );
  const ctx = createContext(
    config,
    new CredentialResolver({}),
    { name: 'Test', email: 'test@example.com' },
    new ProjectRegistry(workspace),
  );
  const compiled: string[] = [];
  ctx.compiler = new CompilerResolver('latexmk', false, () => stubCompiler(compiled));
  cleanups.push(() => ctx.viewer.close());
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: sessionId, version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  // Round-trip the advertised schemas, so every result below is validated as a real client does.
  await client.listTools();
  return { client, compiled };
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

function structuredOf(res: unknown): Record<string, unknown> {
  return (res as { structuredContent: Record<string, unknown> }).structuredContent;
}

describe('a peer session’s re-registration of rootFile', () => {
  it('reaches a session that loaded the project before it, without a restart', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-regroot-peer-ws-'));
    const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-regroot-peer-dir-'));
    cleanups.push(
      () => rm(workspace, { recursive: true, force: true }),
      () => rm(userDir, { recursive: true, force: true }),
      () => rm(buildDir(userDir), { recursive: true, force: true }),
    );
    const doc = (body: string) =>
      `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
    await writeFile(path.join(userDir, 'main.tex'), doc('Main'));
    await writeFile(path.join(userDir, 'paper.tex'), doc('Paper'));

    // `paper` is in the registry, with no rootFile, before session A starts.
    await new ProjectRegistry(workspace).upsert({ id: 'paper', mode: 'local', path: userDir });

    const a = await startSession(workspace, 'A');
    const b = await startSession(workspace, 'B');

    // A loaded it without a rootFile: detection picks main.tex.
    const first = await a.client.callTool({ name: 'compile', arguments: { project: 'paper' } });
    expect(first.isError ?? false, textOf(first)).toBe(false);
    expect(structuredOf(first).rootFile).toBe('main.tex');

    // Peer B re-registers the same directory with a rootFile.
    const reg = await b.client.callTool({
      name: 'register_project',
      arguments: { project: 'paper', path: userDir, rootFile: 'paper.tex' },
    });
    expect(reg.isError ?? false, textOf(reg)).toBe(false);

    // A's next compile without a rootFile builds the root B registered.
    const second = await a.client.callTool({ name: 'compile', arguments: { project: 'paper' } });
    expect(second.isError ?? false, textOf(second)).toBe(false);
    expect(structuredOf(second).rootFile).toBe('paper.tex');
    expect(a.compiled).toEqual(['main.tex', 'paper.tex']);

    // And A's PDF tools read that root's build, not the one A built first.
    const paperPdf = toPosix(buildPdfPath(userDir, 'paper.tex'));
    for (const tool of [
      { name: 'render_pages', args: { pages: [1], inline: false } },
      { name: 'extract_text', args: { pages: [1] } },
      { name: 'pdf_geometry', args: { pages: [1], kinds: ['text'] } },
    ]) {
      const out = await a.client.callTool({
        name: tool.name,
        arguments: { project: 'paper', ...tool.args },
      });
      expect(out.isError ?? false, `${tool.name}: ${textOf(out)}`).toBe(false);
      expect(structuredOf(out).pdfPath, tool.name).toBe(paperPdf);
    }
  });

  // The viewer resolves its root on its own path (context.ts' `viewerRoot`), not through a tool's
  // rootFile lookup, so it is pinned on its own: it must follow the root B registered too.
  it('reaches the viewer of a session that loaded the project before it', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-regroot-peer-ws-'));
    const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-regroot-peer-dir-'));
    cleanups.push(
      () => rm(workspace, { recursive: true, force: true }),
      () => rm(userDir, { recursive: true, force: true }),
    );
    const doc = '\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n';
    await writeFile(path.join(userDir, 'main.tex'), doc);
    await writeFile(path.join(userDir, 'paper.tex'), doc);
    await new ProjectRegistry(workspace).upsert({ id: 'paper', mode: 'local', path: userDir });

    const a = await startSession(workspace, 'A');
    const b = await startSession(workspace, 'B');

    const before = await a.client.callTool({
      name: 'viewer',
      arguments: { project: 'paper', open: false },
    });
    expect(before.isError ?? false, textOf(before)).toBe(false);
    expect(structuredOf(before)).toMatchObject({ rootFile: 'main.tex', rootSource: 'detected' });

    const reg = await b.client.callTool({
      name: 'register_project',
      arguments: { project: 'paper', path: userDir, rootFile: 'paper.tex' },
    });
    expect(reg.isError ?? false, textOf(reg)).toBe(false);

    const after = await a.client.callTool({
      name: 'viewer',
      arguments: { project: 'paper', open: false },
    });
    expect(after.isError ?? false, textOf(after)).toBe(false);
    expect(structuredOf(after)).toMatchObject({ rootFile: 'paper.tex', rootSource: 'registered' });
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, cp, rm, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { LatexmkCompiler } from '../../src/services/compiler.js';
import type { ServerConfig } from '../../src/types.js';

// A real compile of a directory the server does not own, gated on latexmk (runs in tex-smoke CI).
const compiler = new LatexmkCompiler();
const available = await compiler.isAvailable();
const FIXTURE = fileURLToPath(new URL('../fixtures/sample-latex', import.meta.url));

describe.skipIf(!available)('compiling a local (in-place) project', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('builds the PDF without writing anything into the user’s directory', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-localc-ws-'));
    const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-localc-src-'));
    cleanups.push(
      () => rm(workspace, { recursive: true, force: true }),
      () => rm(userDir, { recursive: true, force: true }),
    );
    await cp(FIXTURE, userDir, { recursive: true });
    const before = (await readdir(userDir)).sort();

    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: 'test',
      projects: [{ id: 'cv', mode: 'local', path: userDir, rootFile: 'main.tex' }],
      defaultProject: 'cv',
      // Surface the PDF the way a workspace-local install does, to prove where it lands.
      workspaceIsLocal: true,
    };
    const ctx = createContext(config, new CredentialResolver({}), {
      name: 'Test',
      email: 'test@example.com',
    });
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(async () => {
      await client.close();
    });

    const res = await client.callTool({ name: 'compile', arguments: { project: 'cv' } });
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.success, JSON.stringify(res.content)).toBe(true);
    expect(structured.errors).toEqual([]);
    expect(structured.missingPackages).toEqual([]);

    // The PDF is surfaced into the workspace, never beside the user's source...
    expect(structured.pdfPath).toBe(path.join(workspace, 'cv.pdf').split(path.sep).join('/'));
    // ...and the directory the user gave us is byte-for-byte the same set of files as before:
    // no .aux, no .log, no .pdf dropped next to their .tex.
    expect((await readdir(userDir)).sort()).toEqual(before);
  }, 120_000);
});

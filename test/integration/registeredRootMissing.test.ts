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
 * A registered rootFile is used as given (resolveRootFile), so one that is stale or mistyped —
 * `"rootFile": "main.tex"` pasted from an install doc into a project whose root is another file —
 * must fail in words naming that root and where it came from. It used to come back as
 * `FAILED gone.tex with latexmk … 0 error(s)` from `compile` (the cause only in logTail), and as
 * "No compiled PDF found … Run compile first" from the PDF tools right after a compile of another
 * root had succeeded.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(rootFile = 'gone.tex') {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-regroot-ws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-regroot-dir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
    () => rm(buildDir(userDir), { recursive: true, force: true }),
  );
  await writeFile(
    path.join(userDir, 'other.tex'),
    '\\documentclass{article}\n\\begin{document}\nOther\n\\end{document}\n',
  );
  await mkdir(path.join(userDir, 'sub'));

  const compiled: string[] = [];
  const stub = {
    isAvailable: async () => true,
    compile: async (req: CompileRequest): Promise<CompileOutcome> => {
      compiled.push(req.rootFile);
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

  const config: ServerConfig = {
    workspaceRoot: workspace,
    workspaceIsLocal: false,
    sessionId: 'test',
    projects: [{ id: 'paper', mode: 'local', path: userDir, rootFile }],
  };
  const ctx = createContext(
    config,
    new CredentialResolver({}),
    { name: 'Test', email: 'test@example.com' },
    new ProjectRegistry(workspace),
  );
  ctx.compiler = new CompilerResolver('latexmk', false, () => stub);
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  // Cache the advertised output schemas, so every result below is checked against them.
  await client.listTools();
  return { client, compiled };
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

function expectRegisteredRootRefusal(res: unknown): void {
  expect((res as { isError?: boolean }).isError).toBe(true);
  const text = textOf(res);
  expect(text).toContain('"gone.tex"');
  expect(text).toMatch(/registered/);
  expect(text).toContain('WEB_LATEX_MCP_PROJECTS');
  expect(text).not.toMatch(/No compiled PDF found/);
}

describe('a registered rootFile that is not in the project', () => {
  it('is refused by compile, naming the root and the registration, before any build', async () => {
    const { client, compiled } = await setup();
    const res = await client.callTool({ name: 'compile', arguments: { project: 'paper' } });
    expectRegisteredRootRefusal(res);
    expect(compiled).toEqual([]);
  });

  it('is refused by the PDF tools even after another root compiled', async () => {
    const { client, compiled } = await setup();
    const ok = await client.callTool({
      name: 'compile',
      arguments: { project: 'paper', rootFile: 'other.tex' },
    });
    expect((ok as { isError?: boolean }).isError).toBeFalsy();
    expect(compiled).toEqual(['other.tex']);

    for (const name of ['render_pages', 'extract_text', 'pdf_geometry']) {
      const res = await client.callTool({ name, arguments: { project: 'paper' } });
      expectRegisteredRootRefusal(res);
    }

    // An explicit root keeps working: the check is for the registered one only.
    const named = await client.callTool({
      name: 'extract_text',
      arguments: { project: 'paper', rootFile: 'other.tex' },
    });
    expect((named as { isError?: boolean }).isError).toBeFalsy();
  });
});

describe('a registered rootFile an overlay compile refuses by its spelling', () => {
  it('says the root came from the registration', async () => {
    // `sub/../other.tex` exists, so the registered-root check passes it; the overlay's own
    // spelling check refuses the ".." — for a root this call never named.
    const { client, compiled } = await setup('sub/../other.tex');
    const res = await client.callTool({
      name: 'compile',
      arguments: {
        project: 'paper',
        overlay: [{ file: 'other.tex', edits: [{ oldString: 'Other', newString: 'Changed' }] }],
      },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('".." segment');
    expect(text).toMatch(/registered with \(register_project or WEB_LATEX_MCP_PROJECTS\)/);
    expect(compiled).toEqual([]);
  });
});

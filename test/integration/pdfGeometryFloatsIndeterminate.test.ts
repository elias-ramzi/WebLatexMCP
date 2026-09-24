/**
 * `pdf_geometry`'s `floatsIndeterminate`, at the tool boundary (issue #139 §2).
 *
 * The lib half — that a `\newlabel` whose own key group never closes is counted at all, and
 * counted apart from `dropped` and `refused` — lives in `test/unit/auxFloats.test.ts`. This file
 * covers the two things a unit test structurally cannot: that the tool carries the count out of
 * the handler at all (it computed `refused` and dropped it on the floor for a whole release —
 * #128), and that the field is **declared**.
 *
 * The declaration half needs its own assertion off a real `listTools()` round trip. The MCP SDK
 * neither strips nor rejects a key the `outputSchema` omits (#130): it validates
 * `structuredContent`, discards the parse result and forwards the handler's own object, so an
 * undeclared key reaches the caller verbatim while the schema a model reads to learn the field
 * exists never mentions it. An assertion on `structuredContent` alone would pin the handler and
 * prove nothing about the contract.
 *
 * A separate file from `pdfGeometry.test.ts` only because that one was being rewritten in the
 * same wave; its harness is mirrored here rather than shared.
 */
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
import { buildDir, buildAuxPath } from '../../src/services/compiler.js';
import { expectDeclaredField } from '../helpers/outputSchema.js';
import { GROUP_SKIP_SCAN, MAX_GROUP_SCAN } from '../../src/lib/auxFloats.js';
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
  userDir: string;
}

async function setup(): Promise<Harness> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-indetws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-indetdir-'));
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
  return { client, userDir };
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

interface FloatsOut {
  floats?: Array<{ label: string; number: string; page: string }>;
  floatsOmitted?: number;
  floatsOmittedBySize?: number;
  floatsDropped?: number;
  floatsRefused?: number;
  floatsIndeterminate?: number;
}

function structuredOf(res: unknown): FloatsOut {
  return (res as { structuredContent: FloatsOut }).structuredContent;
}

describe('pdf_geometry floatsIndeterminate (#139 §2)', () => {
  it('reports and DECLARES floatsIndeterminate, apart from floatsDropped and floatsRefused', async () => {
    const { client, userDir } = await setup();
    // A \newlabel whose own key group opens and never closes within either scan budget, so
    // nothing about the marker could be read — not even the key. The real entry before it is
    // untouched, which is what keeps this from passing for the wrong reason.
    const hugeKey = 'k'.repeat(GROUP_SKIP_SCAN + 100);
    const trailer = ' and the file continues well past the retry budget with ordinary text.';
    await stageAux(userDir, `\\newlabel{fig:a}{{1}{3}}\n\\newlabel{${hugeKey}${trailer}`);

    const res = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['floats'] },
    });
    expect(res.isError ?? false).toBe(false);
    const out = structuredOf(res);
    expect(out.floats).toEqual([{ label: 'fig:a', number: '1', page: '3' }]);
    // Watched failing pre-fix: floatsIndeterminate was undefined and the marker was counted
    // nowhere at all — total/dropped/refused all as if the file held one clean entry.
    expect(out.floatsIndeterminate).toBe(1);
    // Added to none of the others. A single number would claim either a loss (floatsDropped) or
    // a fabrication declined (floatsRefused), and this marker supports neither claim.
    expect(out.floatsDropped).toBe(0);
    expect(out.floatsRefused).toBe(0);
    expect(out.floatsOmitted).toBe(0);
    expect(out.floatsOmittedBySize).toBe(0);
    // The text channel says it in words that claim neither a loss nor a fabrication.
    expect(textOf(res)).toContain('1 marker(s) too malformed to judge');

    // Declared, not merely emitted — see this file's header for why that is a separate question.
    await expectDeclaredField(client, 'pdf_geometry', 'floatsIndeterminate', {
      description: /NOT added to floatsDropped/,
    });
  });

  it('#139 §1: a fake inside a group that closes nowhere reaches the tool as refused, never as a float', async () => {
    // The tool-boundary half of the reversal. render_pages and extract_text read the same
    // readAuxFloats index for label->page lookup, so a row invented by the .aux's own bytes
    // becomes a page rendered with confidence. Pre-#139 this call returned
    // floats: [{fig:fake, 9, 999}] with floatsRefused 0.
    const { client, userDir } = await setup();
    const pad = 'x'.repeat(MAX_GROUP_SCAN + 100);
    await stageAux(userDir, `\\newlabel{fig:real}{{1}{7}{${pad}\\newlabel{fig:fake}{{9}{999}}`);

    const res = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['floats'] },
    });
    expect(res.isError ?? false).toBe(false);
    const out = structuredOf(res);
    expect(out.floats).toEqual([]);
    expect(out.floatsDropped).toBe(1);
    expect(out.floatsRefused).toBe(1);
    expect(out.floatsIndeterminate).toBe(0);
  });
});

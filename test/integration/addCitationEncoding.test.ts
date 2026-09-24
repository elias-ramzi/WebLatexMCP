import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { DblpService, type FetchResponse } from '../../src/services/dblp.js';
import { ReferenceResolver } from '../../src/services/referenceResolver.js';
import type { ServerConfig } from '../../src/types.js';
import { MAX_BINARY_READ_BYTES } from '../../src/lib/assets.js';

// add_citation reads the whole .bib, appends one entry and writes the whole file back. The read
// decoded as UTF-8, so a legacy Latin-1 bibliography (an accented author name is the one byte
// 0xE9) came back with every such byte rewritten as U+FFFD (ef bf bd) — the whole file corrupted
// by a one-entry append. It now refuses such a file and writes nothing.

const BIBTEX =
  '@inproceedings{DBLP:conf/cvpr/HeZRS16,\n' +
  '  author = {Kaiming He and others},\n' +
  '  title = {Deep Residual Learning for Image Recognition},\n' +
  '  year = {2016}\n}';

function ok(body: string): FetchResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => body,
    json: async () => ({}),
  };
}

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function isError(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}

function plainText(res: unknown): string {
  const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

/** A local project holding `refs.bib` with exactly `bib`'s bytes; only DBLP answers. */
async function setup(bib: Buffer): Promise<{ client: Client; bibPath: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-citeenc-ws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-citeenc-local-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
  );
  await writeFile(path.join(userDir, 'main.tex'), '\\documentclass{article}\n');
  await writeFile(path.join(userDir, 'refs.bib'), bib);
  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'test',
    projects: [{ id: 'loc', mode: 'local', path: userDir }],
    defaultProject: 'loc',
  };
  const ctx = createContext(
    config,
    new CredentialResolver({}),
    { name: 'Test', email: 'test@example.com' },
    new ProjectRegistry(workspace),
  );
  ctx.references = new ReferenceResolver({
    dblp: new DblpService(async () => ok(BIBTEX)),
    crossref: {
      search: () => Promise.reject(new Error('crossref must not be consulted')),
      fetchBibtex: () => Promise.reject(new Error('crossref must not be consulted')),
    },
    openalex: {
      search: () => Promise.reject(new Error('openalex must not be consulted')),
      resolveDoi: () => Promise.reject(new Error('openalex must not be consulted')),
    },
  });
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return { client, bibPath: path.join(userDir, 'refs.bib') };
}

describe('add_citation never re-encodes a bibliography that is not UTF-8', () => {
  it('refuses a Latin-1 .bib and leaves its bytes untouched', async () => {
    // 'Caf\xe9' in Latin-1: the lone byte 0xE9 is not valid UTF-8.
    const latin1 = Buffer.from('@article{a, author={Caf\xe9}}\n', 'latin1');
    expect(latin1.includes(0xe9)).toBe(true);
    const { client, bibPath } = await setup(latin1);
    const res = await client.callTool({
      name: 'add_citation',
      arguments: { project: 'loc', key: 'dblp:conf/cvpr/HeZRS16' },
    });
    expect(isError(res)).toBe(true);
    expect(plainText(res)).toMatch(/refs\.bib.*not valid UTF-8/);
    expect((await readFile(bibPath)).equals(latin1)).toBe(true);
  });

  it('still appends to a UTF-8 .bib with accented names, keeping them byte-exact', async () => {
    const utf8 = Buffer.from('@article{a, author={Café Müller}}\n', 'utf8');
    const { client, bibPath } = await setup(utf8);
    const res = await client.callTool({
      name: 'add_citation',
      arguments: { project: 'loc', key: 'dblp:conf/cvpr/HeZRS16' },
    });
    expect(isError(res), plainText(res)).toBe(false);
    const after = await readFile(bibPath);
    expect(after.subarray(0, utf8.length).equals(utf8)).toBe(true);
    expect(after.toString('utf8')).toContain('DBLP:conf/cvpr/HeZRS16');
    expect(after.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
  });
});

// Reading the .bib as bytes (so a lossy decode can be refused) must not bring in the 25 MB
// BINARY read cap with it: a shared bibliography can run to tens of MB (ACL Anthology's
// anthology.bib is one), and the text read add_citation used before had no cap at all. Such a
// file was refused with a message about the "binary read cap" and "Open it directly".
describe('add_citation appends to a bibliography larger than the binary read cap', () => {
  it(
    'appends to a UTF-8 .bib just over 25 MB, keeping its bytes',
    { timeout: 60_000 },
    async () => {
      const pad = 'x'.repeat(MAX_BINARY_READ_BYTES);
      const big = Buffer.from(`@comment{${pad}}\n@article{a, author={Café}}\n`, 'utf8');
      expect(big.length).toBeGreaterThan(MAX_BINARY_READ_BYTES);
      const { client, bibPath } = await setup(big);
      const res = await client.callTool({
        name: 'add_citation',
        arguments: { project: 'loc', key: 'dblp:conf/cvpr/HeZRS16' },
      });
      expect(isError(res), plainText(res)).toBe(false);
      const after = await readFile(bibPath);
      expect(after.subarray(0, big.length).equals(big)).toBe(true);
      expect(after.subarray(big.length).toString('utf8')).toContain('DBLP:conf/cvpr/HeZRS16');
    },
  );
});

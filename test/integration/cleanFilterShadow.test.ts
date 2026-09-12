import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * Regression test for #63: a clone whose `.gitattributes` normalises line endings
 * (`* text=auto`) leaves a session's shadow permanently `conflicted` for a path it imported,
 * because `commit`'s default (session) scope stages via `GitService.commitContents`, which
 * clean-filters each blob — so the HEAD bytes differ from the shadow's raw bytes even though no
 * peer touched the file. See `src/services/shadowStore.ts`'s class doc comment.
 *
 * This is driven end to end through the MCP client, exactly like assetRoundTrip.test.ts, because
 * the bug lives in the interaction between `add_asset`/`write_file` (which record a shadow from
 * raw working-tree bytes) and `commit` (which writes filtered blobs) — a unit test against
 * ShadowStore alone cannot exercise the real clean filter.
 */

const CRLF_SVG_1 = '<svg>\r\n<rect/>\r\n</svg>\r\n';
const CRLF_SVG_2 = '<svg>\r\n<rect fill="red"/>\r\n</svg>\r\n';
const CRLF_TEX = '\\section{Notes}\r\nSome text.\r\n';

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function structured(res: unknown): Record<string, unknown> {
  return (res as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}
function isError(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}
function textOf(res: unknown): string {
  return JSON.stringify((res as { content?: unknown }).content ?? '');
}

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

async function setup(): Promise<{ client: Client; remote: FakeRemote; workspace: string }> {
  const remote = await createFakeRemote({
    'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    '.gitattributes': '* text=auto\n',
  });
  cleanups.push(remote.cleanup);
  const workspace = await tmp('ovl-cleanfilter-ws-');
  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'test',
    projects: [{ id: 'demo', gitUrl: remote.url }],
    defaultProject: 'demo',
  };
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
  await client.callTool({ name: 'project_sync', arguments: { project: 'demo', mode: 'clone' } });
  return { client, remote, workspace };
}

describe('shadow store stays honest through a gitattributes clean filter (#63)', () => {
  it('imports a CRLF asset, commits with the default scope, and never sticks conflicted', async () => {
    const { client, workspace } = await setup();

    // 1. add_asset a CRLF SVG, then commit with the default (session) scope.
    const added = await client.callTool({
      name: 'add_asset',
      arguments: {
        project: 'demo',
        path: 'figures/fig.svg',
        contentBase64: Buffer.from(CRLF_SVG_1, 'utf8').toString('base64'),
      },
    });
    expect(isError(added), textOf(added)).toBe(false);

    const committed1 = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'Add CRLF svg' },
    });
    expect(isError(committed1), textOf(committed1)).toBe(false);
    expect(structured(committed1).conflicted).toEqual([]);
    const files1 = (structured(committed1).files as Array<{ path: string }> | undefined)?.map(
      (f) => f.path,
    );
    expect(files1).toEqual(expect.arrayContaining(['figures/fig.svg']));

    // 2. A second add_asset to the same path with DIFFERENT CRLF bytes, then commit again.
    const added2 = await client.callTool({
      name: 'add_asset',
      arguments: {
        project: 'demo',
        path: 'figures/fig.svg',
        contentBase64: Buffer.from(CRLF_SVG_2, 'utf8').toString('base64'),
        overrideExternalChanges: true,
      },
    });
    expect(isError(added2), textOf(added2)).toBe(false);

    const committed2 = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'Update CRLF svg' },
    });
    expect(isError(committed2), textOf(committed2)).toBe(false);
    expect(structured(committed2).conflicted).toEqual([]);
    expect(structured(committed2).committed).toBe(true);
    const files2 = (structured(committed2).files as Array<{ path: string }> | undefined)?.map(
      (f) => f.path,
    );
    expect(files2).toEqual(expect.arrayContaining(['figures/fig.svg']));

    // 3. write_file of a CRLF .tex, then commit.
    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'notes.tex', content: CRLF_TEX },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);

    const committed3 = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'Add CRLF notes' },
    });
    expect(isError(committed3), textOf(committed3)).toBe(false);
    expect(structured(committed3).conflicted).toEqual([]);

    // 4. Prove the clean filter actually ran: HEAD holds LF, not the CRLF bytes that were written.
    const cloneDir = path.join(workspace, 'demo');
    const git = simpleGit(cloneDir);
    const headSvg = await git.raw(['show', 'HEAD:figures/fig.svg']);
    expect(headSvg).not.toContain('\r\n');
    expect(headSvg.replace(/\n$/, '')).toBe(CRLF_SVG_2.replace(/\r\n/g, '\n').replace(/\n$/, ''));
    const headTex = await git.raw(['show', 'HEAD:notes.tex']);
    expect(headTex).not.toContain('\r\n');
  });
});

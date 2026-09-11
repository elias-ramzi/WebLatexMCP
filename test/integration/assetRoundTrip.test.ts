import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
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
 * The whole point of the feature, end to end: a figure that exists on the user's laptop but not
 * in the project reaches the remote byte-identically, alongside a new `.tex` file in a directory
 * that did not exist.
 *
 * This deliberately commits with the **default** scope. `scope: 'all'`/`'paths'` stage through
 * `git add` and were always binary-safe; the default is `'session'`, which stages each file from
 * this session's *shadow* — the path that used to round-trip every byte through UTF-8 and so
 * silently corrupted a PNG. A test that passed `scope: 'all'` would prove nothing about the bug.
 */

/** Every byte value twice: guaranteed to contain sequences no UTF-8 decoder can round-trip. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // real PNG signature
  Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  Buffer.from(Array.from({ length: 256 }, (_, i) => 255 - i)),
]);

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
  });
  cleanups.push(remote.cleanup);
  const workspace = await tmp('ovl-roundtrip-ws-');
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

describe('asset round trip: laptop -> project -> remote', () => {
  it('pushes a PNG and a new .tex in a new folder, byte-identically, via the default commit scope', async () => {
    const { client, remote } = await setup();

    // The figure as it exists on the coworker's laptop — outside every project sandbox.
    const laptop = await tmp('ovl-laptop-');
    const laptopPng = path.join(laptop, 'results plot.png'); // a space, as real filenames have
    await writeFile(laptopPng, PNG);

    const added = await client.callTool({
      name: 'add_asset',
      arguments: { project: 'demo', path: 'figures/plot.png', sourcePath: laptopPng },
    });
    expect(isError(added), textOf(added)).toBe(false);
    expect(structured(added).bytesWritten).toBe(PNG.length);
    // The resolved origin is reported back, so the user can see which file was actually copied.
    expect(String(structured(added).source)).toContain('results plot.png');

    // The other half of the request: a new .tex file inside a folder that does not exist yet.
    const wrote = await client.callTool({
      name: 'write_file',
      arguments: {
        project: 'demo',
        path: 'sections/results.tex',
        content: '\\section{Results}\n\\includegraphics{figures/plot.png}\n',
        createDirs: true,
      },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);

    // Default scope — the shadow path. Not 'all', which would prove nothing about the bug.
    const committed = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'Add results figure and section' },
    });
    expect(isError(committed), textOf(committed)).toBe(false);
    expect(structured(committed).scope).toBe('session');
    const committedPaths = (
      structured(committed).files as Array<{ path: string }> | undefined
    )?.map((f) => f.path);
    expect(committedPaths).toEqual(
      expect.arrayContaining(['figures/plot.png', 'sections/results.tex']),
    );

    const pushed = await client.callTool({
      name: 'push',
      arguments: { project: 'demo', confirm: true },
    });
    expect(isError(pushed), textOf(pushed)).toBe(false);

    // Clone the remote afresh: what a collaborator opening the project would actually get.
    const fresh = await tmp('ovl-fresh-');
    await simpleGit().clone(remote.url, fresh);
    const landed = await readFile(path.join(fresh, 'figures', 'plot.png'));
    expect(Buffer.compare(landed, PNG)).toBe(0);
    expect(landed.length).toBe(PNG.length);
    const tex = await readFile(path.join(fresh, 'sections', 'results.tex'), 'utf8');
    expect(tex).toContain('\\section{Results}');
  });

  it('git records the pushed figure as binary, not as mangled text', async () => {
    const { client, remote } = await setup();
    const laptop = await tmp('ovl-laptop-');
    const laptopPng = path.join(laptop, 'fig.png');
    await writeFile(laptopPng, PNG);

    await client.callTool({
      name: 'add_asset',
      arguments: { project: 'demo', path: 'figures/fig.png', sourcePath: laptopPng },
    });
    await client.callTool({ name: 'commit', arguments: { project: 'demo', message: 'figure' } });
    await client.callTool({ name: 'push', arguments: { project: 'demo', confirm: true } });

    // Ask the remote itself for the blob size. A UTF-8 round trip replaces every invalid
    // sequence with a 3-byte U+FFFD, so a corrupted blob is *larger* than the original —
    // this assertion fails loudly on exactly the bug the feature exists to fix.
    const bare = simpleGit(remote.bareDir);
    const size = (await bare.raw(['cat-file', '-s', `HEAD:figures/fig.png`])).trim();
    expect(Number(size)).toBe(PNG.length);
  });
});

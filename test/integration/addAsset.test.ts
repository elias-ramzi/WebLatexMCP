import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import type { ServerConfig } from '../../src/types.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0xfd]);

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** Tool text/structuredContent, the way other integration tests read a CallToolResult. */
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
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function setupGitProject(): Promise<{
  client: Client;
  remote: FakeRemote;
  workspace: string;
}> {
  const remote = await createFakeRemote({ 'main.tex': '\\documentclass{article}\n' });
  cleanups.push(remote.cleanup);
  const workspace = await tmp('ovl-asset-ws-');
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

describe('add_asset (git project)', () => {
  it('writes byte-identical bytes into the clone', async () => {
    const { client, workspace } = await setupGitProject();
    const src = await tmp('ovl-asset-src-');
    const srcFile = path.join(src, 'plot.png');
    await writeFile(srcFile, PNG);

    const res = await client.callTool({
      name: 'add_asset',
      arguments: { project: 'demo', path: 'figures/plot.png', sourcePath: srcFile },
    });
    expect(isError(res)).toBe(false);
    const sc = structured(res);
    expect(sc.created).toBe(true);
    expect(sc.bytesWritten).toBe(PNG.length);

    const clone = path.join(workspace, 'demo');
    const onDisk = await readFile(path.join(clone, 'figures', 'plot.png'));
    expect(Buffer.compare(onDisk, PNG)).toBe(0);
  });

  it('creates the missing figures/ directory by default (createDirs defaults true)', async () => {
    const { client, workspace } = await setupGitProject();
    const src = await tmp('ovl-asset-src-');
    const srcFile = path.join(src, 'plot.png');
    await writeFile(srcFile, PNG);

    const res = await client.callTool({
      name: 'add_asset',
      arguments: { project: 'demo', path: 'figures/nested/plot.png', sourcePath: srcFile },
    });
    expect(isError(res)).toBe(false);
    const clone = path.join(workspace, 'demo');
    const onDisk = await readFile(path.join(clone, 'figures', 'nested', 'plot.png'));
    expect(Buffer.compare(onDisk, PNG)).toBe(0);
  });

  it('the out-of-band guard bites on a re-import after a direct on-disk edit, and yields to override', async () => {
    const { client, workspace } = await setupGitProject();
    const src = await tmp('ovl-asset-src-');
    const srcFile = path.join(src, 'plot.png');
    await writeFile(srcFile, PNG);

    const first = await client.callTool({
      name: 'add_asset',
      arguments: { project: 'demo', path: 'figures/plot.png', sourcePath: srcFile },
    });
    expect(isError(first)).toBe(false);

    // Simulate the user editing the clone directly, outside the server's tools.
    const clone = path.join(workspace, 'demo');
    await writeFile(path.join(clone, 'figures', 'plot.png'), Buffer.from([1, 2, 3]));

    const blocked = await client.callTool({
      name: 'add_asset',
      arguments: { project: 'demo', path: 'figures/plot.png', sourcePath: srcFile },
    });
    expect(isError(blocked)).toBe(true);
    expect(textOf(blocked)).toMatch(/changed on disk/);
    // The externally-written bytes are preserved, not clobbered.
    expect(
      Buffer.compare(
        await readFile(path.join(clone, 'figures', 'plot.png')),
        Buffer.from([1, 2, 3]),
      ),
    ).toBe(0);

    const overridden = await client.callTool({
      name: 'add_asset',
      arguments: {
        project: 'demo',
        path: 'figures/plot.png',
        sourcePath: srcFile,
        overrideExternalChanges: true,
      },
    });
    expect(isError(overridden)).toBe(false);
    expect(Buffer.compare(await readFile(path.join(clone, 'figures', 'plot.png')), PNG)).toBe(0);
  });
});

describe('add_asset (local project)', () => {
  it('imports into a mode: local project via requireProjectDir (no git needed)', async () => {
    const workspace = await tmp('ovl-asset-localws-');
    const userDir = await tmp('ovl-asset-userdir-');
    await mkdir(path.join(userDir, 'figures'), { recursive: true });
    await writeFile(path.join(userDir, 'main.tex'), '\\documentclass{article}\n');

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
      arguments: { project: 'paper', path: userDir },
    });

    const src = await tmp('ovl-asset-src-');
    const srcFile = path.join(src, 'plot.png');
    await writeFile(srcFile, PNG);

    const res = await client.callTool({
      name: 'add_asset',
      arguments: { project: 'paper', path: 'figures/plot.png', sourcePath: srcFile },
    });
    expect(isError(res)).toBe(false);
    const sc = structured(res);
    // requireProjectDir (not requireGitProject) is what let this succeed for a mode: 'local'
    // project with no .git at all — prove the write actually happened and matches.
    expect(sc.created).toBe(true);
    expect(sc.bytesWritten).toBe(PNG.length);

    const onDisk = await readFile(path.join(userDir, 'figures', 'plot.png'));
    expect(Buffer.compare(onDisk, PNG)).toBe(0);
  });
});

describe('add_asset result shape', () => {
  it('never includes a diff field, and the headline reports source/bytes/sha256', async () => {
    const { client } = await setupGitProject();
    const src = await tmp('ovl-asset-src-');
    const srcFile = path.join(src, 'plot.png');
    await writeFile(srcFile, PNG);

    const res = await client.callTool({
      name: 'add_asset',
      arguments: { project: 'demo', path: 'figures/plot.png', sourcePath: srcFile },
    });
    expect(isError(res)).toBe(false);

    const sc = structured(res);
    expect(sc).not.toHaveProperty('diff');
    expect(sc.source).toBe(srcFile);
    expect(sc.bytesWritten).toBe(PNG.length);
    expect(typeof sc.sha256).toBe('string');
    expect((sc.sha256 as string).length).toBe(64);

    const text = textOf(res);
    expect(text).not.toContain('"diff"');
    expect(text).toContain(srcFile);
    expect(text).toContain(String(PNG.length));
    expect(text).toContain((sc.sha256 as string).slice(0, 12));
  });
});

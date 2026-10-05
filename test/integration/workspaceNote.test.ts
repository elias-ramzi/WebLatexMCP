import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry, registryPath } from '../../src/services/projectRegistry.js';
import { toPosix } from '../../src/lib/paths.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * The workspace is set once, at startup (in the Desktop extension, by its settings form), so the
 * tools a user meets first say where it is and how to move it — and an empty project list names
 * projects registered in the server's fallback workspace, which a Desktop extension that ran
 * there before its form got a default would otherwise read as lost.
 */
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function connect(config: ServerConfig): Promise<Client> {
  const ctx = createContext(
    config,
    new CredentialResolver({}),
    { name: 'Test', email: 'test@example.com' },
    new ProjectRegistry(config.workspaceRoot),
  );
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return client;
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

async function writeRegistry(root: string, entries: Record<string, unknown>): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(registryPath(root), JSON.stringify(entries));
}

describe('list_projects on an empty workspace', () => {
  it('names the projects registered in the fallback workspace', async () => {
    const workspace = await tempDir('wln-ws-');
    const fallback = await tempDir('wln-fallback-');
    await writeRegistry(fallback, {
      thesis: { gitUrl: 'https://git.example/thesis' },
      cv: { gitUrl: 'https://git.example/cv' },
      // Unusable entries are not counted: the server would not load them either.
      '../escape': { gitUrl: 'https://git.example/x' },
      broken: { nonsense: true },
    });
    const client = await connect({
      workspaceRoot: workspace,
      fallbackWorkspaceRoot: fallback,
      sessionId: 'test',
      projects: [],
    });

    const text = textOf(await client.callTool({ name: 'list_projects', arguments: {} }));
    expect(text).toContain('No projects registered yet');
    expect(text).toContain(`2 projects are registered in "${toPosix(fallback)}"`);
    expect(text).toContain('Settings → Extensions → WebLatexMCP → Clone workspace folder');
    // The folder actually in use is named too: this is the case where the caller most needs it.
    expect(text).toContain(`Workspace (clones and the project list): "${toPosix(workspace)}"`);
    // Neutral wording: in workspace-local mode a separate project list is by design, not a loss.
    expect(text).toContain('To use them, point');
    expect(text).not.toContain('get them back');
  });

  it('says where the workspace is when the fallback holds nothing', async () => {
    const workspace = await tempDir('wln-ws-');
    const fallback = await tempDir('wln-fallback-'); // no registry.json at all
    const client = await connect({
      workspaceRoot: workspace,
      fallbackWorkspaceRoot: fallback,
      sessionId: 'test',
      projects: [],
    });

    const text = textOf(await client.callTool({ name: 'list_projects', arguments: {} }));
    expect(text).not.toContain(toPosix(fallback));
    expect(text).toContain(`Workspace (clones and the project list): "${toPosix(workspace)}"`);
    expect(text).toContain('the new folder starts with an empty project list');
  });

  it('never reads a fallback when the server is using it', async () => {
    const workspace = await tempDir('wln-ws-');
    const client = await connect({ workspaceRoot: workspace, sessionId: 'test', projects: [] });

    const text = textOf(await client.callTool({ name: 'list_projects', arguments: {} }));
    expect(text).toContain(`Workspace (clones and the project list): "${toPosix(workspace)}"`);
    expect(text).not.toMatch(/registered in .* a workspace this server is not using/);
  });
});

describe('register_project', () => {
  it('says where the workspace is and how to move it', async () => {
    const workspace = await tempDir('wln-ws-');
    const client = await connect({ workspaceRoot: workspace, sessionId: 'test', projects: [] });

    const res = await client.callTool({
      name: 'register_project',
      arguments: { project: 'thesis', gitUrl: 'https://git.example/thesis', clone: false },
    });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain(`Workspace (clones and the project list): "${toPosix(workspace)}"`);
    expect(text).toContain('WEB_LATEX_MCP_WORKSPACE');
  });
});

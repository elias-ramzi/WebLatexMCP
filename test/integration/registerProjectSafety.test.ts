import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry, registryPath } from '../../src/services/projectRegistry.js';
import type { ProjectConfig, ServerConfig } from '../../src/types.js';

/**
 * `register_project` end to end: a traversal id is refused before anything touches the disk, and
 * a token pasted inside an https git URL is neither persisted to registry.json nor echoed back.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(
  projects: ProjectConfig[] = [],
): Promise<{ client: Client; root: string; workspace: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ovl-regsafe-int-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'ws');
  await mkdir(workspace);
  const config: ServerConfig = { workspaceRoot: workspace, sessionId: 'test', projects };
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
  return { client, root, workspace };
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

describe('register_project safety', () => {
  it('refuses a traversal id and creates nothing outside the workspace', async () => {
    const { client, root } = await setup();
    const res = await client.callTool({
      name: 'register_project',
      arguments: { project: '../escaped', gitUrl: 'https://git.example/x', clone: false },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/project id/i);
    expect(await readdir(root)).toEqual(['ws']);
  });

  it('strips a token from an https gitUrl before persisting or echoing it, and says so', async () => {
    const { client, workspace } = await setup();
    const res = await client.callTool({
      name: 'register_project',
      arguments: {
        project: 'paper',
        gitUrl: 'https://x-access-token:ghp_SECRET123@github.com/me/paper.git',
        clone: false,
      },
    });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).not.toContain('ghp_SECRET123');
    // The login name is kept (credential helpers look up by host + username); the token is not.
    expect(text).toContain('https://x-access-token@github.com/me/paper.git');
    expect(text).toMatch(/not stored/i);
    expect(text).toMatch(/username was kept/i);
    expect(text).toMatch(/tokenEnv|set_credential/);
    const onDisk = await readFile(registryPath(workspace), 'utf8');
    expect(onDisk).not.toContain('ghp_SECRET123');
    expect(JSON.parse(onDisk).paper.gitUrl).toBe('https://x-access-token@github.com/me/paper.git');

    const listed = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(JSON.stringify(listed)).not.toContain('ghp_SECRET123');
  });

  it('list_projects redacts a token in an env-configured gitUrl', async () => {
    const { client } = await setup([
      { id: 'envp', gitUrl: 'https://bob:glpat-SECRET456@gitlab.com/me/envp.git' },
    ]);
    const listed = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(JSON.stringify(listed)).not.toContain('glpat-SECRET456');
    const sc = listed.structuredContent as { projects: Array<{ gitUrl?: string }> };
    expect(sc.projects[0]!.gitUrl).toBe('https://bob:***@gitlab.com/me/envp.git');
  });

  it('refuses a second project id for a local directory that is already registered', async () => {
    const { client, root } = await setup();
    const dir = path.join(root, 'draft');
    await mkdir(dir);
    const first = await client.callTool({
      name: 'register_project',
      arguments: { project: 'a', path: dir },
    });
    expect(first.isError).toBeFalsy();
    const second = await client.callTool({
      name: 'register_project',
      arguments: { project: 'b', path: dir, followSymlinks: true },
    });
    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain('"a"');
  });
});

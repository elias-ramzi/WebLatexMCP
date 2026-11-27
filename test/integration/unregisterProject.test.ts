import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry, registryPath } from '../../src/services/projectRegistry.js';
import { expectNoUndeclaredKeys } from '../helpers/outputSchema.js';
import type { ProjectConfig, ServerConfig } from '../../src/types.js';

/**
 * `unregister_project` forgets a registration and deletes nothing; a peer session (here: a second
 * context on the same workspace, started from the same snapshot) stops listing it too.
 */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function connect(workspace: string, extra: Partial<ServerConfig> = {}): Promise<Client> {
  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: `s${cleanups.length}`,
    projects: new ProjectRegistry(workspace).read(),
    envProjectIds: [], // as `loadConfig` says: every startup project came from the registry
    ...extra,
  };
  const ctx = createContext(
    config,
    new CredentialResolver({}),
    { name: 'Test', email: 'test@example.com' },
    new ProjectRegistry(workspace),
  );
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(b), client.connect(a)]);
  cleanups.push(() => client.close());
  return client;
}

async function workspaceWith(...projects: ProjectConfig[]): Promise<string> {
  const ws = await mkdtemp(path.join(os.tmpdir(), 'wlm-unreg-'));
  cleanups.push(() => rm(ws, { recursive: true, force: true }));
  const reg = new ProjectRegistry(ws);
  for (const p of projects) await reg.upsert(p, { makeDefault: p.id === 'gone' });
  return ws;
}

const listed = async (c: Client): Promise<string[]> => {
  const r = await c.callTool({ name: 'list_projects', arguments: {} });
  const rows = (r.structuredContent as { projects: Array<{ project: string }> }).projects;
  return rows.map((p) => p.project).sort();
};

describe('unregister_project', () => {
  it('forgets the entry, keeps every file, and peers stop listing it', async () => {
    const ws = await workspaceWith(
      { id: 'gone', gitUrl: 'https://example.com/gone.git' },
      { id: 'kept', gitUrl: 'https://example.com/kept.git' },
    );
    const clone = path.join(ws, 'gone');
    await mkdir(path.join(clone, '.git'), { recursive: true });
    await writeFile(path.join(clone, 'main.tex'), 'x');
    const peer = await connect(ws);
    const me = await connect(ws);
    expect(await listed(peer)).toEqual(['gone', 'kept']);

    const r = await me.callTool({ name: 'unregister_project', arguments: { project: 'gone' } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ project: 'gone', mode: 'git', wasDefault: true });
    await expectNoUndeclaredKeys(me, 'unregister_project', r.structuredContent);

    const file = JSON.parse(await readFile(registryPath(ws), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(file)).toEqual(['kept']);
    expect((await stat(path.join(clone, 'main.tex'))).isFile()).toBe(true);
    expect(await listed(me)).toEqual(['kept']);
    expect(await listed(peer)).toEqual(['kept']);

    // Registering the same id again adopts the clone left in place.
    const back = await me.callTool({
      name: 'register_project',
      arguments: { project: 'gone', gitUrl: 'https://example.com/gone.git', clone: false },
    });
    expect(back.isError).toBeFalsy();
    expect(await listed(peer)).toEqual(['gone', 'kept']);
  });

  it('refuses an unknown id and an env-configured one, changing nothing', async () => {
    const ws = await workspaceWith({ id: 'kept', gitUrl: 'https://example.com/kept.git' });
    const env: ProjectConfig = { id: 'fromenv', gitUrl: 'https://example.com/env.git' };
    const c = await connect(ws, {
      projects: [env, ...new ProjectRegistry(ws).read()],
      envProjectIds: ['fromenv'],
    });
    const unknown = await c.callTool({
      name: 'unregister_project',
      arguments: { project: 'nope' },
    });
    expect(unknown.isError).toBe(true);
    const fromEnv = await c.callTool({
      name: 'unregister_project',
      arguments: { project: 'fromenv' },
    });
    expect(fromEnv.isError).toBe(true);
    expect(JSON.stringify(fromEnv.content)).toContain('WEB_LATEX_MCP_PROJECTS');
    expect(await listed(c)).toEqual(['fromenv', 'kept']);
  });
});

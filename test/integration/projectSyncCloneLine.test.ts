import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFakeRemote } from './helpers/bareRepo.js';
import { createContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import type { ProjectConfig, ServerConfig } from '../../src/types.js';

/**
 * A user pasted Overleaf's whole clone command as the gitUrl. `project_sync { gitUrl }` now reads
 * the URL out of the line and clones; an entry that already holds such a line fails fast with the
 * re-registration that fixes it. Local bare repo, no network.
 */

const IDENTITY = { name: 'Test', email: 'test@example.com' };

describe('project_sync with a `git clone` command line as gitUrl', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function connect(
    projects: ProjectConfig[],
  ): Promise<{ client: Client; workspace: string }> {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-cloneline-'));
    cleanups.push(() => rm(workspace, { recursive: true, force: true }));
    const config: ServerConfig = { workspaceRoot: workspace, projects, sessionId: 's' };
    const ctx = createContext(config, new CredentialResolver({}), IDENTITY);
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    return { client, workspace };
  }

  const textOf = (res: Record<string, unknown>): string =>
    ((res.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');

  it('registers and clones the URL inside the line, saying the prefix was removed', async () => {
    const remote = await createFakeRemote();
    cleanups.push(remote.cleanup);
    const { client, workspace } = await connect([]);

    const res = await client.callTool({
      name: 'project_sync',
      arguments: { project: 'paper', gitUrl: `git clone ${remote.url} some-dir` },
    });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect((res.structuredContent as { action: string }).action).toBe('cloned');
    expect(textOf(res)).toMatch(/`git clone` prefix was removed/);
    expect(textOf(res)).toContain('"some-dir" was ignored');
    // Cloned under the project id, not the line's directory argument.
    await stat(path.join(workspace, 'paper', 'main.tex'));
    expect(await readFile(path.join(workspace, 'paper', 'main.tex'), 'utf8')).toContain('Hello');

    // And a later plain sync works against what was registered.
    const again = await client.callTool({ name: 'project_sync', arguments: { project: 'paper' } });
    expect(again.isError, textOf(again)).toBeFalsy();
    expect((again.structuredContent as { action: string }).action).toBe('up-to-date');
  });

  it('refuses a line with options before registering anything', async () => {
    const remote = await createFakeRemote();
    cleanups.push(remote.cleanup);
    const { client, workspace } = await connect([]);
    const res = await client.callTool({
      name: 'project_sync',
      arguments: { project: 'paper', gitUrl: `git clone -b master ${remote.url}` },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Pass just the repository URL/);
    await expect(stat(path.join(workspace, 'paper'))).rejects.toThrow();
  });

  it('fails fast on an entry that already holds a `git clone` line', async () => {
    const remote = await createFakeRemote();
    cleanups.push(remote.cleanup);
    const { client, workspace } = await connect([
      { id: 'paper', gitUrl: `git clone ${remote.url}` },
    ]);
    const res = await client.callTool({ name: 'project_sync', arguments: { project: 'paper' } });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/is a `git clone` command line/);
    expect(text).toContain(`gitUrl: ${JSON.stringify(remote.url)}`);
    expect(text).not.toMatch(/protocol .* is not supported/);
    await expect(stat(path.join(workspace, 'paper'))).rejects.toThrow();

    const push = await client.callTool({
      name: 'push',
      arguments: { project: 'paper', confirm: true },
    });
    expect(push.isError).toBe(true);
    expect(textOf(push)).toMatch(/is a `git clone` command line/);
  });
});

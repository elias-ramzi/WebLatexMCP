import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFakeRemote } from './helpers/bareRepo.js';
import { createContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * A project file whose name is an `Object.prototype` member is still an ordinary file: the session
 * that wrote it owns it, and the default (session-scoped) `commit` stages it through
 * `commitContents`. The shadow index is keyed by path, and before it became a null-prototype map a
 * `constructor` or `__proto__` edit was recorded into nothing, so the session commit found nothing
 * of it to stage.
 */
const IDENTITY = { name: 'Test', email: 'test@example.com' };

describe('session commit of files named like Object.prototype members', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  // `constructor` pre-fix: the edit was recorded into nothing, so the session owned no change and
  // `commit` fell back to scope "all". `__proto__` pre-fix: `record` stamped its bookkeeping onto
  // Object.prototype itself, which wedged the server process (the call never returned).
  it.each(['constructor', '__proto__'])(
    'commits a file named %s written through write_file',
    async (name) => {
      const remote = await createFakeRemote({ 'main.tex': 'hello\n' });
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-proto-'));
      cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));
      const dir = path.join(workspace, 'demo');
      await new GitService(IDENTITY).clone(remote.url, dir, { username: 'git' });

      const config: ServerConfig = {
        workspaceRoot: workspace,
        projects: [{ id: 'demo', gitUrl: remote.url }],
        defaultProject: 'demo',
        sessionId: 's1',
      };
      const ctx = createContext(config, new CredentialResolver({}), IDENTITY);
      const server = createServer(ctx);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test', version: '0.0.0' });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      cleanups.push(() => client.close());

      const call = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
        const res = await client.callTool({ name: tool, arguments: args });
        if (res.isError) throw new Error(`${tool} failed: ${JSON.stringify(res.content)}`);
        return res.structuredContent;
      };

      try {
        await call('write_file', { path: name, content: 'x\n' });
        const result = (await call('commit', { message: 'proto-named files' })) as {
          committed: boolean;
          scope: string;
        };
        expect(result.committed).toBe(true);
        expect(result.scope).toBe('session');

        const tree = await simpleGit(dir).raw(['ls-tree', '--name-only', 'HEAD']);
        expect(tree.split('\n').filter(Boolean).sort()).toEqual([name, 'main.tex'].sort());
        expect(await simpleGit(dir).raw(['show', `HEAD:${name}`])).toBe('x\n');
      } finally {
        // A regression pollutes the shared prototype (see the unit test); keep it out of the worker.
        for (const k of [
          'touchedAt',
          'binary',
          'deleted',
          'baseExists',
          'conflicted',
          'incomplete',
        ]) {
          delete (Object.prototype as Record<string, unknown>)[k];
          delete (Object as unknown as Record<string, unknown>)[k];
        }
      }
    },
  );
});

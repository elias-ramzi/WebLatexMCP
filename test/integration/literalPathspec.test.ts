import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext, type AppContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * A pathspec is a glob by default, so `git add -- 'a[1].tex'` also stages `a1.tex`. Scope "paths"
 * checks peer ownership against the literal names the caller gave, which is exactly the gap: a
 * peer's dirty `a1.tex` rode into a commit that named only `a[1].tex`. `GitService.commit` now
 * passes `--literal-pathspecs`. `[` is not a legal filename character on Windows, hence the skip.
 */
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function structured(res: unknown): Record<string, unknown> {
  return (res as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

async function setup(
  seed: Record<string, string>,
): Promise<{ client: Client; ctx: AppContext; remote: FakeRemote; clone: string }> {
  const remote = await createFakeRemote(seed);
  cleanups.push(remote.cleanup);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-literal-ws-'));
  cleanups.push(() => rm(workspace, { recursive: true, force: true, maxRetries: 10 }));
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
  return { client, ctx, remote, clone: ctx.projectManager.projectPath('demo') };
}

describe.skipIf(process.platform === 'win32')(
  'scope "paths" stages literal names, not globs',
  () => {
    it('naming a[1].tex does not sweep up a dirty a1.tex', async () => {
      const { client, clone } = await setup({ 'a1.tex': 'one\n', 'a[1].tex': 'bracket\n' });
      // Both dirty, outside the server (nobody's shadow), as scope "paths" exists for.
      await writeFile(path.join(clone, 'a1.tex'), 'one changed\n', 'utf8');
      await writeFile(path.join(clone, 'a[1].tex'), 'bracket changed\n', 'utf8');

      const res = await client.callTool({
        name: 'commit',
        arguments: {
          project: 'demo',
          message: 'only the bracket file',
          scope: 'paths',
          paths: ['a[1].tex'],
        },
      });
      const sc = structured(res);
      expect(sc.committed).toBe(true);
      const files = (sc.files as Array<{ path: string }>).map((f) => f.path);
      // Pre-fix: ['a1.tex', 'a[1].tex'] — the glob matched both.
      expect(files).toEqual(['a[1].tex']);
      expect(sc.leftUncommitted).toEqual(['a1.tex']);
    });
  },
);

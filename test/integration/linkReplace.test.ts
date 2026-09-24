import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext, type AppContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * A session that removes a tracked link and writes a REGULAR FILE at the same path
 * (`delete_file link.tex` then `write_file link.tex`) must be able to commit that — see PR #67
 * review finding A.
 *
 * `commitContents` reads the index mode right after resetting the index to HEAD, so it sees
 * 120000 (what HEAD has) regardless of what is on disk now. Pre-fix it refused ANY 120000 index
 * mode outright with "a content commit cannot replace a link with file content. Delete the link
 * first (delete_file), or commit the working tree with scope 'all'." — even though the caller had
 * just done exactly that (delete_file, then write_file) and the working tree already holds a
 * regular file. That refusal message is circular for this session's own default-scope commit.
 * The fix judges the WORKING TREE, not just the index: a 120000 index entry whose working-tree
 * path is no longer a symlink is an ordinary link-to-file typechange (mode 100644), the same one
 * `git add` would record; a 120000 index entry that is STILL a symlink on disk stays refused
 * (that is a stale shadow record, not this case).
 */

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

/**
 * `createFakeRemote`'s seeding writes plain files only, so a tracked symlink has to be committed
 * and pushed through a second, throwaway clone — the real route a collaborator's commit would
 * take (git stores a symlink as mode 120000). Mirrors `linkCommit.test.ts`'s `pushSymlink`
 * (not imported from there — that file is off-limits to edit and this keeps the two independent).
 */
async function pushSymlink(
  remote: FakeRemote,
  linkName: string,
  linkTarget: string,
): Promise<void> {
  const dir = await tmp('ovl-linkreplace-seed-');
  const git = simpleGit(dir);
  await git.clone(remote.url, dir);
  await git.addConfig('user.email', 'seed@example.com');
  await git.addConfig('user.name', 'Seed');
  await git.addConfig('core.autocrlf', 'false');
  await symlink(linkTarget, path.join(dir, linkName));
  await git.add(linkName);
  await git.commit(`add symlink ${linkName} -> ${linkTarget}`);
  await git.push('origin', remote.branch);
}

async function setup(
  remote: FakeRemote,
): Promise<{ client: Client; ctx: AppContext; clone: string; workspace: string }> {
  const workspace = await tmp('ovl-linkreplace-ws-');
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
  return { client, ctx, clone: path.join(workspace, 'demo'), workspace };
}

async function lsTreeMode(dir: string, rel: string): Promise<string | null> {
  const out = await simpleGit(dir).raw(['ls-tree', 'HEAD', '--', rel]);
  const line = out.trim();
  return line ? (line.split(/\s+/)[0] ?? null) : null;
}

async function blobAt(dir: string, rel: string): Promise<string> {
  return simpleGit(dir).raw(['show', `HEAD:${rel}`]);
}

describe.skipIf(process.platform === 'win32')(
  'replacing a tracked link with a regular file',
  () => {
    it('delete_file then write_file at the same path commits as a plain file, not a refused link', async () => {
      const remote = await createFakeRemote({
        'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      });
      cleanups.push(remote.cleanup);
      await pushSymlink(remote, 'link.tex', 'main.tex');

      const { client, clone } = await setup(remote);

      const deleted = await client.callTool({
        name: 'delete_file',
        arguments: { project: 'demo', path: 'link.tex' },
      });
      expect(isError(deleted), textOf(deleted)).toBe(false);

      const wrote = await client.callTool({
        name: 'write_file',
        arguments: { project: 'demo', path: 'link.tex', content: 'Now a real file.\n' },
      });
      expect(isError(wrote), textOf(wrote)).toBe(false);

      const committed = await client.callTool({
        name: 'commit',
        arguments: { project: 'demo', message: 'replace the link with a real file' },
      });
      // Pre-fix: refuses with `"link.tex" is a symbolic link in the index; a content commit cannot
      // replace a link with file content. Delete the link first (delete_file), ...` — which is
      // exactly what this session just did.
      expect(isError(committed), textOf(committed)).toBe(false);
      const result = structured(committed);
      expect(result.committed).toBe(true);
      const files = (result.files as Array<{ path: string }>).map((f) => f.path);
      expect(files).toContain('link.tex');

      expect(await lsTreeMode(clone, 'link.tex')).toBe('100644');
      expect(await blobAt(clone, 'link.tex')).toBe('Now a real file.\n');
      // The target the link used to point at is untouched.
      expect(await blobAt(clone, 'main.tex')).toBe(
        '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      );
    });
  },
);

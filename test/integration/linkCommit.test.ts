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
 * A write through a TRACKED in-project symlink must be attributed to the link's target, and
 * `commitContents` must refuse to replace a mode-120000 index entry with text content — see
 * issue #66 item 4 and CLAUDE.md's "Parallel sessions share a clone; commits don't" bullet.
 *
 * Pre-fix, `write_file link.tex` changed `main.tex` on disk but recorded the shadow entry under
 * `link.tex`, whose HEAD base is the blob `"main.tex"` (the link target string): `commit` then
 * three-way-merges that against the caller's text and refuses with a bogus "this session and
 * someone else changed the same lines of link.tex" conflict.
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
 * take (git stores a symlink as mode 120000).
 */
async function pushSymlink(
  remote: FakeRemote,
  linkName: string,
  linkTarget: string,
): Promise<void> {
  const dir = await tmp('ovl-linkseed-');
  const git = simpleGit(dir);
  await git.clone(remote.url, dir);
  await git.addConfig('user.email', 'seed2@example.com');
  await git.addConfig('user.name', 'Seed2');
  await git.addConfig('core.autocrlf', 'false');
  await symlink(linkTarget, path.join(dir, linkName));
  await git.add(linkName);
  await git.commit(`add symlink ${linkName} -> ${linkTarget}`);
  await git.push('origin', remote.branch);
}

async function setup(
  remote: FakeRemote,
): Promise<{ client: Client; ctx: AppContext; clone: string; workspace: string }> {
  const workspace = await tmp('ovl-linkcommit-ws-');
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

describe.skipIf(process.platform === 'win32')('commit through an in-project symlink', () => {
  it('a tracked, non-dangling link: write_file + commit lands content on the target, link stays 120000', async () => {
    const remote = await createFakeRemote({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });
    cleanups.push(remote.cleanup);
    await pushSymlink(remote, 'link.tex', 'main.tex');

    const { client, clone } = await setup(remote);

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'link.tex', content: 'Edited through the link.\n' },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);

    const committed = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'edit via link' },
    });
    // Pre-fix: refuses with "this session and someone else changed the same lines of link.tex".
    expect(isError(committed), textOf(committed)).toBe(false);
    const result = structured(committed);
    expect(result.committed).toBe(true);
    expect(result.conflicted).toEqual([]);
    const files = (result.files as Array<{ path: string }>).map((f) => f.path);
    expect(files).toContain('main.tex');
    expect(files).not.toContain('link.tex');

    expect(await lsTreeMode(clone, 'link.tex')).toBe('120000');
    expect(await lsTreeMode(clone, 'main.tex')).toBe('100644');
    expect(await blobAt(clone, 'main.tex')).toBe('Edited through the link.\n');
  });

  it('the confirmation diff of a write through a link shows the target, not the unchanged link', async () => {
    const remote = await createFakeRemote({ 'main.tex': 'Hello\n' });
    cleanups.push(remote.cleanup);
    await pushSymlink(remote, 'link.tex', 'main.tex');
    const { client } = await setup(remote);

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'link.tex', content: 'Changed\n' },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);
    // Pre-fix: `changeDiff` diffed `link.tex`, which git sees as unchanged — an empty diff for a
    // write that changed main.tex.
    const diff = String(structured(wrote).diff ?? '');
    expect(diff).toContain('main.tex');
    expect(diff).toContain('+Changed');

    const edited = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'demo',
        path: 'link.tex',
        edits: [{ oldString: 'Changed', newString: 'Edited' }],
      },
    });
    expect(isError(edited), textOf(edited)).toBe(false);
    expect(String(structured(edited).diff ?? '')).toContain('+Edited');
  });

  it('a tracked, DANGLING link: write_file + commit creates the target, link keeps pointing to it', async () => {
    const remote = await createFakeRemote({
      'main.tex': '\\documentclass{article}\n',
    });
    cleanups.push(remote.cleanup);
    await pushSymlink(remote, 'link.tex', 'missing.tex');

    const { client, clone } = await setup(remote);

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'link.tex', content: 'New content.\n' },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);

    const committed = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'edit via dangling link' },
    });
    expect(isError(committed), textOf(committed)).toBe(false);
    const result = structured(committed);
    expect(result.committed).toBe(true);
    const files = (result.files as Array<{ path: string }>).map((f) => f.path);
    expect(files).toContain('missing.tex');
    expect(files).not.toContain('link.tex');

    expect(await lsTreeMode(clone, 'missing.tex')).toBe('100644');
    expect(await lsTreeMode(clone, 'link.tex')).toBe('120000');
    // The link's own blob is still just its target string, never the text that was written.
    expect((await blobAt(clone, 'link.tex')).trim()).toBe('missing.tex');
    expect(await blobAt(clone, 'missing.tex')).toBe('New content.\n');
  });

  it('commitContents refuses to put content into a 120000 index entry, but still commits its deletion', async () => {
    const remote = await createFakeRemote({
      'main.tex': '\\documentclass{article}\n',
    });
    cleanups.push(remote.cleanup);
    await pushSymlink(remote, 'link.tex', 'main.tex');

    const { ctx, clone } = await setup(remote);
    const before = (await simpleGit(clone).revparse(['HEAD'])).trim();

    await expect(
      ctx.git.commitContents(clone, {
        message: 'attempt to overwrite the link with text',
        files: [{ path: 'link.tex', content: 'x' }],
      }),
    ).rejects.toThrow(/symbolic link in the index/);
    expect((await simpleGit(clone).revparse(['HEAD'])).trim()).toBe(before);

    // A null content (deletion) of the link stays allowed — only replacing it with text is refused.
    const res = await ctx.git.commitContents(clone, {
      message: 'delete the link',
      files: [{ path: 'link.tex', content: null }],
    });
    expect(res.committed).toBe(true);
    expect(await lsTreeMode(clone, 'link.tex')).toBeNull();
  });
});

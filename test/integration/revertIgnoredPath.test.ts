import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, readFile, writeFile, appendFile } from 'node:fs/promises';
import { simpleGit, type SimpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { GitService } from '../../src/services/gitService.js';
import { createFakeRemote } from './helpers/bareRepo.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * `git revert` treats an IGNORED file as expendable: when the revert restores a path HEAD does
 * not track, an ignored file sitting there (or at one of its ancestors, as a file where the
 * revert needs a directory) is silently overwritten — unlike an ordinary untracked file, which
 * git refuses to clobber. `status --porcelain` never lists an ignored file, so the preflight's
 * dirty check read the path as clean and the user's local, deliberately-excluded note was
 * replaced by the old committed bytes. The preflight now treats any touched path absent from
 * HEAD that exists on disk (or has a non-directory ancestor on disk that HEAD does not track)
 * as dirty.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

/** A clone with `notes.md` committed and then deleted; returns the deleting commit. */
async function repoWithDeletedNote(
  files: Record<string, string>,
  deleted: string,
): Promise<{ dir: string; git: SimpleGit; delSha: string }> {
  const dir = await tmp('ovl-revign-');
  const git = simpleGit(dir, {
    config: ['user.email=t@example.com', 'user.name=T', 'core.autocrlf=false'],
  });
  await git.raw(['init', '-q', '-b', 'master']);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  await git.add('.');
  await git.commit('initial');
  await git.raw(['rm', '-r', '-q', '--', deleted]);
  await git.commit(`delete ${deleted}`);
  const delSha = (await git.revparse(['HEAD'])).trim();
  return { dir, git, delSha };
}

describe('revert preflight: an ignored file in the way is dirty', () => {
  it('flags an ignored, untracked file at a path the revert restores', async () => {
    const { dir, delSha } = await repoWithDeletedNote(
      { 'notes.md': 'COMMITTED NOTES\n', 'main.tex': 'x\n' },
      'notes.md',
    );
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), 'notes.md\n');
    await writeFile(path.join(dir, 'notes.md'), 'MY PRIVATE LOCAL NOTES\n');

    const pre = await new GitService().revertPreflight(dir, [delSha]);

    expect(pre.touchedPaths).toEqual(['notes.md']);
    expect(pre.dirtyPaths).toEqual(['notes.md']);
    // Told apart from an ordinary uncommitted change: git would NOT refuse this one.
    expect(pre.inTheWayPaths).toEqual(['notes.md']);
  });

  it('keeps an ordinary uncommitted change out of inTheWayPaths', async () => {
    const { dir, delSha } = await repoWithDeletedNote(
      { 'notes.md': 'COMMITTED NOTES\n', 'main.tex': 'x\n' },
      'notes.md',
    );
    // Untracked but NOT ignored: `status` lists it, and git itself refuses to overwrite it.
    await writeFile(path.join(dir, 'notes.md'), 'UNTRACKED\n');

    const pre = await new GitService().revertPreflight(dir, [delSha]);

    expect(pre.dirtyPaths).toEqual(['notes.md']);
    expect(pre.inTheWayPaths).toEqual([]);
  });

  it('flags a touched path whose ancestor is an ignored FILE the revert would replace with a directory', async () => {
    const { dir, delSha } = await repoWithDeletedNote(
      { 'notes/a.md': 'A\n', 'main.tex': 'x\n' },
      'notes',
    );
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), 'notes\n');
    await writeFile(path.join(dir, 'notes'), 'PRIVATE\n');

    const pre = await new GitService().revertPreflight(dir, [delSha]);

    expect(pre.dirtyPaths).toEqual(['notes/a.md']);
  });

  it('still reads a restored path with nothing on disk as clean', async () => {
    const { dir, delSha } = await repoWithDeletedNote(
      { 'notes.md': 'COMMITTED NOTES\n', 'main.tex': 'x\n' },
      'notes.md',
    );
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), 'notes.md\n');

    const pre = await new GitService().revertPreflight(dir, [delSha]);

    expect(pre.dirtyPaths).toEqual([]);
  });

  it('does not flag a tracked, clean ancestor the revert itself turns back into a directory', async () => {
    // HEAD has `notes` as a FILE (the reverted commit replaced the directory with it). Reverting
    // deletes that file and restores `notes/a.md` — the file on disk is HEAD's own, not a stray.
    const dir = await tmp('ovl-revign-df-');
    const git = simpleGit(dir, {
      config: ['user.email=t@example.com', 'user.name=T', 'core.autocrlf=false'],
    });
    await git.raw(['init', '-q', '-b', 'master']);
    await mkdir(path.join(dir, 'notes'));
    await writeFile(path.join(dir, 'notes', 'a.md'), 'A\n');
    await git.add('.');
    await git.commit('dir');
    await git.raw(['rm', '-r', '-q', '--', 'notes']);
    await writeFile(path.join(dir, 'notes'), 'now a file\n');
    await git.add('.');
    await git.commit('dir to file');
    const sha = (await git.revparse(['HEAD'])).trim();

    const pre = await new GitService().revertPreflight(dir, [sha]);

    expect(pre.touchedPaths).toEqual(['notes', 'notes/a.md']);
    expect(pre.dirtyPaths).toEqual([]);
  });
});

describe('revert tool: refuses rather than overwrite an ignored note', () => {
  it('leaves the ignored file byte-identical and the tree unchanged', async () => {
    const remote = await createFakeRemote({ 'main.tex': 'x\n', 'notes.md': 'COMMITTED NOTES\n' });
    cleanups.push(remote.cleanup);
    const workspace = await tmp('ovl-revign-ws-');
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

    const clone = path.join(workspace, 'demo');
    const git = simpleGit(clone, {
      config: ['user.email=t@example.com', 'user.name=T', 'core.autocrlf=false'],
    });
    await git.raw(['rm', '-q', '--', 'notes.md']);
    await git.commit('delete notes');
    const delSha = (await git.revparse(['HEAD'])).trim();
    await appendFile(path.join(clone, '.git', 'info', 'exclude'), 'notes.md\n');
    await writeFile(path.join(clone, 'notes.md'), 'MY PRIVATE LOCAL NOTES\n');

    const res = await client.callTool({
      name: 'revert',
      arguments: { project: 'demo', commits: [delSha], confirm: true },
    });

    expect((res as { isError?: boolean }).isError).toBe(true);
    const text = ((res as { content?: Array<{ text?: string }> }).content ?? [])
      .map((c) => c.text ?? '')
      .join('\n');
    expect(text).toContain('notes.md');
    // The refusal says what is actually true of an ignored file: git would overwrite it (so "git
    // itself refuses" is wrong) and `discard`'s clean skips ignored files (so "discard" is no way
    // out) — it has to be moved or deleted by hand.
    expect(text).toMatch(/not in HEAD/);
    expect(text).toMatch(/Move or delete it by hand/);
    expect(text).not.toMatch(/git itself refuses/);
    expect(text).not.toMatch(/discard/i);
    expect(await readFile(path.join(clone, 'notes.md'), 'utf8')).toBe('MY PRIVATE LOCAL NOTES\n');
    expect((await git.raw(['status', '--porcelain'])).trim()).toBe('');
  });
});

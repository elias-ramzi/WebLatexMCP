import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { createFakeRemote, pushCommit, type FakeRemote } from './helpers/bareRepo.js';
import { GitService } from '../../src/services/gitService.js';
import { FileService } from '../../src/services/fileService.js';
import { ProjectManager } from '../../src/services/projectManager.js';
import type { ServerConfig } from '../../src/types.js';

describe('read-only git flow against a bare-repo stand-in', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(files?: Record<string, string>): Promise<{
    remote: FakeRemote;
    pm: ProjectManager;
    git: GitService;
    files: FileService;
    dir: string;
  }> {
    const remote = await createFakeRemote(files);
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-ws-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));
    const config: ServerConfig = {
      workspaceRoot: workspace,
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
    };
    const pm = new ProjectManager(config);
    const git = new GitService({ username: 'git' }); // no token for file://
    return { remote, pm, git, files: new FileService(), dir: pm.projectPath('demo') };
  }

  it('clones, lists, reads, and reports a clean status', async () => {
    const { remote, pm, git, files, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n',
      'refs.bib': '@book{x, title={T}}\n',
    });

    await git.clone(remote.url, dir);
    expect(await pm.hasClone('demo')).toBe(true);

    // Token must never be persisted into .git/config.
    const persisted = await readFile(path.join(dir, '.git', 'config'), 'utf8');
    expect(persisted).not.toMatch(/@/);

    const listed = await files.list(dir, { filter: 'all' });
    expect(listed.map((f) => f.path).sort()).toEqual(['main.tex', 'refs.bib']);
    expect((await files.list(dir, { filter: 'tex' })).map((f) => f.path)).toEqual(['main.tex']);

    const read = await files.read(dir, { path: 'main.tex' });
    expect(read.content).toContain('documentclass');

    const status = await git.status(dir);
    expect(status.clean).toBe(true);
    expect(status.behind).toBe(0);
  });

  it('fast-forwards on pull and surfaces divergence without merging', async () => {
    const { remote, git, dir } = await setup();
    await git.clone(remote.url, dir);

    // Remote-only change -> clean fast-forward.
    await pushCommit(remote, { 'extra.tex': 'x\n' }, 'remote change');
    const pulled = await git.syncPull(remote.url, dir);
    expect(pulled.action).toBe('pulled');
    expect(pulled.behind).toBe(0);
    expect(await readFile(path.join(dir, 'extra.tex'), 'utf8')).toBe('x\n');

    // Local commit AND remote commit -> divergence, no merge.
    await writeFile(path.join(dir, 'local.tex'), 'local\n');
    const local = simpleGit(dir);
    await local.addConfig('user.email', 'me@example.com');
    await local.addConfig('user.name', 'Me');
    await local.add('.');
    await local.commit('local change');
    await pushCommit(remote, { 'remote2.tex': 'y\n' }, 'remote change 2');

    const diverged = await git.syncPull(remote.url, dir);
    expect(diverged.action).toBe('diverged');
    expect(diverged.diverged).toBe(true);
    expect(diverged.ahead).toBeGreaterThan(0);
    expect(diverged.behind).toBeGreaterThan(0);

    // Local HEAD unchanged: still our commit, no merge commit created.
    const log = await local.log();
    expect(log.latest?.message).toBe('local change');
  });

  it('reports diff after an uncommitted edit', async () => {
    const { remote, git, dir } = await setup({ 'main.tex': 'one\ntwo\n' });
    await git.clone(remote.url, dir);
    await writeFile(path.join(dir, 'main.tex'), 'one\ntwo\nthree\n');

    const diff = await git.diff(dir, {});
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]).toMatchObject({ path: 'main.tex', added: 1, removed: 0 });
    expect(diff.diff).toContain('+three');

    const status = await git.status(dir);
    expect(status.clean).toBe(false);
    expect(status.unstaged).toContain('main.tex');
  });
});

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
      sessionId: 'test',
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
    };
    const pm = new ProjectManager(config);
    const git = new GitService(); // identity-only; auth is passed per call
    return { remote, pm, git, files: new FileService(), dir: pm.projectPath('demo') };
  }

  it('clones, lists, reads, and reports a clean status', async () => {
    const { remote, pm, git, files, dir } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n',
      'refs.bib': '@book{x, title={T}}\n',
    });

    await git.clone(remote.url, dir, { username: 'git' });
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
    await git.clone(remote.url, dir, { username: 'git' });

    // Remote-only change -> clean fast-forward.
    await pushCommit(remote, { 'extra.tex': 'x\n' }, 'remote change');
    const pulled = await git.syncPull(remote.url, dir, { username: 'git' });
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

    const diverged = await git.syncPull(remote.url, dir, { username: 'git' });
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
    await git.clone(remote.url, dir, { username: 'git' });
    await writeFile(path.join(dir, 'main.tex'), 'one\ntwo\nthree\n');

    const diff = await git.diff(dir, {});
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]).toMatchObject({ path: 'main.tex', added: 1, removed: 0 });
    expect(diff.diff).toContain('+three');

    const status = await git.status(dir);
    expect(status.clean).toBe(false);
    expect(status.unstaged).toContain('main.tex');
  });

  describe('diff against a ref', () => {
    /** Clone, then land `count` local commits each appending a line to main.tex. */
    async function withLocalCommits(count: number): Promise<{ git: GitService; dir: string }> {
      const { remote, git, dir } = await setup({ 'main.tex': 'one\n' });
      await git.clone(remote.url, dir, { username: 'git' });
      const local = simpleGit(dir);
      await local.addConfig('user.email', 'me@example.com');
      await local.addConfig('user.name', 'Me');
      let content = 'one\n';
      for (let i = 0; i < count; i++) {
        content += `line-${i}\n`;
        await writeFile(path.join(dir, 'main.tex'), content);
        await local.add('.');
        await local.commit(`local ${i}`);
      }
      return { git, dir };
    }

    it('spans commits already made, unlike the plain working-tree diff', async () => {
      const { git, dir } = await withLocalCommits(3);
      // Everything is committed, so the default diff sees nothing at all.
      expect((await git.diff(dir, {})).files).toHaveLength(0);

      const session = await git.diff(dir, { ref: 'HEAD~3' });
      expect(session.files[0]).toMatchObject({ path: 'main.tex', added: 3, removed: 0 });
      expect(session.diff).toContain('+line-0');
      expect(session.diff).toContain('+line-2');
    });

    it('includes uncommitted work on top of the ref, and honours `path`', async () => {
      const { git, dir } = await withLocalCommits(1);
      await writeFile(path.join(dir, 'main.tex'), 'one\nline-0\nuncommitted\n');
      await writeFile(path.join(dir, 'other.tex'), 'elsewhere\n');

      const all = await git.diff(dir, { ref: 'HEAD~1' });
      expect(all.diff).toContain('+line-0');
      expect(all.diff).toContain('+uncommitted');

      const scoped = await git.diff(dir, { ref: 'HEAD~1', path: 'main.tex' });
      expect(scoped.files.map((f) => f.path)).toEqual(['main.tex']);
      expect(scoped.diff).not.toContain('elsewhere');
    });

    it('diffs what the branch has that the remote does not', async () => {
      const { git, dir } = await withLocalCommits(2);
      const ahead = await git.diff(dir, { ref: `origin/master` });
      expect(ahead.files[0]).toMatchObject({ path: 'main.tex', added: 2, removed: 0 });
    });

    it('accepts a two-dot range between two commits', async () => {
      const { git, dir } = await withLocalCommits(3);
      const range = await git.diff(dir, { ref: 'HEAD~2..HEAD~1' });
      expect(range.files[0]).toMatchObject({ path: 'main.tex', added: 1, removed: 0 });
      expect(range.diff).toContain('+line-1');
      expect(range.diff).not.toContain('+line-2');
    });

    it('fails readably on an unresolvable ref, naming the bad endpoint', async () => {
      const { git, dir } = await withLocalCommits(1);
      await expect(git.diff(dir, { ref: 'no-such-branch' })).rejects.toThrow(
        /Unknown git ref "no-such-branch"/,
      );
      await expect(git.diff(dir, { ref: 'HEAD~1..nope' })).rejects.toThrow(
        /Unknown git ref "nope"/,
      );
      await expect(git.diff(dir, { ref: '--output=/tmp/pwned' })).rejects.toThrow(/Invalid ref/);
    });

    it('rejects `ref` combined with `staged` instead of preferring one', async () => {
      const { git, dir } = await withLocalCommits(1);
      await expect(git.diff(dir, { ref: 'HEAD~1', staged: true })).rejects.toThrow(
        /cannot be combined/,
      );
    });

    it('does not treat a ref that also names a file as ambiguous', async () => {
      const { git, dir } = await withLocalCommits(1);
      const local = simpleGit(dir);
      await local.raw(['branch', 'main.tex']);
      const byBranch = await git.diff(dir, { ref: 'main.tex' });
      expect(byBranch.files).toHaveLength(0);
    });
  });
});

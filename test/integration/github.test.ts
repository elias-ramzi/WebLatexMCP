import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { createFakeRemote } from './helpers/bareRepo.js';
import { GitService } from '../../src/services/gitService.js';
import { FileService } from '../../src/services/fileService.js';
import { ProjectManager } from '../../src/services/projectManager.js';
import type { ServerConfig } from '../../src/types.js';

// GitHub repos default to `main`; this proves the write-back loop is branch-agnostic
// (a `main`-branch bare repo stands in for GitHub — no network or token needed).
describe('GitHub-style main-branch full loop against a bare-repo stand-in', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('clones the default branch (main), edits, commits, and pushes', async () => {
    const remote = await createFakeRemote({ 'main.tex': 'hello\nworld\n' }, 'main');
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-gh-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));

    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: 'test',
      projects: [{ id: 'gh', gitUrl: remote.url }],
      defaultProject: 'gh',
    };
    const pm = new ProjectManager(config);
    const git = new GitService();
    const files = new FileService();
    const dir = pm.projectPath('gh');

    await git.clone(remote.url, dir, { username: 'git' });
    expect((await git.status(dir)).branch).toBe('main');

    await files.applyEdits(dir, 'main.tex', [{ oldString: 'world', newString: 'WORLD' }]);
    await git.commit(dir, { message: 'edit on main' });
    const pushed = await git.safePush(dir, remote.url, { username: 'git' });
    expect(pushed.status).toBe('pushed');
    expect(pushed.pushed).toBe(true);

    const verify = await mkdtemp(path.join(os.tmpdir(), 'ovl-gh-verify-'));
    cleanups.push(() => rm(verify, { recursive: true, force: true }));
    await simpleGit(verify).clone(remote.url, verify);
    expect(await readFile(path.join(verify, 'main.tex'), 'utf8')).toBe('hello\nWORLD\n');
  });
});

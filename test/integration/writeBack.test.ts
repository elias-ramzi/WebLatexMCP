import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import { GitService } from '../../src/services/gitService.js';
import { FileService } from '../../src/services/fileService.js';
import { ProjectManager } from '../../src/services/projectManager.js';
import type { ServerConfig } from '../../src/types.js';

describe('write-back flow (commit + push) against a bare-repo stand-in', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(files: Record<string, string>): Promise<{
    remote: FakeRemote;
    git: GitService;
    files: FileService;
    dir: string;
  }> {
    const remote = await createFakeRemote(files);
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-wb-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));
    const config: ServerConfig = {
      workspaceRoot: workspace,
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
    };
    const pm = new ProjectManager(config);
    const git = new GitService();
    const dir = pm.projectPath('demo');
    await git.clone(remote.url, dir, { username: 'git' });
    return { remote, git, files: new FileService(), dir };
  }

  it('commits an edit and pushes it to the remote', async () => {
    const { remote, git, files, dir } = await setup({ 'main.tex': 'one\ntwo\n' });

    await files.applyEdits(dir, 'main.tex', [{ oldString: 'two', newString: 'TWO' }]);
    const committed = await git.commit(dir, { message: 'edit two' });
    expect(committed.committed).toBe(true);
    expect(committed.filesChanged).toBe(1);

    const pushed = await git.safePush(dir, remote.url, { username: 'git' });
    expect(pushed.status).toBe('pushed');
    expect(pushed.pushed).toBe(true);
    expect(pushed.summary).toMatch(/Pushed 1 commit/);

    // Re-clone the remote and confirm the change actually landed there.
    const verify = await mkdtemp(path.join(os.tmpdir(), 'ovl-verify-'));
    cleanups.push(() => rm(verify, { recursive: true, force: true }));
    await simpleGit(verify).clone(remote.url, verify);
    expect(await readFile(path.join(verify, 'main.tex'), 'utf8')).toBe('one\nTWO\n');
  });

  it('throws when there is nothing to commit', async () => {
    const { git, dir } = await setup({ 'main.tex': 'x\n' });
    await expect(git.commit(dir, { message: 'noop' })).rejects.toThrow(/Nothing to commit/);
  });

  // Concurrent-edit handling (non-overlapping merge, overlapping conflict) lives in safePush.test.ts.
});

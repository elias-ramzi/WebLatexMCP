import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import { GitService } from '../../src/services/gitService.js';
import { FileService } from '../../src/services/fileService.js';
import { ProjectManager } from '../../src/services/projectManager.js';
import type { ServerConfig } from '../../src/types.js';

describe('discard + delete against a bare-repo stand-in', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(
    files: Record<string, string>,
  ): Promise<{ remote: FakeRemote; git: GitService; files: FileService; dir: string }> {
    const remote = await createFakeRemote(files);
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-dd-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));
    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: 'test',
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
    };
    const pm = new ProjectManager(config);
    const git = new GitService();
    const dir = pm.projectPath('demo');
    await git.clone(remote.url, dir, { username: 'git' });
    return { remote, git, files: new FileService(), dir };
  }

  it('discards working-tree edits and untracked files', async () => {
    const { git, files, dir } = await setup({ 'main.tex': 'orig\n' });
    await files.write(dir, { path: 'main.tex', content: 'changed\n' });
    await files.write(dir, { path: 'untracked.tex', content: 'new\n' });

    await git.discard(dir);

    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('orig\n');
    await expect(stat(path.join(dir, 'untracked.tex'))).rejects.toThrow();
    expect((await git.status(dir)).clean).toBe(true);
  });

  it('deletes a tracked file', async () => {
    const { files, dir } = await setup({ 'a.tex': 'x\n', 'b.tex': 'y\n' });
    const res = await files.delete(dir, 'a.tex');
    expect(res.path).toBe('a.tex');
    await expect(stat(path.join(dir, 'a.tex'))).rejects.toThrow();
  });
});

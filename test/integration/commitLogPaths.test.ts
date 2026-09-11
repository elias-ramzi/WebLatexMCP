import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import { GitService } from '../../src/services/gitService.js';
import { ProjectManager } from '../../src/services/projectManager.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * `logCommits` (which backs `status`'s `aheadCommits`/`behindCommits`) drives `git log --numstat`
 * without `--no-renames` or `core.quotePath=false`. `--numstat` applies rename detection by
 * default, so renaming a.tex -> b.tex logs as a single `{a.tex => b.tex}`-shaped entry instead of
 * two plain paths a caller could feed back into e.g. `read_file`; and `core.quotePath` (on by
 * default) C-quotes any non-ASCII path rather than emitting UTF-8, so "résumé.tex" comes back as
 * the literal string `"r\303\251sum\303\251.tex"` (quotes included).
 */
describe('logCommits (via status) reports plain, unquoted paths', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(): Promise<{ remote: FakeRemote; git: GitService; dir: string }> {
    const remote = await createFakeRemote({ 'a.tex': 'one\n' });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-log-paths-'));
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
    return { remote, git, dir };
  }

  it('reports a rename as two plain paths, not one rename expression', async () => {
    const { git, dir } = await setup();
    const raw = simpleGit(dir);
    await raw.addConfig('user.email', 'test@example.com');
    await raw.addConfig('user.name', 'Test');

    await raw.raw(['mv', 'a.tex', 'b.tex']);
    await raw.raw(['commit', '-m', 'rename a.tex to b.tex']);

    const status = await git.status(dir);

    expect(status.aheadCommits).toHaveLength(1);
    const paths = status.aheadCommits[0]?.files.map((f) => f.path).sort();
    expect(paths).toEqual(['a.tex', 'b.tex']);
  });

  it('reports a non-ASCII filename unquoted (UTF-8), not C-quoted', async () => {
    const { git, dir } = await setup();
    const raw = simpleGit(dir);
    await raw.addConfig('user.email', 'test@example.com');
    await raw.addConfig('user.name', 'Test');

    await writeFile(path.join(dir, 'résumé.tex'), 'content\n', 'utf8');
    await raw.add(['résumé.tex']);
    await raw.raw(['commit', '-m', 'add résumé.tex']);

    const status = await git.status(dir);

    expect(status.aheadCommits).toHaveLength(1);
    const paths = status.aheadCommits[0]?.files.map((f) => f.path);
    expect(paths).toEqual(['résumé.tex']);
  });
});

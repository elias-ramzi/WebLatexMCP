import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
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

  // Issue #66 (T7): `discard(dir, paths)` ran `checkout --` over every requested path before
  // `clean -f`. `checkout --` errors "did not match any file(s) known to git" for a path that is
  // not tracked at all — there is nothing at HEAD for it to check back out to — so a request
  // naming an untracked file failed before `clean` ever ran, discarding nothing at all (not even
  // the tracked paths named alongside it).
  it('discards an untracked-only path (pre-fix: rejects with the "did not match any file(s) known to git" pathspec error)', async () => {
    const { git, files, dir } = await setup({ 'main.tex': 'orig\n' });
    await files.write(dir, { path: 'scratch.txt', content: 'temp\n' });

    const res = await git.discard(dir, ['scratch.txt']);

    expect(res).toEqual({ discarded: true });
    await expect(stat(path.join(dir, 'scratch.txt'))).rejects.toThrow();
    expect((await git.status(dir)).clean).toBe(true);
  });

  it('discards a mix of a tracked modification and an untracked path together (pre-fix: rejects, discards neither)', async () => {
    const { git, files, dir } = await setup({ 'main.tex': 'orig\n' });
    await files.write(dir, { path: 'main.tex', content: 'changed\n' });
    await files.write(dir, { path: 'scratch.txt', content: 'temp\n' });

    const res = await git.discard(dir, ['main.tex', 'scratch.txt']);

    expect(res).toEqual({ discarded: true });
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('orig\n');
    await expect(stat(path.join(dir, 'scratch.txt'))).rejects.toThrow();
    expect((await git.status(dir)).clean).toBe(true);
  });

  // Issue #127 amended the report, not the behaviour: the call is still a no-op rather than an
  // error, but `clean -f` matching nothing exits 0, so `discarded: true` used to come back for a
  // path that was never there. It now says so.
  it('a path matching nothing at all (not tracked, not on disk) is a no-op, not an error, and is REPORTED as missed (#127)', async () => {
    const { git, dir } = await setup({ 'main.tex': 'orig\n' });

    await expect(git.discard(dir, ['nothing-here.txt'])).resolves.toEqual({
      discarded: false,
      missed: ['nothing-here.txt'],
    });
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('orig\n');
    expect((await git.status(dir)).clean).toBe(true);
  });

  // Issue #66 finding 1: `discard(dir, paths)` filtered `paths` to the tracked subset with a
  // literal (never case-folding) `ls-files` lookup, so on a `core.ignorecase` clone a caller
  // naming a tracked `Notes.txt` as `notes.txt` matched nothing — `checkout` was skipped, and
  // `clean -f` cannot remove a *tracked* file — so `discard` returned `{ discarded: true }` with
  // the edit still sitting on disk. `Notes.txt` is forced case-insensitive after clone (as
  // `caseFoldCommit.test.ts` does), even though this host filesystem stays case-sensitive
  // regardless: the defect lives in what GIT resolves the pathspec onto, not in what the
  // filesystem does with it.
  it('discards a tracked file named in another case on a core.ignorecase clone (issue #66 finding 1)', async () => {
    const { git, files, dir } = await setup({ 'Notes.txt': 'orig\n' });
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);
    await files.write(dir, { path: 'Notes.txt', content: 'changed\n' });

    const res = await git.discard(dir, ['notes.txt']);

    expect(res).toEqual({ discarded: true });
    expect(await readFile(path.join(dir, 'Notes.txt'), 'utf8')).toBe('orig\n');
    expect((await git.status(dir)).clean).toBe(true);
  });

  // Twin, just outside the fix: on a case-sensitive repository a literal pathspec never folds
  // (correctly), so `notes.txt` names a different file than the tracked `Notes.txt` — nothing
  // matches, the edit is left exactly as it was, and the call still does not throw.
  it('just outside — core.ignorecase=false: the differently-cased request is a no-op, edit stays (issue #66 finding 1 twin)', async () => {
    const { git, files, dir } = await setup({ 'Notes.txt': 'orig\n' });
    await simpleGit(dir).raw(['config', 'core.ignorecase', 'false']);
    await files.write(dir, { path: 'Notes.txt', content: 'changed\n' });

    // …and #127: the miss is reported rather than swallowed, on the case-sensitive clone too.
    await expect(git.discard(dir, ['notes.txt'])).resolves.toEqual({
      discarded: false,
      missed: ['notes.txt'],
    });

    expect(await readFile(path.join(dir, 'Notes.txt'), 'utf8')).toBe('changed\n');
    expect((await git.status(dir)).clean).toBe(false);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { simpleGit, type SimpleGit } from 'simple-git';
import { GitService, NothingToCommitError } from '../../src/services/gitService.js';

/**
 * Two ways a commit could carry, or leave behind, index state nobody asked for:
 *
 * 1. `commitContents` checked the mode-120000 refusal INSIDE its staging loop, after earlier files
 *    had already been `update-index`ed — so a refusal left this session's blobs staged, where the
 *    next `scope: "all"` commit (which commits the index as it stands) would carry them.
 * 2. `commit` with `paths` and no `fromHead` (`scope: "all"` with `paths`) ran `git add -- <paths>`
 *    and then a bare `git commit`, which commits EVERYTHING staged — a hand `git add` of an
 *    unrelated file rode along, although `paths` promises "limit the commit to these paths".
 */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function initRepo(
  files: Record<string, string>,
  opts: { ignorecase?: boolean } = {},
): Promise<{ dir: string; git: SimpleGit }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-index-hygiene-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const git = simpleGit(dir);
  await git.raw(['init', '-b', 'master']);
  await git.addConfig('user.email', 'local@example.com');
  await git.addConfig('user.name', 'Local');
  await git.addConfig('core.autocrlf', 'false');
  await git.addConfig('core.ignorecase', opts.ignorecase ? 'true' : 'false');
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  await git.add(['-A']);
  await git.commit('initial');
  return { dir, git };
}

async function stagedNames(git: SimpleGit): Promise<string[]> {
  return (await git.raw(['diff', '--cached', '--name-only'])).split('\n').filter(Boolean).sort();
}

async function lastCommitNames(git: SimpleGit): Promise<string[]> {
  return (await git.raw(['diff', '--name-only', 'HEAD~1', 'HEAD'])).split('\n').filter(Boolean);
}

describe('commitContents refuses a still-linked path before staging anything', () => {
  it.skipIf(process.platform === 'win32')(
    'a link refusal leaves no earlier file staged',
    async () => {
      const { dir, git } = await initRepo({ 'a.tex': 'a\n', 'target.tex': 't\n' });
      await symlink('target.tex', path.join(dir, 'link.tex'));
      await git.add(['link.tex']);
      await git.commit('add link');

      await expect(
        new GitService().commitContents(dir, {
          message: 'session commit',
          files: [
            { path: 'a.tex', content: 'a-edited\n' },
            { path: 'link.tex', content: 'text over a link\n' },
          ],
        }),
      ).rejects.toThrow(/symbolic link/);
      expect(await stagedNames(git)).toEqual([]);
    },
  );
});

describe('commit with paths over the live index commits only those paths', () => {
  it('a hand-staged unrelated file does not ride along, and stays staged', async () => {
    const { dir, git } = await initRepo({ 'a.tex': 'a\n', 'b.tex': 'b\n' });
    await writeFile(path.join(dir, 'a.tex'), 'a2\n');
    await writeFile(path.join(dir, 'b.tex'), 'b2\n');
    await git.add(['b.tex']);

    const res = await new GitService().commit(dir, { message: 'only a', paths: ['a.tex'] });
    expect(await lastCommitNames(git)).toEqual(['a.tex']);
    expect(res.filesChanged).toBe(1);
    expect(res.files.map((f) => f.path)).toEqual(['a.tex']);
    // The hand staging is the user's, untouched.
    expect(await stagedNames(git)).toEqual(['b.tex']);
  });

  it('when the named path has nothing to commit, a staged extra is not committed in its place', async () => {
    const { dir, git } = await initRepo({ 'a.tex': 'a\n', 'b.tex': 'b\n' });
    await writeFile(path.join(dir, 'b.tex'), 'b2\n');
    await git.add(['b.tex']);
    const head = (await git.revparse(['HEAD'])).trim();

    await expect(
      new GitService().commit(dir, { message: 'only a', paths: ['a.tex'] }),
    ).rejects.toBeInstanceOf(NothingToCommitError);
    expect((await git.revparse(['HEAD'])).trim()).toBe(head);
    expect(await stagedNames(git)).toEqual(['b.tex']);
  });

  it('a directory, a deletion and a new file among the named paths still commit (behaviour kept)', async () => {
    const { dir, git } = await initRepo({ 'sub/x.tex': 'x\n', 'gone.tex': 'g\n', 'c.tex': 'c\n' });
    await writeFile(path.join(dir, 'sub', 'x.tex'), 'x2\n');
    await writeFile(path.join(dir, 'sub', 'new.tex'), 'n\n');
    await unlink(path.join(dir, 'gone.tex'));
    await writeFile(path.join(dir, 'c.tex'), 'c2\n');
    await git.add(['c.tex']);

    await new GitService().commit(dir, { message: 'sub and gone', paths: ['sub', 'gone.tex'] });
    expect((await lastCommitNames(git)).sort()).toEqual(['gone.tex', 'sub/new.tex', 'sub/x.tex']);
    expect(await stagedNames(git)).toEqual(['c.tex']);
  });
});

describe('the legacy two-spellings refusal names a way out that does not discard the file', () => {
  it('tracked file: points at scope "paths", not at discarding a spelling', async () => {
    const { dir } = await initRepo({ 'Notes.txt': 'n\n' }, { ignorecase: true });
    const err = await new GitService()
      .commitContents(dir, {
        message: 'legacy',
        files: [
          { path: 'Notes.txt', content: 'x\n' },
          { path: 'notes.txt', content: 'y\n' },
        ],
      })
      .then(
        () => new Error('resolved instead of refusing'),
        (e: unknown) => e as Error,
      );
    expect(err.message).not.toMatch(/resolved instead/);
    expect(err.message).toMatch(/"Notes\.txt" and "notes\.txt"/);
    expect(err.message).not.toMatch(/Discard one of them/);
    expect(err.message).toMatch(/scope "paths"/);
  });

  it('new file: same', async () => {
    const { dir } = await initRepo({ 'main.tex': 'm\n' }, { ignorecase: true });
    const err = await new GitService()
      .commitContents(dir, {
        message: 'legacy',
        files: [
          { path: 'Other.tex', content: 'x\n' },
          { path: 'other.tex', content: 'y\n' },
        ],
      })
      .then(
        () => new Error('resolved instead of refusing'),
        (e: unknown) => e as Error,
      );
    expect(err.message).not.toMatch(/resolved instead/);
    expect(err.message).not.toMatch(/Discard one of them/);
    expect(err.message).toMatch(/scope "paths"/);
  });
});

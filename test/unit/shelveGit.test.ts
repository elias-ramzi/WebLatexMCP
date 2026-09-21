import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, symlink, unlink } from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { simpleGit, type SimpleGit } from 'simple-git';
import { GitService } from '../../src/services/gitService.js';

/**
 * Real-git coverage for the two additions `shelve`/`unshelve` need from `GitService`:
 * `linkPathsAmong` (which of a caller-named path set is a symlink on any side the restore could
 * write through) and `statAgainstHead` (per-file line counts for the tracked paths among them).
 *
 * A local temp repo, `git init`ed in the test — no network, no remote, no clone. These two methods
 * never touch a remote, so a bare-repo stand-in would only add latency.
 */

// Windows without Developer Mode (or without SeCreateSymbolicLinkPrivilege) cannot create a
// symlink at all, so the link-side cases are gated on the capability rather than on the platform
// name — probed by actually attempting one, the same shape as `test/smoke/**` gating on latexmk.
// Top-level await (as `test/smoke/compile.test.ts` does) so the answer exists at COLLECTION time
// and `describe.skipIf` can mark the block visibly skipped, rather than a `beforeAll` flag that
// could only turn the tests into silent passes.
const symlinksWork = await (async () => {
  const probe = await mkdtemp(path.join(os.tmpdir(), 'shelve-symprobe-'));
  try {
    await writeFile(path.join(probe, 'target.txt'), 'x');
    await symlink('target.txt', path.join(probe, 'link.txt'));
    return true;
  } catch {
    return false;
  } finally {
    await rmDir(probe);
  }
})();

// Windows keeps transient locks on freshly-used .git files, so a plain recursive rm can throw
// EBUSY/ENOTEMPTY — the same retry-tolerant idiom `test/integration/helpers/bareRepo.ts` uses.
function rmDir(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function initRepo(): Promise<{ dir: string; git: SimpleGit }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shelve-git-'));
  const git = simpleGit(dir);
  await git.raw(['init', '-b', 'master']);
  await git.addConfig('user.email', 'shelve@example.com');
  await git.addConfig('user.name', 'Shelve Test');
  await git.addConfig('core.autocrlf', 'false');
  return { dir, git };
}

async function write(dir: string, rel: string, content: string): Promise<void> {
  const full = path.join(dir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}

describe('GitService.linkPathsAmong', () => {
  let dir: string;
  let git: SimpleGit;
  let service: GitService;

  beforeEach(async () => {
    ({ dir, git } = await initRepo());
    service = new GitService();
  });

  afterEach(async () => {
    await rmDir(dir);
  });

  it('returns [] for an empty path list, with no git invocation', async () => {
    // A repo with no commits at all: any git call this method might still make would be the one
    // most likely to throw, so a clean [] here also pins the early return.
    await expect(service.linkPathsAmong(dir, [])).resolves.toEqual([]);
  });

  it('does not report an ordinary tracked file or an untracked regular file', async () => {
    await write(dir, 'main.tex', 'hello\n');
    await git.add('.');
    await git.commit('initial');
    await write(dir, 'scratch.md', 'notes\n');
    await expect(service.linkPathsAmong(dir, ['main.tex', 'scratch.md'])).resolves.toEqual([]);
  });

  describe.skipIf(!symlinksWork)('symlink sides', () => {
    it('finds a link that exists on disk only — created, never added', async () => {
      await write(dir, 'main.tex', 'hello\n');
      await git.add('.');
      await git.commit('initial');
      await symlink('main.tex', path.join(dir, 'link.tex'));
      await expect(service.linkPathsAmong(dir, ['main.tex', 'link.tex'])).resolves.toEqual([
        'link.tex',
      ]);
    });

    it('finds a link on an UNBORN HEAD, where there is no HEAD tree to probe', async () => {
      // A freshly `git init`ed repo with no commit: the HEAD probe must be skipped rather than
      // throwing, and the on-disk check must still fire.
      await write(dir, 'main.tex', 'hello\n');
      await symlink('main.tex', path.join(dir, 'link.tex'));
      await expect(service.linkPathsAmong(dir, ['main.tex', 'link.tex'])).resolves.toEqual([
        'link.tex',
      ]);
    });

    it("finds a link in HEAD's tree after the working-tree file became a regular file", async () => {
      await write(dir, 'main.tex', 'hello\n');
      await symlink('main.tex', path.join(dir, 'link.tex'));
      await git.add('.');
      await git.commit('commit the link');
      // Replace the link with a regular file AND stage that, so neither the on-disk check nor the
      // index check can be what reports it — only HEAD still says 120000.
      await unlink(path.join(dir, 'link.tex'));
      await write(dir, 'link.tex', 'now an ordinary file\n');
      await git.raw(['--literal-pathspecs', 'add', '--', 'link.tex']);
      const staged = await git.raw(['--literal-pathspecs', 'ls-files', '-s', '--', 'link.tex']);
      expect(staged.startsWith('100644')).toBe(true);

      await expect(service.linkPathsAmong(dir, ['link.tex'])).resolves.toEqual(['link.tex']);
    });

    it('finds a link in the INDEX that is neither in HEAD nor on disk', async () => {
      await write(dir, 'main.tex', 'hello\n');
      await git.add('.');
      await git.commit('initial');
      await symlink('main.tex', path.join(dir, 'link.tex'));
      await git.raw(['--literal-pathspecs', 'add', '--', 'link.tex']);
      // Take it off disk and put a regular file there, leaving the 120000 entry in the index only.
      await unlink(path.join(dir, 'link.tex'));
      await write(dir, 'link.tex', 'now an ordinary file\n');

      await expect(service.linkPathsAmong(dir, ['link.tex'])).resolves.toEqual(['link.tex']);
    });

    it('finds a path UNDER a linked directory', async () => {
      await write(dir, 'realdir/notes.tex', 'real\n');
      await symlink('realdir', path.join(dir, 'linkdir'));
      await git.add('.');
      await git.commit('link a directory');
      // `linkdir/notes.tex` is an ordinary name whose final component is not a link, and neither
      // HEAD nor the index has an entry under that path — only `linkedAncestor` catches it.
      await expect(service.linkPathsAmong(dir, ['linkdir/notes.tex'])).resolves.toEqual([
        'linkdir/notes.tex',
      ]);
    });

    it('sorts and deduplicates a path that is a link on several sides at once', async () => {
      await write(dir, 'b.tex', 'b\n');
      await symlink('b.tex', path.join(dir, 'a.tex'));
      await git.add('.');
      await git.commit('link in HEAD, index and on disk');
      await symlink('b.tex', path.join(dir, 'c.tex'));
      await expect(service.linkPathsAmong(dir, ['c.tex', 'a.tex', 'b.tex'])).resolves.toEqual([
        'a.tex',
        'c.tex',
      ]);
    });

    // `--literal-pathspecs` (the GLOBAL option, before the subcommand) is what keeps `a[1].tex`
    // from also meaning `a1.tex` — a pathspec is a wildmatch glob by default. Dropping the flag
    // from either the `ls-tree` or the `ls-files` call makes this test report `a1.tex`, which the
    // caller would then refuse to shelve for being a link it never named.
    it('matches a glob-looking path literally: `a[1].tex` does not pick up a sibling `a1.tex`', async () => {
      await write(dir, 'target.tex', 'target\n');
      await symlink('target.tex', path.join(dir, 'a1.tex'));
      await write(dir, 'a[1].tex', 'a regular file with brackets in its name\n');
      await git.add('.');
      await git.commit('a glob-looking name beside a real link');

      await expect(service.linkPathsAmong(dir, ['a[1].tex'])).resolves.toEqual([]);
      // Sanity: the sibling really IS a link, so an empty result above means the pathspec stayed
      // literal rather than that there was nothing to find.
      await expect(service.linkPathsAmong(dir, ['a1.tex'])).resolves.toEqual(['a1.tex']);
    });
  });
});

describe('GitService.statAgainstHead', () => {
  let dir: string;
  let git: SimpleGit;
  let service: GitService;

  beforeEach(async () => {
    ({ dir, git } = await initRepo());
    service = new GitService();
  });

  afterEach(async () => {
    await rmDir(dir);
  });

  it('returns [] for an empty path list', async () => {
    await expect(service.statAgainstHead(dir, [])).resolves.toEqual([]);
  });

  it('returns [] on an unborn HEAD rather than throwing', async () => {
    await write(dir, 'main.tex', 'hello\n');
    await expect(service.statAgainstHead(dir, ['main.tex'])).resolves.toEqual([]);
  });

  it('reports added/removed for a modified tracked file', async () => {
    await write(dir, 'main.tex', 'a\nb\nc\n');
    await git.add('.');
    await git.commit('initial');
    await write(dir, 'main.tex', 'a\nB\nc\nd\n');

    await expect(service.statAgainstHead(dir, ['main.tex'])).resolves.toEqual([
      { path: 'main.tex', added: 2, removed: 1 },
    ]);
  });

  it('scopes to the named paths — an unnamed dirty file does not appear', async () => {
    await write(dir, 'main.tex', 'a\n');
    await write(dir, 'other.tex', 'x\n');
    await git.add('.');
    await git.commit('initial');
    await write(dir, 'main.tex', 'a\nb\n');
    await write(dir, 'other.tex', 'x\ny\n');

    const files = await service.statAgainstHead(dir, ['main.tex']);
    expect(files.map((f) => f.path)).toEqual(['main.tex']);
  });

  // `git diff HEAD` lists tracked paths only. That is the documented, inherited behaviour: the
  // `shelve` tool counts an untracked file's lines from the bytes it takes, so widening the diff
  // here would be a fix for a problem the caller does not have.
  it('returns [] for an untracked-only request', async () => {
    await write(dir, 'main.tex', 'a\n');
    await git.add('.');
    await git.commit('initial');
    await write(dir, 'scratch.md', 'notes\nmore\n');

    await expect(service.statAgainstHead(dir, ['scratch.md'])).resolves.toEqual([]);
  });

  it('reports POSIX paths for a file in a subdirectory', async () => {
    await write(dir, 'sections/intro.tex', 'a\n');
    await git.add('.');
    await git.commit('initial');
    await write(dir, 'sections/intro.tex', 'a\nb\n');

    const files = await service.statAgainstHead(dir, ['sections/intro.tex']);
    expect(files.map((f) => f.path)).toEqual(['sections/intro.tex']);
  });
});

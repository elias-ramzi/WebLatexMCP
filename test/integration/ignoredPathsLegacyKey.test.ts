import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { simpleGit, type SimpleGit } from 'simple-git';
import {
  GitService,
  PathBeyondSymlinkError,
  beyondSymlinkPaths,
} from '../../src/services/gitService.js';

/**
 * #70, "Accepted trade-offs": a **legacy shadow key beyond a symlink** — filed by a
 * pre-`4c8bba3` `delete_file` under a linked directory, under the link's name rather than the
 * real directory's — makes `git check-ignore` die. `GitService.ignoredPaths` runs once per
 * `commit` over every path the call considers, so such a key failed the whole commit, unrelated
 * files included, with raw git text naming no route out.
 *
 * What was measured before this guard was written (git 2.46.0, Linux), because a guard against
 * an unverified message is worse than none:
 *
 * ```
 * $ printf 'linkdir/notes.tex\0' | git check-ignore -z --stdin --no-index
 * fatal: pathspec 'linkdir/notes.tex' is beyond a symbolic link
 * $ echo $?
 * 128
 * ```
 *
 * Identical with and without `--no-index` (both `tracked` routes), and identical whether the
 * link is tracked, untracked, dangling, or points outside the repository. `check-ignore` dies at
 * the FIRST offending path, so a batch naming two of them names only the first, and an earlier
 * ignored path's stdout is thrown away with the call — which is why fail-open is not merely
 * wrong in principle here: the partial stdout is a real, plausible-looking, WRONG answer.
 *
 * Three properties are pinned:
 *
 * 1. It still **throws** — never an empty set, which would report "nothing is ignored" and let
 *    the commit stage a file git means to exclude.
 * 2. The message is in **server words**, names the path, and names the way out — and the way out
 *    is verified to actually work rather than asserted, since `discard` is what the message
 *    sends the caller to.
 * 3. Every OTHER non-0/1 exit still reports what really happened.
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

/**
 * A repository holding a tracked `linkdir -> realdir` and a real `realdir/notes.tex`, plus an
 * ignore rule so the success paths have something to report.
 *
 * `core.ignorecase` is pinned to **false** rather than inherited: git's own default is `true` on
 * macOS and Windows, which sends `ignoredPaths`' `'index'` route and `trackedAtHead` down their
 * folding branches. The differential assertions below are about the answer, not the branch, so
 * they must not silently mean something different on one runner.
 */
async function initLinkedRepo(): Promise<{ dir: string; git: SimpleGit }> {
  const dir = await tmp('ovl-beyond-link-');
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await git.addConfig('core.ignorecase', 'false');
  await mkdir(path.join(dir, 'realdir'), { recursive: true });
  await writeFile(path.join(dir, 'realdir', 'notes.tex'), 'real\n');
  await writeFile(path.join(dir, 'main.tex'), 'main\n');
  await writeFile(path.join(dir, '.gitignore'), '*.log\n');
  await symlink('realdir', path.join(dir, 'linkdir'), 'dir');
  await git.add('.');
  await git.commit('base');
  await writeFile(path.join(dir, 'scratch.log'), 'noise\n');
  return { dir, git };
}

/** The exact stderr captured from git 2.46.0 for each shape (see the header). */
const STDERR = {
  beyondLink: "fatal: pathspec 'linkdir/notes.tex' is beyond a symbolic link\n",
  // The path is interpolated verbatim, so one containing a newline splits git's own message
  // across two lines, un-quoted. A single-line regex capture yields `linkdir/a` here — a path
  // nobody asked about — which is why naming goes through the requested list instead.
  beyondLinkNewlinePath: "fatal: pathspec 'linkdir/a\nb.tex' is beyond a symbolic link\n",
  notARepo: 'fatal: not a git repository (or any of the parent directories): .git\n',
  invalidGitfile: 'fatal: invalid gitfile format: /tmp/x/.git\n',
} as const;

describe('beyondSymlinkPaths — classifying git check-ignore stderr', () => {
  it('names the requested path git named', () => {
    const named = beyondSymlinkPaths(STDERR.beyondLink, ['main.tex', 'linkdir/notes.tex']);
    expect(named).toEqual(['linkdir/notes.tex']);
  });

  it('returns null for a failure that is not this one, so it keeps its own report', () => {
    expect(beyondSymlinkPaths(STDERR.notARepo, ['main.tex'])).toBeNull();
    expect(beyondSymlinkPaths(STDERR.invalidGitfile, ['main.tex'])).toBeNull();
    expect(beyondSymlinkPaths('', ['main.tex'])).toBeNull();
  });

  it('recognises the failure but names nothing when the path cannot be tied back', () => {
    // Recognised (`[]`), NOT unrecognised (`null`): the distinction is what decides between
    // server words and git's raw text, and collapsing them relabels an unrelated failure.
    const named = beyondSymlinkPaths(STDERR.beyondLinkNewlinePath, ['linkdir/a', 'b.tex']);
    expect(named).not.toBeNull();
    expect(named).toEqual([]);
  });

  it('matches the whole quoted path, not a substring of it', () => {
    // `notes.tex` is a suffix of the path git named; naming it would send the caller to
    // `discard` a file that is not the problem.
    expect(beyondSymlinkPaths(STDERR.beyondLink, ['notes.tex'])).toEqual([]);
  });
});

describe('PathBeyondSymlinkError message', () => {
  it('names the path and the way out, and pastes no raw git text', () => {
    const msg = new PathBeyondSymlinkError(['linkdir/notes.tex'], 3).message;
    expect(msg).toContain('linkdir/notes.tex');
    expect(msg).toContain('discard');
    expect(msg).toContain('symbolic link');
    // Server words OR git's stderr, never both stitched into one sentence.
    expect(msg).not.toContain('fatal:');
    expect(msg).not.toContain('check-ignore');
  });

  it('says which request the failure belongs to when git named no path we asked about', () => {
    const msg = new PathBeyondSymlinkError([], 7).message;
    expect(msg).toContain('7 paths');
    expect(msg).toContain('status');
    expect(msg).toContain('discard');
  });

  it('names every path it was given', () => {
    // Git dies at the first offender, so more than one is not a shape it produces — but the
    // field is an array and the wording branches on its length, so neither branch goes untested.
    const msg = new PathBeyondSymlinkError(['a/x.tex', 'b/y.tex'], 2).message;
    expect(msg).toContain('a/x.tex');
    expect(msg).toContain('b/y.tex');
    expect(msg).toContain('lie beyond a symbolic link');
    expect(new PathBeyondSymlinkError(['a/x.tex'], 1).message).toContain(
      'lies beyond a symbolic link',
    );
  });
});

describe.skipIf(process.platform === 'win32')('ignoredPaths beyond a symlink (posix only)', () => {
  it.each(['head', 'index'] as const)(
    'refuses in server words rather than raw git text (tracked: %s)',
    async (tracked) => {
      const { dir } = await initLinkedRepo();

      const err = await new GitService().ignoredPaths(dir, ['linkdir/notes.tex'], { tracked }).then(
        () => null,
        (e: unknown) => e,
      );

      // Never fail open: an empty result would say "nothing is ignored" and let the commit run.
      expect(err).toBeInstanceOf(PathBeyondSymlinkError);
      expect((err as PathBeyondSymlinkError).paths).toEqual(['linkdir/notes.tex']);
      expect((err as Error).message).toContain('linkdir/notes.tex');
      expect((err as Error).message).toContain('discard');
      expect((err as Error).message).not.toContain('fatal:');
    },
  );

  it('refuses the whole batch rather than returning the part git managed to judge', async () => {
    const { dir } = await initLinkedRepo();
    // `scratch.log` IS ignored and git prints it to stdout before dying on the next path. A
    // fail-open guard would hand that partial stdout back as the answer — plausible, and wrong
    // about every path after it.
    await expect(
      new GitService().ignoredPaths(dir, ['scratch.log', 'linkdir/notes.tex', 'main.tex'], {
        tracked: 'head',
      }),
    ).rejects.toBeInstanceOf(PathBeyondSymlinkError);
  });

  it.each(['head', 'index'] as const)(
    'answers paths that are not beyond the link exactly as before (tracked: %s)',
    async (tracked) => {
      const { dir } = await initLinkedRepo();
      const asked = ['scratch.log', 'main.tex', 'realdir/notes.tex', 'linkdir'];

      const ignored = await new GitService().ignoredPaths(dir, asked, { tracked });

      // A minimum, not just a subset relation: an implementation that answered `[]` for
      // everything would satisfy "no tracked path is reported ignored" vacuously.
      expect(ignored).toEqual(['scratch.log']);
    },
  );

  it('the way out the message names really works', async () => {
    const { dir } = await initLinkedRepo();
    // `discard` is what the message sends the caller to, so it must not die the same way.
    // Its git calls (`ls-files`, `clean -f`) accept a beyond-a-link pathspec as a no-op —
    // measured, not assumed — which is what lets the tool go on to clear the shadow entry.
    // Since #127 it also SAYS that git reached nothing — the path is neither in the index nor in
    // the untracked listing (git does not descend a symlink), so it comes back `missed`. The
    // tool's shadow settle runs over every requested path regardless, which is exactly what
    // makes `discard` the way out of an entry git itself refuses to stage.
    await expect(new GitService().discard(dir, ['linkdir/notes.tex'])).resolves.toEqual({
      discarded: false,
      missed: ['linkdir/notes.tex'],
    });
    // And it left the real file alone: `clean` does not descend through a symlink.
    expect(
      await new GitService().ignoredPaths(dir, ['realdir/notes.tex'], { tracked: 'head' }),
    ).toEqual([]);
  });
});

describe('ignoredPaths on any other check-ignore failure', () => {
  it('still reports what actually happened', async () => {
    const dir = await tmp('ovl-broken-git-');
    // A `.git` FILE holding garbage: exit 128 with a message that is not the symlink one,
    // and deterministic whatever directory the test runner sits in.
    await writeFile(path.join(dir, '.git'), 'garbage\n');

    const err = await new GitService().ignoredPaths(dir, ['main.tex'], { tracked: 'head' }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PathBeyondSymlinkError);
    expect((err as Error).message).toContain('git check-ignore failed:');
    expect((err as Error).message).toContain('invalid gitfile format');
  });
});

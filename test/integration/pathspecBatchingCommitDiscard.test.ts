import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readdir, rm, writeFile, readFile, chmod, stat } from 'node:fs/promises';
import { simpleGit, type SimpleGit } from 'simple-git';
import { GitService, MAX_PATHSPEC_ARGV_CHARS } from '../../src/services/gitService.js';
import { execCapture } from '../../src/lib/exec.js';

/**
 * The three pathspec lists #94 did not batch (#110): `commit`'s `ls-files`/`add`,
 * `trackedAtHead`'s `ls-tree HEAD` (reached from `ignoredPaths`, so it runs on every
 * session-scope commit over everything the session has touched), and `discard`'s
 * `ls-files`/`checkout`/`clean`. Each used to hand one spawn the whole list, which a session or
 * a request touching enough files pushes past Windows' ~32 KB command line.
 *
 * Same two-part proof as `revertPathspecBatching.test.ts`, and the same reasons:
 *
 * - **The split happens, and every chunk keeps its guarantees.** Only the argv a spawn actually
 *   received can show that, so a recording `git` shim goes on `PATH` and the command lines are
 *   read back. Those are the tests that fail against the unbatched code on Linux/macOS, where a
 *   40 KB argv is legal.
 * - **The chunks combine into exactly one call's answer.** Every behavioural body runs at a size
 *   that fits in one chunk and at a size that needs several, against ground truth computed from
 *   a SINGLE unscoped git call parsed here — so a combining bug (a union that keeps only the
 *   last chunk, a loop that stops after the first) shows up as the two sizes disagreeing.
 *
 * On Windows the large fixture also exceeds the real command line, so the unbatched code fails
 * the behavioural tests outright there; on POSIX it is legal, hence the shim.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** Windows' `CreateProcessW` command-line cap — the limit `MAX_PATHSPEC_ARGV_CHARS` comes from. */
const WINDOWS_COMMAND_LINE_LIMIT = 32767;

/** The same accounting `chunkPathspecs` uses: the path, a separating space, a pair of quotes. */
function argvCost(args: string[]): number {
  return args.reduce((n, a) => n + a.length + 3, 0);
}

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * A ~130-character repo-relative path, all under two shared directories: the length is what the
 * chunker is sized against, and sharing the parents keeps the fixture to one `mkdir`.
 */
const DEEP_DIR = `sections/${'d'.repeat(40)}/${'s'.repeat(35)}`;
function fixturePath(i: number, stem = 'figure'): string {
  return `${DEEP_DIR}/${stem}-${String(i).padStart(4, '0')}-${'x'.repeat(30)}.tex`;
}

/**
 * `core.ignorecase=false` is set explicitly, and it is not cosmetic: git turns it ON by default
 * on macOS and Windows clones, and on such a repository `trackedAtHead` takes its OTHER branch —
 * a whole-tree `ls-tree` with no pathspec at all, because a pathspec cannot be both literal and
 * case-insensitive. There is nothing to batch there, so on those runners these fixtures silently
 * stopped exercising the batched call (the argv test found zero pathspec-bearing `ls-tree`
 * invocations on macOS CI and said so). The server's own source of truth for the fold is this
 * config value, never the filesystem, so declaring it here is exactly how a case-sensitive
 * repository is pinned on every platform — and it is the pathspec branch that this lane batches.
 */
async function initRepo(prefix: string): Promise<{ dir: string; git: SimpleGit }> {
  const dir = await tmp(prefix);
  const git = simpleGit(dir);
  await git.raw(['init', '-b', 'master']);
  await git.addConfig('user.email', 'local@example.com');
  await git.addConfig('user.name', 'Local');
  await git.addConfig('core.autocrlf', 'false');
  await git.addConfig('core.ignorecase', 'false');
  // Asserted, not assumed: if the setting ever failed to take, the tests below would go quiet
  // (a branch with no pathspec passes every batching assertion vacuously) rather than fail.
  expect(await new GitService().isCaseInsensitive(dir)).toBe(false);
  return { dir, git };
}

async function writeAll(dir: string, rels: string[], content: string): Promise<void> {
  await mkdir(path.join(dir, DEEP_DIR), { recursive: true });
  for (const rel of rels) await writeFile(path.join(dir, rel), content);
}

/**
 * Run `fn` with a recording `git` earlier on `PATH` than the real one, and return every
 * invocation's argv.
 *
 * ONE FILE PER INVOCATION, never a shared append log — the detail PR #111 paid for: several
 * shims can be alive at once and `printf` of an ~8 KB argv is not one `write()` on every libc,
 * so two records interleaved on macOS and the merged record read as a single oversized spawn,
 * failing the budget assertion for a chunker that had split correctly.
 */
async function recordGitArgv(fn: () => Promise<void>): Promise<string[][]> {
  const which = await execCapture('sh', ['-c', 'command -v git']);
  expect(which.code).toBe(0);
  const realGit = which.stdout.trim();

  const shimDir = await tmp('ovl-git-shim-');
  const logDir = path.join(shimDir, 'argv');
  await mkdir(logDir, { recursive: true });
  await writeFile(
    path.join(shimDir, 'git'),
    // Records this invocation's argv (NUL-separated) into its own file and then runs the real
    // git, so the service under test still talks to real git and real results hold.
    `#!/bin/sh\nprintf '%s\\0' "$@" > "$(mktemp "$WLM_ARGV_DIR/argv.XXXXXXXX")"\nexec "$WLM_REAL_GIT" "$@"\n`,
  );
  await chmod(path.join(shimDir, 'git'), 0o755);

  const prevPath = process.env.PATH;
  process.env.WLM_ARGV_DIR = logDir;
  process.env.WLM_REAL_GIT = realGit;
  process.env.PATH = `${shimDir}${path.delimiter}${prevPath ?? ''}`;
  try {
    await fn();
  } finally {
    process.env.PATH = prevPath;
    delete process.env.WLM_ARGV_DIR;
    delete process.env.WLM_REAL_GIT;
  }

  return Promise.all(
    (await readdir(logDir))
      .sort()
      .map(async (name) =>
        (await readFile(path.join(logDir, name), 'utf8')).split('\0').filter(Boolean),
      ),
  );
}

/** The pathspec tail of an invocation: everything after its `--` separator. */
function pathspecsOf(args: string[]): string[] {
  const sep = args.indexOf('--');
  return sep < 0 ? [] : args.slice(sep + 1);
}

/** Index of the subcommand: the first non-option argument, skipping each `-c <value>`. */
function subcommandAt(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '-c') {
      i++;
      continue;
    }
    if (!a.startsWith('-')) return i;
  }
  return -1;
}

/**
 * The bound the constant exists to keep, plus the guarantees that must survive the batching on
 * EVERY chunk: a literal pathspec, and every global option placed BEFORE the subcommand rather
 * than after it (where git reads `--literal-pathspecs` as the subcommand's own flag, or not at
 * all). Applied to every recorded invocation, not only the ones under test, so a batched call
 * that quietly dropped the flag cannot hide among the others.
 */
function assertEveryInvocationIsBudgetedAndLiteral(invocations: string[][]): void {
  expect(invocations.length).toBeGreaterThan(0);
  for (const args of invocations) {
    expect(argvCost(pathspecsOf(args))).toBeLessThanOrEqual(MAX_PATHSPEC_ARGV_CHARS);
    expect(argvCost(args)).toBeLessThan(WINDOWS_COMMAND_LINE_LIMIT);
    if (pathspecsOf(args).length === 0) continue;
    const sub = subcommandAt(args);
    expect(args).toContain('--literal-pathspecs');
    expect(args.indexOf('--literal-pathspecs')).toBeLessThan(sub);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c') expect(i).toBeLessThan(sub);
    }
  }
}

/**
 * Every pathspec `sub` was invoked with, across all its chunks — the list that has to add up to
 * the whole request. `min` guards the assertion itself: at these sizes the call MUST have been
 * split, so a "union is complete" check cannot pass by never having batched at all.
 */
function pathspecUnionFor(invocations: string[][], sub: string, min: number): string[] {
  const calls = invocations.filter((a) => {
    const at = subcommandAt(a);
    return at >= 0 && a[at] === sub && pathspecsOf(a).length > 0;
  });
  expect(calls.length).toBeGreaterThanOrEqual(min);
  const seen = calls.flatMap((args) => pathspecsOf(args));
  // No chunk repeats a path within one pass: the chunks partition the list.
  expect(new Set(seen).size).toBe(seen.length);
  return [...seen].sort();
}

/**
 * One chunk at 6 paths, several at 300 — the same fixture shape either side, so the only thing
 * that differs between the two runs is whether the pathspec list was split.
 */
const SIZES = [
  { label: '6 paths (one chunk — what a single call would do)', count: 6, batched: false },
  { label: '300 long paths (several chunks)', count: 300, batched: true },
] as const;

/** The fixture is only worth its runtime if one list really would overflow Windows. */
function assertOverflowsWindows(paths: string[]): void {
  expect(argvCost(paths)).toBeGreaterThan(WINDOWS_COMMAND_LINE_LIMIT);
}

describe('pathspec batching outside revert', () => {
  describe.each(SIZES)('commit — $label', ({ count, batched }) => {
    it('stages and commits every named path, however many chunks it took', async () => {
      const { dir, git } = await initRepo('ovl-commit-argv-');
      const rels = Array.from({ length: count }, (_, i) => fixturePath(i));
      await writeAll(dir, rels, 'v1\n');
      await git.add('.');
      await git.commit('base');
      await writeAll(dir, rels, 'v1\nv2\n');
      const paths = [...rels].sort();
      // One named path is tracked but REMOVED from disk — deliberately in a later chunk. It is
      // what makes the `ls-files` listing observable without the shim (so this bites on Windows
      // too): its "does this path exist at all" fallback is an `lstat`, which fails here, so a
      // listing that lost its chunk refuses the whole commit with "Nothing at: …" instead of
      // staging the deletion.
      const deleted = paths[Math.floor(count * 0.8)] ?? '';
      await rm(path.join(dir, deleted));
      if (batched) assertOverflowsWindows(paths);

      const res = await new GitService().commit(dir, { message: 'bulk', paths });

      // Ground truth from git itself: the commit has to hold every named path. An `add` loop
      // that stopped after the first chunk commits ~60 of 300 and fails here.
      const committed = (
        await git.raw(['show', '--no-renames', '--name-only', '--format=', 'HEAD'])
      )
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .sort();
      expect(committed).toEqual(paths);
      expect((await git.raw(['ls-tree', '-r', '--name-only', 'HEAD'])).split('\n')).not.toContain(
        deleted,
      );
      expect(res.committed).toBe(true);
      expect(res.filesChanged).toBe(count);
      expect(res.files.map((f) => f.path).sort()).toEqual(paths);
      // Nothing is left staged and the tree is clean: the whole request landed in one commit.
      expect((await git.raw(['status', '--porcelain'])).trim()).toBe('');
    });
  });

  describe.each(SIZES)('ignoredPaths — $label', ({ count, batched }) => {
    it('reports exactly the untracked-and-ignored paths, however many chunks it took', async () => {
      const { dir, git } = await initRepo('ovl-ignored-argv-');
      const rels = Array.from({ length: count }, (_, i) => fixturePath(i));
      await writeAll(dir, rels, 'v1\n');
      await git.add('.');
      await git.commit('base');
      // Now ignore that whole shape. Git never re-ignores a TRACKED path, so every `rel` above
      // stays committable and only the untracked extras below are ignored — which is exactly
      // the distinction `trackedAtHead`'s batched `ls-tree` has to get right for all 300.
      await writeFile(path.join(dir, '.gitignore'), '*.tex\n');
      await git.add('.gitignore');
      await git.commit('ignore rules');
      // Extras at both ends of the request, so no single chunk holds all of them.
      const extras = [fixturePath(0, 'scratch'), fixturePath(1, 'scratch')];
      await writeAll(dir, extras, 'scratch\n');
      const asked = [extras[0] ?? '', ...rels, extras[1] ?? ''];
      if (batched) assertOverflowsWindows(asked);

      const ignored = await new GitService().ignoredPaths(dir, asked, { tracked: 'head' });

      // Ground truth: ONE unscoped `ls-tree` parsed here. A `ls-tree` loop that stopped after
      // the first chunk reports the later tracked paths as ignored — so `commit` would drop
      // this session's edits to them — and that is what fails here.
      const trackedAtHead = new Set(
        (await git.raw(['ls-tree', '-r', '-z', '--name-only', 'HEAD'])).split('\0').filter(Boolean),
      );
      expect([...ignored].sort()).toEqual(asked.filter((p) => !trackedAtHead.has(p)).sort());
      expect([...ignored].sort()).toEqual([...extras].sort());
    });
  });

  describe.each(SIZES)('discard — $label', ({ count, batched }) => {
    it('reverts every tracked path and removes every untracked one, over all chunks', async () => {
      const { dir, git } = await initRepo('ovl-discard-argv-');
      const rels = Array.from({ length: count }, (_, i) => fixturePath(i));
      await writeAll(dir, rels, 'v1\n');
      await git.add('.');
      await git.commit('base');
      await writeAll(dir, rels, 'v1\nEDITED\n');
      // Untracked scratch files at both ends of the request: `checkout` cannot touch these and
      // `clean` is what removes them, so both batched steps are exercised.
      const scratch = [fixturePath(0, 'scratch'), fixturePath(1, 'scratch')];
      await writeAll(dir, scratch, 'scratch\n');
      const paths = [scratch[0] ?? '', ...rels, scratch[1] ?? ''];
      if (batched) assertOverflowsWindows(paths);

      expect(await new GitService().discard(dir, paths)).toEqual({ discarded: true });

      // Ground truth from git: nothing dirty anywhere. A `checkout` or `clean` loop that ran
      // only its first chunk leaves the rest edited or on disk, and `status` says so.
      expect((await git.raw(['status', '--porcelain'])).trim()).toBe('');
      for (const i of [0, Math.floor(count / 2), count - 1]) {
        expect(await readFile(path.join(dir, rels[i] ?? ''), 'utf8')).toBe('v1\n');
      }
      for (const rel of scratch) expect(await exists(path.join(dir, rel))).toBe(false);
    });
  });

  /**
   * Batching introduces a failure mode one spawn did not have: a chunk can fail with earlier
   * chunks already applied. What the caller is told about that is part of the feature, so it is
   * asserted here — including that the message's factual claims are actually true of the clone.
   */
  describe('partial failure', () => {
    it('commit says nothing was committed, that a retry is safe, and leaves exactly that', async () => {
      const { dir, git } = await initRepo('ovl-commit-partial-');
      const rels = Array.from({ length: 300 }, (_, i) => fixturePath(i));
      await writeAll(dir, rels, 'v1\n');
      await git.add('.');
      await git.commit('base');
      const base = (await git.revparse(['HEAD'])).trim();
      await writeAll(dir, rels, 'v1\nv2\n');
      // `git add` REFUSES an ignored path named outright ("Use -f"), so this is a deterministic,
      // cross-platform way to fail one chunk. It goes LAST, so the earlier chunks have already
      // staged by the time it does.
      await writeFile(path.join(dir, '.gitignore'), 'scratch-*.tex\n');
      await git.add('.gitignore');
      await git.commit('ignore rules');
      const refused = `${DEEP_DIR}/scratch-late.tex`;
      await writeAll(dir, [refused], 'scratch\n');

      const err = await new GitService()
        .commit(dir, { message: 'bulk', paths: [...rels, refused] })
        .then(
          () => null,
          (e: unknown) => e as Error,
        );

      expect(err).toBeInstanceOf(Error);
      const message = err?.message ?? '';
      expect(message).toContain('NOTHING was committed');
      expect(message).toContain('re-running `commit` is safe');
      // Deliberately NOT the revert's "do NOT simply retry": staging cannot double-apply.
      expect(message).not.toContain('Do NOT simply retry');
      expect(message).toContain('git add');

      // The message's two factual claims, checked against the clone rather than taken on trust:
      // no commit was made, and the index really does hold part of what was named.
      expect((await git.revparse(['HEAD'])).trim()).not.toBe(base);
      expect((await git.raw(['log', '--format=%s', '-1'])).trim()).toBe('ignore rules');
      const staged = (await git.raw(['diff', '--cached', '--name-only']))
        .split('\n')
        .filter(Boolean);
      // A strict, non-empty subset of what was named: the chunks before the refused one landed,
      // the refused one did not. Which side of the boundary each path falls on depends on the
      // chunking and is not what is being pinned — that the index is now PART of the request is.
      expect(staged.length).toBeGreaterThan(0);
      expect(staged).not.toContain(refused);
      expect(staged.length).toBeLessThan(rels.length + 1);
      // "Only what this call named can be staged" — nothing else crept in.
      expect(staged.every((p) => rels.includes(p))).toBe(true);
    });

    // Needs a directory git cannot write into, which is a POSIX permission bit root ignores and
    // Windows does not have. The message itself is platform-independent; only this way of
    // provoking it is not.
    describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('discard', () => {
      it('says part of the tree is already gone, and that a retry destroys the rest', async () => {
        const { dir, git } = await initRepo('ovl-discard-partial-');
        const rels = Array.from({ length: 300 }, (_, i) => fixturePath(i));
        const lockedDir = 'locked';
        const lockedRel = `${lockedDir}/last-${'y'.repeat(60)}.tex`;
        await writeAll(dir, rels, 'v1\n');
        await mkdir(path.join(dir, lockedDir), { recursive: true });
        await writeFile(path.join(dir, lockedRel), 'v1\n');
        await git.add('.');
        await git.commit('base');
        await writeAll(dir, rels, 'v1\nEDITED\n');
        await writeFile(path.join(dir, lockedRel), 'v1\nEDITED\n');
        // Read-only directory: `git checkout` cannot unlink the old file, so the chunk holding
        // this path fails — after the chunks before it have already reverted their files.
        await chmod(path.join(dir, lockedDir), 0o555);

        let err: Error | null = null;
        try {
          await new GitService().discard(dir, [...rels, lockedRel]);
        } catch (e) {
          err = e as Error;
        } finally {
          await chmod(path.join(dir, lockedDir), 0o755);
        }

        expect(err).toBeInstanceOf(Error);
        const message = err?.message ?? '';
        expect(message).toContain('PART WAY THROUGH');
        expect(message).toContain('cannot be recovered');
        expect(message).toContain('destroys the rest');
        // The revert's wording is wrong here and must not have been copied: finishing a discard
        // by retrying is exactly what the caller should do if they still want it.
        expect(message).not.toContain('Do NOT simply retry');

        // The claim is true: an earlier chunk's edit is gone, the failing one's survives.
        expect(await readFile(path.join(dir, rels[0] ?? ''), 'utf8')).toBe('v1\n');
        expect(await readFile(path.join(dir, lockedRel), 'utf8')).toBe('v1\nEDITED\n');
      });
    });
  });

  // Observing the spawns themselves needs a recording `git` earlier on PATH than the real one.
  // A shell shim is POSIX-only; on Windows the same regressions are caught by the tests above,
  // because 300 long paths as one list exceed the command line there and the spawn fails.
  describe.skipIf(process.platform === 'win32')('argv seen by git', () => {
    it('commit never hands one spawn more pathspec than the budget, and loses no path', async () => {
      const { dir, git } = await initRepo('ovl-commit-argv-');
      const rels = Array.from({ length: 300 }, (_, i) => fixturePath(i));
      await writeAll(dir, rels, 'v1\n');
      await git.add('.');
      await git.commit('base');
      await writeAll(dir, rels, 'v1\nv2\n');
      const paths = [...rels].sort();

      const invocations = await recordGitArgv(async () => {
        await new GitService().commit(dir, { message: 'bulk', paths });
      });

      assertEveryInvocationIsBudgetedAndLiteral(invocations);
      // Both path-taking steps: the `ls-files` that decides which named paths exist at all, and
      // the `add` that stages them. Unbatched, each carries ~39 KB of paths in one spawn.
      expect(pathspecUnionFor(invocations, 'ls-files', 2)).toEqual(paths);
      expect(pathspecUnionFor(invocations, 'add', 2)).toEqual(paths);
    });

    it('ignoredPaths asks ls-tree about every path in budgeted chunks', async () => {
      const { dir, git } = await initRepo('ovl-ignored-argv-');
      const rels = Array.from({ length: 300 }, (_, i) => fixturePath(i));
      await writeAll(dir, rels, 'v1\n');
      await git.add('.');
      await git.commit('base');
      await writeFile(path.join(dir, '.gitignore'), '*.tex\n');
      await git.add('.gitignore');
      await git.commit('ignore rules');
      const asked = [...rels].sort();

      const invocations = await recordGitArgv(async () => {
        expect(await new GitService().ignoredPaths(dir, asked, { tracked: 'head' })).toEqual([]);
      });

      assertEveryInvocationIsBudgetedAndLiteral(invocations);
      // `check-ignore` reads its paths on STDIN, so it carries no pathspec at all and is not
      // the site at risk; `trackedAtHead`'s `ls-tree` is, and it must cover the whole list.
      expect(pathspecUnionFor(invocations, 'ls-tree', 2)).toEqual(asked);
      const checkIgnore = invocations.filter((a) => a.includes('check-ignore'));
      expect(checkIgnore.length).toBe(1);
      expect(pathspecsOf(checkIgnore[0] ?? [])).toEqual([]);
    });

    it('discard checks out and cleans in budgeted chunks, losing no path', async () => {
      const { dir, git } = await initRepo('ovl-discard-argv-');
      const rels = Array.from({ length: 300 }, (_, i) => fixturePath(i));
      await writeAll(dir, rels, 'v1\n');
      await git.add('.');
      await git.commit('base');
      await writeAll(dir, rels, 'v1\nEDITED\n');
      const paths = [...rels].sort();

      const invocations = await recordGitArgv(async () => {
        await new GitService().discard(dir, paths);
      });

      assertEveryInvocationIsBudgetedAndLiteral(invocations);
      expect(pathspecUnionFor(invocations, 'ls-files', 2)).toEqual(paths);
      // Every tracked path is checked out and every requested path is cleaned — the same two
      // lists one pair of calls would have carried, split across chunks.
      expect(pathspecUnionFor(invocations, 'checkout', 2)).toEqual(paths);
      expect(pathspecUnionFor(invocations, 'clean', 2)).toEqual(paths);
    });

    // `shelve`'s two probes over the paths it is about to take. Unbatched, a shelve of a few
    // hundred long paths handed `ls-tree`/`ls-files`/`diff` one ~39 KB command line each — past
    // Windows' 32,767-character limit.
    it('linkPathsAmong probes HEAD and the index in budgeted chunks, losing no path', async () => {
      const { dir, git } = await initRepo('ovl-links-argv-');
      const rels = Array.from({ length: 300 }, (_, i) => fixturePath(i));
      await writeAll(dir, rels, 'v1\n');
      await git.add('.');
      await git.commit('base');
      const paths = [...rels].sort();

      const invocations = await recordGitArgv(async () => {
        expect(await new GitService().linkPathsAmong(dir, paths)).toEqual([]);
      });

      assertEveryInvocationIsBudgetedAndLiteral(invocations);
      expect(pathspecUnionFor(invocations, 'ls-tree', 2)).toEqual(paths);
      expect(pathspecUnionFor(invocations, 'ls-files', 2)).toEqual(paths);
    });

    it('statAgainstHead diffs in budgeted chunks and reports every changed path', async () => {
      const { dir, git } = await initRepo('ovl-stat-argv-');
      const rels = Array.from({ length: 300 }, (_, i) => fixturePath(i));
      await writeAll(dir, rels, 'v1\n');
      await git.add('.');
      await git.commit('base');
      await writeAll(dir, rels, 'v1\nv2\n');
      const paths = [...rels].sort();

      let stats: Awaited<ReturnType<GitService['statAgainstHead']>> = [];
      const invocations = await recordGitArgv(async () => {
        stats = await new GitService().statAgainstHead(dir, paths);
      });

      assertEveryInvocationIsBudgetedAndLiteral(invocations);
      expect(pathspecUnionFor(invocations, 'diff', 2)).toEqual(paths);
      expect(stats.map((f) => f.path).sort()).toEqual(paths);
      expect(stats.every((f) => f.added === 1 && f.removed === 0)).toBe(true);
    });
  });
});

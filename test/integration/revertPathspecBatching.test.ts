import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod, stat } from 'node:fs/promises';
import { simpleGit, type SimpleGit } from 'simple-git';
import {
  GitService,
  chunkPathspecs,
  MAX_PATHSPEC_ARGV_CHARS,
} from '../../src/services/gitService.js';
import { execCapture } from '../../src/lib/exec.js';

/**
 * `revert` hands git the reverted commit's touched paths as a pathspec list — in the preflight
 * (`status`, `ls-tree`), in the two diffstats and in the scoped unstage. One list, however long,
 * used to go in one spawn, and a commit touching enough files pushed that past Windows'
 * ~32 KB command line (#94). The lists are now chunked by accumulated argument length.
 *
 * What is proved here, and why each part is needed:
 *
 * - **The split happens.** Only the argv a spawn actually received can show that, so one test
 *   puts a recording `git` shim on `PATH` and reads the command lines back. That test is the
 *   one that fails against the unbatched code on Linux/macOS, where a 40 KB argv is legal.
 * - **The chunks combine into exactly one call's answer.** Every probe's result is compared
 *   against ground truth computed from a SINGLE unscoped git call parsed in the test, and the
 *   same body runs at a size that fits in one chunk and at a size that needs five — so a
 *   chunk-combining bug (a union that keeps the last chunk, a reset that stops after the
 *   first) shows up as the two sizes disagreeing with the same ground truth.
 *
 * On Windows the size fixture also exceeds the real command line, so the unbatched code fails
 * these outright there; on POSIX it is legal, hence the shim.
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
 * A ~130-character repo-relative path. Deliberately long and deliberately all in two shared
 * directories: the length is what the chunker is sized against, and sharing the parents keeps
 * the fixture to two `mkdir`s instead of one per file.
 */
const DEEP_DIR = `sections/${'d'.repeat(40)}/${'s'.repeat(35)}`;
function fixturePath(i: number): string {
  return `${DEEP_DIR}/figure-${String(i).padStart(4, '0')}-${'x'.repeat(30)}.tex`;
}

async function initRepo(): Promise<{ dir: string; git: SimpleGit }> {
  const dir = await tmp('ovl-revert-argv-');
  const git = simpleGit(dir);
  await git.raw(['init', '-b', 'master']);
  await git.addConfig('user.email', 'local@example.com');
  await git.addConfig('user.name', 'Local');
  await git.addConfig('core.autocrlf', 'false');
  return { dir, git };
}

async function writeAll(dir: string, rels: string[], content: string): Promise<void> {
  await mkdir(path.join(dir, DEEP_DIR), { recursive: true });
  for (const rel of rels) await writeFile(path.join(dir, rel), content);
}

/**
 * Replace `rel`'s index entry with a mode-120000 (symlink) one, pointing at `target`. Done
 * through plumbing rather than `fs.symlink` so the fixture behaves identically on Windows,
 * where creating a real symlink needs a privilege CI does not have — and the probe under test
 * reads the TREE, which is what a collaborator's committed link looks like here anyway.
 */
async function stageAsLink(dir: string, rel: string, target: string): Promise<void> {
  const hash = await execCapture('git', ['hash-object', '-w', '--stdin'], {
    cwd: dir,
    input: target,
  });
  expect(hash.code).toBe(0);
  const res = await execCapture(
    'git',
    ['update-index', '--add', '--cacheinfo', `120000,${hash.stdout.trim()},${rel}`],
    { cwd: dir },
  );
  expect(res.code).toBe(0);
}

/**
 * Which of `touched` are dirty, from ONE unscoped `git status` parsed here — the answer the
 * batched, pathspec-scoped probe has to reproduce exactly.
 */
async function dirtyGroundTruth(git: SimpleGit, touched: string[]): Promise<string[]> {
  const out = await git.raw(['-c', 'core.quotePath=false', 'status', '--porcelain', '-z']);
  const records = out.split('\0').filter(Boolean);
  const wanted = new Set(touched);
  const dirty = new Set<string>();
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? '';
    const named = [record.slice(3)];
    if (record.slice(0, 2).includes('R') || record.slice(0, 2).includes('C')) {
      const original = records[++i];
      if (original !== undefined) named.push(original);
    }
    for (const rel of named) if (wanted.has(rel)) dirty.add(rel);
  }
  return [...dirty].sort();
}

/** Which of `touched` are mode 120000 in any of `refs`, from one unscoped `ls-tree -r` per ref. */
async function linkGroundTruth(
  git: SimpleGit,
  refs: string[],
  touched: string[],
): Promise<string[]> {
  const wanted = new Set(touched);
  const links = new Set<string>();
  for (const ref of refs) {
    const out = await git.raw(['-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', ref]);
    for (const entry of out.split('\0')) {
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      if (entry.slice(0, entry.indexOf(' ')) !== '120000') continue;
      const rel = entry.slice(tab + 1);
      if (wanted.has(rel)) links.add(rel);
    }
  }
  return [...links].sort();
}

/**
 * One chunk at 6 paths, five at 300 — the same fixture shape either side, so the only thing
 * that differs between the two runs is whether the pathspec list was split.
 */
const SIZES = [
  { label: '6 paths (one chunk — what a single call would do)', count: 6, chunks: 1 },
  { label: '300 long paths (several chunks)', count: 300, chunks: 4 },
] as const;

describe('revert pathspec batching', () => {
  describe.each(SIZES)('$label', ({ count, chunks }) => {
    it('preflight reports exactly what one unscoped call says, however many chunks it took', async () => {
      const { dir, git } = await initRepo();
      const rels = Array.from({ length: count }, (_, i) => fixturePath(i));
      await writeAll(dir, rels, 'v1\n');
      await git.add('.');
      await git.commit('base');
      const base = (await git.revparse(['HEAD'])).trim();

      // The reverted commit touches every path, and turns one of them (deliberately in a LATER
      // chunk, not the first) into a committed symlink.
      const linkRel = rels[Math.floor(count * 0.8)] ?? '';
      await writeAll(dir, rels, 'v1\nv2\n');
      await git.add('.');
      await stageAsLink(dir, linkRel, 'main.tex');
      await git.commit('bulk');
      const bulk = (await git.revparse(['HEAD'])).trim();

      // Dirt at both ends and in the middle, so no single chunk holds all of it.
      await writeFile(path.join(dir, rels[0] ?? ''), 'hand edit\n');
      await rm(path.join(dir, rels[Math.floor(count / 2)] ?? ''));

      const pre = await new GitService().revertPreflight(dir, [bulk]);

      expect(pre.touchedPaths).toEqual([...rels].sort());
      expect(chunkPathspecs(pre.touchedPaths).length).toBeGreaterThanOrEqual(chunks);
      if (chunks === 1) {
        expect(chunkPathspecs(pre.touchedPaths)).toEqual([pre.touchedPaths]);
      } else {
        // The fixture is only worth its runtime if one list really would overflow Windows.
        expect(argvCost(pre.touchedPaths)).toBeGreaterThan(WINDOWS_COMMAND_LINE_LIMIT);
      }

      expect(pre.dirtyPaths).toEqual(await dirtyGroundTruth(git, pre.touchedPaths));
      expect(pre.dirtyPaths).toContain(rels[0]);
      expect(pre.dirtyPaths).toContain(rels[Math.floor(count / 2)]);
      expect(pre.linkPaths).toEqual(await linkGroundTruth(git, [bulk, base, 'HEAD'], rels));
      expect(pre.linkPaths).toEqual([linkRel]);
      expect(pre.stagedPaths).toEqual([]);
      expect(pre.mergeCommits).toEqual([]);
      expect(pre.restoreRef).toBe(base);
    });

    it('apply measures and unstages every chunk, not just the first', async () => {
      const { dir, git } = await initRepo();
      const rels = Array.from({ length: count }, (_, i) => fixturePath(i));
      await writeAll(dir, rels, 'v1\n');
      await git.add('.');
      await git.commit('base');
      const base = (await git.revparse(['HEAD'])).trim();
      await writeAll(dir, rels, 'v1\nv2\n');
      await git.add('.');
      await git.commit('bulk');
      const bulk = (await git.revparse(['HEAD'])).trim();

      const touched = [...rels].sort();
      const res = await new GitService().revertApply(dir, [bulk], touched, base);

      expect(res.status).toBe('reverted');
      expect(res.conflictPaths).toEqual([]);
      // The diffstat is the union over the chunks: one entry per touched path, each the one
      // line the reverted commit added. Keeping only a single chunk's output would give 60.
      expect(res.files).toHaveLength(count);
      expect(res.filesChanged).toBe(count);
      expect(res.files.map((f) => f.path).sort()).toEqual(touched);
      expect([...new Set(res.files.map((f) => `${f.added}/${f.removed}`))]).toEqual(['0/1']);
      // The tree now matches `base`, so nothing is mismatched — measured over every chunk too.
      expect(res.mismatchedFiles).toEqual([]);

      // The unstage covered every chunk: a reset that stopped after the first would leave the
      // rest of the reverted tree staged, which is the promise `revert` makes ("working tree
      // only"). Asserted against git, not against the return value.
      expect((await git.raw(['diff', '--cached', '--name-only'])).trim()).toBe('');
      expect((await git.revparse(['HEAD'])).trim()).toBe(bulk);
      expect(await exists(path.join(dir, '.git', 'REVERT_HEAD'))).toBe(false);
      for (const i of [0, Math.floor(count / 2), count - 1]) {
        expect(await readFile(path.join(dir, rels[i] ?? ''), 'utf8')).toBe('v1\n');
      }
    });
  });

  // Observing the spawns themselves needs a recording `git` earlier on PATH than the real one.
  // A shell shim is POSIX-only; on Windows the same regression is caught by the tests above,
  // because 300 long paths as one list exceed the command line there and the spawn fails.
  describe.skipIf(process.platform === 'win32')('argv seen by git', () => {
    it('never hands one spawn more pathspec than the budget, and loses no path', async () => {
      const { dir, git } = await initRepo();
      const rels = Array.from({ length: 300 }, (_, i) => fixturePath(i));
      await writeAll(dir, rels, 'v1\n');
      await git.add('.');
      await git.commit('base');
      await writeAll(dir, rels, 'v1\nv2\n');
      await git.add('.');
      await git.commit('bulk');
      const bulk = (await git.revparse(['HEAD'])).trim();

      const which = await execCapture('sh', ['-c', 'command -v git']);
      expect(which.code).toBe(0);
      const realGit = which.stdout.trim();

      const shimDir = await tmp('ovl-git-shim-');
      const logFile = path.join(shimDir, 'argv.log');
      await writeFile(
        path.join(shimDir, 'git'),
        // Records this invocation's argv (NUL-separated, RS-terminated) and then runs the real
        // git, so the service under test still talks to real git and real results still hold.
        `#!/bin/sh\nprintf '%s\\0' "$@" >> "$WLM_ARGV_LOG"\nprintf '\\036' >> "$WLM_ARGV_LOG"\nexec "$WLM_REAL_GIT" "$@"\n`,
      );
      await chmod(path.join(shimDir, 'git'), 0o755);

      const prevPath = process.env.PATH;
      process.env.WLM_ARGV_LOG = logFile;
      process.env.WLM_REAL_GIT = realGit;
      process.env.PATH = `${shimDir}${path.delimiter}${prevPath ?? ''}`;
      let pre;
      try {
        pre = await new GitService().revertPreflight(dir, [bulk]);
      } finally {
        process.env.PATH = prevPath;
        delete process.env.WLM_ARGV_LOG;
        delete process.env.WLM_REAL_GIT;
      }
      expect(pre.touchedPaths).toHaveLength(300);

      const log = await readFile(logFile, 'utf8');
      const invocations = log
        .split('\u001e')
        .filter((rec) => rec.length > 0)
        .map((rec) => rec.split('\0').filter(Boolean));
      expect(invocations.length).toBeGreaterThan(0);

      /** The pathspec tail of an invocation: everything after its `--` separator. */
      const pathspecsOf = (args: string[]): string[] => {
        const sep = args.indexOf('--');
        return sep < 0 ? [] : args.slice(sep + 1);
      };
      /** Index of the subcommand: the first non-option argument, skipping each `-c <value>`. */
      const subcommandAt = (args: string[]): number => {
        for (let i = 0; i < args.length; i++) {
          const a = args[i] ?? '';
          if (a === '-c') {
            i++;
            continue;
          }
          if (!a.startsWith('-')) return i;
        }
        return -1;
      };

      for (const args of invocations) {
        // The bound the constant exists to keep. Unbatched, the `status` call alone carries
        // ~39 KB of paths here and this is what fails.
        expect(argvCost(pathspecsOf(args))).toBeLessThanOrEqual(MAX_PATHSPEC_ARGV_CHARS);
        expect(argvCost(args)).toBeLessThan(WINDOWS_COMMAND_LINE_LIMIT);
        if (pathspecsOf(args).length === 0) continue;
        // The guarantees that must survive the batching, on EVERY chunk: a literal pathspec,
        // and the global option placed before the subcommand rather than after it.
        const sub = subcommandAt(args);
        expect(args).toContain('--literal-pathspecs');
        expect(args.indexOf('--literal-pathspecs')).toBeLessThan(sub);
        // Both path-RETURNING probes also keep `core.quotePath=false` on every chunk, or a
        // non-ASCII path would come back C-quoted from some chunks and plain from others.
        expect(args).toContain('core.quotePath=false');
        expect(args.indexOf('core.quotePath=false')).toBeLessThan(sub);
      }

      // Per subcommand: the chunks partition the path list — their union is every touched
      // path, and no chunk repeats one within a pass. A chunk quietly dropped shows up here,
      // rather than as a result that happens to look plausible.
      for (const sub of ['status', 'ls-tree']) {
        const calls = invocations.filter((a) => a.includes(sub) && pathspecsOf(a).length > 0);
        expect(calls.length).toBeGreaterThanOrEqual(2);
        const seen = calls.flatMap((args) => pathspecsOf(args));
        // `ls-tree` runs its whole chunk sequence once per ref (HEAD, the commit, its parent),
        // so the list repeats per ref — a whole number of full passes, never a partial one.
        expect(new Set(seen).size).toBe(300);
        expect(seen.length % 300).toBe(0);
        expect([...new Set(seen)].sort()).toEqual(pre.touchedPaths);
      }
    });
  });
});

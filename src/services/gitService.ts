import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { simpleGit, type SimpleGit } from 'simple-git';
import { authenticateUrl, type AuthConfig, type CommitIdentity } from './auth.js';
import { parseConflictHunks, type ConflictFile } from '../lib/conflictParser.js';
import { toPosix } from '../lib/paths.js';

const DEFAULT_IDENTITY: CommitIdentity = { name: 'WebLatexMCP', email: 'web-latex-mcp@localhost' };

export type SyncAction = 'cloned' | 'pulled' | 'up-to-date' | 'diverged';

export interface SyncResult {
  action: SyncAction;
  ahead: number;
  behind: number;
  diverged: boolean;
}

export interface StatusResult {
  branch: string;
  ahead: number;
  behind: number;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
}

export interface DiffResult {
  diff: string;
  files: DiffFile[];
}

export type PushStatus = 'pushed' | 'conflict' | 'nothing-to-push' | 'awaiting-approval';

/** Both sides of a rebase conflict, surfaced for a human to adjudicate. */
export interface ConflictReport {
  files: ConflictFile[];
  /** The ref we rebased onto (e.g. `origin/master`). */
  rebasedOnto: string;
  guidance: string;
}

export interface SafePushResult {
  status: PushStatus;
  pushed: boolean;
  remote: string;
  branch: string;
  summary: string;
  /** Set when the push created the commit itself (uncommitted work + a message). */
  committedSha?: string;
  /** Number of commits pushed, when `status === 'pushed'`. */
  pushedCommits?: number;
  /** Present iff `status === 'conflict'`. */
  conflict?: ConflictReport;
}

export interface BranchPrepareResult {
  status: 'awaiting-approval';
  branch: string;
  base: string;
  committedSha: string;
  diff: string;
  files: DiffFile[];
  summary: string;
}

type RebaseOutcome = { ok: true } | { ok: false; conflicts: ConflictFile[] };

/**
 * Wraps git operations via the system `git` CLI (through simple-git). Auth is injected
 * in-memory per network call and never persisted to .git/config.
 */
export class GitService {
  constructor(private readonly identity: CommitIdentity = DEFAULT_IDENTITY) {}

  /** Stage and commit locally. Does not push. */
  async commit(
    dir: string,
    opts: { message: string; paths?: string[]; allowEmpty?: boolean },
  ): Promise<{ committed: boolean; sha: string; filesChanged: number; files: DiffFile[] }> {
    const git = simpleGit(dir);
    if (opts.paths && opts.paths.length > 0) {
      await git.add(opts.paths);
    } else {
      await git.add(['-A']);
    }
    const staged = (await git.diff(['--cached', '--name-only'])).split('\n').filter(Boolean);
    if (staged.length === 0 && !opts.allowEmpty) {
      throw new Error('Nothing to commit (no staged changes).');
    }
    // Capture the staged per-file line counts before committing — once committed, the
    // `--cached` diff is empty. Drives the diffstat surfaced by the commit tool.
    const files = parseNumstat(await git.diff(['--cached', '--numstat']));
    // Identity is supplied per-invocation with -c, so we never mutate the repo config.
    const args = [
      '-c',
      `user.name=${this.identity.name}`,
      '-c',
      `user.email=${this.identity.email}`,
      'commit',
      '-m',
      opts.message,
    ];
    if (opts.allowEmpty) args.push('--allow-empty');
    await git.raw(args);
    const sha = (await git.revparse(['HEAD'])).trim();
    return { committed: true, sha, filesChanged: staged.length, files };
  }

  /** Discard uncommitted changes (working tree + untracked), optionally limited to paths. */
  async discard(dir: string, paths?: string[]): Promise<{ discarded: boolean }> {
    const git = simpleGit(dir);
    if (paths && paths.length > 0) {
      await git.checkout(['--', ...paths]);
      await git.clean('f', ['--', ...paths]);
    } else {
      await git.checkout(['--', '.']);
      await git.clean('fd');
    }
    return { discarded: true };
  }

  /**
   * Safe push (default mode). Commits pending work (if a message is given), rebases onto the
   * latest remote, rebases once more immediately before pushing to shrink the sync-lag window,
   * then pushes. Never force-pushes. A rebase conflict aborts the rebase and is reported as
   * `status: 'conflict'` with both sides of each hunk — it is never auto-resolved.
   */
  async safePush(
    dir: string,
    gitUrl: string,
    auth: AuthConfig,
    opts: { commitMessage?: string; paths?: string[] } = {},
  ): Promise<SafePushResult> {
    const git = simpleGit(dir);
    const branch = await this.currentBranch(git);

    // Rebase needs a clean tree. In the normal flow the work is already committed; if it isn't,
    // commit it first (a message is required), otherwise refuse rather than rebase a dirty tree.
    let committedSha: string | undefined;
    if (!(await git.status()).isClean()) {
      if (!opts.commitMessage) {
        throw new Error(
          'Working tree has uncommitted changes. Commit them first (or pass a message to ' +
            'push to commit them), or discard them.',
        );
      }
      committedSha = (await this.commit(dir, { message: opts.commitMessage, paths: opts.paths }))
        .sha;
    }

    const first = await this.fetchAndRebase(git, dir, gitUrl, auth, branch);
    if (!first.ok) return this.conflictResult(gitUrl, branch, first.conflicts);

    if ((await this.aheadBehindOf(git)).ahead === 0) {
      return this.nothingToPush(gitUrl, branch, committedSha);
    }

    // Second rebase right before the push: catch anything that landed in the meantime.
    const second = await this.fetchAndRebase(git, dir, gitUrl, auth, branch);
    if (!second.ok) return this.conflictResult(gitUrl, branch, second.conflicts);

    const ab = await this.aheadBehindOf(git);
    if (ab.ahead === 0) return this.nothingToPush(gitUrl, branch, committedSha);

    await this.withAuth(git, gitUrl, auth, () => git.push(['origin', branch]));
    return {
      status: 'pushed',
      pushed: true,
      remote: gitUrl,
      branch,
      summary: `Pushed ${ab.ahead} commit(s) to origin/${branch}.`,
      committedSha,
      pushedCommits: ab.ahead,
    };
  }

  /**
   * Branch-review mode, phase 1. Commit the working-tree changes onto a local feature branch
   * (kept local — never pushed) and return the full diff against `base` for human review.
   */
  async prepareBranch(
    dir: string,
    opts: { branch: string; message: string; paths?: string[]; base?: string },
  ): Promise<BranchPrepareResult> {
    const git = simpleGit(dir);
    const base = opts.base ?? (await this.currentBranch(git));

    // Create or reset the feature branch at the current commit, carrying the working-tree edits
    // over, then commit them there. The base branch pointer stays put.
    await git.raw(['checkout', '-B', opts.branch]);
    const committed = await this.commit(dir, { message: opts.message, paths: opts.paths });

    const range = `${base}...${opts.branch}`;
    const [diff, numstat] = await Promise.all([git.diff([range]), git.diff([range, '--numstat'])]);

    return {
      status: 'awaiting-approval',
      branch: opts.branch,
      base,
      committedSha: committed.sha,
      diff,
      files: parseNumstat(numstat),
      summary:
        `Committed ${committed.sha.slice(0, 8)} to local branch "${opts.branch}" ` +
        `(${committed.filesChanged} file(s)). Review the diff vs ${base}, then approve to land it.`,
    };
  }

  /**
   * Branch-review mode, phase 2 (on approval). Rebase the feature branch onto a freshly fetched
   * base, fast-forward the base to the branch tip, and push the base. Never force-pushes; a
   * rebase conflict aborts and is surfaced exactly like {@link safePush}.
   */
  async landBranch(
    dir: string,
    gitUrl: string,
    auth: AuthConfig,
    opts: { branch: string; base?: string },
  ): Promise<SafePushResult> {
    const git = simpleGit(dir);
    const base = opts.base ?? (await this.resolveDefaultBranch(git));

    await this.withAuth(git, gitUrl, auth, () => git.fetch(['origin']));

    await git.raw(['checkout', opts.branch]);
    const rebased = await this.tryRebase(dir, git, () => git.raw(['rebase', `origin/${base}`]));
    if (!rebased.ok) {
      // Leave the clone on the base branch with the feature branch intact.
      await git.raw(['checkout', base]);
      return this.conflictResult(gitUrl, base, rebased.conflicts);
    }

    await git.raw(['checkout', base]);
    await git.merge(['--ff-only', opts.branch]);
    const ab = await this.aheadBehindOf(git);
    if (ab.ahead === 0) return this.nothingToPush(gitUrl, base);

    await this.withAuth(git, gitUrl, auth, () => git.push(['origin', base]));
    return {
      status: 'pushed',
      pushed: true,
      remote: gitUrl,
      branch: base,
      summary: `Landed branch "${opts.branch}": pushed ${ab.ahead} commit(s) to origin/${base}.`,
      pushedCommits: ab.ahead,
    };
  }

  /** Clone a project, then reset origin to the tokenless URL so no credential is persisted. */
  async clone(gitUrl: string, targetDir: string, auth: AuthConfig, branch?: string): Promise<void> {
    await mkdir(path.dirname(targetDir), { recursive: true });
    const authUrl = authenticateUrl(gitUrl, auth);
    // Keep repo line endings (LF) so edit_file's exact match is deterministic on Windows.
    const options = ['-c', 'core.autocrlf=false', ...(branch ? ['-b', branch] : [])];
    await simpleGit().clone(authUrl, targetDir, options);
    await simpleGit(targetDir).remote(['set-url', 'origin', gitUrl]);
  }

  /** Fetch and fast-forward (ff-only). Surfaces divergence instead of merging. */
  async syncPull(gitUrl: string, dir: string, auth: AuthConfig): Promise<SyncResult> {
    const git = simpleGit(dir);
    await this.withAuth(git, gitUrl, auth, () => git.fetch(['origin']));
    const ab = await this.aheadBehindOf(git);
    if (ab.behind === 0) {
      return { action: 'up-to-date', ahead: ab.ahead, behind: 0, diverged: false };
    }
    if (ab.ahead > 0) {
      return { action: 'diverged', ahead: ab.ahead, behind: ab.behind, diverged: true };
    }
    await git.merge(['--ff-only', `origin/${ab.branch}`]);
    const after = await this.aheadBehindOf(git);
    return { action: 'pulled', ahead: after.ahead, behind: after.behind, diverged: false };
  }

  /** Ahead/behind counts vs the upstream for a clone directory. */
  async aheadBehind(dir: string): Promise<{ branch: string; ahead: number; behind: number }> {
    return this.aheadBehindOf(simpleGit(dir));
  }

  async status(dir: string): Promise<StatusResult> {
    const git = simpleGit(dir);
    const s = await git.status();
    const ab = await this.aheadBehindOf(git);
    const staged = s.files.filter((f) => f.index !== ' ' && f.index !== '?').map((f) => f.path);
    const unstaged = s.files
      .filter((f) => f.working_dir !== ' ' && f.working_dir !== '?')
      .map((f) => f.path);
    return {
      branch: s.current ?? ab.branch,
      ahead: ab.ahead,
      behind: ab.behind,
      clean: s.isClean(),
      staged,
      unstaged,
      untracked: s.not_added,
    };
  }

  async diff(dir: string, opts: { path?: string; staged?: boolean }): Promise<DiffResult> {
    const git = simpleGit(dir);
    const base: string[] = [];
    if (opts.staged) base.push('--cached');
    const patchArgs = [...base];
    const numstatArgs = [...base, '--numstat'];
    if (opts.path) {
      patchArgs.push('--', opts.path);
      numstatArgs.push('--', opts.path);
    }
    const [diff, numstat] = await Promise.all([git.diff(patchArgs), git.diff(numstatArgs)]);
    return { diff, files: parseNumstat(numstat) };
  }

  private async currentBranch(git: SimpleGit): Promise<string> {
    return (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  }

  /** Resolve the clone's default branch from `origin/HEAD`, falling back to `master`. */
  private async resolveDefaultBranch(git: SimpleGit, fallback = 'master'): Promise<string> {
    try {
      const ref = (await git.revparse(['--abbrev-ref', 'origin/HEAD'])).trim();
      const name = ref.replace(/^origin\//, '');
      return name || fallback;
    } catch {
      return fallback;
    }
  }

  /** Fetch origin, then `pull --rebase origin <branch>`, reporting any conflict (and aborting). */
  private async fetchAndRebase(
    git: SimpleGit,
    dir: string,
    gitUrl: string,
    auth: AuthConfig,
    branch: string,
  ): Promise<RebaseOutcome> {
    await this.withAuth(git, gitUrl, auth, () => git.fetch(['origin']));
    return this.tryRebase(dir, git, () =>
      this.withAuth(git, gitUrl, auth, () => git.raw(['pull', '--rebase', 'origin', branch])),
    );
  }

  /**
   * Run a rebase operation. On a conflict, read both sides of each conflicted file (before
   * touching anything), abort the rebase to restore the pre-rebase state, and return the
   * conflict detail. Any non-conflict failure is rethrown (after clearing a dangling rebase).
   */
  private async tryRebase(
    dir: string,
    git: SimpleGit,
    op: () => Promise<unknown>,
  ): Promise<RebaseOutcome> {
    try {
      await op();
      return { ok: true };
    } catch (err) {
      const unmerged = (await git.raw(['diff', '--name-only', '--diff-filter=U']))
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (unmerged.length === 0) {
        // Not a conflict (e.g. a network/auth failure). Don't leave a rebase half-applied.
        await this.abortRebaseIfInProgress(git);
        throw err;
      }
      const conflicts: ConflictFile[] = [];
      for (const rel of unmerged) {
        const content = await readFile(path.join(dir, rel), 'utf8');
        conflicts.push({ path: toPosix(rel), hunks: parseConflictHunks(content) });
      }
      await git.raw(['rebase', '--abort']);
      return { ok: false, conflicts };
    }
  }

  private async abortRebaseIfInProgress(git: SimpleGit): Promise<void> {
    try {
      await git.raw(['rebase', '--abort']);
    } catch {
      // No rebase in progress — nothing to abort.
    }
  }

  private conflictResult(
    gitUrl: string,
    branch: string,
    conflicts: ConflictFile[],
  ): SafePushResult {
    return {
      status: 'conflict',
      pushed: false,
      remote: gitUrl,
      branch,
      summary:
        `Rebase onto origin/${branch} conflicts in ${conflicts.length} file(s). The rebase was ` +
        'aborted and nothing was pushed — a human must resolve the overlap (see docs/CONCURRENCY.md).',
      conflict: {
        files: conflicts,
        rebasedOnto: `origin/${branch}`,
        guidance:
          'The agent and someone editing on the remote touched the same lines. The local clone ' +
          'is back to its pre-push state (nothing half-merged). Review each hunk — `local` is our ' +
          'version, `remote` is what landed upstream — choose the merged text, then commit and ' +
          'push again. Never force-push.',
      },
    };
  }

  private nothingToPush(gitUrl: string, branch: string, committedSha?: string): SafePushResult {
    return {
      status: 'nothing-to-push',
      pushed: false,
      remote: gitUrl,
      branch,
      summary: 'Nothing to push; already up to date with the remote.',
      committedSha,
    };
  }

  private async aheadBehindOf(
    git: SimpleGit,
  ): Promise<{ branch: string; ahead: number; behind: number }> {
    const branch = await this.currentBranch(git);
    try {
      const out = await git.raw([
        'rev-list',
        '--left-right',
        '--count',
        `${branch}...origin/${branch}`,
      ]);
      const [ahead, behind] = out
        .trim()
        .split(/\s+/)
        .map((n) => Number(n));
      return { branch, ahead: ahead ?? 0, behind: behind ?? 0 };
    } catch {
      // No upstream tracking ref yet (e.g. before first fetch).
      return { branch, ahead: 0, behind: 0 };
    }
  }

  /** Run `fn` with origin temporarily pointed at the authenticated URL, then restore. */
  private async withAuth(
    git: SimpleGit,
    gitUrl: string,
    auth: AuthConfig,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    const authUrl = authenticateUrl(gitUrl, auth);
    if (authUrl === gitUrl) {
      await fn();
      return;
    }
    await git.remote(['set-url', 'origin', authUrl]);
    try {
      await fn();
    } finally {
      await git.remote(['set-url', 'origin', gitUrl]);
    }
  }
}

/** Parse `git diff --numstat` output into per-file added/removed counts. */
function parseNumstat(numstat: string): DiffFile[] {
  return numstat
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...rest] = line.split('\t');
      return {
        path: rest.join('\t'),
        added: added === '-' ? 0 : Number(added),
        removed: removed === '-' ? 0 : Number(removed),
      };
    });
}

import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { simpleGit, type SimpleGit, type StatusResult as GitStatusSummary } from 'simple-git';
import { authenticateUrl, type AuthConfig, type CommitIdentity } from './auth.js';
import { parseConflictHunks, type ConflictHunk } from '../lib/conflictParser.js';
import { isBibFile } from '../lib/bib.js';
import { toPosix } from '../lib/paths.js';
import { execCapture } from '../lib/exec.js';

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
  /** Local commits not yet on the remote (newest first) — what a push would send. */
  aheadCommits: RemoteCommit[];
  /** Remote commits not yet local (newest first) — what landed upstream since the last sync. */
  behindCommits: RemoteCommit[];
}

export interface ResetToRemoteResult {
  branch: string;
  /** Commit now checked out (the current `origin/<branch>` tip). */
  remoteHead: string;
  /** Local commits that were ahead of the remote and are now discarded, newest first. */
  discardedCommits: RemoteCommit[];
  /** Whether the working tree had uncommitted changes (now discarded) before the reset. */
  hadUncommittedChanges: boolean;
  reset: boolean;
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

export type PushStatus =
  | 'pushed'
  | 'conflict'
  | 'nothing-to-push'
  | 'awaiting-approval'
  | 'remote-moved';

/**
 * A conflicted file, with everything needed for a 3-way merge: the full content of all three
 * sides plus a marker view of just the overlapping hunks. A side is `null` when the file did not
 * exist there (added/deleted on one side), which is itself the signal for an add/delete conflict.
 */
export interface ConflictFileDetail {
  path: string;
  /** Full content at the merge-base (common ancestor). `null` if the file is new to both sides. */
  base: string | null;
  /** Full content of our (local) version — the commit(s) being replayed. `null` if we removed it. */
  ours: string | null;
  /** Full content of the remote version that landed upstream. `null` if it isn't there. */
  theirs: string | null;
  /** Compact view of just the overlapping regions (an addition to, not a substitute for, the sides). */
  hunks: ConflictHunk[];
}

/** A commit that landed on the remote that we did not have locally. */
export interface RemoteCommit {
  hash: string;
  /** Commit subject (first line of the message). */
  message: string;
  /** Files the commit touched, with added/removed line counts (empty for e.g. a merge commit). */
  files: DiffFile[];
}

/** Both sides of a rebase conflict, surfaced for a human (or agent) to adjudicate. */
export interface ConflictReport {
  files: ConflictFileDetail[];
  /** Every conflicted path — the scope, up front. */
  conflictPaths: string[];
  /** The ref we rebased onto (e.g. `origin/master`). */
  rebasedOnto: string;
  /** Commit id of the remote head we conflicted against (`origin/<branch>`). */
  remoteHead: string;
  /**
   * Merge-base commit sha (common ancestor of `ours` and `theirs`), or `null` if unrelated. Read
   * any file's `base` side with `read_file(path, ref=<mergeBase>)` — essential for a multi-hunk
   * 3-way merge, where the base is what distinguishes "they changed it" from "we both changed it".
   */
  mergeBase: string | null;
  /** The remote commits we did not have — what landed upstream — newest first. */
  remoteCommits: RemoteCommit[];
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
  /** New local HEAD after a successful push (the tip now on the remote). */
  pushedSha?: string;
  /**
   * Remote commits our change was rebased over (what landed underneath it), newest first. On
   * `remote-moved`, also the commit(s) that won the last race — which nothing was replayed onto.
   */
  rebasedOver?: RemoteCommit[];
  /** Present iff `status === 'conflict'`. */
  conflict?: ConflictReport;
  /**
   * Present iff `status === 'remote-moved'`: the `origin/<branch>` tip as of the last fetch — the
   * push lost the race every retry round; nothing was pushed and the clone is intact.
   */
  remoteHead?: string;
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

type RebaseOutcome = { ok: true } | { ok: false; report: ConflictReport };

/** One conflicted file's merged, ready-to-commit full content, authored to resolve a conflict. */
export interface ConflictResolution {
  /** POSIX path relative to the project root — matches a `ConflictReport` file path. */
  path: string;
  /** The full merged file content that replaces both sides of the conflict. */
  content: string;
}

/** A rebase step that leaves any conflict in the working tree (does NOT abort) for resolution. */
type RebaseStep = { ok: true } | { ok: false; unmerged: string[] };

/**
 * A rebase step aborted (or never even started) because the remote has a commit adding a path
 * that already exists, untracked, in the working tree — git refuses to silently clobber content
 * it doesn't track. The clone is left at its pre-push state; nothing was pushed. `paths` names
 * the colliding file(s) when git's own error names them, and is empty when it didn't.
 */
export class UntrackedOverwriteError extends Error {
  readonly paths: string[];

  constructor(paths: string[]) {
    super(UntrackedOverwriteError.buildMessage(paths));
    this.name = 'UntrackedOverwriteError';
    this.paths = paths;
  }

  private static buildMessage(paths: string[]): string {
    const nothingPushed =
      'The rebase a push needs was aborted. Nothing was pushed; the clone is back to its ' +
      'pre-push state.';
    if (paths.length === 0) {
      return (
        `${nothingPushed} An incoming commit would overwrite an untracked file already in the ` +
        'working tree, but git did not name it — check `status` for untracked files that might ' +
        'collide with the remote. Commit the colliding file (`commit` with `scope: "all"`) so the ' +
        'next push surfaces a proper conflict instead of this abort, or delete/move it, then read ' +
        'the remote version with read_file(path, ref="origin/<branch>").'
      );
    }
    return (
      `${nothingPushed} The remote has a commit adding ${paths.join(', ')}, which already ` +
      `exist${paths.length === 1 ? 's' : ''} untracked in the working tree. Commit ` +
      `${paths.length === 1 ? 'it' : 'them'} (\`commit\` with \`scope: "all"\`) so the next push ` +
      `surfaces a proper conflict instead of this abort, or delete/move ` +
      `${paths.length === 1 ? 'it' : 'them'}, then read the remote version with ` +
      'read_file(path, ref="origin/<branch>").'
    );
  }
}

/**
 * True when a `git push` failure is a plain non-fast-forward rejection — the remote gained a
 * commit we don't have (a collaborator's Overleaf edit landing between our last fetch and the
 * push) — as opposed to an auth failure, a network error, or a server-side hook refusal
 * (`[remote rejected] ... (pre-receive hook declined)`, which is a different bracket phrase
 * entirely and must never be retried). Matched case-insensitively against git/simple-git's raw
 * stderr, which is not a stable API but is the only signal available.
 */
export function isNonFastForwardRejection(message: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes('[rejected]') &&
    (lower.includes('fetch first') || lower.includes('non-fast-forward'))
  );
}

/** How many pull-rebase-then-push rounds `safePush`/`resolvePush` attempt before giving up. */
const PUSH_RETRY_ROUNDS = 3;

/** Outcome of {@link GitService.pushWithRetry}. */
type PushRetryOutcome =
  | { ok: true; rebasedOver: RemoteCommit[] }
  | { ok: false; kind: 'conflict'; report: ConflictReport }
  | { ok: false; kind: 'remote-moved'; remoteHead: string; rebasedOver: RemoteCommit[] };

/**
 * Wraps git operations via the system `git` CLI (through simple-git). Auth is injected
 * in-memory per network call and never persisted to .git/config.
 */
export class GitService {
  constructor(
    private readonly identity: CommitIdentity = DEFAULT_IDENTITY,
    /**
     * Test-only seam (mirrors the injectable `run` in `compiler.ts`'s `probeOnPath`): called
     * immediately before each `git push` attempt, so a test can simulate a collaborator's push
     * landing in the gap between our fetch and our push.
     */
    private readonly hooks: { beforePush?: (attempt: number) => Promise<void> } = {},
  ) {}

  /** Stage and commit locally. Does not push. */
  async commit(
    dir: string,
    opts: { message: string; paths?: string[]; allowEmpty?: boolean; fromHead?: boolean },
  ): Promise<{ committed: boolean; sha: string; filesChanged: number; files: DiffFile[] }> {
    const git = simpleGit(dir);
    if (opts.fromHead) {
      // Start from HEAD so nothing another call left staged (a peer's `commitContents` that threw
      // mid-way, a hand `git add` in the clone) can leak into this commit. Without `-u` the working
      // tree is untouched.
      await git.raw(['read-tree', '--reset', 'HEAD']);
    }
    if (opts.paths && opts.paths.length > 0) {
      await git.add(['--', ...opts.paths]);
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

  /**
   * Commit exact file contents, regardless of what the working tree currently holds.
   *
   * This is how one session commits only its own changes while its peers' edits sit uncommitted
   * in the shared working tree: the index is reset to HEAD, the given contents are written
   * straight into it as blobs, and the commit is made from the index alone — no `add`, no `-a`,
   * and not a single byte of the working tree is touched.
   *
   * A null `content` stages the file's deletion.
   */
  async commitContents(
    dir: string,
    opts: {
      message: string;
      files: Array<{ path: string; content: string | null }>;
      allowEmpty?: boolean;
    },
  ): Promise<{ committed: boolean; sha: string; filesChanged: number; files: DiffFile[] }> {
    const git = simpleGit(dir);
    // Start from HEAD so nothing another call left staged can leak into this commit. Without
    // `-u` the working tree is left exactly as it is.
    await git.raw(['read-tree', '--reset', 'HEAD']);

    for (const file of opts.files) {
      const rel = toPosix(file.path);
      if (file.content === null) {
        await git.raw(['update-index', '--force-remove', '--', rel]);
        continue;
      }
      const mode = (await this.indexMode(git, rel)) ?? '100644';
      const sha = await this.hashObject(dir, rel, file.content);
      await git.raw(['update-index', '--add', '--cacheinfo', `${mode},${sha},${rel}`]);
    }

    const staged = (await git.diff(['--cached', '--name-only'])).split('\n').filter(Boolean);
    if (staged.length === 0 && !opts.allowEmpty) {
      throw new Error('Nothing to commit (no staged changes).');
    }
    const files = parseNumstat(await git.diff(['--cached', '--numstat']));
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

  /** Read a path's content at a commit-ish, or null when it does not exist there. */
  async readAtRef(dir: string, ref: string, relPath: string): Promise<string | null> {
    return this.showOrNull(simpleGit(dir), ref, toPosix(relPath));
  }

  /** Write `content` into the object database and return its blob sha. */
  private async hashObject(dir: string, relPath: string, content: string): Promise<string> {
    const res = await execCapture('git', ['hash-object', '-w', '--stdin', '--path', relPath], {
      cwd: dir,
      input: content,
    });
    if (res.code !== 0) {
      throw new Error(`git hash-object failed for "${relPath}": ${res.stderr.trim()}`);
    }
    return res.stdout.trim();
  }

  /** A tracked path's index mode, so staging preserves it (e.g. an executable). */
  private async indexMode(git: SimpleGit, relPath: string): Promise<string | null> {
    const out = await git.raw(['ls-files', '-s', '--', relPath]);
    return out.trim().split(/\s+/)[0] || null;
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
   * Rewind the clone to the current remote head — the safe recovery from a push conflict. Fetches,
   * then hard-resets to `origin/<branch>` and removes untracked files, so the working tree ends up
   * clean at exactly what is on the remote, ready for edits to be re-applied. Destructive: it drops
   * local commits ahead of the remote and any uncommitted changes, so it reports what it discarded
   * (the ahead commits, and whether the tree was dirty) captured *before* the reset. It never merges
   * or pushes — the caller redoes and re-pushes their edits. Callers must gate this behind explicit
   * confirmation and serialize it per project like other mutating operations.
   */
  async resetToRemote(dir: string, gitUrl: string, auth: AuthConfig): Promise<ResetToRemoteResult> {
    const git = simpleGit(dir);
    const branch = await this.currentBranch(git);

    // Fetch so we land on the *current* remote head, not a stale one — the whole point is to redo
    // edits against what actually landed upstream.
    await this.withAuth(git, gitUrl, auth, () => git.fetch(['origin']));
    const remoteRef = `origin/${branch}`;
    if ((await this.revParseOrNull(git, remoteRef)) === null) {
      throw new Error(
        `No tracking ref ${remoteRef} to reset onto (has the project been pushed/cloned?).`,
      );
    }

    // Capture what we're about to throw away, before the reset erases the evidence.
    const discardedCommits = await this.logCommits(git, `${remoteRef}..${branch}`);
    const hadUncommittedChanges = !(await git.status()).isClean();

    await git.raw(['reset', '--hard', remoteRef]);
    await git.clean('fd');

    return {
      branch,
      remoteHead: (await git.revparse(['HEAD'])).trim(),
      discardedCommits,
      hadUncommittedChanges,
      reset: true,
    };
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

    // A rebase's checkout step tolerates untracked dirt in place — it only balks at uncommitted
    // changes to files it already tracks. In the normal flow the work is already committed; if
    // it isn't and a message was given, commit it first; if it isn't and tracked files are
    // modified, refuse rather than rebase over them. Untracked-only dirt rides straight through.
    let committedSha: string | undefined;
    const preStatus = await git.status();
    if (!preStatus.isClean()) {
      if (opts.commitMessage) {
        committedSha = (await this.commit(dir, { message: opts.commitMessage, paths: opts.paths }))
          .sha;
      } else {
        const modified = trackedModifiedPaths(preStatus);
        if (modified.length > 0) {
          throw new Error(uncommittedModificationsMessage(modified, preStatus.not_added));
        }
      }
    }

    // Fetch first so we can record what our change will rebase over (surfaced on success).
    await this.withAuth(git, gitUrl, auth, () => git.fetch(['origin']));
    const rebasedOver = await this.logCommits(git, `HEAD..origin/${branch}`);
    const first = await this.tryRebase(dir, git, branch, `origin/${branch}`, () =>
      this.withAuth(git, gitUrl, auth, () => git.raw(['pull', '--rebase', 'origin', branch])),
    );
    if (!first.ok) return this.conflictResult(gitUrl, first.report);

    if ((await this.aheadBehindOf(git)).ahead === 0) {
      return this.nothingToPush(gitUrl, branch, committedSha);
    }

    // Second rebase right before the push: catch anything that landed in the meantime.
    const second = await this.fetchAndRebase(git, dir, gitUrl, auth, branch);
    if (!second.ok) return this.conflictResult(gitUrl, second.report);

    const ab = await this.aheadBehindOf(git);
    if (ab.ahead === 0) return this.nothingToPush(gitUrl, branch, committedSha);

    const retryRebase = (): Promise<RebaseOutcome> =>
      this.tryRebase(dir, git, branch, `origin/${branch}`, () =>
        this.withAuth(git, gitUrl, auth, () => git.raw(['pull', '--rebase', 'origin', branch])),
      );
    const pushResult = await this.pushWithRetry(
      git,
      gitUrl,
      auth,
      branch,
      retryRebase,
      rebasedOver,
      PUSH_RETRY_ROUNDS,
    );
    if (!pushResult.ok) {
      return pushResult.kind === 'conflict'
        ? this.conflictResult(gitUrl, pushResult.report)
        : this.remoteMovedResult(
            gitUrl,
            branch,
            pushResult.remoteHead,
            pushResult.rebasedOver,
            PUSH_RETRY_ROUNDS,
            'Re-run push.',
          );
    }
    return {
      status: 'pushed',
      pushed: true,
      remote: gitUrl,
      branch,
      summary: `Pushed ${ab.ahead} commit(s) to origin/${branch}.`,
      committedSha,
      pushedCommits: ab.ahead,
      pushedSha: (await git.revparse(['HEAD'])).trim(),
      ...(pushResult.rebasedOver.length ? { rebasedOver: pushResult.rebasedOver } : {}),
    };
  }

  /**
   * Resolve a rebase conflict with caller-authored merged content, then push.
   *
   * Re-runs the same pull-rebase that {@link safePush} aborts, but this time — instead of failing
   * safe — applies the caller's merged full-file content for each conflicted file, stages it,
   * continues the rebase, and pushes. The merged text is used **verbatim** as the resolved blob, so
   * the caller is responsible for folding in the remote's non-conflicting edits too (which is why
   * the conflict report hands back `theirs` in full). Nothing is ever auto-merged.
   *
   * The resolution set is validated against the actual conflict: a missing file re-surfaces the
   * full conflict report (naming what was omitted); an extra (non-conflicted) file is rejected by
   * name. A `.bib` file may only be resolved when `confirmBibEdit` is set. If `expectedRemoteHead`
   * is given and the remote advanced past it since the conflict was computed, the push is refused
   * rather than applying a merge against a stale `theirs`. Never force-pushes.
   */
  async resolvePush(
    dir: string,
    gitUrl: string,
    auth: AuthConfig,
    opts: {
      resolutions: ConflictResolution[];
      commitMessage?: string;
      confirmBibEdit?: boolean;
      expectedRemoteHead?: string;
    },
  ): Promise<SafePushResult> {
    // Index resolutions by path; reject duplicates and unconfirmed .bib targets up front.
    const byPath = new Map<string, string>();
    for (const r of opts.resolutions) {
      const rel = toPosix(r.path);
      if (byPath.has(rel)) throw new Error(`Duplicate resolution for "${rel}".`);
      if (isBibFile(rel) && !opts.confirmBibEdit) {
        throw new Error(
          `"${rel}" is a .bib file; resolving it needs explicit approval. Retry with ` +
            'confirmBibEdit: true once the user has confirmed the merged bibliography.',
        );
      }
      byPath.set(rel, r.content);
    }

    // `core.editor=true` keeps `rebase --continue` from opening an editor for the replayed commit
    // message; simple-git gates the editor override behind `unsafe.allowUnsafeEditor`.
    const git = simpleGit(dir, {
      unsafe: { allowUnsafeEditor: true },
      config: ['core.editor=true'],
    });
    const branch = await this.currentBranch(git);

    // The work is normally already committed from the earlier (conflicting) push attempt. If the
    // tree is still dirty: untracked-only dirt rides through untouched; a message commits it;
    // otherwise a tracked modification would block the rebase, so refuse rather than proceed.
    let committedSha: string | undefined;
    const preStatus = await git.status();
    if (!preStatus.isClean()) {
      if (opts.commitMessage) {
        committedSha = (await this.commit(dir, { message: opts.commitMessage })).sha;
      } else {
        const modified = trackedModifiedPaths(preStatus);
        if (modified.length > 0) {
          throw new Error(uncommittedModificationsMessage(modified, preStatus.not_added));
        }
      }
    }

    await this.withAuth(git, gitUrl, auth, () => git.fetch(['origin']));
    const rebasedOver = await this.logCommits(git, `HEAD..origin/${branch}`);

    // Race guard: if the caller merged against a specific remote head and the remote has advanced
    // since, `theirs` may now be stale — refuse rather than silently merge over what just landed.
    if (opts.expectedRemoteHead) {
      const currentRemote = await this.revParseOrNull(git, `origin/${branch}`);
      // Resolve the caller's value to a full SHA before comparing — it may be an abbreviated SHA
      // (e.g. the 8-char form we print), which must not be misread as a move from a commit to
      // itself. Fall back to a prefix match if it can't be resolved as a ref.
      const expectedFull = (await this.revParseOrNull(git, opts.expectedRemoteHead)) ?? null;
      const matches = currentRemote
        ? currentRemote === expectedFull ||
          (opts.expectedRemoteHead.length >= 4 && currentRemote.startsWith(opts.expectedRemoteHead))
        : false;
      if (currentRemote && !matches) {
        throw new Error(
          `Remote moved since you computed the merge (origin/${branch} was ` +
            `${expectedFull ?? opts.expectedRemoteHead}, now ${currentRemote}). ` +
            'Nothing was pushed. Re-run push to fetch the current conflict, recompute the merge ' +
            'against the fresh "theirs", and resolve again.',
        );
      }
    }

    // Snapshot HEAD so an invalid resolution set (extra files) can be fully undone after the fact.
    const origHead = (await git.revparse(['HEAD'])).trim();
    const used = new Set<string>();

    // Kick off the rebase; then loop: apply resolutions to whatever is unmerged and continue.
    let step = await this.runRebaseStep(git, () =>
      this.withAuth(git, gitUrl, auth, () => git.raw(['pull', '--rebase', 'origin', branch])),
    );
    // Bound the loop by the number of resolutions (+ slack) so a file that keeps re-conflicting
    // can never spin forever.
    const maxSteps = opts.resolutions.length + 5;
    for (let i = 0; !step.ok; i++) {
      if (i >= maxSteps) {
        await this.abortRebaseIfInProgress(git);
        throw new Error(
          'Rebase did not converge after applying the supplied resolutions; aborted without ' +
            'pushing. Re-pull and try the resolution again.',
        );
      }
      const missing = step.unmerged.filter((rel) => !byPath.has(rel));
      if (missing.length > 0) {
        // Can't resolve without content for every conflicted file — fail safe: build the full
        // report, then abort so the clone returns to its pre-resolve state (nothing half-merged).
        const report = await this.buildConflictReport(
          git,
          dir,
          branch,
          `origin/${branch}`,
          step.unmerged,
        );
        await this.abortRebaseIfInProgress(git);
        report.guidance =
          `No resolution was supplied for: ${missing.join(', ')}. Every conflicted file must be ` +
          `included in "resolutions" (all conflicted paths: ${report.conflictPaths.join(', ')}). ` +
          report.guidance;
        return this.conflictResult(gitUrl, report);
      }
      for (const rel of step.unmerged) {
        await writeFile(path.join(dir, rel), byPath.get(rel) as string, 'utf8');
        await git.add(['--', rel]);
        used.add(rel);
      }
      step = await this.runRebaseStep(git, () => git.raw(['rebase', '--continue']));
    }

    // Reject extra (non-conflicted) resolutions: undo the completed rebase and name them, so a
    // wrong path is an explicit error rather than a silently-ignored no-op.
    const extra = [...byPath.keys()].filter((rel) => !used.has(rel));
    if (extra.length > 0) {
      await git.raw(['reset', '--hard', origHead]);
      throw new Error(
        `These files were not in conflict, so their resolutions were rejected: ${extra.join(', ')}. ` +
          (used.size === 0
            ? 'Nothing conflicted — retry push without "resolutions".'
            : `Only these files conflicted: ${[...used].join(', ')}. Resubmit just those.`),
      );
    }

    const ab = await this.aheadBehindOf(git);
    if (ab.ahead === 0) return this.nothingToPush(gitUrl, branch, committedSha);

    // A retry round here is a plain pull-rebase (no resolutions): any conflict it hits is fresh
    // (against a commit that landed after the one we just resolved), unrelated to `resolutions`,
    // and is reported — never silently retried again with stale content.
    const retryRebase = (): Promise<RebaseOutcome> =>
      this.tryRebase(dir, git, branch, `origin/${branch}`, () =>
        this.withAuth(git, gitUrl, auth, () => git.raw(['pull', '--rebase', 'origin', branch])),
      );
    // When the caller pinned `expectedRemoteHead`, they asked to be refused rather than have their
    // merge silently rebased over a second remote move — one round only, so a lost race here is
    // reported as `remote-moved` (nothing pushed, clone intact) instead of retried.
    const rounds = opts.expectedRemoteHead ? 1 : PUSH_RETRY_ROUNDS;
    const pushResult = await this.pushWithRetry(
      git,
      gitUrl,
      auth,
      branch,
      retryRebase,
      rebasedOver,
      rounds,
    );
    if (!pushResult.ok) {
      return pushResult.kind === 'conflict'
        ? this.conflictResult(gitUrl, pushResult.report)
        : this.remoteMovedResult(
            gitUrl,
            branch,
            pushResult.remoteHead,
            pushResult.rebasedOver,
            rounds,
            'Re-run push.',
          );
    }
    const pushedSha = (await git.revparse(['HEAD'])).trim();
    return {
      status: 'pushed',
      pushed: true,
      remote: gitUrl,
      branch,
      summary: `Resolved conflict and pushed ${ab.ahead} commit(s) to origin/${branch} (${pushedSha.slice(0, 8)}).`,
      committedSha,
      pushedCommits: ab.ahead,
      pushedSha,
      ...(pushResult.rebasedOver.length ? { rebasedOver: pushResult.rebasedOver } : {}),
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
    const rebased = await this.tryRebase(dir, git, opts.branch, `origin/${base}`, () =>
      git.raw(['rebase', `origin/${base}`]),
    );
    if (!rebased.ok) {
      // Leave the clone on the base branch with the feature branch intact.
      await git.raw(['checkout', base]);
      return this.conflictResult(gitUrl, rebased.report);
    }

    await git.raw(['checkout', base]);
    await git.merge(['--ff-only', opts.branch]);
    const ab = await this.aheadBehindOf(git);
    if (ab.ahead === 0) return this.nothingToPush(gitUrl, base);

    // Unlike safePush/resolvePush, landBranch's rebase (feature branch onto origin/base, then an
    // ff-only merge of base) doesn't fit the pull-rebase retry thunk cleanly — so a lost race here
    // is reported as `remote-moved` rather than retried (one attempt, not `PUSH_RETRY_ROUNDS`).
    await this.hooks.beforePush?.(1);
    try {
      await this.withAuth(git, gitUrl, auth, () => git.push(['origin', base]));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isNonFastForwardRejection(message)) throw err;
      await this.withAuth(git, gitUrl, auth, () => git.fetch(['origin']));
      const remoteHead = (await this.revParseOrNull(git, `origin/${base}`)) ?? '';
      const rebasedOver = await this.logCommits(git, `HEAD..origin/${base}`);
      return this.remoteMovedResult(
        gitUrl,
        base,
        remoteHead,
        rebasedOver,
        1,
        `Local ${base} is already fast-forwarded onto "${opts.branch}" and is now ahead of and ` +
          `behind the remote; run push in direct mode (no mode/approve) to pull-rebase ${base} ` +
          `onto the new remote tip and push — the feature branch "${opts.branch}" is intact.`,
      );
    }
    return {
      status: 'pushed',
      pushed: true,
      remote: gitUrl,
      branch: base,
      summary: `Landed branch "${opts.branch}": pushed ${ab.ahead} commit(s) to origin/${base}.`,
      pushedCommits: ab.ahead,
      pushedSha: (await git.revparse(['HEAD'])).trim(),
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
    // Show *what* diverged, not just how far. Uses the last-fetched `origin/<branch>` (status does
    // not fetch), so these reflect known divergence — run project_sync to refresh.
    const [aheadCommits, behindCommits] =
      ab.ahead > 0 || ab.behind > 0
        ? await Promise.all([
            ab.ahead > 0
              ? this.logCommits(git, `origin/${ab.branch}..${ab.branch}`)
              : Promise.resolve([]),
            ab.behind > 0
              ? this.logCommits(git, `${ab.branch}..origin/${ab.branch}`)
              : Promise.resolve([]),
          ])
        : [[], []];
    return {
      branch: s.current ?? ab.branch,
      ahead: ab.ahead,
      behind: ab.behind,
      clean: s.isClean(),
      staged,
      unstaged,
      untracked: s.not_added,
      aheadCommits,
      behindCommits,
    };
  }

  /**
   * Read a committed version of a file at any ref (e.g. `origin/master:sections/04.tex`) without
   * touching the working tree — the way to see `theirs` (the remote side) that a working-tree read
   * can't reach. `relPath` must be repo-relative POSIX (the caller sandboxes it).
   */
  async showAtRef(dir: string, ref: string, relPath: string): Promise<string> {
    if (/^-/.test(ref)) throw new Error(`Invalid ref "${ref}".`);
    try {
      return await simpleGit(dir).show([`${ref}:${relPath}`]);
    } catch {
      throw new Error(`"${relPath}" does not exist at ref "${ref}" (or the ref is unknown).`);
    }
  }

  /**
   * Diff the working tree, optionally against a ref rather than the index. `ref` takes a single
   * commit-ish (`HEAD~3`, `origin/master`, a sha) or a two-dot range (`a..b`), and is resolved
   * before it reaches git so an unknown ref fails with a readable message instead of a raw git
   * error. `staged` is meaningless alongside it, so the pair is rejected rather than silently
   * preferring one.
   */
  async diff(
    dir: string,
    opts: { path?: string; staged?: boolean; ref?: string },
  ): Promise<DiffResult> {
    const git = simpleGit(dir);
    const base: string[] = [];
    if (opts.ref !== undefined) {
      if (opts.staged) {
        throw new Error(
          '`ref` and `staged` cannot be combined: `staged` diffs the index against HEAD, while ' +
            '`ref` diffs the working tree against another commit. Pass one or the other.',
        );
      }
      base.push(await this.resolveDiffRef(git, opts.ref));
    } else if (opts.staged) {
      base.push('--cached');
    }
    // Always terminate the revision list when a ref is in play, so a ref that also names a file
    // ("main.tex" as a branch) is not an ambiguous argument.
    const tail = opts.path ? ['--', opts.path] : opts.ref !== undefined ? ['--'] : [];
    const patchArgs = [...base, ...tail];
    const numstatArgs = [...base, '--numstat', ...tail];
    const [diff, numstat] = await Promise.all([git.diff(patchArgs), git.diff(numstatArgs)]);
    return { diff, files: parseNumstat(numstat) };
  }

  /**
   * Validate a diff ref before handing it to git: each endpoint of a range (and a bare ref) must
   * resolve to a commit in this clone. Returns the caller's spelling — resolving to a sha would
   * only make the error messages harder to recognise.
   */
  private async resolveDiffRef(git: SimpleGit, ref: string): Promise<string> {
    const range = /^(.+?)\.{2,3}(.+)$/.exec(ref);
    const endpoints = range ? [range[1] ?? '', range[2] ?? ''] : [ref];
    for (const endpoint of endpoints) {
      if (endpoint.startsWith('-')) throw new Error(`Invalid ref "${endpoint}".`);
      if ((await this.revParseOrNull(git, `${endpoint}^{commit}`)) === null) {
        throw new Error(
          `Unknown git ref "${endpoint}" — it does not resolve to a commit in this clone. ` +
            'Use a commit sha, "HEAD~N", or a remote-tracking branch such as "origin/master" ' +
            '(run project_sync first if the remote moved).',
        );
      }
    }
    return ref;
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
    return this.tryRebase(dir, git, branch, `origin/${branch}`, () =>
      this.withAuth(git, gitUrl, auth, () => git.raw(['pull', '--rebase', 'origin', branch])),
    );
  }

  /**
   * Run a rebase operation. On a conflict, build the full 3-way conflict report (before touching
   * anything), abort the rebase to restore the pre-rebase state, and return it. Any non-conflict
   * failure is rethrown (after clearing a dangling rebase). `oursRef`/`remoteRef` name the two
   * sides — our commit(s) and the upstream tip they replay onto.
   */
  private async tryRebase(
    dir: string,
    git: SimpleGit,
    oursRef: string,
    remoteRef: string,
    op: () => Promise<unknown>,
  ): Promise<RebaseOutcome> {
    try {
      await op();
      return { ok: true };
    } catch (err) {
      const unmerged = await this.unmergedPaths(git);
      if (unmerged.length === 0) {
        // Not a conflict (e.g. a network/auth failure). Don't leave a rebase half-applied.
        await this.abortRebaseIfInProgress(git);
        throw untrackedOverwriteFromError(err) ?? err;
      }
      // Mid-rebase the branch ref still points at our original tip, so the report is read from
      // refs (valid now); the working tree supplies the marker view before we abort.
      const report = await this.buildConflictReport(git, dir, oursRef, remoteRef, unmerged);
      await git.raw(['rebase', '--abort']);
      return { ok: false, report };
    }
  }

  /**
   * Run one rebase step (start or `--continue`) WITHOUT aborting on conflict. Returns the unmerged
   * paths for a conflict so the caller can resolve them in place; any non-conflict failure aborts a
   * dangling rebase and is rethrown (as {@link tryRebase} does).
   */
  private async runRebaseStep(git: SimpleGit, op: () => Promise<unknown>): Promise<RebaseStep> {
    try {
      await op();
      return { ok: true };
    } catch (err) {
      const unmerged = await this.unmergedPaths(git);
      if (unmerged.length === 0) {
        await this.abortRebaseIfInProgress(git);
        throw untrackedOverwriteFromError(err) ?? err;
      }
      return { ok: false, unmerged };
    }
  }

  private async unmergedPaths(git: SimpleGit): Promise<string[]> {
    return (await git.raw(['diff', '--name-only', '--diff-filter=U']))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * Build the full conflict report for a set of unmerged files: for each, the merge-base (`base`),
   * our version (`ours` = `oursRef`), and the remote version that landed (`theirs` = `remoteRef`),
   * plus a marker view of the overlap. Also gathers the remote head and the commits that landed.
   * Read from refs + the working tree while the rebase is still paused — call before aborting.
   */
  private async buildConflictReport(
    git: SimpleGit,
    dir: string,
    oursRef: string,
    remoteRef: string,
    unmerged: string[],
  ): Promise<ConflictReport> {
    const mergeBase = await this.mergeBaseOrNull(git, oursRef, remoteRef);
    const files: ConflictFileDetail[] = [];
    for (const rel of unmerged) {
      const marker = await readFile(path.join(dir, rel), 'utf8').catch(() => '');
      files.push({
        path: toPosix(rel),
        base: mergeBase ? await this.showOrNull(git, mergeBase, rel) : null,
        ours: await this.showOrNull(git, oursRef, rel),
        theirs: await this.showOrNull(git, remoteRef, rel),
        hunks: parseConflictHunks(marker),
      });
    }
    return {
      files,
      conflictPaths: files.map((f) => f.path),
      rebasedOnto: remoteRef,
      remoteHead: (await this.revParseOrNull(git, remoteRef)) ?? remoteRef,
      mergeBase,
      remoteCommits: await this.logCommits(git, `${oursRef}..${remoteRef}`),
      guidance:
        'We and someone on the remote touched the same lines. The clone is back to its pre-push ' +
        'state (nothing half-merged). For each file, `ours` is our full version, `theirs` is the ' +
        'full version that landed upstream, and `base` is the common ancestor — use all three to ' +
        'compute a merged file that also keeps their non-conflicting edits. Then retry `push` with ' +
        "a `resolutions` array carrying each conflicted file's full merged content. Never force-push. " +
        'Alternatively, `reset_to_remote` (confirm: true) rewinds the clone to the current remote ' +
        'head so you can re-apply your edits cleanly — it discards the local commit shown above.',
    };
  }

  /** `git show <ref>:<path>`, or null if the path does not exist at that ref (add/delete side). */
  private async showOrNull(git: SimpleGit, ref: string, relPath: string): Promise<string | null> {
    try {
      return await git.show([`${ref}:${relPath}`]);
    } catch {
      return null;
    }
  }

  private async revParseOrNull(git: SimpleGit, ref: string): Promise<string | null> {
    try {
      return (await git.revparse([ref])).trim();
    } catch {
      return null;
    }
  }

  private async mergeBaseOrNull(git: SimpleGit, a: string, b: string): Promise<string | null> {
    try {
      return (await git.raw(['merge-base', a, b])).trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Commits in a `A..B` range as {hash, subject, files}, newest first; empty on any error. A
   * NUL-prefixed header line (`%x00%H%x09%s`) is unambiguous against the `--numstat` lines that
   * follow it — the subject may itself contain a tab, so only the header's own NUL marks a new
   * commit.
   */
  private async logCommits(git: SimpleGit, range: string): Promise<RemoteCommit[]> {
    try {
      const out = await git.raw(['log', '--format=%x00%H%x09%s', '--numstat', range]);
      return parseCommitLog(out);
    } catch {
      return [];
    }
  }

  private async abortRebaseIfInProgress(git: SimpleGit): Promise<void> {
    try {
      await git.raw(['rebase', '--abort']);
    } catch {
      // No rebase in progress — nothing to abort.
    }
  }

  private conflictResult(gitUrl: string, report: ConflictReport): SafePushResult {
    const branch = report.rebasedOnto.replace(/^origin\//, '');
    return {
      status: 'conflict',
      pushed: false,
      remote: gitUrl,
      branch,
      summary:
        `Rebase onto ${report.rebasedOnto} conflicts in ${report.files.length} file(s) ` +
        `(${report.conflictPaths.join(', ')}). The rebase was aborted and nothing was pushed — ` +
        'resolve the overlap and push the merged content back (see docs/tools.md).',
      conflict: report,
    };
  }

  /**
   * Push, retrying a lost fast-forward race up to `rounds` times (`PUSH_RETRY_ROUNDS` normally;
   * callers that pinned `expectedRemoteHead` pass 1, since a second lost race should be reported
   * rather than silently rebased over). Each round is the same fetch → pull-rebase → push sequence
   * used elsewhere: on a plain non-fast-forward rejection (a collaborator's commit landing between
   * our last fetch and this push), fetch again (to capture what just landed, prepended to
   * `rebasedOver`) and re-run `rebaseAgain`. A conflict during that re-rebase is returned as-is —
   * never retried again. Any other push error (auth, network, a server-side hook refusal) rethrows
   * immediately, unretried. Exhausting every round leaves the clone exactly where the last rebase
   * left it (no rebase in progress, still ahead), fetches once more, and reports `remote-moved`
   * with the current remote tip — folding that final fetch's commits into `rebasedOver` too, so it
   * accounts for the exact tip `remoteHead` names.
   */
  private async pushWithRetry(
    git: SimpleGit,
    gitUrl: string,
    auth: AuthConfig,
    branch: string,
    rebaseAgain: () => Promise<RebaseOutcome>,
    rebasedOver: RemoteCommit[],
    rounds: number,
  ): Promise<PushRetryOutcome> {
    let over = rebasedOver;
    for (let attempt = 1; attempt <= rounds; attempt++) {
      await this.hooks.beforePush?.(attempt);
      try {
        await this.withAuth(git, gitUrl, auth, () => git.push(['origin', branch]));
        return { ok: true, rebasedOver: over };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isNonFastForwardRejection(message)) throw err;

        if (attempt < rounds) {
          await this.withAuth(git, gitUrl, auth, () => git.fetch(['origin']));
          const justLanded = await this.logCommits(git, `HEAD..origin/${branch}`);
          over = mergeNewestFirst(justLanded, over);
          const outcome = await rebaseAgain();
          if (!outcome.ok) return { ok: false, kind: 'conflict', report: outcome.report };
          continue;
        }

        // Final attempt: fetch once more and fold the commit that just won the race into
        // `over` too, so `rebasedOver` accounts for the exact remote tip named by `remoteHead`
        // — otherwise the landing that caused this very failure would be missing from it.
        await this.withAuth(git, gitUrl, auth, () => git.fetch(['origin']));
        const justLanded = await this.logCommits(git, `HEAD..origin/${branch}`);
        over = mergeNewestFirst(justLanded, over);
        const remoteHead = (await this.revParseOrNull(git, `origin/${branch}`)) ?? '';
        return { ok: false, kind: 'remote-moved', remoteHead, rebasedOver: over };
      }
    }
    /* istanbul ignore next -- unreachable: the loop always returns within rounds >= 1 */
    throw new Error('pushWithRetry: exhausted retry rounds without a result.');
  }

  private remoteMovedResult(
    gitUrl: string,
    branch: string,
    remoteHead: string,
    rebasedOver: RemoteCommit[],
    attempts: number,
    recovery: string,
  ): SafePushResult {
    return {
      status: 'remote-moved',
      pushed: false,
      remote: gitUrl,
      branch,
      summary:
        `Remote origin/${branch} moved during the push (now at ${remoteHead.slice(0, 8)}) ` +
        `after ${attempts} attempt(s); nothing was pushed. ${recovery}`,
      remoteHead,
      ...(rebasedOver.length ? { rebasedOver } : {}),
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

/**
 * Tracked files with staged or unstaged changes (modifications, deletions) — never a file git
 * doesn't know about yet. `status.files` covers both index and working-dir changes;
 * `status.not_added` is exactly the untracked set, so excluding it leaves the tracked ones.
 */
function trackedModifiedPaths(status: GitStatusSummary): string[] {
  const notAdded = new Set(status.not_added);
  return status.files.filter((f) => !notAdded.has(f.path)).map((f) => f.path);
}

/** Join at most `max` entries, appending `… N more` for whatever didn't fit. */
function capList(items: string[], max: number): string {
  if (items.length <= max) return items.join(', ');
  const shown = items.slice(0, max);
  return `${shown.join(', ')}, … ${items.length - max} more`;
}

/**
 * Shared message for both `safePush` and `resolvePush` refusing a dirty tree: names the tracked
 * modifications blocking the rebase, and separately reassures that any untracked files present
 * are not why — they ride through a push untouched. Each list is capped (20 modified, 10
 * untracked) so a working tree with hundreds of dirty files doesn't blow up the error text.
 */
function uncommittedModificationsMessage(modified: string[], untracked: string[]): string {
  const untrackedNote =
    untracked.length > 0
      ? `Untracked file(s) never block a push — ${capList(untracked, 10)} will ride along untouched.`
      : 'Untracked files never block a push.';
  return (
    `Uncommitted changes to tracked file(s): ${capList(modified, 20)}. A push has to rebase onto ` +
    'the latest remote, and git cannot rebase over uncommitted modifications to files it already ' +
    "tracks. Commit them first (`commit` takes this session's edits by default, or " +
    '`scope: "all"` for the whole working tree), pass a `message` to push to commit the WHOLE ' +
    "working tree instead (peers' work included, so prefer commit first), or `discard` them. " +
    untrackedNote
  );
}

/**
 * Matches git's refusal to check out (or merge in, mid-rebase) a commit that would overwrite a
 * path already present, untracked, in the working tree. Git uses "checkout" wording for the
 * initial detach and "merge" wording for a later commit applied during the rebase — both are the
 * same underlying refusal, so both are matched. Git also has a sibling wording, "would be
 * *removed* by", for the case where the incoming commit deletes a tracked file that collides with
 * an untracked one of the same path — same underlying refusal, matched too.
 */
const UNTRACKED_OVERWRITE_RE =
  /following untracked working tree files would be (?:overwritten|removed) by (?:checkout|merge)/i;

/** Pull the indented file list out of git's "would be overwritten" error text. */
function parseUntrackedOverwritePaths(message: string): string[] {
  const lines = message.split('\n');
  const start = lines.findIndex((line) => UNTRACKED_OVERWRITE_RE.test(line));
  if (start === -1) return [];
  const paths: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.startsWith('\t')) break;
    const trimmed = line.replace(/^\t/, '').trim();
    if (!trimmed) break;
    paths.push(toPosix(trimmed));
  }
  return paths;
}

/** Recognise git's "would be overwritten" refusal in a caught error and turn it into our type. */
function untrackedOverwriteFromError(err: unknown): UntrackedOverwriteError | null {
  const message = err instanceof Error ? err.message : String(err);
  if (!UNTRACKED_OVERWRITE_RE.test(message)) return null;
  return new UntrackedOverwriteError(parseUntrackedOverwritePaths(message));
}

/** Prepend `justLanded` (newest first) onto `existing`, dropping any hash already present. */
function mergeNewestFirst(justLanded: RemoteCommit[], existing: RemoteCommit[]): RemoteCommit[] {
  const seen = new Set(existing.map((c) => c.hash));
  return [...justLanded.filter((c) => !seen.has(c.hash)), ...existing];
}

/** Parse one `--numstat` line (`added\tremoved\tpath`) into a {@link DiffFile}, `-` counts as 0. */
function parseNumstatLine(line: string): DiffFile {
  const [added, removed, ...rest] = line.split('\t');
  return {
    // Rename paths ("old => new", "{a => b}/x") are a single field with no tab in them — keep the
    // raw string as-is rather than trying to split it into two paths.
    path: rest.join('\t'),
    added: added === '-' ? 0 : Number(added),
    removed: removed === '-' ? 0 : Number(removed),
  };
}

/** Parse `git diff --numstat` output into per-file added/removed counts. */
function parseNumstat(numstat: string): DiffFile[] {
  return numstat
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseNumstatLine);
}

/**
 * Parse `git log --format=%x00%H%x09%s --numstat <range>` output into {@link RemoteCommit}s.
 *
 * A line starting with NUL begins a new commit: the hash runs up to the first tab, and the
 * subject is everything after it (which may itself contain tabs — only the header's own leading
 * NUL is used to detect a new commit, never a tab count). Lines of the form `added\tremoved\tpath`
 * belong to the current commit's files (`-\t-\t...` — a binary file — counts as 0/0); blank lines
 * are skipped; anything else (a numstat line with no commit header yet seen, stray output) is
 * ignored. A commit with no numstat lines under it (e.g. a merge commit) ends up with `files: []`.
 * Tolerates CRLF input the same way {@link parseNumstat} does: a trailing `\r` is stripped from
 * every line (header and numstat alike) before parsing, so it never ends up glued onto a subject
 * or a path. Pure and exported for unit testing without a live git process.
 */
export function parseCommitLog(out: string): RemoteCommit[] {
  const commits: RemoteCommit[] = [];
  let current: RemoteCommit | null = null;
  for (const rawLine of out.split('\n')) {
    const line0 = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line0.length === 0) continue;
    if (line0[0] === '\u0000') {
      const line = line0.slice(1);
      const tab = line.indexOf('\t');
      current =
        tab === -1
          ? { hash: line, message: '', files: [] }
          : { hash: line.slice(0, tab), message: line.slice(tab + 1), files: [] };
      commits.push(current);
      continue;
    }
    if (!current) continue;
    const parts = line0.split('\t');
    if (parts.length < 3) continue;
    current.files.push(parseNumstatLine(line0));
  }
  return commits;
}

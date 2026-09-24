import path from 'node:path';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { simpleGit, type SimpleGit, type StatusResult as GitStatusSummary } from 'simple-git';
import type { AuthConfig, CommitIdentity } from './auth.js';
import { parseConflictHunks, type ConflictHunk } from '../lib/conflictParser.js';
import { isBibFile } from '../lib/bib.js';
import { resolveInside, toPosix } from '../lib/paths.js';
import { execCapture, execCaptureBytes } from '../lib/exec.js';
import { canonicalNames, foldCase } from '../lib/caseFold.js';
import { coversPath } from '../lib/commitPaths.js';
import { REFUSAL_PATH_CAP } from '../lib/peerAttribution.js';
import { remoteBranchMissingNote } from '../lib/syncState.js';
import { CONFLICT_MAX_COMMITS } from '../lib/conflictBudget.js';

const DEFAULT_IDENTITY: CommitIdentity = { name: 'WebLatexMCP', email: 'web-latex-mcp@localhost' };

export type SyncAction = 'cloned' | 'pulled' | 'up-to-date' | 'diverged' | 'remote-branch-missing';

export interface SyncResult {
  action: SyncAction;
  ahead: number;
  behind: number;
  diverged: boolean;
  /**
   * Present only with `action: 'remote-branch-missing'`: what happened to the branch and what it
   * means for the unpushed work (see `remoteBranchMissingNote`).
   */
  note?: string;
}

export interface StatusResult {
  branch: string;
  ahead: number;
  behind: number;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  /**
   * Local commits not yet on the remote (newest first) — what a push would send. Empty unless the
   * caller asked for the lists (`withCommits`). Complete while `origin/<branch>` resolves; when it
   * is absent the count can be the clone's whole history, so the list is capped at
   * `CONFLICT_MAX_COMMITS` and `aheadCommitsOmitted` counts the rest.
   */
  aheadCommits: RemoteCommit[];
  /** Commits `aheadCommits` left out (only ever when `origin/<branch>` is absent); 0 otherwise. */
  aheadCommitsOmitted: number;
  /**
   * Remote commits not yet local (newest first) — what landed upstream since the last sync. Empty
   * unless the caller asked for the lists (`withCommits`).
   */
  behindCommits: RemoteCommit[];
  /**
   * `origin/<branch>` is gone after the last fetch while the remote has other branches this
   * clone's history came from — renamed or deleted upstream. `ahead`/`aheadCommits` then count the
   * local commits on no remote branch, and `behind` is 0 because there is nothing to be behind.
   */
  remoteBranchMissing: boolean;
  /** Present only when `remoteBranchMissing`: the same explanation `project_sync` gives. */
  remoteBranchNote?: string;
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
   * push lost the race every retry round; nothing was pushed. For `safePush`/`resolvePush` the
   * clone is intact. Not so for branch-mode landing (`landBranch`): there, the local base branch
   * has already been fast-forwarded onto the feature branch before the push fails, and the
   * summary's recovery text says to run push in direct mode to finish syncing it.
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
 * A rebase or fast-forward step aborted (or never even started) because the remote has a commit
 * adding a path that already exists, untracked, in the working tree — git refuses to silently
 * clobber content it doesn't track. `paths` names the colliding file(s) when git's own error
 * names them, and is empty when it didn't.
 *
 * `operation` picks the wording: **push** (the default, and the only case that existed before
 * this class grew a pull path) is thrown from mid-rebase — the clone is left at its pre-push
 * state, nothing was pushed. **pull** is thrown from `syncPull`'s `merge --ff-only`, which aborts
 * cleanly on this refusal (there's no rebase to unwind) — same "nothing changed" opener as
 * {@link LocalChangesOverwriteError}. The two wordings prescribe different exits: a pull refusal
 * has no in-flight rebase to resume, so re-syncing after clearing the collision is a plain `push`
 * (which itself rebases and surfaces a proper conflict), not "retry the push".
 */
export class UntrackedOverwriteError extends Error {
  readonly paths: string[];
  readonly operation: 'push' | 'pull';

  constructor(paths: string[], operation: 'push' | 'pull' = 'push') {
    super(UntrackedOverwriteError.buildMessage(paths, operation));
    this.name = 'UntrackedOverwriteError';
    this.paths = paths;
    this.operation = operation;
  }

  private static buildMessage(paths: string[], operation: 'push' | 'pull'): string {
    return operation === 'pull'
      ? UntrackedOverwriteError.buildPullMessage(paths)
      : UntrackedOverwriteError.buildPushMessage(paths);
  }

  /** Unchanged byte-for-byte from before `operation` existed — existing tests pin this. */
  private static buildPushMessage(paths: string[]): string {
    const nothingPushed =
      'The rebase a push needs was aborted. Nothing was pushed; the clone is back to its ' +
      'pre-push state.';
    if (paths.length === 0) {
      return (
        `${nothingPushed} An incoming commit would overwrite an untracked file already in the ` +
        'working tree, but git did not name it — check `status` for untracked files that might ' +
        'collide with the remote, then commit just those (`commit` with `scope: "paths"` and ' +
        '`paths: [...]`) so the next push surfaces a proper conflict instead of this abort — ' +
        '`scope: "all"` also works but sweeps in every other file in the working tree, including ' +
        "a peer session's in-flight edits. Or delete/move the colliding file, then read the " +
        'remote version with read_file(path, ref="origin/<branch>").'
      );
    }
    const capped = capPaths(paths);
    const pathList = capList(paths, REFUSAL_PATH_CAP);
    const pathsJson = JSON.stringify(capped);
    return (
      `${nothingPushed} The remote has a commit adding ${pathList}, which already ` +
      `exist${paths.length === 1 ? 's' : ''} untracked in the working tree. Commit ` +
      `${paths.length === 1 ? 'it' : 'them'} with \`commit\`, \`scope: "paths"\`, ` +
      `\`paths: ${pathsJson}\` so the next push surfaces a proper conflict instead of this abort ` +
      '(`scope: "all"` also works but sweeps in every other file in the working tree, including ' +
      "a peer session's in-flight edits) — or delete/move " +
      `${paths.length === 1 ? 'it' : 'them'}, then read the remote version with ` +
      `read_file(path, ref="origin/<branch>").${capNote(paths, capped, 'the push get further')}`
    );
  }

  /**
   * `merge --ff-only` aborts cleanly on this refusal — same "nothing changed" opener as
   * {@link LocalChangesOverwriteError}. Unlike the tracked-file sibling, git's own suggestion
   * here ("move or remove") is not relayed: the server's own exits below cover it (`discard`
   * IS a move/remove), and `LocalChangesOverwriteError`'s stash caveat doesn't apply to this
   * refusal at all — git never suggests stash for an untracked-file collision.
   */
  private static buildPullMessage(paths: string[]): string {
    const nothingChanged =
      'The pull was refused; nothing changed — the clone is exactly as it was before this call.';
    if (paths.length === 0) {
      return (
        `${nothingChanged} The remote has a commit adding an untracked file already present in ` +
        'the working tree, but git did not name it — check `status` for untracked files that ' +
        'might collide with the remote. Commit the colliding one (`commit` with `scope: "paths"` ' +
        'and `paths: [...]`), then `push` — the rebase a push performs is what surfaces a proper ' +
        'conflict between the two versions (a plain sync after committing would only report the ' +
        'histories as diverged; `scope: "all"` also works but sweeps in every other file, ' +
        "including a peer session's in-flight edits). Or `discard` it (`discard` with " +
        '`paths: [...]`) to remove the untracked file, after which the sync succeeds — read the ' +
        'remote version with read_file(path, ref="origin/<branch>") afterwards if wanted (a bare ' +
        '`discard` also works but reverts the whole working tree). Or leave it uncommitted and ' +
        'sync later.'
      );
    }
    const capped = capPaths(paths);
    const pathList = capList(paths, REFUSAL_PATH_CAP);
    const pathsJson = JSON.stringify(capped);
    const plural = paths.length > 1;
    return (
      `${nothingChanged} The remote has a commit adding ${pathList}, which already ` +
      `exist${plural ? '' : 's'} untracked in the working tree, so the fast-forward would ` +
      `overwrite ${plural ? 'them' : 'it'}. Commit ${plural ? 'them' : 'it'} with \`commit\`, ` +
      `\`scope: "paths"\`, \`paths: ${pathsJson}\`, then \`push\` — the rebase a push performs is ` +
      'what surfaces a proper conflict between the two versions (a plain sync after committing ' +
      'would only report the histories as diverged; `scope: "all"` also works but sweeps in ' +
      `every other file, including a peer session's in-flight edits). Or \`discard\` ` +
      `${plural ? 'them' : 'it'} with \`discard\`, \`paths: ${pathsJson}\` to remove the ` +
      `untracked file${plural ? 's' : ''}, after which the sync succeeds — read the remote ` +
      'version with read_file(path, ref="origin/<branch>") afterwards if wanted (a bare ' +
      `\`discard\` also works but reverts the whole working tree). Or leave ` +
      `${plural ? 'them' : 'it'} uncommitted and sync later.` +
      capNote(paths, capped, 'the sync get further')
    );
  }
}

/**
 * A `project_sync` pull was refused because the fast-forward would overwrite a locally modified
 * *tracked* file — the sibling case to {@link UntrackedOverwriteError}, but for a file the clone
 * already tracks rather than one sitting untracked in the working tree. `merge --ff-only` aborts
 * cleanly on this refusal (unlike a rebase), so nothing changed: HEAD did not move and the working
 * tree is exactly as it was. `paths` names the colliding file(s) when git's own error names them,
 * and is empty when it didn't.
 *
 * Git's own message tells the caller to `stash` — a command this server does not expose (a stash
 * pop is an automatic merge of someone's uncommitted lines, and a pop conflict leaves markers in
 * the tree; see the ff-only/no-autostash rationale next to `push`). The message here says so
 * explicitly and points at the three exits this server actually has instead: `commit`, `discard`,
 * or simply syncing later.
 *
 * git's `unpack_trees` accumulates rejects per error type and prints every non-empty block, so a
 * single `merge --ff-only` can refuse over a tracked-modification collision AND an untracked-file
 * collision at once (confirmed against real git). When that happens, `pullRefusalFromError` folds
 * both blocks into ONE `LocalChangesOverwriteError` whose `paths` is the union — tracked entries
 * first, then untracked, deduplicated — rather than reporting only whichever block a `??` chain
 * reached first: the caller needs a single `paths` argument that clears everything the sync will
 * refuse over, not one that clears half of it and refuses again right after. `untrackedPaths`
 * names the subset of `paths` that is untracked rather than modified, purely so the message can
 * call out that `discard`ing those removes the file rather than reverting it.
 */
export class LocalChangesOverwriteError extends Error {
  readonly paths: string[];
  readonly untrackedPaths: string[];

  constructor(paths: string[], opts?: { untracked?: string[] }) {
    const untrackedPaths = opts?.untracked ?? [];
    super(LocalChangesOverwriteError.buildMessage(paths, untrackedPaths));
    this.name = 'LocalChangesOverwriteError';
    this.paths = paths;
    this.untrackedPaths = untrackedPaths;
  }

  private static buildMessage(paths: string[], untrackedPaths: string[]): string {
    const nothingChanged =
      'The pull was refused; nothing changed — the clone is exactly as it was before this call.';
    const stashNote =
      "Git's own message suggests `stash` for this — that command is not available here.";
    if (paths.length === 0) {
      return (
        `${nothingChanged} An incoming commit would overwrite a locally modified tracked file, ` +
        'but git did not name it — check `status` for modified files that might collide with the ' +
        'remote. Commit just those (`commit` with `scope: "paths"` and `paths: [...]`), then ' +
        '`push` — the rebase a push performs is what surfaces a proper conflict between the two ' +
        'versions (a plain sync after committing would only report the histories as diverged; ' +
        '`scope: "all"` also works but sweeps in every other file, including a peer session\'s ' +
        'in-flight edits). Or `discard` just those (`discard` with `paths: [...]`), after which ' +
        'the sync succeeds (a bare `discard` also works but reverts the whole working tree, ' +
        "including a peer session's in-flight edits). Or leave them uncommitted and sync later. " +
        stashNote
      );
    }
    const plural = paths.length > 1;
    // Cap consistently everywhere a path could appear in this message — the prose list AND the
    // JSON `paths` argument — so a path beyond the cap never leaks out through either channel.
    const capped = capPaths(paths);
    const pathList = capList(paths, REFUSAL_PATH_CAP);
    const pathsJson = JSON.stringify(capped);
    // With more paths than the cap, the prescribed `paths` names only the first 20, so following
    // this message clears 20 of them and the next sync refuses again on the rest. Say so rather
    // than promising a success the argument cannot deliver — `status` is where the full list is.
    const partial = capNote(paths, capped, 'the sync get further');
    const untracked = untrackedCollisionNote(untrackedPaths, capped);
    return (
      `${nothingChanged} The remote has a commit touching ${pathList}, which ${plural ? 'have' : 'has'} ` +
      `uncommitted local modification${plural ? 's' : ''}, so the fast-forward would overwrite ` +
      `${plural ? 'them' : 'it'}. Commit ${plural ? 'them' : 'it'} with \`commit\`, ` +
      `\`scope: "paths"\`, \`paths: ${pathsJson}\`, then \`push\` — the rebase a push performs is ` +
      'what surfaces a proper conflict between the two versions (a plain sync after committing ' +
      'would only report the histories as diverged; `scope: "all"` also works but sweeps in ' +
      `every other file, including a peer session's in-flight edits). Or \`discard\` ` +
      `${plural ? 'them' : 'it'} with \`discard\`, \`paths: ${pathsJson}\`, after which the sync ` +
      'succeeds (a bare `discard` also works but reverts the whole working tree, including a ' +
      `peer session's in-flight edits), or leave ${plural ? 'them' : 'it'} uncommitted and sync ` +
      `later.${partial}${untracked} ${stashNote}`
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
  | {
      ok: true;
      rebasedOver: RemoteCommit[];
      /**
       * The ahead count re-read immediately before the push that actually ran, for attempt > 1
       * only (a rebase ran since the caller's own pre-read, which can change it — see
       * `pushWithRetry`'s doc comment). `undefined` on attempt 1, where no rebase has happened
       * since the caller read it, so the caller's pre-read count is still accurate. `0` means the
       * push was skipped entirely: there was nothing left to send.
       */
      pushedCommits?: number;
    }
  | { ok: false; kind: 'conflict'; report: ConflictReport }
  | { ok: false; kind: 'remote-moved'; remoteHead: string; rebasedOver: RemoteCommit[] };

/**
 * Thrown by `commit`/`commitContents` when nothing is staged for the paths in scope and
 * `allowEmpty` was not set. A class, not a message: the `commit` tool decides whether to settle a
 * session's stale shadow record on this outcome, and that decision must hang on the error's type,
 * never on its prose. `ignored` names the requested paths that were dropped because git ignores
 * them (the tool's own throw sites), so the caller can report *why* nothing was staged without
 * matching on the text either.
 */
export class NothingToCommitError extends Error {
  constructor(
    message = 'Nothing to commit (no staged changes).',
    readonly ignored: string[] = [],
  ) {
    super(message);
    this.name = 'NothingToCommitError';
  }
}

/**
 * The two halves of git's own wording when a pathspec runs through a symbolic link:
 * `fatal: pathspec '<path>' is beyond a symbolic link`, on stderr, exit **128**. Verified
 * against git 2.46.0 for `check-ignore -z --stdin` with and without `--no-index`, for a link
 * that is tracked, untracked, dangling, or points outside the repository — the wording and the
 * exit code are the same in every case.
 *
 * Split into a prefix and a suffix rather than written as one regex on purpose: the path is
 * interpolated **verbatim**, so it may itself contain a quote or a newline, which makes a
 * single-line capture wrong (git prints `linkdir/a\nb.tex` across two lines, un-quoted) and a
 * multi-line one ambiguous. Detection uses both halves; naming reconstructs the exact needle
 * per requested path, which needs no escaping and cannot mis-split.
 *
 * Git's `die()` is translated, so under a non-English locale neither half matches and the
 * caller falls through to reporting git's raw text — the same degradation
 * {@link pullRefusalFromError} already accepts for the messages it parses.
 */
const BEYOND_SYMLINK_PREFIX = "fatal: pathspec '";
const BEYOND_SYMLINK_SUFFIX = "' is beyond a symbolic link";

/**
 * Which of `requested` git named in `stderr` as being beyond a symbolic link, or `null` when
 * this is not that failure at all — in which case the caller must keep reporting whatever
 * actually happened (a corrupt repository, a missing git) rather than relabelling it.
 *
 * An **empty array** is not `null`: it means the failure IS this one but the offending path
 * could not be tied back to anything we asked about (a translated-looking hybrid, or a path
 * whose own bytes contain a newline). Keep the two apart — `null` licenses the raw-text throw,
 * `[]` does not, because the condition was still recognised.
 *
 * At most one entry in practice: `check-ignore` `die()`s at the first offending path, so the
 * rest of the batch is never judged (verified — a batch of two beyond-link paths names only the
 * first, and any earlier ignored path's stdout is discarded along with the call).
 */
export function beyondSymlinkPaths(stderr: string, requested: readonly string[]): string[] | null {
  if (!stderr.includes(BEYOND_SYMLINK_PREFIX) || !stderr.includes(BEYOND_SYMLINK_SUFFIX)) {
    return null;
  }
  return requested.filter((p) =>
    stderr.includes(BEYOND_SYMLINK_PREFIX + p + BEYOND_SYMLINK_SUFFIX),
  );
}

/**
 * A path handed to `git check-ignore` runs through a symbolic link, so git refuses to judge it
 * and {@link GitService.ignoredPaths} cannot answer. Raised in place of git's raw
 * `fatal: pathspec …` text, which named no route out of a state that fails **every** `commit`:
 * the ignore check runs once per commit over every path the call considers, so one such path
 * stops the whole call, unrelated files included.
 *
 * The state this exists for is a **legacy shadow key** (#70): a pre-`4c8bba3` `delete_file`
 * under a linked directory filed the record under the link's name rather than the real
 * directory's. No such key is written any more (`attributedDeletePath`), and `discard` clears
 * one — `discard`'s own git calls (`ls-files`, `clean -f`) accept such a pathspec without
 * complaint, so the route out really is open, which is why it is safe to name here.
 *
 * A class, not a bare message, for the same reason as {@link NothingToCommitError}: the type is
 * what a caller should branch on. Never swallowed into an empty result — reporting "nothing is
 * ignored" would let the commit stage a file git means to exclude.
 */
export class PathBeyondSymlinkError extends Error {
  readonly paths: string[];

  constructor(paths: string[], requested: number) {
    super(PathBeyondSymlinkError.buildMessage(paths, requested));
    this.name = 'PathBeyondSymlinkError';
    this.paths = paths;
  }

  private static buildMessage(paths: string[], requested: number): string {
    // Count-neutral phrasing, so there is no singular/plural branch to leave untested for a
    // shape git does not produce (it names exactly one path before dying).
    const named = paths.map((p) => `\`${p}\``).join(', ');
    const refusal =
      paths.length === 0
        ? `one of the ${requested} paths this call asked about lies beyond a symbolic link, ` +
          'and git did not name which — check `status` for a recorded path under a linked ' +
          'directory'
        : `${named} ${paths.length === 1 ? 'lies' : 'lie'} beyond a symbolic link`;
    return (
      'Nothing was committed. Before staging anything, a commit asks git which of the paths it ' +
      `is about to consider are ignored, and git refused: ${refusal}. One of its parent ` +
      'directories is a link, and git will not judge a path through one — which stops the ' +
      'whole call, the files that are fine included. ' +
      'This is almost always a stale record left by an older version of this server, which ' +
      "filed a file deleted under a linked directory under the link's name instead of the real " +
      "directory's; no such record is written any more. Clear the record with `discard` " +
      '(`confirm: true`, and `paths` naming just that path, so nothing else is thrown ' +
      'away), then commit again. If you named the path yourself, name it through the real ' +
      'directory rather than through the link.'
    );
  }
}

/**
 * Whether `git ls-files -s` output for one conflicted path shows a symlink (mode 120000) on OUR
 * (stage 2) or THEIR (stage 3) side. During a conflict the index lists one line per stage,
 * `<mode> <object> <stage>\t<name>`. The BASE stage (1) is deliberately not a side: when both
 * sides already replaced a tracked link with a regular file, the conflict is an ordinary content
 * conflict with nothing a file-content resolution could wrongly land on, and refusing it would
 * leave the caller no way to resolve it. A merged entry (stage 0) is not a conflict at all.
 */
export function hasLinkOnConflictSide(lsFilesOutput: string): boolean {
  return lsFilesOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => {
      const [mode, , stage] = line.split(/\s+/);
      return mode === '120000' && (stage === '2' || stage === '3');
    });
}

/**
 * Whether `rel` (POSIX, relative to `dir`) exists on disk under exactly that spelling, judged one
 * directory listing at a time — `lstat` alone answers "something is there" on a case-insensitive
 * filesystem even when only another spelling is. Any unreadable ancestor counts as absent.
 */
async function existsWithExactSpelling(dir: string, rel: string): Promise<boolean> {
  let current = dir;
  // `.` segments name the directory itself (`"."`, `./x`): the whole tree exists.
  for (const segment of toPosix(rel)
    .split('/')
    .filter((s) => s !== '' && s !== '.')) {
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      return false;
    }
    if (!names.includes(segment)) return false;
    current = path.join(current, segment);
  }
  return true;
}

/**
 * The first ancestor of `rel` (POSIX, relative to `dir`, excluding `rel` itself and `dir`) that
 * is a symbolic link in the working tree, as a POSIX relative path, or null when no ancestor is
 * a link. An ancestor that does not exist ends the walk (nothing below it can be a link). The
 * final component is deliberately not judged here — `hasSymlinkMode` owns that.
 */
export async function linkedAncestor(dir: string, rel: string): Promise<string | null> {
  const segments = toPosix(rel).split('/').filter(Boolean);
  for (let i = 1; i < segments.length; i++) {
    const prefix = segments.slice(0, i).join('/');
    try {
      const st = await lstat(path.join(dir, ...segments.slice(0, i)));
      if (st.isSymbolicLink()) return prefix;
    } catch {
      // Ancestor does not exist — nothing below it can be a link either. (An unreadable one
      // ends the walk too; the `writeFile` that follows fails on it just the same.)
      return null;
    }
  }
  return null;
}

/**
 * What the reverted commits touch, and every reason a revert of them would be refused. Read-only:
 * {@link GitService.revertPreflight} produces it without writing an index, a working-tree file or
 * a `.git` state file, so the tool layer can decide and refuse before anything is mutated.
 */
export interface RevertPreflight {
  /** Full 40-char shas, in the order given by the caller (the order they will be applied). */
  commits: string[];
  /** Repo-relative POSIX paths the reverted commits touch, deduplicated, sorted. */
  touchedPaths: string[];
  /** Touched paths with uncommitted working-tree, index or untracked state. Empty when clean. */
  dirtyPaths: string[];
  /**
   * The subset of `dirtyPaths` that `status` does NOT list: a touched path HEAD does not track
   * with something on disk in the way — the path itself, a directory holding untracked or
   * ignored files, or a file where one of its parent directories must go — typically git-ignored
   * (or, failing closed, a path whose `lstat` could not be judged). Reported apart because the
   * way out differs: git itself refuses to overwrite an uncommitted change, but silently
   * overwrites an ignored file, and `discard` (whose `clean` skips ignored files) cannot remove
   * it — it has to be moved or deleted by hand.
   */
  inTheWayPaths: string[];
  /** Touched paths that are a symlink in HEAD, in a reverted commit or its parent, or on disk, or that lie under a symlinked directory. */
  linkPaths: string[];
  /**
   * Every path in the clone whose INDEX differs from HEAD — staged content, anywhere, not only
   * under `touchedPaths`. It is here because of how a conflicting revert has to be undone:
   * `git revert --abort` is a `reset --merge` to the stored head, and it silently resets the
   * whole index. Verified against real git: a peer session's `git add`ed file on a path the
   * revert never touches comes back at HEAD's content, its staged work gone — the same class of
   * destruction that makes a whole-tree `reset --hard` forbidden here. The tool refuses while
   * anything is staged, which makes the abort provably safe (with an index equal to HEAD there is
   * nothing for it to destroy) rather than merely usually safe.
   */
  stagedPaths: string[];
  /** Of `commits`, those that are merge commits (git revert needs -m for these; we refuse them). */
  mergeCommits: string[];
  /**
   * The ref holding what the revert would RESTORE — the sole parent of the sole reverted commit.
   * `null` for a multi-commit revert (each commit restores its own parent, so no single ref names
   * "their side" for every conflicted path) and for a root commit (which has no parent, so
   * `<sha>^` would not resolve and a caller told to read it would just get "Unknown git ref").
   * Reported to the caller as `theirsRef` on a conflict; naming the wrong side is worse than
   * naming none.
   */
  restoreRef: string | null;
}

export interface RevertResult {
  status: 'reverted' | 'conflict';
  /** Full shas, in applied order. */
  commits: string[];
  /** Per-file added/removed of the revert as it now sits in the working tree, vs HEAD. Empty on conflict. */
  files: DiffFile[];
  filesChanged: number;
  /**
   * Per-file added/removed between `expectRef` and the reverted tree, over the reverted paths —
   * empty means they match it exactly. `null` when no `expectRef` was given (and on a conflict),
   * which is what keeps `matchesRef` from claiming `true` having compared nothing.
   */
  mismatchedFiles: DiffFile[] | null;
  /** Every path git reported conflicted. Uncapped. Empty unless status === 'conflict'. */
  conflictPaths: string[];
}

/**
 * A commit-ish the caller named that git cannot resolve, or that is refused outright. A class,
 * not a message, for the same reason {@link NothingToCommitError} is one: the tool layer decides
 * how to word a bad-commit refusal, and that decision must hang on the error's type rather than
 * on its prose.
 */
export class BadCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadCommitError';
  }
}

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

  /**
   * Per-dir cache of {@link isCaseInsensitive}'s answer — `readAtRefBytes` runs it once per
   * shadow entry per `status`, and it costs a `git config` spawn every time otherwise. A
   * `core.ignorecase` flip mid-process (a hand `git config` while this server is running) is not
   * tracked; the cached answer sticks for the life of this `GitService` instance.
   */
  private readonly caseInsensitive = new Map<string, Promise<boolean>>();
  /** {@link canonicalAtRef}'s memoised listing, one per dir, keyed by the tree sha it lists. */
  private readonly canonicalByTree = new Map<
    string,
    { key: string; names: ReturnType<typeof canonicalNames> }
  >();

  /** Stage and commit locally. Does not push. */
  async commit(
    dir: string,
    opts: { message: string; paths?: string[]; allowEmpty?: boolean; fromHead?: boolean },
  ): Promise<{ committed: boolean; sha: string; filesChanged: number; files: DiffFile[] }> {
    const git = simpleGit(dir);
    if (opts.fromHead) {
      // Start from HEAD so nothing another call left staged (a peer's `commitContents` that threw
      // mid-way, a hand `git add` in the clone) can leak into this commit. Without `-u` the working
      // tree is untouched. Tolerates an unborn HEAD (a freshly `git init`'d clone with no commits
      // yet), where `read-tree --reset HEAD` would otherwise fail with "Not a valid object name".
      await this.resetIndexToHead(dir, git);
    }
    // Set only for `paths` over the LIVE index (no `fromHead` — `scope: "all"` with `paths`):
    // what was requested, as staged below. See the commit step for why it is needed.
    let onlyPaths: string[] | null = null;
    if (opts.paths && opts.paths.length > 0) {
      // A literal pathspec never folds case (verified against real git), so on a
      // case-insensitive repository (`core.ignorecase = true`, git's own default on macOS/Windows
      // clones) a caller who names a tracked file in another case than HEAD/the index — the same
      // file on that filesystem — got git's raw "did not match any files" rather than staging it
      // (e.g. deleting the on-disk `Notes.txt` and committing `paths: ["notes.txt"]`). List the
      // index once (after the reset above when `fromHead`, so it reflects HEAD; the live index
      // otherwise, which is what the `git add` below stages over) and resolve every requested path
      // onto its own tracked spelling first. A path the index does not track keeps the caller's
      // spelling unchanged, so it still fails exactly as before. On a case-sensitive repository
      // this costs nothing extra: no listing, paths used byte-exact.
      let paths = opts.paths;
      if (await this.isCaseInsensitive(dir)) {
        const indexNames = (await git.raw(['ls-files', '-z'])).split('\0').filter(Boolean);
        const canonical = canonicalNames(indexNames);
        paths = opts.paths.map((p) => canonical.resolve(toPosix(p)));
      }
      // A path that matches nothing at all — not tracked, not on disk — is a caller mistake (a
      // typo, or a path from a different project), not something `git add` should be asked to
      // resolve: unfiltered, it exits 128 with git's raw `fatal: pathspec '…' did not match any
      // files`. Checked against the post-fold spellings above, since those are what gets staged.
      // "Tracked" is judged the way `coversPath` judges a `scope: "paths"` request covering a
      // shadow entry: a literal, `--literal-pathspecs` `ls-files` listing of exactly these paths,
      // where naming a directory matches every file beneath it. "On disk" is a plain `lstat` —
      // a file, a directory, even a dangling symlink all count as "something is there", so only
      // `lstat` itself failing means nothing is. A path matching only one of the two still commits
      // as before (e.g. a tracked file removed on disk stages its deletion); this only refuses when
      // BOTH say no.
      //
      // The pathspec list is {@link chunkPathspecs}-batched (#110): a `scope: "paths"` request
      // naming thousands of files handed one `ls-files` an oversized command line on Windows.
      // Combining is a CONCATENATION, and that is exactly the union one call would print: the
      // chunks partition `paths`, every index entry a pathspec matches is printed by the one
      // chunk holding that pathspec, and a chunk printing nothing means none of ITS pathspecs
      // matched — never "nothing matched overall". Duplicates across chunks would be harmless
      // here (membership is tested with `some`), and cannot arise anyway.
      const indexed: string[] = [];
      for (const chunk of chunkPathspecs(paths)) {
        indexed.push(
          ...(await git.raw(['--literal-pathspecs', 'ls-files', '-z', '--', ...chunk]))
            .split('\0')
            .filter(Boolean),
        );
      }
      const unmatched: string[] = [];
      for (const p of paths) {
        if (indexed.some((name) => coversPath(p, name))) continue;
        // Judged by exact spelling, segment by segment, not by `lstat`: on a case-insensitive
        // filesystem `lstat("sub")` succeeds for an on-disk `Sub`, but a literal pathspec on a
        // repository configured case-sensitive (`core.ignorecase=false`) matches nothing there,
        // and git's raw "did not match any files" surfaced (Windows CI).
        if (!(await existsWithExactSpelling(dir, p))) unmatched.push(p);
      }
      if (unmatched.length > 0) {
        throw new Error(
          `Nothing at: ${unmatched.join(', ')} — not in the working tree and not tracked. Paths ` +
            'are matched literally: no globs, exact spelling (case-folded only on a ' +
            'core.ignorecase clone).',
        );
      }
      // `--literal-pathspecs`: a pathspec is a glob by default, so naming `a[1].tex` would also
      // stage a peer's dirty `a1.tex` — past the ownership check, which compared literal names.
      //
      // Batched like the listing above (#110), and every chunk keeps that flag. Staging the same
      // paths in several `git add` calls stages exactly what one call would have: `add` is a
      // per-path index write with no cross-path state, and the chunks partition the list. The
      // partial-failure mode the batching introduces is answered by `stageOrExplain` — see there.
      await this.stageOrExplain(paths, async () => {
        for (const chunk of chunkPathspecs(paths)) {
          await git.raw(['--literal-pathspecs', 'add', '--', ...chunk]);
        }
      });
      if (!opts.fromHead) onlyPaths = paths;
    } else {
      await git.add(['-A']);
    }
    // `-z` + `core.quotePath=false`: these names are matched against the requested paths below,
    // and a C-quoted `"r\303\251sum\303\251.tex"` would match nothing.
    let staged = (
      await git.raw([
        '-c',
        'core.quotePath=false',
        'diff',
        '--cached',
        '--no-renames',
        '--name-only',
        '-z',
      ])
    )
      .split('\0')
      .filter(Boolean);
    // Capture the staged per-file line counts before committing — once committed, the
    // `--cached` diff is empty. Drives the diffstat surfaced by the commit tool.
    let files = await this.numstat(git, ['--cached']);
    if (onlyPaths !== null) {
      // Over the live index, whatever was ALREADY staged — a hand `git add`, a peer's leftover —
      // is in the index next to what this call staged, and a bare `git commit` takes the whole
      // index: an unrelated file rode along although `paths` promises "limit the commit to these
      // paths". So count, report and commit only what the requested paths cover, and leave the
      // rest staged exactly as it was. `paths` were resolved to the index's own spelling above,
      // so this is exact in practice; it still folds on an ignorecase clone, like every other
      // by-name comparison there, so a directory named in another case covers what `git add`
      // staged beneath it. The names handed to `--only` below are the index's own either way.
      const requested = onlyPaths;
      const fold = (await this.isCaseInsensitive(dir)) ? foldCase : undefined;
      const covered = (name: string): boolean => requested.some((p) => coversPath(p, name, fold));
      staged = staged.filter(covered);
      files = files.filter((f) => covered(f.path));
    }
    if (staged.length === 0 && !opts.allowEmpty) {
      throw new NothingToCommitError();
    }
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
    if (onlyPaths === null) {
      await git.raw(args);
    } else {
      // `--only` commits exactly the named paths and leaves every other staged entry staged (git
      // builds the commit from HEAD plus just those paths). It takes their WORKING-TREE bytes,
      // not their index entries — the same bytes here: the batched `git add` of these very paths
      // ran just before, inside the caller's `runExclusive`, so nothing of ours changed them in
      // between. The names are the staged entries under the request — each one known to git, so
      // none can fail to match — read from stdin NUL-separated, so no command line grows with the
      // list (#110) and a name needs no quoting; `--literal-pathspecs` keeps `a[1].tex` from also
      // meaning `a1.tex`. An empty list with `allowEmpty` is an empty commit that takes nothing
      // staged, as intended.
      const res = await execCapture(
        'git',
        ['--literal-pathspecs', ...args, '--only', '--pathspec-from-file=-', '--pathspec-file-nul'],
        { cwd: dir, input: staged.join('\0') },
      );
      if (res.code !== 0) {
        throw new Error(`git commit failed: ${(res.stderr || res.stdout).trim()}`);
      }
    }
    const sha = (await git.revparse(['HEAD'])).trim();
    return { committed: true, sha, filesChanged: staged.length, files };
  }

  /**
   * Run {@link commit}'s batched `git add` and, if it fails, say what the batching left behind.
   *
   * Deliberately NOT worded like {@link landedOrExplain}, which the revert path uses: this is a
   * different failure. `git add` only writes the INDEX, and it runs before the commit, so when a
   * chunk fails nothing has been committed and no file on disk has changed — the caller has lost
   * nothing and a retry cannot double-apply anything, which is precisely what a revert's wrapper
   * has to forbid. What HAS changed is that the index may now hold some of the named paths and
   * not others, where one unbatched `add` was all-or-nothing. That is worth saying rather than
   * hiding, because the caller can see it in `status`/`diff` and would otherwise wonder where a
   * staged file came from.
   *
   * It is bounded, too: the only content that can be staged is what this call itself named, and
   * no later commit can take a leftover partial stage it did not ask for. Scope "session" and
   * scope "paths" reset the index to HEAD before staging (`commitContents`, and `commit` with
   * `fromHead`); scope "all" with `paths` commits only the staged entries its own `paths` cover
   * (`--only`); and scope "all" without `paths` re-stages the whole working tree anyway, so it
   * takes exactly what it would have taken with no leftover at all. Hence "retrying is safe",
   * stated plainly, instead of the revert's "do NOT simply retry".
   */
  private async stageOrExplain<T>(paths: string[], step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Staging the requested path(s) failed: ${reason}. NOTHING was committed and no file on ` +
          `disk changed, but the index may already hold some of the ${paths.length} path(s) ` +
          'named — a long path list is split across several `git add` calls and one of them ' +
          'failed. Only what this call named can be staged, and no later commit takes a ' +
          'leftover it did not ask for: scopes "session" and "paths" reset the index to HEAD ' +
          'first, scope "all" with `paths` commits only what its own paths cover, and scope ' +
          '"all" without `paths` re-stages the whole working tree anyway. Inspect it with ' +
          '`status`/`diff`; re-running `commit` is safe and stages the rest.',
        { cause: err },
      );
    }
  }

  /**
   * Commit exact file contents, regardless of what the working tree currently holds.
   *
   * This is how one session commits only its own changes while its peers' edits sit uncommitted
   * in the shared working tree: the index is reset to HEAD, the given contents are written
   * straight into it as blobs, and the commit is made from the index alone — no `add`, no `-a`,
   * and not a single byte of the working tree is touched.
   *
   * A null `content` stages the file's deletion. A `Buffer` content stages verbatim bytes —
   * this is how a binary asset (e.g. a PNG figure) reaches a commit without being decoded as
   * text anywhere along the way.
   */
  async commitContents(
    dir: string,
    opts: {
      message: string;
      files: Array<{ path: string; content: string | Buffer | null }>;
      allowEmpty?: boolean;
    },
  ): Promise<{ committed: boolean; sha: string; filesChanged: number; files: DiffFile[] }> {
    const git = simpleGit(dir);
    // Start from HEAD so nothing another call left staged can leak into this commit. Without
    // `-u` the working tree is left exactly as it is. Tolerates an unborn HEAD the same way
    // `commit`'s `fromHead` branch does.
    await this.resetIndexToHead(dir, git);

    // `update-index --cacheinfo`/`--force-remove` do no case-alias lookup the way `git add`
    // does: on a case-insensitive repository (`core.ignorecase = true`, git's own default on
    // clone/init on macOS and Windows) a caller who spells a tracked file in another case than
    // HEAD — the same file on that filesystem — would otherwise stage a SECOND, case-differing
    // tree entry (or, for a deletion, remove nothing). The index was just reset to HEAD above,
    // so list it once and fold every file's path onto HEAD's own spelling before touching the
    // index. `foldCase` IS git's own ASCII-only case folding (never Unicode), so it matches what
    // `core.ignorecase` does and never over-matches a non-ASCII case pair (a Kelvin sign, a
    // dotted capital I); `canonicalNames` resolves exact-first, so when the tree legitimately
    // holds both `Notes.txt` and `notes.txt`, naming one exactly lands on that one, never on
    // whichever entry happened to sort last. On a case-sensitive repository this costs nothing
    // extra: `canonical` is `null` and every path is used as the caller spelled it.
    const insensitive = await this.isCaseInsensitive(dir);
    const canonical =
      insensitive && (await this.revParseOrNull(git, 'HEAD')) !== null
        ? canonicalNames(
            (await git.raw(['ls-tree', '-r', '-z', '--name-only', 'HEAD']))
              .split('\0')
              .filter(Boolean),
          )
        : null;

    // Two spellings of one file (`Notes.txt` and `notes.txt`, two shadow entries) resolve to the
    // same tree entry above — the second `update-index --cacheinfo` for it would silently
    // overwrite the first with no error. Catch that before touching the index at all (not just
    // before this path's own write), so a collision anywhere in `opts.files` never leaves an
    // earlier file half-staged. Unreachable when `canonical` is null (case-sensitive repository):
    // two distinct spellings there are two distinct tree entries, not a collision.
    //
    // Keyed on `foldCase(rel)`, not `rel` itself: when NEITHER spelling is tracked yet (both
    // brand new — `New.tex` and `new.tex`, say), `canonical.resolve` has nothing to fold either
    // one onto and returns each unchanged, so keying on `rel` directly left two distinct keys and
    // let both stage as separate tree entries for what this filesystem treats as one file. Folding
    // the key catches that pair too, tracked or not.
    // Gated on the repository being case-insensitive, not on `canonical`: on an unborn HEAD
    // (nothing tracked yet) there is no listing to resolve through, but two new spellings that
    // fold together are still one file on that filesystem and must still be refused.
    if (insensitive) {
      const bySpelling = new Map<string, string>();
      for (const file of opts.files) {
        const posixPath = toPosix(file.path);
        const rel = canonical ? canonical.resolve(posixPath) : posixPath;
        const key = foldCase(rel);
        const other = bySpelling.get(key);
        if (other !== undefined && other !== posixPath) {
          // The way out is NOT a discard: on this clone both spellings name one file, so
          // discarding "one of them" restores (or, for a new file, deletes) that one file for
          // every session, both of this session's edits included. The working-tree file already
          // holds what was written under both names, so a `scope: "paths"` commit of it stages it
          // once and settles both records (`settle` folds case here like every other by-name
          // comparison) — and still refuses if a live peer has recorded edits to it.
          const message = canonical?.has(rel)
            ? `"${other}" and "${posixPath}" are two spellings of one file ("${rel}") on this ` +
              'case-insensitive repository, and this session recorded an edit under each — ' +
              'committing both would silently keep only one. Both names are the same file on ' +
              `disk, which already holds both edits: commit it with scope "paths" and paths ` +
              `["${rel}"], which stages it once and settles both records. Do not discard either ` +
              'spelling — that restores the one file for every session, both edits included.'
            : `"${other}" and "${posixPath}" are two spellings of one new file on this ` +
              'case-insensitive repository — neither is tracked yet, and committing both would ' +
              'create two tree entries for what this filesystem treats as one file. Commit it ' +
              'with scope "paths", naming the file as it is spelled on disk: that stages it ' +
              'once and settles both records. Do not discard either spelling — that deletes ' +
              'the one file.';
          throw new Error(message);
        }
        bySpelling.set(key, posixPath);
      }
    }

    // Every file's mode is judged — and the still-a-link refusal below raised — BEFORE the first
    // `update-index`, the same way the two-spellings check above runs before touching the index:
    // refusing from inside the staging loop left every earlier file of this call staged, and
    // `scope: "all"` commits the index as it stands, so those blobs would ride into it.
    const plan: Array<{ rel: string; content: string | Buffer | null; mode: string }> = [];
    for (const file of opts.files) {
      const posixPath = toPosix(file.path);
      const rel = canonical ? canonical.resolve(posixPath) : posixPath;
      if (file.content === null) {
        plan.push({ rel, content: null, mode: '' });
        continue;
      }
      let mode = (await this.indexMode(git, rel)) ?? '100644';
      // The index mode reflects HEAD (the index was just reset above), not the working tree, so
      // a session that `delete_file`d a link and then `write_file`d a regular file over the same
      // name still finds 120000 here. Judge the working tree before refusing: if the path is
      // STILL a symbolic link on disk, this is a stale shadow record filed under the link's own
      // name (predates the write-through-a-link fix) and staging text under 120000 would produce
      // a symlink whose target is that text, not a real file — refuse it. Otherwise (a regular
      // file now on disk, or the link removed and nothing put back) this is an ordinary
      // link-to-file typechange, the same one `git add` would record as mode 100644. A `null`
      // content (deletion) of a link stays allowed either way — that's the link itself going away.
      if (mode === '120000') {
        // Fail closed: only a file that is verifiably gone (ENOENT) or verifiably a regular file
        // clears the refusal. Any other `lstat` failure (EACCES on the parent, ELOOP) means the
        // path could not be judged, and an unjudged path must not stage content over HEAD's link.
        const stillLinked = await lstat(path.join(dir, rel))
          .then((st) => st.isSymbolicLink())
          .catch((err: NodeJS.ErrnoException) => err.code !== 'ENOENT');
        if (stillLinked) {
          throw new Error(
            `"${rel}" is still a symbolic link in the index and the working tree; a content ` +
              `commit cannot replace a link with file content. Delete the link first ` +
              `(delete_file), or commit the working tree with scope "all".`,
          );
        }
        mode = '100644';
      }
      plan.push({ rel, content: file.content, mode });
    }
    for (const { rel, content, mode } of plan) {
      if (content === null) {
        await git.raw(['update-index', '--force-remove', '--', rel]);
        continue;
      }
      const sha = await this.hashObject(dir, rel, content);
      await git.raw(['update-index', '--add', '--cacheinfo', `${mode},${sha},${rel}`]);
    }

    const staged = (await git.diff(['--cached', '--no-renames', '--name-only']))
      .split('\n')
      .filter(Boolean);
    if (staged.length === 0 && !opts.allowEmpty) {
      throw new NothingToCommitError();
    }
    const files = await this.numstat(git, ['--cached']);
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
   * Which of `paths` git ignores (`.gitignore`, `.git/info/exclude`, etc) and would not stage, as
   * POSIX paths relative to `dir`. Exists because `commitContents` stages via `hash-object` +
   * `update-index --add --cacheinfo`, which — unlike `git add` — consults no ignore rules at
   * all; a scope-"session" commit must skip what a plain `git add` (scope "all"/"paths") would
   * already have skipped, or an excluded file (e.g. a skill's local-only note kept out of git via
   * `.git/info/exclude`) gets committed and pushed anyway.
   *
   * Git never re-ignores a *tracked* path, so a tracked file matching a pattern is not ignored —
   * a deletion of, or edit to, it must still commit. `tracked` says where the caller's staging
   * step will look for "tracked", and must match it:
   * - `'head'` for the routes that reset the index to HEAD before staging (`commitContents`,
   *   `commit` with `fromHead`): whatever a hand `git rm --cached` or `git add -f` left in the
   *   index is gone by then. `check-ignore` on its own judges by the index, so after a hand
   *   `git rm --cached` it called a file ignored that the reset was about to put straight back —
   *   the session's edit was dropped from its record while the file stayed tracked at HEAD's
   *   content. So: `check-ignore --no-index` for every path the rules match, minus what
   *   `ls-tree HEAD` lists.
   * - `'index'` for a plain `git add` over the live index (`commit` without `fromHead`, i.e.
   *   scope "all" with `paths`): plain `check-ignore`, which hides index-tracked paths exactly as
   *   `git add` accepts them, so a force-added file stays committable there and a hand
   *   `git rm --cached` one is reported ignored rather than surfacing git's raw "Use -f" hint.
   *   `check-ignore` itself judges the index by exact name only — on a case-insensitive
   *   repository (`core.ignorecase = true`) an index entry `Notes.txt` does not save a
   *   `*.txt`-matched `notes.txt` from being reported ignored, even though `git add -- notes.txt`
   *   would stage it as `Notes.txt` — so this route folds the matches against `git ls-files -z`
   *   itself (exact-first, ASCII fold otherwise) when the repository is case-insensitive.
   *
   * Throws on any exit other than 0/1 — never an empty result, which would report "nothing is
   * ignored" and let the commit stage a file git means to exclude. One such failure gets server
   * words instead of git's raw text: see {@link PathBeyondSymlinkError}.
   */
  async ignoredPaths(
    dir: string,
    paths: string[],
    opts: { tracked: 'head' | 'index' },
  ): Promise<string[]> {
    if (paths.length === 0) return [];
    const rels = paths.map((p) => toPosix(p));
    const args = [
      'check-ignore',
      '-z',
      '--stdin',
      ...(opts.tracked === 'head' ? ['--no-index'] : []),
    ];
    const res = await execCapture('git', args, { cwd: dir, input: rels.join('\0') + '\0' });
    // Exit code 1 means "none of the given paths are ignored" — not an error. Anything other
    // than 0/1 (typically 128) is a real failure.
    if (res.code !== 0 && res.code !== 1) {
      // One such failure is reachable from ordinary use and has a route out git's own text does
      // not mention: a path beyond a symbolic link (a legacy shadow key, #70). Recognised
      // narrowly — exit 128 AND git's exact wording — so every other failure keeps reporting
      // what actually happened. Never `return []`: saying "nothing is ignored" here would let
      // the commit stage a file git means to exclude.
      const beyond = res.code === 128 ? beyondSymlinkPaths(res.stderr, rels) : null;
      if (beyond) throw new PathBeyondSymlinkError(beyond, rels.length);
      throw new Error(`git check-ignore failed: ${res.stderr.trim()}`);
    }
    const matched = res.stdout
      .split('\0')
      .filter(Boolean)
      .map((p) => toPosix(p));
    if (matched.length === 0) return matched;
    if (opts.tracked === 'index') {
      if (!(await this.isCaseInsensitive(dir))) return matched;
      const indexNames = (await simpleGit(dir).raw(['ls-files', '-z'])).split('\0').filter(Boolean);
      const canonical = canonicalNames(indexNames);
      return matched.filter((p) => !canonical.has(p));
    }
    const tracked = await this.trackedAtHead(dir, matched);
    return matched.filter((p) => !tracked.has(p));
  }

  /**
   * Whether the repository at `dir` has `core.ignorecase = true` set (git's own default on
   * clone/init on macOS and Windows). Shared by `trackedAtHead`, `commitContents`,
   * `canonicalAtRef` and `ignoredPaths`'s `'index'` route — and public so the tool layer can
   * apply the same fold (`src/lib/caseFold.ts`) to its own by-name comparisons (peer ownership,
   * peer attribution), which must agree with git about which two spellings are one file. Cached per `dir` on this instance —
   * see {@link caseInsensitive}'s doc comment for what that does and does not track.
   */
  async isCaseInsensitive(dir: string): Promise<boolean> {
    let cached = this.caseInsensitive.get(dir);
    if (!cached) {
      cached = (async () => {
        const ignorecase = await execCapture('git', ['config', '--type=bool', 'core.ignorecase'], {
          cwd: dir,
        });
        return ignorecase.code === 0 && ignorecase.stdout.trim() === 'true';
      })();
      this.caseInsensitive.set(dir, cached);
      // A spawn failure is not an answer: forget it so the next call asks again.
      cached.catch(() => this.caseInsensitive.delete(dir));
    }
    return cached;
  }

  /**
   * Which of `rels` (POSIX, relative to the clone) HEAD tracks. Empty for an unborn HEAD
   * (nothing is tracked yet). Run only when `check-ignore` matched something.
   *
   * On an ordinary (case-sensitive) repository this is exact names only, via a literal
   * pathspec (`--literal-pathspecs` because `a[1].tex` is a glob to git otherwise) intersected
   * with `rels` — cheap, and a directory pathspec's recursive matches never count for a file of
   * the same name.
   *
   * `core.ignorecase = true` — which git sets on clone/init on macOS and Windows — breaks that:
   * HEAD can track `Notes.txt` while an ignore rule (`*.txt`) matches, and the caller (and the
   * file on disk) spell it `notes.txt`. A literal pathspec is compared byte-for-byte regardless
   * of `core.ignorecase` (verified against real git), so `ls-tree -- notes.txt` never matches
   * the tree entry `Notes.txt` and a tracked file was reported ignored. There is no pathspec that
   * is both literal (so `a[1].tex` isn't a glob) and case-insensitive, so on an ignorecase
   * repository we list the whole tree with no pathspec and fold names ourselves via
   * `canonicalNames` — `foldCase` IS git's own ASCII-only case folding (never Unicode), so it
   * matches what `core.ignorecase` itself does and never over-matches a non-ASCII case pair (a
   * Kelvin sign, a dotted capital I), and resolution is exact-first, so a tree holding both
   * `Notes.txt` and `notes.txt` is judged correctly for whichever one the caller actually named.
   * The directory components fold too (`Sub/Notes.txt` vs `sub/notes.txt`), since folding runs
   * over the whole relative path. The returned set holds the CALLER's spellings (from `rels`),
   * because `ignoredPaths` filters `matched` (also the caller's spellings) by `tracked.has(p)`.
   */
  private async trackedAtHead(dir: string, rels: string[]): Promise<Set<string>> {
    const git = simpleGit(dir);
    if ((await this.revParseOrNull(git, 'HEAD')) === null) return new Set();
    const caseInsensitive = await this.isCaseInsensitive(dir);
    // `-z` so a name with a newline or non-ASCII byte comes back verbatim, not C-quoted.
    if (!caseInsensitive) {
      const wanted = new Set(rels);
      const tracked = new Set<string>();
      // {@link chunkPathspecs}-batched (#110), and this is the site that made the issue worth
      // doing: `ignoredPaths` (which calls this) runs on EVERY session-scope commit over what
      // the session has touched, so a session with thousands of edited files crossed Windows'
      // command line here routinely rather than on some rare large operation.
      //
      // Combining is a union over a partition, and the absence of output is not ambiguous: a
      // chunk lists exactly the HEAD entries ITS pathspecs match, so a path missing from its own
      // chunk's output is untracked at HEAD, and a chunk printing nothing means none of its
      // paths are tracked — never that nothing is. A chunk that throws propagates (the commit
      // refuses) rather than shrinking the tracked set, which would report a tracked file as
      // ignored and silently drop the session's edit to it. Every chunk keeps
      // `--literal-pathspecs`: `a[1].tex` is a glob otherwise.
      for (const chunk of chunkPathspecs(rels)) {
        const out = await git.raw([
          '--literal-pathspecs',
          'ls-tree',
          '-r',
          '-z',
          '--name-only',
          'HEAD',
          '--',
          ...chunk,
        ]);
        for (const name of out.split('\0')) if (wanted.has(name)) tracked.add(name);
      }
      return tracked;
    }
    // A pathspec can't be both literal and case-insensitive, so list the whole tree and fold.
    const out = await git.raw(['ls-tree', '-r', '-z', '--name-only', 'HEAD']);
    const canonical = canonicalNames(out.split('\0').filter(Boolean));
    return new Set(rels.filter((rel) => canonical.has(rel)));
  }

  /**
   * `rel`'s own spelling as tracked at `ref`, or `rel` unchanged when the repository is
   * case-sensitive, `ref`'s tree listing can't be read (tolerated — fall through, never throw),
   * or `ref` doesn't track `rel` in any spelling. Shared by `readAtRef`/`readAtRefBytes` so a
   * caller who spells a tracked `Notes.txt` as `notes.txt` on a case-insensitive repository
   * (`core.ignorecase = true`, git's own default on macOS/Windows clones) is answered from the
   * real tree entry rather than getting `null` back — which is how `ShadowStore.readHead` (its
   * only caller other than `readAtRef`/`readAtRefBytes` themselves, indirectly) used to seed a
   * null base for such a spelling, turning a session's shadow into the whole working-tree file,
   * peer lines included. Deliberately NOT used by the conflict-report `showOrNull` call sites —
   * those paths (from `git diff --diff-filter=U` etc.) come from git itself and are already in
   * whichever spelling git tracks.
   */
  private async canonicalAtRef(
    dir: string,
    git: SimpleGit,
    ref: string,
    rel: string,
  ): Promise<string> {
    if (!(await this.isCaseInsensitive(dir))) return rel;
    // `ShadowStore` asks once per entry per `status`, so the whole-tree listing is memoised by
    // the tree it describes: one `rev-parse` (a line of output) per call, the listing only when
    // the ref moved. One entry per dir — the ref this is asked about is HEAD in practice.
    const sha = await this.revParseOrNull(git, `${ref}^{tree}`);
    if (sha === null) return rel;
    const key = `${dir}\0${sha}`;
    let names = this.canonicalByTree.get(dir);
    if (!names || names.key !== key) {
      let listing: string[];
      try {
        listing = (await git.raw(['ls-tree', '-r', '-z', '--name-only', sha]))
          .split('\0')
          .filter(Boolean);
      } catch {
        return rel;
      }
      names = { key, names: canonicalNames(listing) };
      this.canonicalByTree.set(dir, names);
    }
    return names.names.resolve(rel);
  }

  /**
   * Read a path's content at a commit-ish, or null when it does not exist there. Decodes as
   * text (via simple-git's `git show`) — for content that may not be valid UTF-8 (a binary
   * asset), use `readAtRefBytes` instead. On a case-insensitive repository, resolves `relPath` to
   * `ref`'s own spelling first — see {@link canonicalAtRef}.
   */
  async readAtRef(dir: string, ref: string, relPath: string): Promise<string | null> {
    const git = simpleGit(dir);
    const rel = await this.canonicalAtRef(dir, git, ref, toPosix(relPath));
    return this.showOrNull(git, ref, rel);
  }

  /**
   * The commit HEAD points at, or `'unborn'` for a repository with no commits yet. Never throws:
   * `ShadowStore.refresh` calls this once per call to decide whether a conflicted entry's verdict
   * can have changed (it cannot while HEAD is the same commit), and an unanswerable HEAD must
   * degrade to "re-evaluate everything", never to a failed `status`/`commit`.
   */
  async headSha(dir: string): Promise<string> {
    return (await this.revParseOrNull(simpleGit(dir), 'HEAD')) ?? 'unborn';
  }

  /**
   * Byte-exact analogue of `readAtRef`: read a path's content at a commit-ish as a raw
   * `Buffer`, or null when it does not exist there. Use this for content that may not be
   * valid UTF-8 (e.g. a PNG), since `readAtRef`/simple-git's `git show` decode as text and
   * would corrupt such bytes. Same case-insensitive resolution as `readAtRef` — see
   * {@link canonicalAtRef}.
   */
  async readAtRefBytes(dir: string, ref: string, relPath: string): Promise<Buffer | null> {
    const rel = await this.canonicalAtRef(dir, simpleGit(dir), ref, toPosix(relPath));
    const res = await execCaptureBytes('git', ['show', `${ref}:${rel}`], { cwd: dir });
    if (res.code !== 0) return null;
    return res.stdout;
  }

  /**
   * Per-file added/removed counts for `git diff <args>`, with every `path` a literal working-tree
   * path. Same two flags `logCommits` needs, for the same reason: every `files[].path` a tool
   * returns is one the caller may pass to `read_file`, so `core.quotePath` (which C-quotes any
   * non-ASCII path — `"r\303\251sum\303\251.tex"`) is turned off, and `--no-renames` keeps a
   * moved file as a delete plus an add rather than one `a/{x => y}.tex` entry that names no file.
   * `commit`/`commitContents` count staged files with `--no-renames` too, so `filesChanged` agrees
   * with `files.length`. Only these per-file lists are affected: the patch text callers show
   * alongside is produced separately and still renders a rename as a rename.
   */
  private async numstat(git: SimpleGit, args: string[]): Promise<DiffFile[]> {
    // `--literal-pathspecs`: shares `diff()`'s `tail` array, which can carry a caller-supplied
    // pathspec (`-- opts.path`) — without it the same glob expansion `diff()`'s patch call is
    // guarded against would also inflate this diffstat.
    const out = await git.raw([
      '-c',
      'core.quotePath=false',
      '--literal-pathspecs',
      'diff',
      // Counts are git's own: no external diff tool, no colour (see PLAIN_PATCH_FLAGS).
      '--no-color',
      '--no-ext-diff',
      '--no-renames',
      '--numstat',
      ...args,
    ]);
    return parseNumstat(out);
  }

  /**
   * Which of `paths` (POSIX, project-relative) are a symbolic link on ANY side the caller could
   * write through: mode `120000` in HEAD's tree, mode `120000` in the index, an actual link on
   * disk (`lstat`), or an ancestor directory that is a link ({@link linkedAncestor}). Returns the
   * matches, deduplicated and sorted, POSIX.
   *
   * Why all four: an operation that restores file CONTENT at a path writes through whatever that
   * path currently is. HEAD's mode is what a checkout would put back, the index's is what a
   * `read-tree`/`commitContents` sees, the on-disk one is what `writeFile` would follow, and a
   * linked ANCESTOR lands the bytes outside the project even though the final component is an
   * ordinary name. Same reasoning as {@link hasLinkOnConflictSide}: refuse rather than follow.
   *
   * This is the generalisation of the private `linksAmong` that `revert` uses — minus its
   * commit-lineage refs (a revert has commits to look at; a caller-named path set does not) and
   * plus the index. `linksAmong` is deliberately NOT refactored to call this: `revert`'s refusal
   * set is its own, and widening or narrowing it is not this method's business.
   *
   * Two deliberate differences from `linksAmong`'s body, both load-bearing:
   * - **An unstattable path counts as a link — fail closed.** ENOENT means "not a link there" and
   *   falls through to the tree/index checks, but any other `lstat` failure (EACCES on the parent,
   *   ELOOP) means the path could NOT be judged, and an unjudged path must not be handed back as
   *   safe to write through. `linksAmong` swallows every error here; this one does not.
   * - **An unborn HEAD is skipped, not thrown on.** A freshly-initialised clone has no HEAD tree
   *   to probe; the index and working-tree checks still apply.
   *
   * Every git call carries `--literal-pathspecs` (the GLOBAL option, before the subcommand) so
   * `a[1].tex` never also means `a1.tex`, `-c core.quotePath=false` so a non-ASCII path comes back
   * verbatim rather than C-quoted, and `-z` so a path holding a newline does not split a record.
   */
  async linkPathsAmong(dir: string, paths: string[]): Promise<string[]> {
    if (paths.length === 0) return [];
    const git = simpleGit(dir);
    const links = new Set<string>();

    // Both listings are {@link chunkPathspecs}-batched: `shelve` hands this every path it is about
    // to take, and a few hundred long ones overflowed Windows' command line in one spawn. The
    // chunks partition `paths`, so the union of their records is what one call would list.
    const headBorn = (await this.revParseOrNull(git, 'HEAD')) !== null;
    for (const chunk of chunkPathspecs(paths)) {
      // HEAD's tree: `<mode> <type> <sha>\t<path>`. Skipped entirely on an unborn HEAD.
      if (headBorn) {
        const out = await git.raw([
          '-c',
          'core.quotePath=false',
          '--literal-pathspecs',
          'ls-tree',
          '-z',
          'HEAD',
          '--',
          ...chunk,
        ]);
        for (const entry of out.split('\0')) {
          const tab = entry.indexOf('\t');
          if (tab < 0) continue;
          if (entry.slice(0, entry.indexOf(' ')) !== '120000') continue;
          links.add(toPosix(entry.slice(tab + 1)));
        }
      }

      // The index: `<mode> <sha> <stage>\t<path>` — a different record shape from `ls-tree`'s,
      // but the mode is still the leading field.
      const staged = await git.raw([
        '-c',
        'core.quotePath=false',
        '--literal-pathspecs',
        'ls-files',
        '-s',
        '-z',
        '--',
        ...chunk,
      ]);
      for (const entry of staged.split('\0')) {
        const tab = entry.indexOf('\t');
        if (tab < 0) continue;
        if (entry.slice(0, entry.indexOf(' ')) !== '120000') continue;
        links.add(toPosix(entry.slice(tab + 1)));
      }
    }

    for (const raw of paths) {
      const rel = toPosix(raw);
      if (links.has(rel)) continue;
      let onDisk: boolean;
      try {
        onDisk = (await lstat(path.join(dir, rel))).isSymbolicLink();
      } catch (err) {
        // Fail closed: only a verifiably absent path (ENOENT) clears this check.
        onDisk = (err as NodeJS.ErrnoException).code !== 'ENOENT';
      }
      if (onDisk) {
        links.add(rel);
        continue;
      }
      if ((await linkedAncestor(dir, rel)) !== null) links.add(rel);
    }
    return [...links].sort();
  }

  /**
   * Per-file added/removed line counts for `paths` against HEAD — `git diff HEAD -- <paths>`, for
   * the TRACKED paths among them.
   *
   * A thin public wrapper over the private {@link numstatBatched} (and so {@link numstat}, which
   * already carries `--literal-pathspecs` and `core.quotePath=false`; the flags are deliberately
   * not repeated here).
   *
   * **Untracked files never appear in `git diff HEAD` at all.** That is expected, not a gap: the
   * caller (`shelve`) counts an untracked file's lines itself, from the bytes it is taking. Do not
   * "fix" this by widening the diff — an untracked path has no HEAD side to diff against, and
   * making one up would report a file as modified that git considers absent.
   *
   * Empty `paths` → `[]` with no git call. An unborn HEAD → `[]`: there is no HEAD to diff
   * against, and every path is untracked by definition.
   */
  async statAgainstHead(dir: string, paths: string[]): Promise<DiffFile[]> {
    if (paths.length === 0) return [];
    const git = simpleGit(dir);
    if ((await this.revParseOrNull(git, 'HEAD')) === null) return [];
    // Batched ({@link numstatBatched}): `shelve` passes every path it takes, and one `diff` over a
    // few hundred long paths overflowed Windows' command line.
    return this.numstatBatched(
      git,
      ['HEAD'],
      paths.map((p) => toPosix(p)),
    );
  }

  /**
   * {@link numstat} over a pathspec list too long for one command line: `git diff <leading> --
   * <chunk>` once per {@link chunkPathspecs} chunk, concatenated.
   *
   * The concatenation IS the union: `chunkPathspecs` partitions the paths, so a file can be
   * reported by at most one chunk, and a path a chunk reports nothing for is unchanged in that
   * diff rather than unexamined. Chunks keep the input's order and git sorts within each, so the
   * result is byte-for-byte what a single call returns for an ordered path list. Handed the whole
   * list this is exactly one call, so the small case is unchanged.
   */
  private async numstatBatched(
    git: SimpleGit,
    leading: string[],
    paths: string[],
  ): Promise<DiffFile[]> {
    const files: DiffFile[] = [];
    for (const chunk of chunkPathspecs(paths)) {
      files.push(...(await this.numstat(git, [...leading, '--', ...chunk])));
    }
    return files;
  }

  /**
   * The blob id `content` would get if committed at `relPath` — `git hash-object --stdin --path`
   * WITHOUT `-w`, so nothing is written. `--path` applies the path's gitattributes clean filter
   * (`* text=auto` turns CRLF into LF), which is exactly the point: two byte strings with the same
   * id here are the same content *as git will store it*, even when their raw bytes differ. That is
   * the equality `ShadowStore` needs to tell "our change landed" from "a peer changed this file"
   * on a clone whose attributes normalise what `commitContents` writes.
   */
  async cleanBlobId(dir: string, relPath: string, content: Buffer): Promise<string> {
    return this.hashObject(dir, toPosix(relPath), content, { write: false });
  }

  /** Write `content` into the object database (unless `write: false`) and return its blob sha. */
  private async hashObject(
    dir: string,
    relPath: string,
    content: string | Buffer,
    opts: { write: boolean } = { write: true },
  ): Promise<string> {
    const args = ['hash-object', ...(opts.write ? ['-w'] : []), '--stdin', '--path', relPath];
    const res = await execCapture('git', args, {
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
    // `--literal-pathspecs`: a pathspec is a glob by default, so `a[1].tex` would also match `a1.tex`
    // and a backslash in a name escapes instead of matching. The path here is a literal name.
    const out = await git.raw(['--literal-pathspecs', 'ls-files', '-s', '--', relPath]);
    return out.trim().split(/\s+/)[0] || null;
  }

  /**
   * Whether `relPath` is a symlink on OUR or THEIR side of a paused rebase conflict: the working
   * tree (`lstat` — for an ours-vs-theirs type change git checks the link itself out at the
   * path) or conflict stage 2/3 in the index ({@link hasLinkOnConflictSide} over `git ls-files
   * -s`). The index arm is belt and braces for a checkout layout that leaves a regular file at
   * the path while a side is still a link. A missing working-tree file (`ENOENT`, e.g. a
   * delete/modify conflict) is not a link — only an actual link is refused.
   */
  private async hasSymlinkMode(dir: string, git: SimpleGit, relPath: string): Promise<boolean> {
    try {
      const st = await lstat(path.join(dir, relPath));
      if (st.isSymbolicLink()) return true;
    } catch {
      // Absent from the working tree (e.g. a delete/modify conflict) — not a link.
    }
    // `--literal-pathspecs`: a pathspec is a glob by default, so `a[1].tex` would also match `a1.tex`
    // and a backslash in a name escapes instead of matching. The path here is a literal name.
    return hasLinkOnConflictSide(
      await git.raw(['--literal-pathspecs', 'ls-files', '-s', '--', relPath]),
    );
  }

  /**
   * Reset the index to HEAD, tolerating an unborn HEAD (a freshly `git init`'d clone with no
   * commits yet) — plain `git read-tree --reset HEAD` fails there with "fatal: Not a valid
   * object name HEAD". `--verify --quiet` is the cheap, side-effect-free way to ask "does HEAD
   * resolve to a commit yet", but simple-git's error detection only rejects a `raw()` call when
   * the process both exits non-zero AND writes to stderr — `--quiet` suppresses exactly the
   * stderr git would otherwise write on failure, so a rejected `git.raw(...)` never fires and
   * `born` would always read true. Shell out directly with `execCapture` and check the exit
   * code instead, the same seam `hashObject` below already uses for this reason. When unborn,
   * `read-tree --empty` leaves the index empty, the correct "reset to HEAD" for a repo whose
   * HEAD has no tree at all.
   */
  private async resetIndexToHead(dir: string, git: SimpleGit): Promise<void> {
    const born =
      (await execCapture('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: dir }))
        .code === 0;
    await git.raw(born ? ['read-tree', '--reset', 'HEAD'] : ['read-tree', '--empty']);
  }

  /**
   * Discard uncommitted changes (working tree + untracked), optionally limited to paths.
   *
   * The path-limited branch batches its pathspec lists ({@link chunkPathspecs}), so a failure
   * part way through destroys some of the named paths and not others — {@link discardedOrExplain}
   * is what tells the caller so.
   *
   * `discarded` answers "did this call REACH the paths it was given" — whether git knew each
   * requested path at all — not "were bytes destroyed": a tracked path already identical to HEAD
   * is reached and discarded even though nothing changed on disk. `missed` names the requested
   * paths git matched nothing for, in the caller's own spelling, and is **omitted when empty** so
   * the ordinary result shape stays `{ discarded: true }`. Before #127 both halves were silent:
   * `git clean -f` matching nothing exits 0, so a request naming a file that was never there —
   * or, on an ignorecase clone, naming an untracked file in another case — came back
   * `discarded: true` with the file still sitting on disk. In the server's most destructive call,
   * being told a discard happened when it did not is the failure mode that matters.
   */
  async discard(dir: string, paths?: string[]): Promise<{ discarded: boolean; missed?: string[] }> {
    const git = simpleGit(dir);
    if (paths && paths.length > 0) {
      // `--literal-pathspecs`, as for every path-taking call in this file: a pathspec is a glob by
      // default, and this is the most destructive place for `a[1].tex` to also mean `a1.tex`.
      // `checkout --` errors "did not match any file(s) known to git" for a path git does not
      // track at all — there is nothing at HEAD to check it back out to — so an untracked path
      // (e.g. a scratch file the caller wants discarded alongside a tracked edit) used to fail the
      // whole call before `clean` ever ran, discarding nothing. Restrict `checkout` to the subset
      // the index actually tracks (`coversPath`'s directory rule, as in `commit` above: naming a
      // directory tracked underneath still counts), and skip it entirely when that subset is
      // empty. `clean -f` always runs over every requested path regardless — untracked is exactly
      // what it exists to remove, and a path matching nothing there at all stays a no-op (exit 0)
      // rather than an error; it is now counted into `missed` instead of passing unremarked.
      // A literal pathspec never folds case (as in `commit` above), so on a case-insensitive
      // repository (`core.ignorecase = true`) a caller naming a tracked file in another case than
      // the index — the same file on that filesystem — matched nothing below, `checkout` was
      // skipped, and `clean -f` cannot remove a tracked file: `discarded: true` came back with the
      // edit still sitting on disk. Resolve every requested path onto the index's own spelling
      // first, the same way `commit`'s `paths` branch does; a path the index does not track keeps
      // the caller's spelling unchanged, so an untracked scratch file still falls through to
      // `clean` exactly as before. On a case-sensitive repository this costs nothing extra.
      //
      // The spelling is resolved against HEAD's tree as well as the index: `discard` restores to
      // the last COMMIT (see the restore below), so a path staged for deletion — gone from the
      // index, still at HEAD — is one this call reaches, and must fold onto HEAD's spelling too.
      const caseInsensitive = await this.isCaseInsensitive(dir);
      const fold = caseInsensitive ? foldCase : undefined;
      const born = (await this.revParseOrNull(git, 'HEAD')) !== null;
      let resolvedPaths = paths;
      let indexNames: string[] = [];
      if (caseInsensitive) {
        indexNames = (await git.raw(['ls-files', '-z'])).split('\0').filter(Boolean);
        const headNames = born
          ? (await git.raw(['ls-tree', '-r', '-z', '--name-only', 'HEAD']))
              .split('\0')
              .filter(Boolean)
          : [];
        // Index first: `canonicalNames` keeps the first spelling it meets for a folded key, and
        // the index's is the one the restore below will be matching against.
        const canonical = canonicalNames([...indexNames, ...headNames]);
        resolvedPaths = paths.map((p) => canonical.resolve(toPosix(p)));
      }
      // The UNTRACKED half of the same question (#127). The index fold above left `clean` running
      // over the caller's raw spelling, because an untracked file has no index entry to resolve
      // against — so on an ignorecase clone `discard(['scratch.txt'])` folded a tracked path but
      // left an untracked `Scratch.txt` on disk, and one call folded or did not depending on
      // something the caller cannot see. `--icase-pathspecs` is not the way out: git refuses it
      // alongside `--literal-pathspecs`, which every path-taking call here carries so that
      // `a[1].tex` never also means `a1.tex`. So resolve against the OTHER source of truth — the
      // working tree's untracked listing — with the same exact-spelling-first `canonicalNames`
      // machinery, and keep every pathspec literal. `--exclude-standard` matches what `clean -f`
      // (no `-x`) will actually remove, so the listing and the removal agree about ignored files.
      // One extra `ls-files` per path-limited discard, unconditional because `missed` below needs
      // the listing on a case-sensitive clone too; the fold itself is applied only when
      // `core.ignorecase` says so, never because of what the filesystem does.
      const untracked = (
        await git.raw(['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z'])
      )
        .split('\0')
        .filter(Boolean);
      let cleanPaths = paths;
      if (caseInsensitive) {
        // On an unborn HEAD a STAGED new file is untracked once the `reset` below has run, but
        // it is not in the untracked listing yet — it is an index entry. Include the index names
        // so `clean` sees the spelling it will find on disk then. (On a born HEAD the restore
        // removes such a file itself, and `clean` matching nothing there is a no-op.)
        const canonicalUntracked = canonicalNames([...untracked, ...indexNames]);
        cleanPaths = paths.map((p) => canonicalUntracked.resolve(toPosix(p)));
      }
      // All the listings and destructive calls below are {@link chunkPathspecs}-batched (#110),
      // every chunk keeping `--literal-pathspecs`. A listing combines as a concatenation — the
      // chunks partition the list, each chunk prints the entries ITS pathspecs match, and a chunk
      // printing nothing means none of its own paths are listed, never that none are.
      const indexed: string[] = [];
      const headed: string[] = [];
      for (const chunk of chunkPathspecs(resolvedPaths)) {
        indexed.push(
          ...(await git.raw(['--literal-pathspecs', 'ls-files', '-z', '--', ...chunk]))
            .split('\0')
            .filter(Boolean),
        );
        if (born) {
          headed.push(
            ...(
              await git.raw([
                '--literal-pathspecs',
                'ls-tree',
                '-r',
                '-z',
                '--name-only',
                'HEAD',
                '--',
                ...chunk,
              ])
            )
              .split('\0')
              .filter(Boolean),
          );
        }
      }
      // `discard` promises the LAST COMMIT, not the index. `checkout -- <paths>` restored from
      // the index, so a STAGED modification used to survive as the file's content, and `clean`
      // never removes an index entry, so a staged NEW file survived outright — both under
      // `discarded: true`, and `revert`'s own recovery text sends callers here for a revert that
      // may still be staged. So every path either side knows is restored from HEAD, index and
      // working tree together, in ONE index write per chunk: `checkout --no-overlay HEAD --`
      // puts back HEAD's bytes for a staged modification or deletion and removes (index entry
      // and file) what the index has under the path but HEAD does not — a staged new file.
      // One write rather than `reset` then `checkout`: `status` takes no project lock and
      // refreshes the index under `index.lock`, so every extra index-writing spawn here is one
      // more window for a peer's `status` to make this call fail part way. An unborn HEAD has
      // no tree to name, so there the index entries are dropped with `reset --` instead (which
      // reads an unborn HEAD as the empty tree), leaving the files untracked for `clean`.
      // Only paths that cover a HEAD or index entry are named: `checkout` refuses a pathspec
      // "known to git" nowhere, which is what `clean` below is for.
      const indexedOrHeaded = [...indexed, ...headed];
      const toRestore = resolvedPaths.filter((p) =>
        indexedOrHeaded.some((name) => coversPath(p, name, fold)),
      );
      // What this call will reach: every requested path that covers a HEAD entry, an index entry
      // or an untracked working-tree file (`coversPath`'s directory rule, so naming a directory
      // counts for what lies under it). Reported in the CALLER's own spelling — that is the
      // string they typed and the one they have to correct. Computed BEFORE the destructive
      // steps: afterwards a path that was reached looks exactly like one that never matched,
      // since its file is gone or back at HEAD.
      const missed = paths.filter((p) => {
        const rel = toPosix(p);
        return (
          !indexedOrHeaded.some((name) => coversPath(rel, name, fold)) &&
          !untracked.some((name) => coversPath(rel, name, fold))
        );
      });
      // The DESTRUCTIVE steps share one wrapper, so a failure in `clean` also reports the
      // restore chunks that already landed — see `discardedOrExplain`. Each chunk restores or
      // removes only its own paths, with no cross-path state, so the chunks compose into exactly
      // the discard one call of each would have performed.
      await this.discardedOrExplain(async () => {
        for (const chunk of chunkPathspecs(toRestore)) {
          await git.raw(
            born
              ? ['--literal-pathspecs', 'checkout', '--no-overlay', 'HEAD', '--', ...chunk]
              : ['--literal-pathspecs', 'reset', '-q', '--', ...chunk],
          );
        }
        for (const chunk of chunkPathspecs(cleanPaths)) {
          await git.raw(['--literal-pathspecs', 'clean', '-f', '--', ...chunk]);
        }
      });
      // A partial miss still discarded something, so `discarded` stays true and `missed` names
      // the rest; only a call that reached nothing at all reports `discarded: false`. A bare
      // boolean cannot say "one of the two", and a bare list would leave `discarded: true` on a
      // call that did nothing.
      return {
        discarded: missed.length < paths.length,
        ...(missed.length > 0 ? { missed } : {}),
      };
    }
    // The whole-tree branch names no path, so nothing can be missed: restoring from HEAD plus
    // `clean -fd` always leaves the tree at HEAD, which is the whole of what it promises. From
    // HEAD, not the index, for the path-limited branch's reason (`checkout -- .` left a staged
    // modification in place and a staged new file on disk) and in one index write for the same
    // reason too. On an unborn HEAD there is no tree to restore from: `reset` empties the index
    // and `clean` removes what it held.
    if ((await this.revParseOrNull(git, 'HEAD')) !== null) {
      await git.raw(['checkout', '--no-overlay', 'HEAD', '--', '.']);
    } else {
      await git.raw(['reset', '-q']);
    }
    await git.clean('fd');
    return { discarded: true };
  }

  /**
   * Run {@link discard}'s batched, DESTRUCTIVE steps and, if one fails, say what is already gone.
   *
   * This is the {@link landedOrExplain} shape rather than {@link stageOrExplain}'s, and for the
   * revert's reason: `checkout`/`clean` overwrite and delete working-tree content, and a chunk
   * that has run cannot be taken back. A caller told only "discard failed" would reasonably read
   * that as "my changes are still there" — for an earlier chunk's files they are not, and no
   * `status` reading before the call can be trusted afterwards.
   *
   * Where it deliberately differs from the revert's wording: a revert forbids the retry (it would
   * apply the change twice), while here the retry is the way to finish the job — it just destroys
   * the rest, which is what was asked for, so the message says that outright instead of banning
   * it. It also does not count the paths: the split between what fell and what stands is what
   * `status` answers, and quoting the requested total here would invite reading it as the number
   * destroyed.
   *
   * Nothing is cleaned up on the way out on purpose. The tool's baseline reset and shadow settle
   * run only on success, so after a partial discard this session's records and revision baselines
   * still describe the pre-discard tree: a later `edit_file` on a discarded path then refuses with
   * `ExternalChangeError` (overridable) rather than writing over it, which is the safe direction.
   */
  private async discardedOrExplain<T>(step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `The discard failed PART WAY THROUGH: ${reason}. A long path list is split across ` +
          'several git calls, so some of the named paths have ALREADY been reverted to HEAD or ' +
          'deleted — that content is gone and cannot be recovered here — while the rest still ' +
          'hold their uncommitted changes. Run `status` to see which is which. Running `discard` ' +
          'again finishes the job and destroys the rest; it will not bring the first part back.',
        { cause: err },
      );
    }
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
    await this.fetchOrigin(dir, gitUrl, auth);
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
    await this.fetchOrigin(dir, gitUrl, auth);
    const rebasedOver = await this.logCommits(git, `HEAD..origin/${branch}`);
    const first = await this.tryRebase(dir, git, branch, `origin/${branch}`, () =>
      this.withAuth(dir, gitUrl, auth, ['pull', '--rebase', 'origin', branch]),
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
        this.withAuth(dir, gitUrl, auth, ['pull', '--rebase', 'origin', branch]),
      );
    const pushResult = await this.pushWithRetry(
      dir,
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
    // A retry round's rebase can shrink what's ahead — including to zero, when a collaborator
    // landed an identical change and our replayed commit became empty and was dropped.
    // `pushResult.pushedCommits` is the fresh, post-rebase count for that case; `undefined` means
    // the push succeeded on attempt 1, where `ab.ahead` (read before any rebase since) still holds.
    if (pushResult.pushedCommits === 0) {
      return {
        ...this.nothingToPush(gitUrl, branch, committedSha, GitService.DROPPED_COMMIT_SUMMARY),
        ...(pushResult.rebasedOver.length ? { rebasedOver: pushResult.rebasedOver } : {}),
      };
    }
    const pushedCommits = pushResult.pushedCommits ?? ab.ahead;
    return {
      status: 'pushed',
      pushed: true,
      remote: gitUrl,
      branch,
      summary: `Pushed ${pushedCommits} commit(s) to origin/${branch}.`,
      committedSha,
      pushedCommits,
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
   * rather than applying a merge against a stale `theirs`. A path that is a symlink on either side
   * of the conflict (upstream retargeted it, or we did) is refused too — a resolution carries file
   * content, never a link target, so writing one through a link would land in whatever it points
   * at instead of resolving it. Never force-pushes.
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
    // `expectedRemoteHead` is a pin on ONE commit, so it must name one: a hex SHA (full, or the
    // abbreviated form the conflict text prints). Any rev used to be accepted and resolved in
    // this clone, so `origin/<branch>`, `FETCH_HEAD` or `@{u}` — each of which names whatever the
    // remote is NOW — always "matched" and the guard was silently off. Refused before anything
    // is committed or fetched, so a bad pin costs the clone nothing.
    const expectedPin = opts.expectedRemoteHead?.trim();
    if (opts.expectedRemoteHead !== undefined && !/^[0-9a-f]{4,40}$/i.test(expectedPin ?? '')) {
      throw new Error(
        `expectedRemoteHead must be a commit SHA (4 to 40 hex characters) — the \`remoteHead\` ` +
          `the conflict reported — not "${opts.expectedRemoteHead}". A ref name such as ` +
          'origin/<branch>, FETCH_HEAD or @{u} names wherever the remote is now, so it would ' +
          'always match and pin nothing. Nothing was pushed.',
      );
    }

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

    await this.fetchOrigin(dir, gitUrl, auth);
    const rebasedOver = await this.logCommits(git, `HEAD..origin/${branch}`);

    // The remote head THIS call checks and rebases onto — read once, from the fetch above. The
    // rebase below targets this sha rather than re-running `pull --rebase`, which fetched a
    // SECOND time: a commit landing between the two fetches was then rebased onto after the pin
    // had already passed, and the caller's verbatim resolution (merged against the older
    // `theirs`) overwrote it. With no second fetch, a later move surfaces on the push itself —
    // a non-fast-forward, reported `remote-moved` when pinned (one round) or retried as a fresh
    // conflict-reporting rebase otherwise, never merged over.
    const remoteSha = await this.revParseOrNull(git, `origin/${branch}^{commit}`);

    // Race guard: if the caller merged against a specific remote head and the remote has advanced
    // since, `theirs` may now be stale — refuse rather than silently merge over what just landed.
    // A pin with NO remote head to check it against (the branch was deleted or renamed upstream)
    // is refused as well: it cannot be verified, and there is nothing to rebase onto — left to
    // the rebase, it surfaced as git's raw "invalid upstream".
    if (expectedPin !== undefined && remoteSha === null) {
      throw new Error(
        `There is no origin/${branch} after fetching, so expectedRemoteHead ${expectedPin} ` +
          'cannot be checked and there is nothing to rebase onto — the branch may have been ' +
          'deleted or renamed on the remote. Nothing was pushed. Check where the remote branch ' +
          'went (project_sync, status) before resolving again.',
      );
    }
    if (expectedPin !== undefined && remoteSha !== null) {
      // The pin is hex (checked above), so "is it the current remote head" is a prefix test on
      // the full sha — which also covers an abbreviation this clone finds ambiguous. The
      // `rev-parse --verify` only improves the message: the full sha the pin names, when this
      // clone knows exactly one.
      const matches = remoteSha.startsWith(expectedPin.toLowerCase());
      if (!matches) {
        const expectedFull = await git
          .raw(['rev-parse', '--verify', `${expectedPin}^{commit}`])
          .then((out) => out.trim() || null)
          .catch(() => null);
        throw new Error(
          `Remote moved since you computed the merge (origin/${branch} was ` +
            `${expectedFull ?? expectedPin}, now ${remoteSha}). ` +
            'Nothing was pushed. Re-run push to fetch the current conflict, recompute the merge ' +
            'against the fresh "theirs", and resolve again.',
        );
      }
    }

    // Snapshot HEAD so an invalid resolution set (extra files) can be fully undone after the fact.
    const origHead = (await git.revparse(['HEAD'])).trim();
    const used = new Set<string>();

    // Kick off the rebase; then loop: apply resolutions to whatever is unmerged and continue.
    // Onto `remoteSha` (see above), with `pull --rebase`'s own shape otherwise: `--fork-point`
    // against `origin/<branch>` picks the same commits to replay that the conflicting `push`
    // did (the upstream's reflog, as `pull` consults it), so the conflict resolved here is the
    // conflict that was reported. `origin/<branch>` is not re-fetched, so it still names
    // `remoteSha`. With no remote branch at all an UNPINNED call passes the ref name and git's
    // own "invalid upstream" surfaces through `runRebaseStep`, as `pull` failed before (a pinned
    // one was refused above).
    let step = await this.runRebaseStep(git, () =>
      git.raw([
        'rebase',
        '--fork-point',
        '--onto',
        remoteSha ?? `origin/${branch}`,
        `origin/${branch}`,
      ]),
    );
    // Bound the loop by the number of resolutions (+ slack) so a file that keeps re-conflicting
    // can never spin forever.
    const maxSteps = opts.resolutions.length + 5;
    for (let i = 0; !step.ok; i++) {
      // The whole step is one try/catch so that ANY throw out of it — not just the two deliberate
      // refusals below — aborts the paused rebase first. `hasSymlinkMode`'s `ls-files` spawn,
      // `linkedAncestor`'s `lstat`s, `writeFile`, and the `git add` spawn can all throw (a
      // permission error, a spawn failure) and, uncaught, would otherwise leave the clone mid-rebase
      // (conflict markers on disk, detached HEAD) — contradicting the "clone is back to where it
      // was" guarantee this method documents. The `missing`-resolution branch below `return`s
      // rather than throws, so it is unaffected by this catch and keeps its own explicit abort.
      try {
        if (i >= maxSteps) {
          throw new Error(
            'Rebase did not converge after applying the supplied resolutions; aborted without ' +
              'pushing. Re-pull and try the resolution again.',
          );
        }
        // A resolution carries file content, never a link target. Refuse to write through a
        // symlink on either side of the conflict before anything else for this step — including
        // before the "every conflicted path needs a resolution" check below, since a type-change
        // conflict (symlink vs. regular file) can add a synthetic path git itself invents
        // (`notes.tex~HEAD`) that no caller would think to supply a resolution for; the link is
        // what must be refused, not a spurious "missing resolution". `writeFile` follows a link
        // (in-project or pointing outside the clone entirely), so a resolved "notes.tex" would
        // silently land wherever the link points, and `git add` would then stage the untouched
        // link as if it had been resolved. Check the paused rebase's working tree (`lstat`) and
        // the ours/theirs conflict stages in the index (`git ls-files -s`, mode 120000) — either
        // side can carry the link; a link only in the base stage is one both sides already
        // replaced, and is not refused. Ancestor directories are checked too: git itself never
        // leaves a conflicted path beneath a link (a side that turns a directory into a link gets
        // the tracked file moved aside with an unmerged 120000 entry the stage check above already
        // refuses), but a link can be placed by hand into the working tree while the rebase is
        // paused, and `writeFile` would follow it wherever it points.
        const linked: string[] = [];
        const underLink: Array<{ rel: string; via: string }> = [];
        for (const rel of step.unmerged) {
          resolveInside(dir, rel);
          if (await this.hasSymlinkMode(dir, git, rel)) linked.push(rel);
          const via = await linkedAncestor(dir, rel);
          if (via) underLink.push({ rel, via });
        }
        if (linked.length > 0 || underLink.length > 0) {
          throw new Error(
            linked
              .map(
                (rel) =>
                  `"${rel}" is a symbolic link on at least one side of this conflict; a resolution ` +
                  'carries file content and cannot resolve a link.',
              )
              .concat(
                underLink.map(
                  ({ rel, via }) =>
                    `"${rel}" lies under "${via}", a symbolic link in the working tree; a ` +
                    'resolution is written at the path it names and cannot be written through a ' +
                    'link.',
                ),
              )
              .join(' ') +
              ' Nothing was pushed and the rebase was aborted, so the clone is back to where it ' +
              'was before it started — resolve that path by hand and push again, or call ' +
              'reset_to_remote (confirm: true) to rewind the clone to the current remote head ' +
              "(it discards this clone's unpushed commits) so you can re-apply your edits cleanly.",
          );
        }
        const missing = step.unmerged.filter((rel) => !byPath.has(rel));
        if (missing.length > 0) {
          // Can't resolve without content for every conflicted file — fail safe: build the full
          // report, then abort so the clone returns to its pre-resolve state (nothing
          // half-merged). This is a `return`, not a throw, so the outer catch below never sees it
          // — the abort here stays explicit.
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
          await git.raw(['--literal-pathspecs', 'add', '--', rel]);
          used.add(rel);
        }
        step = await this.runRebaseStep(git, () => git.raw(['rebase', '--continue']));
      } catch (err) {
        await this.abortRebaseIfInProgress(git);
        throw err;
      }
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
        this.withAuth(dir, gitUrl, auth, ['pull', '--rebase', 'origin', branch]),
      );
    // When the caller pinned `expectedRemoteHead`, they asked to be refused rather than have their
    // merge silently rebased over a second remote move — one round only, so a lost race here is
    // reported as `remote-moved` (nothing pushed, clone intact) instead of retried.
    const rounds = opts.expectedRemoteHead ? 1 : PUSH_RETRY_ROUNDS;
    const pushResult = await this.pushWithRetry(
      dir,
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
    // See safePush's identical handling: a retry round's rebase can drop our commit as empty.
    if (pushResult.pushedCommits === 0) {
      return {
        ...this.nothingToPush(gitUrl, branch, committedSha, GitService.DROPPED_COMMIT_SUMMARY),
        ...(pushResult.rebasedOver.length ? { rebasedOver: pushResult.rebasedOver } : {}),
      };
    }
    const pushedCommits = pushResult.pushedCommits ?? ab.ahead;
    const pushedSha = (await git.revparse(['HEAD'])).trim();
    return {
      status: 'pushed',
      pushed: true,
      remote: gitUrl,
      branch,
      summary: `Resolved conflict and pushed ${pushedCommits} commit(s) to origin/${branch} (${pushedSha.slice(0, 8)}).`,
      committedSha,
      pushedCommits,
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
    const [diff, files] = await Promise.all([
      git.raw(['diff', ...PLAIN_PATCH_FLAGS, range]),
      this.numstat(git, [range]),
    ]);

    return {
      status: 'awaiting-approval',
      branch: opts.branch,
      base,
      committedSha: committed.sha,
      diff,
      files,
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

    await this.fetchOrigin(dir, gitUrl, auth);

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
      await this.withAuth(dir, gitUrl, auth, ['push', 'origin', base]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isNonFastForwardRejection(message)) throw err;
      await this.fetchOrigin(dir, gitUrl, auth);
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

  /**
   * Clone a project from its tokenless URL, so origin never holds a credential — not even for
   * the length of the clone (it used to clone from the token-bearing URL and reset origin
   * afterwards, so a kill mid-clone left the token in `.git/config`). The credential reaches git
   * through {@link runRemoteGit} instead.
   */
  async clone(gitUrl: string, targetDir: string, auth: AuthConfig, branch?: string): Promise<void> {
    await mkdir(path.dirname(targetDir), { recursive: true });
    // Keep repo line endings (LF) so edit_file's exact match is deterministic on Windows. This is
    // the clone's OWN `-c` (after the subcommand), which git persists into the new repository —
    // deliberately; the credential config from `gitCredentialConfig` is the global kind, which is not.
    const options = ['-c', 'core.autocrlf=false', ...(branch ? ['-b', branch] : [])];
    // `--` ends the options, so a gitUrl can never be read as one.
    await runRemoteGit(undefined, gitUrl, auth, ['clone', ...options, '--', gitUrl, targetDir]);
  }

  /** Fetch and fast-forward (ff-only). Surfaces divergence instead of merging. */
  async syncPull(gitUrl: string, dir: string, auth: AuthConfig): Promise<SyncResult> {
    const git = simpleGit(dir);
    await this.fetchOrigin(dir, gitUrl, auth);
    // The fetch prunes, so a branch renamed or deleted upstream leaves no `origin/<branch>` to
    // count against — and the lenient count below would read that as "0 ahead, 0 behind",
    // `up-to-date` over an unpushed commit. Decide the absence first, in its own terms.
    const branch = await this.currentBranch(git);
    const absence = await this.remoteBranchAbsence(git, branch);
    if (absence) {
      return absence.missing
        ? {
            action: 'remote-branch-missing',
            ahead: absence.unpushed,
            behind: 0,
            diverged: false,
            note: remoteBranchMissingNote(absence.branch, absence.remoteBranches, absence.unpushed),
          }
        : // An empty remote (or one this clone shares no history with): nothing to pull, and
          // nothing this can call missing — but local commits are still counted as unpushed.
          { action: 'up-to-date', ahead: absence.unpushed, behind: 0, diverged: false };
    }
    const ab = await this.aheadBehindOf(git, branch);
    if (ab.behind === 0) {
      return { action: 'up-to-date', ahead: ab.ahead, behind: 0, diverged: false };
    }
    if (ab.ahead > 0) {
      return { action: 'diverged', ahead: ab.ahead, behind: ab.behind, diverged: true };
    }
    try {
      await git.merge(['--ff-only', `origin/${ab.branch}`]);
    } catch (err) {
      throw pullRefusalFromError(err);
    }
    const after = await this.aheadBehindOf(git, branch);
    return { action: 'pulled', ahead: after.ahead, behind: after.behind, diverged: false };
  }

  /** Ahead/behind counts vs the upstream for a clone directory. */
  async aheadBehind(dir: string): Promise<{ branch: string; ahead: number; behind: number }> {
    return this.aheadBehindOf(simpleGit(dir));
  }

  /**
   * `withCommits` (default false) also lists the commits behind `ahead`/`behind`: a
   * `log --numstat` per direction, which only the `status` tool reads. Every internal caller
   * (`commit`, `shelve`, the peer-refusal guard) wants the file lists and counts alone, so it no
   * longer pays for that log — which, with `origin/<branch>` absent, ran over the whole history.
   */
  async status(dir: string, opts: { withCommits?: boolean } = {}): Promise<StatusResult> {
    const git = simpleGit(dir);
    const s = await git.status();
    const branch = await this.currentBranch(git);
    // Same absence check as `syncPull`: with `origin/<branch>` pruned, the lenient count reports
    // 0/0 and the clone reads as in sync while its commits are on no remote branch.
    const absence = await this.remoteBranchAbsence(git, branch);
    const ab = absence
      ? { branch, ahead: absence.unpushed, behind: 0 }
      : await this.aheadBehindOf(git, branch);
    const staged = s.files.filter((f) => f.index !== ' ' && f.index !== '?').map((f) => f.path);
    const unstaged = s.files
      .filter((f) => f.working_dir !== ' ' && f.working_dir !== '?')
      .map((f) => f.path);
    // Show *what* diverged, not just how far. Uses the last-fetched `origin/<branch>` (status does
    // not fetch), so these reflect known divergence — run project_sync to refresh.
    // With `origin/<branch>` absent, `ahead` counts commits on no remote branch, which after the
    // remote lost every branch is the clone's whole history — not the session's own work, and not
    // bounded by it. That list is capped at the house commit cap and the rest counted.
    const want = opts.withCommits === true;
    const [aheadCommits, behindCommits] =
      want && (ab.ahead > 0 || ab.behind > 0)
        ? await Promise.all([
            ab.ahead > 0
              ? this.logCommits(
                  git,
                  absence
                    ? [
                        `--max-count=${CONFLICT_MAX_COMMITS}`,
                        `refs/heads/${ab.branch}`,
                        '--not',
                        '--remotes=origin',
                      ]
                    : `origin/${ab.branch}..${ab.branch}`,
                )
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
      // Only the capped (absent-branch) log can leave commits out; the ordinary range lists all.
      aheadCommitsOmitted: absence && want ? Math.max(0, ab.ahead - aheadCommits.length) : 0,
      behindCommits,
      remoteBranchMissing: absence?.missing ?? false,
      ...(absence?.missing
        ? {
            remoteBranchNote: remoteBranchMissingNote(
              absence.branch,
              absence.remoteBranches,
              absence.unpushed,
            ),
          }
        : {}),
    };
  }

  /**
   * Read a committed version of a file at any ref (e.g. `origin/master:sections/04.tex`) without
   * touching the working tree — the way to see `theirs` (the remote side) that a working-tree read
   * can't reach. `relPath` must be repo-relative POSIX (the caller sandboxes it).
   */
  async showAtRef(dir: string, ref: string, relPath: string): Promise<string> {
    if (/^-/.test(ref)) throw new Error(`Invalid ref "${ref}".`);
    const git = simpleGit(dir);
    // Same case fold as `readAtRef`: on an ignorecase clone the working-tree read of `notes.txt`
    // succeeds (the filesystem folds), so the `ref` read of it must not fail on the spelling.
    const rel = await this.canonicalAtRef(dir, git, ref, toPosix(relPath));
    try {
      return await git.show([`${ref}:${rel}`]);
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
    // `--literal-pathspecs` (like `add`/`ls-files`/`ls-tree` above): a pathspec is a glob by
    // default, so a caller-fed path (this is what `changeDiff`'s write_file/edit_file
    // confirmation diff passes) named "a[1].tex" would also diff a dirty "a1.tex" that nobody
    // asked about. Must precede the subcommand, so this bypasses `git.diff()` for a raw call.
    const [diff, files] = await Promise.all([
      git.raw(['--literal-pathspecs', 'diff', ...PLAIN_PATCH_FLAGS, ...patchArgs]),
      this.numstat(git, [...base, ...tail]),
    ]);
    return { diff, files };
  }

  /**
   * Validate a diff ref before handing it to git: each endpoint of a range (and a bare ref) must
   * resolve to a commit in this clone. Returns the caller's spelling — resolving to a sha would
   * only make the error messages harder to recognise.
   */
  private async resolveDiffRef(git: SimpleGit, ref: string): Promise<string> {
    // A git ref name can never contain `..`, so every `..` here is a range operator. Only the
    // documented shapes pass: one commit-ish, or ONE two-dot range with both ends named. A
    // second operator used to slip through (the lazy split handed `HEAD..HEAD` to `rev-parse` as
    // a single "endpoint", which accepts it as a range) and surface git's raw "bad revision";
    // a three-dot range was accepted although nothing promised it.
    if (ref.includes('...')) {
      throw new Error(
        `Three-dot ranges ("${ref}") are not supported: \`ref\` takes one commit-ish or one ` +
          'two-dot range "A..B". To diff from where two lines of history diverged, pass their ' +
          'merge base explicitly as "<merge-base sha>..B".',
      );
    }
    const parts = ref.split('..');
    if (parts.length > 2) {
      throw new Error(
        `"${ref}" has more than one \`..\`: \`ref\` takes one commit-ish or one two-dot range ` +
          '"A..B".',
      );
    }
    if (parts.length === 2 && parts.some((p) => p === '')) {
      throw new Error(
        `"${ref}" leaves one end of the range empty: name both, as in "HEAD~3..HEAD".`,
      );
    }
    const endpoints = parts;
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

  /**
   * The checked-out branch name. `symbolic-ref` first: it answers on an unborn branch (a clone of
   * an empty remote), where `rev-parse --abbrev-ref HEAD` fails with "ambiguous argument 'HEAD'"
   * and took `status` (and every tool that starts from it) down with it. `symbolic-ref` in turn
   * fails on a detached HEAD, where `rev-parse` still answers `HEAD` — so fall back to it.
   */
  private async currentBranch(git: SimpleGit): Promise<string> {
    try {
      return (await git.raw(['symbolic-ref', '--short', 'HEAD'])).trim();
    } catch {
      return (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    }
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
    await this.fetchOrigin(dir, gitUrl, auth);
    return this.tryRebase(dir, git, branch, `origin/${branch}`, () =>
      this.withAuth(dir, gitUrl, auth, ['pull', '--rebase', 'origin', branch]),
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
      // Everything in this catch runs while the rebase may be paused: listing the unmerged paths
      // and building the report can themselves fail (a spawn error), and a throw from either
      // must not leave the clone mid-rebase — abort first, then propagate.
      let unmerged: string[];
      try {
        unmerged = await this.unmergedPaths(git);
      } catch (listErr) {
        await this.abortRebaseIfInProgress(git);
        throw listErr;
      }
      if (unmerged.length === 0) {
        // Not a conflict (e.g. a network/auth failure). Don't leave a rebase half-applied.
        await this.abortRebaseIfInProgress(git);
        throw untrackedOverwriteFromError(err) ?? err;
      }
      // Mid-rebase the branch ref still points at our original tip, so the report is read from
      // refs (valid now); the working tree supplies the marker view before we abort.
      let report: ConflictReport;
      try {
        report = await this.buildConflictReport(git, dir, oursRef, remoteRef, unmerged);
      } catch (reportErr) {
        await this.abortRebaseIfInProgress(git);
        throw reportErr;
      }
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
      // `unmergedPaths` itself can throw (a spawn failure) rather than answer "no conflict" — and
      // this method is called once to prime the loop in `resolvePush`, from a call site outside
      // that loop's own catch-everything try/catch. Left unguarded, a throw here propagated with
      // the clone mid-rebase, contradicting the "clone is back to where it was" guarantee every
      // other exit from a paused rebase honours.
      let unmerged: string[];
      try {
        unmerged = await this.unmergedPaths(git);
      } catch (unmergedErr) {
        await this.abortRebaseIfInProgress(git);
        throw unmergedErr;
      }
      if (unmerged.length === 0) {
        await this.abortRebaseIfInProgress(git);
        throw untrackedOverwriteFromError(err) ?? err;
      }
      return { ok: false, unmerged };
    }
  }

  private async unmergedPaths(git: SimpleGit): Promise<string[]> {
    return (await git.raw(['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U']))
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
   *
   * `--no-renames` and `-c core.quotePath=false` are load-bearing, not cosmetic: `--numstat`
   * applies rename detection by default, which collapses a two-file change into one
   * `old.tex => new.tex` entry a caller can't feed back into e.g. `read_file`; and
   * `core.quotePath` (on by default) C-quotes any non-ASCII path (`"r\303\251sum\303\251.tex"`)
   * rather than emitting UTF-8. `-c` must precede the subcommand for `git.raw`.
   */
  /** `range` is one revision range, or several revision arguments (e.g. `x --not --remotes`). */
  private async logCommits(
    git: SimpleGit,
    range: string | readonly string[],
  ): Promise<RemoteCommit[]> {
    try {
      const out = await git.raw([
        '-c',
        'core.quotePath=false',
        'log',
        '--no-renames',
        '--format=%x00%H%x09%s',
        '--numstat',
        ...(typeof range === 'string' ? [range] : range),
      ]);
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
        `(${capList(report.conflictPaths, 20)}). The rebase was aborted and nothing was pushed — ` +
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
   *
   * A retry round's rebase can also change what's actually ahead of the remote — including to
   * zero, when a collaborator lands a change identical to ours and the replayed commit becomes
   * empty and is dropped. So from the second attempt on, the ahead count is re-read immediately
   * before that attempt's push rather than trusting the caller's pre-round read: if it's now
   * zero, the push is skipped (there is nothing left to send) and `pushedCommits: 0` is returned;
   * otherwise the fresh count rides along as `pushedCommits` so the caller never reports a push
   * that didn't happen, or the wrong commit count for one that did. That re-read uses
   * {@link aheadBehindStrictOf}, not the lenient `aheadBehindOf`: at this point in the loop no
   * rebase is in progress (the prior round's `rebaseAgain` already resolved, ok or not, before we
   * get here) and `ahead` was non-zero moments earlier, so a `rev-list` failure here must propagate
   * as an error rather than be misread as "the rebase dropped our commit" and silently reported as
   * `nothing-to-push`.
   */
  private async pushWithRetry(
    dir: string,
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
      let pushedCommits: number | undefined;
      if (attempt > 1) {
        const ab = await this.aheadBehindStrictOf(git);
        if (ab.ahead === 0) return { ok: true, rebasedOver: over, pushedCommits: 0 };
        pushedCommits = ab.ahead;
      }
      await this.hooks.beforePush?.(attempt);
      try {
        await this.withAuth(dir, gitUrl, auth, ['push', 'origin', branch]);
        return { ok: true, rebasedOver: over, pushedCommits };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isNonFastForwardRejection(message)) throw err;

        if (attempt < rounds) {
          await this.fetchOrigin(dir, gitUrl, auth);
          const justLanded = await this.logCommits(git, `HEAD..origin/${branch}`);
          over = mergeNewestFirst(justLanded, over);
          const outcome = await rebaseAgain();
          if (!outcome.ok) return { ok: false, kind: 'conflict', report: outcome.report };
          continue;
        }

        // Final attempt: fetch once more and fold the commit that just won the race into
        // `over` too, so `rebasedOver` accounts for the exact remote tip named by `remoteHead`
        // — otherwise the landing that caused this very failure would be missing from it.
        await this.fetchOrigin(dir, gitUrl, auth);
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
    // remoteHead can be '' when origin/<branch> couldn't be resolved (revParseOrNull) — omit the
    // "(now at …)" clause rather than rendering "now at )".
    const movedClause = remoteHead ? ` (now at ${remoteHead.slice(0, 8)})` : '';
    return {
      status: 'remote-moved',
      pushed: false,
      remote: gitUrl,
      branch,
      summary:
        `Remote origin/${branch} moved during the push${movedClause} ` +
        `after ${attempts} attempt(s); nothing was pushed. ${recovery}`,
      remoteHead,
      ...(rebasedOver.length ? { rebasedOver } : {}),
    };
  }

  private nothingToPush(
    gitUrl: string,
    branch: string,
    committedSha?: string,
    summary?: string,
  ): SafePushResult {
    return {
      status: 'nothing-to-push',
      pushed: false,
      remote: gitUrl,
      branch,
      summary: summary ?? 'Nothing to push; already up to date with the remote.',
      committedSha,
    };
  }

  /**
   * `nothingToPush`'s summary for the "a retry round's rebase dropped our commit as empty" case —
   * used at both dropped-commit return sites (`safePush` and `resolvePush`). The generic "already up
   * to date" wording doesn't tell the caller their just-made commit was replayed empty and discarded
   * because an identical change had already landed upstream.
   */
  private static readonly DROPPED_COMMIT_SUMMARY =
    "Nothing left to push: after rebasing onto the remote, this session's commit was already " +
    'there (an identical change landed upstream) and was dropped.';

  /** `branch`, when the caller already resolved it, saves the `currentBranch` spawn(s). */
  private async aheadBehindOf(
    git: SimpleGit,
    branch?: string,
  ): Promise<{ branch: string; ahead: number; behind: number }> {
    try {
      return await this.aheadBehindStrictOf(git, branch);
    } catch {
      // No upstream tracking ref yet (e.g. before first fetch).
      return { branch: branch ?? (await this.currentBranch(git)), ahead: 0, behind: 0 };
    }
  }

  /**
   * Whether `origin/<branch>` is absent (as of the last fetch, which prunes), and if so what that
   * means — `null` when it resolves, which is the ordinary case and costs one `rev-parse`.
   *
   * Absent splits two ways, and `missing` is the split:
   *
   * - **missing** — the remote still has at least one branch, this clone's branch shares
   *   history with the remote's branches (some of its commits are reachable from `origin/*`), AND
   *   the branch tracks its namesake upstream (`branch.<name>.remote` is `origin` and
   *   `branch.<name>.merge` is `refs/heads/<name>` — set by the clone, including a clone of an
   *   empty remote). The branch came from there and is gone: renamed or deleted upstream.
   * - **not missing** — the remote has no branches at all (an empty repository, freshly cloned),
   *   or this clone's branch shares nothing with them (unborn, or an unrelated history pushed to
   *   a differently named branch after an empty clone), or the branch was never tracking
   *   `origin/<name>` — a local branch that was never pushed, such as the review branch
   *   `prepareBranch` leaves the clone on (`checkout -B`), even when `branch.autoSetupMerge`
   *   gave it a local upstream or `--set-upstream-to` pointed it at another origin branch.
   *   Nothing here can be called gone; its commits are plainly unpushed.
   *
   * Either way `unpushed` counts the local commits reachable from no remote branch — never the
   * lenient `0` {@link aheadBehindOf} returns when its range fails to resolve, which is what let a
   * pruned branch report an unpushed commit as in sync.
   */
  private async remoteBranchAbsence(
    git: SimpleGit,
    branch: string,
  ): Promise<{
    branch: string;
    missing: boolean;
    remoteBranches: string[];
    unpushed: number;
  } | null> {
    if ((await this.revParseOrNull(git, `refs/remotes/origin/${branch}`)) !== null) return null;
    let remoteBranches: string[] = [];
    try {
      const out = await git.raw([
        'for-each-ref',
        '--format=%(refname:strip=3)',
        'refs/remotes/origin/',
      ]);
      // `origin/HEAD` is a pointer, not a branch — and dangles once its target is pruned.
      remoteBranches = out
        .split('\n')
        .map((l) => l.trim())
        .filter((name) => name !== '' && name !== 'HEAD');
    } catch {
      // Unreadable refs: claim nothing is missing rather than guess at what the remote holds.
    }
    const count = async (args: string[]): Promise<number> => {
      try {
        return Number((await git.raw(['rev-list', '--count', ...args])).trim()) || 0;
      } catch {
        return 0; // an unborn branch has no commits to count
      }
    };
    const local = `refs/heads/${branch}`;
    const total = await count([local]);
    const unpushed = await count([local, '--not', '--remotes=origin']);
    // Asked last, and only when the rest already says "missing": a branch that never tracked
    // `origin/<branch>` cannot have lost it. That takes BOTH keys naming it — the mere presence of
    // `branch.<b>.merge` is not enough: `branch.autoSetupMerge=always` makes `checkout -B` record
    // `remote=.` + `merge=refs/heads/master` for a never-pushed review branch, and
    // `--set-upstream-to=origin/<other>` names a branch that still exists. `config --get` exits 1
    // when the key is unset, which reads as not tracking.
    const configValue = async (key: string): Promise<string | null> => {
      try {
        return (await git.raw(['config', '--get', key])).trim();
      } catch {
        return null;
      }
    };
    const tracksUpstream = async (): Promise<boolean> =>
      (await configValue(`branch.${branch}.remote`)) === 'origin' &&
      (await configValue(`branch.${branch}.merge`)) === `refs/heads/${branch}`;
    return {
      branch,
      missing: remoteBranches.length > 0 && unpushed < total && (await tracksUpstream()),
      remoteBranches,
      unpushed,
    };
  }

  /**
   * Like {@link aheadBehindOf} but does not swallow a `rev-list` failure into a lenient
   * `{ahead: 0, behind: 0}` — it rethrows instead.
   *
   * `aheadBehindOf`'s blanket catch exists for callers that only decide whether to *start* a push
   * (a `0` there just means "nothing to do yet"). `pushWithRetry`'s mid-round re-read is different:
   * moments earlier `ahead` was known non-zero, so there a `0` reading is at least as likely to
   * mean "rev-list errored" (a stray `index.lock`, an unexpected ref state) as "the rebase legitimately
   * dropped our commit" — and mistaking the former for the latter means silently SKIPPING a push and
   * reporting `nothing-to-push`, telling the caller their work is upstream when it may not be. Use
   * this variant there so a genuine git failure propagates as an error instead. Leave every other
   * (pre-existing) call site on the lenient `aheadBehindOf`.
   */
  private async aheadBehindStrictOf(
    git: SimpleGit,
    knownBranch?: string,
  ): Promise<{ branch: string; ahead: number; behind: number }> {
    const branch = knownBranch ?? (await this.currentBranch(git));
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
  }

  /**
   * Ahead/behind counts vs the upstream for a clone directory, rethrowing a `rev-list` failure
   * rather than reporting zeros. Exposed alongside {@link aheadBehind} (the lenient equivalent)
   * purely so the strict/lenient behavior difference can be unit-tested without going through a
   * full push.
   */
  async aheadBehindStrict(dir: string): Promise<{ branch: string; ahead: number; behind: number }> {
    return this.aheadBehindStrictOf(simpleGit(dir));
  }

  /**
   * Run one fetch/pull/push against origin in `dir`, with this project's credential available
   * to git (see {@link runRemoteGit}).
   *
   * This used to point origin at the token-bearing URL (`remote set-url`) for the length of the
   * call and set it back afterwards, which wrote the token into `.git/config` and put it on the
   * `set-url` command line: a process killed inside that window left it on disk in plain text.
   * Nothing here writes a byte of config now.
   */
  private async withAuth(
    dir: string,
    gitUrl: string,
    auth: AuthConfig,
    args: string[],
  ): Promise<void> {
    await runRemoteGit(dir, gitUrl, auth, args);
  }

  /**
   * Fetch origin WITH `--prune`, so `refs/remotes/origin/*` says what the remote has now — every
   * fetch in this class goes through here. Without it (and `fetch.prune` is never set), a branch
   * deleted or renamed upstream left its tracking ref behind at the old sha, and every caller that
   * reads `origin/<branch>` as "the remote's current head" believed the ghost: `resolvePush`'s pin
   * matched it, the rebase landed on it, and `push origin <branch>` RECREATED the branch the
   * collaborator had just renamed away; `landBranch` would do the same to its base, and
   * `resetToRemote` hard-reset onto a branch that no longer exists. Pruning touches only
   * remote-tracking refs (never a local branch, tag, or the working tree). Two side effects follow.
   * `origin/HEAD` can be left dangling when its target is pruned; `resolveDefaultBranch` reads that
   * as "unknown" and falls back to `master`, which matches what the stale ref named only when the
   * default WAS `master` — a pruned `main` makes `landBranch`'s default base `master`, and a caller
   * on such a remote has to pass `base` explicitly. And `origin/<branch>` itself can vanish, so
   * nothing may read "the ahead/behind range did not resolve" as "in sync": `syncPull` and `status`
   * ask {@link remoteBranchAbsence} first and report a renamed-away branch as such.
   */
  private async fetchOrigin(dir: string, gitUrl: string, auth: AuthConfig): Promise<void> {
    await this.withAuth(dir, gitUrl, auth, ['fetch', '--prune', 'origin']);
  }

  /**
   * Everything the tool layer needs to decide whether reverting `commits` may proceed. Pure
   * inspection: this writes NOTHING — no index, no working-tree file, no `.git` state — so a
   * refusal costs the clone nothing and the caller can report every reason at once instead of
   * discovering the second one after the first has already been undone.
   *
   * `expectRef`, when given, is validated on exactly the same terms as each commit (leading `-`
   * refused, must resolve to a commit here). It has no field on {@link RevertPreflight} to be
   * reported in — validating it is its whole effect, so a caller naming a ref that does not exist
   * in this clone is told so here rather than by a raw git error later.
   *
   * Every refusal reason is collected, never acted on: the decision is the tool's.
   */
  async revertPreflight(
    dir: string,
    commits: string[],
    expectRef?: string,
  ): Promise<RevertPreflight> {
    const git = simpleGit(dir);
    const shas: string[] = [];
    for (const ref of commits) shas.push(await this.resolveCommitish(git, ref));
    if (expectRef !== undefined) await this.resolveCommitish(git, expectRef);

    const lineage = await this.commitLineage(git, shas);
    // `git revert` of a merge needs `-m <parent>` to say which side is "the change". We refuse
    // such a commit by name rather than growing a `mainline` parameter and guessing for the user.
    const mergeCommits = lineage.filter((c) => c.parents.length > 1).map((c) => c.sha);

    const touched = new Set<string>();
    for (const sha of shas) {
      // `show`, not `diff <sha>^ <sha>`: a root commit has no `^`, and `show` handles it.
      // `--no-renames` keeps a move as a delete plus an add, so both names are guarded (the
      // same reason `numstat`/`logCommits` carry it); `core.quotePath=false` keeps a non-ASCII
      // path as UTF-8 rather than `"r\303\251sum\303\251.tex"`, which no later call could match.
      const out = await git.raw([
        '-c',
        'core.quotePath=false',
        '--literal-pathspecs',
        'show',
        '--no-renames',
        '--name-only',
        '--format=',
        sha,
      ]);
      for (const line of out.split('\n')) {
        const rel = line.trim();
        if (rel) touched.add(toPosix(rel));
      }
    }
    const touchedPaths = [...touched].sort();

    const [{ dirty: dirtyPaths, inTheWay: inTheWayPaths }, linkPaths, stagedPaths] =
      await Promise.all([
        this.dirtyAmong(dir, git, touchedPaths),
        this.linksAmong(dir, git, lineage, touchedPaths),
        this.stagedAnywhere(git),
      ]);
    const only = lineage.length === 1 ? lineage[0] : undefined;
    const restoreRef = only && only.parents.length === 1 ? (only.parents[0] ?? null) : null;
    return {
      commits: shas,
      touchedPaths,
      dirtyPaths,
      inTheWayPaths,
      linkPaths,
      stagedPaths,
      mergeCommits,
      restoreRef,
    };
  }

  /**
   * Apply the revert of `commits` (full shas from {@link revertPreflight}, in that order) into the
   * WORKING TREE only — nothing is committed and nothing is left staged. `touchedPaths` is the
   * preflight's list; it scopes the unstaging and the diffstat, so a `git add` this session made
   * elsewhere survives untouched.
   *
   * Preconditions the tool guarantees: every preflight guard came back clean (no merge commit, no
   * dirty touched path, no link) and the whole call runs inside `runExclusive`.
   *
   * On a conflict nothing is left behind: the conflicted paths are collected, the revert is
   * aborted (which rolls back shas that had already applied cleanly and leaves an unrelated dirty
   * file alone — which is why a whole-tree `reset --hard` is forbidden here: it would destroy a
   * peer session's uncommitted work), and the caller gets the paths to act on.
   *
   * `expectRef` (already validated by {@link revertPreflight}) is measured here rather than by the
   * caller afterwards, and that placement is load-bearing — see the `--cached` comment below.
   */
  async revertApply(
    dir: string,
    commits: string[],
    touchedPaths: string[],
    expectRef?: string,
  ): Promise<RevertResult> {
    if (commits.length === 0) throw new BadCommitError('No commits to revert.');
    // These are the preflight's own shas, but `git revert` has no `--` to separate revisions from
    // options, so a leading `-` would be read as one. Fail closed rather than trust the caller.
    for (const sha of commits) {
      if (sha.startsWith('-')) throw new BadCommitError(`Invalid commit "${sha}".`);
    }
    const git = simpleGit(dir);
    // Resolved BEFORE the revert runs, so a ref this clone cannot answer for is a refusal that
    // costs nothing rather than an error over a revert that has already landed. The preflight
    // validated it too; doing it again here is the same fail-closed stance `commits` gets above.
    const expectSha =
      expectRef === undefined ? undefined : await this.resolveCommitish(git, expectRef);
    try {
      // `execCapture`, not `git.raw`: a conflict IS a non-zero exit, and simple-git turns that
      // into a rejection that loses the exit code the two branches below turn on. Same seam, and
      // the same reason, as `resetIndexToHead`'s direct shell-out.
      const res = await execCapture(
        'git',
        ['--literal-pathspecs', 'revert', '--no-commit', ...commits],
        { cwd: dir },
      );
      if (res.code !== 0) {
        // Collect the conflicted paths BEFORE aborting — the abort erases them.
        const conflictPaths = await this.unmergedPaths(git);
        if (conflictPaths.length === 0) {
          // Non-zero with nothing unmerged is not a conflict (a refused merge commit, a dirty
          // tree, a bad sha). Reporting it as `status: 'conflict'` with no paths would hand the
          // caller a conflict they cannot resolve; surface git's own words instead. The catch
          // below aborts any dangling revert before this propagates, exactly as `tryRebase` does.
          throw new Error(`git revert failed: ${res.stderr.trim() || res.stdout.trim()}`);
        }
        await git.raw(['revert', '--abort']);
        return {
          status: 'conflict',
          commits,
          files: [],
          filesChanged: 0,
          mismatchedFiles: null,
          conflictPaths,
        };
      }
      // `revert --no-commit` leaves `.git/REVERT_HEAD` behind EVEN ON SUCCESS (verified against
      // real git), so without this the clone sits mid-revert and a later `commit` would silently
      // pick up git's own revert message. Not obvious, and not optional.
      await git.raw(['revert', '--quit']);
      // MEASURE BEFORE UNSTAGING, and measure the INDEX (`--cached`), not the working tree.
      //
      // The unstage below scopes `git reset HEAD -- <paths>`, which drops from the index every
      // path HEAD does not have — and reverting a commit that DELETED a file restores exactly
      // such a path. Afterwards the restored file is untracked, and `git diff <ref> -- <path>`
      // ignores untracked files entirely: `git diff HEAD` reported nothing (so `files` came back
      // empty and the tool said "reverted — 0 file(s)" over a file it had just restored), and
      // `git diff <expectRef>` reported it as a DELETION (so `matchesRef` came back `false`, with
      // a bogus `mismatchedFiles` entry, for a revert that was exactly right).
      //
      // The index at this point is precisely the reverted tree — `revert -n` wrote the index and
      // the working tree together, and the tool's dirty-path preflight proved they agreed with
      // HEAD beforehand — so `--cached` answers both questions correctly for added, deleted and
      // modified paths alike.
      //
      // An empty `touchedPaths` means the reverted commits changed no file at all; an unscoped
      // diff would then report the whole dirty tree as this revert's doing.
      //
      // Both diffstats and the unstage below batch their pathspec list ({@link chunkPathspecs}),
      // so a commit touching thousands of paths does not hand git one oversized command line —
      // which is exactly the failure `landedOrExplain` exists to describe rather than prevent.
      const files =
        touchedPaths.length > 0
          ? await this.landedOrExplain(git, touchedPaths, () =>
              this.numstatBatched(git, ['--cached', 'HEAD'], touchedPaths),
            )
          : [];
      const mismatchedFiles =
        expectSha !== undefined && touchedPaths.length > 0
          ? await this.landedOrExplain(git, touchedPaths, () =>
              this.numstatBatched(git, ['--cached', expectSha], touchedPaths),
            )
          : null;
      // `revert -n` STAGES what it reverted. Unstage it so the change sits in the working tree
      // only — what this tool promises, and what every other write in this server looks like.
      // Scoped to `touchedPaths`, never a whole-index reset: a hand `git add` elsewhere survives.
      //
      // NEVER run that reset on a conflicted path: it silently clears the unmerged state and
      // leaves the `<<<<<<<` markers sitting in the file as an ordinary edit. The conflict branch
      // above therefore aborts and returns; it never reaches here.
      //
      // Batched like the diffstats: each chunk unstages its own paths and nothing else, so the
      // chunks compose into exactly the reset one call would have performed. A chunk that fails
      // leaves the earlier ones unstaged — `landedOrExplain` says so ("may still be staged").
      if (touchedPaths.length > 0) {
        await this.landedOrExplain(git, touchedPaths, async () => {
          for (const chunk of chunkPathspecs(touchedPaths)) {
            await git.raw(['--literal-pathspecs', 'reset', '-q', 'HEAD', '--', ...chunk]);
          }
        });
      }
      return {
        status: 'reverted',
        commits,
        files,
        filesChanged: files.length,
        mismatchedFiles,
        conflictPaths: [],
      };
    } catch (err) {
      // ABORT ON ANYTHING — a failed spawn, `unmergedPaths` throwing, the deliberate throw above.
      // Never leave the clone mid-revert, the rule `runRebaseStep`/`tryRebase` already follow.
      // (After `revert --quit` there is nothing left to abort and this is a no-op: the reverted
      // change is already in the tree, and undoing it would need the whole-tree reset that is
      // forbidden here.)
      await this.abortRevertIfInProgress(git);
      throw err;
    }
  }

  /**
   * Resolve one caller-named commit-ish to its full sha, refusing a leading `-` (git would read it
   * as an option). Same idiom, and the same two refusals, as {@link resolveDiffRef} — which
   * returns the caller's spelling because its error messages read better that way; a revert needs
   * the sha itself, since the tool reports which commits it applied.
   */
  private async resolveCommitish(git: SimpleGit, ref: string): Promise<string> {
    if (ref.startsWith('-')) throw new BadCommitError(`Invalid commit "${ref}".`);
    const sha = await this.revParseOrNull(git, `${ref}^{commit}`);
    if (sha === null) {
      throw new BadCommitError(
        `Unknown git commit "${ref}" — it does not resolve to a commit in this clone. ` +
          'Use a commit sha or "HEAD~N" from `status`/`diff` (run project_sync first if the ' +
          'commit is only on the remote).',
      );
    }
    return sha;
  }

  /**
   * Each sha with its parent shas, from `git rev-list --parents -n 1 <sha>`, whose single output
   * line is `<sha> <parent>...` — so more than two fields means a merge, and no parent at all
   * means a root commit (nothing to inspect a parent tree of).
   */
  private async commitLineage(
    git: SimpleGit,
    shas: string[],
  ): Promise<{ sha: string; parents: string[] }[]> {
    const lineage: { sha: string; parents: string[] }[] = [];
    for (const sha of shas) {
      const fields = (await git.raw(['rev-list', '--parents', '-n', '1', sha]))
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      lineage.push({ sha: fields[0] ?? sha, parents: fields.slice(1) });
    }
    return lineage;
  }

  /**
   * Which of `touchedPaths` have uncommitted working-tree, index or untracked state. An UNTRACKED
   * file at a path the revert would restore counts, and must: git itself refuses to clobber one.
   *
   * `-z` (as `trackedAtHead` uses it) so a path holding a newline comes back verbatim; porcelain
   * v1's `-z` form is `XY <path>\0`, with a rename/copy's ORIGINAL path following as its own
   * record. Both sides of such a pair are checked against `touchedPaths`, so a rename away from a
   * touched path counts as dirt on it, while a path outside the set never enters the result.
   *
   * The pathspec list is {@link chunkPathspecs}-batched. Combining is a UNION and nothing else:
   * a path git says nothing about in its chunk is clean there and everywhere, and both records
   * of a rename pair come out of whichever chunk matched either side, so the pairing never
   * straddles a chunk boundary. A chunk that throws propagates — never read as "clean".
   */
  private async dirtyAmong(
    dir: string,
    git: SimpleGit,
    touchedPaths: string[],
  ): Promise<{ dirty: string[]; inTheWay: string[] }> {
    if (touchedPaths.length === 0) return { dirty: [], inTheWay: [] };
    const wanted = new Set(touchedPaths);
    const dirty = new Set<string>();
    for (const chunk of chunkPathspecs(touchedPaths)) {
      const out = await git.raw([
        '-c',
        'core.quotePath=false',
        '--literal-pathspecs',
        'status',
        '--porcelain',
        '-z',
        '--',
        ...chunk,
      ]);
      const records = out.split('\0').filter(Boolean);
      for (let i = 0; i < records.length; i++) {
        const record = records[i] ?? '';
        const code = record.slice(0, 2);
        const named = [toPosix(record.slice(3))];
        if (code.includes('R') || code.includes('C')) {
          const original = records[++i];
          if (original !== undefined) named.push(toPosix(original));
        }
        for (const rel of named) if (wanted.has(rel)) dirty.add(rel);
      }
    }

    // What `status` cannot see: an IGNORED file in the way. `git revert` treats an ignored file
    // as expendable — where it restores a path HEAD does not track, an ignored file sitting at
    // that path (or at an ancestor, as a file where the revert needs a directory) is silently
    // overwritten, while `status --porcelain` never lists it. A user's local note kept out of
    // git via `.git/info/exclude` was replaced by the old committed bytes that way, behind a
    // preflight that read the path as clean. So every touched path HEAD does not track is
    // judged on disk instead, by `lstat` — ignored and untracked alike, and on a case-insensitive
    // filesystem in any spelling, which is exactly what the revert's write would land on:
    //   - the path itself exists and is not a directory: dirty;
    //   - the path is a directory: dirty if anything under it is untracked, ignored files
    //     included (`ls-files --others` without `--exclude-standard`) — git would have to remove
    //     the directory to write the file, and a directory holding only HEAD's own files (the
    //     revert deletes those too, and `status` above vouches for them) is not in the way;
    //   - an ancestor exists and is not a directory: dirty unless HEAD tracks that ancestor
    //     (then the revert itself replaces HEAD's file with the directory, and `status` vouches
    //     for the file's content);
    //   - anything `lstat` answers other than "absent" or the above fails CLOSED, as dirty.
    // "Tracked at HEAD" folds case on an ignorecase clone (the whole tree is listed and folded
    // through `canonicalNames`, as `trackedAtHead` does, since a pathspec cannot be literal and
    // case-insensitive at once), so a revert of a case-only rename is not refused over HEAD's own
    // file. Every listing here is {@link chunkPathspecs}-batched, literal and
    // `core.quotePath=false` like the probes above; a chunk that throws propagates (the preflight
    // then fails) rather than reading as "nothing in the way".
    const caseInsensitive = await this.isCaseInsensitive(dir);
    let headNames: ReturnType<typeof canonicalNames> | undefined;
    const trackedAtHeadOf = async (rels: string[]): Promise<Set<string>> => {
      if (caseInsensitive) {
        headNames ??= canonicalNames(
          (
            await git.raw([
              '-c',
              'core.quotePath=false',
              'ls-tree',
              '-r',
              '-z',
              '--name-only',
              'HEAD',
            ])
          )
            .split('\0')
            .filter(Boolean),
        );
        const names = headNames;
        return new Set(rels.filter((rel) => names.has(rel)));
      }
      const listed = new Set<string>();
      for (const chunk of chunkPathspecs(rels)) {
        const out = await git.raw([
          '-c',
          'core.quotePath=false',
          '--literal-pathspecs',
          'ls-tree',
          '-r',
          '-z',
          '--name-only',
          'HEAD',
          '--',
          ...chunk,
        ]);
        for (const name of out.split('\0')) if (name) listed.add(toPosix(name));
      }
      return new Set(rels.filter((rel) => listed.has(rel)));
    };
    // Everything `status` reported, frozen before the on-disk probe below adds to `dirty`: the
    // probe's additions are what `inTheWay` reports (see `RevertPreflight.inTheWayPaths`).
    const statusDirty = new Set(dirty);
    const atHead = await trackedAtHeadOf(touchedPaths);
    const blockedBy = new Map<string, string>();
    const occupiedDirs: string[] = [];
    for (const rel of touchedPaths) {
      if (dirty.has(rel) || atHead.has(rel)) continue;
      const segments = rel.split('/').filter(Boolean);
      for (let i = 1; i <= segments.length; i++) {
        let st: Awaited<ReturnType<typeof lstat>>;
        try {
          st = await lstat(path.join(dir, ...segments.slice(0, i)));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') dirty.add(rel);
          break;
        }
        if (i === segments.length) {
          if (st.isDirectory()) occupiedDirs.push(rel);
          else dirty.add(rel);
        } else if (!st.isDirectory()) {
          blockedBy.set(rel, segments.slice(0, i).join('/'));
          break;
        }
      }
    }
    if (blockedBy.size > 0) {
      const trackedAncestors = await trackedAtHeadOf([...new Set(blockedBy.values())]);
      for (const [rel, ancestor] of blockedBy) if (!trackedAncestors.has(ancestor)) dirty.add(rel);
    }
    for (const chunk of chunkPathspecs(occupiedDirs)) {
      const others = (
        await git.raw([
          '-c',
          'core.quotePath=false',
          '--literal-pathspecs',
          'ls-files',
          '--others',
          '-z',
          '--',
          ...chunk,
        ])
      )
        .split('\0')
        .filter(Boolean)
        .map((name) => toPosix(name));
      for (const rel of chunk) if (others.some((name) => coversPath(rel, name))) dirty.add(rel);
    }
    const all = [...dirty].sort();
    return { dirty: all, inTheWay: all.filter((rel) => !statusDirty.has(rel)) };
  }

  /**
   * Which of `touchedPaths` are a symlink anywhere the revert would touch them: mode `120000` in
   * HEAD's tree, in a reverted commit's tree or in its parent's (a root commit has no parent to
   * look at), an actual link on disk, or an ancestor directory that is a link
   * ({@link linkedAncestor}). Same reasoning as {@link hasLinkOnConflictSide}: a revert restores
   * file CONTENT, so writing it through a link writes outside the project — the tool refuses
   * rather than follows.
   *
   * `ls-tree -z` because the entry carries the path (`<mode> <type> <sha>\t<path>`) and a name
   * with a newline would otherwise split a record in two; `core.quotePath=false` alongside it for
   * the same rule every path-returning call here follows.
   *
   * Each ref's pathspec list is {@link chunkPathspecs}-batched, and the probe stays FAIL-CLOSED
   * across the batching: a chunk that throws propagates out of here (the preflight then refuses
   * the whole revert) rather than contributing an empty entry list that would read as "no links
   * in this chunk". Per ref the combination is a union — a path `ls-tree` does not list in its
   * chunk is simply absent from that tree — and every path still gets its own on-disk
   * `lstat`/{@link linkedAncestor} check below, which no batching touches.
   */
  private async linksAmong(
    dir: string,
    git: SimpleGit,
    lineage: { sha: string; parents: string[] }[],
    touchedPaths: string[],
  ): Promise<string[]> {
    if (touchedPaths.length === 0) return [];
    const refs = new Set<string>(['HEAD']);
    for (const { sha, parents } of lineage) {
      refs.add(sha);
      for (const parent of parents) refs.add(parent);
    }
    const links = new Set<string>();
    for (const ref of refs) {
      for (const chunk of chunkPathspecs(touchedPaths)) {
        const out = await git.raw([
          '-c',
          'core.quotePath=false',
          '--literal-pathspecs',
          'ls-tree',
          '-z',
          ref,
          '--',
          ...chunk,
        ]);
        for (const entry of out.split('\0')) {
          const tab = entry.indexOf('\t');
          if (tab < 0) continue;
          if (entry.slice(0, entry.indexOf(' ')) !== '120000') continue;
          links.add(toPosix(entry.slice(tab + 1)));
        }
      }
    }
    for (const rel of touchedPaths) {
      if (links.has(rel)) continue;
      try {
        if ((await lstat(path.join(dir, rel))).isSymbolicLink()) {
          links.add(rel);
          continue;
        }
      } catch {
        // Absent from the working tree — not a link there. The tree checks above still apply.
      }
      if ((await linkedAncestor(dir, rel)) !== null) links.add(rel);
    }
    return [...links].sort();
  }

  /**
   * Every path whose index entry differs from HEAD — staged content anywhere in the clone, NOT
   * scoped to the reverted paths. Deliberately unscoped: see {@link RevertPreflight.stagedPaths}.
   * A conflicting revert can only be undone with `git revert --abort`, which resets the whole
   * index, so staged work anywhere is at risk and the tool refuses while any exists.
   *
   * `-z` for a path holding a newline, `core.quotePath=false` like every path-returning call
   * here. No pathspec is passed, so there is nothing for `--literal-pathspecs` to protect.
   */
  private async stagedAnywhere(git: SimpleGit): Promise<string[]> {
    const out = await git.raw([
      '-c',
      'core.quotePath=false',
      'diff',
      '--cached',
      '--no-renames',
      '--name-only',
      '-z',
    ]);
    return out
      .split('\0')
      .filter(Boolean)
      .map((rel) => toPosix(rel))
      .sort();
  }

  /**
   * Run a step that happens AFTER `git revert --quit`, when the revert is already in the working
   * tree and can no longer be undone by an abort (undoing it would need the whole-tree
   * `reset --hard` that is forbidden here — it would destroy a peer session's uncommitted work).
   *
   * If such a step fails, the caller must not be told "the revert failed": it did not, and a
   * caller who retries will revert twice. So the failure is re-thrown with the truth attached.
   * The trigger this was written for — a path list long enough to blow Windows' ~32 KB command
   * line — is now batched away ({@link chunkPathspecs}), and a batched step can also fail PART
   * WAY through, which is why the message says the change "may still be staged" rather than
   * promising either state. Everything else that can fail mid-step (a spawn failure, a
   * filesystem error, one pathological path longer than a whole command line) still lands here.
   */
  private async landedOrExplain<T>(
    git: SimpleGit,
    touchedPaths: string[],
    step: () => Promise<T>,
  ): Promise<T> {
    try {
      return await step();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `The revert WAS applied to the working tree (${touchedPaths.length} path(s)), but ` +
          `finishing it failed: ${reason}. The change is on disk and may still be staged — ` +
          'review it with `status`/`diff` and either `commit` it or `discard` those paths. ' +
          'Do NOT simply retry, or the revert would be applied a second time.',
        { cause: err },
      );
    }
  }

  /** Abort a paused revert, tolerating "no revert in progress". Mirrors `abortRebaseIfInProgress`. */
  private async abortRevertIfInProgress(git: SimpleGit): Promise<void> {
    try {
      await git.raw(['revert', '--abort']);
    } catch {
      // No revert in progress — nothing to abort.
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

/**
 * How many characters of PATHSPEC arguments a single git invocation may carry.
 *
 * Derived from the smallest command-line limit of the three platforms this server runs on:
 * Windows caps a whole command line at 32,767 UTF-16 characters (`CreateProcessW`'s
 * `lpCommandLine`, terminating NUL included), against ~2 MB on Linux (`ARG_MAX`, in practice
 * a quarter of the stack rlimit) and 1 MB on macOS. So Windows is the one worth sizing for,
 * and 8,000 is deliberately a quarter of it — the rest of that 32,767 pays for everything the
 * count here cannot see:
 *
 * - the fixed part of the command line: the resolved path of `git.exe`, the global options
 *   (`-c core.quotePath=false`, `--literal-pathspecs`), the subcommand and its flags, up to
 *   two 40-character shas and the `--` separator — a few hundred characters;
 * - Windows argument QUOTING, applied after this accounting: an argument holding a space or a
 *   quote is wrapped in quotes and its backslashes doubled, so the rendered line can be close
 *   to twice the raw length counted here (8,000 → ~16,000, still half the limit away);
 * - on POSIX, the environment block, which shares the `ARG_MAX` budget with the arguments.
 *
 * Conservative on purpose: too low costs one extra git spawn per ~8 KB of paths, too high
 * costs the spawn failure this constant exists to prevent (#94). Pinned by a unit test, so
 * lowering it for a test cannot lower it in production.
 */
export const MAX_PATHSPEC_ARGV_CHARS = 8000;

/**
 * What one pathspec costs the command line beyond its own characters: the separating space,
 * plus the pair of quotes Windows adds around an argument that needs them.
 */
const PATHSPEC_ARG_OVERHEAD = 3;

/**
 * Split `paths` into consecutive chunks, each small enough to hand to one git invocation.
 *
 * Chunked by ACCUMULATED LENGTH, never by a fixed count: `sections/a.tex` and a 200-character
 * nested figure path cost the command line wildly different amounts, so a count is not a bound
 * on argv size at all. Order is preserved and every path appears in exactly one chunk, so a
 * caller that unions each chunk's output gets precisely what one call would have produced.
 *
 * A single path longer than the whole budget still gets a chunk of its own — dropping it would
 * silently narrow the pathspec (a path missing from a `status` scope reads as "not dirty"),
 * and splitting it is not a thing a pathspec permits. Such a call may still fail on Windows;
 * failing loudly on one impossible path beats answering wrongly about the rest.
 */
export function chunkPathspecs(
  paths: string[],
  budget: number = MAX_PATHSPEC_ARGV_CHARS,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const p of paths) {
    const cost = p.length + PATHSPEC_ARG_OVERHEAD;
    if (current.length > 0 && used + cost > budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(p);
    used += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Flags for every PARSED patch (`splitPatch` keys on line-initial `diff --git ` and `@@ -`, and
 * reads paths off `a/`/`b/` headers): git's own unified diff whatever the user configured — no
 * `diff.external` tool, no `color.ui=always` escapes, and the default prefixes over
 * `diff.noprefix`/`diff.mnemonicPrefix`. Textconv is left on: its output is still a unified diff.
 */
const PLAIN_PATCH_FLAGS = ['--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];

/** Environment variables the inline credential helper reads — see {@link gitCredentialConfig}. */
const CREDENTIAL_USERNAME_ENV = 'WEB_LATEX_MCP_GIT_USERNAME';
const CREDENTIAL_TOKEN_ENV = 'WEB_LATEX_MCP_GIT_TOKEN';

/**
 * A git credential helper (the `!`-prefixed shell form, which git runs through `sh` on every
 * platform, Git for Windows included) that answers `get` from the two variables above and
 * ignores `store`/`erase`. It holds only variable NAMES, so the command line carries no secret.
 */
const INLINE_CREDENTIAL_HELPER =
  `!f() { test "$1" = get || return 0; ` +
  `printf 'username=%s\\npassword=%s\\n' "$${CREDENTIAL_USERNAME_ENV}" "$${CREDENTIAL_TOKEN_ENV}"; }; f`;

/**
 * A remote host as it may appear inside a `-c credential.<scheme>://<host>.helper=…` KEY: a
 * hostname or IPv4 address, or a bracketed IPv6 literal, each with an optional port. WHATWG URL
 * keeps `=`, `;`, `$` and `"` in a host, and an `=` in a `-c` argument ends the key — so a host
 * outside this shape is refused rather than handed to git to reinterpret. `_` is allowed: it is
 * not a DNS hostname character, but WHATWG keeps it and resolvers accept it — a docker-compose
 * service name (`https://git_server/…`) is the everyday case — and it means nothing inside a
 * `-c` key.
 */
const CREDENTIAL_HOST_RE = /^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::\d+)?$/;

/**
 * The GLOBAL `-c` options and the extra environment that let one git process authenticate to
 * `gitUrl` with `auth`, WITHOUT the credential touching `.git/config` or any command line;
 * `null` when there is nothing to inject (no token, or not an http(s) remote). Consumed by
 * {@link runRemoteGit}; exported as the unit seam for the host check and the config keys.
 *
 * - The token travels in the child's ENVIRONMENT only (`WEB_LATEX_MCP_GIT_TOKEN`), which other
 *   users cannot read, unlike the process list the old `remote set-url https://user:TOKEN@…`
 *   argv appeared in.
 * - Git reads it through {@link INLINE_CREDENTIAL_HELPER}, configured with GLOBAL `-c` options
 *   (before the subcommand): process-scoped, never persisted — not even by `clone`.
 * - Both options are scoped to the remote's own scheme+host (`credential.<scheme>://<host>.helper`).
 *   The first is EMPTY, which git reads as "reset the helper list" — for URLs that key matches
 *   only — so for this host the project's resolved token is the one git uses (as it was when it
 *   sat in the URL), and nothing stores it into the user's keychain on success; the second adds
 *   the inline helper. Another host (a private submodule, an LFS store, a redirect) matches
 *   neither key: it keeps the user's own helpers and is never handed the token.
 */
export function gitCredentialConfig(
  gitUrl: string,
  auth: AuthConfig,
): { config: string[]; env: Record<string, string> } | null {
  if (!auth.token) return null;
  let url: URL;
  try {
    url = new URL(gitUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // The credential protocol is line-based: a line break would let the value inject a key of its
  // own. Git refuses such values itself; refuse before handing them over, naming neither.
  if (/[\r\n\0]/.test(auth.token) || /[\r\n\0]/.test(auth.username)) {
    throw new Error(
      'The resolved git credential (username or token) contains a line break, which the git ' +
        'credential protocol cannot carry. Fix the stored credential and retry.',
    );
  }
  if (!CREDENTIAL_HOST_RE.test(url.host)) {
    // The host is the caller's own configuration, not a secret — but JSON-quote it so a control
    // character or quote in it cannot shape the message.
    throw new Error(
      `The git remote's host ${JSON.stringify(url.host)} contains characters a hostname cannot ` +
        '(only letters, digits, ".", "-", "_", an optional ":port", or a bracketed IPv6 address), so ' +
        'no credential can be scoped to it. Nothing was sent. Fix the project’s gitUrl.',
    );
  }
  const key = `credential.${url.protocol}//${url.host}.helper`;
  return {
    config: [`${key}=`, `${key}=${INLINE_CREDENTIAL_HELPER}`],
    env: { [CREDENTIAL_USERNAME_ENV]: auth.username, [CREDENTIAL_TOKEN_ENV]: auth.token },
  };
}

/**
 * Run one git command that talks to `gitUrl`'s remote (clone, fetch, pull, push) with the
 * project's credential injected by {@link gitCredentialConfig}, and throw on a non-zero exit.
 *
 * Spawned directly (`execCapture`), not through simple-git: simple-git vets an explicitly-set
 * child environment against a list of "unsafe" variables and config keys, and refuses the whole
 * operation for any category not opted into — so injecting a token that way meant opting out of
 * each category by hand, and a user environment carrying a config entry outside the list (or a
 * simple-git minor adding a category) failed every authenticated operation before git ran. The
 * environment here is this process's own — what simple-git passes when it is given none, and
 * where `src/index.ts` puts `GIT_TERMINAL_PROMPT=0` — plus the two credential variables.
 *
 * The thrown message is stdout followed by stderr, the same text simple-git's `GitError` carried,
 * because callers parse it: {@link isNonFastForwardRejection}, {@link untrackedOverwriteFromError}.
 * No token is in it (it never reaches git's argv or config), and tool handlers scrub every
 * resolved secret out of error text regardless (`errorResult`).
 */
async function runRemoteGit(
  cwd: string | undefined,
  gitUrl: string,
  auth: AuthConfig,
  args: string[],
): Promise<void> {
  const injected = gitCredentialConfig(gitUrl, auth);
  const res = await execCapture(
    'git',
    [...(injected?.config.flatMap((c) => ['-c', c]) ?? []), ...args],
    {
      ...(cwd !== undefined ? { cwd } : {}),
      ...(injected ? { env: { ...process.env, ...injected.env } } : {}),
    },
  );
  if (res.code !== 0) {
    const output = res.stdout + res.stderr;
    throw new Error(
      output.trim() ? output : `git ${args[0]} failed with exit code ${String(res.code)}.`,
    );
  }
}

/** Join at most `max` entries, appending `… N more` for whatever didn't fit. */
function capList(items: string[], max: number): string {
  if (items.length <= max) return items.join(', ');
  const shown = items.slice(0, max);
  return `${shown.join(', ')}, … ${items.length - max} more`;
}

/**
 * `paths` truncated to at most `REFUSAL_PATH_CAP` entries — the cap a refusal message's literal
 * `paths: [...]` argument shares with its prose list, so a path beyond it never leaks out
 * through either channel.
 */
function capPaths(paths: string[]): string[] {
  return paths.length > REFUSAL_PATH_CAP ? paths.slice(0, REFUSAL_PATH_CAP) : paths;
}

/**
 * Trailing note appended to a refusal message when `paths` exceeds the cap: the prescribed
 * `paths` argument names only the first `capped.length` of `paths.length`, so following it
 * clears that many and the rest will refuse again — never promise the sync/push a plain success
 * the argument can't deliver. Shared by every capped refusal message (`LocalChangesOverwriteError`
 * and both `UntrackedOverwriteError` wordings) so the sentence can't drift between them.
 * `progresses` names, in the caller's own words, what "clearing them" gets past (e.g. "the sync
 * get further"). Empty string when nothing was cut.
 */
function capNote(paths: string[], capped: string[], progresses: string): string {
  if (paths.length <= capped.length) return '';
  return (
    ` That \`paths\` list is the first ${capped.length} of ${paths.length}: clearing them lets ` +
    `${progresses}, but the rest will refuse it again — \`status\` lists them all.`
  );
}

/**
 * Trailing sentence for {@link LocalChangesOverwriteError} calling out which of `capped` (the
 * message's own capped `paths`) is untracked rather than modified — `discard`ing an untracked
 * path deletes the file instead of reverting it, worth flagging separately from the tracked
 * majority. Filtered to `capped` (not the raw `untrackedPaths`) so the sentence never names a path
 * that isn't actually in the `paths: [...]` argument above it. Empty string when nothing to add.
 */
function untrackedCollisionNote(untrackedPaths: string[], capped: string[]): string {
  const shown = untrackedPaths.filter((p) => capped.includes(p));
  if (shown.length === 0) return '';
  const plural = shown.length > 1;
  const list = capList(shown, REFUSAL_PATH_CAP);
  return (
    ` Of these, ${list} exist${plural ? '' : 's'} untracked rather than modified: the same ` +
    '`commit`/`discard` calls clear them too (that is why they are in `paths` above), and a ' +
    '`discard` of an untracked path removes the file.'
  );
}

/**
 * Shared message for both `safePush` and `resolvePush` refusing a dirty tree: names the tracked
 * modifications blocking the rebase, and separately reassures that any untracked files present
 * are not why — they ride through a push untouched. Each list is capped (20 modified, 10
 * untracked) so a working tree with hundreds of dirty files doesn't blow up the error text.
 *
 * Four exits are offered, in order: `commit` and a `message` to push both PUBLISH the blocking
 * file, `discard` DESTROYS it, and `shelve` (between them) does neither — it sets the content
 * aside outside the clone and `unshelve` brings it back. That middle route exists because the
 * ordinary case ("push section A while section B is mid-sentence") otherwise has no safe way out,
 * so the refusal the caller actually reads has to name it. Keep the order: `shelve` after the two
 * publishing routes and before the destructive one.
 *
 * Exported solely as a test seam — the same one `untrackedOverwriteFromError` and
 * `localChangesOverwriteFromError` already expose — so the wording can be asserted without
 * standing up a remote and driving a real push. Both call sites are unchanged.
 */
export function uncommittedModificationsMessage(modified: string[], untracked: string[]): string {
  const untrackedNote =
    untracked.length > 0
      ? `Untracked file(s) never block a push — ${capList(untracked, 10)} will ride along untouched.`
      : 'Untracked files never block a push.';
  return (
    `Uncommitted changes to tracked file(s): ${capList(modified, 20)}. A push has to rebase onto ` +
    'the latest remote, and git cannot rebase over uncommitted modifications to files it already ' +
    "tracks. Commit them first (`commit` takes this session's edits by default, or " +
    '`scope: "all"` for the whole working tree), pass a `message` to push to commit the WHOLE ' +
    "working tree instead (peers' work included, so prefer commit first), `shelve` them " +
    '(`shelve { paths: [...] }`) to set them aside outside the clone — the only exit here that ' +
    'neither publishes them nor destroys them — and bring them back with `unshelve` after the ' +
    'push, or `discard` them. ' +
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

/**
 * Pull the indented file list following EVERY line matching `startRe` out of git's "would be
 * overwritten" error text, concatenated in order and deduplicated. Shared by both the
 * untracked-file and the tracked-modification refusals, which differ only in their opening
 * line's wording — the indented-path-list shape underneath is identical. Real git (2.46) emits
 * a SEPARATE block per group of files when a tree has both index-only staged changes and
 * worktree modifications the incoming commit touches, not one block listing everything —
 * collecting only the first block silently dropped every path named in the rest. Each block
 * stops at its first non-tab-indented line, or an (already-trimmed) blank line, whichever comes
 * first; scanning then resumes looking for the next `startRe` match.
 */
function parseIndentedPathList(message: string, startRe: RegExp): string[] {
  const lines = message.split('\n');
  const seen = new Set<string>();
  const paths: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!startRe.test(lines[i] ?? '')) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? '';
      if (!line.startsWith('\t')) break;
      const trimmed = line.replace(/^\t/, '').trim();
      if (!trimmed) break;
      const posix = toPosix(trimmed);
      if (!seen.has(posix)) {
        seen.add(posix);
        paths.push(posix);
      }
    }
  }
  return paths;
}

/** Pull the indented file list out of git's "would be overwritten" error text. */
function parseUntrackedOverwritePaths(message: string): string[] {
  return parseIndentedPathList(message, UNTRACKED_OVERWRITE_RE);
}

/**
 * Recognise git's "would be overwritten" refusal in a caught error and turn it into our type.
 * `operation` picks the wording (`'push'` by default, matching every pre-existing call site);
 * exported for direct unit testing of the regex/parsing, the same seam
 * `localChangesOverwriteFromError` already exposes.
 */
export function untrackedOverwriteFromError(
  err: unknown,
  operation: 'push' | 'pull' = 'push',
): UntrackedOverwriteError | null {
  const message = err instanceof Error ? err.message : String(err);
  if (!UNTRACKED_OVERWRITE_RE.test(message)) return null;
  return new UntrackedOverwriteError(parseUntrackedOverwritePaths(message), operation);
}

/**
 * Matches git's refusal to fast-forward (or check out) over a *tracked* file with uncommitted
 * local modifications — the sibling wording to {@link UNTRACKED_OVERWRITE_RE}, but for a file the
 * clone already tracks. Git uses "merge" wording for `merge --ff-only` (what `syncPull` runs) and
 * "checkout" wording for a plain checkout of the same commit; both are the same underlying
 * refusal, so both are matched. Deliberately does not match {@link UNTRACKED_OVERWRITE_RE}'s
 * "untracked working tree files" wording — the two must never cross-fire, since they lead to
 * different fixes (commit/discard here; commit under `scope: "paths"` or delete/move there).
 */
const LOCAL_CHANGES_OVERWRITE_RE =
  /local changes to the following files would be overwritten by (?:merge|checkout)/i;

/**
 * Recognise git's "local changes ... would be overwritten" refusal and turn it into our type.
 * `syncPull` goes through {@link pullRefusalFromError} (which also handles the case where git
 * prints both refusal blocks); this is that function's tracked-only half, kept exported as the unit
 * seam for the regex/parsing (the same string-matching fragility the sibling
 * `UntrackedOverwriteError` machinery has — matched against git's raw stderr, not a stable API).
 */
export function localChangesOverwriteFromError(err: unknown): LocalChangesOverwriteError | null {
  const message = err instanceof Error ? err.message : String(err);
  if (!LOCAL_CHANGES_OVERWRITE_RE.test(message)) return null;
  return new LocalChangesOverwriteError(parseIndentedPathList(message, LOCAL_CHANGES_OVERWRITE_RE));
}

/**
 * Recognise a `merge --ff-only` refusal (as thrown by `syncPull`) and turn it into the error to
 * throw. Factored out of `syncPull`'s catch so the both-blocks-at-once case is unit-testable
 * without a live git process. git's `unpack_trees` can refuse over a tracked-modification
 * collision, an untracked-file collision, or — accumulating rejects per error type — BOTH in the
 * same call; see {@link LocalChangesOverwriteError}'s doc comment for why that case collapses into
 * one error carrying the union rather than reporting only whichever block is checked first. The
 * single-type cases are unchanged: untracked-only still yields the pull-worded
 * {@link UntrackedOverwriteError}, tracked-only still yields a plain {@link LocalChangesOverwriteError}.
 * An error matching neither is rethrown untouched.
 */
export function pullRefusalFromError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const trackedMatches = LOCAL_CHANGES_OVERWRITE_RE.test(message);
  const untrackedMatches = UNTRACKED_OVERWRITE_RE.test(message);
  if (trackedMatches && untrackedMatches) {
    const tracked = parseIndentedPathList(message, LOCAL_CHANGES_OVERWRITE_RE);
    const untracked = parseIndentedPathList(message, UNTRACKED_OVERWRITE_RE);
    const seen = new Set(tracked);
    const union = [...tracked, ...untracked.filter((p) => !seen.has(p))];
    return new LocalChangesOverwriteError(union, { untracked });
  }
  if (untrackedMatches) {
    return new UntrackedOverwriteError(parseUntrackedOverwritePaths(message), 'pull');
  }
  if (trackedMatches) {
    return new LocalChangesOverwriteError(
      parseIndentedPathList(message, LOCAL_CHANGES_OVERWRITE_RE),
    );
  }
  return err instanceof Error ? err : new Error(message);
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
    // Every in-repo caller passes `--no-renames` (see `numstat`/`logCommits`), so this is a plain
    // path; a rename expression ("{a => b}/x") from any other input is kept verbatim, not split.
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

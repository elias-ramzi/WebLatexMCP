import { clipText } from './commentsBudget.js';
import { quoteId } from './projectId.js';

/**
 * How the local clone stands relative to its tracked remote branch, derived from ahead/behind
 * counts. `behind > 0` means the remote moved since the last sync, so a `push` may conflict; a
 * `diverged` clone (ahead *and* behind) should be synced before pushing. Counts reflect the last
 * fetch — `status` does not hit the network; run `project_sync` to refresh them.
 */
export type SyncState = 'in-sync' | 'ahead' | 'behind' | 'diverged' | 'remote-branch-missing';

/**
 * `remoteBranchMissing` wins over the counts: with `origin/<branch>` pruned there is nothing to be
 * behind, and `ahead` then counts local commits on no remote branch at all, so "in-sync" or a plain
 * "ahead" would describe a comparison that could not be made.
 */
export function syncState(ahead: number, behind: number, remoteBranchMissing = false): SyncState {
  if (remoteBranchMissing) return 'remote-branch-missing';
  if (ahead > 0 && behind > 0) return 'diverged';
  if (ahead > 0) return 'ahead';
  if (behind > 0) return 'behind';
  return 'in-sync';
}

/**
 * A glanceable one-line summary of the clone's sync state for `status`, leading with divergence and
 * its consequence (a possible push conflict) so an unpushed local commit or a moved remote is
 * obvious up front rather than buried under the file lists.
 */
export function syncSummary(
  branch: string,
  ahead: number,
  behind: number,
  remoteBranchMissing = false,
): string {
  switch (syncState(ahead, behind, remoteBranchMissing)) {
    case 'remote-branch-missing':
      return `⚠ origin/${branch} no longer exists on the remote (as of the last fetch)${
        ahead > 0 ? ` — ${ahead} local commit(s) are on no remote branch` : ''
      }`;
    case 'diverged':
      return `⚠ diverged: ${ahead} ahead / ${behind} behind — sync (project_sync) before pushing; a push may conflict`;
    case 'behind':
      return `behind ${behind} — origin/${branch} moved; sync (project_sync) before pushing`;
    case 'ahead':
      return `ahead ${ahead} — ${ahead} unpushed commit(s); push to publish`;
    default:
      return `in sync with origin/${branch}`;
  }
}

/** How many of the remote's other branches {@link remoteBranchMissingNote} names before counting. */
const NOTE_BRANCHES_SHOWN = 5;

/**
 * Longest remote branch name the note shows before an ellipsis. The names come from the remote,
 * so without this five of them bound the note's line count and nothing else.
 */
const NOTE_BRANCH_NAME_CAP = 100;

/**
 * What to tell a caller whose tracked branch is gone from the remote: after a `fetch --prune`,
 * `origin/<branch>` no longer resolves, while the remote still has other branches and this clone's
 * history is shared with them — so the branch came from there and a collaborator renamed or
 * deleted it. Only called for that case (`GitService.remoteBranchAbsence` decides it); a remote with
 * no branches at all, or one this clone shares no history with, is not "missing" anything this can
 * name.
 *
 * `unpushed` is the count of local commits reachable from no remote branch — the work that exists
 * only in this clone — so the note never says "nothing to push" about it.
 */
export function remoteBranchMissingNote(
  branch: string,
  remoteBranches: readonly string[],
  unpushed: number,
): string {
  // Clipped, then quoted the way every other remote- or caller-supplied name in a message is
  // (`quoteId`: `"` escaped, invisible and bidi characters written out), so a branch name can
  // neither blow the note up nor forge what the reader sees.
  const shown = remoteBranches
    .slice(0, NOTE_BRANCHES_SHOWN)
    .map((b) => quoteId(clipText(b, NOTE_BRANCH_NAME_CAP).text));
  const more = remoteBranches.length - shown.length;
  const listed = `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
  return (
    `The remote no longer has branch "${branch}" as of the last fetch (origin/${branch} was ` +
    `pruned): it was renamed or deleted upstream. The remote's branches now: ${listed}. There is ` +
    `nothing to compare this clone against, so it is not in sync with anything. ` +
    (unpushed > 0 ? `${unpushed} local commit(s) are on no remote branch (pushed nowhere). ` : '') +
    `push cannot publish "${branch}" (its pull-rebase finds no such branch upstream) until the ` +
    `branch exists on the remote again or the clone is moved onto another one — ask whoever ` +
    `renamed it.`
  );
}

/**
 * How the local clone stands relative to its tracked remote branch, derived from ahead/behind
 * counts. `behind > 0` means the remote moved since the last sync, so a `push` may conflict; a
 * `diverged` clone (ahead *and* behind) should be synced before pushing. Counts reflect the last
 * fetch — `status` does not hit the network; run `project_sync` to refresh them.
 */
export type SyncState = 'in-sync' | 'ahead' | 'behind' | 'diverged';

export function syncState(ahead: number, behind: number): SyncState {
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
export function syncSummary(branch: string, ahead: number, behind: number): string {
  switch (syncState(ahead, behind)) {
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

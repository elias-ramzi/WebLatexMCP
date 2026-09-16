/**
 * Collapses dead, change-free peer sessions in `status`'s `activeSessions` — report-level only.
 *
 * A session record is only deleted on a clean shutdown (`SessionRegistry.release()`); a killed
 * agent process leaves its record behind forever, so `activeSessions` grows without bound with
 * sessions that hold nothing and are never coming back. Nothing here reaps anything from disk —
 * `SessionRegistry.collectGarbage()` exists for that and is not called from here, deliberately:
 * `status` takes no lock, and deleting a peer's record while it races its own `record()` would
 * destroy the ownership proof `commit scope: "paths"` and `push` depend on.
 */
export interface PeerSummaryInput {
  live: boolean;
  /** The peer's shadow index entries, or `null` when the index could not be read. */
  entries: unknown[] | null;
}

/**
 * True only for a peer that is dead AND demonstrably holds nothing: `!live`, and its shadow index
 * read back as an empty (but readable) array.
 *
 * Every other case is shown, deliberately:
 * - a **live** peer, whatever it holds — it may write again any moment;
 * - a **dead peer with entries** — its last-known changes still matter, which is why `status`
 *   reports a dead peer at all;
 * - **a dead peer whose `entries` is `null`.** This is the one that is easy to get backwards.
 *   `null` from `ShadowStore.peerEntries` means the index was *unreadable*, never "owns nothing"
 *   (see that method's own doc comment and `src/lib/peerAttribution.ts`'s `attributePeers`, which
 *   treats it as owning everything, fail closed). Collapsing an unreadable index into a "no
 *   changes" count would assert the one thing this codebase refuses to infer — so it stays listed
 *   individually, with `changes: null`, exactly as before.
 */
export function isStalePeer(p: PeerSummaryInput): boolean {
  return !p.live && p.entries !== null && p.entries.length === 0;
}

/**
 * Splits `peers` into the ones `status` still lists individually (`shown`, order preserved) and a
 * count of the rest (`stale`) — dead sessions holding nothing, left out of `activeSessions` and
 * reported only as a number.
 */
export function splitStalePeers<T>(
  peers: T[],
  read: (p: T) => PeerSummaryInput,
): { shown: T[]; stale: number } {
  const shown: T[] = [];
  let stale = 0;
  for (const p of peers) {
    if (isStalePeer(read(p))) {
      stale++;
    } else {
      shown.push(p);
    }
  }
  return { shown, stale };
}

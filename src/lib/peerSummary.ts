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

/**
 * How recently a dead peer must have heartbeated for `status` to keep listing it individually even
 * when its shadow index reads back as a readable-empty array.
 *
 * **Why it exists.** `ShadowStore.peerEntries` maps ENOENT — no index file at all — and a
 * successfully-read empty index to the same `[]`, deliberately (distinguishing them is not this
 * layer's job and is not being changed). So "the index records nothing" is *not* the same claim as
 * "the session changed nothing": a session that wrote files through this server but whose own
 * shadow-index write then failed, and which died before ever retrying, leaves dirty lines in the
 * working tree with no entry naming it. Collapsing that peer into a bare count asserts it "holds
 * no changes" — and removes the only named suspect for those lines, exactly when a human is
 * staring at `otherChanges` wondering who wrote them. While the death is recent, the peer stays
 * named.
 *
 * **Why it must exceed `SessionRegistry.STALE_MS`.** In `SessionRegistry.peers()`, `live` is true
 * when the record is this session, or its pid clause grants, or
 * `Number.isFinite(age) && age < STALE_MS`. `isStalePeer` only ever weighs a heartbeat for a peer
 * that is already `!live`, so `!live` ALREADY implies a heartbeat at least `STALE_MS` old (or
 * unparseable). Any grace window at or below `STALE_MS` is therefore **vacuous** — it could never
 * keep a single peer listed, and would sit here reading like a working guard. That ordering is not
 * left to this comment: `STALE_MS` is exported, and `test/unit/peerSummary.test.ts` asserts this
 * constant exceeds it, so raising either one past the other fails a test rather than quietly
 * emptying the exemption. Do not size this against `HEARTBEAT_THROTTLE_MS` (30 seconds): that only
 * paces how often a *live* session rewrites its heartbeat, and bounds nothing about how long a
 * dead one has been quiet.
 *
 * **Why two hours, and what the window is actually for.** Not "long enough that a failed index
 * write is no longer plausible" — that reading is wrong and worth refuting here, because it is the
 * one a reader re-deriving this number will reach for. The write either failed or it did not, at
 * write time; its likelihood does not decay as the record ages, so no amount of elapsed time is
 * *evidence* about it. What the window buys is that a human still looking at those dirty lines, in
 * the same working period as the death, gets a name for them. It is a usefulness window, not an
 * evidence window — which is why it is sized by how long someone stays with a problem rather than
 * by any property of the failure. Two hours sits well clear of `STALE_MS`, so the guard is
 * comfortably non-vacuous rather than sitting one clock skew away from firing never, and it is the
 * boundary
 * `docs/tools.md` already uses when it explains `push`'s peer refusal — "a 30-second-old write
 * means wait; a two-hour-old one is a judgement call". The same instinct applies here, so the same
 * number does. Being *bounded* is the point: #75's unbounded growth of `activeSessions` over the
 * life of a workspace stays fixed, because only the last two hours' worth of dead, empty sessions
 * stay listed; every older one still collapses into the count.
 *
 * The residual, stated rather than sized away: the unattributed lines stay in the working tree
 * indefinitely, while the suspect's name expires after two hours — so an agent killed overnight
 * and found the next morning is already collapsed. Matching the harm exactly would take a
 * *state*-based condition (do not collapse while the tree holds dirty paths no live session owns),
 * which is a larger change than this one and deliberately not made here.
 */
export const RECENT_HEARTBEAT_GRACE_MS = 2 * 60 * 60 * 1000;

export interface PeerSummaryInput {
  live: boolean;
  /** The peer's shadow index entries, or `null` when the index could not be read. */
  entries: unknown[] | null;
  /**
   * `Date.now() - Date.parse(record.heartbeatAt)` — how long ago, in milliseconds, this peer last
   * wrote its session record, as measured by the caller (`status` samples `Date.now()` once and
   * uses it for every peer, so the peers of one report are judged against one instant).
   *
   * Non-finite when `heartbeatAt` does not parse, and that case is *not* collapsed — see
   * `isStalePeer`. Only meaningful for a peer that is already `!live`; for a live one it is
   * ignored, since a live session rewrites this at most every `HEARTBEAT_THROTTLE_MS` and an old
   * value proves nothing about it.
   */
  heartbeatAgeMs: number;
}

/**
 * True only for a peer that is dead, demonstrably holds nothing, and has been quiet long enough
 * that "holds nothing" can be believed: `!live`, its shadow index read back as an empty (but
 * readable) array, and a finite heartbeat age of at least `graceMs`.
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
 * - **a dead peer that went quiet only recently.** An empty index cannot tell "recorded nothing"
 *   apart from "the index write itself failed" (both are `[]`), so within `RECENT_HEARTBEAT_GRACE_MS`
 *   of its last heartbeat the peer keeps its name in `activeSessions` rather than being asserted
 *   change-free — it may be the author of dirty lines nothing else accounts for. See that
 *   constant for why the window must exceed `SessionRegistry`'s `STALE_MS` to do anything at all.
 *
 * A **non-finite** `heartbeatAgeMs` (an unparseable `heartbeatAt`) is never collapsed: the
 * `Number.isFinite` clause rejects it before the ordering clause can, so `+Infinity` — which is
 * arithmetically older than any window — stays listed too. This is the *opposite* convention from
 * `bootIdentity.ts`, where a non-finite age "earns nothing"; the sign flips because the grant does.
 * There, granting means calling a peer **live**, so refusing on unusable evidence is the safe
 * direction. Here, collapsing means asserting a peer **holds no changes** and dropping it from the
 * report, so refusing to collapse is the safe direction. Same fail-closed bias as the `null` rule,
 * pointing the other way.
 *
 * It stays **one conjunction** rather than a chain of early returns, on purpose: every clause only
 * narrows, so appending the age clause can only make FEWER peers collapse, never more. That is
 * what makes this change structurally incapable of weakening the `entries !== null` guard — which
 * stays exactly as it was, and stays ahead of the new clause.
 */
export function isStalePeer(
  p: PeerSummaryInput,
  graceMs: number = RECENT_HEARTBEAT_GRACE_MS,
): boolean {
  return (
    !p.live &&
    p.entries !== null &&
    p.entries.length === 0 &&
    Number.isFinite(p.heartbeatAgeMs) &&
    p.heartbeatAgeMs >= graceMs
  );
}

/**
 * Splits `peers` into the ones `status` still lists individually (`shown`, order preserved) and a
 * count of the rest (`stale`) — dead sessions holding nothing and quiet for longer than `graceMs`,
 * left out of `activeSessions` and reported only as a number.
 */
export function splitStalePeers<T>(
  peers: T[],
  read: (p: T) => PeerSummaryInput,
  graceMs: number = RECENT_HEARTBEAT_GRACE_MS,
): { shown: T[]; stale: number } {
  const shown: T[] = [];
  let stale = 0;
  for (const p of peers) {
    if (isStalePeer(read(p), graceMs)) {
      stale++;
    } else {
      shown.push(p);
    }
  }
  return { shown, stale };
}

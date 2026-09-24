/**
 * Which scope a `commit` call runs under when the caller passed none. Pure: the tool gathers the
 * facts (does this session track anything, which peers are live) and this decides.
 *
 * The default is "session" whenever this session tracks a change. When it tracks nothing, the old
 * rule fell back to "all" (`git add -A`) unconditionally — and that fallback is only harmless when
 * nobody else is working in the clone. With a live peer it swept the peer's in-flight lines into
 * this session's commit with nobody having asked for scope "all", which the tool's own description
 * calls a deliberate act. Two routes reached it:
 *
 *  - a session that has tracked nothing yet (fresh, or everything it wrote already landed) calling
 *    `commit` while a peer is mid-edit; and
 *  - the ignored-only refusal: `commitSession` settles an entry git ignores *before* refusing (so
 *    the entry never wedges the default scope), which left the session tracking nothing — and the
 *    identical retry widened to "all". A refusal must not change which scope the next identical
 *    call gets; under this rule, with a peer present, it no longer can.
 *
 * So with any live peer the fallback refuses instead, naming the peers and both explicit routes.
 * "Any live peer" rather than "a live peer that owns something", deliberately: a peer's index can be
 * unreadable (never read as "owns nothing" — the rule `peerOwnership` applies), and one whose index
 * write failed owns lines it never recorded, so an empty index is not evidence the tree holds
 * nothing of theirs. The strict reading needs no index at all and so cannot fail open.
 *
 * Alone on the clone (no live peer) the fallback to "all" stays: there is no one else's work to
 * take, and it is the documented single-session behaviour (`ignoredCommit.test.ts` pins it).
 */

export type DefaultScopeDecision = { scope: 'session' | 'all' } | { refusal: string };

/** The scope for a call that passed none. A caller's own `scope` always wins and never gets here. */
export function resolveCommitScope(input: {
  /**
   * Whether this session's shadow tracked any change (`ShadowStore.hasChanges`) when the call
   * BEGAN — read before `commit`'s opening `refresh`, never after it. That refresh can settle an
   * entry (an edit reverted to its original text, or content a HEAD move absorbed); read afterwards,
   * a session that arrived with a change could find itself tracking nothing and, alone on the
   * clone, get "all" — the same "something this call did changed its scope" hole as the
   * ignored-only refusal above.
   */
  tracksChanges: boolean;
  /** Ids of the live peer sessions on this project (`SessionRegistry.livePeers`), self excluded. */
  livePeerIds: readonly string[];
}): DefaultScopeDecision {
  if (input.tracksChanges) return { scope: 'session' };
  if (input.livePeerIds.length === 0) return { scope: 'all' };
  const named = input.livePeerIds.map((p) => `"${p}"`).join(', ');
  return {
    refusal:
      'Nothing committed: this session has no changes of its own to commit (nothing it wrote ' +
      `is still uncommitted), and live session(s) ${named} share this clone — so the default ` +
      'cannot fall back to the whole working tree without taking their in-flight work. Pass ' +
      'scope "all" explicitly to take the whole working tree deliberately, their work included, ' +
      'or scope "paths" to commit named files no live session owns.',
  };
}

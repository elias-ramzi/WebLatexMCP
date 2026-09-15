import type { PeerShadowEntry, ShadowStore } from '../services/shadowStore.js';
import { latestTouch } from '../services/shadowStore.js';
import type { PeerSession } from '../services/sessionRegistry.js';

/** One live peer's claim on the disputed files, as seen for one push refusal or one status call. */
export interface PeerAttribution {
  sessionId: string;
  heartbeatAt: string;
  /** Dirty paths this peer's shadow lists; every dirty path when its index is unreadable. */
  owns: string[];
  lastWriteAt: string | null;
  /** True when the peer's index could not be read — treated as owning everything, fail closed. */
  unreadable: boolean;
}

export interface Attribution {
  sessions: PeerAttribution[];
  /** Disputed paths no readable peer's shadow claims. */
  unowned: string[];
}

/**
 * Attributes each of `theirs` (dirty paths this session did not write) to whichever live peer's
 * shadow lists it.
 *
 * A peer whose index could not be read (`entries.get(id) === null`, including a peer missing from
 * the map entirely) is treated as owning every disputed path — the same fail-closed rule
 * `peerEntries` documents: `null` means unreadable, never "owns nothing". That peer therefore never
 * contributes to `unowned`, since it might own anything.
 *
 * `fold` is git's own ASCII case fold (`foldCase`, `src/lib/caseFold.ts`) — pass it only when the
 * caller has established the repository is case-insensitive (`GitService.isCaseInsensitive`);
 * left unset, membership stays byte-exact. It is needed here because `theirs` arrives spelled the
 * way git reports the dirty path (the index's own spelling), while a peer's shadow key is
 * whatever spelling the caller who wrote it used — on a case-insensitive clone the two can name
 * the same file differently, and an unfolded comparison would miss the owner and misreport the
 * path as `unowned`. `owns` keeps `theirs`'s own elements (git's spelling), never the peer's.
 */
export function attributePeers(
  theirs: string[],
  peers: Array<{ sessionId: string; heartbeatAt: string }>,
  entries: Map<string, PeerShadowEntry[] | null>,
  fold: (p: string) => string = (p) => p,
): Attribution {
  const claimed = new Set<string>();

  const sessions: PeerAttribution[] = peers.map((p) => {
    const peerEntries = entries.get(p.sessionId) ?? null;
    if (peerEntries === null) {
      for (const t of theirs) claimed.add(t);
      return {
        sessionId: p.sessionId,
        heartbeatAt: p.heartbeatAt,
        owns: [...theirs],
        lastWriteAt: null,
        unreadable: true,
      };
    }

    const paths = new Set(peerEntries.map((e) => fold(e.path)));
    const owns = theirs.filter((t) => paths.has(fold(t)));
    for (const o of owns) claimed.add(o);
    return {
      sessionId: p.sessionId,
      heartbeatAt: p.heartbeatAt,
      owns,
      lastWriteAt: latestTouch(peerEntries),
      unreadable: false,
    };
  });

  const unowned = theirs.filter((t) => !claimed.has(t));
  return { sessions, unowned };
}

/**
 * Reads every peer's shadow index in parallel, keyed by session id — the shared gatherer behind
 * both the push ownership guard and `status`'s per-session `changes`/`lastWriteAt`. Read-only, no
 * lock: two callers reading the same peer's index concurrently need nothing serialized.
 */
export async function collectPeerShadows(
  shadows: ShadowStore,
  projectId: string,
  peers: PeerSession[],
): Promise<Map<string, PeerShadowEntry[] | null>> {
  const out = new Map<string, PeerShadowEntry[] | null>();
  await Promise.all(
    peers.map(async (p) => {
      out.set(p.sessionId, await shadows.peerEntries(projectId, p.sessionId));
    }),
  );
  return out;
}

/**
 * Renders an age as a short, human string: seconds under a minute, minutes under an hour, then
 * hours(+minutes) under a day, then days(+hours). A zero remainder is omitted (`"2h"`, not
 * `"2h 0m"`). Never negative — a timestamp that is (clock-skew) in the future clamps to `"0s"`.
 * An unparsable timestamp reads `"unknown"` rather than `"NaNs"`.
 */
export function formatAge(fromIso: string, nowMs: number): string {
  const fromMs = Date.parse(fromIso);
  if (Number.isNaN(fromMs)) return 'unknown';

  const deltaMs = Math.max(0, nowMs - fromMs);
  const totalSec = Math.floor(deltaMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;

  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;

  const totalHour = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  if (totalHour < 24) return remMin ? `${totalHour}h ${remMin}m` : `${totalHour}h`;

  const totalDay = Math.floor(totalHour / 24);
  const remHour = totalHour % 24;
  return remHour ? `${totalDay}d ${remHour}h` : `${totalDay}d`;
}

/** Join at most `max` entries, appending `, … N more` for whatever didn't fit — mirrors
 * `capList` in `src/services/gitService.ts` (not exported from there, so reimplemented here).
 * Every path list in the rendered message is bounded by this — the header's `theirs`, each
 * session's `owns`, the "No live session owns" line's `unowned`, and the closing's own copy of
 * `unowned` — so what remains unbounded is the *number of session lines*, one per live peer,
 * bounded in practice by how many sessions are concurrently heartbeating rather than by any list
 * length. */
function capList(items: string[], max: number): string {
  if (items.length <= max) return items.join(', ');
  const shown = items.slice(0, max);
  return `${shown.join(', ')}, … ${items.length - max} more`;
}

/**
 * The one cap for every path list `renderPeerRefusal` (and its `composeClosing`) render. A single
 * exported constant, not one chosen per call site: this file already grew a shared
 * `composeClosing` because two independently-worded messages drifted apart, and four
 * independently-chosen cap values would be the same mistake one level down. 20 is the existing
 * house value — `capList(paths, 20)` in `src/services/gitService.ts`, `CONFLICT_MAX_FILES` in
 * `src/lib/conflictBudget.ts`.
 */
export const REFUSAL_PATH_CAP = 20;

/**
 * True when `s` may own any of the disputed paths: a readable peer that owns at least one, or a
 * peer whose index is unreadable — which `attributePeers` already treats as owning everything, so
 * it must get the same advice as a confirmed owner (fail closed on advice too, not only on the
 * refusal itself).
 */
function isPeerOwning(s: PeerAttribution): boolean {
  return s.unreadable || s.owns.length > 0;
}

/**
 * The calling tool's own vocabulary for a composed closing: `push` is about to rebase and will
 * push again; `project_sync` is a fast-forward pull that cannot land a local commit (a sync after
 * committing only reports the histories as diverged), so it routes the caller to `push`. Only the framing
 * differs — which commit route applies to which group is a property of `commit`'s guards, not of
 * the caller, so that half is shared.
 */
export interface ClosingVocabulary {
  /** Why the caller is blocked, and the wait-for-the-owner advice. Ends with a full stop. */
  opening: string;
  /** What to do once ownership is settled, e.g. `'Then push again.'`. */
  retry: string;
}

/** `push`'s framing — it has to rebase, and retries by pushing. */
export const PUSH_VOCABULARY: ClosingVocabulary = {
  opening:
    'Pushing has to rebase, which would sweep up or overwrite in-flight work. A recent last ' +
    'write means the owner is mid-edit: wait for it to commit.',
  retry: 'Then push again.',
};

/**
 * Composes a refusal's closing paragraph from the attribution itself, instead of one static
 * paragraph that blurred two groups needing opposite advice together:
 *
 * - **Peer-owned files** (owned by a readable peer, or by a peer whose index is unreadable and so
 *   may own anything) can only be taken with `commit scope: "all"` — `scope: "paths"` refuses
 *   outright any path a live session's shadow lists (`src/tools/commit.ts`), so naming it here
 *   would send the caller into a guaranteed second refusal.
 * - **Unowned files** (no live, readable peer's shadow claims them — edited outside the server, or
 *   left by a session that has since exited) commit cleanly with `scope: "paths"` naming just
 *   them, which is the *better* route for this group since it can't sweep in a peer's lines the
 *   way `scope: "all"` would.
 *
 * Each group, when present, gets its own sentence naming its own route — never one piece of advice
 * applied to both. Both `push` and `project_sync` compose from here: which route works is decided
 * by `commit`'s peer guard, so a caller that worded it independently would drift from the guard.
 */
export function composeClosing(a: Attribution, vocab: ClosingVocabulary): string {
  const { opening, retry } = vocab;

  const hasOwned = a.sessions.some(isPeerOwning);
  const hasUnowned = a.unowned.length > 0;

  // An unreadable index refuses `scope: "paths"` on its own terms (whatever paths are named), a
  // readable owner refuses the paths it lists — different triggers, same unavailable route, so the
  // sentence names the route rather than one of the two triggers.
  const ownedAdvice =
    'Taking the peer-owned files requires committing with scope "all" — scope "paths" is not an ' +
    'option for them: it refuses any path a live session owns, and refuses outright while a live ' +
    "session's change index cannot be read. Do not `discard` them either: discard has no " +
    "ownership guard, so it would destroy the owner's uncommitted work.";
  const only = a.unowned.length === 1;
  const unownedAdvice =
    `${capList(a.unowned, REFUSAL_PATH_CAP)} — not owned by any live session — can be committed ` +
    `on ${only ? 'its' : 'their'} own with scope "paths", naming just ` +
    `${only ? 'that path' : 'those paths'}: that does not sweep in anyone else's work, and is ` +
    `preferable to scope "all" for ${only ? 'it' : 'them'}.`;

  if (hasOwned && hasUnowned) {
    return `${opening} ${ownedAdvice} ${unownedAdvice} ${retry}`;
  }
  if (hasOwned) {
    return `${opening} ${ownedAdvice} ${retry}`;
  }
  if (hasUnowned) {
    return `${opening} ${unownedAdvice} ${retry}`;
  }
  // Unreachable in practice: `renderPeerRefusal` is only called with a non-empty `theirs`, and
  // `attributePeers` puts every such path either in some session's `owns` or in `unowned`, so one
  // of the two branches above always fires. Kept as a defensive default — and worded like the
  // peer-owned branch rather than the old "(or scope \"paths\" for named files)", because if it
  // ever does fire we cannot show a path is unowned, and `scope: "paths"` refuses a path a live
  // session owns. Advising the route that fails closed is the safe direction to be wrong in.
  return (
    `${opening} Take ownership deliberately with commit scope "all" — scope "paths" refuses ` +
    'outright any path a live session owns. Do not `discard` them either: discard has no ' +
    `ownership guard, so it would destroy the owner's uncommitted work. ${retry}`
  );
}

/**
 * Renders the peer-refusal message: which disputed files belong to which live peer, dated, so the
 * caller knows whether to wait (a recent last write means the owner is mid-edit) or to take
 * ownership deliberately. Keep the first line's exact prefix
 * (`Uncommitted changes in the shared clone are not this session's:`) — existing tests match
 * `not this session`.
 *
 * `closing` is the final paragraph's text, in the calling tool's own vocabulary — `push` is about
 * to rebase, `project_sync` is about to fast-forward-pull, and the advice ("push again" vs. "sync
 * again") must match. When omitted (as `push`'s own call site does), it is composed from `a` by
 * `composeClosing` with {@link PUSH_VOCABULARY}, so peer-owned and unowned files each get the
 * route that actually works. A caller in another vocabulary passes its own — see `project_sync`.
 */
export function renderPeerRefusal(
  theirs: string[],
  a: Attribution,
  nowMs: number,
  closing?: string,
): string {
  let truncated = theirs.length > REFUSAL_PATH_CAP;

  const lines: string[] = [
    `Uncommitted changes in the shared clone are not this session's: ${capList(theirs, REFUSAL_PATH_CAP)}.`,
  ];

  for (const s of a.sessions) {
    const heartbeat = `heartbeat ${formatAge(s.heartbeatAt, nowMs)} ago`;
    if (s.unreadable) {
      lines.push(
        `Live session "${s.sessionId}" — its change index is unreadable, so every file above may ` +
          `be its; ${heartbeat}.`,
      );
    } else if (s.owns.length === 0) {
      lines.push(`Live session "${s.sessionId}" owns nothing here — ${heartbeat}.`);
    } else {
      // Unreachable as a *decider* for any Attribution attributePeers actually produces: owns is
      // always a subset of theirs (built as theirs.filter(...)), so owns.length > REFUSAL_PATH_CAP
      // already implies theirs.length > REFUSAL_PATH_CAP, which the header check above already
      // caught. Kept only because renderPeerRefusal takes theirs and a as independent arguments —
      // a hand-built Attribution could own more paths than theirs lists, and this stops that case
      // from rendering a truncated owns list with no pointer to `status`.
      if (s.owns.length > REFUSAL_PATH_CAP) truncated = true;
      const lastWrite = s.lastWriteAt
        ? `last write ${formatAge(s.lastWriteAt, nowMs)} ago`
        : 'no write on record';
      lines.push(
        `Live session "${s.sessionId}" owns ${capList(s.owns, REFUSAL_PATH_CAP)} — ${lastWrite}, ${heartbeat}.`,
      );
    }
  }

  if (a.unowned.length > 0) {
    // Same reasoning as the owns-list setter above: unowned is also always a subset of theirs
    // (attributePeers builds it as theirs.filter((t) => !claimed.has(t))), so this can't fire as a
    // decider for any Attribution the server actually builds — the header check already caught it.
    // Kept for the same hand-built-Attribution defence.
    if (a.unowned.length > REFUSAL_PATH_CAP) truncated = true;
    lines.push(
      `No live session owns ${capList(a.unowned, REFUSAL_PATH_CAP)} — edited outside this server, ` +
        'or left by a session that has exited.',
    );
  }

  // Two things this line deliberately does not say.
  //
  // It does not say `status` reports *these* lists, because that is only true for `push`, whose
  // `theirs` is built exactly as `otherChanges` is. `project_sync` renders the same line over the
  // paths an incoming commit would overwrite, tracked or untracked — a strict subset of
  // `otherChanges`, and a set no `status` field reproduces. So the claim is the weaker true one: every omitted path is
  // in there, among more besides.
  //
  // And it spells out a derivation rather than just naming the two fields, because `status` has
  // no `unowned`-shaped field and `otherChanges` is the whole disputed set, peer-owned files
  // included. A caller who fed that to `commit scope: "paths"` — which is what the closing
  // advises for unowned files — would hit the live-peer guard in `src/tools/commit.ts`, which
  // throws before committing anything rather than skipping the offending paths. Naming a field
  // that bounces off a guard one tool over is the failure `composeClosing` above exists to end;
  // it would be back, one layer down, in a pointer that merely sounded helpful.
  if (truncated) {
    lines.push(
      `Lists here are capped at ${REFUSAL_PATH_CAP} paths, the closing's included. \`status\` ` +
        'names every path they omit, uncapped: `otherChanges` is every uncommitted file this ' +
        'session did not write — a superset of the files named here — and ' +
        '`activeSessions[].changes` is what each session claims, with a `live` flag. Subtract ' +
        "every live session's `changes` from `otherChanges` for the files no live session owns; " +
        'a session whose `changes` is null may own any of them.',
    );
  }

  lines.push(closing ?? composeClosing(a, PUSH_VOCABULARY));

  return lines.join('\n');
}

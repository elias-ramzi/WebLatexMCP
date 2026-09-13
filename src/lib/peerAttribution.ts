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

/**
 * Default closing paragraph — written for `push`'s caller, who is about to rebase. A caller in a
 * different vocabulary (e.g. `project_sync`, about to fast-forward-pull) should pass its own
 * `closing` string instead of this one.
 */
const DEFAULT_CLOSING =
  'Pushing has to rebase, which would sweep up or overwrite in-flight work. A recent last write ' +
  'means the owner is mid-edit: wait for it to commit. Otherwise take ownership deliberately ' +
  'with commit scope "all" (or scope "paths" for named files) and push again.';

/**
 * Renders the peer-refusal message: which disputed files belong to which live peer, dated, so the
 * caller knows whether to wait (a recent last write means the owner is mid-edit) or to take
 * ownership deliberately. Keep the first line's exact prefix
 * (`Uncommitted changes in the shared clone are not this session's:`) — existing tests match
 * `not this session`.
 *
 * `closing` is the final paragraph's text, in the calling tool's own vocabulary — `push` is about
 * to rebase, `project_sync` is about to fast-forward-pull, and the advice ("push again" vs. "sync
 * again") must match. Defaults to the push-specific wording so `push`'s own call site (which never
 * passes this) is unaffected.
 */
export function renderPeerRefusal(
  theirs: string[],
  a: Attribution,
  nowMs: number,
  closing: string = DEFAULT_CLOSING,
): string {
  const lines: string[] = [
    `Uncommitted changes in the shared clone are not this session's: ${theirs.join(', ')}.`,
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
      const lastWrite = s.lastWriteAt
        ? `last write ${formatAge(s.lastWriteAt, nowMs)} ago`
        : 'no write on record';
      lines.push(
        `Live session "${s.sessionId}" owns ${s.owns.join(', ')} — ${lastWrite}, ${heartbeat}.`,
      );
    }
  }

  if (a.unowned.length > 0) {
    lines.push(
      `No live session owns ${a.unowned.join(', ')} — edited outside this server, or left by a ` +
        'session that has exited.',
    );
  }

  lines.push(closing);

  return lines.join('\n');
}

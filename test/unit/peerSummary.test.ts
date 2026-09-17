import { describe, it, expect } from 'vitest';
import {
  isStalePeer,
  splitStalePeers,
  RECENT_HEARTBEAT_GRACE_MS,
} from '../../src/lib/peerSummary.js';

/**
 * A heartbeat age comfortably past any grace window — the ordinary "died long ago" peer, which is
 * the case `status`'s collapse exists for.
 */
const VERY_OLD_MS = 24 * 60 * 60 * 1000;
/**
 * Dead (past `SessionRegistry`'s 30-minute `STALE_MS`) but only recently so: inside the grace, so
 * a failed shadow-index write is still a live possibility and the peer stays named.
 */
const RECENTLY_QUIET_MS = 45 * 60 * 1000;
/** An injected grace, used where the boundary has to be legible rather than arithmetic. */
const GRACE = 60 * 60 * 1000;

describe('isStalePeer', () => {
  it('shows a live peer even with an empty shadow index and an ancient heartbeat', () => {
    // Liveness wins outright: a live peer may write any moment, whatever its heartbeat says (a
    // live session only rewrites its heartbeat every HEARTBEAT_THROTTLE_MS, so an old one proves
    // nothing about it).
    expect(isStalePeer({ live: true, entries: [], heartbeatAgeMs: VERY_OLD_MS }, GRACE)).toBe(
      false,
    );
  });

  it('shows a live peer whose index is unreadable', () => {
    expect(isStalePeer({ live: true, entries: null, heartbeatAgeMs: VERY_OLD_MS }, GRACE)).toBe(
      false,
    );
  });

  it('is stale for a dead peer with a readably-empty shadow index and a long-dead heartbeat', () => {
    // The case #75 exists for: a killed agent that never recorded anything and is never coming
    // back. The grace exemption must not have disarmed this.
    expect(isStalePeer({ live: false, entries: [], heartbeatAgeMs: VERY_OLD_MS }, GRACE)).toBe(
      true,
    );
  });

  it('shows a dead peer whose index is unreadable — null means unreadable, never "owns nothing"', () => {
    // This is the load-bearing case: `ShadowStore.peerEntries` returns `null` only when the index
    // could not be read (malformed JSON, wrong shape, an I/O error other than ENOENT) — never as a
    // stand-in for "the peer owns nothing". Collapsing that into a stale count would report as
    // fact the one thing this codebase refuses to infer (see peerAttribution.ts's attributePeers,
    // which treats a `null` index as owning EVERY disputed path, fail closed). So an unreadable
    // index must stay individually listed, whether or not the peer is live.
    expect(isStalePeer({ live: false, entries: null, heartbeatAgeMs: VERY_OLD_MS }, GRACE)).toBe(
      false,
    );
  });

  it('shows a dead peer with an unreadable index that went quiet recently — the null rule is not disarmed by the age clause', () => {
    // Both guards agree here, and that is the point of pinning it: the `entries !== null` clause
    // decides this case on its own, ahead of the age clause, so no future reordering or "simplify
    // the conjunction" pass can make an unreadable index collapse once its heartbeat ages out.
    expect(
      isStalePeer({ live: false, entries: null, heartbeatAgeMs: RECENTLY_QUIET_MS }, GRACE),
    ).toBe(false);
  });

  it('shows a dead peer with entries — its last-known changes still matter', () => {
    expect(
      isStalePeer(
        { live: false, entries: [{ path: 'a.tex' }], heartbeatAgeMs: VERY_OLD_MS },
        GRACE,
      ),
    ).toBe(false);
  });

  it('shows a dead, empty peer whose heartbeat is one millisecond inside the grace', () => {
    // The exemption itself: an empty index cannot distinguish "recorded nothing" from "the index
    // write failed", so while the death is recent the peer stays named as the suspect for any
    // dirty lines in the tree.
    expect(isStalePeer({ live: false, entries: [], heartbeatAgeMs: GRACE - 1 }, GRACE)).toBe(false);
  });

  it('collapses a dead, empty peer exactly at the grace boundary — the comparison is >=', () => {
    expect(isStalePeer({ live: false, entries: [], heartbeatAgeMs: GRACE }, GRACE)).toBe(true);
  });

  it('collapses a dead, empty peer one millisecond past the grace', () => {
    expect(isStalePeer({ live: false, entries: [], heartbeatAgeMs: GRACE + 1 }, GRACE)).toBe(true);
  });

  it('shows a dead, empty peer whose heartbeat is unparseable (NaN age) — fail closed', () => {
    // An unparseable `heartbeatAt` yields a non-finite age, and a non-finite age is never
    // collapsed: we cannot show the death is old, so we do not assert "holds no changes".
    //
    // This is the OPPOSITE sign from `bootIdentity.ts`, where a non-finite age "earns nothing".
    // There, granting on a non-finite value would call a peer live off unusable evidence; here,
    // the unsafe direction is the other one — collapsing removes the only named suspect for dirty
    // lines. Same fail-closed bias as the `null` rule above, applied to a different sign.
    expect(isStalePeer({ live: false, entries: [], heartbeatAgeMs: Number.NaN }, GRACE)).toBe(
      false,
    );
  });

  it('shows a dead, empty peer whose age is +Infinity — Number.isFinite is not a "> 0" check in disguise', () => {
    // An infinite age is arithmetically "older than any grace", so a `>= graceMs` test alone would
    // collapse it. It is still a non-finite value derived from an unusable timestamp, and the
    // finiteness clause must reject it on those grounds rather than let the ordering clause decide.
    expect(
      isStalePeer({ live: false, entries: [], heartbeatAgeMs: Number.POSITIVE_INFINITY }, GRACE),
    ).toBe(false);
  });

  it('uses RECENT_HEARTBEAT_GRACE_MS when no grace is supplied', () => {
    // The default path, not an injected one: `status` calls this with two arguments only through
    // `splitStalePeers`, so the default is what actually ships.
    expect(
      isStalePeer({ live: false, entries: [], heartbeatAgeMs: RECENT_HEARTBEAT_GRACE_MS - 1 }),
    ).toBe(false);
    expect(
      isStalePeer({ live: false, entries: [], heartbeatAgeMs: RECENT_HEARTBEAT_GRACE_MS + 1 }),
    ).toBe(true);
  });

  it('sizes the grace above SessionRegistry.STALE_MS, or the exemption could never fire', () => {
    // The vacuity trap, and the reason this assertion exists rather than the constant just being
    // "some reasonable number": in `SessionRegistry.peers()`, `live` is true when the session is
    // us, or its pid clause grants, or `Number.isFinite(age) && age < STALE_MS` with
    // `STALE_MS = 30 * 60 * 1000`. So `!live` ALREADY implies a heartbeat at least 30 minutes old
    // (or unparseable). `isStalePeer` only ever sees `heartbeatAgeMs` for a peer it has already
    // found `!live`, so any grace window at or below 30 minutes could never keep one listed — the
    // exemption would be dead code that reads as a working guard, which is the worst way for a
    // guard to be wrong.
    //
    // Do not confuse that 30 minutes with `HEARTBEAT_THROTTLE_MS` (30 seconds), which only paces
    // how often a LIVE session rewrites its heartbeat and bounds nothing about death.
    //
    // `STALE_MS` is not exported and `src/services/sessionRegistry.ts` is out of scope here, so
    // the literal is spelled out with this comment instead of imported.
    expect(RECENT_HEARTBEAT_GRACE_MS).toBeGreaterThan(30 * 60 * 1000);
  });
});

describe('splitStalePeers', () => {
  it('separates stale peers from shown ones, preserving order, and counts the stale ones', () => {
    const peers = [
      { id: 'a', live: true, entries: [] as unknown[] | null, age: VERY_OLD_MS },
      { id: 'b', live: false, entries: [] as unknown[] | null, age: VERY_OLD_MS }, // stale
      { id: 'c', live: false, entries: null as unknown[] | null, age: VERY_OLD_MS }, // unreadable
      { id: 'd', live: false, entries: [{ path: 'x' }] as unknown[] | null, age: VERY_OLD_MS },
      { id: 'e', live: false, entries: [] as unknown[] | null, age: VERY_OLD_MS }, // stale
    ];

    const { shown, stale } = splitStalePeers(peers, (p) => ({
      live: p.live,
      entries: p.entries,
      heartbeatAgeMs: p.age,
    }));

    expect(shown.map((p) => p.id)).toEqual(['a', 'c', 'd']);
    expect(stale).toBe(2);
  });

  it('returns nothing shown and stale 0 for no peers at all', () => {
    const peers: Array<{ live: boolean; entries: unknown[] | null; age: number }> = [];
    const { shown, stale } = splitStalePeers(peers, (p) => ({
      live: p.live,
      entries: p.entries,
      heartbeatAgeMs: p.age,
    }));
    expect(shown).toEqual([]);
    expect(stale).toBe(0);
  });

  it('returns everything shown and stale 0 when nothing is stale', () => {
    const peers = [{ id: 'a', live: true, entries: [] as unknown[] | null, age: VERY_OLD_MS }];
    const { shown, stale } = splitStalePeers(peers, (p) => ({
      live: p.live,
      entries: p.entries,
      heartbeatAgeMs: p.age,
    }));
    expect(shown).toEqual(peers);
    expect(stale).toBe(0);
  });

  it('counts a long-dead empty peer but keeps a recently-quiet one shown, order preserved', () => {
    const peers = [
      { id: 'long-dead', live: false, entries: [] as unknown[] | null, age: VERY_OLD_MS },
      { id: 'just-quiet', live: false, entries: [] as unknown[] | null, age: RECENTLY_QUIET_MS },
      { id: 'holder', live: false, entries: [{ path: 'x' }] as unknown[] | null, age: VERY_OLD_MS },
    ];

    const { shown, stale } = splitStalePeers(peers, (p) => ({
      live: p.live,
      entries: p.entries,
      heartbeatAgeMs: p.age,
    }));

    expect(shown.map((p) => p.id)).toEqual(['just-quiet', 'holder']);
    expect(stale).toBe(1);
  });

  it('threads an explicit graceMs through to isStalePeer — the same peers split differently', () => {
    // Pins that the parameter is actually used rather than accepted and ignored: one list, two
    // windows, two answers.
    const peers = [
      { id: 'p30', live: false, entries: [] as unknown[] | null, age: 30 * 60 * 1000 },
      { id: 'p90', live: false, entries: [] as unknown[] | null, age: 90 * 60 * 1000 },
    ];
    const read = (
      p: (typeof peers)[number],
    ): {
      live: boolean;
      entries: unknown[] | null;
      heartbeatAgeMs: number;
    } => ({ live: p.live, entries: p.entries, heartbeatAgeMs: p.age });

    const wide = splitStalePeers(peers, read, 2 * 60 * 60 * 1000);
    expect(wide.shown.map((p) => p.id)).toEqual(['p30', 'p90']);
    expect(wide.stale).toBe(0);

    const narrow = splitStalePeers(peers, read, 60 * 60 * 1000);
    expect(narrow.shown.map((p) => p.id)).toEqual(['p30']);
    expect(narrow.stale).toBe(1);
  });
});

import { describe, it, expect } from 'vitest';
import { isStalePeer, splitStalePeers } from '../../src/lib/peerSummary.js';

describe('isStalePeer', () => {
  it('shows a live peer even with an empty shadow index', () => {
    expect(isStalePeer({ live: true, entries: [] })).toBe(false);
  });

  it('shows a live peer whose index is unreadable', () => {
    expect(isStalePeer({ live: true, entries: null })).toBe(false);
  });

  it('is stale for a dead peer with a readably-empty shadow index', () => {
    expect(isStalePeer({ live: false, entries: [] })).toBe(true);
  });

  it('shows a dead peer whose index is unreadable — null means unreadable, never "owns nothing"', () => {
    // This is the load-bearing case: `ShadowStore.peerEntries` returns `null` only when the index
    // could not be read (malformed JSON, wrong shape, an I/O error other than ENOENT) — never as a
    // stand-in for "the peer owns nothing". Collapsing that into a stale count would report as
    // fact the one thing this codebase refuses to infer (see peerAttribution.ts's attributePeers,
    // which treats a `null` index as owning EVERY disputed path, fail closed). So an unreadable
    // index must stay individually listed, whether or not the peer is live.
    expect(isStalePeer({ live: false, entries: null })).toBe(false);
  });

  it('shows a dead peer with entries — its last-known changes still matter', () => {
    expect(isStalePeer({ live: false, entries: [{ path: 'a.tex' }] })).toBe(false);
  });
});

describe('splitStalePeers', () => {
  it('separates stale peers from shown ones, preserving order, and counts the stale ones', () => {
    const peers = [
      { id: 'a', live: true, entries: [] as unknown[] | null },
      { id: 'b', live: false, entries: [] as unknown[] | null }, // stale
      { id: 'c', live: false, entries: null as unknown[] | null }, // unreadable, shown
      { id: 'd', live: false, entries: [{ path: 'x' }] as unknown[] | null }, // shown
      { id: 'e', live: false, entries: [] as unknown[] | null }, // stale
    ];

    const { shown, stale } = splitStalePeers(peers, (p) => ({ live: p.live, entries: p.entries }));

    expect(shown.map((p) => p.id)).toEqual(['a', 'c', 'd']);
    expect(stale).toBe(2);
  });

  it('returns everything shown and stale 0 when nothing is stale', () => {
    const peers = [{ id: 'a', live: true, entries: [] as unknown[] | null }];
    const { shown, stale } = splitStalePeers(peers, (p) => ({ live: p.live, entries: p.entries }));
    expect(shown).toEqual(peers);
    expect(stale).toBe(0);
  });
});

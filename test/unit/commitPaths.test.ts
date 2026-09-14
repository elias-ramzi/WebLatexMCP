import { describe, it, expect } from 'vitest';
import {
  coversPath,
  uncoveredPaths,
  peerOwnership,
  type OwnedPath,
} from '../../src/lib/commitPaths.js';
import type { PeerShadowEntry } from '../../src/services/shadowStore.js';
import { foldCase } from '../../src/lib/caseFold.js';

const entry = (path: string): PeerShadowEntry => ({
  path,
  deleted: false,
  conflicted: false,
  touchedAt: null,
});

describe('coversPath', () => {
  it('covers an exact match', () => {
    expect(coversPath('a.tex', 'a.tex')).toBe(true);
  });

  it('a directory covers a file under it', () => {
    expect(coversPath('figs', 'figs/a.txt')).toBe(true);
  });

  it('never covers a differently-named directory sharing a prefix', () => {
    expect(coversPath('figs', 'figsx/a.txt')).toBe(false);
  });

  it('normalises a trailing slash away, so it still covers', () => {
    expect(coversPath('figs/', 'figs/a.txt')).toBe(true);
  });

  it('"." and "" cover nothing', () => {
    expect(coversPath('.', 'a.tex')).toBe(false);
    expect(coversPath('', 'a.tex')).toBe(false);
  });

  describe('with a fold function (case-insensitive repository)', () => {
    it('is byte-exact by default — no fold means a differently-cased name is NOT covered', () => {
      expect(coversPath('notes.txt', 'Notes.txt')).toBe(false);
    });

    it('covers a differently-cased exact match when folded', () => {
      expect(coversPath('notes.txt', 'Notes.txt', foldCase)).toBe(true);
    });

    it('covers a differently-cased directory entry when folded', () => {
      expect(coversPath('sub', 'Sub/x.tex', foldCase)).toBe(true);
    });

    it('still refuses a differently-named directory sharing a prefix, even folded', () => {
      expect(coversPath('sub', 'Subx/x.tex', foldCase)).toBe(false);
    });

    it('never folds a Kelvin sign onto ASCII k — git itself would not', () => {
      // U+212A KELVIN SIGN is outside foldCase's deliberately ASCII-only A-Z range.
      expect(coversPath('aK.tex', 'ak.tex', foldCase)).toBe(false);
    });
  });
});

describe('uncoveredPaths', () => {
  it('returns requested paths that match no dirty entry', () => {
    expect(uncoveredPaths(['a.tex', 'figs', 'z.tex'], ['a.tex', 'figs/x.png'])).toEqual(['z.tex']);
  });

  it('returns nothing when every requested path is covered', () => {
    expect(uncoveredPaths(['a.tex'], ['a.tex', 'b.tex'])).toEqual([]);
  });
});

describe('peerOwnership', () => {
  it('reports the path owned by whichever of two peers has it', () => {
    const peers = [{ sessionId: 'beta' }, { sessionId: 'gamma' }];
    const entries = new Map<string, PeerShadowEntry[] | null>([
      ['beta', [entry('sections/method.tex')]],
      ['gamma', [entry('sections/results.tex')]],
    ]);
    const { owned, unreadable } = peerOwnership(['sections/method.tex'], peers, entries);
    expect(unreadable).toEqual([]);
    expect(owned).toEqual<OwnedPath[]>([{ path: 'sections/method.tex', sessionId: 'beta' }]);
  });

  it('lists an unreadable peer in `unreadable`, and never in `owned`', () => {
    const peers = [{ sessionId: 'beta' }, { sessionId: 'gamma' }];
    const entries = new Map<string, PeerShadowEntry[] | null>([
      ['beta', null],
      ['gamma', [entry('sections/results.tex')]],
    ]);
    const { owned, unreadable } = peerOwnership(['sections/method.tex'], peers, entries);
    expect(unreadable).toEqual(['beta']);
    expect(owned.some((o) => o.sessionId === 'beta')).toBe(false);
  });

  it('a peer with an empty index owns nothing', () => {
    const peers = [{ sessionId: 'beta' }];
    const entries = new Map<string, PeerShadowEntry[] | null>([['beta', []]]);
    const { owned, unreadable } = peerOwnership(['a.tex'], peers, entries);
    expect(owned).toEqual([]);
    expect(unreadable).toEqual([]);
  });

  it('a peer entry under a requested directory counts as owned', () => {
    const peers = [{ sessionId: 'beta' }];
    const entries = new Map<string, PeerShadowEntry[] | null>([['beta', [entry('figs/plot.png')]]]);
    const { owned } = peerOwnership(['figs'], peers, entries);
    expect(owned).toEqual<OwnedPath[]>([{ path: 'figs/plot.png', sessionId: 'beta' }]);
  });

  it('fails closed on a live peer missing from the entries map — treated exactly like null', () => {
    // A peer the caller knows is live (it is in the `peers` list) but for which
    // `entriesBySession` happens to carry no entry at all — as opposed to an explicit `null` —
    // must still land in `unreadable`. Iterating `entriesBySession`'s own keys (the pre-fix
    // behaviour) would silently skip this peer and report it as owning nothing, failing open.
    const peers = [{ sessionId: 'beta' }, { sessionId: 'gamma' }];
    const entries = new Map<string, PeerShadowEntry[] | null>([
      ['gamma', [entry('sections/results.tex')]],
      // 'beta' intentionally absent from the map.
    ]);
    const { owned, unreadable } = peerOwnership(['sections/method.tex'], peers, entries);
    expect(unreadable).toEqual(['beta']);
    expect(owned.some((o) => o.sessionId === 'beta')).toBe(false);
  });

  describe('with a fold function (case-insensitive repository)', () => {
    it("finds a peer entry whose spelling differs only in case, and reports the peer's own spelling", () => {
      const peers = [{ sessionId: 'p' }];
      const entries = new Map<string, PeerShadowEntry[] | null>([['p', [entry('Notes.txt')]]]);
      const { owned } = peerOwnership(['notes.txt'], peers, entries, foldCase);
      expect(owned).toEqual<OwnedPath[]>([{ path: 'Notes.txt', sessionId: 'p' }]);
    });

    it('without a fold, a differently-cased peer entry is not found', () => {
      const peers = [{ sessionId: 'p' }];
      const entries = new Map<string, PeerShadowEntry[] | null>([['p', [entry('Notes.txt')]]]);
      const { owned } = peerOwnership(['notes.txt'], peers, entries);
      expect(owned).toEqual([]);
    });

    it('a peer mapped to null is unreadable whether or not a fold is passed', () => {
      const peers = [{ sessionId: 'p' }];
      const entries = new Map<string, PeerShadowEntry[] | null>([['p', null]]);
      expect(peerOwnership(['notes.txt'], peers, entries, foldCase).unreadable).toEqual(['p']);
      expect(peerOwnership(['notes.txt'], peers, entries).unreadable).toEqual(['p']);
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  coversPath,
  uncoveredPaths,
  peerOwnership,
  type OwnedPath,
} from '../../src/lib/commitPaths.js';
import type { PeerShadowEntry } from '../../src/services/shadowStore.js';

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
    const entries = new Map<string, PeerShadowEntry[] | null>([
      ['beta', [entry('sections/method.tex')]],
      ['gamma', [entry('sections/results.tex')]],
    ]);
    const { owned, unreadable } = peerOwnership(['sections/method.tex'], entries);
    expect(unreadable).toEqual([]);
    expect(owned).toEqual<OwnedPath[]>([{ path: 'sections/method.tex', sessionId: 'beta' }]);
  });

  it('lists an unreadable peer in `unreadable`, and never in `owned`', () => {
    const entries = new Map<string, PeerShadowEntry[] | null>([
      ['beta', null],
      ['gamma', [entry('sections/results.tex')]],
    ]);
    const { owned, unreadable } = peerOwnership(['sections/method.tex'], entries);
    expect(unreadable).toEqual(['beta']);
    expect(owned.some((o) => o.sessionId === 'beta')).toBe(false);
  });

  it('a peer with an empty index owns nothing', () => {
    const entries = new Map<string, PeerShadowEntry[] | null>([['beta', []]]);
    const { owned, unreadable } = peerOwnership(['a.tex'], entries);
    expect(owned).toEqual([]);
    expect(unreadable).toEqual([]);
  });

  it('a peer entry under a requested directory counts as owned', () => {
    const entries = new Map<string, PeerShadowEntry[] | null>([['beta', [entry('figs/plot.png')]]]);
    const { owned } = peerOwnership(['figs'], entries);
    expect(owned).toEqual<OwnedPath[]>([{ path: 'figs/plot.png', sessionId: 'beta' }]);
  });
});

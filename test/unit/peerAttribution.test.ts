import { describe, it, expect } from 'vitest';
import {
  attributePeers,
  formatAge,
  renderPeerRefusal,
  composeClosing,
  PUSH_VOCABULARY,
  REFUSAL_PATH_CAP,
  type Attribution,
} from '../../src/lib/peerAttribution.js';
import type { PeerShadowEntry } from '../../src/services/shadowStore.js';
import { foldCase } from '../../src/lib/caseFold.js';

const entry = (path: string, touchedAt: string | null = null): PeerShadowEntry => ({
  path,
  deleted: false,
  conflicted: false,
  touchedAt,
});

describe('attributePeers', () => {
  const THEIRS = ['a.tex', 'b.tex', 'c.png'];
  const PEERS = [
    { sessionId: 'beta', heartbeatAt: '2026-01-01T00:00:10.000Z' },
    { sessionId: 'gamma', heartbeatAt: '2026-01-01T00:03:00.000Z' },
  ];

  it('splits owned/unowned across two readable peers, one owning nothing', () => {
    const entries = new Map([
      [
        'beta',
        [
          entry('a.tex', '2026-01-01T00:00:00.000Z'),
          entry('b.tex', '2026-01-01T00:00:42.000Z'), // later of the two
        ],
      ],
      ['gamma', []],
    ]);

    const a = attributePeers(THEIRS, PEERS, entries);

    expect(a.unowned).toEqual(['c.png']);
    const beta = a.sessions.find((s) => s.sessionId === 'beta');
    expect(beta?.owns).toEqual(['a.tex', 'b.tex']);
    expect(beta?.unreadable).toBe(false);
    // lastWriteAt is latestTouch over this peer's own entries — the later of the two touches.
    expect(beta?.lastWriteAt).toBe('2026-01-01T00:00:42.000Z');

    const gamma = a.sessions.find((s) => s.sessionId === 'gamma');
    expect(gamma?.owns).toEqual([]);
    expect(gamma?.lastWriteAt).toBeNull();
  });

  it('an unreadable peer claims every disputed path and unowned stays empty', () => {
    const entries = new Map<string, PeerShadowEntry[] | null>([
      ['beta', null], // unreadable
      ['gamma', []], // readable, owns nothing
    ]);

    const a = attributePeers(THEIRS, PEERS, entries);

    const beta = a.sessions.find((s) => s.sessionId === 'beta');
    expect(beta?.unreadable).toBe(true);
    expect(beta?.owns).toEqual(THEIRS);
    expect(beta?.lastWriteAt).toBeNull();
    // Even though gamma (readable) owns nothing, the unreadable peer's blanket claim means
    // nothing is left unowned.
    expect(a.unowned).toEqual([]);
  });

  it('a peer missing from the entries map is treated the same as unreadable (fail closed)', () => {
    const entries = new Map<string, PeerShadowEntry[] | null>([['gamma', []]]);
    const a = attributePeers(THEIRS, [PEERS[0] as (typeof PEERS)[0]], entries);
    const beta = a.sessions.find((s) => s.sessionId === 'beta');
    expect(beta?.unreadable).toBe(true);
    expect(beta?.owns).toEqual(THEIRS);
  });

  describe('with a fold function (case-insensitive repository)', () => {
    const PEER = [{ sessionId: 'p', heartbeatAt: '2026-01-01T00:00:10.000Z' }];

    it('attributes a dirty path to a peer whose shadow lists it under a different case', () => {
      const entries = new Map<string, PeerShadowEntry[] | null>([['p', [entry('Notes.txt')]]]);
      const a = attributePeers(['notes.txt'], PEER, entries, foldCase);
      const p = a.sessions.find((s) => s.sessionId === 'p');
      expect(p?.owns).toEqual(['notes.txt']);
      expect(a.unowned).toEqual([]);
    });

    it('without a fold, the same peer misses it and it falls into unowned', () => {
      const entries = new Map<string, PeerShadowEntry[] | null>([['p', [entry('Notes.txt')]]]);
      const a = attributePeers(['notes.txt'], PEER, entries);
      const p = a.sessions.find((s) => s.sessionId === 'p');
      expect(p?.owns).toEqual([]);
      expect(a.unowned).toEqual(['notes.txt']);
    });

    it('an unreadable peer still claims every disputed path, fold or not', () => {
      const entries = new Map<string, PeerShadowEntry[] | null>([['p', null]]);
      const withFold = attributePeers(['notes.txt'], PEER, entries, foldCase);
      const withoutFold = attributePeers(['notes.txt'], PEER, entries);
      expect(withFold.sessions[0]?.owns).toEqual(['notes.txt']);
      expect(withoutFold.sessions[0]?.owns).toEqual(['notes.txt']);
    });
  });
});

describe('formatAge', () => {
  const NOW = Date.parse('2026-01-01T00:10:00.000Z');

  it('renders seconds under a minute', () => {
    expect(formatAge(new Date(NOW - 12_000).toISOString(), NOW)).toBe('12s');
  });

  it('renders minutes under an hour', () => {
    expect(formatAge(new Date(NOW - 3 * 60_000).toISOString(), NOW)).toBe('3m');
  });

  it('renders hours and minutes under a day', () => {
    expect(formatAge(new Date(NOW - (2 * 60 + 5) * 60_000).toISOString(), NOW)).toBe('2h 5m');
  });

  it('renders days and hours at a day or more', () => {
    expect(formatAge(new Date(NOW - (27 * 60 + 0) * 60_000).toISOString(), NOW)).toBe('1d 3h');
  });

  it('reads "unknown" for an unparsable timestamp', () => {
    expect(formatAge('not-a-date', NOW)).toBe('unknown');
  });

  it('clamps a future timestamp to "0s" rather than going negative', () => {
    expect(formatAge(new Date(NOW + 5_000).toISOString(), NOW)).toBe('0s');
  });
});

describe('renderPeerRefusal', () => {
  const NOW = Date.parse('2026-01-01T00:10:00.000Z');
  const THEIRS = ['a.tex', 'b.tex', 'c.png'];

  it('starts with the exact prefix existing tests match on', () => {
    const a: Attribution = { sessions: [], unowned: [] };
    const text = renderPeerRefusal(THEIRS, a, NOW);
    expect(text.startsWith("Uncommitted changes in the shared clone are not this session's:")).toBe(
      true,
    );
  });

  it('shows owns + last write + heartbeat for a readable owning peer', () => {
    const a: Attribution = {
      sessions: [
        {
          sessionId: 'beta',
          heartbeatAt: new Date(NOW - 10_000).toISOString(),
          owns: ['a.tex', 'b.tex'],
          lastWriteAt: new Date(NOW - 42_000).toISOString(),
          unreadable: false,
        },
      ],
      unowned: ['c.png'],
    };
    const text = renderPeerRefusal(THEIRS, a, NOW);
    expect(text).toContain('"beta" owns a.tex, b.tex');
    expect(text).toContain('last write 42s ago');
    expect(text).toContain('heartbeat 10s ago');
    expect(text).toContain('No live session owns c.png');
  });

  it('shows "no write on record" when an owner has no touchedAt', () => {
    const a: Attribution = {
      sessions: [
        {
          sessionId: 'beta',
          heartbeatAt: new Date(NOW - 10_000).toISOString(),
          owns: ['a.tex'],
          lastWriteAt: null,
          unreadable: false,
        },
      ],
      unowned: [],
    };
    const text = renderPeerRefusal(['a.tex'], a, NOW);
    expect(text).toContain('no write on record');
    expect(text).not.toContain('No live session owns');
  });

  it('shows "owns nothing here" without a last-write clause for a readable non-owning peer', () => {
    const a: Attribution = {
      sessions: [
        {
          sessionId: 'gamma',
          heartbeatAt: new Date(NOW - 3 * 60_000).toISOString(),
          owns: [],
          lastWriteAt: null,
          unreadable: false,
        },
      ],
      unowned: THEIRS,
    };
    const text = renderPeerRefusal(THEIRS, a, NOW);
    expect(text).toContain('"gamma" owns nothing here');
    expect(text).toContain('heartbeat 3m ago');
  });

  it('shows the unreadable-index line for an unreadable peer', () => {
    const a: Attribution = {
      sessions: [
        {
          sessionId: 'delta',
          heartbeatAt: new Date(NOW - 5_000).toISOString(),
          owns: THEIRS,
          lastWriteAt: null,
          unreadable: true,
        },
      ],
      unowned: [],
    };
    const text = renderPeerRefusal(THEIRS, a, NOW);
    expect(text).toContain('"delta" — its change index is unreadable');
    expect(text).toContain('heartbeat 5s ago');
  });

  it('omits the "No live session owns" line entirely when unowned is empty', () => {
    const a: Attribution = {
      sessions: [
        {
          sessionId: 'beta',
          heartbeatAt: new Date(NOW - 10_000).toISOString(),
          owns: THEIRS,
          lastWriteAt: new Date(NOW - 1_000).toISOString(),
          unreadable: false,
        },
      ],
      unowned: [],
    };
    const text = renderPeerRefusal(THEIRS, a, NOW);
    expect(text).not.toContain('No live session owns');
  });

  describe('default closing, composed from the attribution', () => {
    it('peer-owned only: advises scope "all", explains why "paths" refuses, never offers "paths" for these files', () => {
      const a: Attribution = {
        sessions: [
          {
            sessionId: 'beta',
            heartbeatAt: new Date(NOW - 10_000).toISOString(),
            owns: ['a.tex', 'b.tex'],
            lastWriteAt: new Date(NOW - 42_000).toISOString(),
            unreadable: false,
          },
        ],
        unowned: [],
      };
      const text = renderPeerRefusal(['a.tex', 'b.tex'], a, NOW);
      const closing = text.split('\n').pop() as string;

      expect(closing).toContain('scope "all"');
      // Pins the *meaning* — that the route is unavailable and why — rather than one phrasing,
      // since the sentence also has to cover the unreadable-index trigger.
      expect(closing).toContain('scope "paths" is not an option');
      expect(closing).toMatch(/refuses any path a live session owns/);
      // The unowned-route sentence (naming paths for scope "paths") must not appear here — there
      // is no unowned group in this shape.
      expect(closing).not.toContain('preferable to scope "all"');
    });

    it('unowned only: advises scope "paths" naming the paths, and does not push the caller to scope "all"', () => {
      const a: Attribution = {
        sessions: [
          {
            sessionId: 'gamma',
            heartbeatAt: new Date(NOW - 10_000).toISOString(),
            owns: [],
            lastWriteAt: null,
            unreadable: false,
          },
        ],
        unowned: ['notes.txt', 'draft.tex'],
      };
      const text = renderPeerRefusal(['notes.txt', 'draft.tex'], a, NOW);
      const closing = text.split('\n').pop() as string;

      expect(closing).toContain('scope "paths"');
      expect(closing).toContain('notes.txt, draft.tex');
      expect(closing).toContain('preferable to scope "all"');
      // Never *advises* taking scope "all" for this group.
      expect(closing).not.toContain('requires committing with scope "all"');
      // Plural group reads as plural — the list is built from a variable-length path set, so the
      // agreement has to follow it rather than being fixed at whichever case was written first.
      expect(closing).toContain('on their own');
      expect(closing).toContain('naming just those paths');
      expect(closing).not.toContain('on its own');
    });

    it('unowned, exactly one path: the advice reads as singular', () => {
      const a: Attribution = {
        sessions: [
          {
            sessionId: 'gamma',
            heartbeatAt: new Date(NOW - 10_000).toISOString(),
            owns: [],
            lastWriteAt: null,
            unreadable: false,
          },
        ],
        unowned: ['notes.txt'],
      };
      const closing = renderPeerRefusal(['notes.txt'], a, NOW).split('\n').pop() as string;

      expect(closing).toContain('on its own');
      expect(closing).toContain('naming just that path');
      expect(closing).not.toContain('on their own');
    });

    it('both groups present: each gets its own route, tied to its own group', () => {
      const a: Attribution = {
        sessions: [
          {
            sessionId: 'beta',
            heartbeatAt: new Date(NOW - 10_000).toISOString(),
            owns: ['a.tex'],
            lastWriteAt: new Date(NOW - 42_000).toISOString(),
            unreadable: false,
          },
        ],
        unowned: ['notes.txt'],
      };
      const text = renderPeerRefusal(['a.tex', 'notes.txt'], a, NOW);
      const closing = text.split('\n').pop() as string;

      expect(closing).toContain('requires committing with scope "all"');
      // Pins the *meaning* — that the route is unavailable and why — rather than one phrasing,
      // since the sentence also has to cover the unreadable-index trigger.
      expect(closing).toContain('scope "paths" is not an option');
      expect(closing).toMatch(/refuses any path a live session owns/);
      expect(closing).toContain('notes.txt');
      expect(closing).toContain('scope "paths"');
      expect(closing).toContain('preferable to scope "all"');
    });

    it('an unreadable peer is treated as peer-owned: advises scope "all", never scope "paths" as a route', () => {
      const a: Attribution = {
        sessions: [
          {
            sessionId: 'delta',
            heartbeatAt: new Date(NOW - 5_000).toISOString(),
            owns: THEIRS,
            lastWriteAt: null,
            unreadable: true,
          },
        ],
        unowned: [],
      };
      const text = renderPeerRefusal(THEIRS, a, NOW);
      const closing = text.split('\n').pop() as string;

      expect(closing).toContain('scope "all"');
      // Pins the *meaning* — that the route is unavailable and why — rather than one phrasing,
      // since the sentence also has to cover the unreadable-index trigger.
      expect(closing).toContain('scope "paths" is not an option');
      expect(closing).toMatch(/refuses any path a live session owns/);
      expect(closing).not.toContain('preferable to scope "all"');
    });

    it('an explicit closing argument still overrides everything, even with peer-owned files present', () => {
      const a: Attribution = {
        sessions: [
          {
            sessionId: 'beta',
            heartbeatAt: new Date(NOW - 10_000).toISOString(),
            owns: ['a.tex'],
            lastWriteAt: new Date(NOW - 42_000).toISOString(),
            unreadable: false,
          },
        ],
        unowned: [],
      };
      const text = renderPeerRefusal(['a.tex'], a, NOW, 'CUSTOM CLOSING TEXT');
      expect(text.split('\n').pop()).toBe('CUSTOM CLOSING TEXT');
      expect(text).not.toContain('scope "all"');
    });

    it('caps the unowned path list in the closing at the boundary', () => {
      const paths = Array.from({ length: 20 }, (_, i) => `f${i}.tex`);
      const a: Attribution = { sessions: [], unowned: paths };
      const text = renderPeerRefusal(paths, a, NOW);
      const closing = text.split('\n').pop() as string;
      expect(closing).toContain(paths.join(', '));
      expect(closing).not.toContain('more');
    });

    it('caps the unowned path list in the closing one over the boundary', () => {
      const paths = Array.from({ length: 21 }, (_, i) => `f${i}.tex`);
      const a: Attribution = { sessions: [], unowned: paths };
      const text = renderPeerRefusal(paths, a, NOW);
      const closing = text.split('\n').pop() as string;
      expect(closing).toContain(paths.slice(0, 20).join(', '));
      expect(closing).toContain('1 more');
      expect(closing).not.toContain(paths[20] as string);
    });
  });

  describe('capping the header, owns and "No live session owns" lists', () => {
    const headerLine = (text: string): string => text.split('\n')[0] as string;
    const ownsLine = (text: string): string =>
      text.split('\n').find((l) => l.includes('" owns ') && !l.includes('owns nothing')) as string;
    const noneOwnLine = (text: string): string =>
      text.split('\n').find((l) => l.startsWith('No live session owns')) as string;

    it('header "theirs" at the boundary (20): all present, no "more"', () => {
      const paths = Array.from({ length: REFUSAL_PATH_CAP }, (_, i) => `h${i}.tex`);
      const a: Attribution = { sessions: [], unowned: [] };
      const text = renderPeerRefusal(paths, a, NOW);
      const header = headerLine(text);
      for (const p of paths) expect(header).toContain(p);
      expect(header).not.toContain('more');
    });

    it('header "theirs" one over the boundary (21): first 20 present, "1 more" present, 21st absent', () => {
      const paths = Array.from({ length: REFUSAL_PATH_CAP + 1 }, (_, i) => `h${i}.tex`);
      const a: Attribution = { sessions: [], unowned: [] };
      const text = renderPeerRefusal(paths, a, NOW);
      const header = headerLine(text);
      for (const p of paths.slice(0, REFUSAL_PATH_CAP)) expect(header).toContain(p);
      expect(header).toContain('1 more');
      expect(header).not.toContain(paths[REFUSAL_PATH_CAP] as string);
    });

    it('a readable owning peer\'s "owns" at the boundary (20): all present, no "more"', () => {
      const paths = Array.from({ length: REFUSAL_PATH_CAP }, (_, i) => `o${i}.tex`);
      const a: Attribution = {
        sessions: [
          {
            sessionId: 'beta',
            heartbeatAt: new Date(NOW - 10_000).toISOString(),
            owns: paths,
            lastWriteAt: new Date(NOW - 5_000).toISOString(),
            unreadable: false,
          },
        ],
        unowned: [],
      };
      const text = renderPeerRefusal(paths, a, NOW);
      const line = ownsLine(text);
      for (const p of paths) expect(line).toContain(p);
      expect(line).not.toContain('more');
    });

    it('a readable owning peer\'s "owns" one over the boundary (21): first 20 present, "1 more", 21st absent', () => {
      const paths = Array.from({ length: REFUSAL_PATH_CAP + 1 }, (_, i) => `o${i}.tex`);
      const a: Attribution = {
        sessions: [
          {
            sessionId: 'beta',
            heartbeatAt: new Date(NOW - 10_000).toISOString(),
            owns: paths,
            lastWriteAt: new Date(NOW - 5_000).toISOString(),
            unreadable: false,
          },
        ],
        unowned: [],
      };
      const text = renderPeerRefusal(paths, a, NOW);
      const line = ownsLine(text);
      for (const p of paths.slice(0, REFUSAL_PATH_CAP)) expect(line).toContain(p);
      expect(line).toContain('1 more');
      expect(line).not.toContain(paths[REFUSAL_PATH_CAP] as string);
    });

    it('the "No live session owns" line at the boundary (20): all present, no "more"', () => {
      const paths = Array.from({ length: REFUSAL_PATH_CAP }, (_, i) => `u${i}.tex`);
      const a: Attribution = { sessions: [], unowned: paths };
      const text = renderPeerRefusal(paths, a, NOW);
      const line = noneOwnLine(text);
      for (const p of paths) expect(line).toContain(p);
      expect(line).not.toContain('more');
    });

    it('the "No live session owns" line one over the boundary (21): first 20, "1 more", 21st absent', () => {
      const paths = Array.from({ length: REFUSAL_PATH_CAP + 1 }, (_, i) => `u${i}.tex`);
      const a: Attribution = { sessions: [], unowned: paths };
      const text = renderPeerRefusal(paths, a, NOW);
      const line = noneOwnLine(text);
      for (const p of paths.slice(0, REFUSAL_PATH_CAP)) expect(line).toContain(p);
      expect(line).toContain('1 more');
      expect(line).not.toContain(paths[REFUSAL_PATH_CAP] as string);
    });
  });

  describe('the pointer line to `status` for the complete lists', () => {
    it('renders when a list truncated, naming status, otherChanges and activeSessions[].changes', () => {
      const paths = Array.from({ length: REFUSAL_PATH_CAP + 1 }, (_, i) => `u${i}.tex`);
      const a: Attribution = { sessions: [], unowned: paths };
      const text = renderPeerRefusal(paths, a, NOW);
      expect(text).toContain('capped at 20 paths');
      expect(text).toContain('`status`');
      expect(text).toContain('`otherChanges`');
      expect(text).toContain('`activeSessions[].changes`');
    });

    // The three assertions below pin the *content* of the pointer, not merely that some pointer
    // rendered. Every field name it mentions was also in the dead-ending wording this line
    // replaced ("`otherChanges` for every file above"), so asserting those alone would let that
    // regression back in green. What must not come back is the claim that `status` reports these
    // very lists (true only for push), and the omission of the subtraction that turns
    // `otherChanges` into the unowned set.
    it('claims only that `status` names the omitted paths, never that it reports these lists', () => {
      const paths = Array.from({ length: REFUSAL_PATH_CAP + 1 }, (_, i) => `u${i}.tex`);
      const a: Attribution = { sessions: [], unowned: paths };
      const pointer = renderPeerRefusal(paths, a, NOW)
        .split('\n')
        .find((l) => l.startsWith('Lists here are capped')) as string;
      expect(pointer).toContain('covers the same ground more fully');
      expect(pointer).toContain('a superset of the files named here');
      expect(pointer).not.toContain('reports them whole');
      expect(pointer).not.toContain('above');
    });

    // Issue #185: the line used to say `status` "names every path they omit, uncapped", which #175
    // falsified by budgeting `otherChanges` and capping `activeSessions`. The claim of
    // completeness is what must never come back — a *stuck* caller reads this line and nothing
    // else. The behavioural half of this (that those lists really are cut, and that the counters
    // named here are the ones that ship) lives in `test/unit/statusPointerClaim.test.ts`; this is
    // only the wording guard.
    it('never claims those `status` lists are uncapped or complete', () => {
      const paths = Array.from({ length: REFUSAL_PATH_CAP + 1 }, (_, i) => `u${i}.tex`);
      const a: Attribution = { sessions: [], unowned: paths };
      const pointer = renderPeerRefusal(paths, a, NOW)
        .split('\n')
        .find((l) => l.startsWith('Lists here are capped')) as string;
      expect(pointer).not.toMatch(/uncapped/i);
      expect(pointer).not.toMatch(/names every path/i);
      expect(pointer).not.toMatch(/\bin full\b/i);
    });

    it('spells out the subtraction that yields the unowned set, and the null-claims-everything rule', () => {
      const paths = Array.from({ length: REFUSAL_PATH_CAP + 1 }, (_, i) => `u${i}.tex`);
      const a: Attribution = { sessions: [], unowned: paths };
      const pointer = renderPeerRefusal(paths, a, NOW)
        .split('\n')
        .find((l) => l.startsWith('Lists here are capped')) as string;
      expect(pointer).toContain("Subtract every live session's `changes` from `otherChanges`");
      expect(pointer).toContain('`changes` is null may own any of them');
    });

    // `unowned` being empty is the ordinary shape when one peer owns the whole dirty tree, and
    // every other pointer-present test here happens to carry a non-empty `unowned` — so without
    // this, gating the pointer on `a.unowned.length > 0` would cut it from that shape unnoticed.
    it('renders when only the header truncated and nothing is unowned', () => {
      const paths = Array.from({ length: 30 }, (_, i) => `p${i}.tex`);
      const a: Attribution = {
        sessions: [
          {
            sessionId: 'beta',
            heartbeatAt: new Date(NOW - 10_000).toISOString(),
            owns: paths,
            lastWriteAt: new Date(NOW - 5_000).toISOString(),
            unreadable: false,
          },
        ],
        unowned: [],
      };
      const text = renderPeerRefusal(paths, a, NOW);
      expect(text).not.toContain('No live session owns');
      expect(text).toContain('Lists here are capped at 20 paths');
    });

    // Makes the hand-built-Attribution defence real rather than asserted in a comment: `owns` is
    // always a subset of `theirs` for anything `attributePeers` builds, so this shape is only
    // reachable by constructing the Attribution directly — which is exactly what the two
    // otherwise-dead `truncated` setters in renderPeerRefusal exist to cover.
    it('renders for a hand-built Attribution whose owns exceeds the cap while theirs does not', () => {
      const owns = Array.from({ length: REFUSAL_PATH_CAP + 1 }, (_, i) => `o${i}.tex`);
      const a: Attribution = {
        sessions: [
          {
            sessionId: 'beta',
            heartbeatAt: new Date(NOW - 10_000).toISOString(),
            owns,
            lastWriteAt: new Date(NOW - 5_000).toISOString(),
            unreadable: false,
          },
        ],
        unowned: [],
      };
      const text = renderPeerRefusal(['a.tex'], a, NOW);
      expect(text).toContain('Lists here are capped at 20 paths');
    });

    it('is absent for a small everyday refusal (2-3 paths)', () => {
      const a: Attribution = { sessions: [], unowned: ['a.tex', 'b.tex'] };
      const text = renderPeerRefusal(['a.tex', 'b.tex'], a, NOW);
      expect(text).not.toContain('capped at');
      expect(text).not.toContain('`status`');
    });

    it('is absent at the exactly-20 boundary across header and "No live session owns"', () => {
      const paths = Array.from({ length: REFUSAL_PATH_CAP }, (_, i) => `b${i}.tex`);
      const a: Attribution = { sessions: [], unowned: paths };
      const text = renderPeerRefusal(paths, a, NOW);
      expect(text).not.toContain('capped at');
      expect(text).not.toContain('`status`');
    });

    it('the closing remains the last line even when the pointer renders', () => {
      const paths = Array.from({ length: REFUSAL_PATH_CAP + 1 }, (_, i) => `u${i}.tex`);
      const a: Attribution = { sessions: [], unowned: paths };
      const text = renderPeerRefusal(paths, a, NOW, 'CUSTOM CLOSING TEXT');
      expect(text).toContain('capped at 20 paths');
      expect(text.split('\n').pop()).toBe('CUSTOM CLOSING TEXT');
    });

    it('the pointer sits after the body (below "No live session owns") and above the closing — not merely present anywhere', () => {
      const paths = Array.from({ length: REFUSAL_PATH_CAP + 1 }, (_, i) => `u${i}.tex`);
      const a: Attribution = { sessions: [], unowned: paths };
      const text = renderPeerRefusal(paths, a, NOW, 'CUSTOM CLOSING TEXT');
      const lines = text.split('\n');
      const noneOwnIdx = lines.findIndex((l) => l.startsWith('No live session owns'));
      const pointerIdx = lines.findIndex((l) => l.includes('capped at 20 paths'));
      expect(noneOwnIdx).toBeGreaterThanOrEqual(0);
      expect(pointerIdx).toBeGreaterThan(noneOwnIdx);
      expect(pointerIdx).toBeLessThan(lines.length - 1);
    });

    // The header-length setter (`theirs.length > REFUSAL_PATH_CAP`) is the only `truncated` setter
    // any real `attributePeers` output can trip in production — the two later setters, on an
    // individual session's `owns` and on `unowned`, are documented as unreachable there because
    // both lists are always subsets of `theirs`, so either one exceeding the cap already implies
    // `theirs` does too. Every other test in this file that exercises the pointer builds an
    // Attribution (by hand or via `attributePeers`) whose `owns` or `unowned` ALSO exceeds the cap,
    // so it can't tell the header-length setter apart from the two "unreachable" ones — a mutant
    // that stubs `truncated` to `false` still passes every one of them. This test isolates the
    // header-only case: 21 total disputed paths, split via the real `attributePeers` so two peers
    // own exactly 10 each and one path is unowned — every per-list count stays at or under the cap
    // (10, 10, 1), so only `theirs.length` (21) exceeds it.
    it('renders the pointer for a real attributePeers split whose theirs exceeds the cap but every per-list count does not', () => {
      const owned1 = Array.from({ length: 10 }, (_, i) => `o1-${i}.tex`);
      const owned2 = Array.from({ length: 10 }, (_, i) => `o2-${i}.tex`);
      const theirs = [...owned1, ...owned2, 'unowned.tex'];
      expect(theirs.length).toBe(21);

      const peers = [
        { sessionId: 'beta', heartbeatAt: new Date(NOW - 10_000).toISOString() },
        { sessionId: 'gamma', heartbeatAt: new Date(NOW - 20_000).toISOString() },
      ];
      const entries = new Map<string, PeerShadowEntry[] | null>([
        ['beta', owned1.map((p) => entry(p))],
        ['gamma', owned2.map((p) => entry(p))],
      ]);

      const a = attributePeers(theirs, peers, entries);
      // Sanity: every per-list count is at or under the cap — only theirs.length trips it.
      for (const s of a.sessions) expect(s.owns.length).toBeLessThanOrEqual(REFUSAL_PATH_CAP);
      expect(a.unowned.length).toBeLessThanOrEqual(REFUSAL_PATH_CAP);
      expect(a.unowned).toEqual(['unowned.tex']);

      const text = renderPeerRefusal(theirs, a, NOW);
      const lines = text.split('\n');
      const header = lines[0] as string;

      expect(header.endsWith(', … 1 more.')).toBe(true);
      expect(text).toContain('Lists here are capped at 20 paths');
    });
  });

  it('renders the realistic refusal shape: an owning peer AND a non-empty unowned set, both over the cap', () => {
    // 25 peer-owned + 30 unowned = 55 in theirs, so the header, the owns line, the "No live
    // session owns" line, and the closing's own unowned copy all truncate — the shape fix 1's
    // pointer text has to actually cover, not the sessions:[] shapes the other cap tests use.
    const owned = Array.from({ length: 25 }, (_, i) => `o${i}.tex`);
    const unowned = Array.from({ length: 30 }, (_, i) => `u${i}.tex`);
    const theirs = [...owned, ...unowned];
    const a: Attribution = {
      sessions: [
        {
          sessionId: 'beta',
          heartbeatAt: new Date(NOW - 10_000).toISOString(),
          owns: owned,
          lastWriteAt: new Date(NOW - 5_000).toISOString(),
          unreadable: false,
        },
      ],
      unowned,
    };
    const text = renderPeerRefusal(theirs, a, NOW);
    const lines = text.split('\n');
    const header = lines[0] as string;
    const ownsLine = lines.find((l) => l.includes('"beta" owns')) as string;
    const noneOwnLine = lines.find((l) => l.startsWith('No live session owns')) as string;
    const pointerLines = lines.filter((l) => l.includes('capped at 20 paths'));
    const closing = lines[lines.length - 1] as string;

    // header (theirs.length === 55) truncates
    expect(header).toContain('35 more');
    // owns (25) truncates
    expect(ownsLine).toContain('5 more');
    // unowned (30) truncates
    expect(noneOwnLine).toContain('10 more');
    // the pointer renders exactly once
    expect(pointerLines.length).toBe(1);
    // the closing stays last, and its own (30-path) unowned copy visibly signals it is partial
    // too — it must not silently drop paths with no "more" marker.
    expect(closing).toContain('10 more');
    expect(lines.indexOf(closing)).toBe(lines.length - 1);
  });

  it('an unreadable peer with 100 disputed paths still renders its line with no path list and no "more"', () => {
    const paths = Array.from({ length: 100 }, (_, i) => `p${i}.tex`);
    const a: Attribution = {
      sessions: [
        {
          sessionId: 'delta',
          heartbeatAt: new Date(NOW - 5_000).toISOString(),
          owns: paths,
          lastWriteAt: null,
          unreadable: true,
        },
      ],
      unowned: [],
    };
    const text = renderPeerRefusal(paths, a, NOW);
    const line = text
      .split('\n')
      .find((l) => l.includes('its change index is unreadable')) as string;
    expect(line).toContain('"delta" — its change index is unreadable');
    expect(line).not.toContain('more');
    // No path is echoed on this line — it may own anything, not "these specific files".
    expect(line).not.toContain('p50.tex');
  });
});

describe('composeClosing retracts discard for peer-owned files', () => {
  // `commit scope: "paths"` refuses a peer-owned path outright, so the closing's `ownedAdvice`
  // already corrects the typed `LocalChangesOverwriteError`'s "commit scope: paths, OR discard"
  // prescription for the commit half. Nothing retracted the discard half: `discard` has no
  // ownership guard at all, so a caller following the typed message's "discard, paths: [...]"
  // over a live peer's owned file would destroy that peer's uncommitted work.
  const NOW = Date.parse('2026-01-01T00:10:00.000Z');

  const readableOwner: Attribution = {
    sessions: [
      {
        sessionId: 'beta',
        heartbeatAt: new Date(NOW - 10_000).toISOString(),
        owns: ['a.tex'],
        lastWriteAt: new Date(NOW - 42_000).toISOString(),
        unreadable: false,
      },
    ],
    unowned: [],
  };

  const unreadablePeer: Attribution = {
    sessions: [
      {
        sessionId: 'delta',
        heartbeatAt: new Date(NOW - 5_000).toISOString(),
        owns: ['a.tex'],
        lastWriteAt: null,
        unreadable: true,
      },
    ],
    unowned: [],
  };

  const mixed: Attribution = {
    sessions: [
      {
        sessionId: 'beta',
        heartbeatAt: new Date(NOW - 10_000).toISOString(),
        owns: ['a.tex'],
        lastWriteAt: new Date(NOW - 42_000).toISOString(),
        unreadable: false,
      },
    ],
    unowned: ['notes.txt'],
  };

  const unownedOnly: Attribution = { sessions: [], unowned: ['notes.txt'] };

  it('retracts discard when a readable peer owns a file', () => {
    const closing = composeClosing(readableOwner, PUSH_VOCABULARY);
    expect(closing).toContain('`discard`');
    expect(closing).toMatch(/no ownership guard/);
  });

  it('retracts discard when the owning peer is unreadable', () => {
    const closing = composeClosing(unreadablePeer, PUSH_VOCABULARY);
    expect(closing).toContain('`discard`');
    expect(closing).toMatch(/no ownership guard/);
  });

  it('retracts discard for the owned group of a mixed owned+unowned closing', () => {
    const closing = composeClosing(mixed, PUSH_VOCABULARY);
    expect(closing).toContain('`discard`');
    expect(closing).toMatch(/no ownership guard/);
  });

  it('says nothing about discard when only unowned files are present', () => {
    const closing = composeClosing(unownedOnly, PUSH_VOCABULARY);
    expect(closing).not.toContain('discard');
  });
});

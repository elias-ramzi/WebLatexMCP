import { describe, it, expect } from 'vitest';
import {
  attributePeers,
  formatAge,
  renderPeerRefusal,
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
});

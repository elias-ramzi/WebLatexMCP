import { describe, it, expect } from 'vitest';
import {
  ReferenceResolver,
  ReferenceSourceUnavailableError,
  NoCanonicalBibtexError,
  DEFAULT_SOURCE_ORDER,
  type ReferenceBackends,
} from '../../src/services/referenceResolver.js';
import { BackendUnavailableError } from '../../src/services/referenceBackend.js';
import type { ReferenceHit } from '../../src/services/referenceBackend.js';
import { DblpService } from '../../src/services/dblp.js';
import { CrossrefService } from '../../src/services/crossref.js';
import { OpenAlexService } from '../../src/services/openalex.js';

function hit(source: string, key: string): ReferenceHit {
  return { key, source, title: `title from ${source}`, authors: ['A. One'] };
}

/** Records which backends were actually consulted, so "did it fall through?" is observable. */
interface Spy {
  backends: ReferenceBackends;
  calls: string[];
}

interface Behaviour {
  /** Hits to return, an error to throw, or [] for a well-formed empty answer. */
  search?: ReferenceHit[] | Error;
  bibtex?: string | Error;
  doi?: string | null | Error;
}

function spy(plan: Partial<Record<'dblp' | 'crossref' | 'openalex', Behaviour>>): Spy {
  const calls: string[] = [];
  const give = <T>(what: T | Error): Promise<T> =>
    what instanceof Error ? Promise.reject(what) : Promise.resolve(what);

  const search = (id: string) => (_q: string) => {
    calls.push(`${id}.search`);
    return give(plan[id as keyof typeof plan]?.search ?? []);
  };
  const fetchBibtex = (id: string) => (_k: string) => {
    calls.push(`${id}.fetchBibtex`);
    return give(plan[id as keyof typeof plan]?.bibtex ?? '@misc{x,}');
  };

  return {
    calls,
    backends: {
      dblp: { search: search('dblp'), fetchBibtex: fetchBibtex('dblp') },
      crossref: { search: search('crossref'), fetchBibtex: fetchBibtex('crossref') },
      openalex: {
        search: search('openalex'),
        resolveDoi: (_k: string) => {
          calls.push('openalex.resolveDoi');
          const d = plan.openalex?.doi;
          return d instanceof Error ? Promise.reject(d) : Promise.resolve(d ?? null);
        },
      },
    },
  };
}

const down = (b: string) => new BackendUnavailableError(b, `${b} is behind a bot wall.`);

describe('ReferenceResolver.search — unpinned (the default may be substituted)', () => {
  it('tries DBLP first and does not consult anyone else when it answers', async () => {
    const s = spy({ dblp: { search: [hit('dblp', 'dblp:conf/x/y')] } });
    const out = await new ReferenceResolver(s.backends).search('resnet');

    expect(out.source).toBe('dblp');
    expect(out.fallbackFrom).toBeUndefined();
    expect(out.note).toBeUndefined();
    expect(s.calls).toEqual(['dblp.search']);
  });

  it('substitutes the next backend when one cannot answer, and says so', async () => {
    const s = spy({
      dblp: { search: down('DBLP') },
      crossref: { search: [hit('crossref', 'crossref:10.1/x')] },
    });
    const out = await new ReferenceResolver(s.backends).search('resnet');

    expect(out.source).toBe('crossref');
    expect(out.fallbackFrom).toBe('dblp');
    // Reported, never silent: the caller must be able to tell which bibliography answered.
    expect(out.note).toMatch(/dblp could not be reached/);
    expect(out.note).toMatch(/bot wall/);
    expect(s.calls).toEqual(['dblp.search', 'crossref.search']);
  });

  it('ZERO RESULTS IS AN ANSWER — it never falls through to another backend', async () => {
    // The distinction the whole design rests on. Falling through here would turn "DBLP has
    // never heard of this" into "here is what Crossref found instead" — a different claim.
    const s = spy({ dblp: { search: [] }, crossref: { search: [hit('crossref', 'c:1')] } });
    const out = await new ReferenceResolver(s.backends).search('nothing at all');

    expect(out.hits).toEqual([]);
    expect(out.source).toBe('dblp');
    expect(out.fallbackFrom).toBeUndefined();
    expect(s.calls).toEqual(['dblp.search']);
  });

  it('names EVERY failure on the way, not just the first', async () => {
    // Two down, third answers. A first-failure-only note drops the rate limit — the one detail
    // that changes what the caller should do next.
    const s = spy({
      dblp: { search: down('DBLP') },
      crossref: {
        search: new BackendUnavailableError('Crossref', 'Crossref rate-limits its API.'),
      },
      openalex: { search: [hit('openalex', 'openalex:W1')] },
    });
    const out = await new ReferenceResolver(s.backends).search('x');

    expect(out.source).toBe('openalex');
    expect(out.fallbackFrom).toBe('dblp');
    expect(out.note).toMatch(/dblp and crossref could not be reached/);
    expect(out.note).toMatch(/bot wall/);
    expect(out.note).toMatch(/rate-limits/);
  });

  it('walks the whole order, and reports every failure when none can answer', async () => {
    const s = spy({
      dblp: { search: down('DBLP') },
      crossref: { search: down('Crossref') },
      openalex: { search: down('OpenAlex') },
    });
    const resolver = new ReferenceResolver(s.backends);

    await expect(resolver.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(resolver.search('x')).rejects.toThrow(/No reference backend could be reached/);
    await expect(resolver.search('x')).rejects.toThrow(/dblp:.*crossref:.*openalex:/s);
  });

  it('does NOT substitute on a caller error — every backend would reject it alike', async () => {
    // The value just outside the fallback guard: a plain Error is not a backend being down.
    const s = spy({ dblp: { search: new Error('Search query must not be empty.') } });
    const resolver = new ReferenceResolver(s.backends);

    await expect(resolver.search('  ')).rejects.toThrow(/must not be empty/);
    expect(s.calls).toEqual(['dblp.search']);
  });

  it('a configured source with `explicit` OMITTED still allows substitution', async () => {
    // The real "assertion, never an inference" case, and the one a `!== false` default would
    // silently break: a source arriving with no `explicit` flag at all was nobody's choice, so
    // it must not disable the fallback that keeps the tool working while a backend is down.
    const s = spy({
      dblp: { search: down('DBLP') },
      crossref: { search: [hit('crossref', 'c:1')] },
    });
    const out = await new ReferenceResolver(s.backends, { source: 'dblp' }).search('x');

    expect(out.source).toBe('crossref');
    expect(out.fallbackFrom).toBe('dblp');
    expect(s.calls).toEqual(['dblp.search', 'crossref.search']);
  });

  it('a configured source that is NOT explicit still allows substitution', async () => {
    // An assertion, never an inference: a value arriving without `explicit` was nobody's choice.
    const s = spy({
      dblp: { search: down('DBLP') },
      crossref: { search: [hit('crossref', 'c:1')] },
    });
    const out = await new ReferenceResolver(s.backends, {
      source: 'dblp',
      explicit: false,
    }).search('x');

    expect(out.source).toBe('crossref');
    expect(out.fallbackFrom).toBe('dblp');
  });
});

describe('ReferenceResolver.search — with REAL backends over a rejecting fetch', () => {
  it('falls through a backend whose network call rejects', async () => {
    // End to end over the real client classes, not hand-built errors: the resolver's fallback was
    // only ever exercised against fixtures that were already BackendUnavailableError, so a raw
    // transport rejection — the likeliest real failure — aborted the chain undetected.
    const dead = () => Promise.reject(new TypeError('fetch failed'));
    const alive = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({ message: { items: [{ DOI: '10.1/x', title: ['T'], author: [] }] } }),
        json: async () => ({}),
      });

    const out = await new ReferenceResolver({
      dblp: new DblpService(dead),
      crossref: new CrossrefService(alive),
      openalex: new OpenAlexService(dead),
    }).search('resnet');

    expect(out.source).toBe('crossref');
    expect(out.fallbackFrom).toBe('dblp');
    expect(out.note).toMatch(/could not be reached/);
    expect(out.hits[0]?.key).toBe('crossref:10.1/x');
  });
});

describe('ReferenceResolver.search — pinned (an assertion is never substituted)', () => {
  it('runs only the env-pinned backend and errors rather than substituting', async () => {
    const s = spy({
      dblp: { search: down('DBLP') },
      crossref: { search: [hit('crossref', 'c:1')] },
    });
    const resolver = new ReferenceResolver(s.backends, { source: 'dblp', explicit: true });

    await expect(resolver.search('x')).rejects.toBeInstanceOf(ReferenceSourceUnavailableError);
    await expect(resolver.search('x')).rejects.toThrow(/WEB_LATEX_MCP_REFERENCE_SOURCE names dblp/);
    // Names both routes out.
    await expect(resolver.search('x')).rejects.toThrow(/source: "crossref" or "openalex"/);
    await expect(resolver.search('x')).rejects.toThrow(/unset WEB_LATEX_MCP_REFERENCE_SOURCE/);
    expect(s.calls).toEqual(['dblp.search', 'dblp.search', 'dblp.search', 'dblp.search']);
  });

  it('a per-call source wins over the configured one, and is always an assertion', async () => {
    const s = spy({
      dblp: { search: [hit('dblp', 'd:1')] },
      openalex: { search: down('OpenAlex') },
    });
    const resolver = new ReferenceResolver(s.backends, { source: 'dblp', explicit: true });

    await expect(resolver.search('x', { source: 'openalex' })).rejects.toThrow(
      /source: "openalex" was requested/,
    );
    expect(s.calls).toEqual(['openalex.search']);
  });

  it('a per-call source pins even when nothing was configured', async () => {
    const s = spy({ crossref: { search: down('Crossref') } });
    const resolver = new ReferenceResolver(s.backends);

    await expect(resolver.search('x', { source: 'crossref' })).rejects.toBeInstanceOf(
      ReferenceSourceUnavailableError,
    );
    await expect(resolver.search('x', { source: 'crossref' })).rejects.toThrow(/omit source:/);
    expect(s.calls).toEqual(['crossref.search', 'crossref.search']);
  });

  it('returns a pinned backend’s answer with no fallback metadata', async () => {
    const s = spy({ openalex: { search: [hit('openalex', 'openalex:W1')] } });
    const out = await new ReferenceResolver(s.backends).search('x', { source: 'openalex' });

    expect(out.source).toBe('openalex');
    expect(out.fallbackFrom).toBeUndefined();
    expect(out.note).toBeUndefined();
  });
});

describe('ReferenceResolver.fetchBibtex — routed by the key, never by config', () => {
  it('sends a dblp key to DBLP and a crossref key to Crossref', async () => {
    const s = spy({ dblp: { bibtex: '@inproceedings{d,}' }, crossref: { bibtex: '@article{c,}' } });
    const resolver = new ReferenceResolver(s.backends);

    expect(await resolver.fetchBibtex('dblp:conf/cvpr/HeZRS16')).toEqual({
      bibtex: '@inproceedings{d,}',
      source: 'dblp',
    });
    expect(await resolver.fetchBibtex('crossref:10.1109/CVPR.2016.90')).toEqual({
      bibtex: '@article{c,}',
      source: 'crossref',
    });
  });

  it('routes by the key even when the config pins a DIFFERENT backend', async () => {
    // A key carries its own provenance; the configured source governs search, not fetching a
    // record someone already found.
    const s = spy({ crossref: { bibtex: '@article{c,}' } });
    const resolver = new ReferenceResolver(s.backends, { source: 'dblp', explicit: true });

    const out = await resolver.fetchBibtex('crossref:10.1109/CVPR.2016.90');
    expect(out.source).toBe('crossref');
    expect(s.calls).toEqual(['crossref.fetchBibtex']);
  });

  it('bridges an OpenAlex record to Crossref by its DOI, and reports the hop', async () => {
    const s = spy({
      openalex: { doi: '10.1109/cvpr.2016.90' },
      crossref: { bibtex: '@inproceedings{He_2016,}' },
    });
    const out = await new ReferenceResolver(s.backends).fetchBibtex('openalex:W2194775991');

    expect(out).toEqual({
      bibtex: '@inproceedings{He_2016,}',
      source: 'openalex',
      via: 'crossref',
    });
    expect(s.calls).toEqual(['openalex.resolveDoi', 'crossref.fetchBibtex']);
  });

  it('REFUSES an OpenAlex record with no DOI rather than synthesizing an entry', async () => {
    // The user's explicit choice: no DOI means no canonical BibTeX exists, and the server never
    // assembles one. Crossref must not be consulted at all.
    const s = spy({ openalex: { doi: null } });
    const resolver = new ReferenceResolver(s.backends);

    await expect(resolver.fetchBibtex('openalex:W1')).rejects.toBeInstanceOf(
      NoCanonicalBibtexError,
    );
    await expect(resolver.fetchBibtex('openalex:W1')).rejects.toThrow(/carries no DOI/);
    await expect(resolver.fetchBibtex('openalex:W1')).rejects.toThrow(/confirmBibEdit/);
    expect(s.calls).not.toContain('crossref.fetchBibtex');
  });

  it('a no-DOI refusal is NOT a backend failure — it must not read as substitutable', async () => {
    const s = spy({ openalex: { doi: null } });
    await expect(
      new ReferenceResolver(s.backends).fetchBibtex('openalex:W1'),
    ).rejects.not.toBeInstanceOf(BackendUnavailableError);
  });

  it('rejects a traversal key before consulting any backend', async () => {
    const s = spy({});
    await expect(
      new ReferenceResolver(s.backends).fetchBibtex('../../etc/passwd'),
    ).rejects.toThrow();
    expect(s.calls).toEqual([]);
  });

  it('never substitutes a backend for a fetch — a key names exactly one record', async () => {
    const s = spy({ dblp: { bibtex: down('DBLP') }, crossref: { bibtex: '@article{c,}' } });
    const resolver = new ReferenceResolver(s.backends);

    await expect(resolver.fetchBibtex('dblp:conf/x/y')).rejects.toBeInstanceOf(
      BackendUnavailableError,
    );
    expect(s.calls).toEqual(['dblp.fetchBibtex']);
  });
});

describe('DEFAULT_SOURCE_ORDER', () => {
  it('covers every source exactly once, so no backend is unreachable by default', () => {
    expect([...DEFAULT_SOURCE_ORDER].sort()).toEqual(['crossref', 'dblp', 'openalex']);
  });
});

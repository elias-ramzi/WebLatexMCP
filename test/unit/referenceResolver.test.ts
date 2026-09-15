import { describe, it, expect } from 'vitest';
import {
  ReferenceResolver,
  ReferenceSourceUnavailableError,
  ReferenceSourceInvalidError,
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
      crossref: { search: [hit('crossref', 'crossref:10.1234/x')] },
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
    //
    // Deliberately `openalex`, NOT `dblp`. Both earlier spellings of this test used `dblp`, which
    // is DEFAULT_SOURCE_ORDER[0] — so they passed identically whether the configured source was
    // preferred or ignored outright, and pinned neither. A non-default id is the only value that
    // can tell the two apart.
    const s = spy({
      openalex: { search: down('OpenAlex') },
      dblp: { search: [hit('dblp', 'd:1')] },
    });
    const out = await new ReferenceResolver(s.backends, { source: 'openalex' }).search('x');

    expect(out.source).toBe('dblp');
    expect(out.fallbackFrom).toBe('openalex');
    // Tried FIRST despite sitting last in DEFAULT_SOURCE_ORDER, then substituted: the compiler
    // analogue exactly — an unchosen default is still the backend that runs, just a replaceable one.
    expect(s.calls).toEqual(['openalex.search', 'dblp.search']);
  });

  it('a configured source that is NOT explicit is preferred, and still substitutable', async () => {
    // An assertion, never an inference: a value arriving without `explicit` was nobody's choice,
    // so it may be substituted — but it is still what gets tried first.
    const s = spy({
      openalex: { search: down('OpenAlex') },
      dblp: { search: [hit('dblp', 'd:1')] },
    });
    const out = await new ReferenceResolver(s.backends, {
      source: 'openalex',
      explicit: false,
    }).search('x');

    expect(out.source).toBe('dblp');
    expect(out.fallbackFrom).toBe('openalex');
    expect(s.calls).toEqual(['openalex.search', 'dblp.search']);
  });

  it('a configured source that ANSWERS stops the chain, without consulting the default order', () => {
    // The other direction: preferring the configured source must not turn into trying everything.
    // Zero hits from it is an ANSWER and ends the search — the rule that keeps "this bibliography
    // has never heard of it" from becoming "here is what another one found instead".
    const s = spy({ openalex: { search: [] } });
    return new ReferenceResolver(s.backends, { source: 'openalex' }).search('x').then((out) => {
      expect(out.source).toBe('openalex');
      expect(out.fallbackFrom).toBeUndefined();
      expect(s.calls).toEqual(['openalex.search']);
    });
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
          JSON.stringify({ message: { items: [{ DOI: '10.1234/x', title: ['T'], author: [] }] } }),
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
    expect(out.hits[0]?.key).toBe('crossref:10.1234/x');
  });
});

describe('ReferenceResolver — WEB_LATEX_MCP_REFERENCE_SOURCE holds an unusable value', () => {
  // The proportionate failure: the setting governs search_references and nothing else, so a
  // typo refuses *that*, loudly and by name, instead of taking the server down at startup.
  // Falling back to the unpinned order would be the real violation — the user asserted a
  // bibliography, and answering from a different one is a different claim.

  it('refuses an unpinned search, naming the bad value and every valid id', async () => {
    const s = spy({ dblp: { search: [hit('dblp', 'd:1')] } });
    const resolver = new ReferenceResolver(s.backends, { invalidSource: 'crossreff' });

    await expect(resolver.search('resnet')).rejects.toBeInstanceOf(ReferenceSourceInvalidError);
    await expect(resolver.search('resnet')).rejects.toThrow(/crossreff/);
    await expect(resolver.search('resnet')).rejects.toThrow(/dblp, crossref, openalex/);
    // Both routes out, the same discipline `pinnedMessage` follows.
    await expect(resolver.search('resnet')).rejects.toThrow(/unset WEB_LATEX_MCP_REFERENCE_SOURCE/);
    await expect(resolver.search('resnet')).rejects.toThrow(/source:/);
    // And no backend was consulted: this is a refusal, not a substitution.
    expect(s.calls).toEqual([]);
  });

  it('carries the rejected value on the error, and is NOT a ReferenceSourceUnavailableError', async () => {
    // Deliberately a separate class: ReferenceSourceUnavailableError carries a
    // `source: ReferenceSourceId`, and the bad value is not one. It is also not substitutable —
    // only BackendUnavailableError licenses trying the next backend.
    const s = spy({});
    const resolver = new ReferenceResolver(s.backends, { invalidSource: 'scopus' });

    const err = await resolver.search('x').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ReferenceSourceInvalidError);
    expect(err).not.toBeInstanceOf(ReferenceSourceUnavailableError);
    expect((err as ReferenceSourceInvalidError).value).toBe('scopus');
    expect((err as Error).name).toBe('ReferenceSourceInvalidError');
  });

  it('a per-call source: still searches normally — the failure stays proportionate', async () => {
    // The one that proves the point: a broken env var must not make the tool unusable for a
    // caller who names a backend. A per-call source is an explicit assertion and wins, exactly
    // as it does over a *valid* configured source.
    const s = spy({ crossref: { search: [hit('crossref', 'crossref:10.1234/x')] } });
    const resolver = new ReferenceResolver(s.backends, { invalidSource: 'crossreff' });

    const out = await resolver.search('resnet', { source: 'crossref' });

    expect(out.source).toBe('crossref');
    expect(out.hits[0]?.key).toBe('crossref:10.1234/x');
    expect(out.fallbackFrom).toBeUndefined();
    expect(s.calls).toEqual(['crossref.search']);
  });

  it('a per-call source that is down still fails as a pinned CALL, not as a bad env var', async () => {
    const s = spy({ dblp: { search: down('DBLP') } });
    const resolver = new ReferenceResolver(s.backends, { invalidSource: 'crossreff' });

    await expect(resolver.search('x', { source: 'dblp' })).rejects.toBeInstanceOf(
      ReferenceSourceUnavailableError,
    );
    await expect(resolver.search('x', { source: 'dblp' })).rejects.toThrow(
      /source: "dblp" was requested/,
    );
  });

  it('leaves fetchBibtex completely alone — it routes by the KEY, not by the config', async () => {
    // A bad env var has nothing to do with fetching a record the caller already found: the key
    // carries its own provenance. Pinned here so a future edit cannot widen the refusal into it.
    const s = spy({ crossref: { bibtex: '@inproceedings{x,}' }, dblp: { bibtex: '@misc{d,}' } });
    const resolver = new ReferenceResolver(s.backends, { invalidSource: 'crossreff' });

    expect(await resolver.fetchBibtex('crossref:10.1109/CVPR.2016.90')).toEqual({
      bibtex: '@inproceedings{x,}',
      source: 'crossref',
    });
    expect(await resolver.fetchBibtex('conf/cvpr/HeZRS16')).toEqual({
      bibtex: '@misc{d,}',
      source: 'dblp',
    });
  });

  it('is inert when no invalid value was configured', async () => {
    const s = spy({ dblp: { search: [hit('dblp', 'd:1')] } });
    const out = await new ReferenceResolver(s.backends, { invalidSource: undefined }).search('x');
    expect(out.source).toBe('dblp');
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

  it('tells the caller to get the user’s approval BEFORE reaching for confirmBibEdit', async () => {
    // This is the one place in the server where server-authored text tells a model it may
    // originate `.bib` entry bytes itself. `confirmBibEdit` only means anything because it
    // stands for the user's acknowledgement (CLAUDE.md, same reasoning as
    // `add_writing_convention`), so the message has to name that approval — and name it
    // *before* the flag, in the same order `bibEditBlockedMessage` uses. A message that only
    // says "add it by hand with confirmBibEdit: true" reads as a licence to just set the flag.
    const s = spy({ openalex: { doi: null } });
    const err = await new ReferenceResolver(s.backends).fetchBibtex('openalex:W1').then(
      () => {
        throw new Error('expected a refusal');
      },
      (e: unknown) => e as Error,
    );

    expect(err).toBeInstanceOf(NoCanonicalBibtexError);
    expect(err.message).toMatch(/ask the user to approve/i);
    // Order matters: the approval is the precondition, the flag is what follows it.
    expect(err.message).toMatch(/ask the user to approve[\s\S]*confirmBibEdit: true/i);
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

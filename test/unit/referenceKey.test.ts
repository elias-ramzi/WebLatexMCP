import { describe, expect, it } from 'vitest';
import {
  REFERENCE_SOURCES,
  formatRecordKey,
  parseRecordKey,
  type ReferenceSourceId,
} from '../../src/lib/referenceKey.js';

function getThrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected function to throw');
}

describe('referenceKey', () => {
  describe('formatRecordKey', () => {
    it('joins source and id with a colon', () => {
      expect(formatRecordKey('dblp', 'conf/cvpr/HeZRS16')).toBe('dblp:conf/cvpr/HeZRS16');
      expect(formatRecordKey('crossref', '10.1109/CVPR.2016.90')).toBe(
        'crossref:10.1109/CVPR.2016.90',
      );
      expect(formatRecordKey('openalex', 'W2194775991')).toBe('openalex:W2194775991');
    });
  });

  describe('round-trip', () => {
    const cases: Array<{ source: ReferenceSourceId; id: string }> = [
      { source: 'dblp', id: 'conf/cvpr/HeZRS16' },
      { source: 'crossref', id: '10.1109/CVPR.2016.90' },
      { source: 'openalex', id: 'W2194775991' },
    ];
    for (const { source, id } of cases) {
      it(`round-trips a ${source} key`, () => {
        expect(parseRecordKey(formatRecordKey(source, id))).toEqual({ source, id });
      });
    }
  });

  describe('accepted input forms', () => {
    it('parses a dblp-prefixed key', () => {
      expect(parseRecordKey('dblp:conf/cvpr/HeZRS16')).toEqual({
        source: 'dblp',
        id: 'conf/cvpr/HeZRS16',
      });
    });

    it('parses a crossref-prefixed DOI', () => {
      expect(parseRecordKey('crossref:10.1109/CVPR.2016.90')).toEqual({
        source: 'crossref',
        id: '10.1109/CVPR.2016.90',
      });
    });

    it('parses an openalex-prefixed id', () => {
      expect(parseRecordKey('openalex:W2194775991')).toEqual({
        source: 'openalex',
        id: 'W2194775991',
      });
    });

    it('treats doi: as an alias for crossref', () => {
      expect(parseRecordKey('doi:10.1109/CVPR.2016.90')).toEqual({
        source: 'crossref',
        id: '10.1109/CVPR.2016.90',
      });
    });

    it('parses a bare DBLP key with no prefix (backward compatibility)', () => {
      expect(parseRecordKey('conf/cvpr/HeZRS16')).toEqual({
        source: 'dblp',
        id: 'conf/cvpr/HeZRS16',
      });
    });

    it('parses dblp URLs by host, in .html/.bib/.xml forms, and the uni-trier host', () => {
      expect(parseRecordKey('https://dblp.org/rec/conf/cvpr/HeZRS16.html')).toEqual({
        source: 'dblp',
        id: 'conf/cvpr/HeZRS16',
      });
      expect(parseRecordKey('https://dblp.org/rec/conf/cvpr/HeZRS16.bib')).toEqual({
        source: 'dblp',
        id: 'conf/cvpr/HeZRS16',
      });
      expect(parseRecordKey('https://dblp.org/rec/conf/cvpr/HeZRS16.xml')).toEqual({
        source: 'dblp',
        id: 'conf/cvpr/HeZRS16',
      });
      expect(parseRecordKey('https://dblp.uni-trier.de/rec/conf/cvpr/HeZRS16.html')).toEqual({
        source: 'dblp',
        id: 'conf/cvpr/HeZRS16',
      });
    });

    it('parses doi.org and dx.doi.org URLs as crossref', () => {
      expect(parseRecordKey('https://doi.org/10.1109/cvpr.2016.90')).toEqual({
        source: 'crossref',
        id: '10.1109/cvpr.2016.90',
      });
      expect(parseRecordKey('https://dx.doi.org/10.1109/cvpr.2016.90')).toEqual({
        source: 'crossref',
        id: '10.1109/cvpr.2016.90',
      });
    });

    it('parses an api.crossref.org works URL as crossref', () => {
      expect(parseRecordKey('https://api.crossref.org/works/10.1109/CVPR.2016.90')).toEqual({
        source: 'crossref',
        id: '10.1109/CVPR.2016.90',
      });
    });

    it('parses openalex.org and api.openalex.org URLs as openalex', () => {
      expect(parseRecordKey('https://openalex.org/W2194775991')).toEqual({
        source: 'openalex',
        id: 'W2194775991',
      });
      expect(parseRecordKey('https://api.openalex.org/works/W2194775991')).toEqual({
        source: 'openalex',
        id: 'W2194775991',
      });
    });

    it('parses a bare DOI with no prefix as crossref', () => {
      expect(parseRecordKey('10.1109/CVPR.2016.90')).toEqual({
        source: 'crossref',
        id: '10.1109/CVPR.2016.90',
      });
    });

    it('parses a bare openalex id with no prefix as openalex', () => {
      expect(parseRecordKey('W2194775991')).toEqual({ source: 'openalex', id: 'W2194775991' });
    });
  });

  describe('precedence', () => {
    it('routes a bare DOI-shaped string to crossref, not dblp', () => {
      const result = parseRecordKey('10.1109/CVPR.2016.90');
      expect(result.source).toBe('crossref');
    });

    it('routes a bare W-prefixed id to openalex, not dblp', () => {
      const result = parseRecordKey('W2194775991');
      expect(result.source).toBe('openalex');
    });

    it('still routes an ordinary bare key to dblp', () => {
      const result = parseRecordKey('conf/cvpr/HeZRS16');
      expect(result.source).toBe('dblp');
    });
  });

  describe('path traversal rejection', () => {
    it('rejects .. under every prefix', () => {
      expect(() => parseRecordKey('dblp:../../etc/passwd')).toThrow();
      expect(() => parseRecordKey('crossref:../../x')).toThrow();
      expect(() => parseRecordKey('openalex:../x')).toThrow();
    });

    it('rejects .. in a bare key', () => {
      expect(() => parseRecordKey('../../etc/passwd')).toThrow();
    });

    it('rejects .. smuggled in a DOI suffix, prefixed or bare', () => {
      expect(() => parseRecordKey('10.1109/../../secret')).toThrow();
      expect(() => parseRecordKey('doi:10.1109/../../secret')).toThrow();
      expect(() => parseRecordKey('crossref:10.1109/../../secret')).toThrow();
    });
  });

  describe('values just outside every guard', () => {
    it('rejects a W id with trailing letters after the digits', () => {
      expect(() => parseRecordKey('W12a')).toThrow();
    });

    it('rejects a bare W with no digits', () => {
      expect(() => parseRecordKey('W')).toThrow();
    });

    it('rejects a DOI with too few registrant digits', () => {
      expect(() => parseRecordKey('10.1/x')).toThrow();
    });

    it('rejects a DOI containing a space', () => {
      expect(() => parseRecordKey('crossref:10.1109/CVPR 2016.90')).toThrow();
    });

    it('rejects a DOI containing a newline', () => {
      expect(() => parseRecordKey('crossref:10.1109/CVPR\n2016.90')).toThrow();
    });

    it('rejects an unknown prefix and lists the accepted sources in the message', () => {
      expect(() => parseRecordKey('scopus:123')).toThrow();
      const message = getThrownMessage(() => parseRecordKey('scopus:123'));
      for (const source of REFERENCE_SOURCES) {
        expect(message).toContain(source);
      }
    });

    it('rejects the empty string', () => {
      expect(() => parseRecordKey('')).toThrow();
    });

    it('rejects a whitespace-only string', () => {
      expect(() => parseRecordKey('   ')).toThrow();
    });
  });

  describe('case-insensitivity', () => {
    it('accepts an uppercase source prefix', () => {
      expect(parseRecordKey('DBLP:conf/x/y')).toEqual({ source: 'dblp', id: 'conf/x/y' });
    });

    it('accepts an uppercase doi: prefix', () => {
      expect(parseRecordKey('DOI:10.1109/CVPR.2016.90')).toEqual({
        source: 'crossref',
        id: '10.1109/CVPR.2016.90',
      });
    });

    it('normalises a lowercase openalex id to uppercase W', () => {
      expect(parseRecordKey('w2194775991')).toEqual({ source: 'openalex', id: 'W2194775991' });
    });
  });

  describe('DOI suffix case preservation', () => {
    it('does not lowercase or uppercase the DOI suffix', () => {
      expect(parseRecordKey('10.1109/CVPR.2016.90')).toEqual({
        source: 'crossref',
        id: '10.1109/CVPR.2016.90',
      });
      expect(parseRecordKey('crossref:10.1109/cvpr.2016.90')).toEqual({
        source: 'crossref',
        id: '10.1109/cvpr.2016.90',
      });
    });
  });
});

describe('a DBLP key that merely starts with w', () => {
  it('is not swallowed by the OpenAlex namespace claim', () => {
    // DBLP really has `www/`-prefixed keys. A loose /^w/i claim rejected them outright with an
    // error that never mentioned DBLP, making a legitimate key unusable.
    expect(parseRecordKey('www/gh/HeZRS16')).toEqual({ source: 'dblp', id: 'www/gh/HeZRS16' });
    expect(parseRecordKey('dblp:www/gh/HeZRS16').source).toBe('dblp');
  });

  it('still rejects the OpenAlex lookalikes', () => {
    expect(() => parseRecordKey('W12a')).toThrow();
    expect(() => parseRecordKey('W')).toThrow();
    expect(parseRecordKey('W2194775991')).toEqual({ source: 'openalex', id: 'W2194775991' });
  });
});

describe('crossref keys the server itself emits', () => {
  // `CrossrefService.search` emits `formatRecordKey('crossref', item.DOI)` for whatever DOI
  // the API returned, so every DOI the allowlist rejects is a key the server prints and then
  // refuses one `add_citation` later. Drive this from a table of shapes seen in the wild, not
  // from three clean ids — three clean ids are why the too-narrow charset shipped.
  const dois = [
    '10.1109/CVPR.2016.90',
    // Real Wiley/AGU SICI-class DOI: parentheses, angle brackets, colons, semicolon, `#`.
    '10.1002/(SICI)1097-0142(19960101)77:1<50::AID-CNCR10>3.0.CO;2-#',
    '10.1175/1520-0469(1996)053<0946:X>2.0.CO;2',
    '10.1016/j.foo,2020.01',
    "10.1234/a'b",
    '10.1234/a~b',
    '10.1234/a*b',
    '10.1234/a!b',
    '10.1234/a$b',
    '10.1234/a=b',
    '10.1234/a@b',
    '10.1234/a#b',
    '10.1234/a+b',
    '10.1234/a[b]c',
    '10.1234/a;b:c',
    '10.1234/a_b-c.d/e',
  ];
  for (const doi of dois) {
    it(`round-trips the emitted key for ${doi}`, () => {
      expect(parseRecordKey(formatRecordKey('crossref', doi))).toEqual({
        source: 'crossref',
        id: doi,
      });
    });
  }
});

describe('the DOI allowlist stays closed where it matters', () => {
  it('refuses a percent sign in a DOI, prefixed or bare', () => {
    // `%` is what stops a double-encoded `%252e%252e` from ever decoding into the `..` the
    // explicit check looks for. Nothing downstream needs it literal — `fetchBibtex`
    // per-segment `encodeURIComponent`s the DOI. Widening the class must never admit it.
    expect(() => parseRecordKey('crossref:10.1234/a%2e%2e/b')).toThrow();
    expect(() => parseRecordKey('doi:10.1234/a%2e%2e/b')).toThrow();
    expect(() => parseRecordKey('10.1234/a%2e%2e/b')).toThrow();
    expect(() => parseRecordKey('crossref:10.1234/a%20b')).toThrow();
  });

  it('refuses whitespace and control characters in a DOI', () => {
    expect(() => parseRecordKey('crossref:10.1234/a b')).toThrow();
    expect(() => parseRecordKey('crossref:10.1234/a\tb')).toThrow();
    expect(() => parseRecordKey('crossref:10.1234/a\u0000b')).toThrow();
  });
});

describe('the .. guard is the only thing rejecting these', () => {
  // `DBLP_KEY`'s `^[A-Za-z0-9]` anchor already rejects anything *starting* with a dot, so the
  // suite's `../../etc/passwd` inputs never exercise `normalizeDblpKey`'s `..` check at all.
  // These do: first character valid, traversal in the middle, every other character allowed.
  it('rejects .. in the middle of an otherwise well-formed bare DBLP key', () => {
    expect(() => parseRecordKey('conf/../../etc/passwd')).toThrow();
  });

  it('rejects .. in the middle of a dblp-prefixed key', () => {
    expect(() => parseRecordKey('dblp:conf/../../etc/passwd')).toThrow();
  });
});

describe('URLs on hosts this module does not recognise', () => {
  it('refuses them instead of stripping the host and reading the path as a DBLP key', () => {
    // `normalizeDblpKey` used to strip *any* `scheme://host/` prefix, so an unrecognised host
    // fell through and came back as a plain DBLP key; its strip is now anchored to the two DBLP
    // hosts, which is what actually refuses these (the `throw` in `tryParseUrl` is defence in
    // depth over it). The userinfo form is the one a reader misjudges: the host is `evil.com`.
    expect(() => parseRecordKey('https://evil.com/rec/conf/cvpr/HeZRS16')).toThrow();
    expect(() => parseRecordKey('https://dblp.org@evil.com/rec/conf/cvpr/HeZRS16')).toThrow();
    expect(() => parseRecordKey('https://dblp.org.evil.com/rec/conf/x/y')).toThrow();
    expect(() => parseRecordKey('http://evil.com/rec/conf/cvpr/HeZRS16')).toThrow();
  });

  it('says the host is unrecognised rather than inventing a DBLP key from the path', () => {
    const message = getThrownMessage(() =>
      parseRecordKey('https://ieeexplore.ieee.org/document/7780459'),
    );
    expect(message).toContain('recognised URL');
    expect(message).toContain('dblp.org/rec/');
    expect(message).toContain('https://ieeexplore.ieee.org/document/7780459');
  });

  it('still accepts every recognised URL form', () => {
    expect(parseRecordKey('https://dblp.org/rec/conf/cvpr/HeZRS16.html').source).toBe('dblp');
    expect(parseRecordKey('https://dblp.org/rec/conf/cvpr/HeZRS16.bib').source).toBe('dblp');
    expect(parseRecordKey('https://dblp.org/rec/conf/cvpr/HeZRS16.xml').source).toBe('dblp');
    expect(parseRecordKey('https://dblp.uni-trier.de/rec/conf/cvpr/HeZRS16.html')).toEqual({
      source: 'dblp',
      id: 'conf/cvpr/HeZRS16',
    });
    expect(parseRecordKey('https://doi.org/10.1109/CVPR.2016.90')).toEqual({
      source: 'crossref',
      id: '10.1109/CVPR.2016.90',
    });
    expect(parseRecordKey('https://dx.doi.org/10.1109/CVPR.2016.90').source).toBe('crossref');
    expect(parseRecordKey('https://api.crossref.org/works/10.1109/CVPR.2016.90')).toEqual({
      source: 'crossref',
      id: '10.1109/CVPR.2016.90',
    });
    expect(parseRecordKey('https://openalex.org/W2194775991')).toEqual({
      source: 'openalex',
      id: 'W2194775991',
    });
    expect(parseRecordKey('https://api.openalex.org/works/W2194775991')).toEqual({
      source: 'openalex',
      id: 'W2194775991',
    });
  });
});

describe('a URL path the parser would silently rewrite', () => {
  it('refuses dot segments rather than normalising them into a different, valid key', () => {
    // WHATWG `URL` collapses `.`/`..`/`%2e%2e` *before* `url.pathname` can be read, so the
    // `..` check never sees them: this used to come back as the perfectly valid-looking
    // `{source: 'dblp', id: 'etc/passwd'}` — a silent rewrite, not a refusal.
    expect(() => parseRecordKey('https://dblp.org/rec/%2e%2e/%2e%2e/etc/passwd')).toThrow();
    expect(() => parseRecordKey('https://dblp.org/rec/%2E%2E/etc/passwd')).toThrow();
    expect(() => parseRecordKey('https://dblp.org/rec/../../etc/passwd')).toThrow();
    expect(() => parseRecordKey('https://dblp.org/rec/./conf/cvpr/HeZRS16')).toThrow();
    expect(() => parseRecordKey('https://doi.org/10.1109/%2e%2e/%2e%2e/x')).toThrow();
  });

  it('still refuses an encoded separator smuggling .. into one segment', () => {
    // `..%2f` is one segment, not a dot segment, so the parser leaves it alone and
    // `decodeSegment` + the `..` check catch it. That path must stay covered.
    expect(() => parseRecordKey('https://dblp.org/rec/..%2f..%2fetc/passwd')).toThrow();
  });
});

describe('the OpenAlex namespace claim, narrowed again', () => {
  it('releases a w-prefixed key containing a slash back to dblp', () => {
    // An OpenAlex work id never contains `/`. Claiming `w3c/foo` was the same shape of bug as
    // the `www/` one: a namespace claimed on a guess about someone else's key space.
    expect(parseRecordKey('w3c/foo')).toEqual({ source: 'dblp', id: 'w3c/foo' });
    expect(parseRecordKey('w3/2024/rec')).toEqual({ source: 'dblp', id: 'w3/2024/rec' });
  });

  it('still claims the slashless OpenAlex lookalikes so they get the specific error', () => {
    expect(() => parseRecordKey('W12a')).toThrow();
    expect(() => parseRecordKey('W')).toThrow();
    expect(parseRecordKey('W2194775991')).toEqual({ source: 'openalex', id: 'W2194775991' });
  });
});

describe('dot segments are refused whatever the scheme', () => {
  it('refuses them on a recognised host reached over a non-http scheme', () => {
    // Host routing has always been protocol-agnostic — `tryParseUrl` switches on
    // `url.hostname` and never looks at `url.protocol` — and WHATWG collapses dot segments
    // for every special scheme, not just http(s). Gating the dot-segment refusal on
    // http(s) alone therefore left the silent rewrite reachable one scheme over.
    expect(() => parseRecordKey('ftp://dblp.org/rec/%2e%2e/%2e%2e/etc/passwd')).toThrow();
    expect(() => parseRecordKey('ws://dblp.org/rec/../../etc/passwd')).toThrow();
  });
});

describe('the three routes that still laundered a host or rewrote an id', () => {
  it('refuses a prefixed key whose value is a URL on an unrecognised host', () => {
    // `tryParseUrl` refuses this for an unprefixed URL, but the `dblp:` branch calls
    // `normalizeDblpKey` directly and never goes through it — and the strip used to take any
    // host, so `dblp:https://evil.com/rec/conf/x/y` came back as the DBLP key `conf/x/y`.
    expect(() => parseRecordKey('dblp:https://evil.com/rec/conf/cvpr/HeZRS16')).toThrow(
      /not a valid reference key/,
    );
    expect(() => parseRecordKey('dblp:https://dblp.org@evil.com/rec/conf/cvpr/HeZRS16')).toThrow(
      /not a valid reference key/,
    );
  });

  it('still accepts a prefixed key whose value is a real DBLP URL', () => {
    expect(parseRecordKey('dblp:https://dblp.org/rec/conf/cvpr/HeZRS16.bib')).toEqual({
      source: 'dblp',
      id: 'conf/cvpr/HeZRS16',
    });
    expect(parseRecordKey('dblp:https://dblp.uni-trier.de/rec/conf/cvpr/HeZRS16')).toEqual({
      source: 'dblp',
      id: 'conf/cvpr/HeZRS16',
    });
  });

  it('refuses a DOI URL carrying a fragment rather than truncating the DOI', () => {
    // A real Wiley/AGU SICI DOI ends `3.0.CO;2-#`. `URL` reads that as a fragment, so
    // `url.pathname` handed back a DOI one character short — a different record, silently.
    const doi = '10.1002/(SICI)1097-0142(19960101)77:1<50::AID-CNCR10>3.0.CO;2-#';
    expect(() => parseRecordKey(`https://doi.org/${doi}`)).toThrow(/not a valid reference key/);
    expect(() => parseRecordKey(`https://api.crossref.org/works/${doi}`)).toThrow(
      /not a valid reference key/,
    );
    // The query half of the same hole: `url.pathname` drops `?…` exactly as it drops `#…`,
    // so a DOI URL carrying one came back as a different, perfectly valid record key.
    expect(() => parseRecordKey('https://doi.org/10.1234/a?b=c')).toThrow(
      /not a valid reference key/,
    );
    expect(() => parseRecordKey('https://api.crossref.org/works/10.1234/a?b=c')).toThrow(
      /not a valid reference key/,
    );
    // The lossless forms for the same DOI keep working, which is why refusing is safe.
    expect(parseRecordKey(`crossref:${doi}`)).toEqual({ source: 'crossref', id: doi });
    expect(parseRecordKey(doi)).toEqual({ source: 'crossref', id: doi });
  });

  it('parses the schemeless spellings the error message advertises', () => {
    // `acceptedFormsMessage` offers "dblp.org/rec/<key>.html", "doi.org/<doi>" and friends, and
    // every one of them failed `new URL` and fell through to the bare-key path, where the host
    // became part of the key — "doi.org/10.1109/CVPR.2016.90" parsed as the DBLP record
    // "doi.org/10.1109/CVPR.2016.90", which 404s one call later. The message has to be true.
    expect(parseRecordKey('dblp.org/rec/conf/cvpr/HeZRS16.html')).toEqual({
      source: 'dblp',
      id: 'conf/cvpr/HeZRS16',
    });
    expect(parseRecordKey('doi.org/10.1109/CVPR.2016.90')).toEqual({
      source: 'crossref',
      id: '10.1109/CVPR.2016.90',
    });
    expect(parseRecordKey('api.crossref.org/works/10.1109/CVPR.2016.90')).toEqual({
      source: 'crossref',
      id: '10.1109/CVPR.2016.90',
    });
    expect(parseRecordKey('openalex.org/W2194775991')).toEqual({
      source: 'openalex',
      id: 'W2194775991',
    });
  });

  it('retries the scheme only for a host it routes, leaving bare keys alone', () => {
    // The retry must not reinterpret a bare record key as a URL, and must not adopt a host
    // this module does not route — that would be the host-laundering the refusals above close.
    expect(parseRecordKey('conf/cvpr/HeZRS16')).toEqual({
      source: 'dblp',
      id: 'conf/cvpr/HeZRS16',
    });
    expect(parseRecordKey('10.1109/CVPR.2016.90')).toEqual({
      source: 'crossref',
      id: '10.1109/CVPR.2016.90',
    });
    // Unrecognised host, no scheme: unchanged — it stays a (useless, but refused-later) bare key
    // rather than being routed anywhere.
    expect(parseRecordKey('evil.com/rec/conf/x/y')).toEqual({
      source: 'dblp',
      id: 'evil.com/rec/conf/x/y',
    });
  });

  it('refuses a non-http URL on a recognised host', () => {
    // Host routing switched on `url.hostname` alone, so a scheme nothing here would ever
    // fetch was accepted as a record key.
    expect(() => parseRecordKey('ftp://dblp.org/rec/conf/cvpr/HeZRS16')).toThrow(
      /not a valid reference key/,
    );
    expect(() => parseRecordKey('ws://api.openalex.org/works/W2194775991')).toThrow(
      /not a valid reference key/,
    );
  });
});

describe('a trailing-dot FQDN is a legal spelling of a recognised host', () => {
  // `https://dblp.org./rec/...` is the fully-qualified spelling of the same host and parsed
  // before the host fix; comparing `url.hostname` exactly turned it into a refusal nobody
  // asked for. The dot is stripped for the *comparison* only — nothing else about host
  // matching is loosened, which is what the two pins below exist to keep true.
  it('routes a trailing-dot DBLP host normally', () => {
    expect(parseRecordKey('https://dblp.org./rec/conf/cvpr/HeZRS16.bib')).toEqual({
      source: 'dblp',
      id: 'conf/cvpr/HeZRS16',
    });
    expect(parseRecordKey('https://dblp.uni-trier.de./rec/conf/cvpr/HeZRS16')).toEqual({
      source: 'dblp',
      id: 'conf/cvpr/HeZRS16',
    });
  });

  it('routes the trailing-dot spelling on the schemeless and prefixed routes too', () => {
    // The first cut stripped the dot in `tryParseUrl` only, so the three routes disagreed about
    // whether `dblp.org.` is the same host as `dblp.org`: the schemeless form fell through to the
    // bare-key path with the host swallowed into the key, and the `dblp:`-prefixed form threw.
    // A legal spelling of a host must not parse on one route and fail on another.
    expect(parseRecordKey('dblp.org./rec/conf/cvpr/HeZRS16.html')).toEqual({
      source: 'dblp',
      id: 'conf/cvpr/HeZRS16',
    });
    expect(parseRecordKey('doi.org./10.1109/CVPR.2016.90')).toEqual({
      source: 'crossref',
      id: '10.1109/CVPR.2016.90',
    });
    expect(parseRecordKey('dblp:https://dblp.org./rec/conf/cvpr/HeZRS16.bib')).toEqual({
      source: 'dblp',
      id: 'conf/cvpr/HeZRS16',
    });
  });

  it('still refuses a host that merely resembles a recognised one, dot or no dot', () => {
    // The dot strip must not become a way to reach an unrouted host.
    for (const bad of [
      'https://dblp.org.evil.com/rec/conf/x/y',
      'https://dblp.org@evil.com/rec/conf/x/y',
      'dblp:https://dblp.org.evil.com/rec/conf/x/y',
      'https://dblp.org../rec/conf/x/y',
    ]) {
      expect(() => parseRecordKey(bad)).toThrow(/not a valid reference key/);
    }
  });

  it('routes a trailing-dot non-DBLP recognised host normally', () => {
    expect(parseRecordKey('https://doi.org./10.1109/CVPR.2016.90')).toEqual({
      source: 'crossref',
      id: '10.1109/CVPR.2016.90',
    });
    expect(parseRecordKey('https://openalex.org./W2194775991')).toEqual({
      source: 'openalex',
      id: 'W2194775991',
    });
  });

  it('still refuses a host that merely begins with a recognised one', () => {
    // The two shapes a loosened comparison would let through. Neither is `dblp.org`: the
    // first is a subdomain of `evil.com`, the second has `dblp.org` as userinfo.
    expect(() => parseRecordKey('https://dblp.org.evil.com/rec/conf/x/y')).toThrow(
      /not a valid reference key/,
    );
    expect(() => parseRecordKey('https://dblp.org@evil.com/rec/conf/x/y')).toThrow(
      /not a valid reference key/,
    );
    // And a doubled trailing dot is not a legal FQDN spelling — only one dot is stripped.
    expect(() => parseRecordKey('https://dblp.org../rec/conf/x/y')).toThrow(
      /not a valid reference key/,
    );
  });
});

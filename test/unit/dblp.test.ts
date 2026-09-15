import { describe, it, expect, afterEach, vi } from 'vitest';
import { DblpService, type FetchResponse } from '../../src/services/dblp.js';
import {
  BackendUnavailableError,
  REQUEST_TIMEOUT_MS,
} from '../../src/services/referenceBackend.js';
import { normalizeDblpKey } from '../../src/lib/referenceKey.js';

function ok(body: string): FetchResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

function fail(status: number, statusText: string): FetchResponse {
  return {
    ok: false,
    status,
    statusText,
    text: async () => '',
    json: async () => ({}),
  };
}

/**
 * The anti-bot interstitial dblp.org serves — abridged, but keeping the two properties that
 * broke the client: it arrives with HTTP **200**, and its inline script carries an `@licstart`
 * header, so "the body contains an @" wrongly accepted it as BibTeX.
 */
const BOT_CHALLENGE =
  '<!doctype html><html lang="en"><head><title>Making sure you&#39;re not a bot!</title>' +
  '</head><body><script>/*\n@licstart The following is the entire license notice.\n' +
  'Copyright (c) 2026 Xe Iaso <xe.iaso@techaro.lol>\n@licend*/</script></body></html>';

const SEARCH_JSON = JSON.stringify({
  result: {
    hits: {
      hit: [
        {
          info: {
            key: 'conf/cvpr/HeZRS16',
            title: 'Deep Residual Learning for Image Recognition.',
            year: '2016',
            venue: 'CVPR',
            type: 'Conference and Workshop Papers',
            doi: '10.1109/CVPR.2016.90',
            url: 'https://dblp.org/rec/conf/cvpr/HeZRS16',
            authors: {
              author: [
                { '@pid': '1', text: 'Kaiming He' },
                { '@pid': '2', text: 'Xiangyu Zhang' },
              ],
            },
          },
        },
      ],
    },
  },
});

describe('DblpService.search', () => {
  it('parses hits, normalizes authors, and strips trailing title dots', async () => {
    let requested = '';
    const dblp = new DblpService((url) => {
      requested = url;
      return Promise.resolve(ok(SEARCH_JSON));
    });
    const hits = await dblp.search('deep residual', { maxResults: 5 });

    expect(requested).toContain('/search/publ/api?q=deep%20residual');
    expect(requested).toContain('h=5');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      // Namespaced like every other backend's key, so add_citation can route it and the docs'
      // "a result's key names its backend" claim holds for all three, not two of three.
      key: 'dblp:conf/cvpr/HeZRS16',
      source: 'dblp',
      title: 'Deep Residual Learning for Image Recognition',
      authors: ['Kaiming He', 'Xiangyu Zhang'],
      year: 2016,
      venue: 'CVPR',
    });
  });

  it('handles a single (non-array) author and missing hits', async () => {
    const single = JSON.stringify({
      result: {
        hits: { hit: { info: { key: 'k/1', title: 'Solo', authors: { author: 'A. One' } } } },
      },
    });
    const dblp = new DblpService(() => Promise.resolve(ok(single)));
    const hits = await dblp.search('solo');
    expect(hits[0]?.authors).toEqual(['A. One']);
    expect(hits[0]?.key).toBe('dblp:k/1');

    const empty = new DblpService(() =>
      Promise.resolve(ok(JSON.stringify({ result: { hits: { '@total': '0' } } }))),
    );
    expect(await empty.search('nothing')).toEqual([]);
  });

  it('rejects an empty query and surfaces HTTP errors', async () => {
    const dblp = new DblpService(() => Promise.resolve(fail(503, 'Unavailable')));
    await expect(dblp.search('   ')).rejects.toThrow(/must not be empty/);
    await expect(dblp.search('x')).rejects.toThrow(/503 Unavailable/);
  });

  it('names the bot challenge rather than dying inside JSON.parse', async () => {
    // The interstitial comes back 200, so `res.ok` is no defence: the body must be sniffed.
    const dblp = new DblpService(() => Promise.resolve(ok(BOT_CHALLENGE)));
    await expect(dblp.search('deep residual')).rejects.toThrow(/HTML page instead of API data/);
    await expect(dblp.search('deep residual')).rejects.toThrow(/anti-bot proof-of-work/);
    // The raw JSON.parse failure is what made this undiagnosable in the field.
    await expect(dblp.search('deep residual')).rejects.not.toThrow(/Unexpected token/);
  });

  it('quotes a non-JSON body that is not a web page', async () => {
    const dblp = new DblpService(() => Promise.resolve(ok('not json at all')));
    await expect(dblp.search('x')).rejects.toThrow(/not JSON.*not json at all/s);
  });

  it('reports an unusable body as unavailable, so a resolver may substitute a backend', async () => {
    // A backend that answers with garbage has not answered; it must be substitutable.
    const dblp = new DblpService(() => Promise.resolve(ok('not json at all')));
    await expect(dblp.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
  });

  it('treats well-formed JSON of the WRONG SHAPE as unavailable, not as zero results', async () => {
    // A 200 carrying an error envelope parses fine and has no results container. Returning []
    // would stop the resolver's fallback and report "no results" for a search that never ran.
    const dblp = new DblpService(() => Promise.resolve(ok('{"status":"error","message":[]}')));
    await expect(dblp.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(dblp.search('x')).rejects.toThrow(/JSON in an unexpected shape/);
  });

  it('still treats a present-but-empty hits container as a real empty answer', async () => {
    // The value just outside: `hits` present with no `hit` — the shape a real DBLP search that
    // found nothing actually returns (`@total: "0"`). This must never become unavailable.
    const dblp = new DblpService(() =>
      Promise.resolve(
        ok(JSON.stringify({ result: { query: 'x', hits: { '@total': '0', '@sent': '0' } } })),
      ),
    );
    await expect(dblp.search('x')).resolves.toEqual([]);
  });

  it('treats a `result` that is an ARRAY, or carries no hits container, as unavailable', async () => {
    // `typeof [] === 'object'` — so the old guard admitted an array, and `{result:{}}` too.
    // Either mapped to zero hits, and the resolver treats zero hits as an ANSWER: it stops the
    // fallback chain and reports "No results for X on dblp" for a backend that never searched.
    // The sibling crossref/openalex guards already reject both; this closes the daylight.
    for (const body of ['{"result":[]}', '{"result":{}}']) {
      const dblp = new DblpService(() => Promise.resolve(ok(body)));
      await expect(dblp.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
      await expect(dblp.search('x')).rejects.toThrow(/JSON in an unexpected shape/);
    }
  });

  it('says a 404 means no such record, not an outage', async () => {
    const missing = new DblpService(() => Promise.resolve(fail(404, 'Not Found')));
    await expect(missing.fetchBibtex('conf/x/y')).rejects.toThrow(
      /no record exists under this key/,
    );
  });

  it('tells a rate-limited caller to slow down', async () => {
    const dblp = new DblpService(() => Promise.resolve(fail(429, 'Too Many Requests')));
    await expect(dblp.search('x')).rejects.toThrow(/rate-limits/);
  });
});

describe('DblpService.fetchBibtex', () => {
  const BIB = '@inproceedings{DBLP:conf/cvpr/HeZRS16,\n  title = {Deep Residual Learning}\n}';

  it('fetches the standalone .bib for a key', async () => {
    let requested = '';
    const dblp = new DblpService((url) => {
      requested = url;
      return Promise.resolve(ok(BIB));
    });
    const text = await dblp.fetchBibtex('conf/cvpr/HeZRS16');
    expect(requested).toBe('https://dblp.org/rec/conf/cvpr/HeZRS16.bib?param=1');
    expect(text).toContain('@inproceedings');
  });

  it('accepts a full DBLP URL and normalizes it to the key', async () => {
    let requested = '';
    const dblp = new DblpService((url) => {
      requested = url;
      return Promise.resolve(ok(BIB));
    });
    await dblp.fetchBibtex('https://dblp.org/rec/conf/cvpr/HeZRS16.html');
    expect(requested).toBe('https://dblp.org/rec/conf/cvpr/HeZRS16.bib?param=1');
  });

  it('rejects an invalid/unsafe key without making a request', async () => {
    let called = false;
    const dblp = new DblpService(() => {
      called = true;
      return Promise.resolve(ok(BIB));
    });
    await expect(dblp.fetchBibtex('../../etc/passwd')).rejects.toThrow(/not a valid DBLP/);
    expect(called).toBe(false);
  });

  it('throws when the body is not BibTeX or the response fails', async () => {
    const html = new DblpService(() => Promise.resolve(ok('<html>not found</html>')));
    await expect(html.fetchBibtex('conf/x/y')).rejects.toThrow(/HTML page instead of API data/);

    const prose = new DblpService(() => Promise.resolve(ok('no entry here')));
    await expect(prose.fetchBibtex('conf/x/y')).rejects.toThrow(/No BibTeX/);

    const missing = new DblpService(() => Promise.resolve(fail(404, 'Not Found')));
    await expect(missing.fetchBibtex('conf/x/y')).rejects.toThrow(/404 Not Found/);
  });

  it('refuses the interstitial page on its "<" prefix, before any entry check runs', async () => {
    // Named for what it actually asserts: BOT_CHALLENGE starts with "<", so `assertApiBody`
    // refuses it and `BIBTEX_ENTRY` is never consulted. The @licstart hole is pinned by the
    // non-HTML test below — this one only proves the page never reaches the caller at all.
    const dblp = new DblpService(() => Promise.resolve(ok(BOT_CHALLENGE)));
    await expect(dblp.fetchBibtex('conf/cvpr/HeZRS16')).rejects.toThrow(
      /HTML page instead of API data/,
    );
  });

  it('keys a missing entry as a real answer, NOT a substitutable failure', async () => {
    // The value just outside BackendUnavailableError: DBLP answered, and said this key has no
    // record. No other backend can serve a DBLP key, so falling through would be wrong.
    const prose = new DblpService(() => Promise.resolve(ok('no entry here')));
    await expect(prose.fetchBibtex('conf/x/y')).rejects.not.toBeInstanceOf(BackendUnavailableError);
  });

  it('accepts a real entry whose only @ is the header', async () => {
    const dblp = new DblpService(() => Promise.resolve(ok(BIB)));
    expect(await dblp.fetchBibtex('conf/cvpr/HeZRS16')).toContain('@inproceedings');
  });

  it('rejects a NON-HTML body whose only "@" is an @licstart license header', async () => {
    // The hole `BIBTEX_ENTRY` actually plugs, and the one no other test in this file reaches:
    // every other @licstart fixture starts with "<", so `assertApiBody` refuses it first and the
    // entry check never runs. A bare JS/CSS body carrying the same header does get that far —
    // and the shipped `text.includes('@')` accepted it straight into a user's .bib.
    const dblp = new DblpService(() =>
      Promise.resolve(ok('/*\n@licstart The following is the entire license notice.\n@licend*/')),
    );
    await expect(dblp.fetchBibtex('conf/cvpr/HeZRS16')).rejects.toThrow(/No BibTeX/);
  });
});

describe('a TRANSPORT failure is substitutable, not a raw error', () => {
  // The gap this pins: every failure fixture in the suite was a hand-built
  // BackendUnavailableError, so the fallback was only ever proved against a fake that could not
  // exhibit the bug. A rejecting fetch — offline, DNS, ECONNREFUSED, timeout — escaped as a raw
  // TypeError, and the resolver rethrows anything that is not BackendUnavailableError, so a
  // timing-out backend aborted the chain instead of substituting.
  const reject = (err: unknown) => () => Promise.reject(err);

  it('Dblp.search converts a rejected fetch', async () => {
    const svc = new DblpService(
      reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })),
    );
    await expect(svc.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(svc.search('x')).rejects.toThrow(/could not be reached/);
    await expect(svc.search('x')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('Dblp names a timeout as a timeout', async () => {
    const svc = new DblpService(
      reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })),
    );
    await expect(svc.search('x')).rejects.toThrow(/timed out after 15s/);
  });

  it('Dblp’s by-record path converts a rejected fetch too', async () => {
    const svc = new DblpService(reject(new TypeError('fetch failed')));
    await expect(svc.fetchBibtex('conf/cvpr/HeZRS16')).rejects.toBeInstanceOf(
      BackendUnavailableError,
    );
  });
});

describe('a body-stream failure is substitutable too', () => {
  /**
   * A 200 whose BODY read fails. No `ok()`/`fail()` fixture can exhibit this — both resolve
   * `text()` — yet it is the likeliest DBLP failure of all: the timeout signal handed to
   * `fetch` governs the whole operation, body streaming included, so headers that arrive fast
   * (the anti-bot interstitial does exactly this) followed by a stalled body reject at
   * `res.text()`, not at the fetch call. An ECONNRESET mid-stream does the same.
   */
  function bodyFails(name = 'TimeoutError'): FetchResponse {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.reject(Object.assign(new Error('aborted'), { name })),
      json: () => Promise.reject(Object.assign(new Error('aborted'), { name })),
    };
  }

  it('DBLP.search converts a rejected body read', async () => {
    const svc = new DblpService(() => Promise.resolve(bodyFails()));
    await expect(svc.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(svc.search('x')).rejects.toThrow(/timed out after 15s/);
  });

  it('DBLP.fetchBibtex converts a rejected body read', async () => {
    const svc = new DblpService(() => Promise.resolve(bodyFails()));
    await expect(svc.fetchBibtex('conf/cvpr/HeZRS16')).rejects.toBeInstanceOf(
      BackendUnavailableError,
    );
  });

  it('a mid-body ECONNRESET is substitutable as well, not a raw TypeError', async () => {
    const svc = new DblpService(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.reject(new TypeError('terminated')),
        json: () => Promise.reject(new TypeError('terminated')),
      }),
    );
    await expect(svc.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
  });
});

describe('fetchBibtex returns the entry, not whatever else shares the body', () => {
  const ENTRY = '@inproceedings{Some:key,\n  title = {Deep Residual Learning}\n}';

  // `BIBTEX_ENTRY.test(text)` only proves an entry exists SOMEWHERE. The return value was the
  // WHOLE body, and `mergeBibEntry` appends it verbatim — so a proxy banner or a trailing
  // <script> landed in the user's .bib. The guarantee is that entry text originates from the
  // service; that is only sayable if the client can say WHICH bytes are the entry.
  it('returns a clean entry byte-identically', async () => {
    const svc = new DblpService(() => Promise.resolve(ok(ENTRY)));
    expect(await svc.fetchBibtex('conf/cvpr/HeZRS16')).toBe(ENTRY);
  });

  it('drops a leading error banner instead of handing it to the .bib', async () => {
    const svc = new DblpService(() => Promise.resolve(ok('Warning: proxy error<br>\n' + ENTRY)));
    const text = await svc.fetchBibtex('conf/cvpr/HeZRS16');
    expect(text).toBe(ENTRY);
    expect(text).not.toContain('proxy error');
  });

  it('refuses a body whose only entry header is mid-line', async () => {
    const svc = new DblpService(() =>
      Promise.resolve(ok('Warning: proxy error @article{evil, note={x}}')),
    );
    await expect(svc.fetchBibtex('conf/cvpr/HeZRS16')).rejects.toThrow(/No BibTeX/);
  });

  // Everything AFTER the entry reached the .bib just as surely as everything before it:
  // `mergeBibEntry` appends `entry.trim()` verbatim, so a trailing <script> or a paragraph of
  // prose landed in the bibliography whole. The client can only claim entry text originates
  // from the service if it can say where the entry ENDS as well as where it starts.
  it('drops a trailing <script> instead of handing it to the .bib', async () => {
    const svc = new DblpService(() => Promise.resolve(ok(ENTRY + '\n<script>alert(1)</script>')));
    const text = await svc.fetchBibtex('conf/cvpr/HeZRS16');
    expect(text).toBe(ENTRY);
    expect(text).not.toContain('script');
  });

  it('drops trailing prose after the entry', async () => {
    const svc = new DblpService(() =>
      Promise.resolve(
        ok(ENTRY + '\n\nRetrieved from dblp.org on Tuesday. Please cite responsibly.'),
      ),
    );
    expect(await svc.fetchBibtex('conf/cvpr/HeZRS16')).toBe(ENTRY);
  });

  it('keeps BOTH entries of a crossref-format body, byte-identically', async () => {
    // DBLP's `param=1` bib emits the @inproceedings plus the @proceedings its `crossref` field
    // names. Cutting at the first closing delimiter would corrupt the entry that survives —
    // worse than the trailing junk the cut exists to remove.
    const TWO = ENTRY + '\n\n@proceedings{DBLP:conf/cvpr/2016,\n  title = {CVPR 2016}\n}';
    const svc = new DblpService(() => Promise.resolve(ok(TWO)));
    expect(await svc.fetchBibtex('conf/cvpr/HeZRS16')).toBe(TWO);
  });

  it('fails OPEN on an unbalanced entry — the whole body, never a truncated one', async () => {
    // A half-parsed entry would be this server authoring BibTeX, and `assertApiBody` plus the
    // header check already stand in front of this. Pins the fallback, not a new behaviour.
    const BROKEN = '@inproceedings{Some:key,\n  title = {Deep {Residual Learning}\n';
    const svc = new DblpService(() => Promise.resolve(ok(BROKEN)));
    expect(await svc.fetchBibtex('conf/cvpr/HeZRS16')).toBe(BROKEN.trim());
  });
});

describe('an EMPTY 200 on the BibTeX path is a failure, not "no such record"', () => {
  // "No BibTeX entry found on DBLP for ..." is a confident claim about the user's record. A
  // truncated or empty body is not evidence for it — it is the backend failing to answer, and
  // the resolver must be free to substitute. The deliberate exception is the 404, which really
  // is DBLP saying the record does not exist, and is handled before this.
  it('reports an empty body as unavailable', async () => {
    const svc = new DblpService(() => Promise.resolve(ok('')));
    await expect(svc.fetchBibtex('conf/cvpr/HeZRS16')).rejects.toBeInstanceOf(
      BackendUnavailableError,
    );
    await expect(svc.fetchBibtex('conf/cvpr/HeZRS16')).rejects.not.toThrow(/No BibTeX entry found/);
  });

  it('reports a whitespace-only body as unavailable', async () => {
    const svc = new DblpService(() => Promise.resolve(ok('   \n\n  ')));
    await expect(svc.fetchBibtex('conf/cvpr/HeZRS16')).rejects.toBeInstanceOf(
      BackendUnavailableError,
    );
  });

  it('but a NON-empty body that is simply not BibTeX stays a plain answer', async () => {
    // The value just outside — widening past "empty" is a separate design call.
    const svc = new DblpService(() =>
      Promise.resolve(ok('Moved Permanently. See https://example.org/')),
    );
    await expect(svc.fetchBibtex('conf/cvpr/HeZRS16')).rejects.toThrow(/No BibTeX/);
    await expect(svc.fetchBibtex('conf/cvpr/HeZRS16')).rejects.not.toBeInstanceOf(
      BackendUnavailableError,
    );
  });
});

describe('DblpService.normalizeKey delegates to the one normalizer in src/lib', () => {
  // Two implementations of one security boundary is one edit away from two behaviours. The
  // comment that called the duplication deliberate cited a lib -> service dependency that the
  // delegation does not create: `dblp.ts` already imports from `referenceKey.ts`.
  function outcome(fn: () => string): { ok: string } | { rejected: true } {
    try {
      return { ok: fn() };
    } catch {
      return { rejected: true };
    }
  }

  const INPUTS = [
    // Accepted shapes, including every one `acceptedFormsMessage` advertises for DBLP.
    'conf/cvpr/HeZRS16',
    'journals/corr/abs-1512-03385',
    'www/HeZRS16',
    '  conf/cvpr/HeZRS16  ',
    '/conf/cvpr/HeZRS16',
    '///conf/cvpr/HeZRS16',
    'rec/conf/cvpr/HeZRS16',
    'REC/conf/cvpr/HeZRS16',
    'conf/cvpr/HeZRS16.bib',
    'conf/cvpr/HeZRS16.HTML',
    'conf/cvpr/HeZRS16.xml',
    'https://dblp.org/rec/conf/cvpr/HeZRS16.bib',
    'http://dblp.org/rec/conf/cvpr/HeZRS16',
    'https://dblp.uni-trier.de/rec/conf/cvpr/HeZRS16.xml',
    '10.1109/CVPR.2016.90',
    'W2194775991',
    // Refused shapes.
    '',
    '   ',
    'conf/../../etc/passwd',
    '../etc/passwd',
    'conf/x/y?a=b',
    'conf/x/y#frag',
    'conf x/y',
    '-conf/cvpr/HeZRS16',
    '.bib',
    // Host laundering — refused shapes like the rest, listed because this is where the two
    // implementations used to part company, so a re-divergence would show up here first.
    // What the laundering actually IS, and the assertion that it is refused rather than merely
    // refused-identically, live in "refuses to launder an unrecognised host into a DBLP key".
    'https://evil.com/rec/conf/cvpr/HeZRS16',
    'https://dblp.org@evil.com/rec/conf/cvpr/HeZRS16',
    'https://dblp.org.evil.com/rec/conf/x/y',
    'ftp://dblp.org/rec/conf/cvpr/HeZRS16',
  ];

  // A tautology while the delegation stands — `DblpService.normalizeKey` calls the very function
  // it is compared against — and that is the point: it is an anti-duplication tripwire, going red
  // the day someone reintroduces a second implementation. It detects nothing about any particular
  // input on its own, host laundering included; that is the next test's job.
  it('accepts the same set and returns the same id for every input', () => {
    for (const input of INPUTS) {
      expect(
        outcome(() => DblpService.normalizeKey(input)),
        `input: ${JSON.stringify(input)}`,
      ).toEqual(outcome(() => normalizeDblpKey(input)));
    }
  });

  it('keeps its own public error message, which callers may match on', () => {
    expect(() => DblpService.normalizeKey('conf/../../etc/passwd')).toThrow(
      '"conf/../../etc/passwd" is not a valid DBLP record key.',
    );
    expect(() => DblpService.normalizeKey('')).toThrow('"" is not a valid DBLP record key.');
    // And never leaks the lib normalizer's own, differently-worded refusal.
    expect(() => DblpService.normalizeKey('conf x/y')).not.toThrow(/not a valid reference key/);
  });

  // This is the test that actually detects host laundering. `normalizeKey` used to strip ANY
  // `scheme://host/`, so an unrecognised host's path came back as a DBLP key — exactly what
  // `tryParseUrl`'s refusal and the anchored strip in `normalizeDblpKey` close for every other
  // route in; delegating closed the last one. The pair below is what makes it detect rather than
  // merely compare: the foreign host is refused, and the real one still resolves.
  it('refuses to launder an unrecognised host into a DBLP key', () => {
    expect(() => DblpService.normalizeKey('https://evil.com/rec/conf/cvpr/HeZRS16')).toThrow(
      /not a valid DBLP record key/,
    );
    expect(DblpService.normalizeKey('https://dblp.org/rec/conf/cvpr/HeZRS16.bib')).toBe(
      'conf/cvpr/HeZRS16',
    );
  });
});

describe('a well-enveloped body whose ELEMENTS are malformed is unavailable, not a crash', () => {
  // The shape guard above inspects the ENVELOPE only (`result`, then the `hits` container).
  // Once it passes, the mapping step dereferenced every element blind, so a 200 with a perfect
  // envelope and unreadable contents escaped as a raw TypeError — and the resolver substitutes
  // a backend ONLY on BackendUnavailableError, rethrowing anything else. So one malformed body
  // from the first backend aborted the entire fallback chain, with the next backend holding a
  // perfectly good answer it was never asked for. Same class of hole `readBodyOrUnavailable`
  // closed one layer up; it survived in the mappers.

  it('refuses `hit: null` rather than reporting it as zero results', async () => {
    // DBLP's JSON is XML-derived: `hit` is ABSENT for zero results, an object for one, an array
    // for many. A proxy or cache spelling "no hits" as an explicit null clears the envelope
    // guard — and must NOT come back as `[]`, because the resolver treats an empty list as an
    // ANSWER: it would stop the chain and report "no results on dblp" for a search DBLP never
    // ran. The genuine empty answer (`hits` present, no `hit`) is pinned above and unchanged.
    const svc = new DblpService(() => Promise.resolve(ok('{"result":{"hits":{"hit":null}}}')));
    await expect(svc.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(svc.search('x')).rejects.not.toBeInstanceOf(TypeError);
    await expect(svc.search('x')).rejects.toThrow(/unexpected shape/);
  });

  it('refuses a null ELEMENT inside the hit array', async () => {
    const svc = new DblpService(() => Promise.resolve(ok('{"result":{"hits":{"hit":[null]}}}')));
    await expect(svc.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(svc.search('x')).rejects.not.toBeInstanceOf(TypeError);
  });

  it('refuses a hit whose title is not a string', async () => {
    // The field-by-field version of the same hole: `(info.title ?? '').replace` is a TypeError
    // for a numeric title. Guarding `title` alone would leave `year`, `venue`, `authors` and
    // every field nobody has thought of yet — which is why the mapping is wrapped whole.
    const svc = new DblpService(() =>
      Promise.resolve(
        ok(JSON.stringify({ result: { hits: { hit: [{ info: { key: 'a/b', title: 42 } }] } } })),
      ),
    );
    await expect(svc.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(svc.search('x')).rejects.not.toBeInstanceOf(TypeError);
  });

  it('still maps a well-formed body, and still answers a real empty search with []', async () => {
    // The values just outside, re-pinned here so a future "make it safe" cannot pass by
    // refusing everything: a good body still maps, and a genuine no-results body is still [].
    const good = new DblpService(() => Promise.resolve(ok(SEARCH_JSON)));
    expect((await good.search('x'))[0]?.key).toBe('dblp:conf/cvpr/HeZRS16');
    const none = new DblpService(() =>
      Promise.resolve(ok(JSON.stringify({ result: { hits: { '@total': '0' } } }))),
    );
    await expect(none.search('x')).resolves.toEqual([]);
  });
});

/**
 * The `init` the DEFAULT fetch arm hands the global `fetch`. Declared here rather than reaching
 * for a DOM `RequestInit`: the assertion below is only about the two fields this client sets.
 */
type FetchInit = { headers?: Record<string, string>; signal?: AbortSignal };

describe('the DEFAULT fetch arm attaches the shared request timeout', () => {
  // Every other test in this file INJECTS a fetchImpl, so the constructor's default arm — the
  // only code that ever attaches `signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)`, and the arm
  // `src/context.ts` actually runs in production — never executed under test at all. Deleting
  // the signal (and `timeoutSignal` with it) left the whole suite green while `transportReason`
  // went on telling users "the request timed out after 15s" about a wait that would never end.
  // The eslint rule over this file pins the constant's NAME and `AbortSignal.timeout`'s
  // argument, so it catches a renamed or drifting value — it cannot see a request that passes
  // no signal at all. This can.
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('passes AbortSignal.timeout(REQUEST_TIMEOUT_MS) to fetch on a search', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchSpy = vi.fn((_url: string, _init?: FetchInit) =>
      Promise.resolve(ok(JSON.stringify({ result: { hits: {} } }))),
    );
    vi.stubGlobal('fetch', fetchSpy);

    // No fetchImpl: this is the arm nothing else in the suite reaches.
    await new DblpService().search('x');

    // Asserting the SPY is the half that pins the DURATION — a timeout cannot be read back off
    // an AbortSignal, so `toBeInstanceOf(AbortSignal)` alone would pass on any value at all.
    expect(timeoutSpy).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
    const signal = timeoutSpy.mock.results[0]?.value as AbortSignal | undefined;
    expect(signal).toBeInstanceOf(AbortSignal);
    // And asserting the init is the half that pins that the signal is actually ATTACHED: a
    // `timeoutSignal()` computed and dropped on the floor would satisfy the spy alone.
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(signal);
  });
});

describe('a 404 addressing a RECORD is DBLP answering, not DBLP being down', () => {
  // `BackendUnavailableError` is documented as "never thrown for a caller error (e.g. an
  // invalid record key)", and `httpHint` says in as many words that "a 404 is the backend
  // answering, not the backend being down" — yet the record path threw the unavailable type for
  // every non-OK status, 404 included, then explained it with "no record exists under this key".
  // Harmless only while `ReferenceResolver.fetchBibtex` has no fallback; the moment one is added
  // the resolver would substitute on it — and substituting is wrong here by design, since a key
  // names one record in one backend and there is nothing to substitute to.
  it('throws a PLAIN Error for a 404 on fetchBibtex', async () => {
    const missing = new DblpService(() => Promise.resolve(fail(404, 'Not Found')));
    await expect(missing.fetchBibtex('conf/x/y')).rejects.not.toBeInstanceOf(
      BackendUnavailableError,
    );
    // Beside the type, so a refactor cannot satisfy the type check while losing the wording.
    await expect(missing.fetchBibtex('conf/x/y')).rejects.toThrow(
      /no record exists under this key/,
    );
  });

  it('but a 500 on the same path stays unavailable — the value just outside', async () => {
    const down = new DblpService(() => Promise.resolve(fail(500, 'Server Error')));
    await expect(down.fetchBibtex('conf/x/y')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(down.fetchBibtex('conf/x/y')).rejects.toThrow(/500 Server Error/);
  });

  // CONTROL — passes before and after this change, deliberately. A search names no record, so a
  // 404 there is a wrong base URL or a changed path: the backend genuinely failing to answer,
  // and substitutable. Kept so the record-path change cannot be over-applied to searches.
  it('CONTROL: a 404 on a SEARCH stays a substitutable failure', async () => {
    const svc = new DblpService(() => Promise.resolve(fail(404, 'Not Found')));
    await expect(svc.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(svc.search('x')).rejects.toThrow(/404 Not Found/);
  });
});

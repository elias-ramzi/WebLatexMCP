import { describe, it, expect, afterEach, vi } from 'vitest';
import { CrossrefService, type FetchResponse } from '../../src/services/crossref.js';
import {
  BackendUnavailableError,
  REQUEST_TIMEOUT_MS,
} from '../../src/services/referenceBackend.js';
import { getServerVersion } from '../../src/lib/version.js';
import { readFileSync } from 'node:fs';

/**
 * The repo URL the polite-pool User-Agent must lead to, read from package.json so the two
 * cannot drift. Identifying honestly is the whole point of the polite pool; a URL that 404s
 * identifies nobody, and the shipped one named a GitHub account that does not exist.
 */
function repoUrl(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    repository?: { url?: string };
  };
  const url = (pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
  // Fail closed: a missing `repository.url` would make this '' and turn every assertion below
  // into `toContain('')`, which passes for any string — the pin would go silently vacuous.
  expect(url).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+$/);
  return url;
}

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
 * A bot-challenge/interstitial page in the same shape DBLP's serves — HTTP **200**, HTML
 * body, and an inline `@licstart` license header that would satisfy a naive "contains an
 * @" BibTeX check.
 */
const BOT_CHALLENGE =
  '<!doctype html><html lang="en"><head><title>Making sure you&#39;re not a bot!</title>' +
  '</head><body><script>/*\n@licstart The following is the entire license notice.\n' +
  'Copyright (c) 2026 Xe Iaso <xe.iaso@techaro.lol>\n@licend*/</script></body></html>';

const RESNET_ITEM = {
  DOI: '10.1109/CVPR.2016.90',
  title: ['Deep Residual Learning for Image Recognition'],
  author: [
    { given: 'Kaiming', family: 'He', sequence: 'first' },
    { given: 'Xiangyu', family: 'Zhang', sequence: 'additional' },
  ],
  issued: { 'date-parts': [[2016]] },
  'container-title': ['2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)'],
  'short-container-title': ['CVPR'],
  type: 'proceedings-article',
  URL: 'https://doi.org/10.1109/CVPR.2016.90',
};

function searchBody(items: unknown[]): string {
  return JSON.stringify({ message: { items } });
}

describe('CrossrefService.search', () => {
  it('parses a realistic payload: title array, given+family authors, issued year, venue, key', async () => {
    let requested = '';
    const crossref = new CrossrefService((url) => {
      requested = url;
      return Promise.resolve(ok(searchBody([RESNET_ITEM])));
    });
    const hits = await crossref.search('deep residual learning', { maxResults: 5 });

    expect(requested).toContain('query.bibliographic=deep%20residual%20learning');
    expect(requested).toContain('rows=5');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      key: 'crossref:10.1109/CVPR.2016.90',
      source: 'crossref',
      title: 'Deep Residual Learning for Image Recognition',
      authors: ['Kaiming He', 'Xiangyu Zhang'],
      year: 2016,
      venue: '2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)',
      doi: '10.1109/CVPR.2016.90',
    });
  });

  it('uses query.bibliographic (not plain query) and carries mailto only when configured', async () => {
    let requestedNoEmail = '';
    const noEmail = new CrossrefService((url) => {
      requestedNoEmail = url;
      return Promise.resolve(ok(searchBody([RESNET_ITEM])));
    });
    await noEmail.search('resnet');
    expect(requestedNoEmail).toContain('query.bibliographic=');
    expect(requestedNoEmail).not.toContain('query=resnet');
    expect(requestedNoEmail).not.toContain('mailto=');

    let requestedWithEmail = '';
    const withEmail = new CrossrefService(
      (url) => {
        requestedWithEmail = url;
        return Promise.resolve(ok(searchBody([RESNET_ITEM])));
      },
      { contactEmail: 'elias.ramzi@gmail.com' },
    );
    await withEmail.search('resnet');
    expect(requestedWithEmail).toContain('mailto=elias.ramzi%40gmail.com');
  });

  it('sends a User-Agent naming the server version, with mailto only when configured', async () => {
    let headersNoEmail: Record<string, string> | undefined;
    const noEmail = new CrossrefService((url, init) => {
      headersNoEmail = init?.headers;
      return Promise.resolve(ok(searchBody([RESNET_ITEM])));
    });
    await noEmail.search('resnet');
    expect(headersNoEmail?.['User-Agent']).toContain('web-latex-mcp/');
    expect(headersNoEmail?.['User-Agent']).toContain(getServerVersion());
    expect(headersNoEmail?.['User-Agent']).not.toContain('mailto:');

    let headersWithEmail: Record<string, string> | undefined;
    const withEmail = new CrossrefService(
      (url, init) => {
        headersWithEmail = init?.headers;
        return Promise.resolve(ok(searchBody([RESNET_ITEM])));
      },
      { contactEmail: 'elias.ramzi@gmail.com' },
    );
    await withEmail.search('resnet');
    expect(headersWithEmail?.['User-Agent']).toContain('mailto:elias.ramzi@gmail.com');
  });

  it('maps an organisation author and a family-only author', async () => {
    const item = {
      DOI: '10.1234/org',
      title: ['Some Report'],
      author: [{ name: 'Some Consortium', sequence: 'first' }, { family: 'Solo' }],
      issued: { 'date-parts': [[2020]] },
    };
    const crossref = new CrossrefService(() => Promise.resolve(ok(searchBody([item]))));
    const hits = await crossref.search('report');
    expect(hits[0]?.authors).toEqual(['Some Consortium', 'Solo']);
  });

  it('skips an item with no DOI, and yields no year (not NaN) for empty date-parts', async () => {
    const noDoi = { title: ['No DOI Here'], author: [] };
    const emptyDateParts = {
      DOI: '10.1234/x',
      title: ['Empty Date Parts'],
      issued: { 'date-parts': [[]] },
    };
    const crossref = new CrossrefService(() =>
      Promise.resolve(ok(searchBody([noDoi, emptyDateParts]))),
    );
    const hits = await crossref.search('x');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.doi).toBe('10.1234/x');
    expect(hits[0]?.year).toBeUndefined();
    expect(Number.isNaN(hits[0]?.year)).toBe(false);
  });

  it('identifies the project with the repo URL from package.json, not a 404ing one', async () => {
    let headers: Record<string, string> | undefined;
    const svc = new CrossrefService((url, init) => {
      headers = init?.headers;
      return Promise.resolve(ok(searchBody([RESNET_ITEM])));
    });
    await svc.search('x');
    expect(headers?.['User-Agent']).toContain(repoUrl());
  });

  it('skips an item whose DOI would not round-trip as a record key', async () => {
    // `formatRecordKey` composes blindly, so an odd DOI produced a key the server itself
    // refuses when `add_citation` parses it back — a result the user can see but not use.
    // `extractWorkId` in the openalex client already skips rather than emitting such a key.
    const spaced = { DOI: '10.1234/has space', title: ['Spaced'] };
    const quoted = { DOI: '10.1234/has"quote', title: ['Quoted'] };
    const svc = new CrossrefService(() =>
      Promise.resolve(ok(searchBody([spaced, quoted, RESNET_ITEM]))),
    );
    const hits = await svc.search('x');
    expect(hits.map((h) => h.key)).toEqual(['crossref:10.1109/CVPR.2016.90']);
  });

  it('rejects an empty query and makes no request', async () => {
    let calls = 0;
    const crossref = new CrossrefService(() => {
      calls += 1;
      return Promise.resolve(ok(searchBody([RESNET_ITEM])));
    });
    await expect(crossref.search('   ')).rejects.toThrow(/must not be empty/);
    expect(calls).toBe(0);
  });

  it('surfaces HTTP failures via BackendUnavailableError, and names rate limiting on 429', async () => {
    const serverError = new CrossrefService(() => Promise.resolve(fail(500, 'Internal Error')));
    await expect(serverError.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(serverError.search('x')).rejects.toThrow(/500 Internal Error/);

    const rateLimited = new CrossrefService(() => Promise.resolve(fail(429, 'Too Many Requests')));
    await expect(rateLimited.search('x')).rejects.toThrow(/rate-limits/);
  });

  it('names a 200 bot-challenge HTML body rather than dying inside JSON.parse', async () => {
    const crossref = new CrossrefService(() => Promise.resolve(ok(BOT_CHALLENGE)));
    await expect(crossref.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(crossref.search('x')).rejects.toThrow(/HTML page instead of API data/);
    await expect(crossref.search('x')).rejects.not.toThrow(/Unexpected token/);
  });

  it('reports an unparseable non-HTML body as unavailable', async () => {
    const crossref = new CrossrefService(() => Promise.resolve(ok('not json at all')));
    await expect(crossref.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(crossref.search('x')).rejects.toThrow(/not JSON.*not json at all/s);
  });
});

describe('CrossrefService.fetchBibtex', () => {
  const BIB = '@inproceedings{He_2016,\n  title={Deep Residual Learning for Image Recognition}\n}';

  it('fetches the transform for a DOI', async () => {
    let requested = '';
    let acceptHeader: string | undefined;
    const crossref = new CrossrefService((url, init) => {
      requested = url;
      acceptHeader = init?.headers?.Accept;
      return Promise.resolve(ok(BIB));
    });
    const text = await crossref.fetchBibtex('10.1109/CVPR.2016.90');
    expect(requested).toBe('https://api.crossref.org/works/10.1109/CVPR.2016.90/transform');
    expect(acceptHeader).toBe('application/x-bibtex');
    expect(text).toContain('@inproceedings');
  });

  it('accepts a crossref: or doi: prefixed key', async () => {
    let requested = '';
    const crossref = new CrossrefService((url) => {
      requested = url;
      return Promise.resolve(ok(BIB));
    });
    await crossref.fetchBibtex('crossref:10.1109/CVPR.2016.90');
    expect(requested).toBe('https://api.crossref.org/works/10.1109/CVPR.2016.90/transform');

    await crossref.fetchBibtex('doi:10.1109/CVPR.2016.90');
    expect(requested).toBe('https://api.crossref.org/works/10.1109/CVPR.2016.90/transform');
  });

  it('rejects a key belonging to a different source, without needing a request', async () => {
    const crossref = new CrossrefService(() => Promise.resolve(ok(BIB)));
    await expect(crossref.fetchBibtex('dblp:conf/cvpr/HeZRS16')).rejects.toThrow(/dblp/);
  });

  it('rejects a path-traversal attempt and makes no request', async () => {
    let called = false;
    const crossref = new CrossrefService(() => {
      called = true;
      return Promise.resolve(ok(BIB));
    });
    // Note this one never reaches Crossref's own DOI validation: it fails as a malformed *DBLP*
    // key, since an unprefixed string routes to dblp. The crossref:-prefixed case below is what
    // actually exercises `normalizeDoi`'s ".." check.
    await expect(crossref.fetchBibtex('../../etc/passwd')).rejects.toThrow(
      /not a valid reference key/,
    );
    expect(called).toBe(false);
  });

  it('rejects a crossref-prefixed path traversal in the DOI itself', async () => {
    let called = false;
    const crossref = new CrossrefService(() => {
      called = true;
      return Promise.resolve(ok(BIB));
    });
    await expect(crossref.fetchBibtex('crossref:10.1234/../../x')).rejects.toThrow(
      /not a valid reference key/,
    );
    expect(called).toBe(false);
  });

  it('refuses the interstitial page on its "<" prefix, before any entry check runs', async () => {
    // Named for what it actually asserts: BOT_CHALLENGE starts with "<", so `assertApiBody`
    // refuses it and `BIBTEX_ENTRY` is never consulted. The @licstart hole is pinned by the
    // non-HTML test below — this one only proves the page never reaches the caller at all.
    const crossref = new CrossrefService(() => Promise.resolve(ok(BOT_CHALLENGE)));
    await expect(crossref.fetchBibtex('10.1109/CVPR.2016.90')).rejects.toThrow(
      /HTML page instead of API data/,
    );
  });

  it('rejects a NON-HTML body whose only "@" is an @licstart license header', async () => {
    // The hole `BIBTEX_ENTRY` actually plugs, and the one no other test in this file reaches:
    // every other @licstart fixture starts with "<", so `assertApiBody` refuses it first and the
    // entry check never runs. A bare JS/CSS body carrying the same header does get that far —
    // and the shipped `text.includes('@')` accepted it straight into a user's .bib.
    const crossref = new CrossrefService(() =>
      Promise.resolve(ok('/*\n@licstart The following is the entire license notice.\n@licend*/')),
    );
    await expect(crossref.fetchBibtex('10.1109/CVPR.2016.90')).rejects.toThrow(/No BibTeX/);
  });

  it('rejects a plain non-BibTeX text body as a real (non-substitutable) answer', async () => {
    const crossref = new CrossrefService(() => Promise.resolve(ok('no entry here')));
    await expect(crossref.fetchBibtex('10.1109/CVPR.2016.90')).rejects.toThrow(/No BibTeX/);
    await expect(crossref.fetchBibtex('10.1109/CVPR.2016.90')).rejects.not.toBeInstanceOf(
      BackendUnavailableError,
    );
  });

  it('surfaces a non-OK HTTP response as unavailable', async () => {
    // The unavailable assertion moved off the 404 and onto a 500: a 404 here names a record
    // Crossref says it does not have, which is the backend ANSWERING, so it is now a plain
    // Error — see "a 404 addressing a RECORD is Crossref answering" below. Every other non-OK
    // status is still the backend failing to answer. The 404's own status text is still pinned
    // here, since that half of the message is unchanged.
    const down = new CrossrefService(() => Promise.resolve(fail(500, 'Internal Error')));
    await expect(down.fetchBibtex('10.1109/CVPR.2016.90')).rejects.toBeInstanceOf(
      BackendUnavailableError,
    );
    await expect(down.fetchBibtex('10.1109/CVPR.2016.90')).rejects.toThrow(/500 Internal Error/);

    const crossref = new CrossrefService(() => Promise.resolve(fail(404, 'Not Found')));
    await expect(crossref.fetchBibtex('10.1109/CVPR.2016.90')).rejects.toThrow(/404 Not Found/);
  });

  it('per-segment encodes the DOI in the transform URL, keeping the structural "/"', async () => {
    let requested = '';
    const crossref = new CrossrefService((url) => {
      requested = url;
      return Promise.resolve(ok('@inproceedings{x, title={T}}'));
    });
    // ":" is a legal DOI character that still needs percent-encoding; the structural "/"
    // between registrant/suffix and inside the suffix must survive un-encoded.
    await crossref.fetchBibtex('crossref:10.1234/a:b/c');
    expect(requested).toBe('https://api.crossref.org/works/10.1234/a%3Ab/c/transform');
  });
});

describe('a 200 carrying JSON of the wrong shape', () => {
  it('is unavailable, not zero results', async () => {
    // Crossref's own validation-failure envelope parses fine and has no `message.items`.
    // Returning [] would halt the resolver's fallback and report "no results" for a search
    // that never ran — the exact zero-result/unreachable conflation the design forbids.
    const svc = new CrossrefService(() => Promise.resolve(ok('{"status":"error","message":[]}')));
    await expect(svc.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(svc.search('x')).rejects.toThrow(/JSON in an unexpected shape/);
  });

  it('but a present-but-empty message IS a real empty answer', async () => {
    const svc = new CrossrefService(() =>
      Promise.resolve(ok(JSON.stringify({ message: { items: [] } }))),
    );
    await expect(svc.search('x')).resolves.toEqual([]);
  });
});

describe('a TRANSPORT failure is substitutable, not a raw error', () => {
  // The gap this pins: every failure fixture in the suite was a hand-built
  // BackendUnavailableError, so the fallback was only ever proved against a fake that could not
  // exhibit the bug. A rejecting fetch — offline, DNS, ECONNREFUSED, timeout — escaped as a raw
  // TypeError, and the resolver rethrows anything that is not BackendUnavailableError, so a
  // timing-out backend aborted the chain instead of substituting.
  const reject = (err: unknown) => () => Promise.reject(err);

  it('Crossref.search converts a rejected fetch', async () => {
    const svc = new CrossrefService(
      reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })),
    );
    await expect(svc.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(svc.search('x')).rejects.toThrow(/could not be reached/);
    await expect(svc.search('x')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('Crossref names a timeout as a timeout', async () => {
    const svc = new CrossrefService(
      reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })),
    );
    await expect(svc.search('x')).rejects.toThrow(/timed out after 15s/);
  });

  it('Crossref’s by-record path converts a rejected fetch too', async () => {
    const svc = new CrossrefService(reject(new TypeError('fetch failed')));
    await expect(svc.fetchBibtex('crossref:10.1109/CVPR.2016.90')).rejects.toBeInstanceOf(
      BackendUnavailableError,
    );
  });
});

describe('a body-stream failure is substitutable too', () => {
  /**
   * A 200 whose BODY read fails. No `ok()`/`fail()` fixture can exhibit this — both resolve
   * `text()` — yet the timeout signal handed to `fetch` governs the whole operation, body
   * streaming included: headers that arrive fast followed by a stalled body reject at
   * `res.text()`, not at the fetch call. An ECONNRESET mid-stream does the same.
   */
  function bodyFails(): FetchResponse {
    const boom = () =>
      Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    return { ok: true, status: 200, statusText: 'OK', text: boom, json: boom };
  }

  it('Crossref.search converts a rejected body read', async () => {
    const svc = new CrossrefService(() => Promise.resolve(bodyFails()));
    await expect(svc.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(svc.search('x')).rejects.toThrow(/timed out after 15s/);
  });

  it('Crossref.fetchBibtex converts a rejected body read', async () => {
    const svc = new CrossrefService(() => Promise.resolve(bodyFails()));
    await expect(svc.fetchBibtex('crossref:10.1109/CVPR.2016.90')).rejects.toBeInstanceOf(
      BackendUnavailableError,
    );
  });
});

describe('fetchBibtex returns the entry, not whatever else shares the body', () => {
  const ENTRY = '@inproceedings{Some:key,\n  title = {Deep Residual Learning}\n}';

  // `BIBTEX_ENTRY.test(text)` only proves an entry exists SOMEWHERE. The return value was the
  // WHOLE body, and `mergeBibEntry` appends it verbatim — so a proxy banner or a trailing
  // <script> landed in the user's .bib. The guarantee is that entry text originates from the
  // service; that is only sayable if the client can say WHICH bytes are the entry.
  it('returns a clean entry byte-identically', async () => {
    const svc = new CrossrefService(() => Promise.resolve(ok(ENTRY)));
    expect(await svc.fetchBibtex('10.1109/CVPR.2016.90')).toBe(ENTRY);
  });

  it('drops a leading error banner instead of handing it to the .bib', async () => {
    const svc = new CrossrefService(() =>
      Promise.resolve(ok('Warning: proxy error<br>\n' + ENTRY)),
    );
    const text = await svc.fetchBibtex('10.1109/CVPR.2016.90');
    expect(text).toBe(ENTRY);
    expect(text).not.toContain('proxy error');
  });

  it('refuses a body whose only entry header is mid-line', async () => {
    const svc = new CrossrefService(() =>
      Promise.resolve(ok('Warning: proxy error @article{evil, note={x}}')),
    );
    await expect(svc.fetchBibtex('10.1109/CVPR.2016.90')).rejects.toThrow(/No BibTeX/);
  });

  // The trailing half of the same hole: `mergeBibEntry` appends what it is handed verbatim, so
  // anything after the entry reached the user's .bib too.
  it('drops a trailing <script> instead of handing it to the .bib', async () => {
    const svc = new CrossrefService(() =>
      Promise.resolve(ok(ENTRY + '\n<script>alert(1)</script>')),
    );
    const text = await svc.fetchBibtex('10.1109/CVPR.2016.90');
    expect(text).toBe(ENTRY);
    expect(text).not.toContain('script');
  });

  it('drops trailing prose after the entry', async () => {
    const svc = new CrossrefService(() =>
      Promise.resolve(ok(ENTRY + '\n\nRetrieved from api.crossref.org. Please cite responsibly.')),
    );
    expect(await svc.fetchBibtex('10.1109/CVPR.2016.90')).toBe(ENTRY);
  });

  it('keeps BOTH entries of a two-entry body, byte-identically', async () => {
    const TWO = ENTRY + '\n\n@proceedings{Some:proc,\n  title = {CVPR 2016}\n}';
    const svc = new CrossrefService(() => Promise.resolve(ok(TWO)));
    expect(await svc.fetchBibtex('10.1109/CVPR.2016.90')).toBe(TWO);
  });

  it('fails OPEN on an unbalanced entry — the whole body, never a truncated one', async () => {
    const BROKEN = '@article{Some:key,\n  title = {Deep {Residual Learning}\n';
    const svc = new CrossrefService(() => Promise.resolve(ok(BROKEN)));
    expect(await svc.fetchBibtex('10.1109/CVPR.2016.90')).toBe(BROKEN.trim());
  });
});

describe('an EMPTY 200 on the BibTeX path is a failure, not "no such record"', () => {
  // "No BibTeX entry found on Crossref for ..." is a confident claim about the user's record. A
  // truncated or empty body is not evidence for it — it is the backend failing to answer, and
  // the resolver must be free to substitute. The deliberate exception is the 404, which really
  // is Crossref saying the record does not exist, and is handled before this.
  it('reports an empty body as unavailable', async () => {
    const svc = new CrossrefService(() => Promise.resolve(ok('')));
    await expect(svc.fetchBibtex('10.1109/CVPR.2016.90')).rejects.toBeInstanceOf(
      BackendUnavailableError,
    );
    await expect(svc.fetchBibtex('10.1109/CVPR.2016.90')).rejects.not.toThrow(
      /No BibTeX entry found/,
    );
  });

  it('reports a whitespace-only body as unavailable', async () => {
    const svc = new CrossrefService(() => Promise.resolve(ok('   \n\n  ')));
    await expect(svc.fetchBibtex('10.1109/CVPR.2016.90')).rejects.toBeInstanceOf(
      BackendUnavailableError,
    );
  });

  it('but a NON-empty body that is simply not BibTeX stays a plain answer', async () => {
    // The value just outside — widening past "empty" is a separate design call.
    const svc = new CrossrefService(() =>
      Promise.resolve(ok('Moved Permanently. See https://example.org/')),
    );
    await expect(svc.fetchBibtex('10.1109/CVPR.2016.90')).rejects.toThrow(/No BibTeX/);
    await expect(svc.fetchBibtex('10.1109/CVPR.2016.90')).rejects.not.toBeInstanceOf(
      BackendUnavailableError,
    );
  });
});

describe('a well-enveloped body whose ELEMENTS are malformed is unavailable, not a crash', () => {
  // The shape guard inspects the ENVELOPE only (`message` is an object, `items` is an array).
  // Past it the mapping dereferenced every item blind, so a well-enveloped 200 carrying junk
  // escaped as a raw TypeError — which the resolver rethrows instead of substituting, aborting
  // the fallback chain. Wrapped whole rather than guarded field by field: the guarantee has to
  // hold for the fields nobody has thought of yet.

  it('refuses a null ELEMENT inside items', async () => {
    const svc = new CrossrefService(() => Promise.resolve(ok('{"message":{"items":[null]}}')));
    await expect(svc.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(svc.search('x')).rejects.not.toBeInstanceOf(TypeError);
  });

  it('refuses an item whose author list is not a list', async () => {
    const svc = new CrossrefService(() =>
      Promise.resolve(
        ok(JSON.stringify({ message: { items: [{ DOI: '10.1109/cvpr.2016.90', author: 42 }] } })),
      ),
    );
    await expect(svc.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(svc.search('x')).rejects.not.toBeInstanceOf(TypeError);
  });

  it('still maps a well-formed body, and still answers a real empty search with []', async () => {
    // The values just outside: refusing everything would satisfy the tests above and nothing else.
    const good = new CrossrefService(() =>
      Promise.resolve(
        ok(
          JSON.stringify({
            message: {
              items: [{ DOI: '10.1109/cvpr.2016.90', title: ['Deep Residual Learning'] }],
            },
          }),
        ),
      ),
    );
    expect((await good.search('x'))[0]?.doi).toBe('10.1109/cvpr.2016.90');
    const none = new CrossrefService(() =>
      Promise.resolve(ok(JSON.stringify({ message: { items: [] } }))),
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
      Promise.resolve(ok(JSON.stringify({ message: { items: [] } }))),
    );
    vi.stubGlobal('fetch', fetchSpy);

    // No fetchImpl: this is the arm nothing else in the suite reaches.
    await new CrossrefService().search('x');

    // Asserting the SPY is the half that pins the DURATION — a timeout cannot be read back off
    // an AbortSignal, so `toBeInstanceOf(AbortSignal)` alone would pass on any value at all.
    expect(timeoutSpy).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
    const signal = timeoutSpy.mock.results[0]?.value as AbortSignal | undefined;
    expect(signal).toBeInstanceOf(AbortSignal);
    // And asserting the init is the half that pins that the signal is actually ATTACHED: a
    // `timeoutSignal()` computed and dropped on the floor would satisfy the spy alone.
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(signal);
    // The polite-pool header still rides along on the same init — the signal is added to it,
    // not substituted for it.
    expect(fetchSpy.mock.calls[0]?.[1]?.headers?.['User-Agent']).toContain('web-latex-mcp/');
  });
});

describe('a 404 addressing a RECORD is Crossref answering, not Crossref being down', () => {
  // `BackendUnavailableError` is documented as "never thrown for a caller error (e.g. an
  // invalid record key)", and `httpHint` says in as many words that "a 404 is the backend
  // answering, not the backend being down" — yet the record path threw the unavailable type for
  // every non-OK status, 404 included, then explained it with "no record exists under this key".
  // Harmless only while `ReferenceResolver.fetchBibtex` has no fallback; the moment one is added
  // the resolver would substitute on it — and substituting is wrong here by design, since a DOI
  // names one record and there is nothing to substitute to.
  it('throws a PLAIN Error for a 404 on fetchBibtex', async () => {
    const missing = new CrossrefService(() => Promise.resolve(fail(404, 'Not Found')));
    await expect(missing.fetchBibtex('10.1109/CVPR.2016.90')).rejects.not.toBeInstanceOf(
      BackendUnavailableError,
    );
    // Beside the type, so a refactor cannot satisfy the type check while losing the wording.
    await expect(missing.fetchBibtex('10.1109/CVPR.2016.90')).rejects.toThrow(
      /no record exists under this key/,
    );
  });

  it('but a 500 on the same path stays unavailable — the value just outside', async () => {
    const down = new CrossrefService(() => Promise.resolve(fail(500, 'Server Error')));
    await expect(down.fetchBibtex('10.1109/CVPR.2016.90')).rejects.toBeInstanceOf(
      BackendUnavailableError,
    );
    await expect(down.fetchBibtex('10.1109/CVPR.2016.90')).rejects.toThrow(/500 Server Error/);
  });

  // CONTROL — passes before and after this change, deliberately. A search names no record, so a
  // 404 there is a wrong base URL or a changed path: the backend genuinely failing to answer,
  // and substitutable. Kept so the record-path change cannot be over-applied to searches.
  it('CONTROL: a 404 on a SEARCH stays a substitutable failure', async () => {
    const svc = new CrossrefService(() => Promise.resolve(fail(404, 'Not Found')));
    await expect(svc.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(svc.search('x')).rejects.toThrow(/404 Not Found/);
  });
});

import { describe, it, expect } from 'vitest';
import { OpenAlexService, type FetchResponse } from '../../src/services/openalex.js';
import { BackendUnavailableError } from '../../src/services/referenceBackend.js';
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
 * A bot-challenge interstitial in the same shape as DBLP's — HTTP **200**, HTML body. OpenAlex
 * is not currently known to serve one, but the client must sniff the body regardless of which
 * upstream sends it: `assertApiBody` is shared plumbing, and this pins that OpenAlex wires it up.
 */
const BOT_CHALLENGE =
  '<!doctype html><html lang="en"><head><title>Making sure you&#39;re not a bot!</title>' +
  '</head><body><script>/*\n@licstart The following is the entire license notice.\n' +
  'Copyright (c) 2026 Xe Iaso <xe.iaso@techaro.lol>\n@licend*/</script></body></html>';

/**
 * A realistic `/works` search payload — real field shapes verified live against the OpenAlex
 * API, including the traps: `primary_location.source` is `null` (not absent), `id` is a full
 * URL, and `doi` is a full `doi.org` URL.
 */
const SEARCH_JSON = JSON.stringify({
  results: [
    {
      id: 'https://openalex.org/W2194775991',
      display_name: 'Deep Residual Learning for Image Recognition',
      authorships: [
        { author: { display_name: 'Kaiming He' } },
        { author: { display_name: 'Xiangyu Zhang' } },
      ],
      publication_year: 2016,
      primary_location: { source: null },
      type: 'proceedings-article',
      doi: 'https://doi.org/10.1109/cvpr.2016.90',
    },
  ],
});

describe('OpenAlexService.search', () => {
  it('parses a realistic payload: title, authors, year, and a stripped-id key', async () => {
    const svc = new OpenAlexService(() => Promise.resolve(ok(SEARCH_JSON)));
    const hits = await svc.search('deep residual');

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      key: 'openalex:W2194775991',
      source: 'openalex',
      title: 'Deep Residual Learning for Image Recognition',
      authors: ['Kaiming He', 'Xiangyu Zhang'],
      year: 2016,
    });
  });

  it('primary_location.source === null yields no venue and does not throw', async () => {
    // The real-payload trap: `source` is present but null, not merely absent. Both levels of
    // optional chaining must be exercised or this throws instead of returning `undefined`.
    const svc = new OpenAlexService(() => Promise.resolve(ok(SEARCH_JSON)));
    const hits = await svc.search('deep residual');
    expect(hits[0]?.venue).toBeUndefined();
  });

  it('falls back to best_oa_location when primary_location has no source', async () => {
    const withOa = JSON.stringify({
      results: [
        {
          id: 'https://openalex.org/W1',
          display_name: 'Oa Fallback',
          primary_location: { source: null },
          best_oa_location: { source: { display_name: 'arXiv' } },
        },
      ],
    });
    const svc = new OpenAlexService(() => Promise.resolve(ok(withOa)));
    const hits = await svc.search('oa fallback');
    expect(hits[0]?.venue).toBe('arXiv');
  });

  it('strips a doi.org URL to the bare DOI, and handles dx.doi.org / absent / null', async () => {
    const payload = JSON.stringify({
      results: [
        {
          id: 'https://openalex.org/W1',
          display_name: 'A',
          doi: 'https://doi.org/10.1109/cvpr.2016.90',
        },
        { id: 'https://openalex.org/W2', display_name: 'B', doi: 'http://dx.doi.org/10.1/xyz' },
        { id: 'https://openalex.org/W3', display_name: 'C' },
        { id: 'https://openalex.org/W4', display_name: 'D', doi: null },
      ],
    });
    const svc = new OpenAlexService(() => Promise.resolve(ok(payload)));
    const hits = await svc.search('doi shapes');
    expect(hits.map((h) => h.doi)).toEqual([
      '10.1109/cvpr.2016.90',
      '10.1/xyz',
      undefined,
      undefined,
    ]);
  });

  it('skips a result whose id is not a valid OpenAlex work URL', async () => {
    const payload = JSON.stringify({
      results: [
        { id: 'not-a-work-url', display_name: 'Bad id' },
        { id: 'https://openalex.org/notawork', display_name: 'Bad suffix' },
        { id: 'https://openalex.org/W42', display_name: 'Good' },
      ],
    });
    const svc = new OpenAlexService(() => Promise.resolve(ok(payload)));
    const hits = await svc.search('mixed ids');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.key).toBe('openalex:W42');
  });

  it('carries per-page and search in the request URL', async () => {
    let requested = '';
    const svc = new OpenAlexService((url) => {
      requested = url;
      return Promise.resolve(ok(SEARCH_JSON));
    });
    await svc.search('deep residual', { maxResults: 5 });
    expect(requested).toContain(`${'https://api.openalex.org'}/works?search=deep%20residual`);
    expect(requested).toContain('per-page=5');
  });

  it('adds mailto to the query only when a contact email is configured', async () => {
    let withoutEmail = '';
    const noEmail = new OpenAlexService((url) => {
      withoutEmail = url;
      return Promise.resolve(ok(SEARCH_JSON));
    });
    await noEmail.search('x');
    expect(withoutEmail).not.toContain('mailto');

    let withEmail = '';
    const withEmailSvc = new OpenAlexService(
      (url) => {
        withEmail = url;
        return Promise.resolve(ok(SEARCH_JSON));
      },
      { contactEmail: 'dev@example.com' },
    );
    await withEmailSvc.search('x');
    expect(withEmail).toContain('mailto=dev%40example.com');
  });

  it('sends a User-Agent naming the version, with mailto: only when configured', async () => {
    let headersSeen: Record<string, string> | undefined;
    const noEmail = new OpenAlexService((url, init) => {
      headersSeen = init?.headers;
      return Promise.resolve(ok(SEARCH_JSON));
    });
    await noEmail.search('x');
    expect(headersSeen?.['User-Agent']).toContain(`web-latex-mcp/${getServerVersion()}`);
    expect(headersSeen?.['User-Agent']).not.toContain('mailto:');

    let headersWithEmail: Record<string, string> | undefined;
    const withEmail = new OpenAlexService(
      (url, init) => {
        headersWithEmail = init?.headers;
        return Promise.resolve(ok(SEARCH_JSON));
      },
      { contactEmail: 'dev@example.com' },
    );
    await withEmail.search('x');
    expect(headersWithEmail?.['User-Agent']).toContain('mailto:dev@example.com');
  });

  it('identifies the project with the repo URL from package.json, not a 404ing one', async () => {
    let headers: Record<string, string> | undefined;
    const svc = new OpenAlexService((url, init) => {
      headers = init?.headers;
      return Promise.resolve(ok(SEARCH_JSON));
    });
    await svc.search('x');
    expect(headers?.['User-Agent']).toContain(repoUrl());
  });

  it('rejects an empty query and makes no request', async () => {
    let calls = 0;
    const svc = new OpenAlexService(() => {
      calls += 1;
      return Promise.resolve(ok(SEARCH_JSON));
    });
    await expect(svc.search('   ')).rejects.toThrow(/must not be empty/);
    expect(calls).toBe(0);
  });

  it('surfaces HTTP errors, and names rate limiting on a 429', async () => {
    const failing = new OpenAlexService(() => Promise.resolve(fail(503, 'Unavailable')));
    await expect(failing.search('x')).rejects.toThrow(/503 Unavailable/);
    await expect(failing.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);

    const limited = new OpenAlexService(() => Promise.resolve(fail(429, 'Too Many Requests')));
    await expect(limited.search('x')).rejects.toThrow(/rate-limits/);
  });

  it('names the bot challenge rather than dying inside JSON.parse', async () => {
    const svc = new OpenAlexService(() => Promise.resolve(ok(BOT_CHALLENGE)));
    await expect(svc.search('x')).rejects.toThrow(/HTML page instead of API data/);
    await expect(svc.search('x')).rejects.not.toThrow(/Unexpected token/);
    await expect(svc.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
  });

  it('reports an unparseable non-HTML body as unavailable', async () => {
    const svc = new OpenAlexService(() => Promise.resolve(ok('not json at all')));
    await expect(svc.search('x')).rejects.toThrow(/not JSON.*not json at all/s);
    await expect(svc.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
  });
});

describe('OpenAlexService.resolveDoi', () => {
  it('returns the bare DOI for a record that has one', async () => {
    let requested = '';
    const svc = new OpenAlexService((url) => {
      requested = url;
      return Promise.resolve(
        ok(
          JSON.stringify({
            id: 'https://openalex.org/W2194775991',
            doi: 'https://doi.org/10.1109/cvpr.2016.90',
          }),
        ),
      );
    });
    const doi = await svc.resolveDoi('openalex:W2194775991');
    expect(doi).toBe('10.1109/cvpr.2016.90');
    expect(requested).toBe('https://api.openalex.org/works/W2194775991');
  });

  it('returns null, not an error, for a record with no DOI', async () => {
    const svc = new OpenAlexService(() =>
      Promise.resolve(ok(JSON.stringify({ id: 'https://openalex.org/W3', doi: null }))),
    );
    await expect(svc.resolveDoi('W3')).resolves.toBeNull();
  });

  it('uses ? for mailto when the URL has no query string yet', async () => {
    let requested = '';
    const svc = new OpenAlexService(
      (url) => {
        requested = url;
        return Promise.resolve(ok(JSON.stringify({ id: 'https://openalex.org/W3' })));
      },
      { contactEmail: 'dev@example.com' },
    );
    await svc.resolveDoi('W3');
    expect(requested).toBe('https://api.openalex.org/works/W3?mailto=dev%40example.com');
  });

  it('throws when the key does not parse as an openalex source', async () => {
    const svc = new OpenAlexService(() => Promise.resolve(ok('{}')));
    await expect(svc.resolveDoi('crossref:10.1109/CVPR.2016.90')).rejects.toThrow(
      /not an OpenAlex record key/,
    );
    await expect(svc.resolveDoi('conf/cvpr/HeZRS16')).rejects.toThrow(/not an OpenAlex record key/);
  });

  it('rejects a path-traversal attempt without making a request', async () => {
    let called = false;
    const svc = new OpenAlexService(() => {
      called = true;
      return Promise.resolve(ok('{}'));
    });
    await expect(svc.resolveDoi('../../etc/passwd')).rejects.toThrow();
    expect(called).toBe(false);
  });

  it('surfaces HTTP errors as BackendUnavailableError', async () => {
    const svc = new OpenAlexService(() => Promise.resolve(fail(500, 'Server Error')));
    await expect(svc.resolveDoi('W1')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(svc.resolveDoi('W1')).rejects.toThrow(/500 Server Error/);
  });

  it('names the bot challenge rather than dying inside JSON.parse', async () => {
    const svc = new OpenAlexService(() => Promise.resolve(ok(BOT_CHALLENGE)));
    await expect(svc.resolveDoi('W1')).rejects.toThrow(/HTML page instead of API data/);
    await expect(svc.resolveDoi('W1')).rejects.not.toThrow(/Unexpected token/);
    await expect(svc.resolveDoi('W1')).rejects.toBeInstanceOf(BackendUnavailableError);
  });

  it('reports an unparseable non-HTML body as unavailable', async () => {
    const svc = new OpenAlexService(() => Promise.resolve(ok('garbage, not json')));
    await expect(svc.resolveDoi('W1')).rejects.toBeInstanceOf(BackendUnavailableError);
  });
});

describe('OpenAlexService interface shape', () => {
  it('has no fetchBibtex method — OpenAlex publishes no BibTeX', () => {
    const svc = new OpenAlexService(() => Promise.resolve(ok('{}')));
    expect((svc as unknown as Record<string, unknown>).fetchBibtex).toBeUndefined();
  });
});

describe('a 200 carrying JSON of the wrong shape', () => {
  it('is unavailable, not zero results', async () => {
    const svc = new OpenAlexService(() => Promise.resolve(ok('{"error":"invalid query"}')));
    await expect(svc.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(svc.search('x')).rejects.toThrow(/JSON in an unexpected shape/);
  });

  it('but an empty results array IS a real empty answer', async () => {
    const svc = new OpenAlexService(() => Promise.resolve(ok(JSON.stringify({ results: [] }))));
    await expect(svc.search('x')).resolves.toEqual([]);
  });
});

describe('resolveDoi gets the same shape guard as search', () => {
  it('does not report a backend error as "this record has no DOI"', async () => {
    // Without the guard this resolved to null, and the resolver turned null into a confident
    // refusal saying the record carries no DOI — a claim about the record, caused by a failure.
    const svc = new OpenAlexService(() => Promise.resolve(ok('{"error":"invalid query"}')));
    await expect(svc.resolveDoi('W2194775991')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(svc.resolveDoi('W2194775991')).rejects.toThrow(/JSON in an unexpected shape/);
  });

  it('still returns null for a REAL record that genuinely has no DOI', async () => {
    // The value just outside: a well-formed work record, no doi field. That is an answer.
    const svc = new OpenAlexService(() =>
      Promise.resolve(ok(JSON.stringify({ id: 'https://openalex.org/W1', doi: null }))),
    );
    await expect(svc.resolveDoi('W1')).resolves.toBeNull();
  });
});

describe('a TRANSPORT failure is substitutable, not a raw error', () => {
  // The gap this pins: every failure fixture in the suite was a hand-built
  // BackendUnavailableError, so the fallback was only ever proved against a fake that could not
  // exhibit the bug. A rejecting fetch — offline, DNS, ECONNREFUSED, timeout — escaped as a raw
  // TypeError, and the resolver rethrows anything that is not BackendUnavailableError, so a
  // timing-out backend aborted the chain instead of substituting.
  const reject = (err: unknown) => () => Promise.reject(err);

  it('OpenAlex.search converts a rejected fetch', async () => {
    const svc = new OpenAlexService(
      reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })),
    );
    await expect(svc.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(svc.search('x')).rejects.toThrow(/could not be reached/);
    await expect(svc.search('x')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('OpenAlex names a timeout as a timeout', async () => {
    const svc = new OpenAlexService(
      reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })),
    );
    await expect(svc.search('x')).rejects.toThrow(/timed out after 15s/);
  });

  it('OpenAlex’s by-record path converts a rejected fetch too', async () => {
    const svc = new OpenAlexService(reject(new TypeError('fetch failed')));
    await expect(svc.resolveDoi('W2194775991')).rejects.toBeInstanceOf(BackendUnavailableError);
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

  it('OpenAlex.search converts a rejected body read', async () => {
    const svc = new OpenAlexService(() => Promise.resolve(bodyFails()));
    await expect(svc.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(svc.search('x')).rejects.toThrow(/timed out after 15s/);
  });

  it('OpenAlex.resolveDoi converts a rejected body read', async () => {
    // Worse here than anywhere: a raw rejection aborts the chain, and the doc comment on
    // resolveDoi turns on "no DOI" staying distinguishable from "could not answer".
    const svc = new OpenAlexService(() => Promise.resolve(bodyFails()));
    await expect(svc.resolveDoi('W2194775991')).rejects.toBeInstanceOf(BackendUnavailableError);
  });
});

describe('a well-enveloped body whose ELEMENTS are malformed is unavailable, not a crash', () => {
  // `results` being an array is an ENVELOPE check; the elements inside it were dereferenced
  // blind, so a well-enveloped 200 carrying junk escaped as a raw TypeError. The resolver
  // substitutes only on BackendUnavailableError, so that aborted the whole fallback chain.

  it('refuses a null ELEMENT inside results', async () => {
    const svc = new OpenAlexService(() => Promise.resolve(ok('{"results":[null]}')));
    await expect(svc.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(svc.search('x')).rejects.not.toBeInstanceOf(TypeError);
  });

  it('refuses a result whose id is not a string', async () => {
    const svc = new OpenAlexService(() => Promise.resolve(ok('{"results":[{"id":42}]}')));
    await expect(svc.search('x')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(svc.search('x')).rejects.not.toBeInstanceOf(TypeError);
  });

  it('refuses a malformed doi on resolveDoi rather than crashing', async () => {
    // Worse here than in `search`: "no DOI" is a real answer this method is allowed to give
    // (`null`), so the failure must stay distinguishable from it — and a raw TypeError is
    // neither, it just aborts the chain.
    const svc = new OpenAlexService(() =>
      Promise.resolve(ok('{"id":"https://openalex.org/W1","doi":42}')),
    );
    await expect(svc.resolveDoi('W1')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(svc.resolveDoi('W1')).rejects.not.toBeInstanceOf(TypeError);
  });

  it('still maps a well-formed body, and still answers a real empty search with []', async () => {
    const good = new OpenAlexService(() =>
      Promise.resolve(
        ok(JSON.stringify({ results: [{ id: 'https://openalex.org/W1', display_name: 'T' }] })),
      ),
    );
    expect((await good.search('x'))[0]?.key).toBe('openalex:W1');
    const none = new OpenAlexService(() => Promise.resolve(ok(JSON.stringify({ results: [] }))));
    await expect(none.search('x')).resolves.toEqual([]);
  });
});

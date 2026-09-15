import { describe, it, expect } from 'vitest';
import { CrossrefService, type FetchResponse } from '../../src/services/crossref.js';
import { BackendUnavailableError } from '../../src/services/referenceBackend.js';
import { getServerVersion } from '../../src/lib/version.js';

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
    await expect(crossref.fetchBibtex('../../etc/passwd')).rejects.toThrow();
    expect(called).toBe(false);
  });

  it('rejects an HTML body whose only "@" is an @licstart license header', async () => {
    // Regression: a naive "body contains an @" check would accept this and let a web page
    // into a user's .bib.
    const crossref = new CrossrefService(() => Promise.resolve(ok(BOT_CHALLENGE)));
    await expect(crossref.fetchBibtex('10.1109/CVPR.2016.90')).rejects.toThrow(
      /HTML page instead of API data/,
    );
  });

  it('rejects a plain non-BibTeX text body as a real (non-substitutable) answer', async () => {
    const crossref = new CrossrefService(() => Promise.resolve(ok('no entry here')));
    await expect(crossref.fetchBibtex('10.1109/CVPR.2016.90')).rejects.toThrow(/No BibTeX/);
    await expect(crossref.fetchBibtex('10.1109/CVPR.2016.90')).rejects.not.toBeInstanceOf(
      BackendUnavailableError,
    );
  });

  it('surfaces a non-OK HTTP response as unavailable', async () => {
    const crossref = new CrossrefService(() => Promise.resolve(fail(404, 'Not Found')));
    await expect(crossref.fetchBibtex('10.1109/CVPR.2016.90')).rejects.toBeInstanceOf(
      BackendUnavailableError,
    );
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

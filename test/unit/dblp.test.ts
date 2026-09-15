import { describe, it, expect } from 'vitest';
import { DblpService, type FetchResponse } from '../../src/services/dblp.js';
import { BackendUnavailableError } from '../../src/services/referenceBackend.js';

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

    const empty = new DblpService(() => Promise.resolve(ok(JSON.stringify({ result: {} }))));
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

  it('still treats a present-but-empty result container as a real empty answer', async () => {
    // The value just outside: `result` present, `hits` absent — DBLP genuinely found nothing.
    const dblp = new DblpService(() => Promise.resolve(ok(JSON.stringify({ result: {} }))));
    await expect(dblp.search('x')).resolves.toEqual([]);
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

  it('never hands back the bot challenge as if it were an entry', async () => {
    // Regression: `@licstart` in the interstitial satisfied the old `includes('@')` check,
    // so a web page could reach the caller — and a user's .bib — as BibTeX.
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

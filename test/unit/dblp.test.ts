import { describe, it, expect } from 'vitest';
import { DblpService, type FetchResponse } from '../../src/services/dblp.js';

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
      key: 'conf/cvpr/HeZRS16',
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

    const empty = new DblpService(() => Promise.resolve(ok(JSON.stringify({ result: {} }))));
    expect(await empty.search('nothing')).toEqual([]);
  });

  it('rejects an empty query and surfaces HTTP errors', async () => {
    const dblp = new DblpService(() => Promise.resolve(fail(503, 'Unavailable')));
    await expect(dblp.search('   ')).rejects.toThrow(/must not be empty/);
    await expect(dblp.search('x')).rejects.toThrow(/503 Unavailable/);
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
    await expect(html.fetchBibtex('conf/x/y')).rejects.toThrow(/No BibTeX/);

    const missing = new DblpService(() => Promise.resolve(fail(404, 'Not Found')));
    await expect(missing.fetchBibtex('conf/x/y')).rejects.toThrow(/404 Not Found/);
  });
});

import { describe, it, expect } from 'vitest';
import { DataCiteService } from '../../src/services/datacite.js';
import {
  BackendUnavailableError,
  RecordNotFoundError,
  type FetchResponse,
} from '../../src/services/referenceBackend.js';

/**
 * DataCite's BibTeX for `10.48550/arXiv.1706.03762`, byte for byte as the live API served it on
 * 2026-11-17 (`GET https://api.datacite.org/dois/application/x-bibtex/10.48550/arXiv.1706.03762`,
 * `content-type: application/x-bibtex; charset=utf-8`). Note the URL-shaped cite key.
 */
const LIVE_ARXIV_BIBTEX = [
  '@misc{https://doi.org/10.48550/arxiv.1706.03762,',
  '  doi = {10.48550/ARXIV.1706.03762},',
  '  url = {https://arxiv.org/abs/1706.03762},',
  '  author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N. and Kaiser, Lukasz and Polosukhin, Illia},',
  '  keywords = {Computation and Language (cs.CL), Machine Learning (cs.LG), FOS: Computer and information sciences, FOS: Computer and information sciences},',
  '  title = {Attention Is All You Need},',
  '  publisher = {arXiv},',
  '  year = {2017},',
  '  copyright = {arXiv.org perpetual, non-exclusive license}',
  '}',
].join('\n');

/** The live 404 body for a DOI DataCite does not hold (a Crossref DOI, or no DOI at all). */
const LIVE_404_BODY =
  '{"errors":[{"status":"404","title":"The resource you are looking for doesn\'t exist."}]}';

function respond(status: number, body: string, statusText = status === 200 ? 'OK' : 'Error') {
  return (): Promise<FetchResponse> =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText,
      text: async () => body,
      json: async () => JSON.parse(body) as unknown,
    });
}

describe('DataCiteService.fetchBibtexByDoi', () => {
  it('returns the live arXiv entry verbatim, URL-shaped key included', async () => {
    const svc = new DataCiteService(respond(200, `${LIVE_ARXIV_BIBTEX}\n`));
    await expect(svc.fetchBibtexByDoi('10.48550/arXiv.1706.03762')).resolves.toBe(
      LIVE_ARXIV_BIBTEX,
    );
  });

  it('asks the content-type-in-path endpoint, encoding each DOI segment, with an honest UA', async () => {
    const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
    const svc = new DataCiteService(
      (url, init) => {
        seen.push({ url, headers: init?.headers });
        return respond(200, LIVE_ARXIV_BIBTEX)();
      },
      { contactEmail: 'contact@example.org' },
    );
    await svc.fetchBibtexByDoi('10.1234/a<b>');
    expect(seen[0]!.url).toBe(
      'https://api.datacite.org/dois/application/x-bibtex/10.1234/a%3Cb%3E',
    );
    expect(seen[0]!.headers?.['User-Agent']).toMatch(
      /^web-latex-mcp\/.*mailto:contact@example\.org/,
    );
    expect(seen[0]!.headers?.Accept).toBe('application/x-bibtex');
  });

  it('sends no contact address unless one was configured', async () => {
    let ua = '';
    const svc = new DataCiteService((_url, init) => {
      ua = init?.headers?.['User-Agent'] ?? '';
      return respond(200, LIVE_ARXIV_BIBTEX)();
    });
    await svc.fetchBibtexByDoi('10.48550/arXiv.1706.03762');
    expect(ua).not.toMatch(/mailto/);
  });

  it('a 404 is DataCite ANSWERING: RecordNotFoundError, never unavailable', async () => {
    const svc = new DataCiteService(respond(404, LIVE_404_BODY, 'Not Found'));
    const err = await svc.fetchBibtexByDoi('10.1109/CVPR.2016.90').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecordNotFoundError);
    expect(err).not.toBeInstanceOf(BackendUnavailableError);
    expect((err as Error).message).toMatch(/DataCite returned 404 Not Found/);
  });

  it('a 500 or 429 is unavailable', async () => {
    for (const status of [500, 429]) {
      const svc = new DataCiteService(respond(status, ''));
      await expect(svc.fetchBibtexByDoi('10.48550/x')).rejects.toBeInstanceOf(
        BackendUnavailableError,
      );
    }
  });

  it('an anti-bot HTML page served with 200 is unavailable, never appended', async () => {
    const svc = new DataCiteService(
      respond(200, '<!doctype html><html><body>Making sure you are not a bot</body></html>'),
    );
    await expect(svc.fetchBibtexByDoi('10.48550/x')).rejects.toBeInstanceOf(
      BackendUnavailableError,
    );
  });

  it('a 200 that carries no BibTeX entry (JSON, prose, empty) is unavailable', async () => {
    for (const body of ['{"data":{}}', 'Service temporarily degraded', '   ']) {
      const svc = new DataCiteService(respond(200, body));
      await expect(svc.fetchBibtexByDoi('10.48550/x')).rejects.toBeInstanceOf(
        BackendUnavailableError,
      );
    }
  });

  it('a transport failure and a body stalled mid-read are unavailable', async () => {
    const dead = new DataCiteService(() => Promise.reject(new TypeError('fetch failed')));
    await expect(dead.fetchBibtexByDoi('10.48550/x')).rejects.toBeInstanceOf(
      BackendUnavailableError,
    );
    const stalled = new DataCiteService(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })),
        json: async () => ({}),
      }),
    );
    await expect(stalled.fetchBibtexByDoi('10.48550/x')).rejects.toBeInstanceOf(
      BackendUnavailableError,
    );
  });

  it('cuts a trailing script off the entry, as bibtexEntrySpan does for Crossref', async () => {
    const svc = new DataCiteService(
      respond(200, `${LIVE_ARXIV_BIBTEX}\n<script>track()</script>\n`),
    );
    await expect(svc.fetchBibtexByDoi('10.48550/arXiv.1706.03762')).resolves.toBe(
      LIVE_ARXIV_BIBTEX,
    );
  });

  it('refuses a string that is not a DOI before any request', async () => {
    let called = false;
    const svc = new DataCiteService(() => {
      called = true;
      return respond(200, LIVE_ARXIV_BIBTEX)();
    });
    for (const bad of ['../../etc/passwd', '10.48550/../x', 'crossref:10.1/x', '10.1/a b']) {
      await expect(svc.fetchBibtexByDoi(bad)).rejects.toThrow();
    }
    expect(called).toBe(false);
  });
});

/**
 * Minimal client for DataCite's REST API (https://api.datacite.org), used for one thing only:
 * fetching the BibTeX DataCite itself serves for a DOI it registered.
 *
 * DOIs are issued by registration agencies, and Crossref is only one of them. DataCite registers,
 * among many others, every arXiv DOI (prefix `10.48550`) — the identifier OpenAlex hands back for
 * an arXiv preprint — so Crossref answers 404 for exactly the records an ML paper cites most. A
 * DOI names one record wherever it is registered, so asking DataCite for it is fetching the same
 * record from its own registrar, not substituting another bibliography; the resolver decides when
 * (`ReferenceResolver.fetchDoiBibtex`).
 *
 * The endpoint is DataCite's content-type-in-path form, `GET /dois/application/x-bibtex/<doi>`,
 * verified live (2026-11-17) for `10.48550/arXiv.1706.03762`: a 200 with
 * `content-type: application/x-bibtex` whose body is one `@misc{https://doi.org/10.48550/arxiv…,`
 * entry, and a 404 with a JSON `{"errors":[…]}` body for a DOI DataCite does not hold (Crossref's
 * DOIs included). The entry's cite key is a URL; it is kept verbatim like every other byte.
 *
 * Same hygiene as `CrossrefService.fetchBibtex`, since this is a sanctioned path into a user's
 * `.bib`: the DOI is validated (`parseDoi`) and encoded per segment before it reaches the URL;
 * every request and body read goes through `fetchOrUnavailable`/`readBodyOrUnavailable`; an HTML
 * page is `assertApiBody`'s unavailability; and the entry is cut by `bibtexEntrySpan`, never
 * composed or reformatted. This class has no `search` — nothing routes a search here.
 *
 * Identification is the same honest polite-pool `User-Agent` Crossref gets, with the contact
 * email only when the user set `WEB_LATEX_MCP_CONTACT_EMAIL`.
 */

import { getServerVersion } from '../lib/version.js';
import { parseDoi } from '../lib/referenceKey.js';
import {
  bibtexEntrySpan,
  BODY_EXCERPT,
  REQUEST_TIMEOUT_MS,
  BackendUnavailableError,
  RecordNotFoundError,
  assertApiBody,
  fetchOrUnavailable,
  readBodyOrUnavailable,
  httpHint,
  type FetchLike,
} from './referenceBackend.js';

const SERVICE = 'DataCite';

const DEFAULT_BASE_URL = 'https://api.datacite.org';

export class DataCiteService {
  readonly id = 'datacite';
  readonly name = SERVICE;

  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly contactEmail: string | undefined;

  constructor(fetchImpl?: FetchLike, opts: { baseUrl?: string; contactEmail?: string } = {}) {
    this.fetchImpl =
      fetchImpl ??
      ((url, init) =>
        fetch(url, { headers: init?.headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }));
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.contactEmail = opts.contactEmail;
  }

  /** Identifying `User-Agent`; the contact address is only ever the one configured. */
  private userAgent(): string {
    const version = getServerVersion();
    const contact = this.contactEmail ? `; mailto:${this.contactEmail}` : '';
    return `web-latex-mcp/${version} (+https://github.com/elias-ramzi/WebLatexMCP${contact})`;
  }

  /**
   * DataCite's own BibTeX for a bare DOI, cut to the entry's span.
   *
   * A 404 is `RecordNotFoundError` (DataCite answered: it holds no such DOI). Every other non-OK
   * status, a transport failure, an HTML page, an empty body and a 200 that carries no BibTeX
   * entry are `BackendUnavailableError`: the endpoint is BibTeX-only, so a body without an entry
   * is content negotiation failing, not an answer about the record.
   */
  async fetchBibtexByDoi(rawDoi: string): Promise<string> {
    const doi = parseDoi(rawDoi);
    // Per segment, as Crossref does: the DOI's structural "/" stays a path separator, and
    // everything else in each segment is encoded.
    const encodedDoi = doi
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const url = `${this.baseUrl}/dois/application/x-bibtex/${encodedDoi}`;
    const what = `BibTeX for DOI "${doi}"`;
    const res = await fetchOrUnavailable(
      SERVICE,
      this.fetchImpl,
      url,
      { headers: { 'User-Agent': this.userAgent(), Accept: 'application/x-bibtex' } },
      what,
    );
    if (!res.ok) {
      const message = `DataCite returned ${res.status} ${res.statusText} for DOI "${doi}".${httpHint(SERVICE, res.status, 'record')}`;
      throw res.status === 404
        ? new RecordNotFoundError(SERVICE, message)
        : new BackendUnavailableError(SERVICE, message);
    }
    const text = (await readBodyOrUnavailable(SERVICE, res, what)).trim();
    assertApiBody(SERVICE, text, `a BibTeX request for DOI "${doi}"`);
    if (!text) {
      throw new BackendUnavailableError(
        SERVICE,
        `DataCite returned an empty body for DOI "${doi}" — the response carried no data, so it ` +
          'is no evidence about whether the record exists.',
      );
    }
    const span = bibtexEntrySpan(text);
    if (span === null) {
      throw new BackendUnavailableError(
        SERVICE,
        `DataCite answered ${what} with a body that is not BibTeX. Body began: ` +
          JSON.stringify(text.slice(0, BODY_EXCERPT)),
      );
    }
    return text.slice(span.start, span.end);
  }
}

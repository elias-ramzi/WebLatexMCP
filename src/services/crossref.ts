/**
 * Minimal client for the public Crossref REST API (https://api.crossref.org), used as a
 * bibliography backend alongside DBLP and OpenAlex.
 *
 * `search` queries the works endpoint; `fetchBibtex` pulls Crossref's own BibTeX
 * transform for a DOI. Keeping the fetch injectable lets unit tests feed canned
 * responses with no network. As with `DblpService`, `fetchBibtex` is a sanctioned path
 * into a user's `.bib`, so the entry text it returns must always be the service's own
 * bytes, never something this client reformats or synthesizes.
 *
 * Crossref *asks* clients to identify themselves (https://api.crossref.org, "polite
 * pool") — this is an honest identification the service documents and rewards with
 * better service, not a spoofed User-Agent meant to defeat a bot wall the way DBLP's
 * anti-bot challenge would need defeating. Every request carries a `User-Agent` naming
 * this project and, when a contact email is configured, a `mailto` on both the header
 * and the query string.
 */

import { getServerVersion } from '../lib/version.js';
import { formatRecordKey, parseRecordKey } from '../lib/referenceKey.js';
import {
  BIBTEX_ENTRY,
  BODY_EXCERPT,
  BackendUnavailableError,
  assertApiBody,
  fetchOrUnavailable,
  assertApiShape,
  httpHint,
  type FetchLike,
  type ReferenceBackend,
  type ReferenceHit,
} from './referenceBackend.js';

export type { FetchResponse, FetchLike } from './referenceBackend.js';

const SERVICE = 'Crossref';

const DEFAULT_BASE_URL = 'https://api.crossref.org';
const REQUEST_TIMEOUT_MS = 15_000;

// --- Crossref JSON shapes (loosely typed; the API is stable but verbose) ---

interface CrossrefAuthor {
  given?: string;
  family?: string;
  /** Organisation authors (e.g. a consortium) carry `name` and no given/family. */
  name?: string;
}

interface CrossrefIssued {
  'date-parts'?: Array<Array<number | undefined>>;
}

interface CrossrefEvent {
  name?: string;
}

interface CrossrefItem {
  DOI?: string;
  title?: string[];
  author?: CrossrefAuthor[];
  issued?: CrossrefIssued;
  'container-title'?: string[];
  'short-container-title'?: string[];
  type?: string;
  URL?: string;
  event?: CrossrefEvent;
}

interface CrossrefSearchResponse {
  message?: { items?: CrossrefItem[] };
}

/** Join `given`+`family`, falling back to `family` alone, then to `name` (organisation
 * authors). Returns `undefined` for an entry that yields nothing usable. */
function authorName(a: CrossrefAuthor): string | undefined {
  const given = a.given?.trim();
  const family = a.family?.trim();
  if (given && family) return `${given} ${family}`;
  if (family) return family;
  const name = a.name?.trim();
  return name ? name : undefined;
}

function authorNames(authors: CrossrefAuthor[] | undefined): string[] {
  return (authors ?? []).map(authorName).filter((name): name is string => Boolean(name));
}

/** `issued['date-parts'][0][0]`, guarded at every level — `date-parts` can be `[[]]`. */
function extractYear(issued: CrossrefIssued | undefined): number | undefined {
  const year = issued?.['date-parts']?.[0]?.[0];
  return typeof year === 'number' && Number.isFinite(year) ? year : undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value && value.trim()) return value;
  }
  return undefined;
}

export class CrossrefService implements ReferenceBackend {
  readonly id = 'crossref';
  readonly name = SERVICE;

  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly contactEmail: string | undefined;

  constructor(fetchImpl?: FetchLike, opts: { baseUrl?: string; contactEmail?: string } = {}) {
    this.fetchImpl =
      fetchImpl ?? ((url, init) => fetch(url, { headers: init?.headers, signal: timeoutSignal() }));
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.contactEmail = opts.contactEmail;
  }

  /**
   * The identifying `User-Agent` Crossref's polite-pool docs ask for. Never invents a
   * contact address — it is only ever the one passed into the constructor.
   */
  private userAgent(): string {
    const version = getServerVersion();
    const contact = this.contactEmail ? `; mailto:${this.contactEmail}` : '';
    return `web-latex-mcp/${version} (+https://github.com/eramzi/WebLatexMCP${contact})`;
  }

  /** Search Crossref works, returning the top matches with their record keys. */
  async search(query: string, opts: { maxResults?: number } = {}): Promise<ReferenceHit[]> {
    const trimmed = query.trim();
    if (!trimmed) throw new Error('Search query must not be empty.');
    const max = Math.min(Math.max(opts.maxResults ?? 10, 1), 30);

    // `query.bibliographic`, not the plain `query` field: verified live against the API —
    // `query=deep residual learning image recognition` does not surface the actual ResNet
    // paper in the top 3 results, `query.bibliographic=...` does. `query.bibliographic` scores
    // the string as a whole citation rather than as free-text keywords. Do not "simplify" this
    // back to `query=`.
    let url = `${this.baseUrl}/works?query.bibliographic=${encodeURIComponent(trimmed)}&rows=${max}`;
    if (this.contactEmail) {
      url += `&mailto=${encodeURIComponent(this.contactEmail)}`;
    }
    // Keep the payload small — only the fields this client actually maps.
    url += '&select=DOI,title,author,issued,container-title,short-container-title,type,URL,event';

    const res = await fetchOrUnavailable(
      SERVICE,
      this.fetchImpl,
      url,
      { headers: { 'User-Agent': this.userAgent() } },
      `a search for "${trimmed}"`,
    );
    if (!res.ok) {
      throw new BackendUnavailableError(
        SERVICE,
        `Crossref search failed: ${res.status} ${res.statusText}.${httpHint(SERVICE, res.status)}`,
      );
    }
    // Read as text, not `res.json()`: a 200 can still carry a bot-challenge/interstitial page,
    // and the raw body is what makes that diagnosable instead of an "Unexpected token '<'"
    // buried inside JSON.parse.
    const body = await res.text();
    assertApiBody(SERVICE, body, `a search for "${trimmed}"`);
    let data: CrossrefSearchResponse;
    try {
      data = JSON.parse(body) as CrossrefSearchResponse;
    } catch {
      // Unavailable, not a plain error: a backend that answers with unparseable JSON has failed
      // to answer at all, so the resolver may substitute another one.
      throw new BackendUnavailableError(
        SERVICE,
        `Crossref returned a body that is not JSON for a search for "${trimmed}". Body began: ` +
          JSON.stringify(body.trimStart().slice(0, BODY_EXCERPT)),
      );
    }
    // `message` present as an OBJECT with no `items` is a legitimate empty answer. Absent — or an
    // ARRAY, which is the shape Crossref's own validation-failure envelope uses — means the
    // request was rejected without an error status, which is not an answer about the query.
    // Checking only for `!== undefined` passes that envelope and reports it as zero results.
    // A real empty answer from Crossref always carries `items: []`, so requiring the ARRAY both
    // rejects the error envelope (whose `message` is an array) and any other non-list envelope,
    // while still admitting a genuine no-results search. The sibling openalex check is the same
    // shape; leaving this one looser was the daylight between two clients that share a design.
    const message = data?.message as { items?: unknown } | undefined;
    assertApiShape(
      SERVICE,
      typeof message === 'object' &&
        message !== null &&
        !Array.isArray(message) &&
        Array.isArray(message.items),
      `a search for "${trimmed}"`,
      body,
    );
    const items = data.message?.items ?? [];
    return (
      items
        // The DOI is the record's identity — `fetchBibtex`/`add_citation` cannot route without
        // one, so an item with no DOI is skipped entirely rather than surfaced with a hole.
        .filter((item): item is CrossrefItem & { DOI: string } => Boolean(item.DOI))
        .map((item) => {
          const doi = item.DOI;
          return {
            key: formatRecordKey('crossref', doi),
            source: this.id,
            // Crossref does not append a trailing "." the way DBLP does — nothing to strip here.
            title: item.title?.[0] ?? '',
            authors: authorNames(item.author),
            year: extractYear(item.issued),
            venue: firstNonEmpty(
              item['container-title']?.[0],
              item.event?.name,
              item['short-container-title']?.[0],
            ),
            type: item.type,
            doi,
            url: item.URL,
          } satisfies ReferenceHit;
        })
    );
  }

  /**
   * Fetch Crossref's own BibTeX transform for a DOI (or a `crossref:`/`doi:`-prefixed
   * record key). Throws on a non-OK response or a body that isn't BibTeX, so callers
   * never append a Crossref error/interstitial page to a `.bib` file.
   */
  async fetchBibtex(doiOrKey: string): Promise<string> {
    const parsed = parseRecordKey(doiOrKey);
    if (parsed.source !== 'crossref') {
      throw new Error(`"${doiOrKey}" is a ${parsed.source} key, not a Crossref DOI.`);
    }
    const doi = parsed.id;
    // Per-segment encoding preserves the DOI's structural "/" (registrant/suffix) while
    // encoding everything else in each segment — a bare interpolation would leave unsafe
    // characters in the path, and a whole-string encodeURIComponent would encode the "/"
    // itself and break the path.
    const encodedDoi = doi
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const url = `${this.baseUrl}/works/${encodedDoi}/transform`;
    const res = await fetchOrUnavailable(
      SERVICE,
      this.fetchImpl,
      url,
      { headers: { 'User-Agent': this.userAgent(), Accept: 'application/x-bibtex' } },
      `BibTeX for DOI "${doi}"`,
    );
    if (!res.ok) {
      throw new BackendUnavailableError(
        SERVICE,
        `Crossref returned ${res.status} ${res.statusText} for DOI "${doi}".${httpHint(SERVICE, res.status, 'record')}`,
      );
    }
    const text = (await res.text()).trim();
    assertApiBody(SERVICE, text, `a BibTeX request for DOI "${doi}"`);
    // An entry header, not merely an "@" anywhere in the body: an interstitial page can carry
    // "@licstart", and this is the guard that keeps a web page out of a user's bibliography.
    if (!BIBTEX_ENTRY.test(text)) {
      throw new Error(`No BibTeX entry found on Crossref for DOI "${doi}".`);
    }
    return text;
  }
}

/** Abort signal that fires after REQUEST_TIMEOUT_MS, so a hung request can't wedge a tool. */
function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

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
  bibtexEntrySpan,
  BODY_EXCERPT,
  REQUEST_TIMEOUT_MS,
  BackendUnavailableError,
  assertApiBody,
  fetchOrUnavailable,
  readBodyOrUnavailable,
  assertApiShape,
  httpHint,
  type FetchLike,
  type ReferenceBackend,
  type ReferenceHit,
} from './referenceBackend.js';

export type { FetchResponse, FetchLike } from './referenceBackend.js';

const SERVICE = 'Crossref';

const DEFAULT_BASE_URL = 'https://api.crossref.org';
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
    return `web-latex-mcp/${version} (+https://github.com/elias-ramzi/WebLatexMCP${contact})`;
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
    const body = await readBodyOrUnavailable(SERVICE, res, `a search for "${trimmed}"`);
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
    const hits: ReferenceHit[] = [];
    for (const item of items) {
      // The DOI is the record's identity — `fetchBibtex`/`add_citation` cannot route without
      // one, so an item with no DOI is skipped entirely rather than surfaced with a hole.
      const doi = item.DOI;
      if (!doi) continue;
      // And a DOI that will not round-trip through `parseRecordKey` is skipped for the same
      // reason: `formatRecordKey` composes blindly, so a DOI carrying a character outside the
      // key allowlist produced a key the server itself refuses the moment `add_citation` parses
      // it back — a result the user can see and cannot use, with the refusal arriving one tool
      // call later and blaming the key. `extractWorkId` in the openalex client is defensive the
      // same way; this is its missing half. Skipping costs one result, emitting costs a dead end.
      const key = formatRecordKey('crossref', doi);
      try {
        const parsed = parseRecordKey(key);
        if (parsed.source !== 'crossref' || parsed.id !== doi) continue;
      } catch {
        continue;
      }
      hits.push({
        key,
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
      });
    }
    return hits;
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
    const text = (await readBodyOrUnavailable(SERVICE, res, `BibTeX for DOI "${doi}"`)).trim();
    assertApiBody(SERVICE, text, `a BibTeX request for DOI "${doi}"`);
    // An empty body is the backend failing to answer, NOT an answer about the record. Falling
    // through to "No BibTeX entry found ... for DOI "${doi}"" would state, confidently and on the
    // user's behalf, that their record does not exist — because the response was truncated. The
    // one genuine "no such record" is the 404, handled above. A non-empty body that simply is
    // not BibTeX stays a plain Error: that is Crossref having said something we could read.
    if (!text) {
      throw new BackendUnavailableError(
        SERVICE,
        `Crossref returned an empty body for DOI "${doi}" — the response carried no data, so it is ` +
          `no evidence about whether the record exists.`,
      );
    }
    // An entry header, not merely an "@" anywhere in the body: an interstitial page can carry
    // "@licstart", and this is the guard that keeps a web page out of a user's bibliography.
    const span = bibtexEntrySpan(text);
    if (span === null) {
      throw new Error(`No BibTeX entry found on Crossref for DOI "${doi}".`);
    }
    // The entry's own span, not the whole body: the header may be preceded by a banner or an
    // error fragment and FOLLOWED by a <script> or a block of prose, and whatever this returns is
    // appended verbatim to the user's .bib. The bytes between the two offsets are the service's,
    // untouched — choosing where to cut is all this does.
    return text.slice(span.start, span.end);
  }
}

/** Abort signal that fires after the SHARED `REQUEST_TIMEOUT_MS`, so a hung request can't wedge a
 * tool. Imported, never redeclared: `transportReason` quotes that same constant back as "timed
 * out after 15s", so a local copy drifting would make the error message lie about the wait the
 * user just sat through. Same rule as `parseCompilerChoice` — both answers from one place. */
function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

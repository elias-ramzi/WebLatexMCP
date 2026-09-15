/**
 * Minimal client for the public OpenAlex works API (https://docs.openalex.org/api-entities/works).
 *
 * **OpenAlex publishes no BibTeX.** Its API answers only JSON — requesting a work with
 * `Accept: application/x-bibtex` still comes back `content-type: application/json`, the
 * header is simply ignored. There is no BibTeX endpoint to call. So this class is
 * deliberately search/discovery-only: `search()` finds candidate records, and
 * `resolveDoi()` hands back a record's DOI so a resolver layer can fetch the *canonical*
 * entry from Crossref instead. **This class must never grow a `fetchBibtex` method** —
 * not even one that assembles a BibTeX string from OpenAlex's own JSON fields. Doing so
 * would defeat the whole reason `add_citation` exists: entry text must always arrive
 * verbatim from a publisher-backed source, never be synthesized by this server (or a
 * model) from metadata. A record with no DOI has no canonical entry to fetch anywhere,
 * and the resolver refuses rather than inventing one — see `resolveDoi`'s doc comment.
 *
 * Keeping the fetch injectable lets unit tests feed canned responses with no network.
 */

import { getServerVersion } from '../lib/version.js';
import { formatRecordKey, parseRecordKey } from '../lib/referenceKey.js';
import {
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

const SERVICE = 'OpenAlex';

/** A publication match returned by the OpenAlex works API. */
export type OpenAlexHit = ReferenceHit;

const DEFAULT_BASE_URL = 'https://api.openalex.org';
/** Repo URL identified in the User-Agent, per OpenAlex's "polite pool" convention. */
const USER_AGENT_URL = '+https://github.com/elias-ramzi/WebLatexMCP';

// --- OpenAlex JSON shapes (loosely typed; only the fields this client reads) ---

interface OpenAlexSource {
  /** Documented as required, but the live API serves `null` for some records — guard it. */
  display_name?: string | null;
}

interface OpenAlexLocation {
  /** `null` in real payloads (e.g. a ResNet record with no indexed venue source) — guard it. */
  source?: OpenAlexSource | null;
}

interface OpenAlexAuthor {
  display_name?: string;
}

interface OpenAlexAuthorship {
  author?: OpenAlexAuthor;
}

interface OpenAlexWork {
  /** A full URL, e.g. "https://openalex.org/W2194775991". */
  id?: string;
  display_name?: string;
  title?: string;
  authorships?: OpenAlexAuthorship[];
  publication_year?: number;
  primary_location?: OpenAlexLocation | null;
  best_oa_location?: OpenAlexLocation | null;
  type?: string;
  /** A full URL, e.g. "https://doi.org/10.1109/cvpr.2016.90", or absent/null. */
  doi?: string | null;
}

interface OpenAlexSearchResponse {
  results?: OpenAlexWork[];
}

/** A bare OpenAlex work id, e.g. "W2194775991". */
const WORK_ID = /^[Ww]\d+$/;
const WORK_ID_HOST = /^https?:\/\/openalex\.org\//i;

/** Strip the `https://openalex.org/` prefix from a work's `id` field, so it can be used as a
 * record key. Returns `null` when the remainder isn't a valid work id — the caller skips the
 * result rather than emitting a hit with a garbage key. */
function extractWorkId(fullId: string | undefined): string | null {
  if (!fullId) return null;
  const bare = fullId.replace(WORK_ID_HOST, '').trim();
  return WORK_ID.test(bare) ? bare : null;
}

/** Strip a DOI URL (`https://doi.org/...`, `http://...`, `dx.doi.org/...`) down to the bare DOI.
 * OpenAlex lowercases DOIs; the case is left exactly as given (DOIs are case-insensitive, and
 * Crossref resolves either way). Returns `undefined` for an absent/null/empty value. */
function stripDoi(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const bare = raw.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
  return bare || undefined;
}

function authorNames(authorships: OpenAlexAuthorship[] | undefined): string[] {
  if (!Array.isArray(authorships)) return [];
  return authorships
    .map((a) => a?.author?.display_name)
    .filter((name): name is string => Boolean(name));
}

/** `primary_location.source` is `null` in real payloads — both levels must be guarded, or a
 * result with no indexed venue throws instead of simply carrying no `venue`. Falls back to the
 * open-access location when the primary one has none. */
function extractVenue(work: OpenAlexWork): string | undefined {
  return (
    work.primary_location?.source?.display_name ??
    work.best_oa_location?.source?.display_name ??
    undefined
  );
}

export class OpenAlexService implements ReferenceBackend {
  readonly id = 'openalex';
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
   * Search OpenAlex works, returning the top matches with their record keys.
   *
   * A result whose `id` does not yield a valid OpenAlex work id is skipped rather than
   * surfaced with a garbage key.
   */
  async search(query: string, opts: { maxResults?: number } = {}): Promise<OpenAlexHit[]> {
    const trimmed = query.trim();
    if (!trimmed) throw new Error('Search query must not be empty.');
    const max = Math.min(Math.max(opts.maxResults ?? 10, 1), 30);
    const url = this.withMailto(
      `${this.baseUrl}/works?search=${encodeURIComponent(trimmed)}&per-page=${max}`,
      '&',
    );

    const res = await fetchOrUnavailable(
      SERVICE,
      this.fetchImpl,
      url,
      { headers: this.headers() },
      `a search for "${trimmed}"`,
    );
    if (!res.ok) {
      throw new BackendUnavailableError(
        SERVICE,
        `OpenAlex search failed: ${res.status} ${res.statusText}.${httpHint(SERVICE, res.status)}`,
      );
    }
    // Read as text, not `res.json()`: a 200 can still carry a bot-challenge page, and the raw
    // body is what makes that diagnosable instead of an "Unexpected token '<'" from JSON.parse.
    const body = await readBodyOrUnavailable(SERVICE, res, `a search for "${trimmed}"`);
    assertApiBody(SERVICE, body, `a search for "${trimmed}"`);
    let data: OpenAlexSearchResponse;
    try {
      data = JSON.parse(body) as OpenAlexSearchResponse;
    } catch {
      // Unavailable, not a plain error: a backend that answers with unparseable JSON has failed
      // to answer at all, so the resolver may substitute another one.
      throw new BackendUnavailableError(
        SERVICE,
        `OpenAlex returned a body that is not JSON for a search for "${trimmed}". Body began: ` +
          JSON.stringify(body.trimStart().slice(0, BODY_EXCERPT)),
      );
    }

    // OpenAlex always answers a search with a `results` array, empty or not. Its absence means
    // this is not a search response, so it is not evidence that the query found nothing.
    assertApiShape(SERVICE, Array.isArray(data?.results), `a search for "${trimmed}"`, body);
    const results = Array.isArray(data.results) ? data.results : [];
    const hits: OpenAlexHit[] = [];
    for (const work of results) {
      const workId = extractWorkId(work.id);
      if (!workId) continue;
      const year = work.publication_year;
      hits.push({
        key: formatRecordKey('openalex', workId),
        source: this.id,
        title: work.display_name ?? work.title ?? '',
        authors: authorNames(work.authorships),
        year: Number.isFinite(year) ? year : undefined,
        venue: extractVenue(work),
        type: work.type,
        doi: stripDoi(work.doi),
        url: work.id,
      });
    }
    return hits;
  }

  /**
   * Resolve an OpenAlex record key (or bare work id) to its DOI, so a resolver layer can fetch
   * the canonical BibTeX entry from Crossref instead — see the file header for why.
   *
   * Returns `null` when the record has no DOI. That is a real, well-formed answer ("this record
   * has no DOI"), never a `BackendUnavailableError` and never a thrown plain error: the resolver
   * turns `null` into the user-facing refusal, and that only works if "no DOI" stays
   * distinguishable from "the backend could not answer at all".
   */
  async resolveDoi(keyOrId: string): Promise<string | null> {
    // The validation boundary: never interpolate an unvalidated string into a request URL.
    const parsed = parseRecordKey(keyOrId);
    if (parsed.source !== 'openalex') {
      throw new Error(
        `"${keyOrId}" is not an OpenAlex record key (it parses as a "${parsed.source}" key).`,
      );
    }
    const id = parsed.id;
    const url = this.withMailto(`${this.baseUrl}/works/${id}`, '?');

    const res = await fetchOrUnavailable(
      SERVICE,
      this.fetchImpl,
      url,
      { headers: this.headers() },
      `a lookup of work "${id}"`,
    );
    if (!res.ok) {
      throw new BackendUnavailableError(
        SERVICE,
        `OpenAlex lookup failed for work "${id}": ${res.status} ${res.statusText}.${httpHint(SERVICE, res.status, 'record')}`,
      );
    }
    const body = await readBodyOrUnavailable(SERVICE, res, `a lookup of work "${id}"`);
    assertApiBody(SERVICE, body, `a lookup of OpenAlex work "${id}"`);
    let data: OpenAlexWork;
    try {
      data = JSON.parse(body) as OpenAlexWork;
    } catch {
      throw new BackendUnavailableError(
        SERVICE,
        `OpenAlex returned a body that is not JSON for a lookup of work "${id}". Body began: ` +
          JSON.stringify(body.trimStart().slice(0, BODY_EXCERPT)),
      );
    }
    // The same shape guard `search` has, and it matters MORE here: without it a 200 error
    // envelope leaves `doi` undefined, this returns null, and the resolver turns that into
    // "this record carries no DOI" — a confident claim about the record, made because the
    // backend failed. A real work record always carries its own `id`.
    assertApiShape(
      SERVICE,
      typeof (data as { id?: unknown } | null)?.id === 'string',
      `a lookup of OpenAlex work "${id}"`,
      body,
    );
    return stripDoi(data.doi) ?? null;
  }

  /**
   * `User-Agent: web-latex-mcp/<version> (+https://github.com/elias-ramzi/WebLatexMCP[; mailto:<email>])`.
   * OpenAlex documents and requests this as honest self-identification — it grants identified
   * clients a faster "polite pool" — which is a different thing entirely from spoofing a
   * browser User-Agent to defeat a bot wall, and this server does neither of those elsewhere.
   */
  private headers(): Record<string, string> {
    const contact = this.contactEmail ? `; mailto:${this.contactEmail}` : '';
    return {
      'User-Agent': `web-latex-mcp/${getServerVersion()} (${USER_AGENT_URL}${contact})`,
    };
  }

  /** Append `mailto=<email>` to the query string when a contact email is configured — the query
   * counterpart to the User-Agent identification above. `sep` is `'?'` when `url` carries no
   * query string yet, `'&'` when it already does; never invents an address from anywhere but
   * the constructor. */
  private withMailto(url: string, sep: '?' | '&'): string {
    if (!this.contactEmail) return url;
    return `${url}${sep}mailto=${encodeURIComponent(this.contactEmail)}`;
  }
}

/** Abort signal that fires after the SHARED `REQUEST_TIMEOUT_MS`, so a hung request can't wedge a
 * tool. Imported, never redeclared: `transportReason` quotes that same constant back as "timed
 * out after 15s", so a local copy drifting would make the error message lie about the wait the
 * user just sat through. Same rule as `parseCompilerChoice` — both answers from one place. */
function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

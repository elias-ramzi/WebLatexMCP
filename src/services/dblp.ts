/**
 * Minimal client for the public DBLP search API
 * (https://dblp.org/faq/How+to+use+the+dblp+search+API.html).
 *
 * `search` queries the publication endpoint; `fetchBibtex` pulls the canonical
 * BibTeX for a record. Keeping the fetch injectable lets unit tests feed canned
 * responses with no network. This is the *only* path through which the server adds
 * citations, so the entry text always originates from DBLP, never the model.
 */

import { formatRecordKey } from '../lib/referenceKey.js';
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

const SERVICE = 'DBLP';

/** A publication match returned by the DBLP search endpoint. */
export type DblpHit = ReferenceHit;

const DEFAULT_BASE_URL = 'https://dblp.org';
const VALID_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const REQUEST_TIMEOUT_MS = 15_000;

// --- DBLP JSON shapes (loosely typed; the API is stable but verbose) ---

interface DblpAuthor {
  text?: string;
}

interface DblpInfo {
  key?: string;
  title?: string;
  year?: string;
  venue?: string | string[];
  type?: string;
  doi?: string;
  url?: string;
  authors?: { author?: DblpAuthor | DblpAuthor[] | string | string[] };
}

interface DblpSearchResponse {
  result?: { hits?: { hit?: Array<{ info?: DblpInfo }> } };
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function authorNames(authors: DblpInfo['authors']): string[] {
  return asArray(authors?.author)
    .map((a) => (typeof a === 'string' ? a : a?.text))
    .filter((name): name is string => Boolean(name));
}

function firstString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export class DblpService implements ReferenceBackend {
  readonly id = 'dblp';
  readonly name = SERVICE;

  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(fetchImpl?: FetchLike, baseUrl: string = DEFAULT_BASE_URL) {
    this.fetchImpl =
      fetchImpl ?? ((url, init) => fetch(url, { headers: init?.headers, signal: timeoutSignal() }));
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * Strip a full URL / `.bib`|`.html` suffix down to a bare DBLP record key and
   * validate it, so it can be safely interpolated into a request path.
   */
  static normalizeKey(input: string): string {
    let key = input.trim();
    key = key.replace(/^https?:\/\/[^/]+\//i, '');
    key = key.replace(/^\/+/, '');
    key = key.replace(/^rec\//i, '');
    key = key.replace(/\.(bib|html|xml)$/i, '');
    if (!key || !VALID_KEY.test(key) || key.includes('..')) {
      throw new Error(`"${input}" is not a valid DBLP record key.`);
    }
    return key;
  }

  /** Search DBLP publications, returning the top matches with their record keys. */
  async search(query: string, opts: { maxResults?: number } = {}): Promise<DblpHit[]> {
    const trimmed = query.trim();
    if (!trimmed) throw new Error('Search query must not be empty.');
    const max = Math.min(Math.max(opts.maxResults ?? 10, 1), 30);
    const url =
      `${this.baseUrl}/search/publ/api?q=${encodeURIComponent(trimmed)}` + `&format=json&h=${max}`;

    const res = await fetchOrUnavailable(
      SERVICE,
      this.fetchImpl,
      url,
      undefined,
      `a search for "${trimmed}"`,
    );
    if (!res.ok) {
      throw new BackendUnavailableError(
        SERVICE,
        `DBLP search failed: ${res.status} ${res.statusText}.${httpHint(SERVICE, res.status)}`,
      );
    }
    // Read as text, not `res.json()`: a 200 can still carry the bot-challenge page, and the raw
    // body is what makes that diagnosable instead of an "Unexpected token '<'" from deep in JSON.parse.
    const body = await res.text();
    assertApiBody(SERVICE, body, `a search for "${trimmed}"`);
    let data: DblpSearchResponse;
    try {
      data = JSON.parse(body) as DblpSearchResponse;
    } catch {
      // Unavailable, not a plain error: a backend that answers with unparseable JSON has failed
      // to answer at all, so the resolver may substitute another one. (`fetchBibtex`'s "no entry
      // found" stays a plain Error — that is a real answer about a DBLP-specific key, and no
      // other backend could serve it.)
      throw new BackendUnavailableError(
        'DBLP',
        `DBLP returned a body that is not JSON for a search for "${trimmed}". Body began: ` +
          JSON.stringify(body.trimStart().slice(0, BODY_EXCERPT)),
      );
    }
    // `result` present with no `hits` is a legitimate empty answer; `result` absent is not an
    // answer at all.
    assertApiShape(
      SERVICE,
      typeof data?.result === 'object' && data.result !== null,
      `a search for "${trimmed}"`,
      body,
    );
    const hits = asArray(data.result?.hits?.hit);
    return hits
      .map((hit) => hit.info)
      .filter((info): info is DblpInfo => Boolean(info?.key))
      .map((info) => {
        const year = info.year ? Number(info.year) : undefined;
        return {
          key: formatRecordKey('dblp', info.key as string),
          source: this.id,
          title: (info.title ?? '').replace(/\.$/, ''),
          authors: authorNames(info.authors),
          year: Number.isFinite(year) ? year : undefined,
          venue: firstString(info.venue),
          type: info.type,
          doi: info.doi,
          url: info.url,
        } satisfies DblpHit;
      });
  }

  /**
   * Fetch the standalone BibTeX (`param=1`, crossrefs inlined) for a record key.
   * Throws on a non-OK response or a body that isn't BibTeX, so callers never
   * append a DBLP error page to a `.bib` file.
   */
  async fetchBibtex(keyOrUrl: string): Promise<string> {
    const key = DblpService.normalizeKey(keyOrUrl);
    const url = `${this.baseUrl}/rec/${key}.bib?param=1`;
    const res = await fetchOrUnavailable(
      SERVICE,
      this.fetchImpl,
      url,
      undefined,
      `BibTeX for key "${key}"`,
    );
    if (!res.ok) {
      throw new BackendUnavailableError(
        SERVICE,
        `DBLP returned ${res.status} ${res.statusText} for key "${key}".${httpHint(SERVICE, res.status, 'record')}`,
      );
    }
    const text = (await res.text()).trim();
    assertApiBody(SERVICE, text, `a BibTeX request for key "${key}"`);
    // An entry header, not merely an `@` anywhere in the body: the bot-challenge page carries
    // `@licstart`, and this is the guard that keeps a web page out of a user's bibliography.
    if (!BIBTEX_ENTRY.test(text)) {
      throw new Error(`No BibTeX entry found on DBLP for key "${key}".`);
    }
    return text;
  }
}

/** Abort signal that fires after REQUEST_TIMEOUT_MS, so a hung request can't wedge a tool. */
function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

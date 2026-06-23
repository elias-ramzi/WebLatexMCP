/**
 * Minimal client for the public DBLP search API
 * (https://dblp.org/faq/How+to+use+the+dblp+search+API.html).
 *
 * `search` queries the publication endpoint; `fetchBibtex` pulls the canonical
 * BibTeX for a record. Keeping the fetch injectable lets unit tests feed canned
 * responses with no network. This is the *only* path through which the server adds
 * citations, so the entry text always originates from DBLP, never the model.
 */

/** The subset of `fetch`'s Response this client needs — keeps tests trivial. */
export interface FetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string) => Promise<FetchResponse>;

/** A publication match returned by the DBLP search endpoint. */
export interface DblpHit {
  /** DBLP record key, e.g. `conf/cvpr/HeZRS16` — pass this to add_citation. */
  key: string;
  title: string;
  authors: string[];
  year?: number;
  /** Venue / journal name, when reported. */
  venue?: string;
  /** DBLP record type, e.g. "Conference and Workshop Papers". */
  type?: string;
  doi?: string;
  /** DBLP record URL (HTML page). */
  url?: string;
}

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

export class DblpService {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(fetchImpl?: FetchLike, baseUrl: string = DEFAULT_BASE_URL) {
    this.fetchImpl = fetchImpl ?? ((url) => fetch(url, { signal: timeoutSignal() }));
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

    const res = await this.fetchImpl(url);
    if (!res.ok) {
      throw new Error(`DBLP search failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as DblpSearchResponse;
    const hits = asArray(data.result?.hits?.hit);
    return hits
      .map((hit) => hit.info)
      .filter((info): info is DblpInfo => Boolean(info?.key))
      .map((info) => {
        const year = info.year ? Number(info.year) : undefined;
        return {
          key: info.key as string,
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
    const res = await this.fetchImpl(url);
    if (!res.ok) {
      throw new Error(`DBLP returned ${res.status} ${res.statusText} for key "${key}".`);
    }
    const text = (await res.text()).trim();
    if (!text.includes('@')) {
      throw new Error(`No BibTeX entry found on DBLP for key "${key}".`);
    }
    return text;
  }
}

/** Abort signal that fires after REQUEST_TIMEOUT_MS, so a hung request can't wedge a tool. */
function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

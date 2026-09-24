/**
 * Minimal client for the public DBLP search API
 * (https://dblp.org/faq/How+to+use+the+dblp+search+API.html).
 *
 * `search` queries the publication endpoint; `fetchBibtex` pulls the canonical
 * BibTeX for a record. Keeping the fetch injectable lets unit tests feed canned
 * responses with no network. This is the *only* path through which the server adds
 * citations, so the entry text always originates from DBLP, never the model.
 */

import { formatRecordKey, normalizeDblpKey, parseRecordKey } from '../lib/referenceKey.js';
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

const SERVICE = 'DBLP';

/** A publication match returned by the DBLP search endpoint. */
export type DblpHit = ReferenceHit;

const DEFAULT_BASE_URL = 'https://dblp.org';

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

/** Wrap DBLP's XML-derived "absent / one / many" fields into a list. `null` counts as absent
 * alongside `undefined`: `asArray(null)` used to be `[null]`, handing every caller a hole
 * shaped like an element. (The call site for `hit` deliberately does NOT route a null through
 * here — see `search`: an explicit null `hit` is not DBLP saying "no results".) */
function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function authorNames(authors: DblpInfo['authors']): string[] {
  return asArray(authors?.author)
    .map((a) => (typeof a === 'string' ? a : a?.text))
    .filter((name): name is string => Boolean(name));
}

/**
 * True when the key DBLP returned for a hit, once `formatRecordKey` namespaces it, parses back to
 * the SAME DBLP record. `formatRecordKey` composes blindly, so a key outside what `parseRecordKey`
 * accepts was emitted and then refused one `add_citation` later — a result the user can see and
 * cannot use — and one it accepts only after rewriting (`rec/conf/a/b` parses to `conf/a/b`) named
 * a different record than the hit it came from. Skipping costs one result; emitting costs a dead
 * end or a wrong citation. The Crossref client makes the same check for the same reason.
 */
function keyRoundTrips(key: string): boolean {
  try {
    const parsed = parseRecordKey(formatRecordKey('dblp', key));
    return parsed.source === 'dblp' && parsed.id === key;
  } catch {
    return false;
  }
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
   * Strip a full URL / `.bib`|`.html`|`.xml` suffix down to a bare DBLP record key and
   * validate it, so it can be safely interpolated into a request path.
   *
   * Delegates to `normalizeDblpKey` (`src/lib/referenceKey.ts`), which is the single
   * implementation of this security boundary. It used to be a second one, kept because
   * `src/lib` must not depend on `src/services` — but that constraint only forbids
   * **lib -> service**, and this direction is the one this file already takes for
   * `formatRecordKey`. The two copies had drifted exactly as a duplicated boundary does:
   * this one stripped *any* `scheme://host/`, so `https://evil.com/rec/conf/x/y` came
   * back as the DBLP key `conf/x/y` — the host laundering every other route in already
   * refuses. Delegating closes that here too.
   *
   * The public contract is unchanged: same accepted set (bar that laundering), same
   * returned id, and the same `"X" is not a valid DBLP record key.` message, which is why
   * the lib refusal is caught and rethrown rather than propagated — a caller matching on
   * that wording must not start seeing `acceptedFormsMessage`'s multi-source text for a
   * method that only ever spoke about DBLP.
   */
  static normalizeKey(input: string): string {
    try {
      return normalizeDblpKey(input);
    } catch {
      throw new Error(`"${input}" is not a valid DBLP record key.`);
    }
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
    const body = await readBodyOrUnavailable(SERVICE, res, `a search for "${trimmed}"`);
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
    // A `hits` container present with no `hit` is a legitimate empty answer — that is exactly
    // what a real DBLP search that found nothing returns. Anything shallower is not an answer:
    // `typeof [] === 'object'`, so checking only for a non-null object admitted an ARRAY (the
    // shape an error envelope uses) and a bare `{"result":{}}`, both of which mapped to zero
    // hits — and the resolver treats zero hits as an ANSWER, stopping the fallback chain and
    // reporting "no results" for a backend that never searched. The crossref and openalex guards
    // are already this strict; leaving this one looser was daylight between clients that share
    // a design.
    const result = data?.result as { hits?: unknown } | undefined;
    const hitsContainer = result?.hits;
    assertApiShape(
      SERVICE,
      typeof result === 'object' &&
        result !== null &&
        !Array.isArray(result) &&
        typeof hitsContainer === 'object' &&
        hitsContainer !== null &&
        !Array.isArray(hitsContainer),
      `a search for "${trimmed}"`,
      body,
    );
    // `hit` ABSENT is DBLP's real empty answer (the `@total: "0"` body the guard above admits);
    // an explicit `"hit": null` is not a shape DBLP serves, so it is not evidence that the query
    // found nothing — a proxy or cache spelling "no hits" that way must stay substitutable. It
    // gets its own refusal because `asArray` treats null as absent (it is generic, and
    // `authorNames` wants exactly that), so routing it through there would turn a backend that
    // never answered into an empty ANSWER, stopping the resolver's fallback chain.
    const hitField = (hitsContainer as { hit?: unknown }).hit;
    assertApiShape(SERVICE, hitField !== null, `a search for "${trimmed}"`, body);
    const hits = asArray(data.result?.hits?.hit);
    try {
      return hits
        .map((hit) => hit.info)
        .filter((info): info is DblpInfo => Boolean(info?.key))
        .filter((info) => keyRoundTrips(info.key as string))
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
    } catch (err) {
      // The guard above validates the ENVELOPE; the elements inside it are whatever the body
      // carried. A null element, or a numeric `title`, used to escape as a raw TypeError — and
      // the resolver substitutes a backend only on BackendUnavailableError, so one malformed
      // body aborted the whole fallback chain while the next backend held a good answer. Wrapped
      // whole rather than guarded field by field, so this holds for fields nobody has thought of
      // yet. `assertApiShape` always throws when passed `false`; rethrowing the original keeps
      // the catch non-returning for the compiler and fails loudly rather than silently if that
      // ever stops being true.
      assertApiShape(SERVICE, false, `a search for "${trimmed}"`, body);
      throw err;
    }
  }

  /**
   * Fetch the BibTeX DBLP serves at `rec/<key>.bib?param=1` for a record key. Whether that body
   * is one self-contained entry or an entry plus the `@proceedings` its `crossref` field names,
   * `bibtexEntrySpan` keeps the whole run, so nothing here depends on which. Throws on a non-OK
   * response or a body that isn't BibTeX, so callers never append a DBLP error page to a `.bib`
   * file.
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
      // A 404 here is the backend ANSWERING — this key names no record — which is exactly what
      // `httpHint` says below and what `BackendUnavailableError`'s own doc promises it is never
      // thrown for. Every other non-OK status is the backend failing to answer, and stays
      // substitutable. The message is identical either way; only the type differs, because only
      // the type decides whether a resolver may fall through to another backend — and falling
      // through on a missing record would be wrong even if there were a fallback to fall to:
      // a key names one record in one backend, so there is nothing to substitute to.
      const message = `DBLP returned ${res.status} ${res.statusText} for key "${key}".${httpHint(SERVICE, res.status, 'record')}`;
      throw res.status === 404 ? new Error(message) : new BackendUnavailableError(SERVICE, message);
    }
    const text = (await readBodyOrUnavailable(SERVICE, res, `BibTeX for key "${key}"`)).trim();
    assertApiBody(SERVICE, text, `a BibTeX request for key "${key}"`);
    // An empty body is the backend failing to answer, NOT an answer about the record. Falling
    // through to "No BibTeX entry found ... for key "${key}"" would state, confidently and on the
    // user's behalf, that their record does not exist — because the response was truncated. The
    // one genuine "no such record" is the 404, handled above. A non-empty body that simply is
    // not BibTeX stays a plain Error: that is DBLP having said something we could read.
    if (!text) {
      throw new BackendUnavailableError(
        SERVICE,
        `DBLP returned an empty body for key "${key}" — the response carried no data, so it is ` +
          `no evidence about whether the record exists.`,
      );
    }
    // An entry header, not merely an `@` anywhere in the body: the bot-challenge page carries
    // `@licstart`, and this is the guard that keeps a web page out of a user's bibliography.
    const span = bibtexEntrySpan(text);
    if (span === null) {
      throw new Error(`No BibTeX entry found on DBLP for key "${key}".`);
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

/**
 * A record key that says which bibliography backend it names. `search_references`
 * returns keys in this shape (`source:id`) and `add_citation` parses them to route
 * the fetch. Backward compatibility: a bare, unprefixed key (no recognised prefix,
 * not URL/DOI/OpenAlex-shaped) is still accepted and defaults to `dblp` — every
 * existing caller, doc and skill that passes a bare DBLP key (e.g.
 * `conf/cvpr/HeZRS16`) keeps working unchanged.
 *
 * Every id here is later interpolated into a request URL path by the service layer
 * (mirroring `DblpService.normalizeKey`'s concern), so validation is a security
 * boundary, not a convenience: this module never returns a partially-validated
 * value, and never falls through to "assume dblp" for input that fails DBLP's own
 * shape check. Pure — no fs, no network, no process/env access.
 */

export const REFERENCE_SOURCES = ['dblp', 'crossref', 'openalex'] as const;
export type ReferenceSourceId = (typeof REFERENCE_SOURCES)[number];

export interface ParsedRecordKey {
  source: ReferenceSourceId;
  id: string;
}

/** Mirrors `DblpService.VALID_KEY` — kept in sync deliberately, not imported: this is a
 * `src/lib` module and must stay dependency-free of the service layer. */
const DBLP_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** A DOI's registrant + suffix. DOIs legitimately contain `/`, so the explicit `..` check
 * below (not this allowlist) is what rejects traversal. */
const DOI_KEY = /^10\.\d{4,9}\/[A-Za-z0-9._;()/:<>+[\]-]+$/i;

/** Loose "this looks like someone attempting a DOI" shape — deliberately looser than
 * `DOI_KEY` (1+ digits, not 4-9), so a too-short registrant is routed to crossref
 * validation (and rejected there with a specific reason) rather than silently falling
 * through and being accepted as an oddly-shaped bare DBLP key. */
const DOI_ATTEMPT = /^10\.\d+\//;

const OPENALEX_KEY = /^W\d+$/i;

/**
 * Loose "this looks like someone attempting an OpenAlex id" shape, used to claim the namespace
 * for strict validation so `W12a` and `W` are rejected with a specific reason instead of being
 * silently accepted as bare DBLP keys (`DBLP_KEY` alone permits any alnum/`.`/`_`/`/`/`-` string).
 *
 * It requires a digit — or end of string — after the `w`, and that is not cosmetic: DBLP really
 * does have `www/`-prefixed record keys, so a bare `/^w/i` claimed them for OpenAlex and then
 * rejected them, making a legitimate DBLP key unusable with an error that never mentioned DBLP.
 * Claiming a namespace on a guess about someone else's key space has to be the narrowest guess
 * that still does the job.
 */
const OPENALEX_ATTEMPT = /^w(\d|$)/i;

const REFERENCE_SOURCE_SET: ReadonlySet<string> = new Set(REFERENCE_SOURCES);

function isReferenceSource(value: string): value is ReferenceSourceId {
  return REFERENCE_SOURCE_SET.has(value);
}

function acceptedFormsMessage(input: string): string {
  return (
    `"${input}" is not a valid reference key. Accepted forms: a source-prefixed key ` +
    `(${REFERENCE_SOURCES.map((s) => `"${s}:<id>"`).join(', ')}, or "doi:<doi>" as an ` +
    `alias for crossref), a bare DBLP record key (e.g. "conf/cvpr/HeZRS16"), a bare DOI ` +
    `(e.g. "10.1109/CVPR.2016.90"), a bare OpenAlex work id (e.g. "W2194775991"), or a ` +
    `recognised URL (dblp.org/rec/<key>.html|.bib|.xml, dblp.uni-trier.de/rec/..., ` +
    `doi.org/<doi>, dx.doi.org/<doi>, api.crossref.org/works/<doi>, openalex.org/<id> or ` +
    `api.openalex.org/works/<id>).`
  );
}

/** Strip a full URL / `.bib`|`.html`|`.xml` suffix down to a bare DBLP record key and
 * validate it, so it can be safely interpolated into a request path. Mirrors
 * `DblpService.normalizeKey`. */
function normalizeDblpId(raw: string, original: string): string {
  let key = raw.trim();
  key = key.replace(/^https?:\/\/[^/]+\//i, '');
  key = key.replace(/^\/+/, '');
  key = key.replace(/^rec\//i, '');
  key = key.replace(/\.(bib|html|xml)$/i, '');
  if (!key || !DBLP_KEY.test(key) || key.includes('..')) {
    throw new Error(acceptedFormsMessage(original));
  }
  return key;
}

/** Validate a DOI strictly. The suffix's case is never touched — only the *decision* to
 * treat a string as a DOI is made case-insensitively; the returned id is verbatim. */
function normalizeDoi(raw: string, original: string): string {
  const id = raw.trim();
  if (!id || id.includes('..') || !DOI_KEY.test(id)) {
    throw new Error(acceptedFormsMessage(original));
  }
  return id;
}

/** Validate an OpenAlex work id, normalising only the leading `W` to uppercase. */
function normalizeOpenAlex(raw: string, original: string): string {
  const id = raw.trim();
  if (!id || !OPENALEX_KEY.test(id)) {
    throw new Error(acceptedFormsMessage(original));
  }
  return 'W' + id.slice(1);
}

function normalizeBySource(source: ReferenceSourceId, raw: string, original: string): string {
  switch (source) {
    case 'dblp':
      return normalizeDblpId(raw, original);
    case 'crossref':
      return normalizeDoi(raw, original);
    case 'openalex':
      return normalizeOpenAlex(raw, original);
  }
}

/** Decode a URL path segment defensively (a caller could smuggle `..` as `%2e%2e`); the
 * decoded string still goes through the same validation everything else does. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Route a recognised URL to its backend by host. Returns `null` for anything that isn't
 * a URL, or is a URL on a host this module doesn't recognise — the caller falls through
 * to the bare-key checks, which throw if nothing else matches either. */
function tryParseUrl(trimmed: string, original: string): ParsedRecordKey | null {
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const path = decodeSegment(url.pathname.replace(/^\/+/, ''));

  if (host === 'dblp.org' || host === 'dblp.uni-trier.de') {
    return { source: 'dblp', id: normalizeDblpId(path, original) };
  }
  if (host === 'doi.org' || host === 'dx.doi.org') {
    return { source: 'crossref', id: normalizeDoi(path, original) };
  }
  if (host === 'api.crossref.org') {
    const match = path.match(/^works\/(.+)$/i);
    if (!match?.[1]) throw new Error(acceptedFormsMessage(original));
    return { source: 'crossref', id: normalizeDoi(match[1], original) };
  }
  if (host === 'openalex.org') {
    return { source: 'openalex', id: normalizeOpenAlex(path, original) };
  }
  if (host === 'api.openalex.org') {
    const match = path.match(/^works\/(.+)$/i);
    if (!match?.[1]) throw new Error(acceptedFormsMessage(original));
    return { source: 'openalex', id: normalizeOpenAlex(match[1], original) };
  }
  return null;
}

/**
 * Parse any of the accepted record key forms — source-prefixed (`dblp:...`,
 * `crossref:...`, `openalex:...`, or `doi:...` as a crossref alias), a recognised URL, a
 * bare DOI, a bare OpenAlex id, or (for backward compatibility) a bare DBLP key — into a
 * `{source, id}` pair with `id` validated for its source. Throws on anything that
 * validates for no source; never returns a partially-validated value.
 */
export function parseRecordKey(input: string): ParsedRecordKey {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error(acceptedFormsMessage(input));
  }

  const prefixMatch = trimmed.match(/^([A-Za-z]+):([\s\S]*)$/);
  if (prefixMatch) {
    const prefix = (prefixMatch[1] ?? '').toLowerCase();
    const rest = prefixMatch[2] ?? '';
    if (prefix === 'doi') {
      return { source: 'crossref', id: normalizeDoi(rest, input) };
    }
    if (isReferenceSource(prefix)) {
      return { source: prefix, id: normalizeBySource(prefix, rest, input) };
    }
    // Not a recognised source prefix — it may still be a URL scheme (e.g. "https:"), so
    // fall through to URL parsing and finally the bare-key checks below, which throw
    // (naming the accepted sources) if it turns out to be neither.
  }

  const fromUrl = tryParseUrl(trimmed, input);
  if (fromUrl) return fromUrl;

  if (DOI_ATTEMPT.test(trimmed)) {
    return { source: 'crossref', id: normalizeDoi(trimmed, input) };
  }
  if (OPENALEX_ATTEMPT.test(trimmed)) {
    return { source: 'openalex', id: normalizeOpenAlex(trimmed, input) };
  }
  return { source: 'dblp', id: normalizeDblpId(trimmed, input) };
}

/** Format a `{source, id}` pair as the `source:id` string `parseRecordKey` accepts back. */
export function formatRecordKey(source: ReferenceSourceId, id: string): string {
  return `${source}:${id}`;
}

/**
 * A record key that says which bibliography backend it names. `search_references`
 * returns keys in this shape (`source:id`) and `add_citation` parses them to route
 * the fetch. Backward compatibility: a bare, unprefixed key (no recognised prefix,
 * not URL/DOI/OpenAlex-shaped) is still accepted and defaults to `dblp` — every
 * existing caller, doc and skill that passes a bare DBLP key (e.g.
 * `conf/cvpr/HeZRS16`) keeps working unchanged.
 *
 * Every id here is later interpolated into a request URL path by the service layer,
 * so validation is a security boundary, not a convenience: this module never returns a
 * partially-validated value, and never falls through to "assume dblp" for input that
 * fails DBLP's own shape check. Pure — no fs, no network, no process/env access.
 *
 * That purity forbids **lib -> service** only. A service importing from here is the
 * normal direction, and `DblpService.normalizeKey` takes it: it delegates to
 * `normalizeDblpKey` below rather than keeping a second copy of the same regex and the
 * same strip sequence. One security boundary, one implementation — a duplicate is one
 * edit away from two behaviours, and the two copies had already drifted (the old one in
 * `dblp.ts` stripped *any* `scheme://host/`, laundering an unrecognised host's path into
 * a DBLP key).
 */

export const REFERENCE_SOURCES = ['dblp', 'crossref', 'openalex'] as const;
export type ReferenceSourceId = (typeof REFERENCE_SOURCES)[number];

export interface ParsedRecordKey {
  source: ReferenceSourceId;
  id: string;
}

/** The only DBLP record-key shape in the server — `DblpService.normalizeKey` reaches it
 * through `normalizeDblpKey` rather than restating it. */
const DBLP_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * A DOI's registrant + suffix. DOIs legitimately contain `/`, so the explicit `..` check
 * below (not this allowlist) is what rejects traversal.
 *
 * The suffix class is an explicit allowlist, not a negated one, so a reader can see exactly
 * what is admitted — and it has to cover what registrars actually mint, because
 * `CrossrefService.search` emits `formatRecordKey('crossref', item.DOI)` for whatever DOI the
 * API returned: anything this rejects is a key the server prints and then refuses one
 * `add_citation` later. SICI-class DOIs alone need `()`, `<>`, `:`, `;` and `#`
 * (`10.1002/(SICI)1097-0142(19960101)77:1<50::AID-CNCR10>3.0.CO;2-#`), and `,`, `'`, `~`, `*`,
 * `!`, `$`, `=`, `@` all occur in the wild.
 *
 * Three things stay out, deliberately:
 *   - whitespace and control characters — a DOI never contains them, and they are what would
 *     let a header or a second path component be smuggled into a request;
 *   - `%` — this is the load-bearing one. It is what stops a double-encoded `%252e%252e` from
 *     decoding, downstream, into the `..` the explicit check looks for; the check runs on the
 *     literal string, so it can only see traversal that is already literal. Nothing needs `%`
 *     to survive: `CrossrefService.fetchBibtex` per-segment `encodeURIComponent`s the DOI
 *     before it reaches a URL, so a genuine `%` in a suffix round-trips as `%25` anyway.
 * Widening this class further is a security decision, not a convenience one — `%` especially.
 */
const DOI_KEY = /^10\.\d{4,9}\/[A-Za-z0-9._;()/:<>+,'~*!$=@#[\]-]+$/i;

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
 *
 * Narrowed a second time for the same reason: an OpenAlex work id never contains `/`, so
 * anything with one is released back to DBLP rather than claimed and then rejected. `/^w(\d|$)/i`
 * claimed `w3c/foo` — one character wider than the job needs, and the identical shape of bug as
 * the `www/` one, harmless only because DBLP happens to have no `w<digit>` top-level prefix
 * today. What is still claimed is exactly the slashless lookalikes (`W`, `W12a`), which is what
 * earns them the specific OpenAlex error instead of silent acceptance as odd DBLP keys.
 */
const OPENALEX_ATTEMPT = /^w(?:\d[^/]*)?$/i;

/**
 * The hosts `tryParseUrl` routes, spelled without a scheme — see the retry in `tryParseUrl`.
 * The optional trailing dot matches the one `tryParseUrl` strips from `url.hostname`: without it
 * the two spellings disagreed, and `dblp.org./rec/conf/x/y` fell through to the bare-key path
 * with the host swallowed into the key.
 */
const SCHEMELESS_KNOWN_HOST =
  /^(?:dblp\.org|dblp\.uni-trier\.de|doi\.org|dx\.doi\.org|api\.crossref\.org|openalex\.org|api\.openalex\.org)\.?\//i;

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

/**
 * Strip a full URL / `.bib`|`.html`|`.xml` suffix down to a bare DBLP record key and validate it,
 * so it can be safely interpolated into a request path.
 *
 * Exported because `DblpService.normalizeKey` delegates here — this is the single implementation
 * of that boundary, not a mirror of one. `original` is only ever what the error message quotes
 * back (a URL route hands in a decoded pathname but wants the user's own input named), and
 * defaults to `raw` for a caller that has nothing else to name.
 */
export function normalizeDblpKey(raw: string, original: string = raw): string {
  let key = raw.trim();
  // Still needed, though `tryParseUrl` now hands this function a bare pathname: the
  // source-prefixed form `dblp:https://dblp.org/rec/conf/x/y.bib` never goes through URL
  // routing at all, and neither does a bare key. Anchored to the two DBLP hosts on purpose:
  // stripping *any* `scheme://host/` let `dblp:https://evil.com/rec/conf/x/y` become the DBLP
  // key `conf/x/y` — the same silent host-laundering `tryParseUrl` refuses for an unprefixed
  // URL, reached by the one route that never goes through it. A host this does not strip is
  // left with its `:` and `/`, which `DBLP_KEY` rejects, so the refusal is the default. The
  // optional trailing dot keeps this in step with `tryParseUrl`, which strips one from
  // `url.hostname`: a legal spelling of the host must not parse on one route and throw on the other.
  key = key.replace(/^https?:\/\/(?:dblp\.org|dblp\.uni-trier\.de)\.?\//i, '');
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
      return normalizeDblpKey(raw, original);
    case 'crossref':
      return normalizeDoi(raw, original);
    case 'openalex':
      return normalizeOpenAlex(raw, original);
  }
}

/**
 * Decode a URL path, so an *encoded separator* still goes through the same validation
 * everything else does: `..%2f..%2fetc` is a single path segment as far as the URL parser is
 * concerned, so it survives into `url.pathname` intact and only decoding turns it back into
 * the `..` the guards look for.
 *
 * It does **not** defend against `%2e%2e`, whatever an earlier comment here claimed: WHATWG
 * `URL` owns dot segments and collapses `.`/`..`/`%2e`/`%2e%2e` away *before* `url.pathname`
 * can be read, so by the time this runs there is nothing left to catch. That case is refused
 * up front instead — see `hasDotSegment`.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * True when the *raw* path of `input` contains a dot segment, in any spelling WHATWG `URL`
 * recognises (`.`, `..`, and their `%2e` forms, case-insensitively).
 *
 * This has to be judged on the raw input, because the parser collapses such a segment before
 * `url.pathname` exists: `https://dblp.org/rec/%2e%2e/%2e%2e/etc/passwd` used to come back as
 * the perfectly valid-looking `{source: 'dblp', id: 'etc/passwd'}` — the caller's input
 * silently rewritten into a *different*, well-formed record key rather than refused. A
 * security boundary may not do that; refusing is the only honest answer.
 *
 * Special schemes treat `\` as a path separator too, so split on both. Deliberately narrow: it
 * asks only "is there a dot segment here", never "does the parsed path equal the raw one" —
 * the parser also percent-encodes `<`, `>` and friends, which real SICI DOI URLs carry, and a
 * whole-path equality check would refuse those for no security reason at all.
 */
function hasDotSegment(input: string): boolean {
  const afterScheme = input.replace(/^[A-Za-z][A-Za-z0-9+.-]*:/, '');
  const afterAuthority = afterScheme.replace(/^[/\\]{2}[^/\\?#]*/, '');
  const rawPath = afterAuthority.split(/[?#]/)[0] ?? '';
  return rawPath.split(/[/\\]/).some((segment) => {
    const decoded = decodeSegment(segment).toLowerCase();
    return decoded === '.' || decoded === '..';
  });
}

/** Route a recognised URL to its backend by host. Returns `null` only for input that isn't an
 * absolute `http(s)` URL at all (a bare key, a `scopus:123`-shaped prefix) — the caller falls
 * through to the bare-key checks, which throw if nothing else matches either. An `http(s)` URL
 * this module doesn't recognise throws rather than returning `null`; see below. */
function tryParseUrl(trimmed: string, original: string): ParsedRecordKey | null {
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // `acceptedFormsMessage` advertises the schemeless spellings ("dblp.org/rec/<key>.html",
    // "doi.org/<doi>", …), and without this retry every one of them failed `new URL` and fell
    // through to the bare-key path, where the host became part of the key:
    // "doi.org/10.1109/CVPR.2016.90" parsed as the DBLP record "doi.org/10.1109/CVPR.2016.90",
    // which 404s one call later. Only retried for a host this module actually routes, so a
    // bare key that merely contains a dot (none do today, but `DBLP_KEY` permits one) is not
    // quietly reinterpreted as a URL.
    if (!SCHEMELESS_KNOWN_HOST.test(trimmed)) return null;
    try {
      url = new URL(`https://${trimmed}`);
    } catch {
      return null;
    }
  }
  const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
  // Refuse before routing, not after: a dot segment is already gone from `url.pathname`.
  // Deliberately *not* gated on `isHttp`, even though routing now is. WHATWG collapses dot
  // segments for every special scheme, and this check answering for all of them means the
  // refusal cannot be lost by a later edit that widens which schemes route — a rewritten
  // identifier is the failure that must never depend on a second guard staying put.
  if (hasDotSegment(trimmed)) {
    throw new Error(acceptedFormsMessage(original));
  }
  // Route by host only for http(s). Routing used to switch on `url.hostname` alone, so
  // `ftp://dblp.org/rec/conf/x/y` was accepted as a DBLP key — the error text promises a
  // recognised URL, and a scheme nothing here would ever fetch is not one. A non-http URL
  // now falls through to the bare-key path, where its `:` fails `DBLP_KEY`.
  if (!isHttp) return null;
  // A single trailing dot is the fully-qualified spelling of the same host — `dblp.org.` IS
  // `dblp.org`, and refusing it was an incidental cost of comparing `url.hostname` exactly.
  // Stripped for the *comparison* only, and exactly one dot: nothing else about host matching
  // is loosened, so `dblp.org.evil.com` (a subdomain of evil.com) and `dblp.org@evil.com`
  // (`dblp.org` as userinfo, host `evil.com`) keep failing, as does `dblp.org..`.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const path = decodeSegment(url.pathname.replace(/^\/+/, ''));

  if (host === 'dblp.org' || host === 'dblp.uni-trier.de') {
    return { source: 'dblp', id: normalizeDblpKey(path, original) };
  }
  // A DOI may legitimately contain `#` (the Wiley/AGU SICI class ends `3.0.CO;2-#`) and `?`,
  // and `URL` reads everything from either as a fragment or a query — so `url.pathname`
  // silently hands back a *truncated* DOI that names a different, perfectly valid record.
  // Refuse instead: the bare and `crossref:`-prefixed forms carry the same DOI losslessly.
  // Same principle as the dot-segment refusal above — never rewrite an identifier into a
  // different valid one. Both spellings are checked, or fixing one leaves the other open.
  // Judged on the raw input, not `url.hash`: a DOI ending in a bare `#` parses to an EMPTY
  // fragment, so `url.hash` is '' and the truncation would have gone unnoticed — which is
  // exactly the SICI shape. DBLP and OpenAlex ids cannot contain `#`, so only DOIs need this.
  if (host === 'doi.org' || host === 'dx.doi.org') {
    if (trimmed.includes('#') || trimmed.includes('?')) {
      throw new Error(acceptedFormsMessage(original));
    }
    return { source: 'crossref', id: normalizeDoi(path, original) };
  }
  if (host === 'api.crossref.org') {
    if (trimmed.includes('#') || trimmed.includes('?')) {
      throw new Error(acceptedFormsMessage(original));
    }
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
  // An absolute http(s) URL on a host we don't recognise is refused here rather than handed back
  // to the bare-key path. **Defence in depth, and nothing more — read the next paragraph before
  // relying on it.**
  //
  // The comment that stood here claimed this line is what stops
  // `https://evil.com/rec/conf/cvpr/HeZRS16` becoming the DBLP key `conf/cvpr/HeZRS16`. It is
  // not. Turn this `throw` into `return null` and the whole suite stays green: the refusal comes
  // from `normalizeDblpKey`, whose host strip is anchored to the two DBLP hosts, so an
  // unrecognised host survives into the key carrying its `://` and fails `DBLP_KEY` on the `:`.
  // Same for `https://dblp.org@evil.com/...` (`dblp.org` is userinfo; the host is `evil.com`)
  // and `https://dblp.org.evil.com/...`. **That anchored strip is the guarantee.** Never weaken
  // it on the strength of this line, and never let a reader think the URL router is the guard.
  //
  // Nor does this line improve the message today: falling through reaches
  // `acceptedFormsMessage(original)` by the other road and reports the identical text. What it
  // is worth is that the refusal happens at *routing*, structurally, instead of resting on
  // `DBLP_KEY`'s character class continuing to exclude `:` — so a future widening of that class
  // cannot quietly turn a pasted `ieeexplore.ieee.org/document/7780459` into a DBLP key that
  // fails later as a missing record. Keep it; just do not count it twice.
  throw new Error(acceptedFormsMessage(original));
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
  return { source: 'dblp', id: normalizeDblpKey(trimmed, input) };
}

/** Format a `{source, id}` pair as the `source:id` string `parseRecordKey` accepts back. */
export function formatRecordKey(source: ReferenceSourceId, id: string): string {
  return `${source}:${id}`;
}

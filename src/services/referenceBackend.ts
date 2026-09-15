/**
 * Shared plumbing for reference-lookup backends (DBLP, Crossref, OpenAlex).
 *
 * Each backend fronts its API with the same failure shapes: a transport error, a non-OK
 * HTTP status, or — worse — a 200 that is actually a bot-challenge/interstitial HTML page
 * rather than API data. This module centralizes the body-sniffing and error wording so
 * every backend reports those failures the same, diagnosable way, and exposes
 * `BackendUnavailableError` so a resolver layer can tell "this backend could not answer"
 * apart from "this backend answered with zero results" or a caller error.
 */

/** The subset of `fetch`'s Response this client needs — keeps tests trivial. */
export interface FetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<FetchResponse>;

/** A publication match returned by a reference-lookup backend. */
export interface ReferenceHit {
  /** Namespaced record key (backend-specific prefix + backend record id). */
  key: string;
  /** Which backend produced this hit — the `ReferenceBackend.id` that returned it. */
  source: string;
  title: string;
  authors: string[];
  year?: number;
  /** Venue / journal name, when reported. */
  venue?: string;
  /** Record type, e.g. "Conference and Workshop Papers". */
  type?: string;
  doi?: string;
  /** Record URL (HTML page), when reported. */
  url?: string;
}

/** A backend able to search for publications and hand back namespaced hits. */
export interface ReferenceBackend {
  /** Stable lowercase id: 'dblp' | 'crossref' | 'openalex'. */
  readonly id: string;
  /** Human name for messages: 'DBLP' | 'Crossref' | 'OpenAlex'. */
  readonly name: string;
  search(query: string, opts?: { maxResults?: number }): Promise<ReferenceHit[]>;
}

/**
 * Thrown when a backend could not answer at all — a transport failure, a non-OK HTTP
 * status, or a bot-challenge/non-API body. Never thrown for a well-formed answer that
 * happens to contain zero results, and never for a caller error (e.g. an invalid record
 * key) — a resolver layer distinguishes substitutable failure from a real answer purely
 * by this type, so the distinction has to stay exact.
 *
 * **A 404 is split by what the request addressed**, the same `record`/`query` distinction
 * {@link httpHint} words its note by — so the type and the sentence beside it say the same
 * thing:
 *
 * - A 404 on a request that **names a record** (`fetchBibtex`, `resolveDoi`) is the backend
 *   *answering*: no record exists under that key. That is a plain `Error`, alongside the
 *   "no BibTeX entry found" refusal in the same methods — and it must stay one, because a
 *   key names one record in one backend, so there is nothing to substitute to.
 * - A 404 on a **search** is the backend failing to answer — a wrong base URL or a changed
 *   path, which another backend can well serve — and stays a `BackendUnavailableError`.
 *
 * An empty 200 on a record path is *not* covered by the first rule: an empty body is no
 * evidence that the record is absent, so it stays unavailable.
 */
export class BackendUnavailableError extends Error {
  readonly backend: string;

  constructor(backend: string, message: string) {
    super(message);
    this.name = 'BackendUnavailableError';
    this.backend = backend;
  }
}

/** How much of an unexpected body to quote back, so a failure is diagnosable from the error alone. */
export const BODY_EXCERPT = 180;

/** Shared request timeout, so a hung request cannot wedge a tool. */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * BibTeX entry header, e.g. `@inproceedings{DBLP:conf/cvpr/HeZRS16,`, **anchored to the start of
 * a line**.
 *
 * The anchor is load-bearing twice over. It keeps out the `@word{`-shaped things a web page
 * carries mid-line — an inline `@licstart` notice, a CSS `@media`/`@supports` rule, prose quoting
 * an entry — and, more importantly, it gives `bibtexEntrySpan` a position that can honestly be
 * cut from: a header found in the middle of `Warning: proxy error @article{evil,` has no line
 * boundary in front of it, so there is no way to return the entry without also returning the
 * banner. `\s*` after the `@word` is deliberately narrowed to `[ \t]*` for the same reason — a
 * newline between the name and its brace is not an entry header anyone writes, and allowing one
 * would let a match start on a line that is not the entry's.
 */
export const BIBTEX_ENTRY = /(^|\n)[ \t]*@[A-Za-z]+[ \t]*[{(]\s*[^,\s})]+\s*,/;

/**
 * The same header shape as {@link BIBTEX_ENTRY}, minus its `(^|\n)` prefix, for testing against a
 * slice the caller has already positioned at the start of a line. Kept beside `BIBTEX_ENTRY` so
 * the two shapes are edited together; a header accepted here but not there (or the reverse) would
 * let the *continuation* rule admit something the *first* header would refuse.
 */
const BIBTEX_ENTRY_AT_LINE_START = /^[ \t]*@[A-Za-z]+[ \t]*[{(]\s*[^,\s})]+\s*,/;

/** Byte range of the leading run of BibTeX entries in a service's response body. */
export interface BibtexEntrySpan {
  /** Offset of the `@` opening the first entry header. */
  start: number;
  /** Offset just past the last entry's closing delimiter. */
  end: number;
}

/**
 * The span of the leading run of BibTeX entries in `text`, or `null` when there is no
 * line-anchored entry header at all.
 *
 * Both `fetchBibtex` implementations slice `text.slice(start, end)`, so their answer to "which
 * bytes are the entry" comes from one place. Returning the whole body instead was how a service's
 * error banner got appended verbatim to a user's `.bib` on one side, and a trailing
 * `<script>alert(1)</script>` on the other: `mergeBibEntry` writes what it is handed, and
 * `BIBTEX_ENTRY.test()` alone proves only that an entry is in there *somewhere*.
 *
 * **This is not the server authoring BibTeX, and must never become that.** All it does is choose
 * a cut point in the bytes the service sent: everything between `start` and `end` is returned
 * verbatim. Nothing is inserted, reordered, reformatted, completed or repaired — an entry this
 * cannot parse is returned whole rather than fixed up (see the fail-open below), because the
 * guarantee callers rely on is that entry text originates from the service, and the moment this
 * function emits a byte the service did not send, that guarantee is gone.
 *
 * Four clauses, each load-bearing:
 *
 * - **Depth, over the pair the header opened with.** A `@article{` ends at the `}` that returns
 *   depth to 0 and a `@article(` at the matching `)`, so a brace inside a field value (`title =
 *   {A {Nested} Title}`) does not end the entry early. A delimiter preceded by a backslash is
 *   ignored — `note = {a literal \}}` is one BibTeX writes — and a `"`-quoted value at depth 1 is
 *   stepped over whole, because the braces inside one are the author's text and not the entry's
 *   structure (`title = "A } weird title"`).
 * - **A run of entries, not one.** After an entry closes, whitespace — plus a `%`-comment line or
 *   an `@string`/`@preamble`/`@comment` block, which are separators rather than the end of the
 *   run — is skipped, and if what follows opens another *line-anchored* header, that entry is
 *   consumed too. A service legitimately answers with more than one: DBLP's `param=1` bib emits an
 *   `@inproceedings` plus the `@proceedings` its `crossref` field names, and cutting the second
 *   off would corrupt the entry that survives. Getting that wrong is worse than the junk this cut
 *   removes — which is also why a skipped `@string` stays *inside* the span: it defines the macros
 *   the entries around it use, and an entry with an unresolved abbreviation is corrupt too. So
 *   skipping only ever widens `end`, and only as a bridge to a further entry: a trailing macro or
 *   comment that no entry follows stays out, like any other trailing junk.
 * - **A close alone on its line, and outside the other pair.** Depth reaching 0 is necessary but
 *   not sufficient: an unmatched `}` inside a value reaches it in the middle of the entry, and
 *   cutting there yields a syntactically broken fragment. Two tests stand between depth 0 and a
 *   cut. The delimiter must be the **only** non-whitespace character on its line — every entry a
 *   service emits closes with a lone `}`/`)` on its own line, and "last on its line" alone
 *   believed a stray closer that happened to end one (`abstract = {Sentence one} extra }`), which
 *   cut the entry in half. And it must sit **outside the other delimiter pair**: inside
 *   `@article(...)` a `)` in a braced value is the author's text, not the entry's close, so the
 *   scan counts `{}` alongside `()` (and symmetrically for a `{`-entry) and refuses any closer
 *   reached while the other pair is open. A delimiter failing either test is not believed and the
 *   scan fails open instead.
 * - **Fail open.** An entry whose delimiters never balance, or whose closing delimiter is not
 *   believed, spans to the end of the text — exactly what this returned before it could see an end
 *   at all. A truncated-but-plausible entry is worse than a whole one with junk after it, and
 *   `assertApiBody` plus the header check already stand in front of this. When in doubt this
 *   returns *more* of the service's bytes, never fewer. The guarantee that buys is exact, and it
 *   is the believability rules above that pay for it: `end` is only ever placed at a delimiter
 *   that closed the entry's own pair while no other pair was open **and** that stands alone on
 *   its line, the way every service closes an entry — so a cut lands where the service ended an
 *   entry, or nowhere at all. It is not a promise that no body can be misread: a body that closes
 *   an entry some other way (a whole entry on one line) is not truncated, it simply gets no cut
 *   point and comes back whole, junk and all.
 */
export function bibtexEntrySpan(text: string): BibtexEntrySpan | null {
  const match = BIBTEX_ENTRY.exec(text);
  if (!match || match.index === undefined) return null;
  // The match may open with the preceding newline and indentation; the entry starts at the `@`.
  const start = match.index + match[0].indexOf('@');

  let end = entryEnd(text, start);
  if (end === null) return { start, end: text.length };
  for (;;) {
    const next = nextEntryHeader(text, end);
    if (next.kind === 'end') return { start, end };
    if (next.kind === 'failOpen') return { start, end: text.length };
    const nextEnd = entryEnd(text, next.at);
    if (nextEnd === null) return { start, end: text.length };
    // Whatever the scan stepped over to get here — a `%` line, an `@string` block — lands inside
    // the span by construction: `end` is one offset, moved forward past the entry that follows the
    // separator. That is deliberate for `@string`, whose macros the entries need.
    end = nextEnd;
  }
}

/**
 * What follows the entry that just closed: one more entry to keep, the end of the run, or a body
 * this cannot read, which must widen the span to everything rather than risk cutting an entry in
 * half. Three outcomes rather than `number | null` because the last two are opposites — collapsing
 * them would either drop a legitimate trailing entry or keep every page's worth of trailing junk.
 */
type Continuation = { kind: 'entry'; at: number } | { kind: 'end' } | { kind: 'failOpen' };

/**
 * How a closing delimiter earns belief, so the two callers can demand different things of one.
 * An **entry**'s closer must be alone on its line; a **separator block**'s need only end one.
 */
type CloserTest = (text: string, i: number) => boolean;

/**
 * Offset just past the delimiter that closes the entry whose header begins at `at`, or `null` when
 * the delimiters never balance, or when the delimiter that balances them is not believable (the
 * two fail-open cases). The pair is whichever one the header opened with; the opening delimiter is
 * the first `{` or `(` at or after `at`, which the header shape guarantees is the entry's own
 * (`@[A-Za-z]+[ \t]*[{(]` admits nothing else in between).
 *
 * The *other* pair is counted alongside it, because the entry's own delimiters are structure only
 * outside it. `@article(` opens a paren entry whose field values are still braced, so a `)` inside
 * `title = {A ) title}` is the author's text; tracking one pair and ignoring the other cut that
 * entry at the `)` and appended a fragment with a dangling `{` to the user's `.bib`, which then
 * broke every entry after it. A closer reached while the other pair is open is refused outright
 * rather than stepped over: refusing fails open, and failing open is the direction this function
 * is allowed to be wrong in.
 *
 * `believes` is how a separator block opts out of the stricter half. Services close an *entry*
 * with a lone delimiter on its own line, but write `@string{cvpr = "CVPR"}` on a single line, so
 * demanding the strict shape there would fail open on every body carrying one — dropping the very
 * trailing entry the separator exists to bridge to. A block's end is never a cut point either
 * (`end` only ever comes from an entry's close), so the strict test buys nothing there.
 */
function entryEnd(text: string, at: number, believes: CloserTest = aloneOnItsLine): number | null {
  let i = at;
  while (i < text.length && text[i] !== '{' && text[i] !== '(') i++;
  if (i >= text.length) return null;
  const open = text[i];
  const close = open === '{' ? '}' : ')';
  const otherOpen = open === '{' ? '(' : '{';
  const otherClose = open === '{' ? ')' : '}';
  let depth = 0;
  // Depth over the pair the header did NOT open with. Never negative: an unmatched `)` in a braced
  // entry (`title = {Part 1)}`) opens nothing, so it must not put the counter into a state a later
  // `(` would cancel back to 0.
  let otherDepth = 0;
  for (; i < text.length; i++) {
    const ch = text[i];
    // A character the document escaped is a literal in a field value, not structure. Checked ahead
    // of the quote branch too: `author = "Kurt G\"{o}del"` is an umlaut, not the value's end.
    if (text[i - 1] === '\\') continue;
    // A `"`-quoted value is opaque — the delimiters inside it are the author's text. Gated on
    // `depth === 1` ONLY, deliberately: a `"` there can only be opening a value, and that is what
    // makes the common over-balance (`title = "A } weird title"`) come out exactly right instead
    // of by the fail-open below. An unterminated quote runs to the end of the text, so depth never
    // returns to 0 and the whole body is returned — the safe direction.
    //
    // Do NOT add `&& otherDepth === 0` here. It reads like the natural companion to the
    // `otherDepth` refusal below, and it is the opposite: it makes a quoted value *transparent*
    // whenever an earlier value left the other pair open, so the delimiters inside a string start
    // counting as structure. `@article{k,\n  a = {x(},\n  b = "z)\n}\n",\n}` was then cut at the
    // `}` inside `b`'s string — a fragment that is delimiter-balanced and ends with a lone closer
    // on its own line, so it looks like a whole entry while carrying an unterminated `"` that
    // swallows every entry appended after it. `otherDepth` exists to REFUSE a closer (fail open),
    // never to decide what is opaque; opacity may only ever be widened, never narrowed.
    if (depth === 1 && ch === '"') {
      i = quotedValueEnd(text, i);
      continue;
    }
    if (ch === otherOpen) {
      otherDepth++;
      continue;
    }
    if (ch === otherClose) {
      if (otherDepth > 0) otherDepth--;
      continue;
    }
    if (ch !== open && ch !== close) continue;
    depth += ch === open ? 1 : -1;
    if (depth !== 0) continue;
    // Depth 0 is necessary, not sufficient — two ways it can be reached mid-entry, both of which
    // used to cut a broken fragment into the user's `.bib`, worse than the trailing junk this
    // whole function exists to remove. Inside the other pair, this delimiter is somebody's prose
    // rather than the entry's close. And an unmatched `}` a `"`-quoted value did not account for
    // (`title = {A } weird title}`) reaches depth 0 in the middle of the entry: what separates it
    // from the real close is that a service's close is the only thing on its line, while one
    // inside a value practically never is — "last on its line" alone still believed
    // `abstract = {Sentence one} extra }`. `null` puts either on the same fail-open path as an
    // entry that never balances at all.
    if (otherDepth > 0) return null;
    return believes(text, i) ? i + 1 : null;
  }
  return null;
}

/**
 * Offset of the `"` closing the value opened by the `"` at `at`, or `text.length` when it is never
 * closed (which leaves the caller's depth scan unable to balance, so the body fails open).
 */
function quotedValueEnd(text: string, at: number): number {
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === '"' && text[i - 1] !== '\\') return i;
  }
  return text.length;
}

/**
 * True when the character at `i` is the *only* non-whitespace one on its line — the last
 * ({@link endsItsLine}) and also the first. The second half is what an entry's closer has to clear:
 * `endsItsLine` alone believes a stray `}` that happens to sit at the end of a line
 * (`abstract = {Sentence one} extra }`), and cutting there returns half an entry.
 */
function aloneOnItsLine(text: string, i: number): boolean {
  if (!endsItsLine(text, i)) return false;
  for (let j = i - 1; j >= 0; j--) {
    const ch = text[j];
    if (ch === '\n') return true;
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') return false;
  }
  return true;
}

/**
 * True when the character at `i` is the last non-whitespace one on its line (end of text counts).
 * `\r` is trailing whitespace like a space or a tab, so a CRLF body is judged identically to an LF
 * one — otherwise every entry a service sends with CRLF line endings would fail the test above and
 * carry its trailing junk into the `.bib`.
 */
function endsItsLine(text: string, i: number): boolean {
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\n') return true;
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') return false;
  }
  return true;
}

/**
 * The same header shape as the *first* header, for the things that may legitimately sit between two
 * entries without ending the run: a `@string` macro block (how a bibliography abbreviates the venue
 * its entries cite), a `@preamble`, or a `@comment`. Line-anchored for the same reason an entry
 * header is — one of these reached mid-line is part of somebody's web page.
 */
const BIBTEX_MACRO_AT_LINE_START = /^[ \t]*@(?:string|preamble|comment)[ \t]*[{(]/i;

/**
 * What follows the entry that ended at `from`. Whitespace is skipped, and so — repeatedly — are the
 * separators above and `%`-comment lines, because stopping at the first thing that is not itself a
 * header dropped a legitimate trailing entry: an `@inproceedings` whose `@proceedings` is separated
 * by the `@string` both use, which is exactly the dangling-`crossref` corruption the continuation
 * rule was written to prevent. Skipping only ever widens the span, never narrows it — a separator
 * is only stepped over on the way to another entry, and the span stops at the last entry found.
 *
 * A header (or separator) that does *not* begin its own line ends the run: that is prose mentioning
 * an entry rather than one more entry to keep.
 */
function nextEntryHeader(text: string, from: number): Continuation {
  let bound = from;
  for (;;) {
    let j = bound;
    while (j < text.length && /\s/.test(text[j] as string)) j++;
    if (j >= text.length) return { kind: 'end' };
    // Line-anchored means a newline was crossed getting here; everything from that newline to `j`
    // is then whitespace by construction, so the patterns' leading `[ \t]*` covers it.
    const lineStart = text.lastIndexOf('\n', j - 1) + 1;
    if (lineStart <= bound) return { kind: 'end' };
    if (text[j] === '%') {
      const nl = text.indexOf('\n', j);
      if (nl === -1) return { kind: 'end' };
      // The newline itself, so the next line clears the line-anchor test above.
      bound = nl;
      continue;
    }
    if (text[j] !== '@') return { kind: 'end' };
    const rest = text.slice(lineStart);
    // Entry first: whatever the *first*-header rule accepts stays an entry here, so the two shapes
    // cannot drift into disagreeing about what opens a run and what continues one.
    if (BIBTEX_ENTRY_AT_LINE_START.test(rest)) return { kind: 'entry', at: j };
    if (!BIBTEX_MACRO_AT_LINE_START.test(rest)) return { kind: 'end' };
    // `endsItsLine`, not the entry rule: `@string{cvpr = "CVPR"}` is how a service writes one, and
    // demanding a lone `}` on its own line would fail open on every body that carries a separator.
    const blockEnd = entryEnd(text, j, endsItsLine);
    // A separator we cannot find the end of is a body we cannot read. Ending the run here would
    // drop whatever follows; fail open instead, on the same reasoning as an unbalanced entry.
    if (blockEnd === null) return { kind: 'failOpen' };
    bound = blockEnd;
  }
}

/**
 * Reject a body that is a web page rather than the API's answer.
 *
 * DBLP (and other APIs behind the same class of protection) fronts its endpoints with an
 * anti-bot proof-of-work interstitial, and serves it with **HTTP 200** and an HTML body —
 * so `res.ok` is true and the status says nothing. Every caller must therefore sniff the
 * payload. Without this, `search` died inside `JSON.parse` with "Unexpected token '<'",
 * naming neither the service nor the reason, and `fetchBibtex`'s "does it contain an @"
 * check passed on the interstitial's own `@licstart` license header — the one thing that
 * check exists to stop.
 */
export function assertApiBody(service: string, body: string, what: string): void {
  const head = body.trimStart();
  if (!head.startsWith('<')) return;
  const challenge = /not a bot|proof[- ]of[- ]work|anubis/i.test(head.slice(0, 2000));
  throw new BackendUnavailableError(
    service,
    `${service} answered ${what} with an HTML page instead of API data` +
      // The remedy is only stated when we actually identified a challenge. A plain error page
      // told the reader to wait for an API-path exemption from a challenge that is not there.
      (challenge
        ? `, and it is ${service}'s anti-bot proof-of-work challenge. The ${service} API cannot ` +
          `be reached from this machine until ${service} exempts its API paths from it.`
        : `. The ${service} API cannot be reached from this machine.`) +
      ' Body began: ' +
      JSON.stringify(head.slice(0, BODY_EXCERPT)),
  );
}

/**
 * Perform the request, turning a **transport** failure into `BackendUnavailableError`.
 *
 * This is load-bearing for the whole fallback. `fetchImpl` rejects — offline, DNS failure,
 * ECONNREFUSED, a sandbox-blocked host, or the request timeout — with a `TypeError`/`DOMException`,
 * and the resolver deliberately rethrows anything that is not `BackendUnavailableError` (a caller
 * error would be rejected identically by every backend, so substituting would only bury the real
 * message). A raw transport error therefore aborted the chain instead of substituting — and a
 * timing-out DBLP is one of the two likeliest ways DBLP fails, alongside the bot wall this feature
 * exists for. Every request must go through here; a bare `fetchImpl` call is the bug.
 */
export async function fetchOrUnavailable(
  service: string,
  fetchImpl: FetchLike,
  url: string,
  init: { headers?: Record<string, string> } | undefined,
  what: string,
): Promise<FetchResponse> {
  try {
    return await fetchImpl(url, init);
  } catch (err) {
    throw new BackendUnavailableError(
      service,
      `${service} could not be reached for ${what}: ${transportReason(err)}.`,
    );
  }
}

/**
 * Read the response body, turning a **streaming** failure into `BackendUnavailableError`.
 *
 * `fetchOrUnavailable` covers only the call that resolves the *headers*. The abort signal handed
 * to `fetch` governs the whole operation, body streaming included, so the likeliest DBLP failure
 * of all rejects here rather than there: headers arrive fast (the anti-bot interstitial does
 * exactly that), the body then stalls until the signal fires, and `res.text()` rejects with a
 * `DOMException`/`TimeoutError`. An ECONNRESET mid-body is the same shape (`TypeError:
 * terminated`). The resolver rethrows anything that is not `BackendUnavailableError`, so either
 * one aborted the fallback chain at the very backend this feature exists to survive. Wrapping the
 * fetch but not the body read leaves exactly half the timeout unguarded; every `res.text()` must
 * go through here, for the same reason every `fetchImpl` call goes through `fetchOrUnavailable`.
 */
export async function readBodyOrUnavailable(
  service: string,
  res: FetchResponse,
  what: string,
): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    throw new BackendUnavailableError(
      service,
      `${service} could not be reached for ${what}: ${transportReason(err)} while reading the ` +
        `response body.`,
    );
  }
}

/** A short, non-leaky reason for a transport failure — an errno or timeout, not a stack. */
function transportReason(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return `the request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`;
  }
  return e?.cause?.code ?? e?.message ?? 'the connection failed';
}

/**
 * Reject a body that parsed as JSON but is not the shape this endpoint answers with.
 *
 * `assertApiBody` only catches a body that *looks* like a web page, and `JSON.parse` only catches
 * syntactic garbage. Between them sits a 200 carrying well-formed JSON of the wrong shape — an
 * API's own error envelope, say. Left unchecked, the mapping step finds no results container,
 * returns `[]`, and the resolver treats that as an **answer**: it stops the fallback chain and
 * reports "no results" for a backend that never actually searched. That is precisely the
 * zero-result/unreachable conflation the resolver exists to keep apart, so the shape has to be
 * checked where the shape is known — in each backend, not in the resolver.
 */
export function assertApiShape(
  service: string,
  wellShaped: boolean,
  what: string,
  body: string,
): void {
  if (wellShaped) return;
  throw new BackendUnavailableError(
    service,
    `${service} answered ${what} with JSON in an unexpected shape — the request may have ` +
      `been rejected without an error status. Body began: ` +
      JSON.stringify(body.trimStart().slice(0, BODY_EXCERPT)),
  );
}

/** Note appended to an HTTP failure, so a rate-limited caller knows to slow down, not retry harder. */
export function httpHint(
  service: string,
  status: number,
  addresses: 'record' | 'query' = 'query',
): string {
  if (status === 429) {
    return ` ${service} rate-limits its API — wait before retrying, and look papers up one at a time.`;
  }
  // A 404 is the backend answering, not the backend being down — but only a request that names a
  // record can be explained by "no such record". A *search* has no key, so the same sentence on a
  // search sends the reader after a nonexistent key instead of a wrong base URL or changed path.
  if (status === 404 && addresses === 'record') {
    return ` That usually means no record exists under this key, rather than ${service} being down.`;
  }
  return '';
}

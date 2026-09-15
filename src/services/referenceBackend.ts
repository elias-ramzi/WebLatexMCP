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

/** BibTeX entry header, e.g. `@inproceedings{DBLP:conf/cvpr/HeZRS16,`. */
export const BIBTEX_ENTRY = /@[A-Za-z]+\s*[{(]\s*[^,\s})]+\s*,/;

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

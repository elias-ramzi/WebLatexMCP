/**
 * Chooses which bibliography backend answers a lookup, and routes a record key back to the
 * backend that issued it.
 *
 * The selection rule is deliberately the same one `CompilerResolver` uses for the compile
 * backend, because the two decisions have the same shape: **an unchosen default may be
 * substituted when it cannot answer; an explicit choice is an assertion and is never
 * substituted.** `config.referenceSourceExplicit` is the whole licence for a substitution,
 * exactly as `config.compilerExplicit` is for a compiler one. Derive the answer here and
 * nowhere else, or a second code path will eventually disagree about whether the user chose.
 *
 * Two distinctions carry the whole design, and both are easy to erase by accident:
 *
 * 1. **A failure substitutes; an answer does not.** Only `BackendUnavailableError` — transport
 *    failure, non-OK status, bot-challenge body, unparseable JSON — lets the resolver try the
 *    next backend. A search that succeeds with zero hits is an *answer*: it is returned as-is.
 *    Falling through on an empty result would silently turn "DBLP has never heard of this" into
 *    "here is something Crossref found instead", which is a different claim than the caller made.
 *
 * 2. **A configured value that names no backend refuses; it does not fall back.**
 *    `parseReferenceSource` no longer throws on a typo — the setting governs this one tool, and
 *    failing to start would cost the user every other tool in the server — so an unusable value
 *    arrives here as `invalidSource` and `search` refuses an unpinned call by name
 *    (`ReferenceSourceInvalidError`). Falling through to `DEFAULT_SOURCE_ORDER` would be the
 *    real violation of "an assertion, never an inference": the user named a bibliography. A
 *    per-call `source:` is its own assertion and still works.
 *
 * 3. **`fetchBibtex` routes by the KEY, never by the configured source.** A key came out of a
 *    search result and carries its own provenance (`crossref:10.1109/…`), so it must go to the
 *    backend that issued it even when the config names another. Nothing is substituted here
 *    either: a key identifies one record in one backend, so there is nothing to substitute *to*.
 */

import { BackendUnavailableError } from './referenceBackend.js';
import type { ReferenceHit } from './referenceBackend.js';
import { parseRecordKey, REFERENCE_SOURCES } from '../lib/referenceKey.js';
import { quoteId } from '../lib/projectId.js';
import type { ReferenceSourceId } from '../lib/referenceKey.js';

/**
 * The order an unchosen default tries backends in.
 *
 * DBLP first: this server exists for LaTeX papers, and DBLP's computer-science metadata and
 * cite keys are the best match for that. Crossref second: the broadest coverage, and the only
 * backend besides DBLP that serves BibTeX directly. OpenAlex last — it serves no BibTeX at all,
 * so adding one of its records costs an extra DOI hop through Crossref.
 */
export const DEFAULT_SOURCE_ORDER: readonly ReferenceSourceId[] = ['dblp', 'crossref', 'openalex'];

export interface ResolvedSearch {
  hits: ReferenceHit[];
  /** The backend that actually answered — not necessarily the configured one. */
  source: ReferenceSourceId;
  /** The backend this substitutes for. Set ONLY on a fallback. */
  fallbackFrom?: ReferenceSourceId;
  /** Why the substitution happened, for the tool's hint. Set iff `fallbackFrom` is. */
  note?: string;
}

export interface ResolvedBibtex {
  /** The BibTeX, verbatim from whichever service issued it. */
  bibtex: string;
  /** The backend the key belongs to. */
  source: ReferenceSourceId;
  /**
   * The backend that actually served the BibTeX, when it is not `source`. Only OpenAlex sets
   * this: it publishes no BibTeX, so its records are fetched from Crossref by DOI.
   */
  via?: ReferenceSourceId;
}

/** Thrown when the caller pinned a backend and that backend could not answer. */
export class ReferenceSourceUnavailableError extends Error {
  readonly source: ReferenceSourceId;

  constructor(source: ReferenceSourceId, message: string) {
    super(message);
    this.name = 'ReferenceSourceUnavailableError';
    this.source = source;
  }
}

/**
 * Thrown when `WEB_LATEX_MCP_REFERENCE_SOURCE` holds a value that names no backend at all.
 *
 * Deliberately NOT a `ReferenceSourceUnavailableError`: that type carries a
 * `source: ReferenceSourceId`, and the whole problem here is that the configured value is not
 * one — there is no id to put in the field. It is also not substitutable. Only
 * `BackendUnavailableError` licenses trying the next backend, and this is not a backend failing
 * to answer: the user asserted a bibliography, and quietly answering from the default order
 * would give them a different bibliography than the one they named. Refusing is the honest
 * answer, and it stays scoped to `search_references` — `fetchBibtex` routes by the key and
 * never consults the configured source, so a bad value has nothing to do with it.
 */
export class ReferenceSourceInvalidError extends Error {
  /** The rejected value, exactly as `parseReferenceSource` kept it (trimmed, elided). */
  readonly value: string;

  constructor(value: string, message: string) {
    super(message);
    this.name = 'ReferenceSourceInvalidError';
    this.value = value;
  }
}

/** Thrown when an OpenAlex record carries no DOI, so no canonical BibTeX exists to fetch. */
export class NoCanonicalBibtexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoCanonicalBibtexError';
  }
}

/**
 * The backends are typed structurally, by the method each one actually needs, rather than as
 * the concrete service classes. Two reasons, and the second is the load-bearing one:
 * a unit test can pass a three-line fake instead of standing up three services with injected
 * `fetch`es; and `openalex` is declared with `resolveDoi` and **no** `fetchBibtex`, so the
 * *resolver* has no way to call one — `fetchBibtex` on an OpenAlex key routes through
 * `resolveDoi` + Crossref or refuses, and adding a call here would not typecheck.
 *
 * That is all this declaration enforces, and the distinction matters given how much weight the
 * ".bib bytes originate from the service" rule carries. TypeScript is structurally typed, so it
 * is NOT a compile-time guarantee that `OpenAlexService` has no `fetchBibtex`: growing one on the
 * class typechecks cleanly against `DoiBackend`, which only requires a subset. What pins the
 * absence is a runtime assertion — `test/unit/openalex.test.ts` asserts
 * `expect(svc.fetchBibtex).toBeUndefined()` ("OpenAlexService interface shape"). Keep that test;
 * this declaration cannot stand in for it.
 */
interface SearchBackend {
  search(query: string, opts?: { maxResults?: number }): Promise<ReferenceHit[]>;
}

interface BibtexBackend extends SearchBackend {
  fetchBibtex(keyOrUrl: string): Promise<string>;
}

interface DoiBackend extends SearchBackend {
  /** The record's DOI, or `null` when it has none — an answer, never an exception. */
  resolveDoi(keyOrId: string): Promise<string | null>;
}

export interface ReferenceBackends {
  dblp: BibtexBackend;
  crossref: BibtexBackend;
  openalex: DoiBackend;
}

/** The two ways a caller can pin a backend, and the wording each one needs in a refusal. */
type Pin = { source: ReferenceSourceId; how: 'call' | 'env' } | undefined;

export class ReferenceResolver {
  private readonly backends: ReferenceBackends;
  private readonly configured: ReferenceSourceId | undefined;
  private readonly explicit: boolean;
  private readonly invalidSource: string | undefined;

  constructor(
    backends: ReferenceBackends,
    opts: { source?: ReferenceSourceId; explicit?: boolean; invalidSource?: string } = {},
  ) {
    this.backends = backends;
    this.configured = opts.source;
    // An assertion, never an inference: a source is only "chosen" when someone said so. A
    // configured value that arrived without `explicit` would otherwise silently disable the
    // fallback that makes the tool work when a backend is down.
    this.explicit = opts.explicit === true;
    // `config.referenceSourceInvalid`: the user named a bibliography this server does not have.
    // Never combined with `source`/`explicit` — those describe a *usable* choice, and this one
    // is unusable by definition, so it can only ever produce a refusal, never a selection.
    this.invalidSource = opts.invalidSource;
  }

  /** The backend object for an id. */
  private backend(source: ReferenceSourceId): SearchBackend {
    return this.backends[source];
  }

  /** What the caller pinned, if anything: a per-call `source` always wins and is always a choice. */
  private pin(perCall: ReferenceSourceId | undefined): Pin {
    if (perCall) return { source: perCall, how: 'call' };
    if (this.configured && this.explicit) return { source: this.configured, how: 'env' };
    return undefined;
  }

  /**
   * The order an *unpinned* search tries backends in: the configured source first, then the rest
   * of `DEFAULT_SOURCE_ORDER`.
   *
   * Reached only when the source is NOT an assertion — an explicit one is a pin and never gets
   * here. So this is the `CompilerResolver` half of the analogy rather than the `pin()` half: an
   * unchosen `latexmk` is still the backend that is *tried*, it is merely substitutable when it
   * cannot answer. A configured-but-unchosen source that was skipped entirely would be a third
   * thing, neither a choice nor a default — and the surprise lands on whoever next adds a config
   * path that sets a source without marking it explicit, which `parseReferenceSource` does not do
   * today. Preferring it changes nothing observable now and keeps the field from becoming a trap.
   *
   * Substitution is unaffected: this decides what is tried FIRST, never what may be substituted.
   * Only `BackendUnavailableError` still licenses moving on, and a zero-hit answer still stops
   * the chain wherever it happens.
   */
  private unpinnedOrder(): readonly ReferenceSourceId[] {
    const preferred = this.configured;
    if (!preferred) return DEFAULT_SOURCE_ORDER;
    return [preferred, ...DEFAULT_SOURCE_ORDER.filter((s) => s !== preferred)];
  }

  /**
   * Search for publications.
   *
   * Pinned: that backend alone runs, and its failure is an error. Unpinned: the default order
   * runs until one answers, and a failure is reported in `note` rather than raised — never
   * silently, so the caller always knows which bibliography actually answered.
   */
  async search(
    query: string,
    opts: { maxResults?: number; source?: ReferenceSourceId } = {},
  ): Promise<ResolvedSearch> {
    const { maxResults } = opts;
    const pinned = this.pin(opts.source);

    // A per-call `source:` is the caller's own assertion and wins, exactly as it wins over a
    // *valid* configured source — so a broken env var never makes this tool unusable for a
    // caller who names a backend. Only an unpinned search has to be refused, and it is refused
    // rather than run: substituting the default order would answer from a bibliography the user
    // did not name, which is the one outcome worse than a refusal.
    if (!pinned && this.invalidSource !== undefined) {
      throw new ReferenceSourceInvalidError(
        this.invalidSource,
        invalidSourceMessage(this.invalidSource),
      );
    }

    if (pinned) {
      try {
        const hits = await this.backend(pinned.source).search(query, { maxResults });
        return { hits, source: pinned.source };
      } catch (err) {
        if (err instanceof BackendUnavailableError) {
          throw new ReferenceSourceUnavailableError(pinned.source, pinnedMessage(pinned, err));
        }
        throw err;
      }
    }

    const failures: Array<{ source: ReferenceSourceId; error: BackendUnavailableError }> = [];
    for (const source of this.unpinnedOrder()) {
      try {
        const hits = await this.backend(source).search(query, { maxResults });
        const first = failures[0];
        // Zero hits is an answer, not a failure — return it. Only `first` being set means a
        // backend ahead of this one could not answer, which is the substitution to report.
        if (!first) return { hits, source };
        return {
          hits,
          source,
          // The backend that was preferred and did not answer. Every other failure on the way
          // here is named in the note — see there for why reporting only the first is not enough.
          fallbackFrom: first.source,
          note: substitutionNote(failures, source),
        };
      } catch (err) {
        if (err instanceof BackendUnavailableError) {
          failures.push({ source, error: err });
          continue;
        }
        // A caller error (an empty query, say) is not a reason to try a different bibliography:
        // every backend would reject it identically, and the real message would be buried.
        throw err;
      }
    }

    throw new BackendUnavailableError(
      failures.map((f) => f.source).join(', '),
      'No reference backend could be reached. ' +
        failures.map((f) => `${f.source}: ${f.error.message}`).join(' | '),
    );
  }

  /**
   * Fetch canonical BibTeX for a record key, from the backend that issued that key.
   *
   * The returned text is whatever the service sent, verbatim. Nothing here composes, reformats
   * or completes an entry: `add_citation` is the only sanctioned way into a `.bib`, and it is
   * only worth that status while the bytes provably originate from the service.
   */
  async fetchBibtex(keyOrUrl: string): Promise<ResolvedBibtex> {
    const { source, id } = parseRecordKey(keyOrUrl);

    if (source === 'dblp') {
      return { bibtex: await this.backends.dblp.fetchBibtex(id), source };
    }
    if (source === 'crossref') {
      return { bibtex: await this.backends.crossref.fetchBibtex(id), source };
    }

    // OpenAlex publishes no BibTeX at all, so the record's DOI is the only route to a canonical
    // entry. No DOI means there is nothing verifiable to fetch — and synthesizing one from
    // OpenAlex's JSON is exactly what this server refuses to do, so the refusal is the answer.
    //
    // The wording of that refusal is load-bearing. It is the only server-authored text that tells
    // a model it may originate `.bib` entry bytes itself, so it must name the user's approval
    // BEFORE the flag, in the same order `bibEditBlockedMessage` (src/lib/bib.ts) uses:
    // `confirmBibEdit` is worth nothing except as the user's acknowledgement. Not shared with
    // that function on purpose — different situation, different subject — so a test pins the
    // order here instead.
    const doi = await this.backends.openalex.resolveDoi(id);
    if (doi === null) {
      throw new NoCanonicalBibtexError(
        `OpenAlex record "${id}" carries no DOI, and OpenAlex publishes no BibTeX of its own, ` +
          'so there is no canonical entry to fetch. Search for the paper again with ' +
          'source: "dblp" or source: "crossref" and add it from there; if it exists in neither, ' +
          'the reference has to be added by hand: first ask the user to approve the entry, ' +
          'then write it with confirmBibEdit: true.',
      );
    }
    return { bibtex: await this.backends.crossref.fetchBibtex(doi), source, via: 'crossref' };
  }
}

/** Refusal for a backend the caller pinned — it names the pin, and both routes off it. */
function pinnedMessage(pin: NonNullable<Pin>, err: BackendUnavailableError): string {
  const how =
    pin.how === 'call'
      ? `source: "${pin.source}" was requested`
      : `WEB_LATEX_MCP_REFERENCE_SOURCE names ${pin.source}`;
  const others = REFERENCE_SOURCES.filter((s) => s !== pin.source)
    .map((s) => `"${s}"`)
    .join(' or ');
  return (
    `${err.message} ${how}, so no other backend was tried. ` +
    `Pass source: ${others} to search another, or ` +
    (pin.how === 'call'
      ? 'omit source: to let the server substitute one automatically.'
      : 'unset WEB_LATEX_MCP_REFERENCE_SOURCE to let the server substitute one automatically.')
  );
}

/**
 * The rejected env value as the refusal shows it: `quoteId`'d, so a newline in it cannot forge a
 * second line of the message nor a bidi control reorder the rest of it — the way `config.ts`
 * quotes every env value it rejects. The value arrives already elided (`parseReferenceSource`
 * cuts it to `<head>… (N characters)`), so that count is split back off and kept OUTSIDE the
 * quotes, where it reads as the server's note rather than as part of the value. The split is
 * taken only when the count exceeds the head it follows, as an elision's always does; were an
 * unelided value to end in that exact shape it would merely be quoted in two pieces, both
 * escaped, the suffix being nothing but digits. `server_info` renders the same value through this
 * too, so the two messages quote it alike.
 */
export function quoteInvalidSource(value: string): string {
  const elided = /^([\s\S]*)… \((\d+) characters\)$/u.exec(value);
  if (elided && Number(elided[2]) > elided[1]!.length) {
    return `${quoteId(elided[1]!)}… (${elided[2]} characters)`;
  }
  return quoteId(value);
}

/**
 * Refusal for a configured source that names no backend — same wording discipline as
 * `pinnedMessage`: name what is actually available, and both routes off the refusal.
 */
function invalidSourceMessage(value: string): string {
  const ids = REFERENCE_SOURCES.map((s) => `"${s}"`).join(', ');
  return (
    `WEB_LATEX_MCP_REFERENCE_SOURCE is set to ${quoteInvalidSource(value)}, which is not a bibliography backend ` +
    `this server knows; expected one of: ${REFERENCE_SOURCES.join(', ')}. No search was run: ` +
    'you named a bibliography, and answering from a different one would be a different claim. ' +
    'Fix or unset WEB_LATEX_MCP_REFERENCE_SOURCE (unset restores the default order: ' +
    `${DEFAULT_SOURCE_ORDER.join(', then ')}), or pass source: ${ids} on this call to search ` +
    'one now. Every other tool on this server is unaffected by the setting.'
  );
}

/**
 * Hint for a substitution the caller did not ask for — reported, never silent.
 *
 * It names **every** backend that failed on the way here, not just the first. With DBLP walled
 * and Crossref rate-limiting, OpenAlex answers and a first-failure-only note would mention the
 * wall and silently drop the rate limit — which is the one thing that changes what the caller
 * should do next (slow down, rather than wait for someone else's infrastructure). CLAUDE.md's
 * compiler analogue sets the same precedent: every refusal names what is actually there.
 */
function substitutionNote(
  failures: ReadonlyArray<{ source: ReferenceSourceId; error: BackendUnavailableError }>,
  to: ReferenceSourceId,
): string {
  const names = failures.map((f) => f.source).join(' and ');
  const detail = failures.map((f) => `${f.source}: ${f.error.message}`).join(' | ');
  const pin = failures[0]!.source;
  return (
    `${names} could not be reached, so ${to} answered instead. ${detail} ` +
    `Pass source: "${pin}" to make this an error rather than a substitution.`
  );
}

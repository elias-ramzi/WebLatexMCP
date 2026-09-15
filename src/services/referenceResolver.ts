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
 * 2. **`fetchBibtex` routes by the KEY, never by the configured source.** A key came out of a
 *    search result and carries its own provenance (`crossref:10.1109/…`), so it must go to the
 *    backend that issued it even when the config names another. Nothing is substituted here
 *    either: a key identifies one record in one backend, so there is nothing to substitute *to*.
 */

import { BackendUnavailableError } from './referenceBackend.js';
import type { ReferenceHit } from './referenceBackend.js';
import { parseRecordKey, REFERENCE_SOURCES } from '../lib/referenceKey.js';
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
 * `fetch`es; and `openalex` is typed with `resolveDoi` and **no** `fetchBibtex`, so the type
 * system itself records that OpenAlex publishes no BibTeX. A future edit that "completes" the
 * interface has to change this declaration to do it, which is a visible act rather than a quiet one.
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

  constructor(
    backends: ReferenceBackends,
    opts: { source?: ReferenceSourceId; explicit?: boolean } = {},
  ) {
    this.backends = backends;
    this.configured = opts.source;
    // An assertion, never an inference: a source is only "chosen" when someone said so. A
    // configured value that arrived without `explicit` would otherwise silently disable the
    // fallback that makes the tool work when a backend is down.
    this.explicit = opts.explicit === true;
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
    for (const source of DEFAULT_SOURCE_ORDER) {
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
    const doi = await this.backends.openalex.resolveDoi(id);
    if (doi === null) {
      throw new NoCanonicalBibtexError(
        `OpenAlex record "${id}" carries no DOI, and OpenAlex publishes no BibTeX of its own, ` +
          'so there is no canonical entry to fetch. Search for the paper again with ' +
          'source: "dblp" or source: "crossref" and add it from there; if it exists in neither, ' +
          'the reference has to be added by hand with confirmBibEdit: true.',
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

/**
 * Running `search_references_batch`'s queries: one at a time, paced, and bounded in time.
 *
 * Why this exists. Verifying a bibliography is one lookup per entry, and the services behind
 * `search_references` (DBLP, Crossref, OpenAlex) rate-limit hard. The `verify-citations` skill
 * therefore told the model to make the calls strictly one after another and back off on a 429 —
 * pacing done by the model, one round trip per entry, every result passing through its context.
 * The server can pace better than the model can, so this module takes over that discipline: the
 * caller hands over a list, and the server makes the same sequential calls with the same spacing
 * and the same backoff the skill describes. Nothing here searches in parallel, and nothing here
 * is a different search: each query goes through `ReferenceResolver.search` exactly as a single
 * `search_references` call does, with the same pin, substitution and refusals.
 *
 * Three bounds, each with its reason:
 *
 *  1. **Spacing** ({@link BATCH_SPACING_MS}) between consecutive queries — the model's own think
 *     time used to space its calls out; a server loop has none, and back-to-back requests are what
 *     trips the limiters.
 *  2. **Backoff after a failure** ({@link BATCH_BACKOFF_MS}, 5 s → 10 s → 20 s, the figures the
 *     skill gives), and a stop after {@link BATCH_MAX_CONSECUTIVE_FAILURES} failures in a row:
 *     at that point the services are refusing us, and hammering on only lengthens the cooldown.
 *  3. **A start deadline** ({@link BATCH_START_DEADLINE_MS}): no query starts once it has passed,
 *     so a client's tool-call timeout is not spent on queries the caller will never see answered.
 *     A query already running is never cut short — it is bounded by the backends' own request
 *     timeout.
 *
 * Queries a stop leaves unstarted are reported `notRun`, in order, so the caller can send exactly
 * those again. A failure is reported per query and never stops the batch on its own — except a
 * refusal that every query would meet identically (`isFatal`, an invalid configured source),
 * which is raised whole, as the single-query tool raises it.
 *
 * Pure over its dependencies: the search, the clock and the sleep are injected, so the pacing is
 * tested without waiting and without a network.
 */

import type { ResolvedSearch } from '../services/referenceResolver.js';

/** At most this many queries per call — the house figure for a capped list. */
export const BATCH_MAX_QUERIES = 20;

/** Pause between two queries when the previous one was answered. */
export const BATCH_SPACING_MS = 1000;

/**
 * Pause before the next query after one or more consecutive failures, indexed by the number of
 * failures in a row minus one (the last figure repeats). The skill's own 5 s → 10 s → 20 s.
 */
export const BATCH_BACKOFF_MS: readonly number[] = [5000, 10000, 20000];

/** This many failures in a row stops the batch; the rest is reported `notRun`. */
export const BATCH_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * No query starts later than this after the call began. With the backends' 15 s request timeout
 * and three backends tried in an unpinned search, one query can take up to 45 s, so this keeps a
 * whole call near a minute and a half in the worst case and well under a minute in the ordinary
 * one (20 answered queries at one per second plus the spacing).
 */
export const BATCH_START_DEADLINE_MS = 45_000;

/**
 * Longest error or substitution note kept per query. Resolver messages quote each backend's
 * failure (a body excerpt of up to 180 characters each), and up to twenty of them would otherwise
 * crowd every hit out of the payload.
 */
export const BATCH_MESSAGE_CAP = 300;

/** Marker ending a message cut to {@link BATCH_MESSAGE_CAP}, so a cut is never mistaken for the whole. */
export const BATCH_MESSAGE_CUT_MARKER = ' …[cut]';

/** One query's outcome. `hits` keep the backend's rank order. */
export type BatchItem =
  | {
      query: string;
      status: 'ok';
      source: string;
      fallbackFrom?: string;
      note?: string;
      hits: ResolvedSearch['hits'];
    }
  | { query: string; status: 'error'; error: string }
  | { query: string; status: 'notRun' };

/** Why a batch ended before its last query, if it did. */
export type BatchStop = 'failures' | 'deadline';

export interface BatchRun {
  items: BatchItem[];
  stopped?: BatchStop;
}

export interface BatchDeps {
  /** One search — `ReferenceResolver.search` with the call's `maxResults`/`source` bound in. */
  search(query: string): Promise<ResolvedSearch>;
  sleep(ms: number): Promise<void>;
  /** A monotonic clock, in milliseconds. */
  now(): number;
  /** Scrubs secrets from an error message before it is reported. */
  redact(message: string): string;
  /** An error every query would meet identically, raised whole rather than reported per query. */
  isFatal(err: unknown): boolean;
}

/** Cuts `message` to {@link BATCH_MESSAGE_CAP} characters, marker included. */
export function capBatchMessage(message: string): string {
  if (message.length <= BATCH_MESSAGE_CAP) return message;
  return (
    message.slice(0, BATCH_MESSAGE_CAP - BATCH_MESSAGE_CUT_MARKER.length) + BATCH_MESSAGE_CUT_MARKER
  );
}

/** The pause owed before the next query, given how many failures in a row came just before. */
export function pauseBefore(consecutiveFailures: number): number {
  if (consecutiveFailures === 0) return BATCH_SPACING_MS;
  const index = Math.min(consecutiveFailures, BATCH_BACKOFF_MS.length) - 1;
  return BATCH_BACKOFF_MS[index]!;
}

/** Runs `queries` in order, one at a time, under the bounds described above. */
export async function runReferenceBatch(
  queries: readonly string[],
  deps: BatchDeps,
): Promise<BatchRun> {
  const started = deps.now();
  const items: BatchItem[] = [];
  let failuresInARow = 0;
  let stopped: BatchStop | undefined;

  for (const [index, query] of queries.entries()) {
    if (index > 0) {
      if (failuresInARow >= BATCH_MAX_CONSECUTIVE_FAILURES) {
        stopped = 'failures';
        break;
      }
      const pause = pauseBefore(failuresInARow);
      // Judged before the pause, so a call never sleeps only to start nothing.
      if (deps.now() - started + pause > BATCH_START_DEADLINE_MS) {
        stopped = 'deadline';
        break;
      }
      await deps.sleep(pause);
    }

    try {
      const found = await deps.search(query);
      items.push({
        query,
        status: 'ok',
        source: found.source,
        ...(found.fallbackFrom ? { fallbackFrom: found.fallbackFrom } : {}),
        ...(found.note ? { note: capBatchMessage(found.note) } : {}),
        hits: found.hits,
      });
      failuresInARow = 0;
    } catch (err) {
      if (deps.isFatal(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      items.push({ query, status: 'error', error: capBatchMessage(deps.redact(message)) });
      failuresInARow += 1;
    }
  }

  for (const query of queries.slice(items.length)) items.push({ query, status: 'notRun' });
  return stopped ? { items, stopped } : { items };
}

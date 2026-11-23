/**
 * Deciding how much of `search_references_batch`'s hits may be returned, against a character
 * budget charged on the RENDERED result in BOTH channels — the family of `fileListBudget.ts` and
 * `diffBudget.ts`. A pure planner over plain data: the render functions live here beside the cost
 * functions and the cost functions **call** them, so the charge and the text cannot drift apart.
 * The tool hands {@link planReferenceBatch}'s `items` to `structuredContent` as they are and
 * builds its text with {@link renderReferenceBatchText}; a unit test pins the two channels' total
 * against {@link REFERENCE_BATCH_BUDGET}.
 *
 * What is document-controlled here is the backends' records — a title, and an author list with no
 * bound at all (a physics collaboration paper lists thousands). Twenty queries at up to ten hits
 * each is two hundred records, so without a bound one long author list or one generous
 * `maxResults` produces the payload a client rejects undelivered.
 *
 * The three decisions:
 *
 *  1. **A hit is kept whole or not at all.** A verification compares the author list — every
 *     surname and the count — so a hit with its authors trimmed would read as a mismatch that is
 *     not there. Nothing inside a hit is cut.
 *  2. **Cut by rank across queries** (`ALLOCATION_ORDER`): every query's first hit before any
 *     query's second, and so on. A batch is a list of separate lookups, and the top hit is what
 *     each of them is mostly for — so one query with ten long hits must not starve the nineteen
 *     after it. Within a query the kept hits are always a **prefix** of the backend's ranking:
 *     once one hit of a query does not fit, that query keeps none after it, so "the first hit
 *     shown" always means "the backend's first hit".
 *  3. **The per-query frame is charged first and never cut**: the query, its status, `source`,
 *     an error or a substitution note (each already capped by `capBatchMessage`). Which query
 *     failed or was not run is the part the caller must act on.
 *
 * A cut is counted (`resultsOmitted`, per query and in total) and named in the note, and stays
 * distinguishable from "no results": `count` is what the backend returned, `results` what was
 * kept.
 */

import type { ReferenceHit } from '../services/referenceBackend.js';
import type { BatchItem, BatchStop } from './referenceBatch.js';

/**
 * Total character budget across BOTH channels. Twice the house 20000, for the reason
 * `FILE_LIST_CONTENT_BUDGET` gives: the hits are the whole result here, not one field's share of
 * it, so 20000 per channel is the house figure per rendered payload. It stays well under the ~67k
 * a client rejected in #68. The frame worst case — twenty queries of the longest accepted query
 * with a capped message each, in both channels — is about 25000, so hits always get the rest.
 */
export const REFERENCE_BATCH_BUDGET = 40000;

/**
 * The order hits are kept in, with each rank's reason — see decision 2 above. Ranks run across
 * queries; within a rank, queries keep the caller's order.
 */
export const ALLOCATION_ORDER = [
  'frame: every query, its status, source, error or note — never cut',
  'hit rank 1 of every query, in query order — the match each lookup is mostly for',
  'hit rank 2, 3, … the same way — a query that has lost a hit keeps none after it',
] as const;

/** One query as published: the outcome plus what was kept of its hits. */
export interface PlannedBatchItem {
  query: string;
  status: 'ok' | 'error' | 'notRun';
  /** Hits the backend returned — present for an answered query only. */
  count?: number;
  source?: string;
  fallbackFrom?: string;
  hint?: string;
  error?: string;
  results: ReferenceHit[];
  /** Hits returned but not kept, by the budget. */
  resultsOmitted: number;
}

export interface ReferenceBatchPlan {
  items: PlannedBatchItem[];
  searched: number;
  failed: number;
  notRun: number;
  resultsOmitted: number;
  stopped?: BatchStop;
  note?: string;
}

/** One hit as a text block — the same shape `search_references` renders. */
export function renderHit(hit: ReferenceHit): string {
  const authors = hit.authors.length ? hit.authors.join(', ') : 'unknown authors';
  const where = [hit.venue, hit.year].filter(Boolean).join(' ');
  return `• ${hit.title}\n  ${authors}${where ? ` — ${where}` : ''}\n  key: ${hit.key}`;
}

/** One query's heading line (and its message, if any), without hits. */
export function renderItemHeader(item: PlannedBatchItem, position: number): string {
  const head = `[${position}] ${JSON.stringify(item.query)}`;
  if (item.status === 'notRun') return `${head} — not run`;
  if (item.status === 'error') return `${head} — failed: ${item.error ?? ''}`;
  const kept = item.results.length;
  const counted =
    item.count === 0
      ? 'no results'
      : kept === item.count
        ? `${item.count} result(s)`
        : `${kept} of ${item.count} result(s) shown`;
  const hint = item.hint ? `\n  Note: ${item.hint}` : '';
  return `${head} — ${counted} from ${item.source ?? 'unknown'}:${hint}`;
}

/** The summary line heading the text channel. */
export function renderSummary(
  plan: Omit<ReferenceBatchPlan, 'items' | 'note'> & { total: number },
): string {
  return (
    `${plan.searched} of ${plan.total} queries answered` +
    ` (${plan.failed} failed, ${plan.notRun} not run).`
  );
}

/** The whole text channel, rendered from the already-cut plan. */
export function renderReferenceBatchText(plan: ReferenceBatchPlan): string {
  const blocks = plan.items.map((item, i) => {
    const hits = item.results.map((hit) => `\n${renderHit(hit)}`).join('');
    return `${renderItemHeader(item, i + 1)}${hits}`;
  });
  const summary = renderSummary({ ...plan, total: plan.items.length });
  const note = plan.note ? `\n\nNote: ${plan.note}` : '';
  return `${summary}\n\n${blocks.join('\n\n')}${note}`;
}

/** Text + JSON cost of one hit: its block plus the newline before it, its JSON plus a comma. */
export function hitCost(hit: ReferenceHit): number {
  return renderHit(hit).length + 1 + JSON.stringify(hit).length + 1;
}

/** Text + JSON cost of one query's frame: header, block separator, and its JSON with no hits. */
export function frameCost(item: PlannedBatchItem, position: number): number {
  return (
    renderItemHeader(item, position).length +
    2 +
    JSON.stringify({ ...item, results: [] }).length +
    1
  );
}

/**
 * Room held back for what is rendered after the plan is made — the summary line, the top-level
 * JSON keys and the note — so the frame and hits are charged against what is truly left. The
 * note is bounded (it names counts and at most the cap's worth of positions), and a test pins
 * that the whole result stays under {@link REFERENCE_BATCH_BUDGET}.
 */
export const REFERENCE_BATCH_SCAFFOLD_RESERVE = 1200;

function frameOf(item: BatchItem): PlannedBatchItem {
  if (item.status === 'notRun')
    return { query: item.query, status: 'notRun', results: [], resultsOmitted: 0 };
  if (item.status === 'error') {
    return {
      query: item.query,
      status: 'error',
      error: item.error,
      results: [],
      resultsOmitted: 0,
    };
  }
  return {
    query: item.query,
    status: 'ok',
    count: item.hits.length,
    source: item.source,
    ...(item.fallbackFrom ? { fallbackFrom: item.fallbackFrom } : {}),
    ...(item.note ? { hint: item.note } : {}),
    results: [],
    resultsOmitted: 0,
  };
}

/** 1-based positions, listed — the note names which queries to send again. */
function positions(
  items: readonly PlannedBatchItem[],
  pick: (item: PlannedBatchItem) => boolean,
): number[] {
  return items.flatMap((item, i) => (pick(item) ? [i + 1] : []));
}

function buildNote(plan: Omit<ReferenceBatchPlan, 'note'>): string | undefined {
  const parts: string[] = [];
  if (plan.stopped === 'failures') {
    parts.push(
      'Stopped after repeated failures — the bibliography services are refusing or unreachable; ' +
        'wait a minute before sending the queries marked not run again.',
    );
  } else if (plan.stopped === 'deadline') {
    parts.push(
      'Stopped at the time limit for one call; send the queries marked not run again in a new call.',
    );
  }
  if (plan.resultsOmitted > 0) {
    const cut = positions(plan.items, (item) => item.resultsOmitted > 0);
    parts.push(
      `${plan.resultsOmitted} lower-ranked hit(s) left out to keep the result deliverable ` +
        `(queries ${cut.join(', ')}); hits are kept whole and in rank order. Send those queries ` +
        'again with a smaller batch or a lower maxResults to see them.',
    );
  }
  return parts.length ? parts.join(' ') : undefined;
}

/** Plans the published result of a batch run. */
export function planReferenceBatch(
  run: { items: readonly BatchItem[]; stopped?: BatchStop },
  budget: number = REFERENCE_BATCH_BUDGET,
): ReferenceBatchPlan {
  const items = run.items.map(frameOf);
  let left = budget - REFERENCE_BATCH_SCAFFOLD_RESERVE;
  items.forEach((item, i) => {
    left -= frameCost(item, i + 1);
  });

  const closed = new Set<number>();
  const deepest = Math.max(
    0,
    ...run.items.map((item) => (item.status === 'ok' ? item.hits.length : 0)),
  );
  for (let rank = 0; rank < deepest; rank++) {
    run.items.forEach((source, i) => {
      if (source.status !== 'ok' || rank >= source.hits.length || closed.has(i)) return;
      const hit = source.hits[rank]!;
      const cost = hitCost(hit);
      if (cost <= left) {
        items[i]!.results.push(hit);
        left -= cost;
      } else {
        closed.add(i);
      }
    });
  }

  let resultsOmitted = 0;
  for (const item of items) {
    if (item.status !== 'ok') continue;
    item.resultsOmitted = (item.count ?? 0) - item.results.length;
    resultsOmitted += item.resultsOmitted;
  }

  const base = {
    items,
    searched: items.filter((item) => item.status === 'ok').length,
    failed: items.filter((item) => item.status === 'error').length,
    notRun: items.filter((item) => item.status === 'notRun').length,
    resultsOmitted,
    ...(run.stopped ? { stopped: run.stopped } : {}),
  };
  const note = buildNote(base);
  return note ? { ...base, note } : base;
}

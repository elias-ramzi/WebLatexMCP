import { describe, expect, it } from 'vitest';
import {
  REFERENCE_BATCH_BUDGET,
  planReferenceBatch,
  renderReferenceBatchText,
  type ReferenceBatchPlan,
} from '../../src/lib/referenceBatchBudget.js';
import {
  BATCH_MAX_QUERIES,
  BATCH_MESSAGE_CAP,
  type BatchItem,
} from '../../src/lib/referenceBatch.js';
import type { ReferenceHit } from '../../src/services/referenceBackend.js';

function hit(id: string, authors = 3, titleChars = 60): ReferenceHit {
  return {
    key: `dblp:conf/x/${id}`,
    source: 'dblp',
    title: `${id} `.padEnd(titleChars, 't'),
    authors: Array.from({ length: authors }, (_, i) => `Author Number${i}`),
    year: 2020,
    venue: 'CVPR',
    doi: `10.1/${id}`,
    url: `https://dblp.org/rec/conf/x/${id}`,
  };
}

function answered(query: string, hits: ReferenceHit[]): BatchItem {
  return { query, status: 'ok', source: 'dblp', hits };
}

/** What the tool ships: the text channel plus the structured payload, as JSON. */
function shippedSize(plan: ReferenceBatchPlan): number {
  const structured = {
    queries: plan.items.length,
    searched: plan.searched,
    failed: plan.failed,
    notRun: plan.notRun,
    resultsOmitted: plan.resultsOmitted,
    ...(plan.stopped ? { stopped: plan.stopped } : {}),
    ...(plan.note ? { note: plan.note } : {}),
    items: plan.items,
  };
  return renderReferenceBatchText(plan).length + JSON.stringify(structured).length;
}

describe('planReferenceBatch', () => {
  it('keeps everything that fits, uncut and uncounted', () => {
    const plan = planReferenceBatch({
      items: [answered('a', [hit('a1'), hit('a2')]), answered('b', [])],
    });
    expect(plan.items[0]!.results).toHaveLength(2);
    expect(plan.items[1]).toMatchObject({ count: 0, results: [], resultsOmitted: 0 });
    expect(plan.resultsOmitted).toBe(0);
    expect(plan.note).toBeUndefined();
  });

  it("gives every query its top hit before any query's second", () => {
    // One query with ten huge hits ahead of nineteen ordinary ones.
    const greedy = answered(
      'greedy',
      Array.from({ length: 10 }, (_, i) => hit(`g${i}`, 300)),
    );
    const others = Array.from({ length: 19 }, (_, i) =>
      answered(`q${i}`, [hit(`q${i}a`), hit(`q${i}b`)]),
    );
    const plan = planReferenceBatch({ items: [greedy, ...others] });

    for (const item of plan.items) expect(item.results.length).toBeGreaterThanOrEqual(1);
    expect(plan.items[0]!.resultsOmitted).toBeGreaterThan(0);
    expect(plan.resultsOmitted).toBe(
      plan.items.reduce((sum, item) => sum + item.resultsOmitted, 0),
    );
    expect(plan.note).toMatch(/queries 1\b/);
  });

  it("keeps a prefix of each query's ranking: nothing after a hit that did not fit", () => {
    const plan = planReferenceBatch(
      { items: [answered('a', [hit('a1'), hit('a2', 2000), hit('a3')])] },
      6000,
    );
    expect(plan.items[0]!.results.map((h) => h.key)).toEqual(['dblp:conf/x/a1']);
    expect(plan.items[0]!.resultsOmitted).toBe(2);
  });

  it('never cuts inside a hit: authors arrive whole or the hit is omitted', () => {
    const plan = planReferenceBatch({ items: [answered('a', [hit('big', 5000)])] });
    expect(plan.items[0]!.results).toEqual([]);
    expect(plan.items[0]).toMatchObject({ count: 1, resultsOmitted: 1 });
  });

  it('reports failures and not-run queries in the frame, whatever the budget', () => {
    const plan = planReferenceBatch(
      {
        items: [
          answered('a', [hit('a1')]),
          { query: 'b', status: 'error', error: 'DBLP search failed: 429' },
          { query: 'c', status: 'notRun' },
        ],
        stopped: 'failures',
      },
      0,
    );
    expect(plan.items.map((i) => i.status)).toEqual(['ok', 'error', 'notRun']);
    expect(plan.items[1]!.error).toContain('429');
    expect(plan).toMatchObject({ searched: 1, failed: 1, notRun: 1, stopped: 'failures' });
    const text = renderReferenceBatchText(plan);
    expect(text).toContain('[2] "b" — failed: DBLP search failed: 429');
    expect(text).toContain('[3] "c" — not run');
    expect(text).toContain('Stopped after repeated failures');
  });

  it('stays within the budget across both channels at the worst accepted input', () => {
    // Every query at the longest accepted length, half failing with a capped message, half
    // answering with ten hits each carrying long author lists.
    const longQuery = (i: number) => `${i} `.padEnd(300, 'q');
    const items: BatchItem[] = Array.from({ length: BATCH_MAX_QUERIES }, (_, i) =>
      i % 2
        ? { query: longQuery(i), status: 'error', error: 'e'.repeat(BATCH_MESSAGE_CAP) }
        : {
            query: longQuery(i),
            status: 'ok',
            source: 'crossref',
            fallbackFrom: 'dblp',
            note: 'n'.repeat(BATCH_MESSAGE_CAP),
            hits: Array.from({ length: 10 }, (_, k) => hit(`${i}-${k}`, 40, 200)),
          },
    );
    const plan = planReferenceBatch({ items, stopped: 'deadline' });
    expect(plan.resultsOmitted).toBeGreaterThan(0);
    expect(shippedSize(plan)).toBeLessThanOrEqual(REFERENCE_BATCH_BUDGET);
    // And the budget is used, not hoarded.
    expect(shippedSize(plan)).toBeGreaterThan(REFERENCE_BATCH_BUDGET * 0.9);
  });

  it('renders the text channel from the cut plan', () => {
    const plan = planReferenceBatch({ items: [answered('a', [hit('a1'), hit('a2', 2000)])] }, 4000);
    const text = renderReferenceBatchText(plan);
    expect(text).toContain('1 of 2 result(s) shown');
    expect(text).toContain('key: dblp:conf/x/a1');
    expect(text).not.toContain('key: dblp:conf/x/a2');
  });
});

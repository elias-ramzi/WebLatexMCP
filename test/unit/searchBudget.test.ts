import { describe, it, expect } from 'vitest';
import {
  planSearchPayload,
  renderMatchesText,
  SEARCH_CONTENT_BUDGET,
  SEARCH_MAX_MATCHES,
} from '../../src/lib/searchBudget.js';
import type { SearchMatch, SkippedFile } from '../../src/lib/searchFiles.js';

/**
 * The rendered-size bound on a `search_files` payload.
 *
 * The assertion that matters in every test here is the same one: `JSON.stringify(plan.matches)`
 * — the exact string the client receives inside `structuredContent` — is no longer than the
 * budget. A count cap is not a bound on that, and neither is an accounting that charges content
 * only: issue #68's second round of bugs was precisely a budget that counted content and not the
 * punctuation and escaping wrapped around it, so a payload of many small elements blew the same
 * limit with its content nowhere near it.
 */

function match(over: Partial<SearchMatch> = {}): SearchMatch {
  return { path: 'sections/intro.tex', line: 42, text: 'the matching line', ...over };
}

function encodedSize(items: unknown[]): number {
  return JSON.stringify(items).length;
}

describe('planSearchPayload: the size bound', () => {
  it('keeps the encoded matches array inside the budget for long entries', () => {
    const matches = Array.from({ length: 500 }, (_unused, i) =>
      match({
        line: i + 1,
        text: 'x'.repeat(200),
        before: ['b'.repeat(200)],
        after: ['a'.repeat(200)],
      }),
    );

    const plan = planSearchPayload(matches, []);

    expect(encodedSize(plan.matches)).toBeLessThanOrEqual(SEARCH_CONTENT_BUDGET);
    expect(plan.omittedBySize).toBeGreaterThan(0);
    expect(plan.matches.length + plan.omittedBySize + plan.omittedByCap).toBe(matches.length);
  });

  it('keeps it inside the budget for MANY SMALL entries, where the punctuation is the payload', () => {
    // Content of ~1 character per entry: an accounting that charges only `text` would put these
    // at ~200 characters in total and return every one of them, rendering far past the budget.
    const matches = Array.from({ length: SEARCH_MAX_MATCHES }, (_unused, i) =>
      match({ path: 'a.tex', line: i + 1, text: 'x' }),
    );

    const plan = planSearchPayload(matches, []);

    expect(encodedSize(plan.matches)).toBeLessThanOrEqual(SEARCH_CONTENT_BUDGET);
  });

  it('charges JSON escaping, not raw length — LaTeX is backslash-dense', () => {
    // Every character of `text` here doubles when encoded. Charging `text.length` would let
    // twice as many entries through as fit, and the encoded array would run past the budget.
    const matches = Array.from({ length: 400 }, (_unused, i) =>
      match({ line: i + 1, text: '\\'.repeat(150) }),
    );

    const plan = planSearchPayload(matches, []);

    expect(encodedSize(plan.matches)).toBeLessThanOrEqual(SEARCH_CONTENT_BUDGET);
    expect(plan.omittedBySize).toBeGreaterThan(0);
  });

  it('cuts the TAIL and never reorders or cherry-picks', () => {
    const matches = [
      match({ line: 1, text: 'x'.repeat(19900) }),
      match({ line: 2, text: 'small' }),
      match({ line: 3, text: 'small' }),
    ];

    const plan = planSearchPayload(matches, []);

    expect(plan.matches.map((m) => m.line)).toEqual([1]);
    expect(plan.omittedBySize).toBe(2);
  });

  it('keeps one over-budget entry rather than returning nothing', () => {
    const matches = [match({ line: 7, text: 'x'.repeat(SEARCH_CONTENT_BUDGET * 2) }), match()];

    const plan = planSearchPayload(matches, []);

    expect(plan.matches).toHaveLength(1);
    expect(plan.matches[0]?.line).toBe(7);
    expect(plan.omittedBySize).toBe(1);
    expect(plan.note).toContain('the first match alone renders to');
  });
});

describe('planSearchPayload: both channels', () => {
  it('keeps the JSON and the rendered text TOGETHER inside the budget', () => {
    // The text channel renders every kept match again. Many files (a path header each) and
    // context lines (numbered, plus a `--`) are what make the text the larger of the two.
    const matches = Array.from({ length: 300 }, (_unused, i) =>
      match({
        path: `sections/part-${i}.tex`,
        line: i + 3,
        text: 'x'.repeat(120),
        before: ['b'.repeat(80), 'c'.repeat(80)],
        after: ['a'.repeat(80)],
      }),
    );

    const plan = planSearchPayload(matches, [], { contextLines: 2 });
    const text = renderMatchesText(plan.matches, 2).join('\n');

    expect(encodedSize(plan.matches) + text.length).toBeLessThanOrEqual(SEARCH_CONTENT_BUDGET);
    expect(plan.omittedBySize).toBeGreaterThan(0);
    // And not by a wide margin: the budget is spent, not merely respected.
    expect(encodedSize(plan.matches) + text.length).toBeGreaterThan(SEARCH_CONTENT_BUDGET * 0.9);
  });
});

describe('planSearchPayload: the count cap', () => {
  it('returns at most SEARCH_MAX_MATCHES, counting the rest', () => {
    const matches = Array.from({ length: SEARCH_MAX_MATCHES + 37 }, (_unused, i) =>
      match({ line: i + 1, text: 'x' }),
    );

    const plan = planSearchPayload(matches, []);

    expect(plan.matches).toHaveLength(SEARCH_MAX_MATCHES);
    expect(plan.omittedByCap).toBe(37);
    expect(plan.omittedBySize).toBe(0);
  });

  it('names only the bound that fired', () => {
    const capped = planSearchPayload(
      Array.from({ length: SEARCH_MAX_MATCHES + 1 }, () => match({ text: 'x' })),
      [],
    );
    expect(capped.note).toContain('at most 200 are returned');
    expect(capped.note).not.toContain('payload budget');

    const sized = planSearchPayload(
      Array.from({ length: 50 }, () => match({ text: 'x'.repeat(1000) })),
      [],
    );
    expect(sized.note).toContain('payload budget');
    expect(sized.note).not.toContain('at most 200 are returned');
  });

  it('has no note at all when nothing was cut', () => {
    const plan = planSearchPayload([match()], []);
    expect(plan.note).toBeUndefined();
    expect(plan.omittedByCap).toBe(0);
    expect(plan.omittedBySize).toBe(0);
  });
});

describe('planSearchPayload: the skipped list', () => {
  const skipped = (n: number): SkippedFile[] =>
    Array.from({ length: n }, (_unused, i) => ({ path: `figures/fig${i}.png`, reason: 'asset' }));

  it('is bounded on its own, so "not searched" is never crowded out by hits', () => {
    // A full, over-budget match list alongside a long skipped list: the skipped records must
    // still come through, because "this file was not searched" is a different claim from "no
    // match here" and losing it turns one into the other.
    const matches = Array.from({ length: 500 }, (_unused, i) =>
      match({ line: i + 1, text: 'x'.repeat(200) }),
    );

    const plan = planSearchPayload(matches, skipped(100));

    expect(plan.omittedBySize).toBeGreaterThan(0);
    // The full count cap's worth, not the single entry a SHARED budget would have left room
    // for after the matches exhausted it.
    expect(plan.skipped).toHaveLength(20);
    expect(plan.skipped.length + plan.skippedOmitted).toBe(100);
  });

  it('caps the skipped list by count and says so', () => {
    const plan = planSearchPayload([], skipped(50));
    expect(plan.skipped).toHaveLength(20);
    expect(plan.skippedOmitted).toBe(30);
    expect(plan.note).toContain('lists at most 20 paths');
  });

  it('cuts the skipped list by size when its paths are long, and says THAT instead', () => {
    const long: SkippedFile[] = Array.from({ length: 10 }, (_unused, i) => ({
      path: `${'d'.repeat(400)}/${i}.png`,
      reason: 'asset',
    }));

    const plan = planSearchPayload([], long);

    expect(encodedSize(plan.skipped)).toBeLessThanOrEqual(2000);
    expect(plan.skippedOmitted).toBeGreaterThan(0);
    expect(plan.note).toContain('character budget');
    expect(plan.note).not.toContain('lists at most');
  });
});

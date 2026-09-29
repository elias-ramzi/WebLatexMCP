import { describe, it, expect } from 'vitest';
import {
  planFloatsPayload,
  FLOATS_CONTENT_BUDGET,
  FLOAT_ENTRY_JSON_OVERHEAD,
  FLOATS_ARRAY_JSON_OVERHEAD,
  type FloatEntryLike,
} from '../../src/lib/floatsBudget.js';
import type { AuxLabel } from '../../src/lib/auxFloats.js';

/**
 * Deliberately typed `AuxLabel` — the reader's own type, i.e. the objects the tool actually puts
 * into `structuredContent.floats` — and NOT the planner's structural `FloatEntryLike`.
 *
 * That is the whole tie that makes FLOAT_ENTRY_JSON_OVERHEAD a pin rather than a test of itself.
 * `planFloatsPayload` accepts anything structurally compatible, and the tool passes a variable
 * rather than a fresh object literal, so TypeScript's excess-property check never fires on the
 * real call: a fourth field added to `AuxLabel` would be JSON-encoded into the payload, charged
 * nothing by the accounting, and caught by nothing. Because this returns `AuxLabel`, that same
 * fourth field is a compile error HERE, at the constant that would have to change with it.
 */
function entry(label: string, number = '1', page = '1'): AuxLabel {
  return { label, number, page };
}

/**
 * The planner's own accounting, restated independently of the module so the pin tests below cannot
 * pass by agreeing with a mistake: each value's real `JSON.stringify` length plus the named
 * per-entry constant, plus the array brackets.
 */
function accountedLength(entries: readonly FloatEntryLike[]): number {
  const values = entries.reduce(
    (sum, e) =>
      sum +
      JSON.stringify(e.label).length +
      JSON.stringify(e.number).length +
      JSON.stringify(e.page).length,
    0,
  );
  return values + FLOAT_ENTRY_JSON_OVERHEAD * entries.length + FLOATS_ARRAY_JSON_OVERHEAD;
}

describe('FLOAT_ENTRY_JSON_OVERHEAD (constant pin)', () => {
  it('accounts for exactly the JSON punctuation around a known floats array', () => {
    // The array `structuredContent.floats` will actually carry, encoded the way MCP encodes it.
    const entries = [
      entry('fig:overview', '1', '3'),
      entry('fig:overview', '1', '3'),
      entry('fig:overview', '1', '3'),
    ];
    const real = JSON.stringify(entries).length;
    expect(real).toBe(148);

    // The accounting is an UPPER bound and lands exactly one character high: the per-entry charge
    // includes an inter-element comma for every entry, and the last entry has no comma after it —
    // that spare character pays for one of the two brackets. Erring high by a known, fixed amount
    // is the only safe direction; a constant that drifted low would under-count silently.
    expect(accountedLength(entries)).toBe(149);
    expect(accountedLength(entries) - real).toBe(1);

    // And the per-entry constant on its own, with the three values subtracted exactly.
    const one = entry('fig:overview', '1', '3');
    const valueChars =
      JSON.stringify(one.label).length +
      JSON.stringify(one.number).length +
      JSON.stringify(one.page).length;
    expect(valueChars).toBe(20);
    expect(JSON.stringify(one).length - valueChars).toBe(FLOAT_ENTRY_JSON_OVERHEAD - 1);
  });

  it('FLOATS_ARRAY_JSON_OVERHEAD is the real cost of the empty array', () => {
    expect(JSON.stringify([]).length).toBe(FLOATS_ARRAY_JSON_OVERHEAD);
    expect(FLOATS_ARRAY_JSON_OVERHEAD).toBe(2);
  });

  it('FLOATS_CONTENT_BUDGET matches the house number used for conflict payloads', () => {
    expect(FLOATS_CONTENT_BUDGET).toBe(20000);
  });
});

describe('planFloatsPayload', () => {
  it('returns an empty plan with no note for no entries', () => {
    const plan = planFloatsPayload([]);
    expect(plan.floats).toEqual([]);
    expect(plan.omittedBySize).toBe(0);
    expect(plan.note).toBeUndefined();
  });

  it('keeps everything, with no note, when the whole list fits', () => {
    const entries = [entry('fig:a'), entry('tab:b', '2', '4'), entry('fig:c', '3', '7')];
    const plan = planFloatsPayload(entries);
    expect(plan.floats).toEqual(entries);
    expect(plan.omittedBySize).toBe(0);
    expect(plan.note).toBeUndefined();
  });

  it('keeps a list that lands EXACTLY on the budget in full', () => {
    // Each entry: 3 values of 5+1+1 raw chars => 7 + 6 quotes = 13, plus 29 = 42 rendered.
    // Two of them plus the 2-char array brackets is exactly 86.
    const entries = [entry('fig:a'), entry('fig:a')];
    expect(accountedLength(entries)).toBe(86);

    const plan = planFloatsPayload(entries, { budget: 86 });
    expect(plan.floats).toHaveLength(2);
    expect(plan.omittedBySize).toBe(0);
    expect(plan.note).toBeUndefined();
    // The bound is real: what actually goes on the wire is 85, one under the accounting.
    expect(JSON.stringify(plan.floats).length).toBe(85);
  });

  it('cuts the last entry when one more character of content pushes it over', () => {
    // Same budget as the test above; the second label is one character longer, so the list needs
    // 87 where 86 is available.
    const entries = [entry('fig:a'), entry('fig:ab')];
    expect(accountedLength(entries)).toBe(87);

    const plan = planFloatsPayload(entries, { budget: 86 });
    expect(plan.floats).toHaveLength(1);
    expect(plan.floats[0]?.label).toBe('fig:a');
    expect(plan.omittedBySize).toBe(1);
    expect(plan.note).toContain('1 of the 2 float(s) that reached this budget were omitted');
    expect(plan.note).toContain('86-char floats payload budget');
  });

  it('charges the JSON-ESCAPED size, so a backslash-heavy label costs more than its raw length', () => {
    // This is a bug conflictBudget.ts once had, reproduced here so it cannot ship twice: a `\label`
    // is document-controlled LaTeX, and LaTeX is backslash-dense.
    const escaped = entry('\\'.repeat(10), '2', '2');
    expect(escaped.label.length).toBe(10);
    expect(JSON.stringify(escaped.label).length).toBe(22); // 10 backslashes -> 20, plus 2 quotes

    const entries = [entry('fig:a'), escaped];
    // Budget 100. First entry: 2 (brackets) + 42 = 44 used. Second entry really costs
    // 22 + 3 + 3 + 29 = 57, so 44 + 57 = 101 > 100 and it is cut...
    expect(accountedLength([escaped]) - FLOATS_ARRAY_JSON_OVERHEAD).toBe(57);
    // ...whereas charging raw content length would have made it 10 + 1 + 1 + 29 = 41, i.e. 85 in
    // total, comfortably "within" a budget it in fact overruns.
    const rawCost = escaped.label.length + escaped.number.length + escaped.page.length;
    expect(rawCost + FLOAT_ENTRY_JSON_OVERHEAD).toBe(41);
    expect(44 + 41).toBeLessThanOrEqual(100);

    const plan = planFloatsPayload(entries, { budget: 100 });
    expect(plan.floats).toHaveLength(1);
    expect(plan.floats[0]?.label).toBe('fig:a');
    expect(plan.omittedBySize).toBe(1);
  });

  it('keeps input order and never prefers small entries over a large earlier one', () => {
    // 'x' * 50 => 52 + 3 + 3 + 29 = 87 rendered; the two small entries cost 38 each and would both fit
    // in the 100-char budget if the planner were allowed to reorder or cherry-pick.
    const big = entry('x'.repeat(50), '1', '1');
    const small1 = entry('a', '2', '2');
    const small2 = entry('b', '3', '3');
    expect(accountedLength([big]) - FLOATS_ARRAY_JSON_OVERHEAD).toBe(87);
    expect(accountedLength([small1]) - FLOATS_ARRAY_JSON_OVERHEAD).toBe(38);

    const plan = planFloatsPayload([big, small1, small2], { budget: 100 });
    expect(plan.floats).toHaveLength(1);
    expect(plan.floats[0]?.label).toBe('x'.repeat(50));
    expect(plan.omittedBySize).toBe(2);
  });

  it('preserves the given order among the entries it keeps', () => {
    const entries = [entry('fig:c'), entry('fig:a'), entry('fig:b')];
    const plan = planFloatsPayload(entries, { budget: 2 + 42 * 2 });
    expect(plan.floats.map((f) => f.label)).toEqual(['fig:c', 'fig:a']);
    expect(plan.omittedBySize).toBe(1);
  });

  it('keeps a single entry that is larger than the whole budget, with no note when it is alone', () => {
    // A bound that returns nothing tells the caller less than one over-budget row does, and the
    // .aux reader already caps each field at 200 chars, so "one entry" is bounded by construction.
    const plan = planFloatsPayload([entry('fig:a')], { budget: 10 });
    expect(plan.floats).toHaveLength(1);
    expect(plan.floats[0]?.label).toBe('fig:a');
    expect(plan.omittedBySize).toBe(0);
    expect(plan.note).toBeUndefined();
  });

  it('names the oversized first entry as the reason, and cuts everything after it', () => {
    const plan = planFloatsPayload([entry('fig:a'), entry('fig:b'), entry('fig:c')], {
      budget: 10,
    });
    expect(plan.floats).toHaveLength(1);
    expect(plan.omittedBySize).toBe(2);
    expect(plan.note).toContain('2 of the 3 float(s) that reached this budget were omitted');
    expect(plan.note).toContain('the first float entry alone renders to 42 chars');
    // The note names only the cause that fired: this is one huge row, not a list that ran long.
    expect(plan.note).not.toContain('was reached');
  });

  it('bounds the worst case the count-only cap allowed (200 entries x 3 fields x 200 chars)', () => {
    // Every field at the reader's 200-char cap and every character a backslash: the payload the
    // old count-only bound permitted.
    const worst = '\\'.repeat(200);
    const entries = Array.from({ length: 200 }, () => entry(worst, worst, worst));
    expect(JSON.stringify(entries).length).toBe(247001);

    const plan = planFloatsPayload(entries);
    expect(plan.floats).toHaveLength(16);
    expect(plan.omittedBySize).toBe(184);
    expect(JSON.stringify(plan.floats).length).toBe(19761);
    expect(JSON.stringify(plan.floats).length).toBeLessThanOrEqual(FLOATS_CONTENT_BUDGET);
    expect(plan.note).toContain('184 of the 200 float(s) that reached this budget were omitted');
    expect(plan.note).toContain('20000-char floats payload budget');
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INLINE_BUDGET_BYTES,
  planInlining,
  type InlineCandidate,
} from '../../src/lib/inlineBudget.js';

describe('planInlining', () => {
  it('inlines every page when everything fits comfortably under the budget', () => {
    const candidates: InlineCandidate[] = [
      { page: 1, bytes: 10_000 },
      { page: 2, bytes: 10_000 },
      { page: 3, bytes: 10_000 },
    ];

    const plan = planInlining(candidates, { inline: true });

    expect(plan.inlined).toEqual([true, true, true]);
    expect(plan.note).toBeUndefined();
  });

  it('inline: false inlines nothing and points the caller at pngPath', () => {
    const candidates: InlineCandidate[] = [
      { page: 1, bytes: 10_000 },
      { page: 2, bytes: 10_000 },
    ];

    const plan = planInlining(candidates, { inline: false });

    expect(plan.inlined).toEqual([false, false]);
    expect(plan.note).toBeDefined();
    expect(plan.note).toMatch(/pngPath/);
  });

  it('sticky prefix: a page too big to fit is skipped, and a later small page that would fit is skipped too', () => {
    // budget: 5 MiB, matching DEFAULT_INLINE_BUDGET_BYTES.
    const budgetBytes = 5 * 1024 * 1024;
    // Pages 1-3 are 1,800,000 raw bytes each (divisible by 3, so base64 encoding is exact:
    // encoded = 1,800,000/3*4 = 2,400,000). Page 4 is small (100,000 raw bytes, encoded ~133,336).
    const candidates: InlineCandidate[] = [
      { page: 1, bytes: 1_800_000 },
      { page: 2, bytes: 1_800_000 },
      { page: 3, bytes: 1_800_000 },
      { page: 4, bytes: 100_000 },
    ];

    // Running encoded totals: after page 1 -> 2,400,000 (<= 5,242,880, fits).
    // After page 2 -> 4,800,000 (<= 5,242,880, fits).
    // Page 3 would push the total to 7,200,000 (> 5,242,880) -> excluded, budget now "exceeded".
    // Page 4 alone (encoded ~133,336) would easily fit in the 442,880 bytes of budget left over,
    // but must be excluded anyway: the cutoff is a sticky prefix, not "whatever still fits".
    const plan = planInlining(candidates, { inline: true, budgetBytes });

    expect(plan.inlined).toEqual([true, true, false, false]);
    expect(plan.note).toBeDefined();
    expect(plan.note).toMatch(/after page 2/);
    expect(plan.note).toMatch(/3, 4/);
  });

  it('a page landing exactly on the budget is inlined', () => {
    // 75 raw bytes -> base64 encodes to exactly 100 bytes (75/3*4 = 100).
    const plan = planInlining([{ page: 1, bytes: 75 }], { inline: true, budgetBytes: 100 });

    expect(plan.inlined).toEqual([true]);
    expect(plan.note).toBeUndefined();
  });

  it('a page landing one increment past the budget is not inlined', () => {
    // 78 raw bytes -> base64 encodes to 104 bytes (ceil(78/3)*4 = 104), just over a 100-byte budget.
    const plan = planInlining([{ page: 1, bytes: 78 }], { inline: true, budgetBytes: 100 });

    expect(plan.inlined).toEqual([false]);
    expect(plan.note).toBeDefined();
  });

  it('excludes a page whose raw bytes fit the budget but whose base64-encoded size does not', () => {
    // This is the accounting fix: base64 inflates by ~4/3, so a page can be under budget in raw
    // bytes yet blow it once encoded. Under the old (buggy) raw-byte comparison this page would
    // have been inlined (4,500,000 <= 5,242,880); the fix must exclude it.
    const budgetBytes = DEFAULT_INLINE_BUDGET_BYTES; // 5 MiB
    const bytes = 4_500_000;
    const encoded = Math.ceil(bytes / 3) * 4;

    // Sanity-check the premise of this test: fits raw, does not fit encoded.
    expect(bytes).toBeLessThanOrEqual(budgetBytes);
    expect(encoded).toBeGreaterThan(budgetBytes);

    const plan = planInlining([{ page: 1, bytes }], { inline: true, budgetBytes });

    expect(plan.inlined).toEqual([false]);
    expect(plan.note).toBeDefined();
  });

  it('handles an empty candidate list without throwing', () => {
    const plan = planInlining([], { inline: true });

    expect(plan.inlined).toEqual([]);
    expect(plan.note).toBeUndefined();
  });

  it('handles an empty candidate list with inline: false without throwing', () => {
    const plan = planInlining([], { inline: false });

    expect(plan.inlined).toEqual([]);
    expect(plan.note).toBeUndefined();
  });

  it('names the remedy when one page alone is too big to inline', () => {
    // The motivating case: a poster page asked for at high dpi can exceed the whole budget by
    // itself. Nothing is inlined, so the note has to say what to do instead of reporting that the
    // budget "was reached after page undefined".
    const plan = planInlining([{ page: 1, bytes: 9_000_000 }], { inline: true, budgetBytes: 1000 });

    expect(plan.inlined).toEqual([false]);
    expect(plan.note).toMatch(/page 1 alone exceeds/);
    expect(plan.note).toMatch(/pngPath/);
    expect(plan.note).toMatch(/dpi|clip/);
    expect(plan.note).not.toMatch(/undefined|\?/);
  });
});

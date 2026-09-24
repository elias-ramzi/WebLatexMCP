import { describe, it, expect } from 'vitest';
import {
  DIFF_CONTENT_BUDGET,
  DIFF_JSON_QUOTES_OVERHEAD,
  DIFF_MAX_FILES,
  DIFF_NOTE_RESERVE,
  PUSH_REVIEW_SCAFFOLD_OVERHEAD,
  planPushReviewDiff,
  renderCost,
  renderPushReviewText,
  structuredOnlyCost,
} from '../../src/lib/diffBudget.js';
import type { DiffFile } from '../../src/services/gitService.js';

/**
 * Unit tests for `push`'s branch-mode review-diff budget (issue #160).
 *
 * The claim under test is not "something was cut" but **the rendered result fits** — and here, on
 * a branch `push`, "rendered" means one channel for the patch (`structuredContent.diff`) and two
 * for the summary and the note. `test/integration/pushReviewDiffBudget.test.ts` measures the same
 * thing off a real MCP round trip against a real git clone; this file pins the planner, including
 * the single-channel charge that a two-channel one would silently halve.
 */

/** One `@@` hunk of `lines` lines, each `width` characters wide. */
function hunk(start: number, lines: number, width: number): string {
  const body = Array.from(
    { length: lines },
    (_, i) => `+${'x'.repeat(Math.max(1, width - 1))}${i % 10}\n`,
  ).join('');
  return `@@ -${start},0 +${start},${lines} @@\n${body}`;
}

function filePatch(path: string, hunks: string[]): string {
  return (
    `diff --git a/${path} b/${path}\n` +
    `index 1111111..2222222 100644\n` +
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    hunks.join('')
  );
}

function numstat(paths: string[]): DiffFile[] {
  return paths.map((path) => ({ path, added: 300, removed: 0 }));
}

const SUMMARY =
  'Committed 1a2b3c4d to local branch "review/x" (3 file(s)). Review the diff vs master, then ' +
  'approve to land it.';

const OPTS = { summary: SUMMARY, base: 'master', branch: 'review/x' };

/**
 * Everything the caller receives, modelled exactly on what `src/tools/push.ts` sends for an
 * `awaiting-approval` result: the text channel is the summary plus (only) the note, and the patch
 * travels in `structuredContent` alone.
 */
function receivedChars(
  plan: ReturnType<typeof planPushReviewDiff>,
  extra: Record<string, unknown> = {},
): number {
  const structured = {
    status: 'awaiting-approval',
    pushed: false,
    remote: 'https://git.overleaf.com/deadbeefdeadbeefdeadbeef',
    branch: 'review/x',
    base: 'master',
    summary: SUMMARY,
    committedSha: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
    diff: plan.diff,
    diffFiles: plan.diffFiles,
    diffChars: plan.diffChars,
    diffTruncated: plan.diffTruncated,
    diffHunksOmitted: plan.diffHunksOmitted,
    diffPatchFilesOmitted: plan.diffPatchFilesOmitted,
    diffFilesOmitted: plan.diffFilesOmitted,
    ...(plan.diffNote ? { diffNote: plan.diffNote } : {}),
    ...extra,
  };
  return renderPushReviewText(SUMMARY, plan).length + JSON.stringify(structured).length;
}

describe('planPushReviewDiff fits the review payload inside the budget', () => {
  it('keeps a huge branch diff under the budget, both channels counted', () => {
    // 60 files of 300 lines each: ~1.3MB of patch, the shape a `prepareBranch` over a session's
    // whole work produces. Unbudgeted this was the entire patch, verbatim.
    const paths = Array.from({ length: 60 }, (_, i) => `sections/file${i}.tex`);
    const patch = paths.map((p) => filePatch(p, [hunk(1, 300, 70)])).join('');
    const plan = planPushReviewDiff(patch, numstat(paths), OPTS);

    expect(plan.diffChars).toBeGreaterThan(DIFF_CONTENT_BUDGET * 50);
    expect(receivedChars(plan)).toBeLessThanOrEqual(DIFF_CONTENT_BUDGET);
    expect(plan.diffTruncated).toBe(true);
    expect(plan.diffNote).toBeDefined();
  });

  it('charges the patch ONCE, so a single-channel payload is not silently halved', () => {
    // The point of `structuredOnlyCost`. A patch that fits comfortably must come back whole, and
    // the plan must have spent budget at the one-channel rate: if this planner were charging
    // `renderCost`, a patch sized between the two rates would come back cut.
    const patch = filePatch(
      'main.tex',
      Array.from({ length: 17 }, (_, i) => hunk(i * 20 + 1, 12, 60)),
    );
    // Sized so it fits when charged once and does NOT fit when charged twice.
    expect(structuredOnlyCost(patch)).toBeLessThan(DIFF_CONTENT_BUDGET - DIFF_NOTE_RESERVE - 1000);
    expect(renderCost(patch)).toBeGreaterThan(DIFF_CONTENT_BUDGET);

    const plan = planPushReviewDiff(patch, numstat(['main.tex']), OPTS);
    expect(plan.diffTruncated).toBe(false);
    expect(plan.diffHunksOmitted).toBe(0);
    expect(plan.diff).toBe(patch);
    expect(plan.diffNote).toBeUndefined();
    expect(receivedChars(plan)).toBeLessThanOrEqual(DIFF_CONTENT_BUDGET);
  });

  it('cuts at hunk boundaries and keeps every included file named', () => {
    const patch = filePatch(
      'main.tex',
      Array.from({ length: 200 }, (_, i) => hunk(i * 20 + 1, 20, 80)),
    );
    const plan = planPushReviewDiff(patch, numstat(['main.tex']), OPTS);

    expect(plan.diff).toContain('diff --git a/main.tex b/main.tex');
    expect(plan.diff).toContain('+++ b/main.tex');
    expect(plan.diffHunksOmitted).toBeGreaterThan(0);
    // The marker is the last line: nothing of the cut hunks trails behind it, and no hunk is half
    // there (every kept `@@` block's line count matches its header).
    const lines = plan.diff.trimEnd().split('\n');
    expect(lines[lines.length - 1]).toMatch(
      /^\.\.\. \d+ of \d+ hunk\(s\) of main\.tex omitted \(\d+ chars\)$/,
    );
    const kept = plan.diff.match(/^@@ /gm) ?? [];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBe(200 - plan.diffHunksOmitted);
  });

  it('caps diffFiles at DIFF_MAX_FILES and counts what the cap dropped', () => {
    const paths = Array.from({ length: DIFF_MAX_FILES + 17 }, (_, i) => `f${i}.tex`);
    const plan = planPushReviewDiff(
      paths.map((p) => filePatch(p, [hunk(1, 1, 20)])).join(''),
      numstat(paths),
      OPTS,
    );
    expect(plan.diffFiles).toHaveLength(DIFF_MAX_FILES);
    expect(plan.diffFilesOmitted).toBe(17);
    expect(plan.diffTruncated).toBe(true);
    expect(plan.diffNote).toContain(`only the first ${DIFF_MAX_FILES} of ${paths.length}`);
    expect(plan.diffNote).toContain('diffFiles[]');
  });

  it('never cuts silently, and never confuses "cut" with "nothing changed"', () => {
    const empty = planPushReviewDiff('', [], OPTS);
    expect(empty.diff).toBe('');
    expect(empty.diffChars).toBe(0);
    expect(empty.diffTruncated).toBe(false);
    expect(empty.diffNote).toBeUndefined();
    expect(renderPushReviewText(SUMMARY, empty)).toBe(SUMMARY);

    const cut = planPushReviewDiff(
      filePatch(
        'main.tex',
        Array.from({ length: 200 }, (_, i) => hunk(i * 20 + 1, 20, 80)),
      ),
      numstat(['main.tex']),
      OPTS,
    );
    // A cut patch is never empty — the headers stay — so the two states cannot be confused.
    expect(cut.diff).not.toBe('');
    expect(cut.diffChars).toBeGreaterThan(cut.diff.length);
    // And the note reaches the text channel, so a client that drops structuredContent is still
    // told the patch it cannot see was cut.
    expect(renderPushReviewText(SUMMARY, cut)).toContain(cut.diffNote!);
  });

  it('routes the caller to the rest by the branch range, not by a flag push does not have', () => {
    const paths = Array.from({ length: 60 }, (_, i) => `${'nested/'.repeat(8)}file${i}.tex`);
    const plan = planPushReviewDiff(
      paths.map((p) => filePatch(p, [hunk(1, 300, 70)])).join(''),
      numstat(paths),
      { summary: SUMMARY, base: 'master', branch: 'review/x' },
    );
    expect(plan.diffNote).toContain('diff, ref: "master...review/x"');
    expect(plan.diffNote).toContain('detail: "full"');
  });

  it('names only the bound that actually fired', () => {
    const oneFile = planPushReviewDiff(
      filePatch(
        'a.tex',
        Array.from({ length: 200 }, (_, i) => hunk(i * 20 + 1, 20, 80)),
      ),
      numstat(['a.tex']),
      OPTS,
    );
    expect(oneFile.diffNote).toContain('hunk(s) across 1 file(s) were cut');
    expect(oneFile.diffNote).not.toContain('listed in diffFiles[]');
    expect(oneFile.diffNote).not.toContain('no section in the patch');

    const manyFiles = planPushReviewDiff(
      Array.from({ length: 40 }, (_, i) => filePatch(`f${i}.tex`, [hunk(1, 1, 20)])).join(''),
      numstat(Array.from({ length: 40 }, (_, i) => `f${i}.tex`)),
      OPTS,
    );
    expect(manyFiles.diffNote).toContain('listed in diffFiles[]');
    expect(manyFiles.diffNote).not.toContain('hunk(s) across');
  });

  it('reserves enough for the longest note it can build, in BOTH channels', () => {
    // The note is the one part that cannot be charged per-decision without circularity, so a flat
    // reserve stands in for it. Unlike `diff`'s note, this one ships twice (structuredContent AND
    // the result text), so the reserve has to cover two copies — `renderCost` is exactly that.
    const paths = Array.from({ length: 60 }, (_, i) => `${'nested/'.repeat(8)}file${i}.tex`);
    const plan = planPushReviewDiff(
      paths.map((p) => filePatch(p, [hunk(1, 300, 70)])).join(''),
      numstat(paths),
      { summary: SUMMARY, base: `${'long-'.repeat(12)}base`, branch: `${'long-'.repeat(12)}br` },
    );
    expect(plan.diffNote).toBeDefined();
    expect(renderCost(plan.diffNote!)).toBeLessThanOrEqual(DIFF_NOTE_RESERVE);
  });

  it('the scaffold reserve accounts for the JSON push wraps around the payload', () => {
    // Pinned from BOTH sides: an under-charge makes the budget a lie, and an over-charge padded
    // to meaninglessness would make this assertion decorative.
    const plan = planPushReviewDiff(
      filePatch('main.tex', [hunk(1, 4, 40)]),
      numstat(['main.tex']),
      {
        ...OPTS,
        branch: `${'long-'.repeat(12)}branch`,
        base: `${'long-'.repeat(12)}base`,
      },
    );
    const structured = {
      status: 'awaiting-approval',
      pushed: false,
      remote: 'https://git.overleaf.com/deadbeefdeadbeefdeadbeef',
      branch: `${'long-'.repeat(12)}branch`,
      base: `${'long-'.repeat(12)}base`,
      summary: SUMMARY,
      committedSha: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
      diff: plan.diff,
      diffFiles: plan.diffFiles,
      diffChars: plan.diffChars,
      diffTruncated: plan.diffTruncated,
      diffHunksOmitted: plan.diffHunksOmitted,
      diffPatchFilesOmitted: plan.diffPatchFilesOmitted,
      diffFilesOmitted: plan.diffFilesOmitted,
    };
    // Everything the planner charges exactly, removed — what is left is the scaffold.
    const scaffold =
      JSON.stringify(structured).length -
      JSON.stringify(structured.diff).length -
      JSON.stringify(structured.diffFiles).length -
      JSON.stringify(structured.summary).length -
      structured.branch.length -
      structured.base.length +
      DIFF_JSON_QUOTES_OVERHEAD;
    expect(scaffold).toBeLessThanOrEqual(PUSH_REVIEW_SCAFFOLD_OVERHEAD);
    expect(scaffold).toBeGreaterThan(PUSH_REVIEW_SCAFFOLD_OVERHEAD / 3);
  });
});

import { describe, it, expect } from 'vitest';
import {
  CHANGE_DIFF_BUDGET,
  DIFF_CONTENT_BUDGET,
  DIFF_JSON_QUOTES_OVERHEAD,
  DIFF_MAX_FILES,
  DIFF_NOTE_RESERVE,
  DIFF_STRUCTURED_SCAFFOLD_OVERHEAD,
  planChangeDiff,
  planDiffPayload,
  renderCost,
  renderDiffText,
  splitPatch,
} from '../../src/lib/diffBudget.js';
import type { DiffPlan } from '../../src/lib/diffBudget.js';
import type { DiffFile } from '../../src/services/gitService.js';

/**
 * Unit tests for the `diff` / confirmation-diff budget (issue #153).
 *
 * The load-bearing claim is not "something was cut" but **the rendered result fits**, so most of
 * what follows measures the payload the tool will actually send — the text channel plus the
 * JSON-encoded structured channel — rather than the raw patch. `test/integration/diffBudget.test.ts`
 * measures the same thing off a real MCP round trip against a real git clone, which is what keeps
 * the shape assembled below honest.
 */

/** One `@@` hunk of `lines` lines, each `width` characters of `fill`. */
function hunk(start: number, lines: number, width: number, fill = 'x'): string {
  const body = Array.from(
    { length: lines },
    (_, i) => `+${fill.repeat(Math.max(1, width - 1))}${i % 10}\n`,
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
  return paths.map((p) => ({ path: p, added: 10, removed: 2 }));
}

/**
 * The hunks of one file of a BUDGETED patch, with the omission marker peeled back off.
 *
 * `splitPatch` has no reason to know about markers, so a `... N of M hunk(s) omitted` line lands
 * inside whatever it follows — which is exactly where a reader wants to see it, right under the
 * last hunk that survived. Peeling it off here lets the assertions below compare what was kept
 * against the original hunks byte for byte.
 */
function keptHunks(patch: string, index = 0): string[] {
  const hunks = splitPatch(patch)[index]?.hunks ?? [];
  return hunks.map((h) => h.replace(/\n\.\.\. \d+ of \d+ hunk\(s\)[^\n]*\n$/, '\n'));
}

/**
 * The payload `src/tools/diff.ts` assembles from a plan, measured across BOTH channels exactly as
 * a client receives it. Kept in the same order and shape as the tool's own object literal; the
 * integration test measures the real one, so a drift between the two is caught there.
 */
function renderedSize(plan: DiffPlan): number {
  const structured = {
    diff: plan.diff,
    files: plan.files,
    ...(plan.ref ? { ref: plan.ref } : {}),
    truncated: plan.truncated,
    diffChars: plan.diffChars,
    hunksOmitted: plan.hunksOmitted,
    patchFilesOmitted: plan.patchFilesOmitted,
    filesOmitted: plan.filesOmitted,
    ...(plan.note ? { note: plan.note } : {}),
  };
  return renderDiffText(plan).length + JSON.stringify(structured).length;
}

describe('splitPatch', () => {
  it('splits a multi-file patch into headers and whole hunks', () => {
    const patch =
      filePatch('a.tex', [hunk(1, 2, 20), hunk(40, 3, 20)]) +
      filePatch('sub/b.tex', [hunk(1, 1, 20)]);
    const sections = splitPatch(patch);
    expect(sections.map((s) => s.path)).toEqual(['a.tex', 'sub/b.tex']);
    expect(sections[0]!.hunks).toHaveLength(2);
    expect(sections[1]!.hunks).toHaveLength(1);
    // Exactness matters: the planner reassembles the patch from these pieces, so any byte lost
    // here is a byte silently dropped from a patch nobody said was cut.
    expect(sections.map((s) => s.header + s.hunks.join('')).join('')).toBe(patch);
  });

  it('keeps a binary or mode-only section, which has no hunks at all', () => {
    const patch =
      'diff --git a/fig.png b/fig.png\nindex 111..222 100644\nBinary files a/fig.png and b/fig.png differ\n';
    const sections = splitPatch(patch);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.hunks).toEqual([]);
    expect(sections[0]!.header).toBe(patch);
  });

  it("reads a deletion's path from the --- side, since +++ is /dev/null", () => {
    const patch =
      'diff --git a/gone.tex b/gone.tex\ndeleted file mode 100644\n--- a/gone.tex\n+++ /dev/null\n' +
      '@@ -1,1 +0,0 @@\n-bye\n';
    expect(splitPatch(patch)[0]!.path).toBe('gone.tex');
  });

  it('treats text before the first `diff --git` as one elidable chunk, not a mandatory header', () => {
    const sections = splitPatch('warning: something\n' + filePatch('a.tex', [hunk(1, 1, 10)]));
    expect(sections[0]).toMatchObject({ path: '', header: '', hunks: ['warning: something\n'] });
  });

  it('is empty for an empty patch', () => {
    expect(splitPatch('')).toEqual([]);
  });
});

describe('renderCost charges both channels', () => {
  it('counts a string once as text and once JSON-encoded', () => {
    // 'abcd' renders verbatim (4) and again inside structuredContent.diff (4 + no escapes).
    expect(renderCost('abcd')).toBe(8);
  });

  it('counts the real escaping cost, which a raw-length charge misses', () => {
    // A backslash is one character of text and two of JSON — LaTeX is full of them.
    expect(renderCost('\\')).toBe(3);
    expect(renderCost('\n')).toBe(3);
    expect(JSON.stringify('\\').length - DIFF_JSON_QUOTES_OVERHEAD).toBe(2);
  });
});

describe('planDiffPayload', () => {
  it('returns a small patch untouched and reports nothing cut', () => {
    const patch = filePatch('a.tex', [hunk(1, 3, 40)]);
    const plan = planDiffPayload(patch, numstat(['a.tex']));
    expect(plan.diff).toBe(patch);
    expect(plan).toMatchObject({
      truncated: false,
      hunksOmitted: 0,
      patchFilesOmitted: 0,
      filesOmitted: 0,
      diffChars: patch.length,
    });
    expect(plan.note).toBeUndefined();
  });

  it('cuts a patch that is under the budget by raw length but over it once shipped twice', () => {
    // ~12k of patch: comfortably under a 20000-char budget counted ONCE, and comfortably over it
    // counted in both channels. This is the 2x the issue names; a single-channel charge passes
    // every "is it cut at all" test and still returns ~24k to the client.
    const hunks = Array.from({ length: 20 }, (_, i) => hunk(i * 10 + 1, 10, 60));
    const patch = filePatch('main.tex', hunks);
    expect(patch.length).toBeGreaterThan(11000);
    expect(patch.length).toBeLessThan(DIFF_CONTENT_BUDGET);

    const plan = planDiffPayload(patch, numstat(['main.tex']));
    expect(plan.truncated).toBe(true);
    expect(plan.hunksOmitted).toBeGreaterThan(0);
    expect(renderedSize(plan)).toBeLessThanOrEqual(DIFF_CONTENT_BUDGET);
  });

  it('cuts escape-heavy content sooner than plain content of the same raw size', () => {
    const shape = (fill: string): number => {
      const hunks = Array.from({ length: 30 }, (_, i) => hunk(i * 10 + 1, 8, 60, fill));
      const plan = planDiffPayload(filePatch('main.tex', hunks), numstat(['main.tex']));
      return keptHunks(plan.diff).length;
    };
    // Same raw length either way; a backslash costs two characters in the JSON channel, so fewer
    // of those hunks fit. A raw-length budget would keep exactly as many of each.
    expect(shape('\\')).toBeLessThan(shape('x'));
  });

  it('keeps whole hunks only — every kept hunk is byte-identical to an original', () => {
    const hunks = Array.from({ length: 40 }, (_, i) => hunk(i * 10 + 1, 8, 70));
    const plan = planDiffPayload(filePatch('main.tex', hunks), numstat(['main.tex']));
    const kept = keptHunks(plan.diff);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(hunks.length);
    // A prefix, in order, each one whole: a part-hunk is text that looks like a diff and is not
    // one, and reordering would answer a different question than the one asked.
    expect(kept).toEqual(hunks.slice(0, kept.length));
  });

  it('keeps the diff --git/---/+++ headers of a file whose hunks were all cut', () => {
    const patch =
      filePatch('big.tex', [hunk(1, 400, 60)]) + filePatch('small.tex', [hunk(1, 1, 20)]);
    const plan = planDiffPayload(patch, numstat(['big.tex', 'small.tex']));
    expect(plan.diff).toContain('diff --git a/big.tex b/big.tex');
    expect(plan.diff).toContain('--- a/big.tex');
    expect(plan.diff).toContain('+++ b/big.tex');
    expect(plan.diff).toMatch(/\.\.\. 1 of 1 hunk\(s\) of big\.tex omitted \(\d+ chars\)/);
    expect(plan.hunksOmitted).toBe(1);
    expect(renderedSize(plan)).toBeLessThanOrEqual(DIFF_CONTENT_BUDGET);
  });

  it('a file too big to inline does not blank the hunks of the files after it', () => {
    // The cut stops at the file boundary. A regenerated .bbl (or a re-exported .svg) is exactly
    // the kind of first file that blows the budget, and carrying its cut onwards would throw away
    // the hand-written section the reviewer actually opened `diff` for.
    const patch =
      filePatch('refs.bbl', [hunk(1, 3000, 80)]) +
      filePatch('sections/intro.tex', [hunk(10, 4, 50), hunk(90, 3, 50)]);
    const plan = planDiffPayload(patch, numstat(['refs.bbl', 'sections/intro.tex']));
    expect(keptHunks(plan.diff, 0)).toEqual([]);
    expect(keptHunks(plan.diff, 1)).toHaveLength(2);
    expect(plan.hunksOmitted).toBe(1);
    expect(renderedSize(plan)).toBeLessThanOrEqual(DIFF_CONTENT_BUDGET);
  });

  it('never keeps one oversized hunk to "have something" — unlike searchBudget', () => {
    // One regenerated .bbl is a single hunk far past the whole budget. Keeping it is the defect.
    const patch = filePatch('refs.bbl', [hunk(1, 4000, 80)]);
    const plan = planDiffPayload(patch, numstat(['refs.bbl']));
    expect(keptHunks(plan.diff)).toEqual([]);
    expect(plan.diffChars).toBe(patch.length);
    expect(renderedSize(plan)).toBeLessThanOrEqual(DIFF_CONTENT_BUDGET);
  });

  it(`caps files[] at ${DIFF_MAX_FILES} and counts the rest`, () => {
    const paths = Array.from({ length: 57 }, (_, i) => `sec/file${i}.tex`);
    const patch = paths.map((p) => filePatch(p, [hunk(1, 2, 40)])).join('');
    const plan = planDiffPayload(patch, numstat(paths));
    expect(plan.files).toHaveLength(DIFF_MAX_FILES);
    expect(plan.filesOmitted).toBe(57 - DIFF_MAX_FILES);
    expect(plan.patchFilesOmitted).toBe(57 - DIFF_MAX_FILES);
    expect(plan.truncated).toBe(true);
    expect(renderDiffText(plan)).toContain(
      '37 more changed file(s) not listed (57 changed in all)',
    );
    expect(plan.diff).toContain('... 37 more changed file(s) omitted from this patch');
  });

  it('bounds the rendered result for every adversarial shape, note included', () => {
    const cases: Array<[string, string, DiffFile[]]> = [
      ['one enormous hunk', filePatch('a.tex', [hunk(1, 8000, 90)]), numstat(['a.tex'])],
      [
        'thousands of tiny hunks',
        filePatch(
          'a.tex',
          Array.from({ length: 3000 }, (_, i) => hunk(i + 1, 1, 8)),
        ),
        numstat(['a.tex']),
      ],
      [
        'hundreds of files',
        Array.from({ length: 400 }, (_, i) => filePatch(`f${i}.tex`, [hunk(1, 3, 50)])).join(''),
        numstat(Array.from({ length: 400 }, (_, i) => `f${i}.tex`)),
      ],
      [
        'very long paths',
        Array.from({ length: 30 }, (_, i) =>
          filePatch(`${'deeply/nested/'.repeat(14)}file${i}.tex`, [hunk(1, 3, 50)]),
        ).join(''),
        numstat(Array.from({ length: 30 }, (_, i) => `${'deeply/nested/'.repeat(14)}file${i}.tex`)),
      ],
      [
        'backslash-dense LaTeX',
        filePatch(
          'm.tex',
          Array.from({ length: 200 }, (_, i) => hunk(i + 1, 6, 70, '\\')),
        ),
        numstat(['m.tex']),
      ],
      [
        'control characters',
        filePatch(
          'm.tex',
          Array.from({ length: 200 }, (_, i) => hunk(i + 1, 6, 70, '\u0001')),
        ),
        numstat(['m.tex']),
      ],
      ['binary only', 'diff --git a/f.png b/f.png\nBinary files differ\n', numstat(['f.png'])],
    ];
    for (const [name, patch, files] of cases) {
      for (const ref of [undefined, 'origin/master']) {
        const plan = planDiffPayload(patch, files, ref ? { ref } : {});
        expect(renderedSize(plan), `${name}${ref ? ` (ref)` : ''}`).toBeLessThanOrEqual(
          DIFF_CONTENT_BUDGET,
        );
      }
    }
  });

  it('pins the note inside its reserve, in both channels', () => {
    // The note is the one part that cannot be charged per-decision without circularity, so a flat
    // reserve stands in for it. If a future note outgrows the reserve, the bound above becomes a
    // lie quietly — this is what catches that.
    const paths = Array.from({ length: 60 }, (_, i) => `${'nested/'.repeat(8)}file${i}.tex`);
    const patch = paths.map((p) => filePatch(p, [hunk(1, 300, 70)])).join('');
    const plan = planDiffPayload(patch, numstat(paths));
    expect(plan.note).toBeDefined();
    // Every reason fires here, which is the longest note this module can build.
    expect(renderCost(plan.note!)).toBeLessThanOrEqual(DIFF_NOTE_RESERVE);
  });

  it('names only the bound that actually fired', () => {
    const oneFile = planDiffPayload(
      filePatch(
        'a.tex',
        Array.from({ length: 60 }, (_, i) => hunk(i * 10 + 1, 10, 60)),
      ),
      numstat(['a.tex']),
    );
    expect(oneFile.note).toContain('hunk(s) across 1 file(s) were cut');
    expect(oneFile.note).not.toContain('are listed in files[]');
    expect(oneFile.note).not.toContain('no section in the patch');

    const manyFiles = planDiffPayload(
      Array.from({ length: 40 }, (_, i) => filePatch(`f${i}.tex`, [hunk(1, 1, 20)])).join(''),
      numstat(Array.from({ length: 40 }, (_, i) => `f${i}.tex`)),
    );
    expect(manyFiles.note).toContain('are listed in files[]');
    expect(manyFiles.note).not.toContain('hunk(s) across');
  });

  it('points at every route back to what was cut', () => {
    const plan = planDiffPayload(filePatch('a.tex', [hunk(1, 4000, 80)]), numstat(['a.tex']));
    expect(plan.note).toContain('path');
    expect(plan.note).toContain('read_file');
    expect(plan.note).toContain('detail: "full"');
  });

  it('detail: "full" is the escape hatch — nothing cut, nothing capped', () => {
    const paths = Array.from({ length: 40 }, (_, i) => `f${i}.tex`);
    const patch = paths.map((p) => filePatch(p, [hunk(1, 300, 80)])).join('');
    const plan = planDiffPayload(patch, numstat(paths), { detail: 'full' });
    expect(plan.diff).toBe(patch);
    expect(plan.files).toHaveLength(40);
    expect(plan).toMatchObject({ truncated: false, hunksOmitted: 0, filesOmitted: 0 });
    expect(plan.note).toBeUndefined();
  });

  it('distinguishes "no diff" from "cut": an empty patch is never truncated', () => {
    const plan = planDiffPayload('', [], { ref: 'HEAD~2' });
    expect(plan.diff).toBe('');
    expect(plan.truncated).toBe(false);
    expect(renderDiffText(plan)).toBe('No changes vs HEAD~2.');
  });

  it('pins DIFF_STRUCTURED_SCAFFOLD_OVERHEAD against the real structuredContent scaffold', () => {
    // Everything `src/tools/diff.ts` puts in structuredContent except the two payload bodies,
    // with counters wide enough for any plausible patch. If a key is added there and not here,
    // the accounting above silently under-charges — so this fails when the gap closes, and the
    // assertion below keeps the constant from being padded into meaninglessness instead.
    const scaffold = JSON.stringify({
      diff: '',
      files: [],
      truncated: true,
      diffChars: 999999999,
      hunksOmitted: 999999,
      patchFilesOmitted: 999999,
      filesOmitted: 999999,
      note: '',
    }).length;
    expect(scaffold).toBeLessThanOrEqual(DIFF_STRUCTURED_SCAFFOLD_OVERHEAD);
    expect(scaffold).toBeGreaterThan(DIFF_STRUCTURED_SCAFFOLD_OVERHEAD - 60);
  });
});

describe('planChangeDiff', () => {
  it('is budgeted far harder than diff, because nobody asked for it', () => {
    expect(CHANGE_DIFF_BUDGET).toBeLessThan(DIFF_CONTENT_BUDGET / 4);
  });

  it('cuts a whole-file overwrite down to its headers and a marker', () => {
    const patch = filePatch('main.tex', [hunk(1, 600, 70)]);
    const plan = planChangeDiff(patch);
    expect(plan.truncated).toBe(true);
    expect(plan.diff).toContain('diff --git a/main.tex b/main.tex');
    expect(plan.diff).toContain('... 1 of 1 hunk(s) of main.tex omitted');
    // The route out rides on the marker here: there is no aggregate note in a 2000-char budget.
    expect(plan.diff).toContain('call diff for the full patch');
    expect(renderCost(plan.diff)).toBeLessThanOrEqual(CHANGE_DIFF_BUDGET);
  });

  it('keeps a small confirmation diff exactly as it was', () => {
    const patch = filePatch('main.tex', [hunk(1, 2, 30)]);
    expect(planChangeDiff(patch)).toEqual({ diff: patch, truncated: false });
  });

  it('returns an empty, untruncated diff for an empty patch — "absent" is not "cut"', () => {
    expect(planChangeDiff('')).toEqual({ diff: '', truncated: false });
  });

  it('bounds the confirmation diff for every adversarial shape', () => {
    const cases = [
      filePatch('a.tex', [hunk(1, 9000, 90)]),
      filePatch(
        'a.tex',
        Array.from({ length: 2000 }, (_, i) => hunk(i + 1, 1, 6)),
      ),
      Array.from({ length: 50 }, (_, i) => filePatch(`f${i}.tex`, [hunk(1, 4, 60)])).join(''),
      filePatch(
        'm.tex',
        Array.from({ length: 100 }, (_, i) => hunk(i + 1, 6, 70, '\\')),
      ),
    ];
    for (const patch of cases) {
      expect(renderCost(planChangeDiff(patch).diff)).toBeLessThanOrEqual(CHANGE_DIFF_BUDGET);
    }
  });
});

import { describe, it, expect } from 'vitest';
import {
  planConflictPayload,
  CONFLICT_SIDE_CAP,
  CONFLICT_CONTENT_BUDGET,
  CONFLICT_MAX_FILES,
  CONFLICT_MAX_COMMITS,
  FILE_HEADER_OVERHEAD,
  HUNK_MARKER_OVERHEAD,
  HUNK_JSON_OVERHEAD,
  HUNK_LINE_ELEMENT_OVERHEAD,
  type ConflictRefs,
} from '../../src/lib/conflictBudget.js';
import { capRemoteCommits } from '../../src/lib/conflictText.js';
import { STATUS_COMPLETENESS_PROMISES } from '../../src/lib/statusBudget.js';
import type { ConflictFileDetail, RemoteCommit } from '../../src/services/gitService.js';
import type { ConflictHunk } from '../../src/lib/conflictParser.js';

/** Fixed, realistic refs for tests that don't care about ref content itself — mirrors the shape
 * `push.ts` passes from a real `ConflictReport`. */
const REFS: ConflictRefs = {
  mergeBase: 'ba5eba5e1122334455667788990011223344aabb',
  rebasedOnto: 'origin/master',
};

function hunk(localChars: number, remoteChars: number, at = 1): ConflictHunk {
  return {
    startLine: at,
    endLine: at + 1,
    local: ['x'.repeat(localChars)],
    remote: ['y'.repeat(remoteChars)],
  };
}

function file(overrides: Partial<ConflictFileDetail> = {}): ConflictFileDetail {
  return {
    path: 'main.tex',
    base: 'base',
    ours: 'ours',
    theirs: 'theirs',
    hunks: [],
    ...overrides,
  };
}

describe('planConflictPayload', () => {
  it('allocates hunks before sides: hunks + sides over budget keeps hunks, loses sides', () => {
    // Hunks alone: 15000 chars. Sides: 4000 chars each (12000 total). Combined (27000) exceeds the
    // 20000 budget, but hunks fit on their own (15000 <= 20000) and are allocated first, leaving
    // only 5000 for sides — not enough for even one 4000-char side plus the next.
    const f = file({
      hunks: [hunk(7500, 7500)],
      base: 'b'.repeat(4000),
      ours: 'o'.repeat(4000),
      theirs: 't'.repeat(4000),
    });
    const plan = planConflictPayload([f], { detail: 'auto', refs: REFS });
    const fp = plan.files[0]!;

    expect(fp.hunks.included).toBe(true);
    expect(fp.hunks.chars).toBe(15000);
    // 5000 left: base (4000) fits, ours (4000) does not (5000-4000=1000 remaining, then theirs
    // doesn't fit either).
    expect(fp.base.included).toBe(true);
    expect(fp.ours.included).toBe(false);
    expect(fp.theirs.included).toBe(false);
    expect(fp.ours.chars).toBe(4000); // true count, not truncated to 0
    expect(fp.theirs.chars).toBe(4000);
    expect(plan.truncated).toBe(true);
    expect(plan.note).toBeDefined();
  });

  it('elides a single side over CONFLICT_SIDE_CAP even when the total budget would allow it', () => {
    const f = file({
      base: 'z'.repeat(CONFLICT_SIDE_CAP + 1),
      ours: null,
      theirs: null,
      hunks: [],
    });
    const plan = planConflictPayload([f], { detail: 'auto', refs: REFS });
    const fp = plan.files[0]!;
    // Plenty of total budget (20000) remains, but the side alone exceeds the per-side cap.
    expect(fp.base.included).toBe(false);
    expect(fp.base.chars).toBe(CONFLICT_SIDE_CAP + 1);
  });

  it('keeps 10 conflicted files within CONFLICT_CONTENT_BUDGET in aggregate', () => {
    const files = Array.from({ length: 10 }, (_, i) =>
      file({
        path: `f${i}.tex`,
        base: 'b'.repeat(3000),
        ours: 'o'.repeat(3000),
        theirs: 't'.repeat(3000),
        hunks: [],
      }),
    );
    const plan = planConflictPayload(files, { detail: 'auto', refs: REFS });

    const includedChars = plan.files.reduce(
      (n, fp) =>
        n +
        (fp.hunks.included ? fp.hunks.chars : 0) +
        (fp.base.included ? fp.base.chars : 0) +
        (fp.ours.included ? fp.ours.chars : 0) +
        (fp.theirs.included ? fp.theirs.chars : 0),
      0,
    );
    expect(includedChars).toBeLessThanOrEqual(CONFLICT_CONTENT_BUDGET);
    expect(plan.truncated).toBe(true);
  });

  it('detail: "full" includes everything and caps nothing, even past both budgets', () => {
    const f = file({
      base: 'b'.repeat(CONFLICT_SIDE_CAP + 5000),
      ours: 'o'.repeat(CONFLICT_SIDE_CAP + 5000),
      theirs: 't'.repeat(CONFLICT_SIDE_CAP + 5000),
      hunks: [hunk(CONFLICT_CONTENT_BUDGET, CONFLICT_CONTENT_BUDGET)],
    });
    const plan = planConflictPayload([f], { detail: 'full', refs: REFS });
    const fp = plan.files[0]!;
    expect(fp.base.included).toBe(true);
    expect(fp.ours.included).toBe(true);
    expect(fp.theirs.included).toBe(true);
    expect(fp.hunks.included).toBe(true);
    expect(plan.truncated).toBe(false);
    expect(plan.note).toBeUndefined();
  });

  it('boundary: hunks exactly at the RENDERED-size budget fit; one char over does not', () => {
    // Regression for the finding that the budget counted only hunk CONTENT, never the marker
    // boilerplate (text channel) or JSON punctuation (structured channel) around it — so a hunk
    // could be "at budget" by content alone while its real rendered size blew well past it. This
    // derives the true boundary from the same named overhead constants the planner charges,
    // rather than hand-picking a round content number the way the old (buggy) test did.
    const path = 'main.tex';
    const startLine = 1;
    const endLine = 2;
    const digits = String(startLine).length + String(endLine).length;
    // One-element local/remote arrays: 2 line elements total.
    const perHunkOverhead = Math.max(
      HUNK_MARKER_OVERHEAD,
      HUNK_JSON_OVERHEAD + 2 * HUNK_LINE_ELEMENT_OVERHEAD,
    );
    const budgetForHunks = CONFLICT_CONTENT_BUDGET - (FILE_HEADER_OVERHEAD + path.length);
    const contentAtBudget = budgetForHunks - digits - perHunkOverhead;

    const makeFile = (localLen: number): ConflictFileDetail =>
      file({
        path,
        hunks: [{ startLine, endLine, local: ['x'.repeat(localLen)], remote: [''] }],
        base: null,
        ours: null,
        theirs: null,
      });

    const planAt = planConflictPayload([makeFile(contentAtBudget)], { detail: 'auto', refs: REFS });
    expect(planAt.files[0]!.hunks.included).toBe(true);
    expect(planAt.truncated).toBe(false);

    const planOver = planConflictPayload([makeFile(contentAtBudget + 1)], {
      detail: 'auto',
      refs: REFS,
    });
    expect(planOver.files[0]!.hunks.included).toBe(false);
    expect(planOver.truncated).toBe(true);
  });

  it('boundary: a side exactly at CONFLICT_SIDE_CAP is included; one char over is elided', () => {
    const atCap = file({
      base: 'a'.repeat(CONFLICT_SIDE_CAP),
      ours: null,
      theirs: null,
      hunks: [],
    });
    expect(
      planConflictPayload([atCap], { detail: 'auto', refs: REFS }).files[0]!.base.included,
    ).toBe(true);

    const overCap = file({
      base: 'a'.repeat(CONFLICT_SIDE_CAP + 1),
      ours: null,
      theirs: null,
      hunks: [],
    });
    expect(
      planConflictPayload([overCap], { detail: 'auto', refs: REFS }).files[0]!.base.included,
    ).toBe(false);
  });

  it('an absent side (null) is never elided and costs nothing', () => {
    const f = file({
      base: null,
      ours: 'o'.repeat(CONFLICT_SIDE_CAP + 1),
      theirs: null,
      hunks: [],
    });
    const plan = planConflictPayload([f], { detail: 'auto', refs: REFS });
    expect(plan.files[0]!.base).toEqual({ included: true, chars: 0 });
    expect(plan.files[0]!.theirs).toEqual({ included: true, chars: 0 });
    // ours still elided on its own oversize, independent of base/theirs being free.
    expect(plan.files[0]!.ours.included).toBe(false);
  });

  describe('CONFLICT_MAX_FILES (per-file structural overhead has to be capped too)', () => {
    it('caps the number of files given a detailed block, in "auto" mode', () => {
      // Regression for the finding: 250 conflicted files x 1 tiny hunk rendered 50,501 chars of
      // pure per-file headers with truncated: false — no content at all, just structural
      // overhead with no ceiling. A file cap is the only thing that bounds this shape.
      const files = Array.from({ length: 250 }, (_, i) =>
        file({ path: `f${i}.tex`, hunks: [hunk(1, 1)], base: null, ours: null, theirs: null }),
      );
      const plan = planConflictPayload(files, { detail: 'auto', refs: REFS });

      expect(plan.files).toHaveLength(CONFLICT_MAX_FILES);
      expect(plan.omittedFiles).toHaveLength(250 - CONFLICT_MAX_FILES);
      expect(plan.omittedFiles).toContain('f249.tex');
      expect(plan.omittedFiles).not.toContain('f0.tex');
      expect(plan.truncated).toBe(true);
      expect(plan.note).toMatch(new RegExp(`first ${CONFLICT_MAX_FILES} of 250`));
    });

    it('does not cap files in "full" mode — that escape hatch stays uncapped', () => {
      const files = Array.from({ length: 250 }, (_, i) =>
        file({ path: `f${i}.tex`, hunks: [hunk(1, 1)], base: null, ours: null, theirs: null }),
      );
      const plan = planConflictPayload(files, { detail: 'full', refs: REFS });
      expect(plan.files).toHaveLength(250);
      expect(plan.omittedFiles).toBeUndefined();
      expect(plan.truncated).toBe(false);
    });

    it("caps an elided hunks block's own `spans` array, independent of its (uncapped) `count`", () => {
      const manyHunks = Array.from({ length: 200 }, (_, i) => hunk(1, 1, i * 3 + 1));
      const f = file({ hunks: manyHunks, base: null, ours: null, theirs: null });
      // Force the hunks block to be elided by starving the budget with a prior file whose single
      // hunk consumes almost all of it (leaving far less than 200 tiny hunks' all-or-nothing
      // block could ever fit in).
      const hog = file({
        path: 'hog.tex',
        hunks: [
          {
            startLine: 1,
            endLine: 2,
            local: ['x'.repeat(CONFLICT_CONTENT_BUDGET - 500)],
            remote: [''],
          },
        ],
        base: null,
        ours: null,
        theirs: null,
      });
      const plan = planConflictPayload([hog, f], { detail: 'auto', refs: REFS });
      expect(plan.files[0]!.hunks.included).toBe(true); // sanity: the hog really was allocated
      const fp = plan.files[1]!;
      expect(fp.hunks.included).toBe(false);
      expect(fp.hunks.count).toBe(200); // true, uncapped count
      expect(fp.hunks.spans.length).toBeLessThanOrEqual(20);
    });
  });

  describe('plan.note names only the reason(s) that actually fired (finding 5)', () => {
    it('names only the per-side cap when the aggregate budget was never touched', () => {
      // One file, one oversized side — plenty of aggregate budget left over.
      const f = file({
        base: 'z'.repeat(CONFLICT_SIDE_CAP + 1),
        ours: null,
        theirs: null,
        hunks: [],
      });
      const plan = planConflictPayload([f], { detail: 'auto', refs: REFS });
      expect(plan.note).toBeDefined();
      expect(plan.note).toMatch(/over 12000 characters/);
      expect(plan.note).not.toMatch(/aggregate/);
      expect(plan.note).not.toMatch(/first \d+ of/);
    });

    it('names only the aggregate budget when no single side/hunk exceeds its own cap', () => {
      const files = Array.from({ length: 10 }, (_, i) =>
        file({
          path: `f${i}.tex`,
          base: 'b'.repeat(3000),
          ours: 'o'.repeat(3000),
          theirs: 't'.repeat(3000),
          hunks: [],
        }),
      );
      const plan = planConflictPayload(files, { detail: 'auto', refs: REFS });
      expect(plan.note).toBeDefined();
      expect(plan.note).toMatch(new RegExp(`${CONFLICT_CONTENT_BUDGET}-char aggregate`));
      expect(plan.note).not.toMatch(/over 12000 characters/);
      expect(plan.note).not.toMatch(/first \d+ of/);
    });

    it('names only the file cap when every detailed file fits within budget', () => {
      const files = Array.from({ length: 250 }, (_, i) =>
        file({ path: `f${i}.tex`, hunks: [hunk(1, 1)], base: null, ours: null, theirs: null }),
      );
      const plan = planConflictPayload(files, { detail: 'auto', refs: REFS });
      expect(plan.note).toBeDefined();
      expect(plan.note).toMatch(new RegExp(`first ${CONFLICT_MAX_FILES} of 250`));
      expect(plan.note).not.toMatch(/over 12000 characters/);
      expect(plan.note).not.toMatch(/aggregate/);
    });
  });

  describe(
    'worst-case shapes measured at the planner level (see conflictText.test.ts for the ' +
      'actual rendered-size measurements against real render output)',
    () => {
      it('10 files x 200 hunks: cannot all be included, and reports truncated', () => {
        // Regression for the finding: 10 files x 200 tiny hunks rendered 64,361 chars of text
        // because per-hunk marker/JSON overhead (~55-60 chars/hunk) went entirely unbudgeted, even
        // though the RAW CONTENT of 2000 tiny hunks is trivially small. A content-only budget check
        // would pass this shape both before and after the fix — the real proof is that most of
        // these 2000 hunks get excluded once their rendered cost (not their content) is charged.
        const files = Array.from({ length: 10 }, (_, fi) =>
          file({
            path: `f${fi}.tex`,
            hunks: Array.from({ length: 200 }, (_, hi) => hunk(3, 3, hi * 3 + 1)),
            base: null,
            ours: null,
            theirs: null,
          }),
        );
        const plan = planConflictPayload(files, { detail: 'auto', refs: REFS });
        expect(plan.truncated).toBe(true);
        const includedHunkFiles = plan.files.filter((fp) => fp.hunks.included).length;
        const totalHunks = plan.files.length * 200;
        const includedHunks = plan.files
          .filter((fp) => fp.hunks.included)
          .reduce((n, fp) => n + fp.hunks.count, 0);
        // Each file's hunks are all-or-nothing (pass 1 allocates a whole file's hunks block at
        // once) — so proving the bug is fixed means most FILES' hunks blocks get excluded, not
        // just individual hunks trimmed within one.
        expect(includedHunkFiles).toBeLessThan(files.length);
        expect(includedHunks).toBeLessThan(totalHunks);
      });

      it('250 files x 1 hunk: file cap keeps the plan to 20 detailed files, truncated true', () => {
        // Regression for the finding: 250 conflicted files x 1 tiny hunk rendered 50,501 chars of
        // pure per-file headers with truncated: false. Raw content here is negligible either way —
        // the only thing that bounds this shape is a hard cap on the number of files detailed.
        const files = Array.from({ length: 250 }, (_, i) =>
          file({ path: `f${i}.tex`, hunks: [hunk(1, 1)], base: null, ours: null, theirs: null }),
        );
        const plan = planConflictPayload(files, { detail: 'auto', refs: REFS });
        expect(plan.files).toHaveLength(CONFLICT_MAX_FILES);
        expect(plan.truncated).toBe(true);
      });
    },
  );

  describe('a hunkless file is never treated as having elided hunks (finding 3)', () => {
    it('is not marked truncated by mandatory headers alone when nothing was actually cut', () => {
      // Regression: `if (cost <= budgetRemaining)` — cost is exactly 0 for a file with NO hunks (a
      // legitimate delete/modify conflict, not "hunks too big to fit") — failed once oversized
      // mandatory path headers alone drove budgetRemaining negative (0 <= a negative number is
      // false), taking the `else` branch and marking the file's hunks `included: false` even
      // though there was nothing to elide. With every side null too, nothing here should ever be
      // reported as cut.
      const bigPath = (i: number): string => `${'x'.repeat(1100)}-${i}.tex`;
      const files = Array.from({ length: CONFLICT_MAX_FILES }, (_, i) =>
        file({ path: bigPath(i), hunks: [], base: null, ours: null, theirs: null }),
      );
      const plan = planConflictPayload(files, { detail: 'auto', refs: REFS });

      for (const fp of plan.files) {
        expect(fp.hunks.included).toBe(true);
        expect(fp.hunks.count).toBe(0);
      }
      expect(plan.truncated).toBe(false);
      expect(plan.note).toBeUndefined();
    });

    it('never gets a reasonless elided.hunks entry even when mixed with a file that IS genuinely truncated', () => {
      // Same budget-pressure-from-huge-headers setup as above, but mixed with one file that has a
      // genuinely oversized side — so `truncated` is legitimately true here and the note must
      // still be well-formed (never a bare '.' from a hunkless file recording no reason for its
      // own, false, elision).
      const bigPath = (i: number): string => `${'x'.repeat(1100)}-${i}.tex`;
      const hunklessFiles = Array.from({ length: CONFLICT_MAX_FILES - 1 }, (_, i) =>
        file({ path: bigPath(i), hunks: [], base: null, ours: null, theirs: null }),
      );
      const oversizedFile = file({
        path: bigPath(CONFLICT_MAX_FILES - 1),
        hunks: [],
        base: 'z'.repeat(CONFLICT_SIDE_CAP + 1),
        ours: null,
        theirs: null,
      });
      const plan = planConflictPayload([...hunklessFiles, oversizedFile], {
        detail: 'auto',
        refs: REFS,
      });

      for (const fp of plan.files.slice(0, CONFLICT_MAX_FILES - 1)) {
        expect(fp.hunks.included).toBe(true);
        expect(fp.hunks.count).toBe(0);
      }
      expect(plan.truncated).toBe(true);
      expect(plan.note).toBeDefined();
      expect(plan.note!.startsWith('.')).toBe(false);
    });
  });

  describe('a distinct note reason when mandatory headers alone exhaust the budget', () => {
    const bigPath = (i: number): string => `${'x'.repeat(1100)}-${i}.tex`;

    it('20 files with 1,100-char paths + one small hunk each: note starts with the headers reason and still lists the aggregate reason', () => {
      const files = Array.from({ length: CONFLICT_MAX_FILES }, (_, i) =>
        file({ path: bigPath(i), hunks: [hunk(1, 1)], base: null, ours: null, theirs: null }),
      );
      const plan = planConflictPayload(files, { detail: 'auto', refs: REFS });

      expect(plan.truncated).toBe(true);
      expect(plan.note).toBeDefined();
      // First reason names the real cause (long paths), not just "the budget was reached".
      expect(plan.note!.startsWith(`the ${CONFLICT_MAX_FILES}-file headers alone`)).toBe(true);
      expect(plan.note).toMatch(/chars of headers and paths\) consumed the 20000-char budget/);
      // The aggregate reason still fires too (the hunks genuinely couldn't fit either) and is
      // still listed — the new reason supplements, it does not replace.
      expect(plan.note).toMatch(new RegExp(`${CONFLICT_CONTENT_BUDGET}-char aggregate`));
    });

    it('20 short-path files with a normal budget overrun: note does NOT mention headers', () => {
      const files = Array.from({ length: 10 }, (_, i) =>
        file({
          path: `f${i}.tex`,
          base: 'b'.repeat(3000),
          ours: 'o'.repeat(3000),
          theirs: 't'.repeat(3000),
          hunks: [],
        }),
      );
      const plan = planConflictPayload(files, { detail: 'auto', refs: REFS });

      expect(plan.truncated).toBe(true);
      expect(plan.note).toBeDefined();
      expect(plan.note).not.toMatch(/headers alone/);
    });

    it('long paths but no content at all (null sides, no hunks): truncated false, no note', () => {
      const files = Array.from({ length: CONFLICT_MAX_FILES }, (_, i) =>
        file({ path: bigPath(i), hunks: [], base: null, ours: null, theirs: null }),
      );
      const plan = planConflictPayload(files, { detail: 'auto', refs: REFS });

      expect(plan.truncated).toBe(false);
      expect(plan.note).toBeUndefined();
    });
  });
});

/**
 * This cap's OTHER half, which does not live in this file (#187).
 *
 * `CONFLICT_MAX_COMMITS` drops commits from both channels and tells the caller the whole list is in
 * `status.behindCommits`. That promise is only true while `status` leaves `behindCommits` out of
 * its own budget — a decision made in `src/lib/statusBudget.ts`, by people who may never read this
 * file. #175 kept it because that wave's spec named this pointer; the second pointer into `status`,
 * in `peerAttribution.ts`, was silently falsified by the same wave (#185).
 *
 * So the cap asserts its own delegation is registered. If someone deletes the inventory entry (or
 * the field's exemption with it), the failure lands here, on the cap that depends on it, and not
 * only in `statusBudget`'s tests.
 */
describe('CONFLICT_MAX_COMMITS delegates completeness to `status` (#187)', () => {
  it('is registered as a dependent of `status.behindCommits` in the completeness inventory', () => {
    const promise = STATUS_COMPLETENESS_PROMISES.find((p) => p.field === 'behindCommits');
    expect(
      promise,
      'this cap tells the caller `status.behindCommits` holds every commit it dropped, but ' +
        '`behindCommits` is no longer registered as a field `status` keeps complete ' +
        '(STATUS_COMPLETENESS_PROMISES, src/lib/statusBudget.ts). Either it is still exempt and ' +
        'the entry was lost — restore it — or it is now budgeted, and this cap is pointing at a ' +
        'list that may be short, which is #185 over again.',
    ).toBeDefined();

    const dependent = promise!.dependents.find((d) => d.module === 'src/lib/conflictBudget.ts');
    expect(
      dependent,
      'the inventory no longer records THIS file as depending on `behindCommits` being complete, ' +
        'so a future reader weighing whether the exemption still earns its place will not see the ' +
        'pointer below `CONFLICT_MAX_COMMITS` that still makes the promise.',
    ).toBeDefined();
    expect(dependent!.cap).toBe('CONFLICT_MAX_COMMITS');
  });

  it('really drops commits, so the delegation is load-bearing rather than decorative', () => {
    const commits: RemoteCommit[] = Array.from({ length: CONFLICT_MAX_COMMITS + 3 }, (_, i) => ({
      hash: `${i}`.padStart(40, '0'),
      message: `Update on Overleaf ${i}`,
      files: [],
    }));

    // The premise of the whole entry: this cap cuts, which is why something else has to hold the
    // complete list. A cap that stopped cutting would make the exemption pointless, not safe.
    expect(capRemoteCommits(commits).omitted).toBe(3);
  });
});

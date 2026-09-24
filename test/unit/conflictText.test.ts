import { describe, it, expect } from 'vitest';
import {
  renderConflictText,
  renderRebasedOver,
  renderCommitLines,
  capRemoteCommits,
  buildConflictFilePayload,
  renderHunkMarkers,
  renderHunksBlock,
  fileHeaderLine,
  renderSide,
  SIDE_LABELS,
} from '../../src/lib/conflictText.js';
import {
  planConflictPayload,
  renderElidedHunkSpans,
  sideElisionHint,
  CONFLICT_SIDE_CAP,
  CONFLICT_CONTENT_BUDGET,
  CONFLICT_MAX_FILES,
  CONFLICT_MAX_COMMITS,
  CONFLICT_MAX_COMMIT_FILES,
  HUNK_MARKER_OVERHEAD,
  HUNK_JSON_OVERHEAD,
  HUNK_LINE_ELEMENT_OVERHEAD,
  FILE_HEADER_OVERHEAD,
  SIDE_LABEL_OVERHEAD,
  SIDE_ELISION_OVERHEAD,
  HUNK_ELISION_TEXT_OVERHEAD,
  FILE_TEXT_LINE_BREAKS,
  HUNKS_BLOCK_TEXT_OVERHEAD,
  FILE_JSON_OVERHEAD,
  ELIDED_JSON_WRAPPER_OVERHEAD,
  SIDE_ABSENT_OVERHEAD,
  type ConflictPayloadPlan,
  type ConflictRefs,
} from '../../src/lib/conflictBudget.js';
import type { ConflictHunk } from '../../src/lib/conflictParser.js';
import type {
  ConflictFileDetail,
  ConflictReport,
  RemoteCommit,
} from '../../src/services/gitService.js';

const REMOTE_HEAD = 'e782dae2c0ffee1234567890abcdef0011223344';
const MERGE_BASE = 'ba5eba5e1122334455667788990011223344aabb';

function report(overrides: Partial<ConflictReport> = {}): ConflictReport {
  return {
    files: [
      {
        path: 'sections/04.tex',
        base: 'alpha\nbeta\ngamma\n',
        ours: 'alpha\nbeta-local\ngamma\n',
        theirs: 'alpha\nbeta-remote\ngamma\n',
        hunks: [{ startLine: 2, endLine: 6, local: ['beta-local'], remote: ['beta-remote'] }],
      },
    ],
    conflictPaths: ['sections/04.tex'],
    rebasedOnto: 'origin/master',
    remoteHead: REMOTE_HEAD,
    mergeBase: MERGE_BASE,
    remoteCommits: [
      {
        hash: 'abc1234def',
        message: 'reword scaling section',
        files: [{ path: 'sections/04.tex', added: 3, removed: 1 }],
      },
    ],
    guidance: 'resolve the overlap',
    ...overrides,
  };
}

describe('renderConflictText', () => {
  it('puts the full resolution payload in the visible text', () => {
    const text = renderConflictText('Rebase conflicts in 1 file(s).', report());

    // Per the acceptance test: paths, remoteHead (full + abbrev), remoteCommits, and per-file
    // content are all present in the model-visible text — not only in structuredContent.
    expect(text).toContain('sections/04.tex');
    expect(text).toContain(REMOTE_HEAD); // full sha
    expect(text).toContain('e782dae2'); // abbreviated
    expect(text).toContain(MERGE_BASE); // merge-base sha, so base is fetchable by ref
    expect(text).toContain('expectedRemoteHead');
    expect(text).toContain('reword scaling section');
    // Landed-upstream commit lists the file it touched, with line counts.
    expect(text).toContain('+3/-1 sections/04.tex');
    // All three full sides.
    expect(text).toContain('alpha\nbeta\ngamma\n'); // base
    expect(text).toContain('beta-local'); // ours
    expect(text).toContain('beta-remote'); // theirs
    // Marker view too.
    expect(text).toContain('<<<<<<< ours');
  });

  it('elides an oversized side with a read_file pointer instead of dumping it', () => {
    const huge = 'x'.repeat(20000);
    const base = report();
    const text = renderConflictText('conflict', {
      ...base,
      files: [{ ...base.files[0]!, theirs: huge, base: huge }],
    });

    expect(text).not.toContain(huge);
    // theirs points at the remote ref; base points at the merge-base sha — both shell-free.
    expect(text).toContain('read_file("sections/04.tex", ref="origin/master")');
    expect(text).toContain(`read_file("sections/04.tex", ref="${MERGE_BASE}")`);
  });

  it('marks an absent side (added/deleted) rather than showing null', () => {
    const rep = report();
    const text = renderConflictText('conflict', {
      ...rep,
      files: [{ ...rep.files[0]!, base: null }],
    });
    expect(text).toContain('base (common ancestor): (absent');
  });

  it('states the hunk count and line spans when hunks are elided', () => {
    const hugeHunk = {
      startLine: 10,
      endLine: 20,
      local: ['l'.repeat(CONFLICT_CONTENT_BUDGET + 1)],
      remote: ['r'],
    };
    const rep = report();
    const text = renderConflictText('conflict', {
      ...rep,
      files: [{ ...rep.files[0]!, hunks: [hugeHunk], base: null, ours: null, theirs: null }],
    });
    // The overlap content itself must not appear...
    expect(text).not.toContain('l'.repeat(CONFLICT_CONTENT_BUDGET + 1));
    // ...but the count and the line span it covered must, so the caller knows what's missing.
    expect(text).toContain('1 hunk');
    expect(text).toContain('10-20');
  });

  it('detail: "full" restores an otherwise-elided side in full', () => {
    const huge = 'x'.repeat(20000);
    const base = report();
    const rep: ConflictReport = {
      ...base,
      files: [{ ...base.files[0]!, theirs: huge, base: huge }],
    };
    const autoText = renderConflictText('conflict', rep);
    expect(autoText).not.toContain(huge);
    const fullText = renderConflictText('conflict', rep, { detail: 'full' });
    expect(fullText).toContain(huge);
  });
});

describe('buildConflictFilePayload (structured channel) agrees with the text channel', () => {
  it('elides the same parts of the same files that the text channel elides', () => {
    const hugeHunk = {
      startLine: 3,
      endLine: 9,
      local: ['l'.repeat(CONFLICT_CONTENT_BUDGET + 1)],
      remote: ['r'],
    };
    const rep = report();
    const conflicted: ConflictReport = {
      ...rep,
      files: [
        { ...rep.files[0]!, hunks: [hugeHunk], theirs: 'x'.repeat(20000), base: 'y'.repeat(20000) },
      ],
    };

    const plan = planConflictPayload(conflicted.files, {
      detail: 'auto',
      refs: { mergeBase: conflicted.mergeBase, rebasedOnto: conflicted.rebasedOnto },
    });
    const text = renderConflictText('conflict', conflicted);
    const structured = buildConflictFilePayload(conflicted, plan);

    expect(structured).toHaveLength(1);
    const entry = structured[0]!;
    // Whatever the text channel shows as elided (theirs, base, hunks — oversized/over-budget),
    // the structured channel must mark `elided` for the same parts, and null out their content —
    // never silently indistinguishable from "absent, added/deleted on this side".
    expect(text).toContain('theirs (remote that landed): (');
    expect(text).toContain('base (common ancestor): (');
    expect(entry.elided?.theirs).toBeDefined();
    expect(entry.elided?.base).toBeDefined();
    expect(entry.theirs).toBeNull();
    expect(entry.base).toBeNull();
    // ours was small enough to survive in both channels.
    expect(entry.elided?.ours).toBeUndefined();
    expect(entry.ours).not.toBeNull();
    expect(text).toContain('ours (local):\n' + entry.ours);
    // The elided entry's chars are the TRUE size, not 0 / not the truncated size.
    expect(entry.elided?.theirs?.chars).toBe(20000);
    expect(entry.elided?.base?.chars).toBe(20000);
  });

  it('never confuses an elided side with an absent one', () => {
    const rep = report();
    const conflicted: ConflictReport = {
      ...rep,
      files: [{ ...rep.files[0]!, base: null }], // genuinely absent, not elided
    };
    const plan = planConflictPayload(conflicted.files, {
      detail: 'auto',
      refs: { mergeBase: conflicted.mergeBase, rebasedOnto: conflicted.rebasedOnto },
    });
    const structured = buildConflictFilePayload(conflicted, plan);
    expect(structured[0]!.base).toBeNull();
    expect(structured[0]!.elided?.base).toBeUndefined();
  });
});

describe('no-merge-base hint is honest about what is actually on screen (dead-advice fix)', () => {
  // `report()`'s default file has mergeBase set; these tests override it to null (unrelated
  // histories) and force `base` to elide via CONFLICT_SIDE_CAP, independent of the aggregate
  // budget, so only `hunksRendered` (whether THIS file's hunks block shows full markers) varies
  // between cases.
  function noMergeBaseConflict(fileOverrides: Partial<ConflictFileDetail>): ConflictReport {
    const rep = report({ mergeBase: null });
    return { ...rep, files: [{ ...rep.files[0]!, ...fileOverrides }] };
  }

  it('hunks rendered: text points at the markers AND states there is no merge base', () => {
    // Default file's hunk (small) survives in full — hunks really are on screen.
    const conflicted = noMergeBaseConflict({ base: 'z'.repeat(CONFLICT_SIDE_CAP + 1) });
    const plan = planConflictPayload(conflicted.files, {
      detail: 'auto',
      refs: { mergeBase: conflicted.mergeBase, rebasedOnto: conflicted.rebasedOnto },
    });
    expect(plan.files[0]!.hunks.included).toBe(true); // sanity: markers really are rendered

    const text = renderConflictText('conflict', conflicted);
    const structured = buildConflictFilePayload(conflicted, plan);

    expect(text).toContain('overlap markers above');
    expect(text).toContain('no merge base');
    expect(structured[0]!.elided?.base?.ref).toBe('no merge base (unrelated histories)');
  });

  it('hunks elided: text must NOT mention markers, only the honest no-merge-base wording (dead advice)', () => {
    const hugeHunk = {
      startLine: 10,
      endLine: 20,
      local: ['l'.repeat(CONFLICT_CONTENT_BUDGET + 1)],
      remote: ['r'],
    };
    const conflicted = noMergeBaseConflict({
      hunks: [hugeHunk],
      base: 'z'.repeat(CONFLICT_SIDE_CAP + 1),
    });
    const plan = planConflictPayload(conflicted.files, {
      detail: 'auto',
      refs: { mergeBase: conflicted.mergeBase, rebasedOnto: conflicted.rebasedOnto },
    });
    expect(plan.files[0]!.hunks.included).toBe(false); // sanity: markers really are cut

    const text = renderConflictText('conflict', conflicted);
    const structured = buildConflictFilePayload(conflicted, plan);

    expect(text).not.toContain('markers');
    expect(text).toContain('no merge base (unrelated histories)');
    expect(structured[0]!.elided?.base?.ref).toBe('no merge base (unrelated histories)');
  });

  it('file has no hunks at all (hunks: []): same honest wording, not the markers pointer', () => {
    // Distinct input from "hunks elided" above: an empty array is never `included: false` (there
    // is nothing to cut), so this must not accidentally fall through to the markers branch either.
    const conflicted = noMergeBaseConflict({ hunks: [], base: 'z'.repeat(CONFLICT_SIDE_CAP + 1) });
    const plan = planConflictPayload(conflicted.files, {
      detail: 'auto',
      refs: { mergeBase: conflicted.mergeBase, rebasedOnto: conflicted.rebasedOnto },
    });
    expect(plan.files[0]!.hunks.included).toBe(true); // trivially true; nothing to elide
    expect(conflicted.files[0]!.hunks).toHaveLength(0);

    const text = renderConflictText('conflict', conflicted);
    const structured = buildConflictFilePayload(conflicted, plan);

    expect(text).not.toContain('markers');
    expect(text).toContain('no merge base (unrelated histories)');
    expect(structured[0]!.elided?.base?.ref).toBe('no merge base (unrelated histories)');
  });

  it('mergeBase present: hint unchanged in both channels (common path does not regress)', () => {
    const rep = report();
    const conflicted: ConflictReport = {
      ...rep,
      files: [{ ...rep.files[0]!, base: 'x'.repeat(20000) }],
    };
    const plan = planConflictPayload(conflicted.files, {
      detail: 'auto',
      refs: { mergeBase: conflicted.mergeBase, rebasedOnto: conflicted.rebasedOnto },
    });
    const text = renderConflictText('conflict', conflicted);
    const structured = buildConflictFilePayload(conflicted, plan);

    const expectedRef = `read_file("sections/04.tex", ref="${MERGE_BASE}")`;
    expect(text).toContain(expectedRef);
    expect(structured[0]!.elided?.base?.ref).toBe(expectedRef);
  });
});

describe('renderRebasedOver', () => {
  it('summarizes the commits landed underneath a successful push', () => {
    const text = renderRebasedOver([
      {
        hash: 'deadbeef00',
        message: 'their edit',
        files: [{ path: 'main.tex', added: 2, removed: 0 }],
      },
    ]);
    expect(text).toContain('Rebased over 1 commit(s)');
    // The file the commit touched is listed too, not just the hash/subject.
    expect(text).toContain('+2/-0 main.tex');
    expect(renderRebasedOver([])).toBe('');
    expect(renderRebasedOver(undefined)).toBe('');
  });
});

describe('renderCommitLines', () => {
  function commit(hash: string, message: string, files: RemoteCommit['files'] = []): RemoteCommit {
    return { hash, message, files };
  }

  it('prints a file line per file, with added/removed counts', () => {
    const lines = renderCommitLines([
      commit('aaaaaaaa1111', 'edit two files', [
        { path: 'main.tex', added: 3, removed: 1 },
        { path: 'sections/new.tex', added: 10, removed: 0 },
      ]),
    ]);
    expect(lines[0]).toBe('  aaaaaaaa edit two files');
    expect(lines).toContain('      +3/-1 main.tex');
    expect(lines).toContain('      +10/-0 sections/new.tex');
  });

  it('caps files per commit and adds a "more file(s)" line', () => {
    const files = Array.from({ length: 8 }, (_, i) => ({
      path: `f${i}.tex`,
      added: 1,
      removed: 0,
    }));
    const lines = renderCommitLines([commit('bbbbbbbb2222', 'many files', files)], {
      maxFiles: 5,
    });
    const fileLines = lines.filter((l) => l.startsWith('      +'));
    expect(fileLines).toHaveLength(5);
    expect(lines).toContain('      … 3 more file(s)');
  });

  it('caps commits and adds a "more commit(s)" line', () => {
    const commits = Array.from({ length: 25 }, (_, i) => commit(`cccc${i}`, `commit ${i}`));
    const lines = renderCommitLines(commits, { maxCommits: 20 });
    const commitLines = lines.filter((l) => /^ {2}c{4}\d+ /.test(l));
    expect(commitLines).toHaveLength(20);
    expect(lines[lines.length - 1]).toBe('  … 5 more commit(s) (see structuredContent)');
  });
});

describe('overhead constants stay pinned to the real render format (finding 1)', () => {
  // These tests exist to FAIL the moment renderHunkMarkers, fileHeaderLine, SIDE_LABELS, or the
  // ConflictHunk JSON shape change without conflictBudget.ts's overhead constants being updated
  // to match — the whole point of naming them is that they must never silently drift apart from
  // what actually gets rendered.

  it('HUNK_MARKER_OVERHEAD matches renderHunkMarkers exactly (text channel)', () => {
    const h: ConflictHunk = { startLine: 3, endLine: 9, local: ['abc', 'de'], remote: ['fghij'] };
    const rendered = renderHunkMarkers([h]);
    const contentChars = h.local.join('\n').length + h.remote.join('\n').length;
    const digits = String(h.startLine).length + String(h.endLine).length;
    expect(rendered.length - contentChars - digits).toBe(HUNK_MARKER_OVERHEAD);
  });

  it('FILE_HEADER_OVERHEAD matches fileHeaderLine exactly (text channel)', () => {
    const path = 'sections/04.tex';
    expect(fileHeaderLine(path).length - path.length).toBe(FILE_HEADER_OVERHEAD);
  });

  it('SIDE_LABEL_OVERHEAD covers the longest of the three SIDE_LABELS plus ":\\n"', () => {
    const longest = Math.max(...Object.values(SIDE_LABELS).map((l) => l.length));
    expect(longest + ':\n'.length).toBe(SIDE_LABEL_OVERHEAD);
  });

  it('HUNK_JSON_OVERHEAD + HUNK_LINE_ELEMENT_OVERHEAD matches JSON.stringify of a ConflictHunk', () => {
    // structuredContent embeds ConflictHunk objects verbatim (no wrapper) in `hunks: []`.
    const h: ConflictHunk = { startLine: 12, endLine: 34, local: ['a', 'b', 'c'], remote: ['d'] };
    const json = JSON.stringify(h);
    const contentChars = h.local.join('\n').length + h.remote.join('\n').length;
    const digits = String(h.startLine).length + String(h.endLine).length;
    const lineElements = h.local.length + h.remote.length;
    expect(json.length - contentChars - digits).toBe(
      HUNK_JSON_OVERHEAD + lineElements * HUNK_LINE_ELEMENT_OVERHEAD,
    );
  });

  it("SIDE_ELISION_OVERHEAD matches renderSide's elided branch exactly (finding 2)", () => {
    const longest = Math.max(...Object.values(SIDE_LABELS).map((l) => l.length));
    const chars = 1234;
    const hint = 'HINT';
    // Non-null content of any length picks the elided branch as long as `part.included` is false;
    // its own length is irrelevant there.
    const rendered = renderSide(SIDE_LABELS.theirs, 'x', { included: false, chars }, hint);
    expect(SIDE_LABELS.theirs.length).toBe(longest); // sanity: theirs really is the longest label
    // SIDE_ELISION_OVERHEAD already includes the (longest) label's own length — see its doc
    // comment — so only the digits and the hint are subtracted here.
    expect(rendered.length - String(chars).length - hint.length).toBe(SIDE_ELISION_OVERHEAD);
  });

  it("HUNK_ELISION_TEXT_OVERHEAD matches renderHunksBlock's elided branch exactly (finding 2)", () => {
    const count = 7;
    const chars = 1234;
    const spans = [
      { startLine: 1, endLine: 2 },
      { startLine: 3, endLine: 4 },
    ];
    const spansText = renderElidedHunkSpans(spans, count);
    const rendered = renderHunksBlock([], { included: false, chars, count, spans });
    expect(rendered.length - String(count).length - String(chars).length - spansText.length).toBe(
      HUNK_ELISION_TEXT_OVERHEAD,
    );
  });

  it('SIDE_ELISION_OVERHEAD matches renderSide for BOTH no-merge-base hint variants (dead-advice fix)', () => {
    // `sideElisionCost` (conflictBudget.ts) charges `SIDE_ELISION_OVERHEAD + digits +
    // hint.text.length` using whichever variant `sideElisionHint` selects for a given
    // `hunksRendered`. If the two variants' real rendered lengths ever drift from what the
    // planner charges, this is the test that catches it — the same style as the
    // SIDE_ELISION_OVERHEAD test above, just against both real hint strings instead of a
    // placeholder.
    const refsNoMergeBase: ConflictRefs = { mergeBase: null, rebasedOnto: 'origin/master' };
    const chars = 4321;
    for (const hunksRendered of [true, false]) {
      const hint = sideElisionHint('sections/04.tex', 'base', refsNoMergeBase, hunksRendered);
      // The JSON side must also carry the exact fact both channels agree on, regardless of
      // `hunksRendered` — this is the JSON hint that never varies.
      expect(hint.json).toBe('no merge base (unrelated histories)');
      // SIDE_ELISION_OVERHEAD is sized off the LONGEST label (theirs) — see the sibling pinning
      // test above — so render under that label here too, the same way that test does.
      const rendered = renderSide(SIDE_LABELS.theirs, 'x', { included: false, chars }, hint.text);
      expect(rendered.length - String(chars).length - hint.text.length).toBe(SIDE_ELISION_OVERHEAD);
    }
    // And the two variants really are different lengths — otherwise this test would not be
    // exercising the bug the accounting-care warns about.
    const withMarkers = sideElisionHint('p.tex', 'base', refsNoMergeBase, true).text;
    const withoutMarkers = sideElisionHint('p.tex', 'base', refsNoMergeBase, false).text;
    expect(withMarkers.length).not.toBe(withoutMarkers.length);
  });
});

describe('worst-case shapes stay bounded once rendered (regression for findings 1 & 3)', () => {
  function fileWithHunks(path: string, hunks: ConflictHunk[]): ConflictFileDetail {
    return { path, base: null, ours: null, theirs: null, hunks };
  }

  function tinyHunk(at: number): ConflictHunk {
    return { startLine: at, endLine: at + 1, local: ['x'], remote: ['y'] };
  }

  // Comfortably under the ~50-67k that failed to deliver, but far tighter than "no bound at all".
  const RENDERED_SIZE_CEILING = 35000;

  it('10 files x 200 tiny hunks: text and structured JSON both stay bounded and truncated', () => {
    const files = Array.from({ length: 10 }, (_, fi) =>
      fileWithHunks(
        `f${fi}.tex`,
        Array.from({ length: 200 }, (_, hi) => tinyHunk(hi * 3 + 1)),
      ),
    );
    const rep = report({ files, conflictPaths: files.map((f) => f.path) });

    const plan = planConflictPayload(rep.files, {
      detail: 'auto',
      refs: { mergeBase: rep.mergeBase, rebasedOnto: rep.rebasedOnto },
    });
    const text = renderConflictText(rep.guidance, rep);
    const structured = buildConflictFilePayload(rep, plan);
    const json = JSON.stringify({
      conflictFiles: structured,
      conflictPaths: rep.conflictPaths,
      remoteHead: rep.remoteHead,
      mergeBase: rep.mergeBase,
      remoteCommits: rep.remoteCommits,
      conflictTruncated: plan.truncated,
    });

    expect(plan.truncated).toBe(true);
    expect(text.length).toBeLessThan(RENDERED_SIZE_CEILING);
    expect(json.length).toBeLessThan(RENDERED_SIZE_CEILING);
    // The essential top-level fields survive regardless of what got elided inside files.
    for (const f of files) expect(text).toContain(f.path);
  });

  it('250 files x 1 tiny hunk: file cap keeps both channels bounded, truncated true, conflictPaths intact', () => {
    const files = Array.from({ length: 250 }, (_, i) => fileWithHunks(`f${i}.tex`, [tinyHunk(1)]));
    const rep = report({ files, conflictPaths: files.map((f) => f.path) });

    const plan = planConflictPayload(rep.files, {
      detail: 'auto',
      refs: { mergeBase: rep.mergeBase, rebasedOnto: rep.rebasedOnto },
    });
    const text = renderConflictText(rep.guidance, rep);
    const structured = buildConflictFilePayload(rep, plan);
    const json = JSON.stringify({
      conflictFiles: structured,
      conflictPaths: rep.conflictPaths,
      remoteHead: rep.remoteHead,
      mergeBase: rep.mergeBase,
      remoteCommits: rep.remoteCommits,
      conflictTruncated: plan.truncated,
    });

    expect(plan.truncated).toBe(true);
    expect(text.length).toBeLessThan(RENDERED_SIZE_CEILING);
    expect(json.length).toBeLessThan(RENDERED_SIZE_CEILING);
    expect(structured.length).toBe(CONFLICT_MAX_FILES);
    // INVARIANT: conflictPaths (top-level) is never capped or truncated, even though the
    // per-file detail is — every one of the 250 paths is still named, in the text too.
    expect(rep.conflictPaths).toHaveLength(250);
    for (const f of files) expect(text).toContain(f.path);
  });

  it(
    '20 files x 200 hunks x 3 oversized sides (everything elided): both channels stay bounded ' +
      '(finding 2 coverage)',
    () => {
      // Coverage for the finding's own probe shape: eliding is not free — the "(N chars, elided —
      // read_file(...))" pointer and an elided hunks block's line-span list were charged ZERO. This
      // exact shape (every side forced over CONFLICT_SIDE_CAP, unconditionally elided regardless of
      // budget; every file with 200 hunks) happens to stay bounded via CONFLICT_MAX_FILES /
      // CONFLICT_MAX_SPANS alone even pre-fix (nothing here is a MARGINAL decision the elision
      // charge could shift) — see the sibling test below for a shape where the charge is what
      // actually decides the outcome. Kept as a permanent ceiling check for this shape regardless.
      const files = Array.from({ length: CONFLICT_MAX_FILES }, (_, fi) => ({
        path: `f${fi}.tex`,
        base: 'b'.repeat(CONFLICT_SIDE_CAP + 1),
        ours: 'o'.repeat(CONFLICT_SIDE_CAP + 1),
        theirs: 't'.repeat(CONFLICT_SIDE_CAP + 1),
        hunks: Array.from({ length: 200 }, (_, hi) => tinyHunk(hi * 3 + 1)),
      }));
      const rep = report({ files, conflictPaths: files.map((f) => f.path) });

      const plan = planConflictPayload(rep.files, {
        detail: 'auto',
        refs: { mergeBase: rep.mergeBase, rebasedOnto: rep.rebasedOnto },
      });
      const text = renderConflictText(rep.guidance, rep);
      const structured = buildConflictFilePayload(rep, plan);
      const json = JSON.stringify(structured);

      expect(plan.truncated).toBe(true);
      // Every side, on every file, is well over CONFLICT_SIDE_CAP — none of them ever fit.
      for (const fp of plan.files) {
        expect(fp.base.included).toBe(false);
        expect(fp.ours.included).toBe(false);
        expect(fp.theirs.included).toBe(false);
      }
      // The aggregate hunks budget cannot hold 20 files x 200 hunks either — most files' hunks
      // blocks are excluded (each file's hunks are allocated all-or-nothing).
      const includedHunkFiles = plan.files.filter((fp) => fp.hunks.included).length;
      expect(includedHunkFiles).toBeLessThan(files.length);
      expect(text.length).toBeLessThan(RENDERED_SIZE_CEILING);
      expect(json.length).toBeLessThan(RENDERED_SIZE_CEILING);
      for (const f of files) expect(text).toContain(f.path);
    },
  );

  it('unbudgeted elision boilerplate lets an oversized side sneak in past the real budget (finding 2 regression)', () => {
    // A genuine regression, unlike the sibling test above: 19 "noise" files whose three sides are
    // ALL forced over CONFLICT_SIDE_CAP (so each is unconditionally elided, regardless of budget —
    // its ELISION pointer is what was, pre-fix, charged zero) are followed by one file with a
    // single 11,900-char side — comfortably under CONFLICT_SIDE_CAP, and small enough that it fits
    // the RAW aggregate budget too. Pre-fix, none of the 57 preceding elisions consumed any of the
    // shared budget, so this last side was wrongly included in full. Post-fix, their real (path- and
    // ref-embedding) pointer cost is charged as it accrues, correctly leaving too little budget for
    // the last side — which is exactly what a caller re-fetching it via `read_file` should see
    // reflected: elided for size, not silently smuggled in because 57 unrelated cuts were "free".
    const NOISE_FILES = 19;
    const noisePath = (i: number): string => `n${i}-${'p'.repeat(55)}.tex`;
    const noiseFiles: ConflictFileDetail[] = Array.from({ length: NOISE_FILES }, (_, i) => ({
      path: noisePath(i),
      base: 'z'.repeat(CONFLICT_SIDE_CAP + 1),
      ours: 'o'.repeat(CONFLICT_SIDE_CAP + 1),
      theirs: 't'.repeat(CONFLICT_SIDE_CAP + 1),
      hunks: [],
    }));
    const flipFile: ConflictFileDetail = {
      path: 'flip.tex',
      base: 'q'.repeat(11900),
      ours: null,
      theirs: null,
      hunks: [],
    };
    const files = [...noiseFiles, flipFile];
    const rep = report({ files, conflictPaths: files.map((f) => f.path) });

    const plan = planConflictPayload(rep.files, {
      detail: 'auto',
      refs: { mergeBase: rep.mergeBase, rebasedOnto: rep.rebasedOnto },
    });
    const structured = buildConflictFilePayload(rep, plan);

    const flipPlan = plan.files[plan.files.length - 1]!;
    const flipEntry = structured[structured.length - 1]!;
    expect(flipPlan.path).toBe('flip.tex');
    expect(flipPlan.base.included).toBe(false);
    expect(flipEntry.base).toBeNull();
    expect(flipEntry.elided?.base?.chars).toBe(11900);
    expect(plan.truncated).toBe(true);
  });
});

describe('escape-heavy content stays bounded once JSON-encoded (finding 1 regression)', () => {
  // Matches the finding's own probe shape: two files, one oversized side each, sized so their RAW
  // lengths sum to comfortably under CONFLICT_CONTENT_BUDGET — pre-fix, charged only by raw
  // length, both were always fully included (`truncated: false`). The bug is that
  // `JSON.stringify` (structuredContent is JSON) explodes their real encoded size well past that,
  // entirely uncharged — LaTeX is backslash-dense, so this is not a hypothetical adversarial
  // input. A single isolated escape-heavy side never reproduces this: with nothing else competing
  // for budget it stays small regardless, pre- or post-fix.
  const SIZE_A = 11900;
  const SIZE_B = 7800;
  const ESCAPE_CEILING = 35000;

  function reportWithSides(sideA: string, sideB: string): ConflictReport {
    const rep = report();
    const base = rep.files[0]!;
    const files: ConflictFileDetail[] = [
      { ...base, path: 'a.tex', base: sideA, ours: null, theirs: null, hunks: [] },
      { ...base, path: 'b.tex', base: sideB, ours: null, theirs: null, hunks: [] },
    ];
    return { ...rep, files, conflictPaths: files.map((f) => f.path) };
  }

  function planAndBuild(rep: ConflictReport): { plan: ConflictPayloadPlan; json: string } {
    const plan = planConflictPayload(rep.files, {
      detail: 'auto',
      refs: { mergeBase: rep.mergeBase, rebasedOnto: rep.rebasedOnto },
    });
    const structured = buildConflictFilePayload(rep, plan);
    return { plan, json: JSON.stringify(structured) };
  }

  it('all-backslash sides: bounded and truncated once real JSON escaping is charged', () => {
    const rep = reportWithSides('\\'.repeat(SIZE_A), '\\'.repeat(SIZE_B));
    const { plan, json } = planAndBuild(rep);

    expect(plan.truncated).toBe(true);
    expect(json.length).toBeLessThan(ESCAPE_CEILING);
  });

  it('sides with many literal newlines: bounded and truncated once real JSON escaping is charged', () => {
    const rep = reportWithSides('a\n'.repeat(SIZE_A / 2), 'a\n'.repeat(SIZE_B / 2));
    const { plan, json } = planAndBuild(rep);

    expect(plan.truncated).toBe(true);
    expect(json.length).toBeLessThan(ESCAPE_CEILING);
  });

  it('control-character sides: bounded and truncated once real JSON escaping is charged', () => {
    const rep = reportWithSides('\x01'.repeat(SIZE_A), '\x01'.repeat(SIZE_B));
    const { plan, json } = planAndBuild(rep);

    expect(plan.truncated).toBe(true);
    expect(json.length).toBeLessThan(ESCAPE_CEILING);
  });
});

describe('CONFLICT_CONTENT_BUDGET bounds BOTH channels combined, not the larger of the two', () => {
  // The per-file payload ships twice: as the file blocks of the result text and again as
  // `structuredContent.conflictFiles`. Charging `max(text, json)` per part bounded each channel
  // on its own at best — never what the caller receives — and the per-file JSON scaffold (keys,
  // `null` sides, the `elided` wrapper), the text channel's line breaks, `overlap:` label and
  // absent-side lines were never charged at all: 20 backslash-heavy files reached 23,485
  // characters of JSON alone, past the 20000 budget, and ~40k across the two channels.

  /** The file blocks of the text channel — everything `renderConflictText` renders per detailed
   * file (from the blank line before the first header onward), i.e. what the plan decides. The
   * report-level prelude (summary, guidance, refs, landed commits, the never-capped conflictPaths
   * list, the note) is outside the budget by design. Valid for reports within CONFLICT_MAX_FILES,
   * where no "… N more" trailer follows the last block. */
  function fileBlocksText(text: string, rep: ConflictReport): string {
    const start = text.indexOf('\n\n' + fileHeaderLine(rep.files[0]!.path));
    expect(start).toBeGreaterThan(0);
    return text.slice(start);
  }

  function renderedPerFileSize(rep: ConflictReport): { total: number; truncated: boolean } {
    const plan = planConflictPayload(rep.files, {
      detail: 'auto',
      refs: { mergeBase: rep.mergeBase, rebasedOnto: rep.rebasedOnto },
    });
    const text = renderConflictText('summary', rep, { plan });
    const json = JSON.stringify(buildConflictFilePayload(rep, plan));
    return { total: fileBlocksText(text, rep).length + json.length, truncated: plan.truncated };
  }

  /** `n` characters of `ch`, broken into 80-column lines — a realistic side. */
  function side(n: number, ch: string): string {
    return (ch.repeat(79) + '\n').repeat(Math.ceil(n / 80)).slice(0, n);
  }

  function manyFiles(opts: {
    files: number;
    sideChars: number;
    ch: string;
    hunks: ConflictHunk[];
    mergeBase?: string | null;
  }): ConflictReport {
    const files: ConflictFileDetail[] = Array.from({ length: opts.files }, (_, i) => ({
      path: `sections/s${i}.tex`,
      base: side(opts.sideChars, opts.ch),
      ours: side(opts.sideChars, opts.ch),
      theirs: side(opts.sideChars, opts.ch),
      hunks: opts.hunks,
    }));
    return report({
      files,
      conflictPaths: files.map((f) => f.path),
      mergeBase: opts.mergeBase === undefined ? MERGE_BASE : opts.mergeBase,
      guidance: 'g'.repeat(700),
    });
  }

  const probeHunk: ConflictHunk = {
    startLine: 1,
    endLine: 5,
    local: ['x'.repeat(40)],
    remote: ['y'.repeat(40)],
  };

  it('20 backslash-heavy files: text file blocks + conflictFiles JSON stay within the budget', () => {
    const { total, truncated } = renderedPerFileSize(
      manyFiles({ files: 20, sideChars: 300, ch: '\\', hunks: [probeHunk] }),
    );
    expect(truncated).toBe(true);
    expect(total).toBeLessThanOrEqual(CONFLICT_CONTENT_BUDGET);
  });

  it('20 plain-text files: text file blocks + conflictFiles JSON stay within the budget', () => {
    const { total, truncated } = renderedPerFileSize(
      manyFiles({ files: 20, sideChars: 300, ch: 'a', hunks: [probeHunk] }),
    );
    expect(truncated).toBe(true);
    expect(total).toBeLessThanOrEqual(CONFLICT_CONTENT_BUDGET);
  });

  /**
   * The same report with EVERY cuttable part cut — the smallest thing the per-file payload can be
   * rendered as short of dropping files. Built by hand from the plan's own shape, not by the
   * planner, so it is an independent oracle for whether the budget is honourable at all.
   */
  function allCutSize(rep: ConflictReport): number {
    const plan: ConflictPayloadPlan = {
      truncated: true,
      files: rep.files.map((f) => ({
        path: f.path,
        hunks: {
          included: f.hunks.length === 0,
          chars: f.hunks.reduce(
            (n, h) => n + h.local.join('\n').length + h.remote.join('\n').length,
            0,
          ),
          count: f.hunks.length,
          spans: f.hunks.slice(0, 20).map((h) => ({ startLine: h.startLine, endLine: h.endLine })),
        },
        base: { included: f.base === null, chars: f.base?.length ?? 0 },
        ours: { included: f.ours === null, chars: f.ours?.length ?? 0 },
        theirs: { included: f.theirs === null, chars: f.theirs?.length ?? 0 },
      })),
    };
    const text = renderConflictText('summary', rep, { plan });
    return (
      fileBlocksText(text, rep).length + JSON.stringify(buildConflictFilePayload(rep, plan)).length
    );
  }

  it('holds across a sweep of sizes, escape densities, file counts, hunk shapes and merge bases', () => {
    const tinyHunks = Array.from({ length: 30 }, (_, i) => ({
      startLine: i * 3 + 1,
      endLine: i * 3 + 2,
      local: ['a\\b'],
      remote: ['"c"'],
    }));
    const bigHunk: ConflictHunk = {
      startLine: 7,
      endLine: 70,
      local: [side(2000, '\\')],
      remote: [side(1500, 'r')],
    };
    const failures: string[] = [];
    let honourable = 0;
    for (const files of [1, 3, 20])
      for (const sideChars of [50, 3000, 11900])
        for (const ch of ['a', '\\', '"\n'])
          for (const [hunkLabel, hunks] of [
            ['none', []],
            ['big', [bigHunk]],
            ['tiny30', tinyHunks],
          ] as const)
            for (const mergeBase of [MERGE_BASE, null]) {
              const rep = manyFiles({ files, sideChars, ch, hunks: [...hunks], mergeBase });
              const label =
                `${files} file(s) x ${sideChars} ${JSON.stringify(ch)} hunks=${hunkLabel} ` +
                `mergeBase=${mergeBase ? 'set' : 'null'}`;
              const plan = planConflictPayload(rep.files, {
                detail: 'auto',
                refs: { mergeBase: rep.mergeBase, rebasedOnto: rep.rebasedOnto },
              });
              const { total } = renderedPerFileSize(rep);
              if (allCutSize(rep) <= CONFLICT_CONTENT_BUDGET) {
                honourable++;
                if (total > CONFLICT_CONTENT_BUDGET) failures.push(`${label}: ${total}`);
              } else if (!/pointers standing in|headers alone/.test(plan.note ?? '')) {
                // No plan can fit (20 files x 30 hunks: the span notes and read_file pointers
                // alone exceed the budget) — then the note must say so, not claim a budget held.
                failures.push(`${label}: over budget (${total}) without saying why: ${plan.note}`);
              }
            }
    expect(failures).toEqual([]);
    // The exemption above must stay the exception, or this sweep proves nothing.
    expect(honourable).toBeGreaterThanOrEqual(90);
  });
});

describe('per-file framing constants stay pinned to the real render, from both sides', () => {
  const PATH = 'sections/04.tex';

  function oneFile(overrides: Partial<ConflictFileDetail>): ConflictReport {
    const f: ConflictFileDetail = {
      path: PATH,
      base: null,
      ours: null,
      theirs: null,
      hunks: [],
      ...overrides,
    };
    return report({ files: [f], conflictPaths: [PATH] });
  }

  function blocksAndEntry(
    rep: ConflictReport,
    plan?: ConflictPayloadPlan,
  ): { blocks: string; entry: string } {
    const p =
      plan ??
      planConflictPayload(rep.files, {
        detail: 'auto',
        refs: { mergeBase: rep.mergeBase, rebasedOnto: rep.rebasedOnto },
      });
    const text = renderConflictText('summary', rep, { plan: p });
    const start = text.indexOf('\n\n' + fileHeaderLine(PATH));
    return {
      blocks: text.slice(start),
      entry: JSON.stringify(buildConflictFilePayload(rep, p)[0]),
    };
  }

  const absentLines = (['base', 'ours', 'theirs'] as const).reduce(
    (n, k) => n + renderSide(SIDE_LABELS[k], null, { included: true, chars: 0 }, '').length,
    0,
  );

  it('SIDE_ABSENT_OVERHEAD matches renderSide for an absent side under the longest label', () => {
    expect(
      renderSide(SIDE_LABELS.theirs, null, { included: true, chars: 0 }, 'unused').length,
    ).toBe(SIDE_ABSENT_OVERHEAD);
  });

  it('FILE_TEXT_LINE_BREAKS: a hunkless, all-absent file block is header + breaks + side lines', () => {
    const { blocks } = blocksAndEntry(oneFile({}));
    expect(blocks.length).toBe(
      FILE_HEADER_OVERHEAD + PATH.length + FILE_TEXT_LINE_BREAKS + absentLines,
    );
  });

  it('HUNKS_BLOCK_TEXT_OVERHEAD: a shown overlap block adds exactly its markers plus the constant', () => {
    const h: ConflictHunk = { startLine: 3, endLine: 9, local: ['abc'], remote: ['de'] };
    const without = blocksAndEntry(oneFile({})).blocks.length;
    const withHunk = blocksAndEntry(oneFile({ hunks: [h] })).blocks.length;
    expect(withHunk - without).toBe(HUNKS_BLOCK_TEXT_OVERHEAD + renderHunkMarkers([h]).length);
  });

  it('FILE_JSON_OVERHEAD: an all-absent, hunkless entry is the scaffold + path + three nulls', () => {
    const { entry } = blocksAndEntry(oneFile({}));
    expect(entry.length).toBe(FILE_JSON_OVERHEAD + JSON.stringify(PATH).length + 3 * 'null'.length);
  });

  it('ELIDED_JSON_WRAPPER_OVERHEAD: the elided wrapper costs the constant plus key, value and comma per member', () => {
    const rep = oneFile({ base: 'b'.repeat(10), ours: 'o'.repeat(20), theirs: 't'.repeat(30) });
    const refs: ConflictRefs = { mergeBase: rep.mergeBase, rebasedOnto: rep.rebasedOnto };
    const planWith = (cut: Array<'base' | 'ours' | 'theirs'>): ConflictPayloadPlan => ({
      truncated: cut.length > 0,
      files: [
        {
          path: PATH,
          hunks: { included: true, chars: 0, count: 0, spans: [] },
          base: { included: !cut.includes('base'), chars: 10 },
          ours: { included: !cut.includes('ours'), chars: 20 },
          theirs: { included: !cut.includes('theirs'), chars: 30 },
        },
      ],
    });
    for (const cut of [['ours'], ['base', 'ours', 'theirs']] as Array<
      Array<'base' | 'ours' | 'theirs'>
    >) {
      const withCut = JSON.parse(blocksAndEntry(rep, planWith(cut)).entry) as Record<
        string,
        unknown
      >;
      const { elided, ...rest } = withCut;
      const members = cut.reduce(
        (n, k) =>
          n +
          JSON.stringify(k).length +
          1 +
          JSON.stringify({
            chars: rep.files[0]![k]!.length,
            ref: sideElisionHint(PATH, k, refs, false).json,
          }).length +
          1,
        0,
      );
      expect(elided).toBeDefined();
      expect(JSON.stringify(withCut).length - JSON.stringify(rest).length).toBe(
        ELIDED_JSON_WRAPPER_OVERHEAD + members,
      );
    }
  });
});

describe('plan/report mismatch is a guarded programming error, not a silent wrong render', () => {
  // Both renderers index `plan.files[i]` alongside `report.files[i]`; a plan built from a
  // DIFFERENT report (or hand-corrupted) must never silently render file i's content under
  // file j's budget decisions — it must throw, naming the index and both paths, so the mismatch
  // is caught immediately rather than surfacing as a subtly wrong (but not obviously broken)
  // conflict payload.
  function twoFileReport(): ConflictReport {
    const rep = report();
    const base = rep.files[0]!;
    const files: ConflictFileDetail[] = [
      { ...base, path: 'a.tex', hunks: [] },
      { ...base, path: 'b.tex', hunks: [] },
    ];
    return { ...rep, files, conflictPaths: files.map((f) => f.path) };
  }

  function planFrom(rep: ConflictReport): ConflictPayloadPlan {
    return planConflictPayload(rep.files, {
      detail: 'auto',
      refs: { mergeBase: rep.mergeBase, rebasedOnto: rep.rebasedOnto },
    });
  }

  it("renderConflictText throws when the plan's second entry names a different path than the report's", () => {
    const rep = twoFileReport();
    const plan = planFrom(rep);
    const mismatched: ConflictPayloadPlan = {
      ...plan,
      files: [plan.files[0]!, { ...plan.files[1]!, path: 'not-b.tex' }],
    };
    expect(() => renderConflictText('conflict', rep, { plan: mismatched })).toThrow(/index 1/);
    expect(() => renderConflictText('conflict', rep, { plan: mismatched })).toThrow(/not-b\.tex/);
    expect(() => renderConflictText('conflict', rep, { plan: mismatched })).toThrow(/"b\.tex"/);
  });

  it("buildConflictFilePayload throws when the plan's second entry names a different path than the report's", () => {
    const rep = twoFileReport();
    const plan = planFrom(rep);
    const mismatched: ConflictPayloadPlan = {
      ...plan,
      files: [plan.files[0]!, { ...plan.files[1]!, path: 'not-b.tex' }],
    };
    expect(() => buildConflictFilePayload(rep, mismatched)).toThrow(/index 1/);
    expect(() => buildConflictFilePayload(rep, mismatched)).toThrow(/not-b\.tex/);
    expect(() => buildConflictFilePayload(rep, mismatched)).toThrow(/"b\.tex"/);
  });

  it('a plan built by planConflictPayload from the SAME report never throws (happy path)', () => {
    const rep = twoFileReport();
    const plan = planFrom(rep);
    expect(() => renderConflictText('conflict', rep, { plan })).not.toThrow();
    expect(() => buildConflictFilePayload(rep, plan)).not.toThrow();
  });
});

describe('renderConflictText accepts a precomputed plan (opts.plan) instead of re-planning', () => {
  it('a passed plan wins over opts.detail — proves the plan is used verbatim, not re-derived', () => {
    const huge = 'x'.repeat(20000);
    const base = report();
    const rep: ConflictReport = {
      ...base,
      files: [{ ...base.files[0]!, theirs: huge, base: huge }],
    };
    // Build an 'auto' plan (elides the oversized theirs/base) but pass `detail: 'full'` in opts
    // too — if the plan were being used verbatim, `detail: 'full'` must NOT restore the elided
    // content, because no re-planning happens when opts.plan is given.
    const autoPlan = planConflictPayload(rep.files, {
      detail: 'auto',
      refs: { mergeBase: rep.mergeBase, rebasedOnto: rep.rebasedOnto },
    });
    const text = renderConflictText('conflict', rep, { detail: 'full', plan: autoPlan });
    expect(text).not.toContain(huge);
    expect(text).toContain('read_file("sections/04.tex", ref="origin/master")');
  });

  it('with no plan given, behaviour is unchanged from today (existing tests already cover this)', () => {
    const text = renderConflictText('Rebase conflicts in 1 file(s).', report());
    expect(text).toContain('sections/04.tex');
    expect(text).toContain('<<<<<<< ours');
  });
});

describe('capRemoteCommits (structured-channel commit cap, issue #68 follow-up)', () => {
  function commit(hash: string, message: string, fileCount = 0): RemoteCommit {
    return {
      hash,
      message,
      files: Array.from({ length: fileCount }, (_, i) => ({
        path: `f${i}.tex`,
        added: 1,
        removed: 0,
      })),
    };
  }

  it('caps at CONFLICT_MAX_COMMITS, and each commit at CONFLICT_MAX_COMMIT_FILES files', () => {
    const commits = Array.from({ length: 25 }, (_, i) =>
      i === 0 ? commit(`h${i}`, `commit ${i}`, 8) : commit(`h${i}`, `commit ${i}`, 1),
    );
    const { commits: capped, omitted } = capRemoteCommits(commits);

    expect(capped).toHaveLength(CONFLICT_MAX_COMMITS);
    expect(omitted).toBe(25 - CONFLICT_MAX_COMMITS);

    const first = capped[0]!;
    expect(first.files).toHaveLength(CONFLICT_MAX_COMMIT_FILES);
    expect(first.filesOmitted).toBe(8 - CONFLICT_MAX_COMMIT_FILES);

    // Every other capped commit touched only 1 file — well under the per-commit cap — and must
    // carry NO filesOmitted key at all (not even 0), the same "absent means untouched" convention
    // the conflict-file elision payload uses.
    for (const c of capped.slice(1)) {
      expect(c.files).toHaveLength(1);
      expect('filesOmitted' in c).toBe(false);
    }
  });

  it('does not mutate the input commits or their file arrays', () => {
    const commits = [commit('h0', 'c0', 8)];
    const originalFiles = commits[0]!.files;
    capRemoteCommits(commits);
    expect(commits[0]!.files).toBe(originalFiles);
    expect(commits[0]!.files).toHaveLength(8);
  });

  it('omitted is 0 and every commit passes through untouched when nothing exceeds either cap', () => {
    const commits = [commit('h0', 'c0', 1), commit('h1', 'c1', 2)];
    const { commits: capped, omitted } = capRemoteCommits(commits);
    expect(omitted).toBe(0);
    expect(capped).toEqual(commits);
  });
});

describe('conflict text points at status.behindCommits, not structuredContent, past the commit cap', () => {
  it('report with 25 remoteCommits: "… 5 more commit(s)" + the status hint, never "see structuredContent"', () => {
    const commits: RemoteCommit[] = Array.from({ length: 25 }, (_, i) => ({
      hash: `h${i}`,
      message: `commit ${i}`,
      files: [],
    }));
    const rep = report({ remoteCommits: commits });
    const text = renderConflictText('conflict', rep);

    expect(text).toContain('… 5 more commit(s)');
    expect(text).toContain(
      '(see status.behindCommits — the clone is back at its pre-push state, so status lists them all)',
    );
    expect(text).not.toContain('see structuredContent');
  });

  it('renderRebasedOver with 25 commits still says "(see structuredContent)" (unchanged)', () => {
    const commits: RemoteCommit[] = Array.from({ length: 25 }, (_, i) => ({
      hash: `h${i}`,
      message: `commit ${i}`,
      files: [],
    }));
    const text = renderRebasedOver(commits);
    expect(text).toContain('… 5 more commit(s) (see structuredContent)');
  });

  it(
    'detail: "full" flips the pointer to "(see structuredContent)": under "full" that field ' +
      'genuinely holds every commit, so the status.behindCommits hint (which exists only because ' +
      "auto's structuredContent.remoteCommits is itself capped) is the misleading one there",
    () => {
      const commits: RemoteCommit[] = Array.from({ length: 25 }, (_, i) => ({
        hash: `h${i}`,
        message: `commit ${i}`,
        files: [],
      }));
      const rep = report({ remoteCommits: commits });
      const plan = planConflictPayload(rep.files, {
        detail: 'full',
        refs: { mergeBase: rep.mergeBase, rebasedOnto: rep.rebasedOnto },
      });
      const text = renderConflictText('conflict', rep, { detail: 'full', plan });

      expect(text).toContain('… 5 more commit(s)');
      expect(text).toContain('(see structuredContent)');
      expect(text).not.toContain('status.behindCommits');
    },
  );
});

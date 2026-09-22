import { describe, it, expect } from 'vitest';
import {
  FILE_LIST_CONTENT_BUDGET,
  FILE_LIST_NOTE_RESERVE,
  FILE_LIST_STRUCTURED_SCAFFOLD_OVERHEAD,
  TYPE_PRIORITY,
  buildFileListNote,
  entryCost,
  planFileList,
  renderCost,
  renderFileLine,
  renderFileListText,
  type FileListPlan,
} from '../../src/lib/fileListBudget.js';
import type { FileEntry } from '../../src/services/fileService.js';

/**
 * `list_files` had no bound of any kind (#164) and rendered the listing twice — once as
 * `structuredContent.files`, once as a text line per entry. These pin the planner that bounds it.
 *
 * The central assertion is deliberately made against the bytes the tool actually sends
 * (`JSON.stringify` of the plan PLUS `renderFileListText` of it), not against a per-entry constant:
 * both channels ship in the same result, so a budget that counts the listing once is wrong by 2x,
 * which is the second-round lesson of #68.
 */

/** What the tool sends, in both channels, for a given plan. */
function renderedSize(plan: FileListPlan): number {
  return JSON.stringify({ ...plan }).length + renderFileListText(plan).length;
}

function entries(specs: Array<[path: string, type: FileEntry['type']]>): FileEntry[] {
  return specs.map(([path, type], i) => ({ path, type, sizeBytes: 1000 + i }));
}

/** A deep `figures/` tree: the ordinary shape that blows the listing up. */
function assetTree(n: number): FileEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    path: `assets/experiments/ablation-${String(i).padStart(4, '0')}/seed-${i % 7}/curve-precision-recall.pdf`,
    type: 'asset' as const,
    sizeBytes: 123456,
  }));
}

/** The paths the walk produces are path-sorted; keep the fixtures that way too. */
function sorted(list: FileEntry[]): FileEntry[] {
  return [...list].sort((a, b) => a.path.localeCompare(b.path));
}

describe('planFileList: the budget is charged against what both channels render', () => {
  it('keeps a whole result inside the budget for a tree that is far over it', () => {
    const plan = planFileList(sorted([...assetTree(4000), ...entries([['main.tex', 'tex']])]));

    expect(renderedSize(plan)).toBeLessThanOrEqual(FILE_LIST_CONTENT_BUDGET);
    // Not vacuous: the budget must actually be *used*, or "bounded" would be satisfied by
    // returning almost nothing. Half the budget is the floor this asserts against.
    expect(renderedSize(plan)).toBeGreaterThan(FILE_LIST_CONTENT_BUDGET / 2);
    expect(plan.totalFiles).toBe(4001);
    expect(plan.omittedBySize).toBeGreaterThan(3000);
    expect(plan.note).toBeDefined();
  });

  it('charges each entry at least what that entry really costs in both channels', () => {
    const list = sorted([
      ...assetTree(12),
      ...entries([
        ['main.tex', 'tex'],
        ['refs.bib', 'bib'],
        // A path with characters JSON has to escape: a raw-length charge under-counts these.
        ['sections/"quoted"\\odd.tex', 'tex'],
      ]),
    ]);
    const plan = planFileList(list);
    expect(plan.files).toHaveLength(list.length);

    const charged = list.reduce((n, e) => n + entryCost(e), 0) + 2;
    const rendered =
      JSON.stringify(plan.files).length + plan.files.map(renderFileLine).join('\n').length;
    expect(charged).toBeGreaterThanOrEqual(rendered);
  });

  it('pins the JSON scaffolding constant against a real cut result', () => {
    const plan = planFileList(sorted([...assetTree(4000), ...entries([['main.tex', 'tex']])]));
    const scaffold =
      JSON.stringify({ ...plan }).length -
      JSON.stringify(plan.files).length -
      JSON.stringify(plan.note).length;
    expect(scaffold).toBeGreaterThan(0);
    expect(scaffold).toBeLessThanOrEqual(FILE_LIST_STRUCTURED_SCAFFOLD_OVERHEAD);
  });

  it('pins the note reserve against the worst note this module can produce', () => {
    const maxed: FileListPlan = {
      files: [],
      totalFiles: 9_999_999,
      omittedByCap: 9_999_999,
      omittedBySize: 9_999_999,
      omittedByType: {
        tex: 9_999_999,
        bib: 9_999_999,
        doc: 9_999_999,
        other: 9_999_999,
        asset: 9_999_999,
      },
    };
    // All three causes: the cap, the plain budget, and the oversized-first message (the longest).
    const notes = [
      buildFileListNote(maxed, { budget: 9_999_999, maxResults: 9_999_999, oversizedFirst: 0 }),
      buildFileListNote({ ...maxed, omittedByCap: 0 }, { budget: 9_999_999, oversizedFirst: 0 }),
      buildFileListNote(
        { ...maxed, omittedByCap: 0 },
        { budget: 9_999_999, oversizedFirst: 9_999_999 },
      ),
    ];
    for (const note of notes) expect(renderCost(note)).toBeLessThanOrEqual(FILE_LIST_NOTE_RESERVE);
  });
});

describe('planFileList: an uncut listing is unchanged', () => {
  const small = sorted(
    entries([
      ['main.tex', 'tex'],
      ['refs.bib', 'bib'],
      ['README.md', 'doc'],
      ['figures/overview.pdf', 'asset'],
      ['Makefile', 'other'],
      ['sections/intro.tex', 'tex'],
    ]),
  );

  it('returns every entry, in the order given, with no note and no per-type tally', () => {
    const plan = planFileList(small);
    expect(plan.files).toEqual(small);
    expect(plan.totalFiles).toBe(small.length);
    expect(plan.omittedByCap).toBe(0);
    expect(plan.omittedBySize).toBe(0);
    expect(plan.omittedByType).toBeUndefined();
    expect(plan.note).toBeUndefined();
  });

  it('renders byte-identically to the pre-budget text channel', () => {
    // The formula `src/tools/listFiles.ts` used before #164, verbatim.
    const before = small.map((f) => `${f.path} (${f.type}, ${f.sizeBytes}B)`).join('\n');
    expect(renderFileListText(planFileList(small))).toBe(before);
  });

  it('keeps `No matching files.` for a genuinely empty listing, with no note', () => {
    const plan = planFileList([]);
    expect(plan.files).toEqual([]);
    expect(plan.totalFiles).toBe(0);
    expect(plan.note).toBeUndefined();
    expect(renderFileListText(plan)).toBe('No matching files.');
  });
});

describe('planFileList: which entries survive a cut', () => {
  const sources = entries([
    ['zz-main.tex', 'tex'],
    ['zz-sections/intro.tex', 'tex'],
    ['zz-sections/method.tex', 'tex'],
    ['zz-refs.bib', 'bib'],
    ['zz-NOTES.md', 'doc'],
    ['zz-conference.sty', 'other'],
  ]);

  it('keeps the .tex sources an alphabetically earlier assets/ tree would have starved', () => {
    const list = sorted([...assetTree(4000), ...sources]);
    // The defect this guards: walk order is path order, so every `assets/…` entry precedes every
    // `zz-…` one. A budget spent in walk order returns 200 PDFs and not one source file.
    expect(list.slice(0, 100).every((e) => e.type === 'asset')).toBe(true);

    const plan = planFileList(list);
    const kept = new Set(plan.files.map((f) => f.path));
    for (const source of sources) expect(kept.has(source.path)).toBe(true);
    expect(plan.omittedByType).toMatchObject({ tex: 0, bib: 0, doc: 0, other: 0 });
    expect(plan.omittedByType!.asset).toBeGreaterThan(3000);
  });

  it('emits the kept entries in the original path order, never in priority order', () => {
    const plan = planFileList(sorted([...assetTree(4000), ...sources]));
    const paths = plan.files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
    // And an asset does appear before the sources, i.e. the order really was restored.
    expect(paths[0]!.startsWith('assets/')).toBe(true);
  });

  it('is strict: nothing lower-priority slips in behind a rank the budget already cut', () => {
    // Enough `.tex` to exhaust the budget on rank 1 alone, plus one cheap `.bib` behind it.
    const texs = Array.from({ length: 2000 }, (_, i) => ({
      path: `sections/chapter-${String(i).padStart(4, '0')}/subsection-long-name.tex`,
      type: 'tex' as const,
      sizeBytes: 4096,
    }));
    const plan = planFileList(sorted([...texs, ...entries([['a.bib', 'bib']])]));

    expect(plan.omittedByType!.tex).toBeGreaterThan(0);
    expect(plan.files.some((f) => f.type === 'bib')).toBe(false);
    expect(plan.omittedByType!.bib).toBe(1);
  });

  it('ranks in the declared order and puts an unknown type last', () => {
    expect(TYPE_PRIORITY).toEqual(['tex', 'bib', 'doc', 'other', 'asset']);
    const odd = { path: 'x.weird', type: 'sideways' as FileEntry['type'], sizeBytes: 1 };
    const plan = planFileList([odd, ...entries([['main.tex', 'tex']])], { maxResults: 1 });
    expect(plan.files.map((f) => f.path)).toEqual(['main.tex']);
  });
});

describe('planFileList: a cut is never confusable with an empty project', () => {
  it('returns the first entry even when it alone exceeds the whole budget', () => {
    const list = entries([
      ['main.tex', 'tex'],
      ['refs.bib', 'bib'],
      ['figures/a.pdf', 'asset'],
    ]);
    const plan = planFileList(list, { budget: 1 });

    // `files: []` must keep meaning "nothing matched"; the budget may never forge it.
    expect(plan.files).toEqual([list[0]]);
    expect(plan.omittedBySize).toBe(2);
    expect(plan.note).toContain('returned regardless');
    expect(plan.files.length).toBeLessThan(plan.totalFiles);
  });

  it('marks every cut with a non-zero counter and a note', () => {
    const plan = planFileList(assetTree(4000));
    expect(plan.files.length).toBeGreaterThan(0);
    expect(plan.omittedByCap + plan.omittedBySize).toBe(plan.totalFiles - plan.files.length);
    expect(plan.note).toBeDefined();
  });
});

describe('planFileList: maxResults', () => {
  it('narrows by count, counts the cut apart from the budget, and names only that bound', () => {
    const list = sorted(assetTree(50));
    const plan = planFileList(list, { maxResults: 5 });

    expect(plan.files).toHaveLength(5);
    expect(plan.omittedByCap).toBe(45);
    expect(plan.omittedBySize).toBe(0);
    expect(plan.note).toContain('maxResults is 5');
    expect(plan.note).not.toContain('payload budget');
  });

  it('applies the priority order too, so a cap never starves the sources', () => {
    const plan = planFileList(sorted([...assetTree(50), ...entries([['zz.tex', 'tex']])]), {
      maxResults: 2,
    });
    expect(plan.files.map((f) => f.type)).toContain('tex');
  });

  it('is absent by default: only the character budget bounds the listing', () => {
    const plan = planFileList(sorted(assetTree(50)));
    expect(plan.files).toHaveLength(50);
    expect(plan.omittedByCap).toBe(0);
  });
});

describe('the note', () => {
  it('names the remedy that actually exists, unlike most of this family', () => {
    const plan = planFileList(assetTree(4000));
    expect(plan.note).toContain('subdir');
    expect(plan.note).toContain('filter');
    expect(plan.note).toContain('tex, bib, doc, other, asset');
    expect(plan.note).toContain('omitted by type: asset');
  });

  it('is rendered into the text channel, appended to the already-cut listing', () => {
    const plan = planFileList(assetTree(4000));
    const text = renderFileListText(plan);
    expect(text.endsWith(plan.note!)).toBe(true);
    // Built from the CUT entries, never the full listing.
    expect(text.split('\n')).toHaveLength(plan.files.length + 1);
  });
});

import { describe, it, expect } from 'vitest';
import {
  EXTRACT_TEXT_CONTENT_BUDGET,
  PAGES_ARRAY_JSON_OVERHEAD,
  TEXT_BLOCK_SEPARATOR_OVERHEAD,
  planExtractedText,
  renderTextPageBlock,
  textLineCost,
  textPageSkeletonCost,
} from '../../src/lib/extractTextBudget.js';
import type { ExtractedTextPage, TextPageLike } from '../../src/lib/extractTextBudget.js';
import { CONFLICT_CONTENT_BUDGET } from '../../src/lib/conflictBudget.js';

/** What the page payload actually costs on the wire: every text block + its `\n`, and the JSON. */
function renderedSize(pages: ExtractedTextPage[]): number {
  let text = 0;
  for (const p of pages) text += renderTextPageBlock(p).length + TEXT_BLOCK_SEPARATOR_OVERHEAD;
  return text + JSON.stringify(pages).length;
}

const dense = (page: number, n: number, len = 120): TextPageLike => ({
  page,
  // Quote- and backslash-dense, so JSON escaping costs more than the raw text.
  lines: Array.from({ length: n }, (_, i) =>
    `${page}:${i} \\alpha "q" \\\\ ${'x'.repeat(len)}`.slice(0, len),
  ),
  linesOmitted: 0,
  charsOmitted: 0,
});

describe('EXTRACT_TEXT_CONTENT_BUDGET', () => {
  it('is the house figure, imported rather than restated', () => {
    expect(EXTRACT_TEXT_CONTENT_BUDGET).toBe(CONFLICT_CONTENT_BUDGET);
  });
});

describe('cost functions are pinned to the rendered payload from both sides', () => {
  it('a line costs exactly its text-block increment plus its JSON element', () => {
    for (const line of ['plain', '', 'a "quoted" \\cmd{x}', 'tab\there', '\u{1F600} emoji']) {
      const without: ExtractedTextPage = {
        page: 3,
        lines: ['a'],
        linesOmitted: 0,
        charsOmitted: 0,
      };
      const withLine: ExtractedTextPage = { ...without, lines: ['a', line] };
      const delta = renderedSize([withLine]) - renderedSize([without]);
      // Exact: every element after the first carries its comma, which the cost charges.
      expect(textLineCost(line)).toBe(delta);
    }
  });

  it('the plan charges an upper bound that is never loose by more than a small per-page slack', () => {
    const cases: TextPageLike[][] = [
      [dense(1, 200), dense(2, 200), dense(3, 200), dense(4, 200)],
      [dense(1, 5), dense(2, 5)],
      [dense(1, 400, 30)],
      [{ page: 7, lines: [], linesOmitted: 0, charsOmitted: 0 }],
      [{ page: 9, lines: ['x'.repeat(50)], linesOmitted: 12, charsOmitted: 99999 }],
    ];
    for (const pages of cases) {
      const plan = planExtractedText(pages);
      const rendered = renderedSize(plan.pages);
      // Never under-charged: what ships is at most what was charged, and within the budget.
      expect(rendered).toBeLessThanOrEqual(plan.charged);
      expect(rendered).toBeLessThanOrEqual(EXTRACT_TEXT_CONTENT_BUDGET);
      // Never padded into meaninglessness: the slack is the worst-case cut marker per page plus a
      // comma per array, nothing proportional to the content.
      expect(plan.charged - rendered).toBeLessThanOrEqual(120 * pages.length);
    }
  });

  it('the skeleton charge covers the page with every line cut', () => {
    const p = dense(12, 40);
    const allCut: ExtractedTextPage = {
      page: 12,
      lines: [],
      linesOmitted: 40,
      charsOmitted: p.lines.reduce((n, l) => n + l.length, 0),
    };
    expect(textPageSkeletonCost(p)).toBe(renderedSize([allCut]) - PAGES_ARRAY_JSON_OVERHEAD + 1);
  });
});

describe('planExtractedText', () => {
  it('guarantees every page a share when all four want more than the budget', () => {
    const pages = [dense(1, 300), dense(2, 300), dense(3, 300), dense(4, 300)];
    const plan = planExtractedText(pages);
    const kept = plan.pages.map((p) => p.lines.length);
    for (const k of kept) expect(k).toBeGreaterThan(0);
    // Equal lines of equal cost: the shares come out equal, bar what pass 2 hands page 1 from the
    // other lanes' leftovers — each lane leaves less than one line unspent, so at most 3 lines.
    expect(Math.max(...kept) - Math.min(...kept)).toBeLessThanOrEqual(pages.length - 1);
    expect(plan.linesOmittedBySize).toBe(1200 - kept.reduce((a, b) => a + b, 0));
  });

  it('passes the surplus of small pages to the page that needs it', () => {
    const pages = [dense(1, 300), dense(2, 2), dense(3, 2), dense(4, 2)];
    const plan = planExtractedText(pages);
    const share = planExtractedText([dense(1, 300), dense(2, 300), dense(3, 300), dense(4, 300)])
      .pages[0]!.lines.length;
    // Far more than one equal share — nearly the whole budget.
    expect(plan.pages[0]!.lines.length).toBeGreaterThan(3 * share);
    for (const p of plan.pages.slice(1)) {
      expect(p.lines).toHaveLength(2);
      expect(p.linesOmitted).toBe(0);
    }
  });

  it('cuts a suffix and merges its counters with the extractor’s own', () => {
    const src = dense(5, 500);
    const serviceCut = { ...src, linesOmitted: 7, charsOmitted: 700 };
    const plan = planExtractedText([serviceCut]);
    const p = plan.pages[0]!;
    expect(p.lines).toEqual(src.lines.slice(0, p.lines.length));
    const cut = src.lines.slice(p.lines.length);
    expect(p.linesOmitted).toBe(7 + cut.length);
    expect(p.charsOmitted).toBe(700 + cut.reduce((n, l) => n + l.length, 0));
    expect(plan.linesOmittedBySize).toBe(cut.length);
  });

  it('never keeps a line after one that did not fit', () => {
    const plan = planExtractedText([
      {
        page: 1,
        lines: ['short', 'y'.repeat(30000), 'short again'],
        linesOmitted: 0,
        charsOmitted: 0,
      },
    ]);
    expect(plan.pages[0]!.lines).toEqual(['short']);
    expect(plan.pages[0]!.linesOmitted).toBe(2);
    expect(plan.pages[0]!.charsOmitted).toBe(30000 + 'short again'.length);
  });

  it('cuts nothing and writes no note when everything fits', () => {
    const pages = [dense(1, 10), dense(2, 10)];
    const plan = planExtractedText(pages);
    expect(plan.pages.map((p) => p.lines)).toEqual(pages.map((p) => p.lines));
    expect(plan.linesOmittedBySize).toBe(0);
    expect(plan.note).toBeUndefined();
  });

  it('keeps "all cut" distinguishable from "no text"', () => {
    const plan = planExtractedText(
      [
        { page: 1, lines: [], linesOmitted: 0, charsOmitted: 0 },
        { page: 2, lines: ['z'.repeat(40000)], linesOmitted: 0, charsOmitted: 0 },
      ],
      {},
    );
    expect(plan.pages[0]).toEqual({ page: 1, lines: [], linesOmitted: 0, charsOmitted: 0 });
    expect(plan.pages[1]).toEqual({ page: 2, lines: [], linesOmitted: 1, charsOmitted: 40000 });
  });
});

describe('the note names only the cut that fired', () => {
  it('blames the call budget alone when only it cut', () => {
    const note = planExtractedText([dense(1, 400)]).note!;
    expect(note).toContain(`${EXTRACT_TEXT_CONTENT_BUDGET}-character text budget`);
    expect(note).not.toContain("extractor's own cut");
    // One page: "ask for fewer pages" would be advice that cannot help.
    expect(note).not.toContain('fewer pages');
  });

  it('blames a cut the extractor reported alone when only it cut', () => {
    // Today's service cuts nothing (PB3), but the counters stay in its shape and are merged, so a
    // cut it did report must be named for what it is rather than blamed on this budget.
    const note = planExtractedText([
      { page: 2, lines: ['fits'], linesOmitted: 1, charsOmitted: 30000 },
    ]).note!;
    expect(note).toContain("the PDF extractor's own cut: 1 line(s)");
    expect(note).not.toContain('text budget');
    expect(note).toContain('page 2 (1 line(s), 30000 chars)');
  });

  it('suggests fewer pages when more than one was asked for', () => {
    const note = planExtractedText([dense(1, 400), dense(2, 400)]).note!;
    expect(note).toContain('fewer pages');
  });
});

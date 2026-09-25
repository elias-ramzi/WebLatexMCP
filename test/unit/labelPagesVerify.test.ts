import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  planLabelPages,
  labelRefusalMessage,
  labelResolutionNote,
  resolveLabelPages,
  pdfLabelPageReader,
  pagesToVerify,
  readFolios,
  MAX_AMBIGUOUS_CANDIDATES,
} from '../../src/lib/labelPages.js';
import type { LabelPageEvidence, LabelPageReader } from '../../src/lib/labelPages.js';
import { isBeamerAux, parseAuxLabels, readAuxFloats } from '../../src/lib/auxFloats.js';
import type { AuxFloatsResult, AuxLabel } from '../../src/lib/auxFloats.js';
import { buildAuxPath, buildDir } from '../../src/services/compiler.js';
import type { TextRequest, TextResult } from '../../src/services/pdfRender.js';

/**
 * `[label, number, page]` — the three fields a `\newlabel{label}{{number}{page}}` carries. The
 * index is the ordinary case, `pgfpages: false`: a build whose `.log` was read and names no
 * pgfpages, so the label routes run (an index without the field is refused as
 * `'pgfpagesUnknown'`, see {@link withoutRecords}).
 */
function aux(entries: Array<[label: string, number: string, page: string]>): AuxFloatsResult {
  const floats: AuxLabel[] = entries.map(([label, number, page]) => ({ label, number, page }));
  return { floats, omitted: 0, total: floats.length, dropped: 0, pgfpages: false };
}

/** `index` as the reader hands it over when neither the build's `.fls` nor its `.log` could be
 *  read: `pgfpages` absent, nothing known about the layout. */
function withoutRecords(index: AuxFloatsResult): AuxFloatsResult {
  const copy = { ...index };
  delete copy.pgfpages;
  return copy;
}

function evidence(pageCount: number, text: Record<number, string[]>): LabelPageEvidence {
  return { pageCount, text: new Map(Object.entries(text).map(([p, l]) => [Number(p), l])) };
}

/**
 * The real text layer of a two-page pdflatex build of
 * `\documentclass{report}\title{T}\author{A}\begin{document}\maketitle\chapter{One}` + a figure
 * labelled `fig:a`, WITHOUT hyperref (so no /PageLabels): page 1 is the title page, and the
 * figure sits on PDF page 2, which prints page number "1". The `.aux` records
 * `\newlabel{fig:a}{{1.1}{1}}`. Captured through `PdfRenderer.text`.
 */
const REPORT_TEXT = {
  1: ['T', 'A', 'September 23, 2026'],
  2: ['Chapter 1', 'One', 'FIGURE-BODY', 'Figure 1.1: Cap', '1'],
};

/**
 * Real text layers (`PdfRenderer.text`, i.e. merged lines in drawing order) of five pdflatex
 * builds WITHOUT hyperref, so none carries /PageLabels. The sources sit beside the JSON:
 *  - `titlepageShifted` — `\documentclass[titlepage]{article}`: the title page is unnumbered and
 *    resets the counter, so PDF page p prints folio p-1. Its .aux records
 *    `\newlabel{fig:a}{{1}{2}}` and `\newlabel{fig:b}{{2}{3}}`, but the figures are on PDF pages 3
 *    and 4. Every body paragraph ends "Prior work [1, 2] reports 3 runs.", so single-digit tokens
 *    are on every page — which is what defeated the old "the page shows the label's number" check.
 *  - `unshifted` — the same body in a plain `article` (title on page 1): same .aux, and there the
 *    figures ARE on PDF pages 2 and 3.
 *  - `bookHeadings`, `articleOnesideHeadings`, `articleTwosideHeadings` — `\pagestyle{headings}`
 *    (book's default), whose folio is in the running head, not the footer. pdf.js splits the head
 *    at its glue: "2 CHAPTER 1. ONE" arrives as the three lines "2", "CHAPTER 1.", "ONE".
 */
type FolioFixture = Record<string, Record<string, string[]>>;
const FOLIO: FolioFixture = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/label-folio/pages.json'),
    'utf8',
  ),
) as FolioFixture;

function pagesOf(doc: string): LabelPageEvidence {
  const text = new Map(Object.entries(FOLIO[doc]!).map(([p, l]) => [Number(p), l]));
  return { pageCount: text.size, text };
}

function linesOf(doc: string, page: number): string[] {
  return FOLIO[doc]![String(page)]!;
}

describe('planLabelPages verifies the printed-page route against the page FOLIO', () => {
  it('refuses a [titlepage] article whose body is full of small numbers (real pdflatex text)', () => {
    // An earlier check ("the page shows the label's number") accepted both: "[1, 2]" and
    // "3 runs" put the label numbers "1" and "2" on every page, so PDF pages 2 and 3 "showed"
    // them — one page before the real figures.
    const index = aux([
      ['fig:a', '1', '2'],
      ['fig:b', '2', '3'],
    ]);
    const plan = planLabelPages(['fig:a', 'fig:b'], index, null, pagesOf('titlepageShifted'));
    expect(plan.resolved).toEqual([]);
    expect(plan.pages).toEqual([]);
    expect(plan.failed).toEqual([
      {
        label: 'fig:a',
        reason: 'unverifiedPage',
        printedPage: '2',
        number: '1',
        unverified: 'folioMismatch',
        folios: ['1'],
      },
      {
        label: 'fig:b',
        reason: 'unverifiedPage',
        printedPage: '3',
        number: '2',
        unverified: 'folioMismatch',
        folios: ['2'],
      },
    ]);
    const msg = labelRefusalMessage(plan, index);
    // "Reads as", not "prints": the number read may be a section mark rather than the folio.
    expect(msg).toContain('PDF page 2 reads as page number "1", not "2"');
    expect(msg).not.toMatch(/shifted against/);
    expect(msg).toContain('hyperref');
  });

  it('resolves the same body, unshifted, to the pages the figures are really on', () => {
    // The value just outside the refusal above: same .aux, same body, no title-page shift.
    const index = aux([
      ['fig:a', '1', '2'],
      ['fig:b', '2', '3'],
    ]);
    const plan = planLabelPages(['fig:a', 'fig:b'], index, null, pagesOf('unshifted'));
    expect(plan.failed).toEqual([]);
    expect(plan.resolved).toEqual([
      { label: 'fig:a', printedPage: '2', page: 2 },
      { label: 'fig:b', printedPage: '3', page: 3 },
    ]);
    expect(linesOf('unshifted', 2)[0]).toBe('Figure 1: First');
    expect(linesOf('unshifted', 3)[0]).toBe('Figure 2: Second');
    expect(plan.labelSource).toBe('printedPage');
  });

  it('refuses the title page itself: it carries no folio at all', () => {
    const plan = planLabelPages(
      ['sec:x'],
      aux([['sec:x', '1', '1']]),
      null,
      pagesOf('titlepageShifted'),
    );
    expect(plan.failed).toEqual([
      {
        label: 'sec:x',
        reason: 'unverifiedPage',
        printedPage: '1',
        number: '1',
        unverified: 'noFolio',
      },
    ]);
    expect(labelRefusalMessage(plan, aux([['sec:x', '1', '1']]))).toMatch(/no page number/);
  });

  it('accepts a running-head folio on both sides of a twoside book', () => {
    // Odd page 3 heads "1.1." "SEC" "3" (folio last); even page 4 heads "4" "CHAPTER 1." "ONE"
    // (folio first). tab:x's number is on no page: the folio settles the index, not the number.
    const plan = planLabelPages(
      ['fig:a', 'tab:x'],
      aux([
        ['fig:a', '1.1', '3'],
        ['tab:x', '9.9', '4'],
      ]),
      null,
      pagesOf('bookHeadings'),
    );
    expect(plan.failed).toEqual([]);
    expect(plan.pages).toEqual([3, 4]);
  });

  it('accepts a twoside article head whose mark carries a bare section number after the folio', () => {
    // Even page 2 heads "2" "1" "INTRO": the "1" follows the folio, so it is the mark.
    const plan = planLabelPages(
      ['eq:x'],
      aux([['eq:x', '5', '2']]),
      null,
      pagesOf('articleTwosideHeadings'),
    );
    expect(plan.failed).toEqual([]);
    expect(plan.pages).toEqual([2]);
  });

  it('refuses a head that reads two ways: a oneside "1 INTRO 3" is folio 1 or folio 3', () => {
    // Section number first, folio last, and nothing in the text layer says which is which —
    // an even-page head followed by a body line "3" looks identical. Refused, not guessed.
    const plan = planLabelPages(
      ['fig:a'],
      aux([['fig:a', '1', '3']]),
      null,
      pagesOf('articleOnesideHeadings'),
    );
    expect(plan.failed[0]).toMatchObject({
      reason: 'unverifiedPage',
      unverified: 'ambiguousFolio',
      folios: ['1', '3'],
    });
  });

  it('refuses a head folio that does not match (a shifted book)', () => {
    const plan = planLabelPages(['fig:a'], aux([['fig:a', '1.1', '3']]), null, {
      pageCount: 4,
      text: new Map([[3, linesOf('bookHeadings', 4)]]),
    });
    expect(plan.failed[0]).toMatchObject({ unverified: 'folioMismatch', folios: ['4'] });
  });

  it('refuses a report whose \\maketitle title page shifts every page, instead of rendering it', () => {
    const plan = planLabelPages(
      ['fig:a'],
      aux([['fig:a', '1.1', '1']]),
      null,
      evidence(2, REPORT_TEXT),
    );
    expect(plan.resolved).toEqual([]);
    expect(plan.failed).toEqual([
      {
        label: 'fig:a',
        reason: 'unverifiedPage',
        printedPage: '1',
        number: '1.1',
        unverified: 'noFolio',
      },
    ]);
  });

  it('resolves a label with no digit in its number once the folio confirms the page', () => {
    // An enumerate item ("a") or an appendix ("A"): nothing to search for, and nothing needed —
    // the folio is what proves the page index.
    const plan = planLabelPages(
      ['item:a', 'app:a'],
      aux([
        ['item:a', 'a', '1'],
        ['app:a', 'A', '2'],
      ]),
      null,
      evidence(2, { 1: ['First here.', '1'], 2: ['Appendix A', 'text', '2'] }),
    );
    expect(plan.failed).toEqual([]);
    expect(plan.pages).toEqual([1, 2]);
  });

  it('refuses when no page text was supplied at all', () => {
    const plan = planLabelPages(['fig:a'], aux([['fig:a', '1', '1']]), null);
    expect(plan.failed[0]).toMatchObject({ reason: 'unverifiedPage', unverified: 'noEvidence' });
  });

  it('refuses a printed page past the end of the PDF without claiming it knows why', () => {
    const plan = planLabelPages(
      ['tab:results'],
      aux([['tab:results', '1', '9']]),
      null,
      evidence(3, {}),
    );
    expect(plan.failed[0]).toMatchObject({ reason: 'unverifiedPage', unverified: 'pastEndOfPdf' });
    const msg = labelRefusalMessage(plan, aux([['tab:results', '1', '9']]));
    expect(msg).toContain('3 page(s)');
    expect(msg).toMatch(/stale/);
    expect(msg).toMatch(/setcounter/);
  });

  it('explains the refusal: no /PageLabels, hyperref, and how to find the page yourself', () => {
    const index = aux([['fig:a', '1.1', '1']]);
    const plan = planLabelPages(['fig:a'], index, null, evidence(2, REPORT_TEXT));
    const msg = labelRefusalMessage(plan, index);
    expect(msg).toContain('fig:a');
    expect(msg).toContain('"1.1"');
    expect(msg).toContain('/PageLabels');
    expect(msg).toContain('hyperref');
    expect(msg).toContain('extract_text');
    expect(msg).toContain('pages:');
  });

  it('leaves the /PageLabels route alone: no text is needed or consulted there', () => {
    const plan = planLabelPages(['fig:a'], aux([['fig:a', '1.1', '1']]), ['', '1']);
    expect(plan.failed).toEqual([]);
    expect(plan.resolved).toEqual([{ label: 'fig:a', printedPage: '1', page: 2 }]);
  });

  it('says the printed-page route was checked against the page folio in its note', () => {
    const plan = planLabelPages(
      ['fig:a'],
      aux([['fig:a', '1', '2']]),
      null,
      evidence(3, { 1: ['body', '1'], 2: ['Figure 1: Cap', '2'], 3: ['body', '3'] }),
    );
    const note = labelResolutionNote(plan);
    expect(note).toContain('no /PageLabels tree');
    expect(note).toMatch(/folio/);
    expect(note).not.toMatch(/show the label's number/);
    expect(note).toMatch(/neighbouring page/);
  });
});

/**
 * The PDF page a label's float is really on, read off the fixture: each forged document marks
 * every float body with `MK` + the label's alphanumerics, so the truth comes from the same real
 * text layer the check reads, not from a hand-written expectation.
 */
function truthPage(doc: string, label: string): number | undefined {
  const mark = 'MK' + label.replace(/[^A-Za-z0-9]/g, '');
  const hit = Object.entries(FOLIO[doc]!).find(([, lines]) => lines.some((l) => l.includes(mark)));
  return hit ? Number(hit[0]) : undefined;
}

describe('planLabelPages believes a folio only when a neighbouring page corroborates it', () => {
  // Each of these is a real pdflatex build (sources beside pages.json) that an earlier version,
  // one that believed a single page's folio, resolved to the WRONG page: the folio it read was
  // not the folio.
  it('refuses a fancyhdr "Page N" foot whose head carries the section number (titlepage)', () => {
    // `\cfoot{Page \thepage}` is not a bare number, so an earlier version read the head instead
    // — and the head is `\rightmark`, the SECTION number: PDF page 4 heads "4" "SEC4" (section 4
    // started on printed page 3) while fig:s4 (printed page 4) is really on PDF page 5. The
    // neighbour check alone would refuse it, since no neighbour corroborates the forged "4"; but
    // the "Page N" foot is now read as what it is, the folio, so PDF page 4 reads as the page
    // number it prints: 3.
    const fig4 = aux([['fig:s4', '4', '4']]);
    const plan = planLabelPages(['fig:s4'], fig4, null, pagesOf('fancyPageFoot'));
    expect(truthPage('fancyPageFoot', 'fig:s4')).toBe(5);
    expect(linesOf('fancyPageFoot', 4).at(-1)).toBe('Page 3');
    expect(plan.resolved).toEqual([]);
    expect(plan.failed).toEqual([
      {
        label: 'fig:s4',
        reason: 'unverifiedPage',
        printedPage: '4',
        number: '4',
        unverified: 'folioMismatch',
        folios: ['3'],
      },
    ]);
    const msg = labelRefusalMessage(plan, fig4);
    expect(msg).toContain('PDF page 4 reads as page number "3", not "4"');
    expect(msg).toMatch(/section/);
  });

  it('never resolves any label of that document to a page its float is not on', () => {
    for (let s = 1; s <= 8; s++) {
      const label = `fig:s${s}`;
      const plan = planLabelPages(
        [label],
        aux([[label, String(s), String(s)]]),
        null,
        pagesOf('fancyPageFoot'),
      );
      for (const r of plan.resolved) expect(r.page).toBe(truthPage('fancyPageFoot', label));
    }
  });

  it('refuses a [b] table whose bottom cell "2" reads as the foot under \\pagestyle{headings}', () => {
    // PDF page 2's last line is the table's "2"; its real folio is the head's "1". fig:a is on
    // PDF page 3, and page 3's head reads "1" "ONE" "2" — it cannot corroborate page 2 as "2".
    const index = aux([
      ['tab:x', '1', '1'],
      ['fig:a', '1', '2'],
    ]);
    const plan = planLabelPages(['fig:a'], index, null, pagesOf('tableBottomHeadings'));
    expect(truthPage('tableBottomHeadings', 'fig:a')).toBe(3);
    expect(plan.resolved).toEqual([]);
    expect(plan.failed[0]).toMatchObject({
      reason: 'unverifiedPage',
      unverified: 'uncorroboratedFolio',
      folios: ['2'],
    });
  });

  it('refuses an eso-pic foreground mark drawn after the foot, which hides the bare folio', () => {
    // Every page ends "CONFIDENTIAL", so the head was read, and PDF page 3 opens with the section
    // heading "3" "Three". fig:a (printed page 3) is really on PDF page 4.
    const plan = planLabelPages(
      ['fig:a'],
      aux([['fig:a', '1', '3']]),
      null,
      pagesOf('esopicForeground'),
    );
    expect(truthPage('esopicForeground', 'fig:a')).toBe(4);
    expect(plan.resolved).toEqual([]);
    expect(plan.failed[0]).toMatchObject({
      unverified: 'uncorroboratedFolio',
      folios: ['3'],
      neighbours: [
        { page: 2, folios: ['1'] },
        { page: 4, folios: [] },
      ],
    });
  });

  it('accepts the first page on its successor alone, and the last page on its predecessor', () => {
    const text = { 1: ['body', '1'], 2: ['body', '2'], 3: ['body', '3'] };
    const first = planLabelPages(['a'], aux([['a', '1', '1']]), null, evidence(3, text));
    expect(first.pages).toEqual([1]);
    const last = planLabelPages(['c'], aux([['c', '1', '3']]), null, evidence(3, text));
    expect(last.pages).toEqual([3]);
  });

  it('refuses when neither neighbour reads the adjacent number, and a roman one never does', () => {
    const plan = planLabelPages(
      ['a'],
      aux([['a', '1', '2']]),
      null,
      evidence(3, { 1: ['front', 'i'], 2: ['body', '2'], 3: ['end'] }),
    );
    expect(plan.failed[0]).toMatchObject({
      unverified: 'uncorroboratedFolio',
      neighbours: [
        { page: 1, folios: ['i'] },
        { page: 3, folios: [] },
      ],
    });
  });

  it('refuses a neighbour whose text could not be read, saying so', () => {
    const plan = planLabelPages(
      ['a'],
      aux([['a', '1', '2']]),
      null,
      evidence(3, { 2: ['body', '2'] }),
    );
    expect(plan.failed[0]).toMatchObject({
      unverified: 'uncorroboratedFolio',
      neighbours: [
        { page: 1, folios: null },
        { page: 3, folios: null },
      ],
    });
    expect(labelRefusalMessage(plan, aux([['a', '1', '2']]))).toContain(
      'PDF page 1 could not be read',
    );
  });

  it('lets a chapter opener’s foot folio be corroborated by the running head after it', () => {
    // Deliberately NOT same-kind: book page 1 reads its `plain` foot "1", page 2 its head "2".
    // Requiring one kind would refuse every label on a chapter-opening page.
    const plan = planLabelPages(
      ['chap:one'],
      aux([['chap:one', '1', '1']]),
      null,
      pagesOf('bookHeadings'),
    );
    expect(linesOf('bookHeadings', 1).at(-1)).toBe('1');
    expect(linesOf('bookHeadings', 2)[0]).toBe('2');
    expect(plan.pages).toEqual([1]);
  });

  it('needs no neighbour in a one-page PDF: page 1 is the only page there is', () => {
    const plan = planLabelPages(
      ['a'],
      aux([['a', '1', '1']]),
      null,
      evidence(1, { 1: ['body', '1'] }),
    );
    expect(plan.pages).toEqual([1]);
  });
});

describe('readFolios', () => {
  it('reads the footer folio first, and only it, when the last line is a bare page number', () => {
    // Page 2 opens with the section number "1" on its own line; the footer "1" decides.
    expect(readFolios(linesOf('titlepageShifted', 2))).toEqual(['1']);
    expect(readFolios(linesOf('titlepageShifted', 3))).toEqual(['2']);
    expect(readFolios(linesOf('unshifted', 3))).toEqual(['3']);
    expect(readFolios(linesOf('bookHeadings', 1))).toEqual(['1']);
  });

  it('finds no folio on a title page', () => {
    expect(readFolios(linesOf('titlepageShifted', 1))).toEqual([]);
    expect(readFolios([])).toEqual([]);
  });

  it('reads a head folio at either edge of the head, and both readings when they differ', () => {
    expect(readFolios(linesOf('bookHeadings', 2))).toEqual(['2']);
    expect(readFolios(linesOf('bookHeadings', 3))).toEqual(['3']);
    expect(readFolios(linesOf('articleTwosideHeadings', 2))).toEqual(['2']);
    expect(readFolios(linesOf('articleTwosideHeadings', 3))).toEqual(['3']);
    expect(readFolios(linesOf('articleOnesideHeadings', 1))).toEqual(['1']);
    expect(readFolios(linesOf('articleOnesideHeadings', 3))).toEqual(['1', '3']);
  });

  it('never takes a number inside a line, nor a dotted section number, for a folio', () => {
    expect(readFolios(['Prior work [1, 2] reports 3 runs.', 'Figure 2: Cap', 'x 3'])).toEqual([]);
    expect(readFolios(['1.1.', 'SEC', 'body'])).toEqual([]);
  });
});

describe('planLabelPages refuses a multiply-defined label', () => {
  it('names every printed page rather than resolving to the first record', () => {
    // LaTeX's \@newl@bel \global-defines each time, so \pageref prints the LAST record; the
    // first is not what a reader of the document sees.
    const plan = planLabelPages(
      ['x'],
      aux([
        ['x', '', '1'],
        ['x', '', '2'],
      ]),
      null,
      evidence(3, { 1: ['First here.'], 2: ['Second there.'] }),
    );
    expect(plan.resolved).toEqual([]);
    expect(plan.failed).toEqual([
      { label: 'x', reason: 'multiplyDefined', printedPages: ['1', '2'], printedPagesOmitted: 0 },
    ]);
  });

  it('refuses on the /PageLabels route too', () => {
    const plan = planLabelPages(
      ['tab:dup'],
      aux([
        ['tab:dup', '1', '2'],
        ['tab:dup', '1', '3'],
      ]),
      ['1', '2', '3'],
    );
    expect(plan.failed.map((f) => f.reason)).toEqual(['multiplyDefined']);
  });

  it('caps the pages it names and counts the rest', () => {
    const many = Array.from(
      { length: MAX_AMBIGUOUS_CANDIDATES + 4 },
      (_, i): [string, string, string] => ['x', '1', String(i + 1)],
    );
    const plan = planLabelPages(['x'], aux(many), null);
    expect(plan.failed[0]?.printedPages).toHaveLength(MAX_AMBIGUOUS_CANDIDATES);
    expect(plan.failed[0]?.printedPagesOmitted).toBe(4);
  });

  it('says why in the refusal text: multiply defined, the pages, and that LaTeX uses the last', () => {
    const index = aux([
      ['x', '', '1'],
      ['x', '', '2'],
    ]);
    const msg = labelRefusalMessage(planLabelPages(['x'], index, null), index);
    expect(msg).toContain('"x"');
    expect(msg).toMatch(/multiply defined/i);
    expect(msg).toContain('"1", "2"');
    expect(msg).toMatch(/last/i);
    expect(msg).not.toMatch(/Rerun to get cross-references right/);
  });
});

describe('resolveLabelPages', () => {
  function reader(
    pageLabels: string[] | null,
    pageCount: number,
    text: Record<number, string[]>,
  ): LabelPageReader & { textCalls: number[][] } {
    const textCalls: number[][] = [];
    return {
      textCalls,
      pageLabels: () => Promise.resolve(pageLabels),
      pageCount: () => Promise.resolve(pageCount),
      pageText: (pages) => {
        textCalls.push(pages);
        return Promise.resolve(new Map(pages.map((p) => [p, text[p] ?? []])));
      },
    };
  }

  it('reads the candidate page and its in-range neighbours, and verifies against them', async () => {
    const r = reader(null, 2, REPORT_TEXT);
    const plan = await resolveLabelPages(['fig:a'], aux([['fig:a', '1.1', '1']]), r);
    expect(r.textCalls).toEqual([[1, 2]]);
    expect(plan.failed.map((f) => f.reason)).toEqual(['unverifiedPage']);
  });

  it('never reads page text when the PDF has /PageLabels', async () => {
    const r = reader(['', '1'], 2, REPORT_TEXT);
    const plan = await resolveLabelPages(['fig:a'], aux([['fig:a', '1.1', '1']]), r);
    expect(r.textCalls).toEqual([]);
    expect(plan.pages).toEqual([2]);
  });

  it('reads at most three pages per label, each page once across labels', async () => {
    const r = reader(null, 9, {});
    await resolveLabelPages(
      ['a', 'b', 'c'],
      aux([
        ['a', '1', '3'],
        ['b', '2', '4'],
        ['c', '3', '9'],
      ]),
      r,
    );
    expect(r.textCalls).toEqual([[3, 2, 4, 5, 9, 8]]);
  });

  it('asks for no page past the end of the PDF (the renderer would throw for it)', async () => {
    const r = reader(null, 2, {});
    const plan = await resolveLabelPages(['t'], aux([['t', '1', '9']]), r);
    expect(r.textCalls).toEqual([]);
    expect(plan.failed[0]?.unverified).toBe('pastEndOfPdf');
  });
});

describe('pdfLabelPageReader', () => {
  it('keeps asking until every page came back, past the renderer’s per-call page cap', async () => {
    const calls: number[][] = [];
    const renderer = {
      pageLabels: () => Promise.resolve(null),
      pageCount: () => Promise.resolve(10),
      text: (req: TextRequest): Promise<TextResult> => {
        const pages = req.pages ?? [];
        calls.push(pages);
        return Promise.resolve({
          pageCount: 10,
          pages: pages
            .slice(0, 4)
            .map((page) => ({ page, lines: [`p${page}`], linesOmitted: 0, charsOmitted: 0 })),
          skippedPages: pages.slice(4),
        });
      },
    };
    const text = await pdfLabelPageReader(renderer, '/x.pdf').pageText([1, 2, 3, 4, 5, 6]);
    expect(calls).toEqual([
      [1, 2, 3, 4, 5, 6],
      [5, 6],
    ]);
    expect([...text.keys()]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(text.get(6)).toEqual(['p6']);
  });
});

describe('labelRefusalMessage when the .aux has unread \\@input files', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) {
      await rm(buildDir(dir), { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('does not end on "compile again" when the note says a chapter .aux was not read', async () => {
    // Uses the real reader, so a change to its note's wording breaks this test rather than
    // silently re-enabling the misleading closing line.
    dir = await mkdtemp(path.join(os.tmpdir(), 'labelnote-'));
    await mkdir(buildDir(dir), { recursive: true });
    await writeFile(
      buildAuxPath(dir, 'main.tex'),
      '\\relax \n\\@input{chap.aux}\n\\newlabel{fig:root}{{1}{1}}\n',
    );
    const index = await readAuxFloats(dir, 'main.tex');
    expect(index.note).toBeDefined();
    expect(index.unreadInputs).toBe(1);
    // Plain English, naming what was not read.
    expect(index.note).toMatch(/^The \.aux lists 1 \\@input file\(s\) that were not read/);

    const msg = labelRefusalMessage(planLabelPages(['fig:chap'], index, null), index);
    expect(msg).toContain('chap.aux');
    expect(msg).toMatch(/not read/);
    expect(msg).not.toMatch(/compile again and retry\.$/m);
  });

  it("decides on the structured count, never on the note's wording", () => {
    const index: AuxFloatsResult = {
      floats: [],
      omitted: 0,
      total: 0,
      dropped: 0,
      unreadInputs: 2,
      note: 'Any wording at all: "chap.aux" and "app.aux" (not found in the build directory).',
    };
    const msg = labelRefusalMessage(planLabelPages(['fig:chap'], index, null), index);
    expect(msg).toContain('not read');
    expect(msg).not.toMatch(/compile again and retry\.$/m);
  });

  it('keeps "compile again" when the note is only that no .aux exists yet', () => {
    const index: AuxFloatsResult = {
      floats: [],
      omitted: 0,
      total: 0,
      dropped: 0,
      note: 'No .aux found in the build directory (/tmp/x/main.aux) — nothing has been compiled.',
    };
    const msg = labelRefusalMessage(planLabelPages(['fig:a'], index, null), index);
    expect(msg).toMatch(/compile again and retry\./);
  });
});

/** A fixture `.aux` beside pages.json, verbatim from the pdflatex build its text came from. */
function fixtureAux(name: string): string {
  return readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), `../fixtures/label-folio/${name}.aux`),
    'utf8',
  );
}

/** A reader over a fixture document's real text layer and a given `/PageLabels` array. */
function fixtureReader(doc: string, pageLabels: string[] | null): LabelPageReader {
  const text = pagesOf(doc).text;
  return {
    pageLabels: () => Promise.resolve(pageLabels),
    pageCount: () => Promise.resolve(text.size),
    pageText: (pages) => Promise.resolve(new Map(pages.map((p) => [p, text.get(p) ?? []]))),
  };
}

describe('the .aux, read through the real reader (readAuxFloats over a build dir)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) {
      await rm(buildDir(dir), { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  /**
   * `readAuxFloats` over a build dir holding `files` (the root is `main.aux`), plus the `.log`
   * every compile writes beside it — one that names no pgfpages, unless `files` brings its own —
   * so the routes run rather than every label refusing as `'pgfpagesUnknown'`.
   */
  async function readBuild(files: Record<string, string>): Promise<AuxFloatsResult> {
    dir = await mkdtemp(path.join(os.tmpdir(), 'labelaux-'));
    await mkdir(buildDir(dir), { recursive: true });
    for (const [name, content] of Object.entries({ 'main.log': 'This is pdfTeX\n', ...files })) {
      await writeFile(path.join(buildDir(dir), name), content);
    }
    expect(path.join(buildDir(dir), 'main.aux')).toBe(buildAuxPath(dir, 'main.tex'));
    return readAuxFloats(dir, 'main.tex', { max: 20_000 });
  }

  it('marks a beamer .aux (its \\@writefile{nav} records), and only a beamer one', async () => {
    expect((await readBuild({ 'main.aux': fixtureAux('beamerPause') })).beamerNav).toBe(true);
    await rm(buildDir(dir!), { recursive: true, force: true });
    expect((await readBuild({ 'main.aux': fixtureAux('restartSupp') })).beamerNav).toBe(false);
  });

  it('never resolves a beamer overlay deck through its FRAME-numbered /PageLabels', async () => {
    // Real pdflatex: `\documentclass{beamer}` (hyperref by default), a 3-slide \pause frame, then
    // fig:r's frame. pdf.js labels the 7 pages by FRAME ("1","1","1","2",...), while the .aux
    // records \thepage = the SLIDE index: fig:r is on slide 4, and "4" is frame 4 = PDF page 7.
    // No footline, so nothing on the page can confirm the slide either: refused.
    const index = await readBuild({ 'main.aux': fixtureAux('beamerPause') });
    const tree = ['1', '1', '1', '2', '3', '3', '4'];
    expect(truthPage('beamerPause', 'fig:r')).toBe(4);
    for (const label of ['fig:r', 'tab:t']) {
      const plan = await resolveLabelPages([label], index, fixtureReader('beamerPause', tree));
      expect(plan.resolved, label).toEqual([]);
      expect(plan.labelSource).toBe('printedPage');
      expect(plan.failed[0]).toMatchObject({ reason: 'unverifiedPage', unverified: 'noFolio' });
      const msg = labelRefusalMessage(plan, index);
      expect(msg).toMatch(/beamer/);
      expect(msg).toMatch(/frame/i);
      expect(msg).not.toMatch(/This PDF has no \/PageLabels tree/);
    }
  });

  it('resolves that deck by its slide numbers once the footline prints them', async () => {
    // Same deck with `\insertpagenumber` in the footline: the folio IS the slide index, which is
    // what the .aux recorded, so the printed-page route resolves it exactly.
    const index = await readBuild({ 'main.aux': fixtureAux('beamerPausePageNumber') });
    const tree = ['1', '1', '1', '2', '3', '3', '4'];
    const plan = await resolveLabelPages(
      ['fig:r', 'tab:t'],
      index,
      fixtureReader('beamerPausePageNumber', tree),
    );
    expect(plan.failed).toEqual([]);
    expect(plan.resolved).toEqual([
      { label: 'fig:r', printedPage: '4', page: truthPage('beamerPausePageNumber', 'fig:r') },
      { label: 'tab:t', printedPage: '7', page: truthPage('beamerPausePageNumber', 'tab:t') },
    ]);
    expect(labelResolutionNote(plan)).toMatch(/beamer/);
  });

  it('refuses that deck when the footline prints FRAME numbers ("2 / 4" on slide 4)', async () => {
    const index = await readBuild({ 'main.aux': fixtureAux('beamerPause') });
    const tree = ['1', '1', '1', '2', '3', '3', '4'];
    const plan = await resolveLabelPages(
      ['fig:r'],
      index,
      fixtureReader('beamerPauseFrameNumber', tree),
    );
    expect(plan.resolved).toEqual([]);
    expect(plan.failed[0]).toMatchObject({ unverified: 'folioMismatch', folios: ['2'] });
  });

  it('refuses a non-overlay default-theme deck, identity tree or not (real pdflatex)', async () => {
    // `\documentclass{beamer}`, six one-slide frames, no slide number in the footline. Its tree
    // "1".."6" happens to be the slide numbering here, but an identity tree proves nothing about
    // a deck (see the pgfpages decks below), so it is not used; and no footline prints a slide
    // number, so nothing on a page confirms one either: every label refuses.
    const index = await readBuild({ 'main.aux': fixtureAux('beamerPlain') });
    expect(index.beamerNav).toBe(true);
    const tree = ['1', '2', '3', '4', '5', '6'];
    for (const label of ['fig:r', 'tab:t']) {
      const plan = await resolveLabelPages([label], index, fixtureReader('beamerPlain', tree));
      expect(plan.resolved, label).toEqual([]);
      expect(plan.labelSource, label).toBe('printedPage');
      expect(plan.pageLabelsIgnored, label).toBe('beamer');
      expect(plan.failed[0], label).toMatchObject({
        reason: 'unverifiedPage',
        unverified: 'noFolio',
      });
      expect(labelRefusalMessage(plan, index)).toMatch(/beamer/);
    }
  });

  it('never renders a wrong page for a pgfpages "resize to" deck, whose tree is the identity (real pdflatex)', async () => {
    // `\pgfpagesuselayout{resize to}[a4paper,border shrink=5mm,landscape]` — beamer's common
    // print layout, one slide per sheet. The tree is "1".."4", the identity, and the .aux counts
    // 4 slides (`\beamer@documentpages{4}`), so the deck looks like a plain one. But pgfpages
    // defers every shipout by one page, so each \newlabel records \thepage one too high: fig:f1,
    // on PDF page 1, records "2". A lookup renders the NEXT slide for every label.
    const index = await readBuild({ 'main.aux': fixtureAux('beamerResizeTo') });
    expect(index.beamerNav).toBe(true);
    const tree = ['1', '2', '3', '4'];
    for (const [label, recorded, truth] of [
      ['fig:f1', '2', 1],
      ['fig:f2', '3', 2],
      ['fig:f3', '4', 3],
    ] as const) {
      expect(index.floats.find((f) => f.label === label)?.page, label).toBe(recorded);
      expect(truthPage('beamerResizeTo', label), label).toBe(truth);
      const plan = await resolveLabelPages([label], index, fixtureReader('beamerResizeTo', tree));
      expect(plan.resolved, label).toEqual([]);
      expect(plan.pageLabelsIgnored, label).toBe('beamer');
    }
  });

  it('never renders a wrong page for that "resize to" deck when its footline prints the slide number (real pdflatex)', async () => {
    // The same deck with `\insertpagenumber` in the footline. Each sheet prints its TRUE slide
    // number, so the folio route used to confirm the wrong page: fig:f1 (PDF page 1) records "2",
    // PDF page 2 reads "2", its neighbours read "1" and "3", and the last page reads the page
    // count — every label resolved one slide late, with no refusal. What gives it away is in the
    // same .aux: beamer's own record of the slide the \label ran on,
    // `\@writefile{snm}{\beamer@slide {fig:f1}{1}}`, which disagrees with the \newlabel's "2".
    const index = await readBuild({ 'main.aux': fixtureAux('beamerResizeToPageNumber') });
    expect(index.beamerNav).toBe(true);
    const tree = ['1', '2', '3', '4'];
    for (const [label, recorded, slide] of [
      ['fig:f1', '2', 1],
      ['fig:f2', '3', 2],
      ['fig:f3', '4', 3],
    ] as const) {
      expect(index.floats.find((f) => f.label === label)?.page, label).toBe(recorded);
      expect(truthPage('beamerResizeToPageNumber', label), label).toBe(slide);
      expect(linesOf('beamerResizeToPageNumber', Number(recorded)).at(-1), label).toBe(recorded);
      const plan = await resolveLabelPages(
        [label],
        index,
        fixtureReader('beamerResizeToPageNumber', tree),
      );
      expect(plan.resolved, label).toEqual([]);
      expect(plan.pages, label).toEqual([]);
      expect(plan.failed[0], label).toMatchObject({
        reason: 'slideMismatch',
        printedPage: recorded,
        slides: [String(slide)],
      });
      const msg = labelRefusalMessage(plan, index);
      expect(msg, label).toContain(`printed page "${recorded}"`);
      expect(msg, label).toContain(`slide "${slide}"`);
      expect(msg, label).toMatch(/pgfpages/);
      expect(msg, label).toMatch(/Nothing was rendered and no page was guessed/);
    }
  });

  it('refuses every label of a document that restarts arabic numbering (real pdflatex)', async () => {
    // `\clearpage\setcounter{page}{1}` before a supplement: PDF pages 1-3 print 1-3, and so do
    // PDF pages 4-6. The folios agree with the candidates on pages 1-3, so every supplement label
    // used to resolve to the MAIN paper's page. The .aux gives the restart away: \label is written
    // at shipout, so its records come in page order, and fig:s1's printed page 1 follows fig:m3's 3.
    const index = await readBuild({ 'main.aux': fixtureAux('restartSupp') });
    for (const label of ['fig:m1', 'fig:m2', 'fig:m3', 'fig:s1', 'fig:s2', 'fig:s3']) {
      const plan = await resolveLabelPages([label], index, fixtureReader('restartSupp', null));
      expect(plan.resolved, label).toEqual([]);
      expect(plan.failed[0], label).toMatchObject({ reason: 'restarted' });
      const msg = labelRefusalMessage(plan, index);
      expect(msg).toContain('"fig:m3"');
      expect(msg).toContain('"fig:s1"');
      expect(msg).toMatch(/restart/);
    }
  });

  it('sees a restart across an \\@input-ed .aux, in the order LaTeX read them', async () => {
    // The supplement \include'd: its labels live in supp.aux, read where the root \@inputs it.
    const index = await readBuild({
      'main.aux': '\\relax \n\\newlabel{fig:m}{{1}{3}}\n\\@input{supp.aux}\n',
      'supp.aux': '\\relax \n\\newlabel{fig:s}{{2}{1}}\n',
    });
    expect(index.floats.map((f) => f.label)).toEqual(['fig:m', 'fig:s']);
    const text = { 2: ['body', '2'], 3: ['body', '3'], 4: ['body', '4'] };
    const plan = planLabelPages(['fig:m'], index, null, evidence(4, text));
    expect(plan.resolved).toEqual([]);
    expect(plan.failed[0]).toMatchObject({ label: 'fig:m', reason: 'restarted' });
  });

  it('takes floats written after later labels for what they are: page order, not a restart', async () => {
    // A precision pin for the restart rule, not a regression test (it passes on the code before
    // the rule existed). Real pdflatex .aux: two [p] floats defined on page 1 ship on page 4,
    // AFTER sec:c/eq:x (page 2) — the records follow shipout, never source order, so the page
    // never goes down and nothing here is a restart.
    const index = await readBuild({
      'main.aux': [
        '\\relax ',
        '\\newlabel{sec:intro}{{1}{1}}',
        '\\newlabel{sec:a}{{1.1}{1}}',
        '\\newlabel{sec:b}{{1.2}{1}}',
        '\\newlabel{sec:c}{{1.3}{2}}',
        '\\newlabel{eq:x}{{1}{2}}',
        '\\newlabel{fig:big1}{{1}{4}}',
        '\\newlabel{fig:big2}{{2}{4}}',
        '\\newlabel{fig:t1}{{3}{4}}',
        '',
      ].join('\n'),
    });
    const text = { 3: ['body', '3'], 4: ['FIG', '4'] };
    const plan = planLabelPages(['fig:big1', 'eq:x'], index, null, evidence(4, text));
    expect(plan.failed).toMatchObject([{ label: 'eq:x', reason: 'unverifiedPage' }]);
    const figOnly = planLabelPages(['fig:big1'], index, null, evidence(4, text));
    expect(figOnly.pages).toEqual([4]);
  });
});

describe('readFolios reads the common non-bare foot forms on the last line', () => {
  it('takes "Page N", "N/M", "– N –" over a head that carries section numbers (real pdflatex)', () => {
    // Each head reads "3" "3" "P3": \rightmark's section number, which advanced one per page in
    // step with the PDF and forged the old head reading. The foot is the folio.
    expect(readFolios(linesOf('secpagePageN', 3))).toEqual(['2']);
    expect(readFolios(linesOf('secpageSlashOf', 3))).toEqual(['2']);
    expect(readFolios(linesOf('secpageDash', 3))).toEqual(['2']);
    expect(readFolios(linesOf('pageNPlain', 3))).toEqual(['3']);
  });

  it('knows each form, anchored to the whole line', () => {
    for (const foot of [
      'Page 4',
      'page 4',
      'Page 4 of 9',
      '4 of 9',
      '4/9',
      '4 / 9',
      '-- 4 --',
      '- 4 -',
      '– 4 –',
      '— 4 —',
    ]) {
      expect(readFolios(['9', 'HEAD', 'body', foot]), foot).toEqual(['4']);
    }
    expect(readFolios(['body', 'Page iv'])).toEqual(['iv']);
    // Not a folio form: a number inside prose, a fraction whose top exceeds its bottom, unequal
    // dashes.
    expect(readFolios(['body', 'see Page 4'])).toEqual([]);
    expect(readFolios(['body', '5/4'])).toEqual([]);
    expect(readFolios(['body', '- 4 --'])).toEqual([]);
  });

  it('never resolves a section-per-page document to a page its float is not on', () => {
    // Adversarial builds: `[titlepage]` shifts every page by one, and the head
    // shows the section number, which advances one per page — so page p read "p" and its
    // neighbour "p±1", a perfect forgery. Printed page s-1 is fig:s<s>'s, on PDF page s.
    for (const doc of ['secpagePageN', 'secpageSlashOf', 'secpageDash']) {
      for (let s = 2; s <= 8; s++) {
        const label = `fig:s${s}`;
        const plan = planLabelPages(
          [label],
          aux([[label, String(s), String(s - 1)]]),
          null,
          pagesOf(doc),
        );
        expect(truthPage(doc, label), `${doc} ${label}`).toBe(s);
        for (const r of plan.resolved) expect(r.page, `${doc} ${label}`).toBe(s);
      }
    }
  });

  it('now resolves a plain article whose foot reads "Page N" (it used to refuse: no folio)', () => {
    const index = aux(
      parseAuxLabels(fixtureAux('pageNPlain')).map((l) => [l.label, l.number, l.page]),
    );
    const labels = index.floats.map((f) => f.label);
    const plan = planLabelPages(labels, index, null, pagesOf('pageNPlain'));
    expect(plan.failed).toEqual([]);
    for (const r of plan.resolved) expect(r.page, r.label).toBe(truthPage('pageNPlain', r.label));
    expect(plan.resolved).toHaveLength(6);
  });
});

describe('the printed-page route checks that the numbering reaches the LAST page', () => {
  /** A fixture `.aux` as the reader would hand it over (its beamer flag included). */
  function auxOf(name: string): AuxFloatsResult {
    const text = fixtureAux(name);
    const floats = parseAuxLabels(text);
    return {
      floats,
      omitted: 0,
      total: floats.length,
      dropped: 0,
      beamerNav: isBeamerAux(text),
      // The ordinary case: the build's .log was read and names no pgfpages.
      pgfpages: false,
    };
  }

  it('refuses a supplement restart whose printed pages never go DOWN in the .aux (real pdflatex)', async () => {
    // `\clearpage\setcounter{page}{1}` before a supplement, with the main paper's labels on
    // printed pages 1-2 and the supplement's on printed pages 2-4: the .aux reads 1, 2, 2, 3, 4,
    // which never decreases, so the restart rule saw nothing — and every supplement label's page
    // folio, corroborated by its neighbour, confirmed the MAIN paper's page of the same number
    // (fig:s1 -> PDF page 2, while it is on PDF page 8). The last PDF page prints "4" of 10.
    const index = auxOf('restartNoDecrease');
    expect(truthPage('restartNoDecrease', 'fig:s1')).toBe(8);
    // The supplement's labels first: they are the wrong answers. The main paper's labels are refused
    // too — their pages are right, but nothing on them tells this document from one without a
    // restart, which is the price of the rule.
    for (const label of ['fig:s1', 'fig:s2', 'fig:s3', 'fig:m1', 'fig:m2']) {
      const plan = await resolveLabelPages(
        [label],
        index,
        fixtureReader('restartNoDecrease', null),
      );
      expect(plan.resolved, label).toEqual([]);
      expect(plan.failed[0], label).toMatchObject({
        reason: 'unverifiedPage',
        unverified: 'lastPageMismatch',
        lastPage: { page: 10, folios: ['4'] },
      });
      const msg = labelRefusalMessage(plan, index);
      expect(msg).toContain('the last PDF page, 10, reads as page number "4"');
      expect(msg).toContain('\\setcounter{page}{1}');
      expect(msg).toMatch(/restart/);
    }
  });

  it('refuses an EQUAL restart: the last label before it and the first after share a page', () => {
    // Printed 1, 2, 2 in .aux order (fig:s1 is printed page 2 of the supplement, PDF page 5).
    const index = aux([
      ['fig:m1', '1', '1'],
      ['fig:m2', '2', '2'],
      ['fig:s1', '3', '2'],
    ]);
    const text = {
      1: ['a', '1'],
      2: ['b', '2'],
      3: ['c', '3'],
      4: ['d', '1'],
      5: ['e', '2'],
      6: ['f', '3'],
    };
    const plan = planLabelPages(['fig:s1'], index, null, evidence(6, text));
    expect(plan.resolved).toEqual([]);
    expect(plan.failed[0]).toMatchObject({ unverified: 'lastPageMismatch' });
  });

  it('keeps resolving when the last page shows no folio, or a roman one', () => {
    // An empty back page (`\pagestyle{empty}`, a back cover) says nothing about the numbering,
    // and a roman one is not a decimal count of the PDF: neither is evidence of a restart.
    const index = aux([['fig:a', '1', '2']]);
    for (const last of [['Back cover'], ['Index', 'ii']]) {
      const text = { 1: ['x', '1'], 2: ['FIG', '2'], 3: ['y', '3'], 4: last };
      const plan = planLabelPages(['fig:a'], index, null, evidence(4, text));
      expect(plan.failed, JSON.stringify(last)).toEqual([]);
      expect(plan.pages).toEqual([2]);
      // Its note must not claim the last page read as the page count: it read as no number.
      const note = labelResolutionNote(plan);
      expect(note).not.toMatch(/the last page read as the page count/);
      expect(note).toMatch(/no decimal page number other than the page count/);
    }
  });

  it('words a last-page refusal as a reading, not a diagnosed restart', () => {
    // No restart at all: the last page is `\thispagestyle{empty}` and opens with a section
    // heading, so its foot is empty and its head scan reads the section number "3". The rule
    // still refuses (it cannot tell this from a restart), but it must not assert one as fact.
    const index = aux([['fig:a', '1', '2']]);
    const text = {
      1: ['x', '1'],
      2: ['FIG', '2'],
      3: ['y', '3'],
      4: ['3', 'Conclusion', 'We conclude.'],
    };
    const plan = planLabelPages(['fig:a'], index, null, evidence(4, text));
    expect(plan.failed[0]).toMatchObject({
      unverified: 'lastPageMismatch',
      lastPage: { page: 4, folios: ['3'] },
    });
    const msg = labelRefusalMessage(plan, index);
    expect(msg).toContain('the last PDF page, 4, reads as page number "3", not the page count 4');
    expect(msg).toMatch(/running head or appended content shows a different number/);
    expect(msg).not.toMatch(/does not reach the end of the PDF in step/);
    expect(msg).not.toMatch(/^ {2}A restarted arabic numbering/m);
    expect(msg).toMatch(/If the numbering does restart/);
  });

  it('refuses when the last page was never read: an absent page corroborates nothing', () => {
    const index = aux([['fig:a', '1', '2']]);
    const text = { 1: ['x', '1'], 2: ['FIG', '2'], 3: ['y', '3'] };
    const plan = planLabelPages(['fig:a'], index, null, evidence(4, text));
    expect(plan.resolved).toEqual([]);
    expect(plan.failed[0]).toMatchObject({
      unverified: 'lastPageMismatch',
      lastPage: { page: 4, folios: null },
    });
  });

  it('reads the last page along with the candidates, once', async () => {
    const pages: number[][] = [];
    const r: LabelPageReader = {
      pageLabels: () => Promise.resolve(null),
      pageCount: () => Promise.resolve(9),
      pageText: (p) => {
        pages.push(p);
        return Promise.resolve(new Map(p.map((q) => [q, ['body', String(q)]])));
      },
    };
    const plan = await resolveLabelPages(['a'], aux([['a', '1', '3']]), r);
    expect(pages).toEqual([[3, 2, 4, 9]]);
    expect(plan.pages).toEqual([3]);
  });

  it('refuses a pgfpages "2 on 1" deck, whose identity tree numbers sheets (real pdflatex)', async () => {
    // A precision pin, not a regression test: no code this file has run ever resolved it. It pins
    // one of the two reasons an IDENTITY tree proves nothing about a deck (the "resize to" layout
    // above is the other): `\pgfpagesuselayout{2 on 1}` makes an 8-slide deck a 4-page PDF whose
    // tree is "1".."4" while the .aux records fig:f1 and fig:f2 on "3". The lookup would render
    // PDF page 3 (slides 5-6); fig:f1 is on PDF page 1.
    const index = auxOf('beamerPgfpages');
    expect(index.beamerNav).toBe(true);
    const tree = ['1', '2', '3', '4'];
    expect(index.floats.find((f) => f.label === 'fig:f1')?.page).toBe('3');
    expect(truthPage('beamerPgfpages', 'fig:f1')).toBe(1);
    const plan = await resolveLabelPages(['fig:f1'], index, fixtureReader('beamerPgfpages', tree));
    expect(plan.pageLabelsIgnored).toBe('beamer');
    expect(plan.resolved).toEqual([]);
  });
});

describe("a beamer label is checked against beamer's own slide record (\\beamer@slide)", () => {
  /** A beamer deck's index: `[label, number, page]` records plus `label -> slides` records. */
  function deck(
    entries: Array<[label: string, number: string, page: string]>,
    slides: Record<string, string[]>,
  ): AuxFloatsResult {
    return { ...aux(entries), beamerNav: true, beamerSlides: new Map(Object.entries(slides)) };
  }
  const FOOTED = { 1: ['a', '1'], 2: ['b', '2'], 3: ['c', '3'], 4: ['d', '4'] };

  it('refuses a label whose printed page is not the slide beamer recorded, before any folio is read', async () => {
    const index = deck([['fig:a', '1', '3']], { 'fig:a': ['2'] });
    const read: number[][] = [];
    const reader: LabelPageReader = {
      pageLabels: () => Promise.resolve(['1', '2', '3', '4']),
      pageCount: () => Promise.resolve(4),
      pageText: (p) => {
        read.push(p);
        return Promise.resolve(new Map(p.map((q) => [q, FOOTED[q as 1 | 2 | 3 | 4]])));
      },
    };
    const plan = await resolveLabelPages(['fig:a'], index, reader);
    expect(plan.resolved).toEqual([]);
    expect(plan.failed).toEqual([
      { label: 'fig:a', reason: 'slideMismatch', printedPage: '3', number: '1', slides: ['2'] },
    ]);
    // Nothing is checked for a label already refused, so nothing is read for it.
    expect(read).toEqual([]);
  });

  it('keeps resolving a label whose record agrees, and one that has no record at all', () => {
    const cases: Array<Record<string, string[]>> = [{ 'fig:a': ['3'] }, {}];
    for (const slides of cases) {
      const plan = planLabelPages(
        ['fig:a'],
        deck([['fig:a', '1', '3']], slides),
        null,
        evidence(4, FOOTED),
      );
      expect(plan.failed, JSON.stringify(slides)).toEqual([]);
      expect(plan.pages).toEqual([3]);
    }
  });

  it('refuses when ANY of several records disagrees: a forged or repeated record can only refuse', () => {
    const plan = planLabelPages(
      ['fig:a'],
      deck([['fig:a', '1', '3']], { 'fig:a': ['3', '2'] }),
      null,
      evidence(4, FOOTED),
    );
    expect(plan.failed[0]).toMatchObject({ reason: 'slideMismatch', slides: ['3', '2'] });
  });

  it('refuses an allowframebreaks label too, although its \\newlabel page was the right one', () => {
    // Measured (pdflatex, non-pgfpages deck): a figure in the second part of an allowframebreaks
    // frame is on PDF page 3 and its \newlabel says "3", but beamer's record says slide "2" —
    // written when the \label ran, before the frame was broken. The two cannot be told apart from
    // a pgfpages shift, so this refuses a right page: the safe direction.
    const plan = planLabelPages(
      ['fig:f2'],
      deck([['fig:f2', '1', '3']], { 'fig:f2': ['2'] }),
      null,
      evidence(4, FOOTED),
    );
    expect(plan.resolved).toEqual([]);
    expect(plan.failed[0]).toMatchObject({ reason: 'slideMismatch', printedPage: '3' });
    expect(labelRefusalMessage(plan, deck([], {}))).toMatch(/allowframebreaks/);
  });

  it('reads the slide records only for a beamer deck', () => {
    const plan = planLabelPages(
      ['fig:a'],
      {
        ...aux([['fig:a', '1', '3']]),
        beamerNav: false,
        beamerSlides: new Map([['fig:a', ['2']]]),
      },
      null,
      evidence(4, FOOTED),
    );
    expect(plan.failed).toEqual([]);
  });
});

describe('a build whose records cannot say whether it loaded pgfpages refuses every label, on both routes', () => {
  // `pgfpages` absent: neither the build's .fls nor its .log could be read beside the .aux, so a
  // layout that shifted every label a page late cannot be ruled out. Evidence the document
  // controls may only ADD a refusal, so the unknown case refuses rather than resolving.
  const ENTRIES: Array<[string, string, string]> = [
    ['dup', '3', '1'],
    ['dup', '4', '1'],
    ['fig:a', '1', '2'],
    ['fig:b', '2', '3'],
  ];
  const TREE = ['1', '2', '3', '4'];

  it('refuses each found label as pgfpagesUnknown; notFound and multiplyDefined still win for theirs', () => {
    const index = withoutRecords(aux(ENTRIES));
    for (const [tree, ev] of [
      [null, pagesOf('unshifted')],
      [TREE, undefined],
    ] as const) {
      const plan = planLabelPages(['fig:a', 'nope', 'dup', 'fig:b'], index, tree, ev);
      expect(plan.labelSource).toBe(tree ? 'pageLabels' : 'printedPage');
      expect(plan.resolved).toEqual([]);
      expect(plan.pages).toEqual([]);
      expect(plan.failed).toEqual([
        { label: 'fig:a', reason: 'pgfpagesUnknown', printedPage: '2', number: '1' },
        { label: 'nope', reason: 'notFound' },
        {
          label: 'dup',
          reason: 'multiplyDefined',
          printedPages: ['1', '1'],
          printedPagesOmitted: 0,
        },
        { label: 'fig:b', reason: 'pgfpagesUnknown', printedPage: '3', number: '2' },
      ]);
    }
  });

  it('resolves the same labels once a record was read and names no pgfpages (the value just outside)', () => {
    const index = aux(ENTRIES);
    expect(planLabelPages(['fig:a', 'fig:b'], index, null, pagesOf('unshifted'))).toMatchObject({
      failed: [],
      pages: [2, 3],
    });
    expect(planLabelPages(['fig:a', 'fig:b'], index, TREE)).toMatchObject({
      failed: [],
      pages: [2, 3],
    });
  });

  it('asks the reader for no page text unless the records were read and name no pgfpages', async () => {
    const known = aux(ENTRIES);
    expect(pagesToVerify(['fig:a'], known, 4)).toEqual([2, 1, 3, 4]);
    expect(pagesToVerify(['fig:a'], withoutRecords(known), 4)).toEqual([]);
    expect(pagesToVerify(['fig:a'], { ...known, pgfpages: true }, 4)).toEqual([]);

    const read: number[][] = [];
    const base = fixtureReader('unshifted', null);
    const reader: LabelPageReader = {
      ...base,
      pageText: (p) => {
        read.push(p);
        return base.pageText(p);
      },
    };
    const plan = await resolveLabelPages(['fig:a', 'fig:b'], withoutRecords(known), reader);
    expect(plan.failed.map((f) => f.reason)).toEqual(['pgfpagesUnknown', 'pgfpagesUnknown']);
    expect(read).toEqual([]);
  });

  it('says the records could not be read, that a compile writes them, and how to pass pages:', () => {
    const index = withoutRecords(aux(ENTRIES));
    const msg = labelRefusalMessage(planLabelPages(['fig:a'], index, null), index);
    expect(msg).toContain('"fig:a"');
    expect(msg).toContain('printed page "2"');
    expect(msg).toContain('.fls');
    expect(msg).toContain('.log');
    expect(msg).toMatch(/neither the build's recorder file \(\.fls\) nor its \.log could be read/);
    expect(msg).toMatch(/\\pgfpagesuselayout\{resize to\}/);
    expect(msg).toMatch(/No page was assumed/);
    expect(msg).toMatch(/Its number is "1"/);
    expect(msg).toMatch(/compile again/i);
    expect(msg).toMatch(/pages:/);
    // Nothing is known about pgfpages, so nothing may be claimed about it.
    expect(msg).not.toMatch(/loaded pgfpages|names? pgfpages\.sty/);
    // The advice is given once, however many labels refuse.
    const two = labelRefusalMessage(planLabelPages(['fig:a', 'fig:b'], index, null), index);
    expect(two.match(/compile again/gi)).toHaveLength(1);
  });
});

describe('a build that loaded pgfpages refuses every label, on both routes', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) {
      await rm(buildDir(dir), { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  /** `readAuxFloats` over a build dir holding `files` (the root is `main.aux`). */
  async function readBuild(files: Record<string, string>): Promise<AuxFloatsResult> {
    dir = await mkdtemp(path.join(os.tmpdir(), 'labelpgf-'));
    await mkdir(buildDir(dir), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(buildDir(dir), name), content);
    }
    return readAuxFloats(dir, 'main.tex', { max: 20_000 });
  }

  /** A fixture file beside pages.json that is not an `.aux` (a recorder `.fls`, a `.log`). */
  function fixtureFile(name: string): string {
    return readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), `../fixtures/label-folio/${name}`),
      'utf8',
    );
  }

  const LABELS = ['fig:a', 'fig:b', 'fig:c'];

  it('refuses a "resize to" ARTICLE, whose every label records the next page (real pdflatex)', async () => {
    // `\pgfpagesuselayout{resize to}` holds each page back until the next one is built, so every
    // \newlabel records \thepage one too high: fig:a is on PDF page 1 and records "2". Each PDF
    // page prints its own true folio, so the page the shifted record names reads exactly as it
    // and a neighbour agrees — the folio route rendered the NEXT figure for every label.
    const index = await readBuild({
      'main.aux': fixtureAux('articleResizeTo'),
      'main.fls': fixtureFile('articleResizeTo.fls'),
    });
    for (const [i, label] of LABELS.entries()) {
      expect(truthPage('articleResizeTo', label), label).toBe(i + 1);
      expect(index.floats.find((f) => f.label === label)?.page, label).toBe(String(i + 2));
      const plan = await resolveLabelPages([label], index, fixtureReader('articleResizeTo', null));
      expect(plan.resolved, label).toEqual([]);
      expect(plan.failed, label).toEqual([
        { label, reason: 'pgfpagesLayout', printedPage: String(i + 2), number: String(i + 1) },
      ]);
    }
    expect(index.pgfpages).toBe(true);
  });

  it('refuses it on the /PageLabels route too: the tree is shifted with the labels', async () => {
    const index = await readBuild({
      'main.aux': fixtureAux('articleResizeTo'),
      'main.fls': fixtureFile('articleResizeTo.fls'),
    });
    const plan = await resolveLabelPages(
      [...LABELS, 'nope'],
      index,
      fixtureReader('articleResizeTo', ['1', '2', '3', '4']),
    );
    expect(plan.resolved).toEqual([]);
    // A label the .aux does not have is still reported as not found: the more specific fact.
    expect(plan.failed.map((f) => f.reason)).toEqual([
      'pgfpagesLayout',
      'pgfpagesLayout',
      'pgfpagesLayout',
      'notFound',
    ]);
    const msg = labelRefusalMessage(plan, index);
    expect(msg).toMatch(/pgfpages/);
    expect(msg).toMatch(/pages:/);
    expect(msg).toMatch(/Its number is "1"/);
    // The records name the file; they do not show it was loaded, let alone the layout used —
    // the .fls records a file merely opened by \IfFileExists.
    expect(msg).not.toMatch(/loaded pgfpages/);
    expect(msg).toMatch(/names? pgfpages\.sty or pgfmorepages\.sty/);
    expect(msg).toMatch(/only that the file was opened, not that a layout is in use/);
    expect(msg).toMatch(/spurious — and still made/);
    expect(msg).toContain('\\IfFileExists{pgfpages.sty}');
    expect(msg).toMatch(/without \\pgfpagesuselayout/);
    expect(msg).toMatch(/removing that load or test lets the lookup run/);
    // The last page is simply the last PDF page: the pointer, not an exemption.
    expect(msg).toContain('LastPage');
    expect(msg).toMatch(/pass pages: with the PDF's page count/);
    // Still points at the way round it.
    expect(msg).toMatch(/extract_text/);
    expect(msg).toContain('pdf_geometry kinds: ["text"]');
    expect(msg).not.toMatch(/could be read beside the \.aux/);
  });

  it('reads the evidence off the .log when the build left no .fls (a recorder turned off)', async () => {
    const index = await readBuild({
      'main.aux': fixtureAux('articleResizeTo'),
      'main.log': fixtureFile('articleResizeTo.log.txt'),
    });
    expect(index.pgfpages).toBe(true);
    const plan = await resolveLabelPages(['fig:a'], index, fixtureReader('articleResizeTo', null));
    expect(plan.failed[0]).toMatchObject({ label: 'fig:a', reason: 'pgfpagesLayout' });
  });

  it('believes the .log over a stale .fls that shows no pgfpages: either record refuses', async () => {
    const index = await readBuild({
      'main.aux': fixtureAux('articleResizeTo'),
      'main.fls': 'PWD /build\nINPUT /usr/share/texlive/texmf-dist/tex/latex/base/article.cls\n',
      'main.log': fixtureFile('articleResizeTo.log.txt'),
    });
    expect(index.pgfpages).toBe(true);
  });

  it('knows nothing when neither record is there, and says so as undefined, not false', async () => {
    const index = await readBuild({ 'main.aux': fixtureAux('articleResizeTo') });
    expect(index.pgfpages).toBeUndefined();
  });

  it('refuses every label of that "resize to" article when neither record is there, on both routes (real pdflatex)', async () => {
    // Nothing says whether a layout shifted the labels, and without the records the folio route
    // resolved every label to the NEXT figure (fig:a, on PDF page 1, records "2", and PDF page 2
    // reads "2"). Every compile leaves a .log beside the .aux, so failing closed costs nothing in
    // normal use.
    const index = await readBuild({ 'main.aux': fixtureAux('articleResizeTo') });
    expect(index.pgfpages).toBeUndefined();
    const expected = LABELS.map((label, i) => ({
      label,
      reason: 'pgfpagesUnknown',
      printedPage: String(i + 2),
      number: String(i + 1),
    }));
    for (const tree of [null, ['1', '2', '3', '4']]) {
      const plan = await resolveLabelPages(LABELS, index, fixtureReader('articleResizeTo', tree));
      expect(plan.resolved, JSON.stringify(tree)).toEqual([]);
      expect(plan.pages, JSON.stringify(tree)).toEqual([]);
      expect(plan.failed, JSON.stringify(tree)).toEqual(expected);
    }
  });

  it('runs the routes once an EMPTY .log was read: a record that names nothing is not "unknown"', async () => {
    // The value just outside the guard: the same .aux, and a .log that was read and names
    // nothing, so pgfpages is false and whatever the routes decide, it is not a pgfpages refusal.
    const index = await readBuild({ 'main.aux': fixtureAux('articleResizeTo'), 'main.log': '' });
    expect(index.pgfpages).toBe(false);
    for (const tree of [null, ['1', '2', '3', '4']]) {
      const plan = await resolveLabelPages(LABELS, index, fixtureReader('articleResizeTo', tree));
      const reasons = plan.failed.map((f) => f.reason);
      expect(reasons, JSON.stringify(tree)).not.toContain('pgfpagesUnknown');
      expect(reasons, JSON.stringify(tree)).not.toContain('pgfpagesLayout');
      expect(plan.resolved.length + plan.failed.length, JSON.stringify(tree)).toBe(LABELS.length);
    }
  });

  it('says false only when a record was read and names no pgfpages.sty', async () => {
    const index = await readBuild({
      'main.aux': fixtureAux('articleResizeTo'),
      'main.fls': [
        'PWD /build',
        'INPUT /texmf/tex/latex/mine/mypgfpages.sty',
        'INPUT /texmf/tex/latex/mine/pgfpages.sty.bak',
        'INPUT ./pgfpagesx.sty',
        '',
      ].join('\n'),
      'main.log': [
        '(/texmf/tex/latex/mine/mypgfpages.sty',
        'Package: mypgfpages 2020/01/01',
        'Package: pgfpagesx 2020/01/01',
        '',
      ].join('\n'),
    });
    expect(index.pgfpages).toBe(false);
    const plan = await resolveLabelPages(['fig:a'], index, fixtureReader('articleResizeTo', null));
    expect(plan.failed[0]?.reason).not.toBe('pgfpagesLayout');
  });

  it('takes any spelling of the file itself: relative, Windows separators, CRLF', async () => {
    for (const fls of [
      'INPUT pgfpages.sty\n',
      'INPUT ./pgfpages.sty\r\n',
      'INPUT C:\\texlive\\texmf-dist\\tex\\latex\\pgf\\utilities\\pgfpages.sty\r\n',
      'INPUT C:/texlive/texmf-dist/tex/latex/pgf/utilities/pgfpages.sty\n',
    ]) {
      const index = await readBuild({ 'main.aux': fixtureAux('articleResizeTo'), 'main.fls': fls });
      expect(index.pgfpages, fls).toBe(true);
      await rm(buildDir(dir!), { recursive: true, force: true });
    }
  });

  it('takes pgfmorepages, which holds pages back the same way without loading pgfpages.sty', async () => {
    // Lines from a real pdflatex build with \usepackage{pgfmorepages} and a `resize to` layout:
    // neither record names pgfpages.sty, and every label there was one page late.
    const builds: Array<Record<string, string>> = [
      {
        'main.fls':
          'PWD /build\nINPUT /usr/share/texlive/texmf-dist/tex/latex/pgfmorepages/pgfmorepages.sty\n',
      },
      { 'main.log': 'Package: pgfmorepages 2019/03/22 v1.00 multiple page manipulation\n' },
      { 'main.log': 'no file-open or Package line survived here\n\\pgfpages@shipoutbox=\\box51\n' },
    ];
    for (const files of builds) {
      const index = await readBuild({ 'main.aux': fixtureAux('articleResizeTo'), ...files });
      expect(index.pgfpages, JSON.stringify(files)).toBe(true);
      await rm(buildDir(dir!), { recursive: true, force: true });
    }
  });

  it('refuses a pgfpages beamer deck as pgfpages, before its slide records are consulted', async () => {
    const index = await readBuild({
      'main.aux': fixtureAux('beamerResizeToPageNumber'),
      'main.fls': 'INPUT /usr/share/texlive/texmf-dist/tex/latex/pgf/utilities/pgfpages.sty\n',
    });
    expect(index.beamerNav).toBe(true);
    const plan = await resolveLabelPages(
      ['fig:f1'],
      index,
      fixtureReader('beamerResizeToPageNumber', ['1', '2', '3', '4']),
    );
    expect(plan.failed[0]).toMatchObject({ label: 'fig:f1', reason: 'pgfpagesLayout' });
    expect(labelRefusalMessage(plan, index)).not.toMatch(/allowframebreaks/);
  });

  it('reads no page text for a pgfpages build: nothing is checked, so nothing is read', async () => {
    const index = await readBuild({
      'main.aux': fixtureAux('articleResizeTo'),
      'main.fls': fixtureFile('articleResizeTo.fls'),
    });
    const read: number[][] = [];
    const base = fixtureReader('articleResizeTo', null);
    const reader: LabelPageReader = {
      ...base,
      pageText: (p) => {
        read.push(p);
        return base.pageText(p);
      },
    };
    await resolveLabelPages(LABELS, index, reader);
    expect(read).toEqual([]);
  });
});

describe('a beamer slide record whose label key holds a brace group', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) {
      await rm(buildDir(dir), { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('is read under the key the \\newlabel parser stores, so the slide check applies (real pdflatex)', async () => {
    // A "resize to" deck whose footline prints the slide number, with \label{fig:{a}} and
    // \label{fig:{c}}: the .aux records "2" and "4" while beamer's own record keeps slides 1 and
    // 3. Beside the .aux sits a .log that names no pgfpages — records that are wrong about this
    // deck, the one case the slide check is still there to catch — so this is the slide record's
    // refusal alone.
    dir = await mkdtemp(path.join(os.tmpdir(), 'labelbrace-'));
    await mkdir(buildDir(dir), { recursive: true });
    await writeFile(path.join(buildDir(dir), 'main.aux'), fixtureAux('beamerResizeToBraces'));
    await writeFile(path.join(buildDir(dir), 'main.log'), 'This is pdfTeX\n');
    const index = await readAuxFloats(dir, 'main.tex', { max: 20_000 });
    expect(index.pgfpages).toBe(false);
    expect(index.beamerSlides?.get('fig:{a}')).toEqual(['1']);
    expect(index.beamerSlides?.get('fig:{c}')).toEqual(['3']);
    const tree = ['1', '2', '3', '4'];
    for (const [label, slide, recorded] of [
      ['fig:{a}', '1', '2'],
      ['fig:{c}', '3', '4'],
    ] as const) {
      expect(truthPage('beamerResizeToBraces', label), label).toBe(Number(slide));
      expect(index.floats.find((f) => f.label === label)?.page, label).toBe(recorded);
      const plan = await resolveLabelPages(
        [label],
        index,
        fixtureReader('beamerResizeToBraces', tree),
      );
      expect(plan.resolved, label).toEqual([]);
      expect(plan.failed[0], label).toMatchObject({ reason: 'slideMismatch', slides: [slide] });
    }
  });
});

describe('the slideMismatch refusal gives the advice that fits the build', () => {
  function deckAux(pgfpages: boolean | undefined): AuxFloatsResult {
    return {
      floats: [{ label: 'brk', number: '', page: '3' }],
      omitted: 0,
      total: 1,
      dropped: 0,
      beamerNav: true,
      beamerSlides: new Map([['brk', ['2']]]),
      ...(pgfpages === undefined ? {} : { pgfpages }),
    };
  }

  it('does not tell a deck whose build did not load pgfpages to compile without it', () => {
    // An allowframebreaks label in a deck with no pgfpages: the old advice sent the caller to
    // remove a layout the deck does not have.
    const index = deckAux(false);
    const plan = planLabelPages(['brk'], index, null, evidence(4, {}));
    expect(plan.failed[0]?.reason).toBe('slideMismatch');
    const msg = labelRefusalMessage(plan, index);
    expect(msg).not.toMatch(/compile without|compiling without/);
    expect(msg).toMatch(/records name neither pgfpages nor pgfmorepages/);
    expect(msg).toMatch(/allowframebreaks/);
    // Nor offer a pgfpages layout as a cause per label, which the closing advice then denies.
    expect(msg).not.toMatch(/pgfpages layout/);
  });

  it('is never reached by a deck whose records could not be read, nor one whose records name pgfpages', () => {
    // Both refuse every label first, so the slide record is not consulted and its advice (which
    // only fits a build known to have no pgfpages) is never given.
    for (const [pgfpages, reason] of [
      [undefined, 'pgfpagesUnknown'],
      [true, 'pgfpagesLayout'],
    ] as const) {
      const index = deckAux(pgfpages);
      const plan = planLabelPages(['brk'], index, null, evidence(4, {}));
      expect(plan.failed, reason).toEqual([{ label: 'brk', reason, printedPage: '3', number: '' }]);
      const msg = labelRefusalMessage(plan, index);
      expect(msg, reason).not.toMatch(/allowframebreaks/);
      expect(msg, reason).not.toMatch(/beamer@slide/);
    }
  });
});

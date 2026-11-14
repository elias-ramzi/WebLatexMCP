import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  planLabelPages,
  labelRefusalMessage,
  labelResolutionNote,
  resolveLabelPages,
  pdfLabelPageReader,
} from '../../src/lib/labelPages.js';
import type { LabelPageEvidence, LabelPageReader } from '../../src/lib/labelPages.js';
import type { AuxFloatsResult, AuxLabel } from '../../src/lib/auxFloats.js';
import { PdfRenderer, PDFJS_SPECIFIER } from '../../src/services/pdfRender.js';
import type { PdfjsLoader } from '../../src/services/pdfRender.js';
import { minimalPdf } from '../helpers/minimalPdf.js';

/**
 * #223: hyperref writes no /PageLabels tree when every page's label equals its index
 * (`\HyPL@Useless`), so an ordinary arabic paper takes the printed-page route, where a page whose
 * folio cannot be read from its text (a float page, a table cell above the foot) was refused. The
 * label's own hyperref destination on the candidate page now verifies it instead — and only that:
 * every other check still refuses.
 */

/** `[label, number, page, anchor]` — hyperref's `\newlabel{label}{{number}{page}{..}{anchor}{}}`. */
type Row = [label: string, number: string, page: string, anchor?: string];

function aux(rows: Row[], extra: Partial<AuxFloatsResult> = {}): AuxFloatsResult {
  const floats: AuxLabel[] = rows.map(([label, number, page, anchor]) => ({
    label,
    number,
    page,
    ...(anchor ? { anchor } : {}),
  }));
  return { floats, omitted: 0, total: floats.length, dropped: 0, pgfpages: false, ...extra };
}

function evidence(
  text: Record<number, string[]>,
  destinations?: Record<string, number>,
): LabelPageEvidence {
  return {
    pageCount: Object.keys(text).length,
    text: new Map(Object.entries(text).map(([p, l]) => [Number(p), l])),
    ...(destinations ? { destinations: new Map(Object.entries(destinations)) } : {}),
  };
}

/** Six pages of an unshifted article: every page prints its folio last, except page 4 — a float
 *  page whose last line is a table cell, so no folio can be read off it. */
const FLOAT_PAGE: Record<number, string[]> = {
  1: ['Title', 'Body text [1, 2].', '1'],
  2: ['Body text.', '2'],
  3: ['Body text.', '3'],
  4: ['Table 2: Results', 'Method A 0.81', 'Ours 0.83'],
  5: ['Body text.', '5'],
  6: ['References', '6'],
};

const TABLE: Row = ['tab:results', '2', '4', 'table.caption.2'];

describe('the printed-page route verifies a candidate by its hyperref destination (#223)', () => {
  it('refuses a float page with no readable folio when there is no destination (the bug)', () => {
    const plan = planLabelPages(['tab:results'], aux([TABLE]), null, evidence(FLOAT_PAGE));
    expect(plan.failed.map((f) => [f.reason, f.unverified])).toEqual([
      ['unverifiedPage', 'noFolio'],
    ]);
  });

  it("resolves it when the label's destination lies on the candidate page", () => {
    const plan = planLabelPages(
      ['tab:results'],
      aux([TABLE]),
      null,
      evidence(FLOAT_PAGE, { 'table.caption.2': 4 }),
    );
    expect(plan.failed).toEqual([]);
    expect(plan.resolved).toEqual([{ label: 'tab:results', printedPage: '4', page: 4 }]);
    expect(plan.labelSource).toBe('printedPage');
    expect(plan.destinationVerified).toEqual(['tab:results']);
    const note = labelResolutionNote(plan);
    expect(note).toContain('For tab:results that text check was not needed');
    expect(note).toContain('link target');
  });

  it('falls back to the folio check, and says where the destination is, when it disagrees', () => {
    const plan = planLabelPages(
      ['tab:results'],
      aux([TABLE]),
      null,
      evidence(FLOAT_PAGE, { 'table.caption.2': 5 }),
    );
    expect(plan.failed).toEqual([
      expect.objectContaining({ unverified: 'noFolio', destinationPage: 5 }),
    ]);
    expect(labelRefusalMessage(plan, aux([TABLE]))).toContain(
      'Its hyperref link target (the destination \\ref jumps to) is on PDF page 5',
    );
  });

  it('never verifies by an anchor other than the label’s own', () => {
    const plan = planLabelPages(
      ['tab:results'],
      aux([TABLE, ['fig:other', '1', '4', 'figure.caption.1']]),
      null,
      evidence(FLOAT_PAGE, { 'figure.caption.1': 4 }),
    );
    expect(plan.failed.map((f) => f.unverified)).toEqual(['noFolio']);
  });

  it('refuses a title-page-shifted article whose destinations sit on the true pages', () => {
    // Under `[titlepage]` the figure printed on page 2 is on PDF page 3, and so is its anchor:
    // the destination disagrees with the candidate and confirms nothing.
    const text = { 1: ['A', 'September 24, 2026'], 2: ['x', '1'], 3: ['x', '2'], 4: ['x', '3'] };
    const index = aux([['fig:a', '1', '2', 'figure.caption.1']]);
    const plan = planLabelPages(['fig:a'], index, null, evidence(text, { 'figure.caption.1': 3 }));
    expect(plan.failed).toEqual([
      expect.objectContaining({ unverified: 'folioMismatch', destinationPage: 3 }),
    ]);
  });

  it('still refuses on the shipout record when a destination agrees with a shifted page', () => {
    // The residual the destination cannot close — an anchor shipped exactly as many pages before
    // its label as the document is shifted — is still judged by the .log: PDF page 2 shipped
    // with counter 1, not 2.
    // (The last page shows no folio, so the last-page check has nothing against it.)
    const text = { 1: ['A', 'date'], 2: ['x', '1'], 3: ['x', '2'], 4: ['References'] };
    const index = aux([['sec:b', '2', '2', 'section.2']], { shipouts: [1, 1, 2, 3] });
    const plan = planLabelPages(['sec:b'], index, null, evidence(text, { 'section.2': 2 }));
    expect(plan.failed.map((f) => f.unverified)).toEqual(['shipoutMismatch']);
  });

  it('stands in for the page text only: the last-page check still refuses', () => {
    const text = { ...FLOAT_PAGE, 6: ['References', '3'] };
    const plan = planLabelPages(
      ['tab:results'],
      aux([TABLE]),
      null,
      evidence(text, { 'table.caption.2': 4 }),
    );
    expect(plan.failed.map((f) => f.unverified)).toEqual(['lastPageMismatch']);
  });

  it('stands in for the page text only: a restart is still refused', () => {
    const index = aux([
      ['fig:main', '1', '3', 'figure.caption.1'],
      ['fig:supp', 'S1', '1', 'figure.caption.5'],
    ]);
    const plan = planLabelPages(
      ['fig:supp'],
      index,
      null,
      evidence(FLOAT_PAGE, { 'figure.caption.5': 1 }),
    );
    expect(plan.failed.map((f) => f.reason)).toEqual(['restarted']);
  });

  it('is never used for a beamer deck', () => {
    const index = aux([TABLE], { beamerNav: true });
    const plan = planLabelPages(
      ['tab:results'],
      index,
      null,
      evidence(FLOAT_PAGE, { 'table.caption.2': 4 }),
    );
    expect(plan.failed.map((f) => f.unverified)).toEqual(['noFolio']);
    expect(plan.destinationVerified).toBeUndefined();
  });

  it('says in the refusal that hyperref writes no tree for a 1..N document', () => {
    const plan = planLabelPages(['tab:results'], aux([TABLE]), null, evidence(FLOAT_PAGE));
    const msg = labelRefusalMessage(plan, aux([TABLE]));
    expect(msg).toContain('hyperref writes one only when the printed page numbers differ');
    expect(msg).not.toContain('Loading hyperref writes /PageLabels, which turns this');
  });
});

describe('resolveLabelPages asks the PDF for destinations', () => {
  function reader(
    pageLabels: string[] | null,
    text: Record<number, string[]>,
    destinations?: Record<string, number>,
  ): LabelPageReader & { asked: string[][] } {
    const asked: string[][] = [];
    return {
      asked,
      pageLabels: () => Promise.resolve(pageLabels),
      pageCount: () => Promise.resolve(Object.keys(text).length),
      pageText: (pages) => Promise.resolve(new Map(pages.map((p) => [p, text[p] ?? []]))),
      ...(destinations
        ? {
            destinationPages: (names: string[]) => {
              asked.push(names);
              return Promise.resolve(
                new Map(names.flatMap((n) => (n in destinations ? [[n, destinations[n]!]] : []))),
              );
            },
          }
        : {}),
    };
  }

  it("for the requested labels' anchors only, and resolves through them", async () => {
    const r = reader(null, FLOAT_PAGE, { 'table.caption.2': 4, 'figure.caption.1': 2 });
    const index = aux([['fig:a', '1', '2', 'figure.caption.1'], TABLE]);
    const plan = await resolveLabelPages(['tab:results'], index, r);
    expect(r.asked).toEqual([['table.caption.2']]);
    expect(plan.pages).toEqual([4]);
  });

  it('never on the /PageLabels route', async () => {
    const r = reader(['1', '2', '3', '4', '5', '6'], FLOAT_PAGE, { 'table.caption.2': 4 });
    const plan = await resolveLabelPages(['tab:results'], aux([TABLE]), r);
    expect(r.asked).toEqual([]);
    expect(plan.labelSource).toBe('pageLabels');
  });

  it('decides on the text alone with a reader that has no destination lookup', async () => {
    const plan = await resolveLabelPages(['tab:results'], aux([TABLE]), reader(null, FLOAT_PAGE));
    expect(plan.failed.map((f) => f.unverified)).toEqual(['noFolio']);
  });
});

describe('PdfRenderer.destinationPages (real pdf.js)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function countingLoader(): { loader: PdfjsLoader; loads: () => number } {
    let loads = 0;
    const loader: PdfjsLoader = async () => {
      const real = (await import(PDFJS_SPECIFIER)) as unknown as Awaited<ReturnType<PdfjsLoader>>;
      return {
        OPS: real.OPS,
        getDocument: (src) => {
          loads++;
          return real.getDocument(src);
        },
      };
    };
    return { loader, loads: () => loads };
  }

  it('maps each named destination to its page, leaving out unknown and non-page targets', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'dest-pages-'));
    const pdfPath = path.join(dir, 'main.pdf');
    await writeFile(
      pdfPath,
      minimalPdf(3, 200, 100, {
        destinations: {
          'figure.caption.1': 2,
          'section.2': 3,
          'remote.page': '[1 /XYZ 0 0 null]',
        },
      }),
    );
    const pages = await new PdfRenderer(countingLoader().loader).destinationPages(pdfPath, [
      'figure.caption.1',
      'section.2',
      'remote.page',
      'missing',
    ]);
    expect([...pages]).toEqual([
      ['figure.caption.1', 2],
      ['section.2', 3],
    ]);
  });

  it('opens no document for no names', async () => {
    const { loader, loads } = countingLoader();
    const pages = await new PdfRenderer(loader).destinationPages('/nowhere.pdf', []);
    expect(pages.size).toBe(0);
    expect(loads()).toBe(0);
  });

  it('resolves a float page with no folio end to end, through the real reader', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'dest-e2e-'));
    const pdfPath = path.join(dir, 'main.pdf');
    await writeFile(
      pdfPath,
      minimalPdf(6, 300, 400, {
        text: (p) => FLOAT_PAGE[p]!.join('\n'),
        destinations: { 'table.caption.2': 4 },
      }),
    );
    const index = aux([TABLE], { pairedPdf: pdfPath });
    const renderer = new PdfRenderer(countingLoader().loader);
    const plan = await resolveLabelPages(
      ['tab:results'],
      index,
      pdfLabelPageReader(renderer, pdfPath),
    );
    expect(plan.failed).toEqual([]);
    expect(plan.pages).toEqual([4]);
    expect(plan.destinationVerified).toEqual(['tab:results']);
  });
});

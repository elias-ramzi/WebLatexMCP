import { describe, it, expect } from 'vitest';
import {
  planLabelPages,
  labelRefusalMessage,
  labelResolutionNote,
  resolveLabelPages,
} from '../../src/lib/labelPages.js';
import type { LabelPageEvidence, LabelPageReader } from '../../src/lib/labelPages.js';
import { parseDuplicateDestinations } from '../../src/lib/auxFloats.js';
import type { AuxFloatsResult, AuxLabel } from '../../src/lib/auxFloats.js';

/**
 * The destination route: a CVPR main paper and its supplement in ONE PDF, the supplement
 * restarting its page numbering, so every printed page of the supplement names two PDF pages.
 * The label's own hyperref destination picks the copy — only when what the route reads for that
 * page agrees, and only behind every build-level refusal.
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

/** 24 PDF pages: a 12-page main paper and a 12-page supplement numbered 1..12 again. */
const PAGE_LABELS = [...Array.from({ length: 12 }, (_, i) => String(i + 1))].concat(
  Array.from({ length: 12 }, (_, i) => String(i + 1)),
);
/** Every page's text: body, then its folio (the printed page) on the last line. */
const TEXT: Record<number, string[]> = Object.fromEntries(
  PAGE_LABELS.map((label, i) => [i + 1, ['Body text.', label]]),
);
/** The counter each page shipped with: 1..12 twice. */
const SHIPOUTS = PAGE_LABELS.map(Number);

const MAIN: Row = ['fig:teaser', '1', '1', 'figure.caption.1'];
const SUPP: Row = ['fig:backbone_scaling', '9', '12', 'figure.caption.40'];

function evidence(
  destinations?: Record<string, number>,
  text: Record<number, string[]> = TEXT,
): LabelPageEvidence {
  return {
    pageCount: 24,
    text: new Map(Object.entries(text).map(([p, l]) => [Number(p), l])),
    ...(destinations ? { destinations: new Map(Object.entries(destinations)) } : {}),
  };
}

describe('the destination route on the /PageLabels route (printed "12" on PDF pages 12 and 24)', () => {
  it('refuses as before when the label has no destination', () => {
    const index = aux([MAIN, SUPP]);
    const plan = planLabelPages(['fig:backbone_scaling'], index, PAGE_LABELS, evidence());
    expect(plan.failed).toEqual([
      {
        label: 'fig:backbone_scaling',
        reason: 'ambiguousPrintedPage',
        printedPage: '12',
        candidatePages: [12, 24],
        candidatePagesOmitted: 0,
      },
    ]);
    expect(labelRefusalMessage(plan, index)).not.toContain('link target');
  });

  it('refuses as before when the PDF has no destination of that name', () => {
    const index = aux([MAIN, SUPP]);
    const without = planLabelPages(['fig:backbone_scaling'], index, PAGE_LABELS, evidence());
    const other = planLabelPages(
      ['fig:backbone_scaling'],
      index,
      PAGE_LABELS,
      evidence({ 'figure.caption.1': 1 }),
    );
    expect(other.failed).toEqual(without.failed);
    expect(labelRefusalMessage(other, index)).toBe(labelRefusalMessage(without, index));
  });

  it('resolves to the page the destination points at when the tree labels it "12"', () => {
    const index = aux([MAIN, SUPP]);
    const plan = planLabelPages(
      ['fig:backbone_scaling'],
      index,
      PAGE_LABELS,
      evidence({ 'figure.caption.40': 24 }),
    );
    expect(plan.failed).toEqual([]);
    expect(plan.resolved).toEqual([
      { label: 'fig:backbone_scaling', printedPage: '12', page: 24, via: 'destination' },
    ]);
    expect(plan.pages).toEqual([24]);
    const note = labelResolutionNote(plan);
    expect(note).toContain('fig:backbone_scaling -> page 24');
    expect(note).toContain('hyperref link target');
    expect(note).toContain("that page's /PageLabels entry is the printed page");
  });

  it('resolves with the shipout record agreeing, ignoring the other page shipped with 12', () => {
    const index = aux([MAIN, SUPP], { shipouts: SHIPOUTS });
    const plan = planLabelPages(
      ['fig:backbone_scaling'],
      index,
      PAGE_LABELS,
      evidence({ 'figure.caption.40': 24 }),
    );
    expect(plan.failed).toEqual([]);
    expect(plan.pages).toEqual([24]);
    expect(plan.shipoutsChecked).toBe(true);
  });

  it('refuses when the tree labels the destination page another number', () => {
    const index = aux([MAIN, SUPP]);
    const plan = planLabelPages(
      ['fig:backbone_scaling'],
      index,
      PAGE_LABELS,
      evidence({ 'figure.caption.40': 20 }),
    );
    expect(plan.failed).toEqual([
      expect.objectContaining({
        reason: 'ambiguousPrintedPage',
        destinationPage: 20,
        destinationContradiction: { kind: 'pageLabel', pageLabel: '8' },
      }),
    ]);
    const msg = labelRefusalMessage(plan, index);
    expect(msg).toContain('is on PDF page 20');
    expect(msg).toContain('labels that page "8", not "12"');
  });

  it('refuses when the shipout record shows another counter on the destination page', () => {
    const shipouts = [...SHIPOUTS];
    shipouts[23] = 13;
    const index = aux([MAIN, SUPP], { shipouts });
    const plan = planLabelPages(
      ['fig:backbone_scaling'],
      index,
      PAGE_LABELS,
      evidence({ 'figure.caption.40': 24 }),
    );
    expect(plan.failed).toEqual([
      expect.objectContaining({
        reason: 'ambiguousPrintedPage',
        destinationPage: 24,
        destinationContradiction: { kind: 'shipout', shipout: 13 },
      }),
    ]);
    expect(labelRefusalMessage(plan, index)).toContain('page counter 13, not "12"');
  });

  it('never moves a label the tree resolves on its own', () => {
    const index = aux([MAIN, ['fig:main_late', '3', '11', 'figure.caption.9']]);
    const labels = [...PAGE_LABELS];
    labels[22] = 'S11'; // only one page prints "11" now
    const plan = planLabelPages(
      ['fig:main_late'],
      index,
      labels,
      evidence({ 'figure.caption.9': 5 }),
    );
    expect(plan.resolved).toEqual([{ label: 'fig:main_late', printedPage: '11', page: 11 }]);
  });

  it('runs behind pgfpages evidence: true still refuses first', () => {
    const index = aux([MAIN, SUPP], { pgfpages: true });
    const plan = planLabelPages(
      ['fig:backbone_scaling'],
      index,
      PAGE_LABELS,
      evidence({ 'figure.caption.40': 24 }),
    );
    expect(plan.failed.map((f) => f.reason)).toEqual(['pgfpagesLayout']);
  });

  it('runs behind pgfpages evidence: unknown still refuses first', () => {
    const index = aux([MAIN, SUPP], { pgfpages: undefined });
    const plan = planLabelPages(
      ['fig:backbone_scaling'],
      index,
      PAGE_LABELS,
      evidence({ 'figure.caption.40': 24 }),
    );
    expect(plan.failed.map((f) => f.reason)).toEqual(['pgfpagesUnknown']);
  });

  it('runs behind the stale-PDF refusal', () => {
    const index = aux([MAIN, SUPP], { engineOutput: { kind: 'written', pages: 23 } });
    const plan = planLabelPages(
      ['fig:backbone_scaling'],
      index,
      PAGE_LABELS,
      evidence({ 'figure.caption.40': 24 }),
    );
    expect(plan.failed.map((f) => f.reason)).toEqual(['stalePdf']);
  });

  it('runs behind nothingShipped', () => {
    const index = aux([MAIN, SUPP], { shipouts: [] });
    const plan = planLabelPages(
      ['fig:backbone_scaling'],
      index,
      PAGE_LABELS,
      evidence({ 'figure.caption.40': 24 }),
    );
    expect(plan.failed.map((f) => f.reason)).toEqual(['nothingShipped']);
  });

  it('runs behind multiplyDefined', () => {
    const index = aux([MAIN, SUPP, ['fig:backbone_scaling', '10', '12', 'figure.caption.41']]);
    const plan = planLabelPages(
      ['fig:backbone_scaling'],
      index,
      PAGE_LABELS,
      evidence({ 'figure.caption.40': 24 }),
    );
    expect(plan.failed.map((f) => f.reason)).toEqual(['multiplyDefined']);
  });

  it('is never used for a beamer deck', () => {
    const index = aux([MAIN, SUPP], { beamerNav: true });
    const plan = planLabelPages(
      ['fig:backbone_scaling'],
      index,
      PAGE_LABELS,
      evidence({ 'figure.caption.40': 24 }),
    );
    expect(plan.resolved).toEqual([]);
    expect(plan.failed[0]?.destinationContradiction).toBeUndefined();
  });
});

describe('the destination route on the printed-page route (no /PageLabels tree)', () => {
  // The .aux shows the restart: printed page 12 in the main paper, then 3 in the supplement.
  const ROWS: Row[] = [
    ['fig:main', '1', '12', 'figure.caption.1'],
    ['fig:supp', '5', '3', 'figure.caption.30'],
  ];

  it('refuses as before without a destination', () => {
    const plan = planLabelPages(['fig:supp'], aux(ROWS), null, evidence());
    expect(plan.failed).toEqual([{ label: 'fig:supp', reason: 'restarted', printedPage: '3' }]);
  });

  it('resolves through the destination when that page reads the printed page', () => {
    const plan = planLabelPages(
      ['fig:supp'],
      aux(ROWS),
      null,
      evidence({ 'figure.caption.30': 15 }),
    );
    expect(plan.failed).toEqual([]);
    expect(plan.resolved).toEqual([
      { label: 'fig:supp', printedPage: '3', page: 15, via: 'destination' },
    ]);
    const note = labelResolutionNote(plan);
    expect(note).toContain('fig:supp -> page 15');
    expect(note).toContain('this PDF carries no /PageLabels tree');
    expect(note).not.toContain('a neighbouring page read as the adjacent number');
  });

  it('resolves with the shipout record agreeing even though page 3 shipped with 3 too', () => {
    const plan = planLabelPages(
      ['fig:supp'],
      aux(ROWS, { shipouts: SHIPOUTS }),
      null,
      evidence({ 'figure.caption.30': 15 }),
    );
    expect(plan.failed).toEqual([]);
    expect(plan.pages).toEqual([15]);
  });

  it('refuses when the destination page reads another number', () => {
    const index = aux(ROWS);
    const plan = planLabelPages(['fig:supp'], index, null, evidence({ 'figure.caption.30': 16 }));
    expect(plan.failed).toEqual([
      expect.objectContaining({
        reason: 'restarted',
        destinationPage: 16,
        destinationContradiction: { kind: 'folio', folios: ['4'] },
      }),
    ]);
    expect(labelRefusalMessage(plan, index)).toContain(
      'is on PDF page 16, but that page reads as page number "4", not "3"',
    );
  });

  it('accepts a page with no folio only when the shipout record confirms it', () => {
    const text = { ...TEXT, 15: ['Figure 5: Scaling', 'ViT-L 0.83'] };
    const unconfirmed = planLabelPages(
      ['fig:supp'],
      aux(ROWS),
      null,
      evidence({ 'figure.caption.30': 15 }, text),
    );
    expect(unconfirmed.failed).toEqual([
      expect.objectContaining({
        destinationPage: 15,
        destinationContradiction: { kind: 'uncorroborated' },
      }),
    ]);
    const confirmed = planLabelPages(
      ['fig:supp'],
      aux(ROWS, { shipouts: SHIPOUTS }),
      null,
      evidence({ 'figure.caption.30': 15 }, text),
    );
    expect(confirmed.pages).toEqual([15]);
  });

  it('refuses when the destination page text was not read', () => {
    const text = { ...TEXT };
    delete text[15];
    const plan = planLabelPages(
      ['fig:supp'],
      aux(ROWS, { shipouts: SHIPOUTS }),
      null,
      evidence({ 'figure.caption.30': 15 }, text),
    );
    expect(plan.failed[0]?.destinationContradiction).toEqual({ kind: 'noEvidence' });
  });

  it('resolves a restart the .aux shows no decrease for (lastPageMismatch) through it', () => {
    // Only the supplement label: no decrease to see, the candidate (main paper's page 3) reads
    // "3" with its neighbours agreeing, but the last page reads "12", not 24.
    const index = aux([['fig:supp', '5', '3', 'figure.caption.30']]);
    const without = planLabelPages(['fig:supp'], index, null, evidence());
    expect(without.failed.map((f) => f.unverified)).toEqual(['lastPageMismatch']);
    const plan = planLabelPages(['fig:supp'], index, null, evidence({ 'figure.caption.30': 15 }));
    expect(plan.resolved).toEqual([
      { label: 'fig:supp', printedPage: '3', page: 15, via: 'destination' },
    ]);
  });

  it('runs behind the stale-PDF refusal', () => {
    const index = aux(ROWS, { buildTimes: { auxMs: 2000, pdfMs: 1000 } });
    const plan = planLabelPages(['fig:supp'], index, null, evidence({ 'figure.caption.30': 15 }));
    expect(plan.failed.map((f) => f.reason)).toEqual(['stalePdf']);
  });

  it('runs behind pgfpages evidence', () => {
    const plan = planLabelPages(
      ['fig:supp'],
      aux(ROWS, { pgfpages: true }),
      null,
      evidence({ 'figure.caption.30': 15 }),
    );
    expect(plan.failed.map((f) => f.reason)).toEqual(['pgfpagesLayout']);
  });
});

describe('resolveLabelPages gathers what the destination route needs', () => {
  function reader(
    pageLabels: string[] | null,
    destinations: Record<string, number>,
  ): LabelPageReader & { asked: string[][]; read: number[][] } {
    const asked: string[][] = [];
    const read: number[][] = [];
    return {
      asked,
      read,
      pageLabels: () => Promise.resolve(pageLabels),
      pageCount: () => Promise.resolve(24),
      pageText: (pages) => {
        read.push(pages);
        return Promise.resolve(new Map(pages.map((p) => [p, TEXT[p] ?? []])));
      },
      destinationPages: (names: string[]) => {
        asked.push(names);
        return Promise.resolve(
          new Map(names.flatMap((n) => (n in destinations ? [[n, destinations[n]!]] : []))),
        );
      },
    };
  }

  it('asks the tree route only for labels whose printed page is ambiguous', async () => {
    const index = aux([MAIN, SUPP]);
    const labels = [...PAGE_LABELS];
    labels[0] = 'i'; // "1" is printed once now (PDF page 13): fig:teaser needs no destination
    const r = reader(labels, { 'figure.caption.1': 1, 'figure.caption.40': 24 });
    const plan = await resolveLabelPages(['fig:teaser', 'fig:backbone_scaling'], index, r);
    expect(r.asked).toEqual([['figure.caption.40']]);
    expect(plan.resolved).toEqual([
      { label: 'fig:teaser', printedPage: '1', page: 13 },
      { label: 'fig:backbone_scaling', printedPage: '12', page: 24, via: 'destination' },
    ]);
  });

  it('resolves the CVPR shape end to end through the tree route', async () => {
    const r = reader(PAGE_LABELS, { 'figure.caption.40': 24 });
    const plan = await resolveLabelPages(['fig:backbone_scaling'], aux([MAIN, SUPP]), r);
    expect(plan.pages).toEqual([24]);
    expect(r.read).toEqual([]);
  });

  it('reads the destination page on the printed-page route of a restarted document', async () => {
    const r = reader(null, { 'figure.caption.30': 15 });
    const index = aux([
      ['fig:main', '1', '12', 'figure.caption.1'],
      ['fig:supp', '5', '3', 'figure.caption.30'],
    ]);
    const plan = await resolveLabelPages(['fig:supp'], index, r);
    expect(r.read).toEqual([[15]]);
    expect(plan.pages).toEqual([15]);
  });

  it('asks nothing for a build refused as a whole', async () => {
    const r = reader(PAGE_LABELS, { 'figure.caption.40': 24 });
    const plan = await resolveLabelPages(
      ['fig:backbone_scaling'],
      aux([MAIN, SUPP], { pgfpages: true }),
      r,
    );
    expect(r.asked).toEqual([]);
    expect(plan.failed.map((f) => f.reason)).toEqual(['pgfpagesLayout']);
  });
});

describe('a destination is never trusted for an anchor another label shares', () => {
  // A supplement that resets the figure counter reuses the main paper's anchor: both labels are
  // `figure.1`, and the PDF keeps the FIRST destination (the main figure's, PDF page 12), whose
  // tree label "12", folio and shipout mark all agree with the supplement label's printed page.
  const MAIN_FIG: Row = ['fig:main', '1', '12', 'figure.1'];
  const SUPP_FIG: Row = ['fig:supp', 'S1', '12', 'figure.1'];

  it('refuses the /PageLabels destination route for a shared anchor, naming it', () => {
    const index = aux([MAIN_FIG, SUPP_FIG], { shipouts: SHIPOUTS });
    const plan = planLabelPages(['fig:supp'], index, PAGE_LABELS, evidence({ 'figure.1': 12 }));
    expect(plan.resolved).toEqual([]);
    expect(plan.failed).toEqual([
      expect.objectContaining({
        reason: 'ambiguousPrintedPage',
        destinationPage: 12,
        destinationContradiction: {
          kind: 'sharedAnchor',
          anchor: 'figure.1',
          labels: ['fig:main'],
        },
      }),
    ]);
    const msg = labelRefusalMessage(plan, index);
    expect(msg).toContain('anchor "figure.1" is also the anchor of "fig:main"');
    expect(msg).toContain('pass pages: explicitly');
  });

  it('refuses the printed-page destination route for a shared anchor', () => {
    const index = aux([
      ['fig:main', '1', '12', 'figure.1'],
      ['fig:supp', 'S1', '3', 'figure.1'],
    ]);
    const plan = planLabelPages(['fig:supp'], index, null, evidence({ 'figure.1': 3 }));
    expect(plan.failed).toEqual([
      expect.objectContaining({
        reason: 'restarted',
        destinationContradiction: expect.objectContaining({ kind: 'sharedAnchor' }),
      }),
    ]);
  });

  it('refuses when the .log reports a duplicate destination of that name', () => {
    const index = aux([MAIN, SUPP], { duplicateDestinations: new Set(['figure.caption.40']) });
    const plan = planLabelPages(
      ['fig:backbone_scaling'],
      index,
      PAGE_LABELS,
      evidence({ 'figure.caption.40': 24 }),
    );
    expect(plan.failed[0]?.destinationContradiction).toEqual({
      kind: 'duplicateDestination',
      anchor: 'figure.caption.40',
    });
    expect(labelRefusalMessage(plan, index)).toContain(
      'reports a duplicate destination named "figure.caption.40"',
    );
  });

  it('refuses when not every \\newlabel was read, so sharing cannot be ruled out', () => {
    const index = aux([MAIN, SUPP], { omitted: 3 });
    const plan = planLabelPages(
      ['fig:backbone_scaling'],
      index,
      PAGE_LABELS,
      evidence({ 'figure.caption.40': 24 }),
    );
    expect(plan.failed[0]?.destinationContradiction).toEqual({
      kind: 'anchorUnchecked',
      anchor: 'figure.caption.40',
    });
  });

  it('still resolves a unique anchor when the .log names other duplicates', () => {
    const index = aux([MAIN, SUPP], { duplicateDestinations: new Set(['page.1', 'figure.1']) });
    const plan = planLabelPages(
      ['fig:backbone_scaling'],
      index,
      PAGE_LABELS,
      evidence({ 'figure.caption.40': 24 }),
    );
    expect(plan.pages).toEqual([24]);
  });

  it('stops the #223 shortcut too: a shared anchor on the candidate page verifies nothing', () => {
    // No tree, no restart: fig:a's candidate page 4 has no folio, and its anchor's destination
    // lies there — but fig:b shares the anchor, so the text check decides, and refuses.
    const text: Record<number, string[]> = { ...TEXT, 4: ['Table 2: Results', 'Ours 0.83'] };
    const index = aux([
      ['fig:a', '2', '4', 'table.2'],
      ['fig:b', 'S2', '9', 'table.2'],
    ]);
    const shared = planLabelPages(['fig:a'], index, null, evidence({ 'table.2': 4 }, text));
    expect(shared.failed).toEqual([
      expect.objectContaining({
        unverified: 'noFolio',
        destinationContradiction: expect.objectContaining({ kind: 'sharedAnchor' }),
      }),
    ]);
    expect(labelRefusalMessage(shared, index)).toContain('"table.2"');
    const logged = planLabelPages(
      ['fig:a'],
      aux([['fig:a', '2', '4', 'table.2']], { duplicateDestinations: new Set(['table.2']) }),
      null,
      evidence({ 'table.2': 4 }, text),
    );
    expect(logged.failed.map((f) => f.unverified)).toEqual(['noFolio']);
    expect(logged.destinationVerified).toBeUndefined();
  });
});

describe('parseDuplicateDestinations', () => {
  it('reads pdfTeX’s warning wrapped at 79 columns, inside the text and inside the name', () => {
    const log = [
      '{/usr/share/texmf/fonts/map/pdftex/updmap/pdftex.map}]',
      'pdfTeX warning (ext4): destination with the same identifier (name{figure.1}) ha',
      's been already used, duplicate ignored',
      '<to be read again> ',
      'pdfTeX warning (ext4): destination with the same identifier (name{figure.capt',
      'ion.12}) has been already used, duplicate ignored',
    ].join('\n');
    expect([...parseDuplicateDestinations(log)]).toEqual(['figure.1', 'figure.caption.12']);
  });

  it('reads LuaTeX’s warning', () => {
    const log =
      "warning  (pdf backend): ignoring duplicate destination with the name 'figure.1'\n\n" +
      "warning  (pdf backend): ignoring duplicate destination with the name 'page.1'\n[1\n";
    expect([...parseDuplicateDestinations(log)]).toEqual(['figure.1', 'page.1']);
  });

  it('finds nothing in a log without one', () => {
    const log = 'This is pdfTeX\n[1] [2]\nOutput written on x.pdf (2 pages, 10 bytes).';
    expect(parseDuplicateDestinations(log).size).toBe(0);
  });
});

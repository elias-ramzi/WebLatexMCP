import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  labelRefusalMessage,
  labelResolutionNote,
  pagesToVerify,
  planLabelPages,
  resolveLabelPages,
  MAX_AMBIGUOUS_CANDIDATES,
} from '../../src/lib/labelPages.js';
import type {
  LabelPageEvidence,
  LabelPagePlan,
  LabelPageReader,
} from '../../src/lib/labelPages.js';
import { readAuxFloats } from '../../src/lib/auxFloats.js';
import type { AuxFloatsResult, AuxLabel } from '../../src/lib/auxFloats.js';
import { buildAuxPath, buildDir } from '../../src/services/compiler.js';

/**
 * The shipout-record cross-check: TeX writes `[<\count0>…]` into the `.log` each time it ships a
 * page out, so the k-th mark is the page counter PDF page k was shipped with. The check may only
 * turn an accepted label into a refusal — never choose, move or accept a page — and runs only when
 * the marks number exactly the PDF's pages.
 */
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/label-folio');

type Folio = Record<string, Record<string, string[]>>;
const FOLIO = JSON.parse(readFileSync(path.join(FIXTURES, 'pages.json'), 'utf8')) as Folio;

function pagesOf(doc: string): LabelPageEvidence {
  const text = new Map(Object.entries(FOLIO[doc]!).map(([p, l]) => [Number(p), l]));
  return { pageCount: text.size, text };
}

function truthPage(doc: string, label: string): number | undefined {
  const mark = 'MK' + label.replace(/[^A-Za-z0-9]/g, '');
  const hit = Object.entries(FOLIO[doc]!).find(([, lines]) => lines.some((l) => l.includes(mark)));
  return hit ? Number(hit[0]) : undefined;
}

function aux(
  entries: Array<[label: string, number: string, page: string]>,
  shipouts?: number[],
): AuxFloatsResult {
  const floats: AuxLabel[] = entries.map(([label, number, page]) => ({ label, number, page }));
  return {
    floats,
    omitted: 0,
    total: floats.length,
    dropped: 0,
    pgfpages: false,
    ...(shipouts ? { shipouts } : {}),
  };
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** `unshifted`: a plain article, figures on PDF pages 2 and 3, which print "2" and "3". */
const UNSHIFTED = [
  ['fig:a', '1', '2'],
  ['fig:b', '2', '3'],
] as Array<[string, string, string]>;

/** The PDF's page count as {@link planLabelPages} takes it on the /PageLabels route. */
function count(pageCount: number): LabelPageEvidence {
  return { pageCount, text: new Map() };
}

describe('the printed-page route refuses a page the log shipped under another counter', () => {
  let proj: string | undefined;
  afterEach(async () => {
    if (proj) {
      await rm(buildDir(proj), { recursive: true, force: true });
      await rm(proj, { recursive: true, force: true });
      proj = undefined;
    }
  });

  it('refuses the shifted table-bottom residual it used to resolve to the wrong page (real pdflatex)', async () => {
    // `tableBottomShifted.tex`: `[titlepage]` article, `\pagestyle{empty}`, and a tabular ending in
    // a bare cell at the foot of each page — the cell is the PDF page index (2, 3, 4). The title
    // page resets the counter, so figb (printed "2") is on PDF page 3, but PDF page 2's last line
    // reads "2" and PDF page 3's reads "3": the folio route accepted PDF page 2 for figb, 3 for figc
    // and 4 for figd — each one page early. The real .log shipped the pages as [1] [1] [2] [3] [4].
    proj = await mkdtemp(path.join(os.tmpdir(), 'shipouts-plan-'));
    await mkdir(buildDir(proj), { recursive: true });
    await writeFile(
      buildAuxPath(proj, 'main.tex'),
      readFileSync(path.join(FIXTURES, 'tableBottomShifted.aux')),
    );
    await writeFile(
      path.join(buildDir(proj), 'main.log'),
      readFileSync(path.join(FIXTURES, 'shipouts/tableBottomShifted-pdflatex.log.txt')),
    );
    const index = await readAuxFloats(proj, 'main.tex', { max: 20_000, shipouts: true });
    const ev = pagesOf('tableBottomShifted');
    const reader: LabelPageReader = {
      pageLabels: () => Promise.resolve(null),
      pageCount: () => Promise.resolve(ev.pageCount),
      pageText: (pages) => Promise.resolve(new Map(pages.map((p) => [p, ev.text.get(p) ?? []]))),
    };
    for (const [label, printed] of [
      ['figb', 2],
      ['figc', 3],
      ['figd', 4],
    ] as const) {
      expect(truthPage('tableBottomShifted', label), label).toBe(printed + 1);
      const plan = await resolveLabelPages([label], index, reader);
      expect(plan.resolved, label).toEqual([]);
      expect(plan.failed[0], label).toMatchObject({
        label,
        reason: 'unverifiedPage',
        unverified: 'shipoutMismatch',
        printedPage: String(printed),
        resolvedPage: printed,
        shipout: printed - 1,
        shipoutPages: [printed + 1],
        shipoutPagesOmitted: 0,
      });
    }
    const plan = await resolveLabelPages(['figb'], index, reader);
    const msg = labelRefusalMessage(plan, index);
    expect(msg).toContain(
      '"figb": the .aux records printed page "2", and PDF page 2 reads as "2" with a neighbour ' +
        "agreeing, but the log's shipout record says PDF page 2 was shipped out with page " +
        'counter 1, and page counter 2 was shipped out on PDF page 3 — so PDF page 2 is not ' +
        'confirmed to be printed page "2", and no page was assumed.',
    );
    expect(msg).toMatch(/records the page counter as each page is shipped out/);
    expect(msg).toMatch(/search extract_text's output/);
    expect(msg).toContain('pages:');
    expect(msg).not.toMatch(/prove/);
  });

  it('accepts exactly as before when every mark agrees', () => {
    const plan = planLabelPages(
      ['fig:a', 'fig:b'],
      aux(UNSHIFTED, range(1, 4)),
      null,
      pagesOf('unshifted'),
    );
    expect(plan.failed).toEqual([]);
    expect(plan.resolved).toEqual([
      { label: 'fig:a', printedPage: '2', page: 2 },
      { label: 'fig:b', printedPage: '3', page: 3 },
    ]);
  });

  it('refuses a printed page whose counter the log shows on more than one PDF page', () => {
    // A restart that left no decrease in the .aux and a last page reading the page count: the
    // counter 2 was shipped twice, so "printed page 2" is two pages.
    const plan = planLabelPages(
      ['fig:a', 'fig:b'],
      aux(UNSHIFTED, [1, 2, 3, 2]),
      null,
      pagesOf('unshifted'),
    );
    expect(plan.resolved).toEqual([]);
    expect(plan.failed).toEqual([
      expect.objectContaining({
        label: 'fig:a',
        unverified: 'shipoutMismatch',
        resolvedPage: 2,
        shipout: 2,
        shipoutPages: [2, 4],
      }),
    ]);
    const msg = labelRefusalMessage(plan, aux(UNSHIFTED));
    expect(msg).toContain(
      "but the log's shipout record shows page counter 2 on PDF page 2 and also on PDF page 4",
    );
  });

  it('caps the pages it names when one counter was shipped on many', () => {
    // Tree route: printed "9" is PDF page 9, shipped with counter 5, while counter 9 was shipped on
    // the fifteen pages after it. The list is capped like every other candidate list.
    const tree = [...range(1, 9).map(String), ...range(0, 14).map((i) => `z${i}`)];
    const shipouts = [...range(1, 8), 5, ...Array.from({ length: 15 }, () => 9)];
    const plan = planLabelPages(['fig:a'], aux([['fig:a', '1', '9']], shipouts), tree, count(24));
    expect(plan.failed[0]).toMatchObject({
      unverified: 'shipoutMismatch',
      shipout: 5,
      shipoutPages: range(10, 10 + MAX_AMBIGUOUS_CANDIDATES - 1),
      shipoutPagesOmitted: 15 - MAX_AMBIGUOUS_CANDIDATES,
    });
    expect(labelRefusalMessage(plan, aux([['fig:a', '1', '9']]))).toContain(
      'page counter 9 was shipped out on PDF pages 10, 11, 12, 13, 14, 15, 16, 17, and 7 more',
    );
  });

  it('does not check when the marks do not number exactly the PDF pages', () => {
    for (const shipouts of [[], range(1, 3), range(1, 5), [7, 1, 8, 2, 3, 4]]) {
      const plan = planLabelPages(
        ['fig:a', 'fig:b'],
        aux(UNSHIFTED, shipouts),
        null,
        pagesOf('unshifted'),
      );
      expect(plan.failed, JSON.stringify(shipouts)).toEqual([]);
      expect(plan.pages).toEqual([2, 3]);
    }
  });

  it('does not check when the log was not read', () => {
    const plan = planLabelPages(['fig:a', 'fig:b'], aux(UNSHIFTED), null, pagesOf('unshifted'));
    expect(plan.failed).toEqual([]);
    expect(plan.pages).toEqual([2, 3]);
  });
});

describe('the /PageLabels route refuses a page the log shipped under another counter', () => {
  it('refuses a tree lookup whose page was shipped with a different counter', () => {
    const plan = planLabelPages(
      ['fig:a'],
      aux([['fig:a', '1', '3']], [1, 2, 4, 5]),
      ['1', '2', '3', '4'],
      count(4),
    );
    expect(plan.labelSource).toBe('pageLabels');
    expect(plan.resolved).toEqual([]);
    expect(plan.failed).toEqual([
      {
        label: 'fig:a',
        reason: 'unverifiedPage',
        printedPage: '3',
        number: '1',
        unverified: 'shipoutMismatch',
        resolvedPage: 3,
        shipout: 4,
        shipoutPages: [],
        shipoutPagesOmitted: 0,
      },
    ]);
    const msg = labelRefusalMessage(plan, aux([['fig:a', '1', '3']]));
    expect(msg).toContain(
      'the PDF\'s /PageLabels tree puts printed page "3" on PDF page 3, but the log\'s shipout ' +
        'record says PDF page 3 was shipped out with page counter 4, and no PDF page was ' +
        'shipped out with page counter 3',
    );
    // The folio-route explanation would be false here: this PDF HAS a tree.
    expect(msg).not.toMatch(/This PDF has no \/PageLabels tree/);
  });

  it('accepts roman front matter under hyperref, whose arabic counters repeat the roman ones (real pdflatex)', () => {
    // `book` + hyperref, \frontmatter (6 roman pages) then \mainmatter: the real .log shipped
    // [1]..[6] [1]..[5], and the tree prints i..vi, 1..5. fig:a records "2", which the tree puts on
    // PDF page 8 — exactly — though counter 2 was also shipped on PDF page 2 (as "ii").
    const shipouts = [...range(1, 6), ...range(1, 5)];
    const tree = ['i', 'ii', 'iii', 'iv', 'v', 'vi', '1', '2', '3', '4', '5'];
    const plan = planLabelPages(
      ['fig:a', 'fig:b'],
      aux(
        [
          ['fig:a', '1.1', '2'],
          ['fig:b', '1.2', '4'],
        ],
        shipouts,
      ),
      tree,
      count(11),
    );
    expect(plan.failed).toEqual([]);
    expect(plan.pages).toEqual([8, 10]);
  });

  it('does not check a printed page that is not a decimal number', () => {
    const plan = planLabelPages(
      ['pre'],
      aux([['pre', '1', 'iv']], [9, 9, 9, 9, 9]),
      ['i', 'ii', 'iii', 'iv', '1'],
      count(5),
    );
    expect(plan.failed).toEqual([]);
    expect(plan.pages).toEqual([4]);
  });

  it('carries the page count it was given on either route', async () => {
    expect(planLabelPages(['fig:a'], aux([['fig:a', '1', '1']]), ['1'], count(1)).pageCount).toBe(
      1,
    );
    expect(
      planLabelPages(['fig:a', 'fig:b'], aux(UNSHIFTED), null, pagesOf('unshifted')).pageCount,
    ).toBe(4);
    const reader: LabelPageReader = {
      pageLabels: () => Promise.resolve(['1', '2', '3']),
      pageCount: () => Promise.resolve(3),
      pageText: () => Promise.resolve(new Map()),
    };
    const plan = await resolveLabelPages(['fig:a'], aux([['fig:a', '1', '2']], [1, 3, 3]), reader);
    // resolveLabelPages asks the PDF for its page count on the tree route too, so the check runs.
    expect(plan.pageCount).toBe(3);
    expect(plan.failed[0]).toMatchObject({ unverified: 'shipoutMismatch', shipout: 3 });
  });
});

describe('the shipout check only ever adds a refusal', () => {
  /** Every plan the two routes make over these inputs, with and without marks. */
  const CASES: Array<{
    name: string;
    labels: string[];
    index: AuxFloatsResult;
    tree: string[] | null;
    ev: LabelPageEvidence;
  }> = [
    {
      name: 'unshifted',
      labels: ['fig:a', 'fig:b'],
      index: aux(UNSHIFTED),
      tree: null,
      ev: pagesOf('unshifted'),
    },
    {
      name: 'titlepageShifted',
      labels: ['fig:a', 'fig:b'],
      index: aux(UNSHIFTED),
      tree: null,
      ev: pagesOf('titlepageShifted'),
    },
    {
      name: 'tree',
      labels: ['a', 'b', 'c'],
      index: aux([
        ['a', '1', '1'],
        ['b', '2', '3'],
        ['c', '3', 'ii'],
      ]),
      tree: ['i', 'ii', '1', '2', '3'],
      ev: count(5),
    },
  ];
  const MARKS: number[][] = [
    [1, 2, 3, 4],
    [1, 1, 2, 3],
    [2, 3, 4, 5],
    [3, 1, 2, 1, 3],
    [1, 2, 3, 4, 5],
    [5, 4, 3, 2, 1],
    [1, 1, 1, 1, 1],
  ];

  it('never accepts what the route refused, and never moves a resolved page', () => {
    for (const c of CASES) {
      for (const labels of [...c.labels.map((l) => [l]), c.labels]) {
        const before: LabelPagePlan = planLabelPages(labels, c.index, c.tree, c.ev);
        for (const shipouts of MARKS) {
          const after = planLabelPages(labels, { ...c.index, shipouts }, c.tree, c.ev);
          const tag = `${c.name} ${labels.join(',')} ${JSON.stringify(shipouts)}`;
          if (before.failed.length > 0) {
            // A refused call stays refused: every failure the route made is still there, and
            // the only failures added are the check's own.
            expect(after.resolved, tag).toEqual([]);
            expect(
              after.failed.filter((f) => f.unverified !== 'shipoutMismatch'),
              tag,
            ).toEqual(before.failed);
          } else if (after.failed.length === 0) {
            expect(after.resolved, tag).toEqual(before.resolved);
            expect(after.pages, tag).toEqual(before.pages);
          } else {
            expect(after.resolved, tag).toEqual([]);
            expect(
              after.failed.every((f) => f.unverified === 'shipoutMismatch'),
              tag,
            ).toBe(true);
          }
        }
      }
    }
  });
});

/** A real build's `.aux` and `.log` read back through `readAuxFloats`, as the tools read them. */
async function realIndex(
  auxFixture: string,
  logFixture: string,
): Promise<{
  index: AuxFloatsResult;
  cleanup: () => Promise<void>;
}> {
  const proj = await mkdtemp(path.join(os.tmpdir(), 'shipouts-real-'));
  await mkdir(buildDir(proj), { recursive: true });
  await writeFile(
    buildAuxPath(proj, 'main.tex'),
    readFileSync(path.join(FIXTURES, `${auxFixture}.aux`)),
  );
  await writeFile(
    path.join(buildDir(proj), 'main.log'),
    readFileSync(path.join(FIXTURES, `shipouts/${logFixture}.log.txt`)),
  );
  const index = await readAuxFloats(proj, 'main.tex', { max: 20_000, shipouts: true });
  return {
    index,
    cleanup: async () => {
      await rm(buildDir(proj), { recursive: true, force: true });
      await rm(proj, { recursive: true, force: true });
    },
  };
}

function readerOver(doc: string): LabelPageReader {
  const ev = pagesOf(doc);
  return {
    pageLabels: () => Promise.resolve(null),
    pageCount: () => Promise.resolve(ev.pageCount),
    pageText: (pages) => Promise.resolve(new Map(pages.map((p) => [p, ev.text.get(p) ?? []]))),
  };
}

const BODY = ['figa', 'figb', 'figc', 'figd'];

describe('a counter repeated under another page-number scheme is not a second printed page', () => {
  it.each([
    ['appendixAlph', 'appendixAlph-pdflatex'],
    ['appendixAlph', 'appendixAlph-lualatex'],
    ['suppPrefixed', 'suppPrefixed-pdflatex'],
    ['suppPrefixed', 'suppPrefixed-xelatex'],
  ])(
    '%s (%s log): every body label resolves to its own page, as it did before the log was read',
    async (doc, log) => {
      // No hyperref. The body is arabic 1-4; then `\pagenumbering{alph}` (or
      // `\setcounter{page}{1}` under `\thepage` = `S\arabic{page}`) resets the counter, so the
      // log ships [1] [2] [3] [4] [1] [2]. PDF pages 5 and 6 print "a"/"b" ("S1"/"S2"), so
      // counters 1 and 2 are no second "1" and "2", and figa/figb keep their pages.
      const { index, cleanup } = await realIndex(doc, log);
      try {
        expect(index.shipouts).toEqual([1, 2, 3, 4, 1, 2]);
        const plan = await resolveLabelPages(BODY, index, readerOver(doc));
        expect(plan.failed).toEqual([]);
        expect(plan.resolved.map((r) => r.page)).toEqual(BODY.map((l) => truthPage(doc, l)));
        expect(plan.pages).toEqual([1, 2, 3, 4]);
      } finally {
        await cleanup();
      }
    },
  );

  it('still refuses an arabic restart with no label before it (real pdflatex)', async () => {
    // Main paper 1-4 with one label (figa on 1), then `\setcounter{page}{1}` and a supplement
    // whose label suppb sits on its printed page 2 (PDF page 6); the last page is
    // `\thispagestyle{empty}`. The .aux reads 1, 2 — no decrease — and the last page shows no
    // number, so the folio route resolves suppb to PDF page 2, the main paper's. The log ships
    // [1] [2] [3] [4] [1] [2] [3], and PDF page 6 prints "2" as well: refused.
    const { index, cleanup } = await realIndex('restartUnlabelled', 'restartUnlabelled-pdflatex');
    try {
      const reader = readerOver('restartUnlabelled');
      expect(truthPage('restartUnlabelled', 'suppb')).toBe(6);
      const plan = await resolveLabelPages(['suppb'], index, reader);
      expect(plan.resolved).toEqual([]);
      expect(plan.failed).toEqual([
        expect.objectContaining({
          label: 'suppb',
          unverified: 'shipoutMismatch',
          resolvedPage: 2,
          shipout: 2,
          shipoutPages: [2, 6],
          shipoutPagesOmitted: 0,
        }),
      ]);
      expect(labelRefusalMessage(plan, index)).toContain(
        '"suppb": the .aux records printed page "2", and PDF page 2 reads as "2" with a ' +
          "neighbour agreeing, but the log's shipout record shows page counter 2 on PDF page 2 " +
          'and also on PDF page 6, which does not read as a page number in another style (a ' +
          'roman numeral, a letter, or a prefixed number such as "S2") — so PDF page 2 is not ' +
          'confirmed to be printed page "2", and no page was assumed.',
      );
      // The main paper's own label is refused too: PDF page 5 prints "1" again.
      const main = await resolveLabelPages(['figa'], index, reader);
      expect(main.failed[0]).toMatchObject({ unverified: 'shipoutMismatch', shipoutPages: [1, 5] });
    } finally {
      await cleanup();
    }
  });
});

describe('what a page shipped with the same counter must print to be no competitor', () => {
  /** Six pages: arabic 1-4 with figa on 1, then two pages shipped with counters 1, 2 whose
   *  text is `five`/`six` (absent = never read). */
  function evidence(
    five: string[] | undefined,
    six: string[] = ['Body text.', 'b'],
  ): { pageCount: number; text: Map<number, string[]> } {
    const text = new Map<number, string[]>([
      [1, ['1', 'Intro', 'Body text.', '1']],
      [2, ['Body text.', '2']],
      [3, ['Body text.', '3']],
      [4, ['Body text.', '4']],
      [6, six],
    ]);
    if (five) text.set(5, five);
    return { pageCount: 6, text };
  }
  const index = aux([['figa', '1', '1']], [1, 2, 3, 4, 1, 2]);

  it.each([
    ['alph', ['A', 'Extra', 'x', 'a']],
    ['Alph', ['Body text.', 'B']],
    ['alphalph', ['Body text.', 'aa']],
    ['roman', ['Body text.', 'i']],
    ['Roman', ['Body text.', 'I']],
    ['prefixed', ['Body text.', 'S1']],
    ['prefixed with a hyphen', ['Body text.', 'A-3']],
    ['prefixed foot form', ['Body text.', 'Page S-12']],
    ['running head', ['S1', 'SUPPLEMENT', 'Body text.', 'More body text.']],
  ])('%s: not a competitor', (_name, five) => {
    const plan = planLabelPages(['figa'], index, null, evidence(five));
    expect(plan.failed).toEqual([]);
    expect(plan.pages).toEqual([1]);
  });

  it.each([
    ['reads the same number', ['Body text.', '1']],
    [
      'reads another decimal number (which a section number or table cell can forge)',
      ['Body text.', '7'],
    ],
    ['reads nothing', ['Body text.', 'More body text.']],
    ['reads two ways', ['a', 'INTRO', 'i', 'body']],
    ['reads a mixed-case word', ['Body text.', 'Mix']],
    ['was never read', undefined],
  ])('%s: a competitor, refused', (_name, five) => {
    const plan = planLabelPages(['figa'], index, null, evidence(five));
    expect(plan.resolved).toEqual([]);
    expect(plan.failed[0]).toMatchObject({
      unverified: 'shipoutMismatch',
      resolvedPage: 1,
      shipout: 1,
      shipoutPages: [1, 5],
    });
  });

  it('never accepts on the strength of another page: a route refusal stays a refusal', () => {
    // PDF page 1 reads "7": the folio route refuses it, whatever page 5 prints.
    const ev = evidence(['Body text.', 'a']);
    ev.text.set(1, ['Body text.', '7']);
    const plan = planLabelPages(['figa'], index, null, ev);
    expect(plan.failed[0]).toMatchObject({ unverified: 'folioMismatch' });
  });
});

describe('pagesToVerify reads the pages shipped with the same counter', () => {
  const index = aux([['figa', '1', '1']], [1, 2, 3, 4, 1, 2]);

  it('adds them after the candidate and its neighbours, only when the check will run', () => {
    expect(pagesToVerify(['figa'], index, 6)).toEqual([1, 2, 5, 6]);
    // No marks, marks that do not number the PDF's pages, or a candidate shipped under another
    // counter (refused whatever the others print): nothing more is read.
    expect(pagesToVerify(['figa'], aux([['figa', '1', '1']]), 6)).toEqual([1, 2, 6]);
    expect(pagesToVerify(['figa'], aux([['figa', '1', '1']], [1, 2, 3, 1]), 6)).toEqual([1, 2, 6]);
    expect(pagesToVerify(['figa'], aux([['figa', '1', '1']], [2, 1, 3, 4, 1, 2]), 6)).toEqual([
      1, 2, 6,
    ]);
  });

  it('reads at most MAX_AMBIGUOUS_CANDIDATES of them per label, and refuses past the cap', () => {
    // Counter 1 on PDF page 1 and again on the eleven pages 3..13.
    const shipouts = [1, 2, ...Array.from({ length: 11 }, () => 1)];
    const idx = aux([['figa', '1', '1']], shipouts);
    const wanted = pagesToVerify(['figa'], idx, 13);
    expect(wanted).toEqual([1, 2, ...range(3, 2 + MAX_AMBIGUOUS_CANDIDATES), 13]);
    // Every page it read (3..10, and 13 as the last page) prints "a": 11 and 12, past the cap,
    // were never read, so they compete.
    const text = new Map<number, string[]>(wanted.map((p) => [p, ['Body text.', 'a']]));
    text.set(1, ['Body text.', '1']);
    text.set(2, ['Body text.', '2']);
    const plan = planLabelPages(['figa'], idx, null, { pageCount: 13, text });
    expect(plan.failed[0]).toMatchObject({
      unverified: 'shipoutMismatch',
      shipoutPages: [1, 11, 12],
    });
  });
});

describe('the shipout refusal compares the counter as a number', () => {
  it('names a repeated counter as repeated when the printed page has a leading zero', () => {
    // Printed page "02" is counter 2. PDF page 2 reads "02" (its neighbour "1" agrees) and was
    // shipped with counter 2 — so was PDF page 4, which reads "2".
    const text = new Map<number, string[]>([
      [1, ['Body text.', '1']],
      [2, ['Body text.', '02']],
      [3, ['Body text.', '3']],
      [4, ['Body text.', '2']],
      [5, ['Body text.', '5']],
    ]);
    const index = aux([['fig:a', '1', '02']], [1, 2, 3, 2, 5]);
    const plan = planLabelPages(['fig:a'], index, null, { pageCount: 5, text });
    expect(plan.failed[0]).toMatchObject({ shipout: 2, shipoutPages: [2, 4] });
    const msg = labelRefusalMessage(plan, index);
    expect(msg).toContain(
      "but the log's shipout record shows page counter 2 on PDF page 2 and also on PDF page 4",
    );
    expect(msg).not.toMatch(/shipped out with page counter 2, and page counter 02/);
  });
});

describe('the resolution note says whether the shipout record was checked', () => {
  it('names the record when it numbered the PDF pages, and says it was not used otherwise', () => {
    const checked = planLabelPages(
      ['fig:a', 'fig:b'],
      aux(UNSHIFTED, range(1, 4)),
      null,
      pagesOf('unshifted'),
    );
    expect(checked.shipoutsChecked).toBe(true);
    const note = labelResolutionNote(checked);
    expect(note).toMatch(/\.log recorded that PDF page as shipped out with that page counter/);
    expect(note).not.toMatch(/a restart whose last page shows no page number goes unseen/);
    for (const shipouts of [undefined, range(1, 3)]) {
      const unchecked = planLabelPages(
        ['fig:a', 'fig:b'],
        aux(UNSHIFTED, shipouts),
        null,
        pagesOf('unshifted'),
      );
      expect(unchecked.shipoutsChecked).toBeUndefined();
      const text = labelResolutionNote(unchecked);
      expect(text).toMatch(/shipout record was not used/);
      expect(text).toMatch(/a restart whose last page shows no page number goes unseen/);
    }
    const tree = planLabelPages(['fig:a'], aux([['fig:a', '1', '2']], [1, 2, 3]), ['1', '2', '3'], {
      pageCount: 3,
      text: new Map(),
    });
    expect(labelResolutionNote(tree)).toMatch(/for a decimal printed page, the build's \.log/);
  });
});

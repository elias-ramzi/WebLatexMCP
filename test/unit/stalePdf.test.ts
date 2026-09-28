import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  labelRefusalMessage,
  pagesToVerify,
  planLabelPages,
  resolveLabelPages,
} from '../../src/lib/labelPages.js';
import type { LabelPageEvidence, LabelPageReader } from '../../src/lib/labelPages.js';
import { readAuxFloats } from '../../src/lib/auxFloats.js';
import type { AuxFloatsResult } from '../../src/lib/auxFloats.js';
import { buildAuxPath, buildDir } from '../../src/services/compiler.js';

/**
 * #220: a build whose PDF is not the output of the last compile. With xelatex, an
 * error in the document BODY writes a new `.aux` and `.log` and never runs xdvipdfmx, so the
 * earlier run's PDF stays beside them — and a label looked up in that PDF lands on whatever the
 * OLD document had on that page. Every fixture here is real TeX Live 2026 output under latexmk
 * 4.88 (the `.log` files under `fixtures/label-folio/shipouts/`, and the old PDF's text layer,
 * read through `PdfRenderer.text`).
 *
 * The case, as reproduced: a 3-page document printing "A 1", "B 2", "C 3" is compiled, then
 * edited to `X\label{x}\newpage Y\label{a}\newpage\input{missingfile}` and compiled again.
 * xelatex stops (`Emergency stop.`) after shipping two pages, writes `main.xdv (2 pages)`, an
 * `.aux` putting `a` on printed page 2, and a `.log` shipping `[1] [2]` — and the 3-page PDF
 * stays. Before this, `a` resolved to PDF page 2, which shows "B".
 */
const SHIPOUTS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/label-folio/shipouts',
);
const log = (name: string): string =>
  readFileSync(path.join(SHIPOUTS, `${name}.log.txt`), 'latin1');

/** The earlier run's 3-page PDF, as `PdfRenderer.text` reads it: each page its letter and folio. */
const OLD_PDF = new Map<number, string[]>([
  [1, ['A', '1']],
  [2, ['B', '2']],
  [3, ['C', '3']],
]);
const oldPdf: LabelPageEvidence = { pageCount: 3, text: OLD_PDF };
const reader: LabelPageReader = {
  pageLabels: () => Promise.resolve(null),
  pageCount: () => Promise.resolve(3),
  pageText: (pages) => Promise.resolve(new Map(pages.map((p) => [p, OLD_PDF.get(p) ?? []]))),
};

/** The `.aux` the stopped xelatex run wrote (`\newlabel{x}{{}{1}…}`, `\newlabel{a}{{}{2}…}`). */
const FATAL_AUX = '\\relax \n\\newlabel{x}{{}{1}{}{}{}}\n\\newlabel{a}{{}{2}{}{}{}}\n';
/** The `.aux` an xelatex run that finished with an ORDINARY error wrote: three pages, like the
 *  old PDF, so the shipout marks number it exactly and agree with every label. */
const ERROR_AUX =
  '\\relax \n\\newlabel{x}{{}{1}{}{}{}}\n\\newlabel{a}{{}{2}{}{}{}}\n' +
  '\\newlabel{z}{{}{3}{}{}{}}\n\\gdef \\@abspage@last{3}\n';
/** The `.aux` of the earlier, finished build ("A 1", "B 2", "C 3"). */
const OLD_AUX =
  '\\relax \n\\newlabel{a}{{}{1}{}{}{}}\n\\newlabel{b}{{}{2}{}{}{}}\n' +
  '\\newlabel{c}{{}{3}{}{}{}}\n\\gdef \\@abspage@last{3}\n';

let proj: string | undefined;
afterEach(async () => {
  if (proj) {
    await rm(buildDir(proj), { recursive: true, force: true });
    await rm(proj, { recursive: true, force: true });
    proj = undefined;
  }
});

/**
 * Stage a build dir: the `.aux` and `.log` a run left, and the PDF beside them, with the PDF's
 * modification time `pdfAgeMs` before the `.aux`'s (negative: after it, as a finished compile
 * leaves them). Returns the PDF's path.
 */
async function stage(aux: string, logText: string, pdfAgeMs: number): Promise<string> {
  proj = await mkdtemp(path.join(os.tmpdir(), 'stalepdf-'));
  await mkdir(buildDir(proj), { recursive: true });
  const auxPath = buildAuxPath(proj, 'main.tex');
  const pdfPath = path.join(buildDir(proj), 'main.pdf');
  await writeFile(auxPath, aux);
  await writeFile(path.join(buildDir(proj), 'main.log'), logText, 'latin1');
  await writeFile(pdfPath, '%PDF-1.5 stand-in: the reader here is canned\n');
  const auxTime = new Date('2026-09-28T12:00:00Z');
  await utimes(auxPath, auxTime, auxTime);
  const pdfTime = new Date(auxTime.getTime() - pdfAgeMs);
  await utimes(pdfPath, pdfTime, pdfTime);
  return pdfPath;
}

describe('a PDF that is not the output of the last compile refuses every label', () => {
  it('xelatex stopped in the body after two pages: `a` is refused, not resolved to "B"', async () => {
    const pdfPath = await stage(FATAL_AUX, log('bodyFatal-xelatex'), 1_400);
    const index = await readAuxFloats(proj!, 'main.tex', {
      max: 20_000,
      shipouts: true,
      pdfPath,
    });
    // What the lookup used to run on: a readable record naming no pgfpages, and marks that
    // are not empty (so 'nothingShipped' does not fire) and do not number the 3-page PDF (so the
    // shipout check is off).
    expect(index.pgfpages).toBe(false);
    expect(index.shipouts).toEqual([1, 2]);
    const plan = await resolveLabelPages(['a', 'x'], index, reader);
    expect(plan.resolved).toEqual([]);
    expect(plan.pages).toEqual([]);
    expect(plan.failed).toEqual([
      { label: 'a', reason: 'stalePdf', printedPage: '2', number: '' },
      { label: 'x', reason: 'stalePdf', printedPage: '1', number: '' },
    ]);
    const msg = labelRefusalMessage(plan, index);
    expect(msg).toContain(
      '"a": the .aux records it on printed page "2", but the PDF beside it is not the output ' +
        'of the last compile: the .aux was written 1.4 s after the PDF, while a ' +
        "compile that finishes writes its .aux before its PDF; and the engine's closing line " +
        'in the .log says that run wrote 2 page(s) to its .xdv file, while the PDF has 3 ' +
        'page(s). No page was assumed.',
    );
    expect(msg).toContain(
      'Under xelatex, an error in the document body rewrites the .aux and .log and leaves the',
    );
    expect(msg).toContain("pass pages: [3] (the PDF's page count).");
    // The advice is given once, however many labels refuse.
    expect(msg.match(/The last compile did not produce the PDF on disk/g)).toHaveLength(1);
  });

  it('refuses on the closing record alone when the timestamps say nothing (a coarse clock)', async () => {
    // Same files, the two times equal: a filesystem with 1 s or 2 s timestamps can leave them so.
    const pdfPath = await stage(FATAL_AUX, log('bodyFatal-xelatex'), 0);
    const index = await readAuxFloats(proj!, 'main.tex', { max: 20_000, shipouts: true, pdfPath });
    const plan = await resolveLabelPages(['a'], index, reader);
    expect(plan.failed.map((f) => f.reason)).toEqual(['stalePdf']);
    const msg = labelRefusalMessage(plan, index);
    expect(msg).toContain('says that run wrote 2 page(s) to its .xdv file, while the PDF has 3');
    expect(msg).not.toMatch(/the \.aux was written/);
  });

  it('refuses on the timestamps alone when the stopped run shipped as many pages as the PDF has', async () => {
    // xelatex finishing with an ordinary error (`\undefinedmacro`): latexmk does not run
    // xdvipdfmx, so the 3-page PDF stays, and the new run shipped 3 pages too — its marks number
    // the PDF exactly and agree with every label, and its closing record agrees with the PDF's
    // page count. Only the order of the files shows it.
    const pdfPath = await stage(ERROR_AUX, log('bodyError-xelatex'), 1_388);
    const index = await readAuxFloats(proj!, 'main.tex', { max: 20_000, shipouts: true, pdfPath });
    expect(index.shipouts).toEqual([1, 2, 3]);
    const plan = await resolveLabelPages(['a'], index, reader);
    expect(plan.failed).toEqual([{ label: 'a', reason: 'stalePdf', printedPage: '2', number: '' }]);
    const msg = labelRefusalMessage(plan, index);
    expect(msg).toContain('the .aux was written 1.4 s after the PDF');
    expect(msg).not.toMatch(/closing line/);

    // The same files in the order a FINISHED build leaves them (the .aux closed in \enddocument,
    // before the PDF) resolve as they always did — the order is what decides, nothing else.
    const auxTime = new Date('2026-09-28T12:00:00Z');
    const after = new Date(auxTime.getTime() + 300);
    await utimes(pdfPath, after, after);
    const finished = await readAuxFloats(proj!, 'main.tex', {
      max: 20_000,
      shipouts: true,
      pdfPath,
    });
    expect(await resolveLabelPages(['a'], finished, reader)).toMatchObject({
      failed: [],
      resolved: [{ label: 'a', printedPage: '2', page: 2 }],
    });

    // And the timestamps are only consulted for a PDF the caller names: without one, or with one
    // that cannot be stat'd, they add nothing (the closing record agrees with the PDF here).
    await utimes(pdfPath, new Date(auxTime.getTime() - 1_388), new Date(auxTime.getTime() - 1_388));
    for (const opts of [{}, { pdfPath: `${pdfPath}.gone` }]) {
      const unpaired = await readAuxFloats(proj!, 'main.tex', {
        max: 20_000,
        shipouts: true,
        ...opts,
      });
      expect(unpaired.buildTimes).toBeUndefined();
      expect((await resolveLabelPages(['a'], unpaired, reader)).failed).toEqual([]);
    }
  });

  it('refuses a preamble stop that wrote mark-shaped text, by its closing record', async () => {
    // `\message{[1]}` and a `\typeout` of a forged `Output written on main.pdf (3 pages, …)` in
    // a preamble that then fails: the marks are not empty, so 'nothingShipped' does not fire, and
    // one mark does not number the 3-page PDF, so the shipout check is off. The .aux and PDF are
    // the earlier, finished run's (the .aux older), so the lookup used to run on the stopped
    // run's pgfpages evidence. The engine's closing line is the run's real verdict: no output.
    for (const [name, closing] of [
      ['forgedPreambleAbort-pdflatex', 'Fatal error occurred, no output PDF file produced!'],
      ['forgedPreambleAbort-xelatex', 'No pages of output.'],
      ['forgedPreambleAbort-lualatex', 'Fatal error occurred, no output PDF file produced!'],
    ] as const) {
      const pdfPath = await stage(OLD_AUX, log(name), -200);
      const index = await readAuxFloats(proj!, 'main.tex', {
        max: 20_000,
        shipouts: true,
        pdfPath,
      });
      expect(index.shipouts, name).toEqual([1]);
      const plan = await resolveLabelPages(['b'], index, reader);
      expect(plan.failed, name).toEqual([
        { label: 'b', reason: 'stalePdf', printedPage: '2', number: '' },
      ]);
      const msg = labelRefusalMessage(plan, index);
      expect(msg, name).toContain(`the engine's closing line in the .log is "${closing}`);
      expect(msg, name).not.toMatch(/the \.aux was written/);
      await rm(buildDir(proj!), { recursive: true, force: true });
      await rm(proj!, { recursive: true, force: true });
      proj = undefined;
    }
  });

  it('ignores an .aux newer by no more than the tolerance, and refuses one a millisecond past it', async () => {
    const pdfPath = await stage(OLD_AUX, log('bodyError-xelatex'), 250);
    const index = await readAuxFloats(proj!, 'main.tex', { max: 20_000, shipouts: true, pdfPath });
    const plan = await resolveLabelPages(['b'], index, reader);
    expect(plan.failed).toEqual([]);
    expect(plan.pages).toEqual([2]);

    const older = new Date(new Date('2026-09-28T12:00:00Z').getTime() - 251);
    await utimes(pdfPath, older, older);
    const past = await readAuxFloats(proj!, 'main.tex', { max: 20_000, shipouts: true, pdfPath });
    expect((await resolveLabelPages(['b'], past, reader)).failed.map((f) => f.reason)).toEqual([
      'stalePdf',
    ]);
  });
});

describe('where the stale-PDF refusal sits among the whole-build refusals', () => {
  const base = (over: Partial<AuxFloatsResult>): AuxFloatsResult => ({
    floats: [{ label: 'a', number: '1', page: '2' }],
    omitted: 0,
    total: 1,
    dropped: 0,
    pgfpages: false,
    engineOutput: { kind: 'written', pages: 2, ext: '.xdv' },
    ...over,
  });

  it('comes after pgfpagesLayout, pgfpagesUnknown and nothingShipped, on both routes', () => {
    const cases: Array<[Partial<AuxFloatsResult>, string]> = [
      [{ pgfpages: true }, 'pgfpagesLayout'],
      [{ pgfpages: undefined }, 'pgfpagesUnknown'],
      [{ shipouts: [] }, 'nothingShipped'],
      [{}, 'stalePdf'],
    ];
    for (const [over, reason] of cases) {
      const index = base(over);
      if ('pgfpages' in over && over.pgfpages === undefined) delete index.pgfpages;
      for (const tree of [null, ['1', '2', '3']]) {
        const plan = planLabelPages(['a', 'nope'], index, tree, oldPdf);
        expect(plan.failed, `${reason} ${tree ? 'tree' : 'folio'}`).toEqual([
          { label: 'a', reason, printedPage: '2', number: '1' },
          { label: 'nope', reason: 'notFound' },
        ]);
      }
    }
  });

  it('asks the reader for no page text, since no label can resolve', async () => {
    const index = base({});
    expect(pagesToVerify(['a'], index, 3)).toEqual([]);
    const read: number[][] = [];
    const plan = await resolveLabelPages(['a'], index, {
      ...reader,
      pageText: (p) => {
        read.push(p);
        return reader.pageText(p);
      },
    });
    expect(plan.failed.map((f) => f.reason)).toEqual(['stalePdf']);
    expect(read).toEqual([]);
  });
});

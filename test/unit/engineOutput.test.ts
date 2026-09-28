import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEngineOutput, parseShipoutMarks } from '../../src/lib/auxFloats.js';
import type { AuxFloatsResult } from '../../src/lib/auxFloats.js';
import {
  STALE_PDF_TOLERANCE_MS,
  staleBuildEvidence,
  staleRecordsText,
} from '../../src/lib/labelPages.js';
import { ROUTES_ONLY_LOG } from '../helpers/stagedLog.js';

/**
 * The engine's closing record in a `.log` (`parseEngineOutput`) and the stale-PDF evidence built
 * on it and on the files' timestamps (`staleBuildEvidence`) — #220. Every `.log` here is real TeX
 * Live output (`fixtures/label-folio/shipouts/`).
 */
const SHIPOUTS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/label-folio/shipouts',
);
const log = (file: string): string => readFileSync(path.join(SHIPOUTS, file), 'latin1');

/** The fixtures that record a run that did NOT finish, or whose marks were forged on purpose. */
const NOT_FINISHED = new Set([
  'forged-pdflatex.log.txt',
  'preambleAbort-pdflatex.log.txt',
  'forgedPreambleAbort-pdflatex.log.txt',
  'forgedPreambleAbort-xelatex.log.txt',
  'forgedPreambleAbort-lualatex.log.txt',
]);

describe('parseEngineOutput', () => {
  it('reads, in every finished real build, the page count its own shipout marks number', () => {
    // pdflatex, xelatex and lualatex; hyperref, beamer, \include, 130 pages, non-ASCII paths,
    // images, box warnings, error contexts — the closing record never disagrees with the
    // build's own marks, so it cannot refuse a finished build's PDF (which has that many pages).
    const files = readdirSync(SHIPOUTS).filter((f) => !NOT_FINISHED.has(f));
    expect(files.length).toBeGreaterThanOrEqual(35);
    for (const file of files) {
      const text = log(file);
      const out = parseEngineOutput(text);
      expect(out?.kind, file).toBe('written');
      expect(out?.kind === 'written' ? out.pages : undefined, file).toBe(
        parseShipoutMarks(text)?.length,
      );
      expect(out?.kind === 'written' ? out.ext : undefined, file).toBe(
        file.includes('-xelatex') ? '.xdv' : '.pdf',
      );
    }
  });

  it('reads the #220 run: xelatex stopped in the body after two pages', () => {
    // Its closing line is wrapped across three physical lines by the 79-column log width.
    expect(parseEngineOutput(log('bodyFatal-xelatex.log.txt'))).toEqual({
      kind: 'written',
      pages: 2,
      ext: '.xdv',
    });
    expect(parseEngineOutput(log('bodyError-xelatex.log.txt'))).toEqual({
      kind: 'written',
      pages: 3,
      ext: '.xdv',
    });
  });

  it("takes the engine's closing record over a forged one the document wrote before it", () => {
    // Each preamble `\typeout`s "Output written on main.pdf (3 pages, 9 bytes)." and then loads
    // a package that does not exist.
    for (const [file, kind] of [
      ['forgedPreambleAbort-pdflatex.log.txt', 'noPdf'],
      ['forgedPreambleAbort-xelatex.log.txt', 'noPages'],
      ['forgedPreambleAbort-lualatex.log.txt', 'noPdf'],
      ['preambleAbort-pdflatex.log.txt', 'noPdf'],
    ] as const) {
      const text = log(file);
      if (file.startsWith('forged')) {
        expect(text, file).toContain('Output written on main.pdf (3 pages, 9 bytes).');
      }
      expect(parseEngineOutput(text), file).toEqual({ kind });
    }
    // The xelatex log ends "…200000s" (exactly 79 columns) and then "No pages of output.", which
    // a wrap-rejoining reader glues into one line: read line by line, the closing record was
    // lost there and the forged line before it became the last.
    const tail = log('forgedPreambleAbort-xelatex.log.txt')
      .split('\n')
      .filter((l) => l !== '')
      .slice(-2);
    expect(tail[0]).toHaveLength(79);
    expect(tail[1]).toBe('No pages of output.');
  });

  it('reads a record split where the wrap width and the line length disagree', () => {
    const split =
      'This is XeTeX\n[1] [2]\nOutput written on /b/über/main.xdv (2 pa\nges, 576 bytes).\n';
    expect(parseEngineOutput(split)).toEqual({ kind: 'written', pages: 2, ext: '.xdv' });
  });

  it('gives undefined, never the record before it, when the last one cannot be read', () => {
    const text =
      'Output written on main.pdf (3 pages, 9 bytes).\n[1] [2]\nOutput written on main.pdf (two';
    expect(parseEngineOutput(text)).toBeUndefined();
  });

  it('gives undefined for a log with no closing record (a run killed before it closed)', () => {
    expect(parseEngineOutput(ROUTES_ONLY_LOG)).toBeUndefined();
    expect(parseEngineOutput('')).toBeUndefined();
  });

  it('names no extension it does not know, and reads "1 page" in the singular', () => {
    expect(parseEngineOutput('Output written on out/job.weird (1 page, 10 bytes).\n')).toEqual({
      kind: 'written',
      pages: 1,
    });
  });
});

describe('staleBuildEvidence', () => {
  const aux = (over: Partial<AuxFloatsResult>): AuxFloatsResult => ({
    floats: [],
    omitted: 0,
    total: 0,
    dropped: 0,
    ...over,
  });

  it('is undefined when nothing was recorded', () => {
    expect(staleBuildEvidence(aux({}), { pageCount: 3, hasPages: true })).toBeUndefined();
  });

  it('fires on an .aux newer than the PDF past the tolerance, never at or under it', () => {
    const at = (newer: number) =>
      staleBuildEvidence(aux({ buildTimes: { auxMs: 10_000 + newer, pdfMs: 10_000 } }), {
        hasPages: true,
      });
    expect(at(-500)).toBeUndefined();
    expect(at(0)).toBeUndefined();
    expect(at(STALE_PDF_TOLERANCE_MS)).toBeUndefined();
    expect(at(STALE_PDF_TOLERANCE_MS + 0.5)).toEqual({ auxNewerByMs: 251 });
    expect(at(1_400)).toEqual({ auxNewerByMs: 1_400 });
  });

  it('fires on a closing record that disagrees with the PDF, and only then', () => {
    const written = aux({ engineOutput: { kind: 'written', pages: 2, ext: '.xdv' } });
    expect(staleBuildEvidence(written, { pageCount: 2, hasPages: true })).toBeUndefined();
    expect(staleBuildEvidence(written, { pageCount: 3, hasPages: true })).toEqual({
      logOutput: { kind: 'written', pages: 2, ext: '.xdv' },
      pageCount: 3,
    });
    // A written count with no page count to compare with says nothing.
    expect(staleBuildEvidence(written, { hasPages: true })).toBeUndefined();
    for (const kind of ['noPages', 'noPdf'] as const) {
      const none = aux({ engineOutput: { kind } });
      expect(staleBuildEvidence(none, { pageCount: 3, hasPages: true }), kind).toEqual({
        logOutput: { kind },
        pageCount: 3,
      });
      expect(staleBuildEvidence(none, { pageCount: 0, hasPages: false }), kind).toBeUndefined();
      // Without a page count, a PDF that exists stands in for one with pages.
      expect(staleBuildEvidence(none, { hasPages: true }), kind).toEqual({ logOutput: { kind } });
      expect(staleBuildEvidence(none, { hasPages: false }), kind).toBeUndefined();
    }
  });

  it('says what each record shows, and only the records that fired', () => {
    expect(
      staleRecordsText({
        auxNewerByMs: 1_896,
        logOutput: { kind: 'written', pages: 2, ext: '.xdv' },
        pageCount: 3,
      }),
    ).toBe(
      'the .aux was written 1.9 s after the PDF, while a compile that finishes writes its .aux ' +
        "before its PDF; and the engine's closing line in the .log says that run wrote 2 " +
        'page(s) to its .xdv file, while the PDF has 3 page(s)',
    );
    expect(staleRecordsText({ logOutput: { kind: 'noPages' } })).toBe(
      'the engine\'s closing line in the .log is "No pages of output.", while the PDF has pages',
    );
    expect(staleRecordsText({ logOutput: { kind: 'noPdf' }, pageCount: 2 })).toBe(
      'the engine\'s closing line in the .log is "Fatal error occurred, no output PDF file ' +
        'produced!", while a PDF with 2 page(s) is beside it',
    );
  });
});

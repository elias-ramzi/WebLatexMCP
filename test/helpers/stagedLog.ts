import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The `.log` the integration tests stage beside a hand-written `.aux` when the test is about the
 * label ROUTES, not the log. A STAND-IN, not a realistic log, and it has to be one:
 *
 *  - some log must be there, or the build has no record at all and every label is refused as
 *    `'pgfpagesUnknown'`; this one is non-empty and names no pgfpages, so the evidence reads
 *    `false` and the routes run;
 *  - its shipout marks must not be USED. A real log numbers every page it shipped, so it would
 *    have to match each test's PDF page count, which the staging helpers do not know; and the
 *    obvious banner-only log holds no mark at all, which beside a PDF with pages is a compile
 *    that shipped nothing — every label refused as `'nothingShipped'`. So its one mark is cut
 *    across a line (`[1` then `2]`), the shape `parseShipoutMarks` refuses to guess at: the parse
 *    gives up, `shipouts` is absent, and neither the shipout check nor the no-page refusal runs.
 *
 * A test about the marks stages a log that carries them (see {@link PREAMBLE_ABORT_LOG}, and the
 * `[1] [2] …` logs in `renderPages.test.ts` and `extractText.test.ts`).
 */
export const ROUTES_ONLY_LOG = 'This is pdfTeX, Version 3.141592653\n[1\n2]\n';

/**
 * A REAL pdflatex `.log` of a compile that stopped in the preamble (`\usepackage{doesnotexist}`
 * above `\usepackage{pgfpages}`): it holds no shipout mark and names no pgfpages. pdflatex leaves
 * the earlier run's `.aux` and PDF beside it, so a label lookup must refuse (`'nothingShipped'`).
 */
export const PREAMBLE_ABORT_LOG = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../fixtures/label-folio/shipouts/preambleAbort-pdflatex.log.txt',
  ),
  'latin1',
);

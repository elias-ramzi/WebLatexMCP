/**
 * Resolving a `\label` to the page `render_pages` should rasterize, out of the label index the
 * LAST COMPILE left in the build-directory `.aux`.
 *
 * Why this is a lib and not a few lines in the tool: every interesting part of it is a refusal,
 * and a refusal is exactly the thing that has to be unit-testable without a live MCP client, a
 * compiled PDF, or a TeX install. The tool layer reads the `.aux` (through `readAuxFloats`, the
 * same reader `pdf_geometry`'s "floats" kind uses — there is one `.aux` parser in this codebase
 * and this file is not a second one), hands the parsed result here, and maps the plan onto
 * response shapes. Everything below is pure over plain data: no fs, no clock, no process.
 *
 * Three facts govern the whole design, and each of them is a place where guessing would be worse
 * than refusing:
 *
 *  1. **The `.aux` reflects the last compile, never the working tree.** A label added since, one
 *     that moved, or one whose reference has not converged yet (LaTeX's "Label(s) may have
 *     changed. Rerun to get cross-references right.") resolves to a stale page — or not at all.
 *     Nothing here can detect that, so every successful resolution carries
 *     {@link labelResolutionNote} saying where the number came from, and the one symptom that IS
 *     detectable — a resolved page past the end of the PDF actually on disk — is reported with
 *     {@link labelPageRangeMessage} rather than as a bare renderer range error.
 *
 *  2. **The `.aux` records the PRINTED page, and `render_pages` wants a 1-based PDF page index.**
 *     They coincide for a document with one arabic numbering scheme, which is every paper this
 *     tool was built for, and they do NOT coincide the moment `\pagenumbering{roman}` front
 *     matter (or `\frontmatter`) shifts the arabic run later into the file. There is no offset to
 *     compute from the `.aux` alone: it records what was printed, never how many pages preceded
 *     it. So a printed page that is not a decimal integer is refused outright
 *     (`'notAPageNumber'`), and a document that shows POSITIVE EVIDENCE of renumbering — any
 *     label in its own index printing as a roman numeral — refuses even its arabic labels
 *     (`'renumbered'`), because those are precisely the ones whose printed number would render
 *     the wrong page while looking perfectly reasonable. Both refusals name the escape hatch: read
 *     the index with `pdf_geometry kinds: ["floats"]` and pass `pages:` explicitly.
 *
 *     The residual, stated rather than hidden: a scheme that is neither decimal nor roman
 *     (`\pagenumbering{alph}`, or a `thesis`-style `A-3`) is caught for the requested label itself
 *     (it is not a decimal integer) but is NOT evidence this code recognizes for the
 *     document-wide `'renumbered'` refusal, so an arabic label in such a document can still
 *     resolve to an offset page. Closing that properly means reading the PDF's own `/PageLabels`
 *     tree (pdf.js exposes it as `getPageLabels()`), which is a change to the render service, not
 *     to this file.
 *
 *  3. **An assertion, never an inference.** If a label cannot be resolved, the whole call refuses
 *     ({@link labelRefusalMessage}) — it never renders the labels it did resolve and quietly drops
 *     the rest, and it never falls back to page 1. A partially-honoured request would be read as
 *     "here is your table" while showing a different page's table, which is the exact failure this
 *     feature exists to prevent.
 */

import type { AuxFloatsResult, AuxLabel } from './auxFloats.js';

/**
 * How many labels one call may name. Bounded because every one of them is echoed back in the
 * result (and each carries a printed page out of the document-controlled `.aux`), and because
 * `render_pages` rasterizes at most `MAX_PAGES_PER_CALL` (8) pages anyway — past that the pages
 * land in `skippedPages` and the render is a partial answer regardless. 16 leaves room for several
 * labels sharing a page (two subfigures of one float, a table and its discussion) without the cap
 * firing on a request that would have rendered fine.
 */
export const MAX_LABELS_PER_CALL = 16;

/**
 * The entry cap handed to `readAuxFloats` for a label lookup, deliberately far above its own
 * `DEFAULT_MAX_FLOATS` (200). That default bounds a REPORT — `pdf_geometry` prints the index — but
 * here the index is only searched, and one entry is returned per label the caller already named.
 * A real manuscript clears 200 labels easily (every section, equation and subfigure is one), and
 * under the reporting cap a lookup would come back "no such label" for a label that is plainly in
 * the file: a wrong answer, not a truncated one. The reader's own `PARSE_BOUND` (50000 markers)
 * and per-field cap (200 characters) still bound the work and the memory, so this is a bound on
 * what is retained, not the only bound in play; `omitted` is still reported and
 * {@link labelRefusalMessage} names it, so a lookup that DOES fall past even this cap says so
 * instead of claiming the label is undefined.
 */
export const LABEL_LOOKUP_MAX = 20_000;

export interface ResolvedLabel {
  /** The `\label{...}` key, exactly as the caller named it. */
  label: string;
  /** The printed page the `.aux` records for it, verbatim (e.g. `"3"`). */
  printedPage: string;
  /** The 1-based PDF page index rendered for it — the printed page read as a decimal integer. */
  page: number;
}

/**
 * Why one label could not be turned into a page. Counted apart rather than collapsed into one
 * "unresolved", because the caller's next move differs: `'notFound'` usually means "compile
 * again", while the other two mean "this document's printed pages are not PDF page indices — pass
 * `pages:` yourself".
 */
export type LabelFailureReason = 'notFound' | 'notAPageNumber' | 'renumbered';

export interface LabelFailure {
  label: string;
  reason: LabelFailureReason;
  /** The printed page the `.aux` recorded, for the two reasons that HAVE one. */
  printedPage?: string;
}

export interface LabelPagePlan {
  /** One entry per distinct label that resolved, in request order. Empty when anything failed. */
  resolved: ResolvedLabel[];
  /** Every label that did not resolve, in request order. Non-empty means the call must refuse. */
  failed: LabelFailure[];
  /** The pages to render: `resolved`'s pages, deduplicated, in request order. */
  pages: number[];
  /** The label whose roman printed page is the evidence behind a `'renumbered'` failure. */
  renumberedBy?: AuxLabel;
}

/** A printed page usable as a 1-based PDF page index. Bounded in width so a hostile `.aux` cannot
 *  hand back a page number that is not a safe integer. */
const DECIMAL_PAGE = /^[0-9]{1,7}$/;

/** Strict roman numeral, upper or lower case (`\pagenumbering{roman}` and `{Roman}`). All groups
 *  are optional, so the empty string matches — {@link isRomanPage} rejects that separately. */
const ROMAN_PAGE = /^m{0,4}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;

/** Whether a printed page is a roman numeral — the one renumbering scheme this code can recognize
 *  from the `.aux` alone, and therefore the only positive evidence behind a `'renumbered'`
 *  refusal. Never a claim that a page failing this test is arabic. */
export function isRomanPage(page: string): boolean {
  return page.length > 0 && ROMAN_PAGE.test(page);
}

/** The printed page as a 1-based PDF page index, or `undefined` when it is not a decimal integer
 *  at all (`"iv"`, `"A-3"`, `"\hbox {3}"`, `""`) or is not a usable page number (`"0"`). */
export function parsePrintedPage(page: string): number | undefined {
  if (!DECIMAL_PAGE.test(page)) {
    return undefined;
  }
  const n = Number.parseInt(page, 10);
  return n >= 1 ? n : undefined;
}

/**
 * Plan the pages for a list of labels against a parsed `.aux` index.
 *
 * Duplicate labels in the request are collapsed (first occurrence wins, request order kept), and
 * so are duplicate pages — two labels on one page render that page once, while both still appear
 * in `resolved`, because the caller asked about two things and deserves both answers. A label
 * defined twice in the `.aux` (LaTeX's "multiply defined" warning) resolves to its FIRST record,
 * which is the one `\ref` would print.
 *
 * `resolved` is emptied when anything failed: a caller must never receive a half-honoured render.
 */
export function planLabelPages(labels: string[], aux: AuxFloatsResult): LabelPagePlan {
  const index = new Map<string, AuxLabel>();
  for (const entry of aux.floats) {
    if (!index.has(entry.label)) {
      index.set(entry.label, entry);
    }
  }
  const renumberedBy = aux.floats.find((entry) => isRomanPage(entry.page));

  const resolved: ResolvedLabel[] = [];
  const failed: LabelFailure[] = [];
  const pages: number[] = [];
  const seenLabel = new Set<string>();
  const seenPage = new Set<number>();

  for (const label of labels) {
    if (seenLabel.has(label)) {
      continue;
    }
    seenLabel.add(label);

    const entry = index.get(label);
    if (!entry) {
      failed.push({ label, reason: 'notFound' });
      continue;
    }
    const page = parsePrintedPage(entry.page);
    if (page === undefined) {
      // Checked BEFORE the document-wide renumbering verdict: this label's own printed page is
      // the more specific fact, and naming it ("prints as iv") tells the caller more than the
      // evidence label would.
      failed.push({ label, reason: 'notAPageNumber', printedPage: entry.page });
      continue;
    }
    if (renumberedBy) {
      failed.push({ label, reason: 'renumbered', printedPage: entry.page });
      continue;
    }
    resolved.push({ label, printedPage: entry.page, page });
    if (!seenPage.has(page)) {
      seenPage.add(page);
      pages.push(page);
    }
  }

  if (failed.length > 0) {
    return { resolved: [], failed, pages: [], renumberedBy };
  }
  return { resolved, failed, pages, renumberedBy };
}

function quoteLabel(label: string): string {
  return JSON.stringify(label);
}

/**
 * The refusal text for a plan with any failure — one line per failed label, then what to do.
 * Only ever called when `plan.failed` is non-empty; nothing is rendered when it is.
 */
export function labelRefusalMessage(plan: LabelPagePlan, aux: AuxFloatsResult): string {
  const lines: string[] = [
    `Could not resolve ${plan.failed.length} label(s) to a page through the build-directory ` +
      '.aux of the last compile:',
  ];
  for (const failure of plan.failed) {
    if (failure.reason === 'notFound') {
      lines.push(`  - ${quoteLabel(failure.label)}: no \\newlabel for it in the .aux.`);
      continue;
    }
    if (failure.reason === 'notAPageNumber') {
      lines.push(
        `  - ${quoteLabel(failure.label)}: the .aux records its printed page as ` +
          `${quoteLabel(failure.printedPage ?? '')}, which is not a decimal page number, so it ` +
          'cannot be used as a 1-based PDF page index.',
      );
      continue;
    }
    lines.push(
      `  - ${quoteLabel(failure.label)}: prints on page ${quoteLabel(failure.printedPage ?? '')}, ` +
        `but this document renumbers its pages — ${quoteLabel(plan.renumberedBy?.label ?? '')} ` +
        `prints on ${quoteLabel(plan.renumberedBy?.page ?? '')} — so a printed page is not the ` +
        'PDF page index here and the offset cannot be computed from the .aux.',
    );
  }

  if (plan.failed.some((f) => f.reason === 'notFound')) {
    if (aux.note) {
      lines.push(`  ${aux.note}`);
    }
    if (aux.omitted > 0) {
      lines.push(
        `  Note: the label index was capped at ${aux.floats.length} entries and ${aux.omitted} ` +
          'more were not searched, so a missing label may be past the cap rather than undefined.',
      );
    }
    if (aux.dropped > 0) {
      lines.push(
        `  Note: ${aux.dropped} \\newlabel entr(ies) in the .aux were unreportable (a field or ` +
          'group past the parser’s cap) and were not searched.',
      );
    }
    lines.push(
      '  A label added, moved, or whose reference has not converged yet ("Label(s) may have ' +
        'changed. Rerun to get cross-references right.") is absent until the next compile — ' +
        'compile again and retry.',
    );
  }
  lines.push(
    '  Nothing was rendered and no page was guessed. To choose a page yourself, read the index ' +
      'with pdf_geometry kinds: ["floats"] and pass pages: explicitly.',
  );
  return lines.join('\n');
}

/** `label -> page` pairs, for a one-line summary in a result's text channel and note. */
export function describeResolvedLabels(resolved: ResolvedLabel[]): string {
  return resolved.map((r) => `${r.label} -> page ${r.page}`).join(', ');
}

/**
 * The caveat attached to every successful label resolution. It is not decoration: the number came
 * out of the last compile's `.aux`, and nothing in this process can tell whether the source has
 * moved since, so the result must say so rather than presenting a live page.
 */
export function labelResolutionNote(plan: LabelPagePlan): string {
  return (
    `Pages resolved from labels through the build-directory .aux of the LAST COMPILE ` +
    `(${describeResolvedLabels(plan.resolved)}), which records each label's PRINTED page. That ` +
    'is the PDF page index only while the document numbers its pages in one arabic run — a ' +
    'renumbered document (roman front matter) is refused rather than guessed. Edits since that ' +
    'compile, and references that have not converged, are not reflected: recompile if the page ' +
    'looks wrong.'
  );
}

/**
 * Enriches the renderer's own out-of-range error when the page came from a label. The bare
 * message ("Page 9 is out of range: this document has 3 page(s).") is true but blames the caller
 * for a number they never chose — this names where the number came from and what to do.
 */
export function labelPageRangeMessage(plan: LabelPagePlan, cause: string): string {
  return (
    `${cause} That page was resolved from a label through the build-directory .aux of the last ` +
    `compile (${describeResolvedLabels(plan.resolved)}), so that .aux is stale relative to the ` +
    'PDF on disk — the document got shorter since. Compile again, then retry.'
  );
}

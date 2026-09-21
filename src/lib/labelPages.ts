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
 * Four facts govern the whole design, and each of them is a place where guessing would be worse
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
 *     The PDF itself can settle that conversion exactly: a `/PageLabels` number tree maps page
 *     index -> printed label for every page, whatever the numbering scheme, and pdf.js hands it
 *     over as `getPageLabels()`. When the render service supplies that array
 *     ({@link planLabelPages}'s third argument), resolution is a LOOKUP — printed page from the
 *     `.aux`, page index from the array — and nothing about renumbering is inferred at all. This
 *     file never reaches for it: the map arrives as plain data, which is what keeps every refusal
 *     below unit-testable without pdf.js, a compiled PDF or a TeX install.
 *
 *     Two refusals belong to that path, and both are cases where a number IS available and using
 *     it would be wrong. A printed page **absent** from `/PageLabels` (`'printedPageAbsent'`) is
 *     the `.aux` being stale relative to the PDF on disk, NOT an undefined label — the label was
 *     found, its page just is not printed anywhere in this document any more. And a printed page
 *     that `/PageLabels` maps to **more than one** page (`'ambiguousPrintedPage'`) is legitimate —
 *     a restarted `\pagenumbering`, or an unnumbered front page — so taking the first match would
 *     re-create the wrong-page failure by another route; both candidates are named instead.
 *
 *  3. **Without `/PageLabels` the conversion is inferred, and the inference refuses rather than
 *     guesses.** `getPageLabels()` returning `null` is the COMMON case, not an error: a plain
 *     `article` carries no such tree, and there the printed page IS the page index — precisely
 *     because nothing renumbered. So the fallback keeps the two heuristic refusals it always had:
 *     a printed page that is not a decimal integer is refused outright (`'notAPageNumber'`), and a
 *     document that shows POSITIVE EVIDENCE of renumbering — any label in its own index printing
 *     as a roman numeral — refuses even its arabic labels (`'renumbered'`), because those are
 *     precisely the ones whose printed number would render the wrong page while looking perfectly
 *     reasonable. Both refusals name the escape hatch: read the index with
 *     `pdf_geometry kinds: ["floats"]` and pass `pages:` explicitly.
 *
 *     The residual this fallback still carries, stated rather than hidden: a scheme that is
 *     neither decimal nor roman (`\pagenumbering{alph}`, a `thesis`-style `A-3`) is caught for the
 *     requested label itself but is not evidence the `'renumbered'` verdict recognizes, so an
 *     arabic label in such a document can still resolve to an offset page. That is why a document
 *     numbered that way should carry `/PageLabels` — `hyperref` writes one — and why fact 2 is the
 *     real answer and this one only the floor under it.
 *
 *  4. **An assertion, never an inference.** If a label cannot be resolved, the whole call refuses
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

/**
 * How many PDF pages an `'ambiguousPrintedPage'` failure names before it starts counting instead.
 * Bounded because the candidate list comes out of a document-controlled `/PageLabels` tree, where
 * nothing stops every page of a long document from printing the same string; two candidates are
 * already enough to prove the lookup is ambiguous, and the rest are a count.
 */
export const MAX_AMBIGUOUS_CANDIDATES = 8;

export interface ResolvedLabel {
  /** The `\label{...}` key, exactly as the caller named it. */
  label: string;
  /** The printed page the `.aux` records for it, verbatim (e.g. `"3"`). */
  printedPage: string;
  /**
   * The 1-based PDF page index resolved for it: the page the PDF's own `/PageLabels` tree prints
   * `printedPage` on, or — when the document carries no such tree — the printed page read as a
   * decimal integer. {@link LabelPagePlan.labelSource} says which of the two it was.
   */
  page: number;
}

/**
 * Why one label could not be turned into a page. Counted apart rather than collapsed into one
 * "unresolved", because the caller's next move differs: `'notFound'` and `'printedPageAbsent'`
 * both mean "compile again" (the label is missing from the `.aux`, or the `.aux` is stale
 * relative to the PDF), while `'notAPageNumber'`, `'renumbered'` and `'ambiguousPrintedPage'`
 * mean "this document's printed pages are not usable as PDF page indices — pass `pages:`
 * yourself".
 *
 * Which reasons are even reachable depends on how the plan was resolved: `'notAPageNumber'` and
 * `'renumbered'` belong to the inferred fallback, `'printedPageAbsent'` and
 * `'ambiguousPrintedPage'` to the `/PageLabels` lookup. `'notFound'` belongs to both.
 */
export type LabelFailureReason =
  | 'notFound'
  | 'notAPageNumber'
  | 'renumbered'
  | 'printedPageAbsent'
  | 'ambiguousPrintedPage';

export interface LabelFailure {
  label: string;
  reason: LabelFailureReason;
  /** The printed page the `.aux` recorded, for every reason except `'notFound'`. */
  printedPage?: string;
  /**
   * `'ambiguousPrintedPage'` only: the 1-based PDF pages that print `printedPage`, in page order,
   * at most {@link MAX_AMBIGUOUS_CANDIDATES} of them.
   */
  candidatePages?: number[];
  /** `'ambiguousPrintedPage'` only: how many further candidates the cap left out of the list. */
  candidatePagesOmitted?: number;
}

/** Where a plan's page numbers came from — reported rather than implied, because the two routes
 *  carry different caveats and {@link labelResolutionNote} has to state the right one. */
export type LabelSource = 'pageLabels' | 'printedPage';

export interface LabelPagePlan {
  /** One entry per distinct label that resolved, in request order. Empty when anything failed. */
  resolved: ResolvedLabel[];
  /** Every label that did not resolve, in request order. Non-empty means the call must refuse. */
  failed: LabelFailure[];
  /** The pages to render: `resolved`'s pages, deduplicated, in request order. */
  pages: number[];
  /**
   * Which route was taken: `'pageLabels'` when the PDF's own `/PageLabels` tree settled the
   * conversion, `'printedPage'` when there was no usable tree and the printed page was used as
   * the index directly (with the two heuristic refusals live).
   */
  labelSource: LabelSource;
  /** The label whose roman printed page is the evidence behind a `'renumbered'` failure. Only
   *  ever set on the `'printedPage'` route, which is the only one that infers anything. */
  renumberedBy?: AuxLabel;
}

/**
 * `printed label -> the 1-based PDF pages printing it`, built from pdf.js's `getPageLabels()`
 * array (0-based page index -> printed label), or `undefined` when there is nothing usable to
 * look anything up in.
 *
 * Three inputs collapse to `undefined`, and the caller must treat all three the same — as "this
 * document has no page-label tree", falling back to the inferred route rather than refusing every
 * label: `null`/`undefined` (pdf.js's own answer for a PDF with no `/PageLabels`, or one whose
 * tree it could not read), an empty array, and an array whose entries are ALL blank. That last
 * one is not hypothetical — a `/Nums` entry carrying neither `/S` nor `/P` yields `""` — and
 * treating a document labelled `["", "", ""]` as authoritative would refuse every label in it
 * with `'printedPageAbsent'`, replacing a working heuristic with a wrong certainty.
 *
 * Individual blank entries are dropped for the same reason in miniature: a blank label can never
 * be the printed page of a resolved `\newlabel` worth rendering, and letting one match would map
 * a label to a page on the strength of two empty strings being equal.
 *
 * Matching is exact and literal — no trimming, no case folding, no numeric coercion — the same
 * rule `--literal-pathspecs` follows everywhere else here: `"3"` and `" 3"` are different printed
 * pages, and a near-miss must fail conspicuously rather than resolve to a plausible page.
 */
export function buildPageLabelIndex(
  pageLabels: readonly string[] | null | undefined,
): Map<string, number[]> | undefined {
  if (!pageLabels || pageLabels.length === 0) {
    return undefined;
  }
  const index = new Map<string, number[]>();
  for (const [i, label] of pageLabels.entries()) {
    if (typeof label !== 'string' || label === '') {
      continue;
    }
    const pages = index.get(label);
    if (pages) {
      pages.push(i + 1);
    } else {
      index.set(label, [i + 1]);
    }
  }
  return index.size > 0 ? index : undefined;
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
 *
 * `pageLabels` is the PDF's own `/PageLabels` array as pdf.js's `getPageLabels()` returns it —
 * one printed label per page, indexed by 0-based page index — and supplying it switches the
 * whole plan from the inferred route to an exact lookup (see this file's header, fact 2). It is
 * optional, and `null` is the common answer rather than an error: see
 * {@link buildPageLabelIndex} for what counts as "no usable tree".
 */
export function planLabelPages(
  labels: string[],
  aux: AuxFloatsResult,
  pageLabels?: readonly string[] | null,
): LabelPagePlan {
  const index = new Map<string, AuxLabel>();
  for (const entry of aux.floats) {
    if (!index.has(entry.label)) {
      index.set(entry.label, entry);
    }
  }
  const byPrintedPage = buildPageLabelIndex(pageLabels);
  const labelSource: LabelSource = byPrintedPage ? 'pageLabels' : 'printedPage';
  // Only ever evidence on the inferred route. On the `/PageLabels` route a roman printed page is
  // an ordinary lookup key, not a symptom, so computing a verdict from it would be noise at best
  // and, if it ever reached a refusal, a refusal of a label this route resolves exactly.
  const renumberedBy = byPrintedPage
    ? undefined
    : aux.floats.find((entry) => isRomanPage(entry.page));

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

    let page: number | undefined;
    if (byPrintedPage) {
      const candidates = byPrintedPage.get(entry.page) ?? [];
      // Exactly one candidate is the only resolvable case; `only` is `undefined` for both of the
      // other two, which the branches below then tell apart. Written this way rather than
      // indexing after a length check so the element's type carries the guarantee.
      const only = candidates.length === 1 ? candidates[0] : undefined;
      if (candidates.length === 0) {
        // NOT 'notFound': the label is in the .aux, so "no \newlabel for it" would be a lie and
        // would send the caller looking for a typo in a label that is plainly defined. What is
        // missing is the PAGE — this document does not print that number anywhere — which is the
        // .aux being older than the PDF beside it.
        failed.push({ label, reason: 'printedPageAbsent', printedPage: entry.page });
        continue;
      }
      if (only === undefined) {
        // Never the first match. A document that restarts \pagenumbering prints "1" twice, and
        // taking the lower index renders the front matter when the caller meant the body — the
        // exact silently-wrong page this whole feature exists to refuse.
        failed.push({
          label,
          reason: 'ambiguousPrintedPage',
          printedPage: entry.page,
          candidatePages: candidates.slice(0, MAX_AMBIGUOUS_CANDIDATES),
          candidatePagesOmitted: Math.max(0, candidates.length - MAX_AMBIGUOUS_CANDIDATES),
        });
        continue;
      }
      page = only;
    } else {
      page = parsePrintedPage(entry.page);
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
    }

    resolved.push({ label, printedPage: entry.page, page });
    if (!seenPage.has(page)) {
      seenPage.add(page);
      pages.push(page);
    }
  }

  if (failed.length > 0) {
    return { resolved: [], failed, pages: [], labelSource, renumberedBy };
  }
  return { resolved, failed, pages, labelSource, renumberedBy };
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
    if (failure.reason === 'printedPageAbsent') {
      lines.push(
        `  - ${quoteLabel(failure.label)}: the .aux records its printed page as ` +
          `${quoteLabel(failure.printedPage ?? '')}, but the PDF's own /PageLabels tree prints ` +
          'that on no page at all — the label IS defined, so this is that .aux being stale ' +
          'relative to the PDF beside it (the page moved or went away since the last compile), ' +
          'not an unknown label. Compile again, then retry.',
      );
      continue;
    }
    if (failure.reason === 'ambiguousPrintedPage') {
      const candidates = failure.candidatePages ?? [];
      const omitted = failure.candidatePagesOmitted ?? 0;
      const more = omitted > 0 ? `, and ${omitted} more` : '';
      lines.push(
        `  - ${quoteLabel(failure.label)}: the .aux records its printed page as ` +
          `${quoteLabel(failure.printedPage ?? '')}, and the PDF prints that on ` +
          `${candidates.length + omitted} different pages (PDF pages ${candidates.join(', ')}` +
          `${more}) — a document that restarts \\pagenumbering legitimately prints one number ` +
          'twice, so there is no single page to render and picking one would be a coin flip.',
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
  const conversion =
    plan.labelSource === 'pageLabels'
      ? "which records each label's PRINTED page; that printed page was then looked up in the " +
        "PDF's own /PageLabels tree to get the page index, so a renumbered document (roman " +
        'front matter, an appendix scheme) resolves exactly rather than being refused'
      : "which records each label's PRINTED page. This PDF carries no /PageLabels tree, so the " +
        'printed page was used as the page index directly — correct precisely because nothing ' +
        'renumbered the document, and a document that shows signs of renumbering is refused ' +
        'rather than guessed';
  return (
    `Pages resolved from labels through the build-directory .aux of the LAST COMPILE ` +
    `(${describeResolvedLabels(plan.resolved)}), ${conversion}. Edits since that compile, and ` +
    'references that have not converged, are not reflected: recompile if the page looks wrong.'
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

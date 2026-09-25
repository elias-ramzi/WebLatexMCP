/**
 * Resolving a `\label` to the page `render_pages` should rasterize, out of the label index the
 * LAST COMPILE left in the build-directory `.aux`.
 *
 * Why this is a lib and not a few lines in the tool: every interesting part of it is a refusal,
 * and a refusal is exactly the thing that has to be unit-testable without a live MCP client, a
 * compiled PDF, or a TeX install. The tool layer reads the `.aux` (through `readAuxFloats`, the
 * same reader `pdf_geometry`'s "floats" kind uses — there is one `.aux` parser in this codebase
 * and this file is not a second one), hands the parsed result here with a
 * {@link LabelPageReader} over the PDF, and maps the plan onto response shapes. Everything below
 * is pure over plain data — no fs, no clock, no process — except that {@link resolveLabelPages}
 * awaits the reader it is handed, which a test replaces with canned data.
 *
 * Four facts govern the whole design, and each of them is a place where guessing would be worse
 * than refusing:
 *
 *  1. **The `.aux` reflects the last compile, never the working tree.** A label added since, one
 *     that moved, or one whose reference has not converged yet (LaTeX's "Label(s) may have
 *     changed. Rerun to get cross-references right.") resolves to a stale page — or not at all.
 *     Nothing here can detect that, so every successful resolution carries
 *     {@link labelResolutionNote} saying where the number came from. The one symptom that IS
 *     detectable — a page past the end of the PDF actually on disk — is refused by the plan
 *     itself on the printed-page route (`'pastEndOfPdf'`, fact 3; the `/PageLabels` route cannot
 *     produce one), and {@link labelPageRangeMessage} remains for a renderer range error that
 *     slips past it anyway, rather than surfacing it bare.
 *
 *  2. **The `.aux` records the PRINTED page, and `render_pages` wants a 1-based PDF page index.**
 *     The PDF itself can settle that conversion exactly: a `/PageLabels` number tree maps page
 *     index -> printed label for every page, whatever the numbering scheme, and pdf.js hands it
 *     over as `getPageLabels()`. When the render service supplies that array
 *     ({@link planLabelPages}'s third argument), resolution is a LOOKUP — printed page from the
 *     `.aux`, page index from the array — and nothing about renumbering is inferred at all. This
 *     file never opens a PDF: the map arrives as plain data (through a {@link LabelPageReader}
 *     the caller supplies), which is what keeps every refusal below unit-testable without pdf.js,
 *     a compiled PDF or a TeX install.
 *
 *     Two refusals belong to that path, and both are cases where a number IS available and using
 *     it would be wrong. A printed page **absent** from `/PageLabels` (`'printedPageAbsent'`) is
 *     the `.aux` being stale relative to the PDF on disk, NOT an undefined label — the label was
 *     found, its page just is not printed anywhere in this document any more. And a printed page
 *     that `/PageLabels` maps to **more than one** page (`'ambiguousPrintedPage'`) is legitimate —
 *     a restarted `\pagenumbering`, or an unnumbered front page — so taking the first match would
 *     re-create the wrong-page failure by another route; both candidates are named instead.
 *
 *     One tree is never looked anything up in: a **beamer** deck's (`pageLabelsIgnored`,
 *     {@link usablePageLabelIndex}). The lookup is exact only because hyperref labels each page
 *     with the same `\thepage` that `\label` records — and beamer breaks that: it labels each
 *     PDF page with its FRAME number,
 *     which every overlay slide of a `\pause` frame repeats, while `\thepage` counts SLIDES.
 *     A 3-slide frame and then a figure on slide 4 gives `["1","1","1","2",...]`, and the `.aux`'s
 *     "4" finds frame 4 on PDF page 7, rendered with no refusal (beamer's `nohyperref` option
 *     still writes such a tree). The tree alone cannot give this away — an ordinary hyperref
 *     tree repeats "1" on a `titlepage` and the page after it too, so "a label repeated on
 *     consecutive pages" would throw the exact lookup away for every such document — but the
 *     `.aux` does: beamer writes its navigation records there (`\@writefile{nav}`, surfaced as
 *     `AuxFloatsResult.beamerNav`). Nor does a tree that IS the identity "1".."N" vouch for
 *     anything: `pgfpages` breaks it both ways a real build showed — `2 on 1` puts two slides on
 *     each sheet (the tree numbers sheets), and `resize to` (one slide per sheet, a common print
 *     layout) defers every shipout by one page, so each `\label` records `\thepage` one too high
 *     while the tree, and even the `.aux`'s slide count, match the PDF exactly. So a deck always
 *     takes the printed-page route below, where the slide number is a candidate like any other
 *     and a footline printing it
 *     (`\insertpagenumber`) confirms it; a deck with no such footline is refused (`'noFolio'`),
 *     and one printing FRAME numbers reads as the wrong number and is refused too. Before any of
 *     that, a deck's label is refused (`'slideMismatch'`) when its `\newlabel` page disagrees with
 *     beamer's own record of the slide (`\beamer@slide`, {@link slideMismatch}): that record is
 *     taken when the `\label` runs rather than when the page ships, so under `resize to` it keeps
 *     the true slide while the `\newlabel` is one late — and there a footline printing the true
 *     slide numbers would confirm the late page.
 *
 *     The pgfpages shift is not a beamer matter, though, and ahead of both routes a build whose
 *     records name `pgfpages` at all has every label refused (`'pgfpagesLayout'`,
 *     `AuxFloatsResult.pgfpages`, read off the build's `.fls` and `.log`). An `article` under
 *     `resize to` records every label one page late too, with or without hyperref, and there is
 *     no slide record to contradict it: each page prints its own true folio, so the late page
 *     reads exactly as the printed page the `.aux` names and a neighbour agrees, and hyperref's
 *     tree moves with the pages. Nothing in the PDF or the `.aux` shows the shift; only the
 *     build's record of what it read does. When neither record can be read, nothing is known —
 *     and since the shift is invisible everywhere else, every label of such a build is refused
 *     too (`'pgfpagesUnknown'`). Every compile leaves a `.log` beside the `.aux`, so in normal use
 *     that never happens and failing closed costs nothing; the routes below run only for a build
 *     whose records were read and name neither package.
 *
 *  3. **Without `/PageLabels` the conversion is inferred, then CHECKED, and refused unless the
 *     check passes.** `getPageLabels()` returning `null` is the COMMON case, not an error: a
 *     plain `article` carries no such tree, and there the printed page usually IS the page
 *     index. Usually is not always, and nothing in the `.aux` says which: a `report`/`book`
 *     `\maketitle` title page, a `titlepage` environment, a `\setcounter{page}`, or roman front
 *     matter that happens to carry no label all shift every later page while leaving each
 *     printed page a perfectly plausible decimal. So the printed page is only a CANDIDATE here,
 *     and the fact that decides it is the one the question is actually about: what page number
 *     that PDF page PRINTS. The candidate is accepted only when the page's own folio — the
 *     number LaTeX draws in its footer (`plain`) or at the outer edge of its running head
 *     (`headings`) — reads exactly the printed page, AND a neighbouring page corroborates it:
 *     PDF page P-1 reads exactly P-1, or PDF page P+1 reads exactly P+1. See {@link readFolios}
 *     for how a folio is found in a text layer that carries no coordinates, and why a head that
 *     could be read two ways is not read either way. A page whose folio reads otherwise is
 *     refused (`'unverifiedPage'`/`'folioMismatch'`), as is one with no folio at all
 *     (`'noFolio'`: a title page, `\pagestyle{empty}`), one whose head reads two ways
 *     (`'ambiguousFolio'`), one no neighbour corroborates (`'uncorroboratedFolio'`) and one whose
 *     candidate page is past the end of the PDF. Three heuristic refusals stay in front of the
 *     check: a printed page that is not a decimal integer (`'notAPageNumber'`), and a document
 *     with POSITIVE evidence of renumbering — any label printing as a roman numeral
 *     (`'renumbered'`), or a decimal printed page that goes DOWN in `.aux` order
 *     (`'restarted'`, {@link findNumberingRestart}: `\label` writes at shipout, so the records
 *     come in page order, and a decrease is an arabic restart — a supplement after
 *     `\setcounter{page}{1}` prints 1, 2, 3 again, and its folios confirm the MAIN paper's pages
 *     as readily as its own). One check behind the per-page one is document-wide: a candidate
 *     that passes is still refused (`'lastPageMismatch'`) unless the LAST PDF page reads as the
 *     page count whenever it reads as a decimal at all ({@link lastPageVerdict}) — a restart the
 *     `.aux` shows no decrease for still ends on a smaller number. Every refusal names the escape
 *     hatches: load `hyperref` (which writes `/PageLabels`), or find the page with
 *     `extract_text`/`pdf_geometry` and pass `pages:`.
 *
 *     The label's NUMBER is not what is checked ("the page shows 1.1 somewhere"): that is not
 *     evidence of anything in an `article`, whose figure and table numbers are single digits, and
 *     "[1, 2]", "3 runs" put those on nearly every page, so checked that way a `[titlepage]`
 *     article resolves each figure to the page before it. The number is not consulted at all:
 *     requiring it as well would only add false refusals (a subfigure `"1a"` shown as "(a)", an enumerate item, a
 *     heading that opens the page) without catching a wrong page the folio check lets through.
 *
 *     One page's reading is never believed on its own, because real pdflatex builds forge it —
 *     believed alone, each of these resolved to the page BEFORE the float, with no refusal. When the real folio is not a
 *     bare number (fancyhdr `\cfoot{Page \thepage}`, "Page N of M", "-- N --", "Draft N"), or
 *     something is drawn after the foot (an eso-pic `\AddToShipoutPictureFG` mark), the last line
 *     is not a folio, so the head is read — and there the head is a SECTION number: fancyhdr's
 *     default `\rightmark` ("4", "SEC4"), or a heading opening the page ("3", "Three"). And under
 *     `\pagestyle{headings}`, whose foot is empty, a `[b]` table ending in a bare cell "2" put
 *     "2" on the page's last line, which read as the only folio and overrode the head's real
 *     "1". The neighbour rule answers both, because a forged reading does not continue: a
 *     section mark persists or lags across pages, and a table cell does not repeat, while a real
 *     folio reads one more on the next page. It also means a corroborated candidate is right even
 *     when its OWN reading was a forgery, as long as the neighbour's is a real folio and the
 *     numbering does not jump between exactly those two pages: locally aligned numbering is the
 *     fact the lookup needs. Over the labels of 45 real pdflatex documents the rule took the
 *     wrong answers from 6 to 0, at the price of more refusals — the safe direction.
 *     The two readings may be of different kinds (a chapter-opening page's `plain` foot beside
 *     the next page's running head): requiring the same kind would refuse every label on a
 *     `book` chapter opener, and would catch only a foot forgery and a head forgery adjacent to
 *     each other AND reading consecutive numbers equal to their page indices.
 *
 *     The neighbour rule cannot see a forgery that DOES continue: a head showing the section
 *     number (`\leftmark`) under short sections that advance exactly one per page in step with
 *     the PDF, beside a foot that is not a bare number. Every page reads as its own index and
 *     every neighbour agrees. So the foot is read for what it is:
 *     the common forms — `Page N`, `N of M`, `Page N of M`, `N/M`, `– N –` — are recognised as a
 *     WHOLE last line ({@link readFolios}) and win over the head, so those documents read their
 *     true, shifted folio and refuse. Together with the beamer and restart rules, this took the
 *     wrong answers over 133 real pdflatex builds from 45 to 16 (and over 23 more built to
 *     test it from 31 to 0), while the share of correct candidates refused fell from 13.6%
 *     to 11.9% (34.3% to 10.4%): a "Page N" foot now reads where it used to count as no folio.
 *
 *     A restart need not leave a DECREASE for {@link findNumberingRestart} to see: a supplement
 *     whose first label sits on a printed page no lower than the main paper's last (the `.aux`
 *     reads 1, 2, 2, 3, 4), an equal restart, or labelled arabic front matter followed by
 *     `\pagenumbering{arabic}`. Each prints some number twice, and the main paper's copy passed
 *     the local check for the supplement's label — 10 wrong answers across 4 real builds, 3 of
 *     them under a "Page N" foot, which the foot forms above made readable. So the last page is
 *     read as well: over 177 real pdflatex builds that took the wrong answers from 46 to 36
 *     (every restart-shaped one), and cost 7 correct answers — the main-paper and front-matter
 *     labels of those same restarted documents, whose pages cannot be told from the repeated
 *     ones — raising the share of correct candidates refused from 14.5% to 16.6%. No label of any
 *     other build changed.
 *
 *     The residuals this route still carries, stated rather than hidden: the folio is read from
 *     text, not from a page box, so it is evidence of the folio rather than the folio itself.
 *     Two adjacent forgeries that read as their own page indices still pass. The 36 wrong
 *     answers above are all one contrived shape: a shifted document whose foot is EMPTY
 *     (`\pagestyle{empty}`, or `headings`, whose folio is in the head) with, on consecutive
 *     pages, a last line that reads as the PDF page index — a `[b]` table whose last cell is that
 *     number (16), or is written in one of the foot forms ("3/9", 16), or a centred
 *     `-- 3 --` body line at the page bottom (4). The foot forms added those 20 routes, and no
 *     small rule takes them back: the forgery repeats on every page in the SAME form, so
 *     requiring the neighbour's reading to share the candidate's form catches none of them, and
 *     requiring the head to agree would catch the `headings` variant only while refusing every
 *     `plain` page that opens with a section heading. A section-numbered head beside a foot form
 *     outside the list ("Draft 3", "p. 3") is the continuing forgery above again. An arabic restart passes
 *     when its last page gives no decimal reading (`\thispagestyle{empty}` on it, a back cover)
 *     or a wrong one that happens to equal the page count (a stray bare number above an empty
 *     foot, a `\setcounter{page}` that makes the numbering catch up); only `/PageLabels` could
 *     reveal it then (roman front matter is caught — its pages print roman folios, which never
 *     corroborate a decimal neighbour). The first and last page of the PDF have one neighbour to
 *     consult instead of two, so they are refused more often, never accepted on less; a one-page
 *     PDF is the exception, accepted on its own folio, since its only page is the only page a
 *     label can be on. It errs the other way more often — a oneside
 *     `headings` page whose head opens with a section number ("1 INTRO 3"), a
 *     `\pagestyle{empty}` page, a beamer deck with no slide number in its footline, every label
 *     of a document with a restart, and every label of a document whose last page reads as some
 *     other decimal (a table cell, the number of a section heading opening an unnumbered last
 *     page, an appended `\includepdf` page with its own folio) all refuse although the page was
 *     right — and that is the direction to err in; so does a beamer label in an
 *     `allowframebreaks` frame, whose `\newlabel` page is right but disagrees with beamer's slide
 *     record (fact 2). A document numbered any way but plainly should carry `/PageLabels`; fact 2
 *     is the real answer and this is only the floor under it.
 *
 *     A label defined more than once (`'multiplyDefined'`) is refused on BOTH routes: LaTeX's
 *     `\@newl@bel` `\global`-defines on every record, so `\ref`/`\pageref` print the LAST one,
 *     and LaTeX itself warns "multiply defined" — the document is wrong, and picking a record
 *     would be a guess. (A redefinition that fell past the lookup cap is not seen; the cap is
 *     far above any real document, and the reader reports `omitted` when it fires.)
 *
 *  4. **An assertion, never an inference.** If a label cannot be resolved, the whole call refuses
 *     ({@link labelRefusalMessage}) — it never renders the labels it did resolve and quietly drops
 *     the rest, and it never falls back to page 1. A partially-honoured request would be read as
 *     "here is your table" while showing a different page's table, which is the exact failure this
 *     feature exists to prevent.
 */

import type { AuxFloatsResult, AuxLabel } from './auxFloats.js';
import type { PdfRenderService } from '../services/pdfRender.js';

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
   * `printedPage` on, or — when the document carries no usable tree — the printed page read as a
   * decimal integer, accepted only because that page's own folio reads `printedPage` and a
   * neighbouring page's reads the adjacent number.
   * {@link LabelPagePlan.labelSource} says which of the two it was.
   */
  page: number;
}

/**
 * Why one label could not be turned into a page. Counted apart rather than collapsed into one
 * "unresolved", because the caller's next move differs: `'notFound'` and `'printedPageAbsent'`
 * both mean "compile again" (the label is missing from the `.aux`, or the `.aux` is stale
 * relative to the PDF), `'multiplyDefined'` means "fix the duplicate `\label`", while
 * `'notAPageNumber'`, `'renumbered'`, `'restarted'`, `'ambiguousPrintedPage'` and
 * `'unverifiedPage'` mean "this document's printed pages are not usable as PDF page indices —
 * load `hyperref`, or pass `pages:` yourself". `'slideMismatch'` is the beamer form of that:
 * the deck's `\newlabel` page and beamer's own record of the slide disagree
 * ({@link slideMismatch}), so neither is trusted. `'pgfpagesLayout'` means "no label of this
 * build is usable": the build's records name `pgfpages` (`AuxFloatsResult.pgfpages` is `true`),
 * whose layouts shift every label a page late, so the caller must pass `pages:` or compile
 * without the package. `'pgfpagesUnknown'` means the same for a build whose records could not be
 * read at all (`AuxFloatsResult.pgfpages` absent): whether pgfpages shifted this build cannot be
 * told, so no label is usable — the caller must compile again (which writes the `.log`) or pass
 * `pages:`.
 *
 * Which reasons are even reachable depends on how the plan was resolved: `'notAPageNumber'`,
 * `'renumbered'`, `'restarted'`, `'slideMismatch'` and `'unverifiedPage'` belong to the inferred
 * fallback (which a beamer deck always takes),
 * `'printedPageAbsent'` and `'ambiguousPrintedPage'` to the `/PageLabels` lookup. `'notFound'`,
 * `'multiplyDefined'`, `'pgfpagesLayout'` and `'pgfpagesUnknown'` belong to both.
 *
 * None of this reaches a tool's `structuredContent`: a failure refuses the call, and only the
 * refusal TEXT ({@link labelRefusalMessage}) goes back.
 */
export type LabelFailureReason =
  | 'notFound'
  | 'multiplyDefined'
  | 'notAPageNumber'
  | 'renumbered'
  | 'restarted'
  | 'slideMismatch'
  | 'pgfpagesLayout'
  | 'pgfpagesUnknown'
  | 'printedPageAbsent'
  | 'ambiguousPrintedPage'
  | 'unverifiedPage';

/**
 * Why an `'unverifiedPage'` label could not be checked against its candidate page:
 *  - `'folioMismatch'` — the page reads as a different page number (`folios` says which). Most
 *    often the printed pages are shifted against the PDF, but what was read may also be a section
 *    mark standing where no bare folio was found, so the refusal says "reads as", never "prints";
 *  - `'ambiguousFolio'` — the page's running head reads as two different folios, one of them the
 *    printed page (`folios` lists both), and the text layer cannot say which one is the folio;
 *  - `'noFolio'` — the page shows no folio at all (a title page, `\pagestyle{empty}`), so
 *    nothing on it says which printed page it is;
 *  - `'uncorroboratedFolio'` — the page reads exactly as the printed page, but neither
 *    neighbouring PDF page reads as the adjacent number (`neighbours` says what each read), so
 *    the reading may be a section number or a table cell rather than the folio;
 *  - `'pastEndOfPdf'` — the candidate page does not exist in the PDF on disk (a stale `.aux`, or a
 *    `\setcounter{page}` — without `/PageLabels` the two cannot be told apart);
 *  - `'lastPageMismatch'` — the candidate page checked out, but the LAST PDF page reads as a
 *    decimal page number other than the page count, or could not be read at all (`lastPage` says
 *    which). That is what an arabic restart leaves behind when the `.aux` shows no decrease
 *    ({@link lastPageVerdict}) — and also what an ordinary last page shows when its head or its
 *    content puts another number where the folio is looked for, which nothing here tells apart;
 *  - `'noEvidence'` — no text was supplied for the page at all.
 */
export type UnverifiedReason =
  | 'folioMismatch'
  | 'ambiguousFolio'
  | 'noFolio'
  | 'uncorroboratedFolio'
  | 'pastEndOfPdf'
  | 'lastPageMismatch'
  | 'noEvidence';

/**
 * What one neighbouring PDF page read as, for an `'uncorroboratedFolio'` refusal: its
 * {@link readFolios} readings, or `null` when its text could not be read at all (said apart,
 * because "reads as nothing" and "was never looked at" are different facts).
 */
export interface NeighbourFolio {
  page: number;
  folios: string[] | null;
}

export interface LabelFailure {
  label: string;
  reason: LabelFailureReason;
  /** The printed page the `.aux` recorded, for every reason except `'notFound'` and
   *  `'multiplyDefined'` (which has several — see `printedPages`). */
  printedPage?: string;
  /**
   * `'ambiguousPrintedPage'` only: the 1-based PDF pages that print `printedPage`, in page order,
   * at most {@link MAX_AMBIGUOUS_CANDIDATES} of them.
   */
  candidatePages?: number[];
  /** `'ambiguousPrintedPage'` only: how many further candidates the cap left out of the list. */
  candidatePagesOmitted?: number;
  /** `'multiplyDefined'` only: the printed page of each record, in `.aux` order, at most
   *  {@link MAX_AMBIGUOUS_CANDIDATES} of them. */
  printedPages?: string[];
  /** `'multiplyDefined'` only: how many further records the cap left out of the list. */
  printedPagesOmitted?: number;
  /** `'unverifiedPage'`, `'slideMismatch'`, `'pgfpagesLayout'` and `'pgfpagesUnknown'` only: the
   *  label's number as the `.aux` records it
   *  (the first field of `\newlabel`). Not checked against anything — it is echoed so the
   *  refusal can tell the caller what to search `extract_text`'s output for. */
  number?: string;
  /** `'slideMismatch'` only: the slides beamer's own `\beamer@slide` records name for the label
   *  (`AuxFloatsResult.beamerSlides`), none or not all of them `printedPage`. */
  slides?: string[];
  /** `'unverifiedPage'` only: which part of the check failed. */
  unverified?: UnverifiedReason;
  /** `'folioMismatch'`/`'ambiguousFolio'`/`'uncorroboratedFolio'` only: what the candidate
   *  page's folio reads as — one or two tokens out of {@link readFolios}, each a bare decimal or
   *  roman numeral. */
  folios?: string[];
  /** `'uncorroboratedFolio'` only: what each in-range neighbouring page read as, in page order
   *  (one entry on the first or last page of the PDF, two otherwise). */
  neighbours?: NeighbourFolio[];
  /** `'unverifiedPage'` with `'pastEndOfPdf'` only: how many pages the PDF on disk has. */
  pageCount?: number;
  /** `'unverifiedPage'` with `'lastPageMismatch'` only: the last PDF page and what it read as
   *  (`null`: its text could not be read). */
  lastPage?: NeighbourFolio;
}

/**
 * What the printed-page route checks a candidate page against: the PDF's page count, and the
 * text layer (merged lines, drawing order — as `PdfRenderService.text` returns them) of the
 * candidate pages AND their neighbours, whose first and last lines carry the folio. A candidate
 * absent from `text` is `'noEvidence'`, and an absent neighbour corroborates nothing — never a
 * pass either way.
 */
export interface LabelPageEvidence {
  pageCount: number;
  text: ReadonlyMap<number, readonly string[]>;
}

/** Where a plan's page numbers came from — reported rather than implied, because the two routes
 *  carry different caveats and {@link labelResolutionNote} has to state the right one. */
export type LabelSource = 'pageLabels' | 'printedPage';

/**
 * Two labels, consecutive in `.aux` order, whose decimal printed pages go DOWN: `after` is recorded
 * on a smaller printed page than `before`. `\label` writes at shipout, so the records come in page
 * order and this is positive evidence that the document restarts its arabic numbering (a
 * `\setcounter{page}{1}` before a supplement, a second `\pagenumbering{arabic}`).
 */
export interface NumberingRestart {
  before: AuxLabel;
  after: AuxLabel;
}

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
   * the index once that page's own folio read the same and a neighbour's corroborated it (with
   * the heuristic refusals live).
   */
  labelSource: LabelSource;
  /** The label whose roman printed page is the evidence behind a `'renumbered'` failure. Only
   *  ever set on the `'printedPage'` route, which is the only one that infers anything. */
  renumberedBy?: AuxLabel;
  /** The evidence behind a `'restarted'` failure ({@link findNumberingRestart}). Only ever set on
   *  the `'printedPage'` route, like `renumberedBy`. */
  restartedAt?: NumberingRestart;
  /**
   * Set when the PDF DID carry a usable `/PageLabels` tree and it was deliberately not used —
   * `'beamer'`: the `.aux` is a beamer deck's (`AuxFloatsResult.beamerNav`), whose tree numbers
   * FRAMES while the `.aux` records the SLIDE, so a lookup lands on a later slide (and an identity
   * tree proves nothing either, see `usablePageLabelIndex`). The plan then
   * takes the printed-page route, and the refusal and note must not claim the PDF has no tree.
   */
  pageLabelsIgnored?: 'beamer';
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

/**
 * The `/PageLabels` index a plan may look printed pages up in: {@link buildPageLabelIndex}'s,
 * except that a beamer deck's tree is never used. beamer labels each PDF page with its FRAME
 * number (every overlay slide of a `\pause` frame repeats it), while `\label` records
 * `\thepage`, which beamer steps per SLIDE — so the `.aux`'s printed page 4 (slide 4) looked up in
 * `["1","1","1","2",...]` finds frame 4, a later slide. Nothing in the tree alone gives this away:
 * an ordinary hyperref tree repeats a label on consecutive pages too (a `titlepage` resets the
 * counter, so the title page and the first body page are both "1"), so rejecting repeats would
 * throw away the exact lookup for every such document. The `.aux` does give the deck away
 * (`AuxFloatsResult.beamerNav`), and it is the `.aux` that is checked.
 *
 * A deck whose tree is the IDENTITY "1".."P" is refused too, because `pgfpages` makes an identity
 * tree prove nothing, in both of the layouts a real build was checked against:
 *  - `\pgfpagesuselayout{2 on 1}` (handouts) prints two slides per sheet, so an 8-slide deck is a
 *    4-page PDF labelled "1".."4" while its labels record "3", "5", "7", "9" — the tree's "3" is
 *    the sheet holding slides 5 and 6 (fig:f1 resolved to PDF page 3; it is on page 1);
 *  - `\pgfpagesuselayout{resize to}` (one slide per sheet, the common print layout) defers every
 *    shipout by one page, so each `\newlabel` records `\thepage` one too high — fig:f1 on PDF
 *    page 1 records "2" — while the tree is "1".."4" and even the `.aux`'s own slide count
 *    (`\beamer@documentpages{4}`) matches the page count: every label resolved to the NEXT slide.
 * An identity tree whose length matches that slide count is no evidence either — the second
 * layout passes that test — so a deck always takes the printed-page route (`'beamer'`), where a
 * footline printing the slide number is what resolves it. Both layouts are refused before that
 * wherever the build's records name `pgfpages` (`'pgfpagesLayout'`), and so is every label of a
 * build whose records cannot be read (`'pgfpagesUnknown'`); where the records were read and are
 * wrong, the second layout, whose footline prints the TRUE slide numbers, is still refused by
 * beamer's own slide record ({@link slideMismatch}).
 */
function usablePageLabelIndex(
  aux: AuxFloatsResult,
  pageLabels: readonly string[] | null | undefined,
): { index?: Map<string, number[]>; ignored?: 'beamer' } {
  const index = buildPageLabelIndex(pageLabels);
  if (index && aux.beamerNav === true) {
    return { ignored: 'beamer' };
  }
  return index ? { index } : {};
}

/**
 * The first place, in `.aux` order, where a decimal printed page goes DOWN — or `undefined`.
 *
 * `\label` is a non-immediate `\write`: its `\newlabel` record is written when the page holding
 * it SHIPS, with `\thepage` expanded then. Pages ship in order, so the records come in page order
 * — including a float's label, which is written when the float is placed, after any later text
 * labels that shipped first (a float is never placed before the page it is defined on) — and
 * `readAuxFloats` keeps that order across `\@input`-ed chapter files. So within one numbering
 * scheme the printed page never decreases, and a decrease is a restart: the document prints some
 * arabic number on more than one page, and a printed page is no longer a page index anywhere in
 * it. Non-decimal pages are skipped (a roman one is `'renumbered'`'s evidence instead).
 *
 * Evidence, never proof of absence: a restart with no label on a page before it (a cover letter
 * with no `\label`, then `\pagenumbering{arabic}`) leaves no decrease to see, and one past the
 * lookup cap (`omitted`) is not seen either.
 */
export function findNumberingRestart(floats: readonly AuxLabel[]): NumberingRestart | undefined {
  let prev: { entry: AuxLabel; page: number } | undefined;
  for (const entry of floats) {
    const page = parsePrintedPage(entry.page);
    if (page === undefined) continue;
    if (prev && page < prev.page) return { before: prev.entry, after: entry };
    prev = { entry, page };
  }
  return undefined;
}

/**
 * The slides beamer recorded for `entry`'s label when any of them is not the printed page its
 * `\newlabel` records — otherwise `undefined`. Only for a beamer deck (`aux.beamerNav`), whose
 * every `\label` also writes `\@writefile{snm}{\beamer@slide {<label>}{<slide>}}`
 * (`AuxFloatsResult.beamerSlides`).
 *
 * The two records come from one `\label` but are expanded at different moments: `\newlabel`'s
 * `\thepage` when the page ships, beamer's `\the\c@page` when the `\label` runs. A
 * `\pgfpagesuselayout` (`resize to`, `2 on 1`, …) holds every page back until the next one is
 * built, so each `\newlabel` records the page AFTER its own while beamer's record keeps the true
 * slide — and a footline printing `\insertpagenumber` then shows the true slide numbers, so the
 * page the shifted record names reads exactly as it, a neighbour agrees, and the folio route used
 * to render the next slide for every label. A disagreement is therefore refused rather than
 * resolved either way: over 16 real decks (and 5 more built for this rule: cleveref, amsmath
 * equations, `lastpage`) the two records agreed everywhere except under pgfpages (off by one) and
 * for a `\label` in an `allowframebreaks` frame, where beamer's record names the
 * slide before the frame was broken and the `\newlabel` page was the right one. That second case
 * is refused too — a right page given up, the safe direction, since the `.aux` cannot tell the
 * two apart. Only a build whose records were read and name no `pgfpages`
 * (`AuxFloatsResult.pgfpages === false`) reaches this check — one whose `.fls` or `.log` names it
 * is refused as `'pgfpagesLayout'` first, and one whose records could not be read as
 * `'pgfpagesUnknown'` — so what it catches is what the records cannot show: an
 * `allowframebreaks` label, and a pgfpages shift only if the records were wrong.
 *
 * A label with NO record (a `\newlabel` some package writes itself, e.g. `lastpage`'s
 * `LastPage`, or a key holding a brace group, which the line pattern does not read) keeps the
 * folio route: nothing contradicts it, and a measured `lastpage` label in a `resize to` deck was
 * recorded on the right page.
 */
function slideMismatch(aux: AuxFloatsResult, entry: AuxLabel): string[] | undefined {
  if (aux.beamerNav !== true) return undefined;
  const slides = aux.beamerSlides?.get(entry.label);
  if (!slides || slides.every((slide) => slide === entry.page)) return undefined;
  return [...slides];
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

/** A token that reads as a page number on its own: a decimal (bounded like {@link DECIMAL_PAGE})
 *  or a roman numeral. Roman counts so that a roman folio is READ — and then fails to match a
 *  decimal printed page — rather than skipped over as if the page had none. */
function isFolioToken(token: string): boolean {
  return DECIMAL_PAGE.test(token) || isRomanPage(token);
}

/**
 * The foot forms a page style commonly wraps its folio in, each anchored to the WHOLE last line:
 * `Page N`, `N of M`, `Page N of M`, `N/M`, `N / M`, and a folio between two equal dashes
 * (`-- N --`, which pdf.js reads as the en-dash ligature `– N –`, `- N -`, `— N —`). The folio
 * group is validated by {@link isFolioToken} like a bare foot, and a total (`M`) must be one too
 * and, when both are decimal, no smaller than the folio — so a body line such as `5/4`, or a
 * dash-wrapped word, is not taken for a folio. Deliberately a short list of whole-line shapes, not
 * a search for a number in the foot: a line that merely CONTAINS "Page 4" ("see Page 4") is prose.
 */
const FOOT_FORMS: ReadonlyArray<{ re: RegExp; folio: number; total?: number }> = [
  { re: /^page\s+(\S+)$/i, folio: 1 },
  { re: /^(?:page\s+)?(\S+)\s+of\s+(\S+)$/i, folio: 1, total: 2 },
  { re: /^(\S+?)\s*\/\s*(\S+)$/, folio: 1, total: 2 },
  { re: /^(-{1,2}|[\u2013\u2014])\s*(\S+?)\s*\1$/, folio: 2 },
];

/** The folio a whole foot line holds in one of the {@link FOOT_FORMS}, or `undefined`. */
function footFormFolio(line: string): string | undefined {
  for (const form of FOOT_FORMS) {
    const m = form.re.exec(line);
    if (!m) continue;
    const folio = m[form.folio] ?? '';
    if (!isFolioToken(folio)) continue;
    if (form.total !== undefined) {
      const total = m[form.total] ?? '';
      if (!isFolioToken(total)) continue;
      if (DECIMAL_PAGE.test(folio) && DECIMAL_PAGE.test(total) && Number(folio) > Number(total)) {
        continue;
      }
    }
    return folio;
  }
  return undefined;
}

/** How many leading lines may hold the running head. pdf.js splits a head at its glue, so
 *  "1.1. SEC 3" arrives as three lines; one more is headroom for a mark that splits once more.
 *  Past this the lines are body text, which is what makes a number there not a folio. */
const HEAD_LINES = 5;

/**
 * What page number a page's text layer shows as its folio — the number LaTeX's page style
 * draws outside the text block — as zero, one or two readings. This is the fact the
 * printed-page route rests on: printed page P is PDF page P exactly when PDF page P prints P.
 *
 * The text layer has no coordinates here, only merged lines in DRAWING order, and LaTeX's
 * output routine ships the head first and the foot last (`\@outputpage`), so:
 *
 *  - **Footer** (`plain`, the default of `article` and `report`, and every chapter-opening page):
 *    the LAST line is the folio when it is a bare number, and then it is the only reading.
 *    First lines are deliberately not consulted then: a page that opens with a section heading
 *    starts with that section's number on a line of its own ("1", "Intro"), which is not a folio.
 *    The same holds when the last line is one of the common foot forms ({@link FOOT_FORMS}:
 *    "Page 4", "4 of 9", "4/9", "– 4 –"), whose number is then the only reading. Reading these
 *    is what keeps a head that shows the SECTION number (fancyhdr's `\rightmark`/`\leftmark`)
 *    from being read instead — a head whose section numbers advance one per page in step with
 *    the PDF forged a corroborated folio on every page before these were recognised.
 *  - **Running head** (`headings`), when the last line is not a bare number: the head arrives as
 *    its pieces, so the folio is either the FIRST line (an even page: "2", "CHAPTER 1.", "ONE")
 *    or the first bare number that follows a non-number within {@link HEAD_LINES} (an odd page:
 *    "1.1.", "SEC", "3"). A bare number right after another bare number is a mark's section
 *    number, not a folio (twoside even page "2", "1", "INTRO"). When both readings exist and
 *    differ, BOTH are returned: a oneside `article` head "1", "INTRO", "3" (section 1, page 3)
 *    is indistinguishable in text from an even-page head "1", "INTRO" followed by a body line
 *    "3", so the caller must not pick one.
 *
 * A number inside a line ("[1, 2]", "Figure 2: Cap") is never a folio, and neither is a dotted
 * section number ("1.1."). An empty result means the page shows no folio at all.
 */
export function readFolios(lines: readonly string[]): string[] {
  if (lines.length === 0) return [];
  const foot = lines[lines.length - 1]!.trim();
  if (isFolioToken(foot)) return [foot];
  const form = footFormFolio(foot);
  if (form !== undefined) return [form];
  const readings: string[] = [];
  const first = lines[0]!.trim();
  if (isFolioToken(first)) readings.push(first);
  const scan = Math.min(lines.length, HEAD_LINES);
  for (let i = 1; i < scan; i++) {
    const token = lines[i]!.trim();
    if (isFolioToken(token) && !isFolioToken(lines[i - 1]!.trim())) {
      if (!readings.includes(token)) readings.push(token);
      break;
    }
  }
  return readings;
}

/**
 * Plan the pages for a list of labels against a parsed `.aux` index.
 *
 * Duplicate labels in the request are collapsed (first occurrence wins, request order kept), and
 * so are duplicate pages — two labels on one page render that page once, while both still appear
 * in `resolved`, because the caller asked about two things and deserves both answers. A label
 * DEFINED more than once in the `.aux` (LaTeX's "multiply defined" warning) is refused
 * (`'multiplyDefined'`), on either route: `\@newl@bel` `\global`-defines on every record, so the
 * LAST one is what `\ref`/`\pageref` print, and neither record is a page the document vouches for.
 *
 * `resolved` is emptied when anything failed: a caller must never receive a half-honoured render.
 *
 * `pageLabels` is the PDF's own `/PageLabels` array as pdf.js's `getPageLabels()` returns it —
 * one printed label per page, indexed by 0-based page index — and supplying it switches the
 * whole plan from the inferred route to an exact lookup (see this file's header, fact 2), unless
 * the `.aux` is a beamer deck's, whose tree is never used ({@link usablePageLabelIndex},
 * `pageLabelsIgnored`). It is optional, and `null` is the common answer rather than an error: see
 * {@link buildPageLabelIndex} for what counts as "no usable tree".
 *
 * `evidence` is what the inferred route checks each candidate page against (fact 3). Without it,
 * that route refuses every label it would otherwise have resolved (`'noEvidence'`) — the check is
 * not optional, so a caller that skips gathering the evidence gets a refusal, never an unchecked
 * page. {@link resolveLabelPages} gathers exactly the evidence this needs.
 */
export function planLabelPages(
  labels: string[],
  aux: AuxFloatsResult,
  pageLabels?: readonly string[] | null,
  evidence?: LabelPageEvidence,
): LabelPagePlan {
  const index = new Map<string, AuxLabel[]>();
  for (const entry of aux.floats) {
    const records = index.get(entry.label);
    if (records) {
      records.push(entry);
    } else {
      index.set(entry.label, [entry]);
    }
  }
  const { index: byPrintedPage, ignored: pageLabelsIgnored } = usablePageLabelIndex(
    aux,
    pageLabels,
  );
  const labelSource: LabelSource = byPrintedPage ? 'pageLabels' : 'printedPage';
  // Only ever evidence on the inferred route. On the `/PageLabels` route a roman printed page is
  // an ordinary lookup key, not a symptom, and a repeated arabic one is refused there as
  // 'ambiguousPrintedPage' by the lookup itself — so computing a verdict from either would be
  // noise at best and, if it ever reached a refusal, a refusal of a label this route resolves
  // exactly.
  const renumberedBy = byPrintedPage
    ? undefined
    : aux.floats.find((entry) => isRomanPage(entry.page));
  const restartedAt = byPrintedPage ? undefined : findNumberingRestart(aux.floats);
  // Document-wide like the two above, but consulted only for a label whose own page checked out,
  // so every other refusal keeps its more specific reason.
  const lastPage = byPrintedPage || !evidence ? undefined : lastPageVerdict(evidence);
  const verdicts = {
    labelSource,
    renumberedBy,
    ...(restartedAt ? { restartedAt } : {}),
    ...(pageLabelsIgnored ? { pageLabelsIgnored } : {}),
  };

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

    const records = index.get(label);
    const entry = records?.[0];
    if (!records || !entry) {
      failed.push({ label, reason: 'notFound' });
      continue;
    }
    if (records.length > 1) {
      // Never the first record, and never the last either: the last is what LaTeX prints, but a
      // document that defines one label twice has a bug LaTeX already warns about, and which
      // \label the author MEANT is not something the .aux can say.
      failed.push({
        label,
        reason: 'multiplyDefined',
        printedPages: records.slice(0, MAX_AMBIGUOUS_CANDIDATES).map((r) => r.page),
        printedPagesOmitted: Math.max(0, records.length - MAX_AMBIGUOUS_CANDIDATES),
      });
      continue;
    }
    if (aux.pgfpages === true) {
      // Ahead of both routes, because both are shifted: the \newlabel is a page late, and so are
      // hyperref's /PageLabels tree and the folios each page prints, so the tree lookup and the
      // folio check would each confirm the late page. After 'notFound' and 'multiplyDefined',
      // which are more specific facts about this one label.
      failed.push({
        label,
        reason: 'pgfpagesLayout',
        printedPage: entry.page,
        number: entry.number,
      });
      continue;
    }
    if (aux.pgfpages === undefined) {
      // Neither the .fls nor the .log could be read, so a layout that shifted every label cannot
      // be ruled out — and it is invisible to both routes (above). Refused rather than resolved:
      // this evidence may only ever add a refusal. Every compile leaves a .log beside the .aux,
      // so in normal use this never happens, and failing closed costs nothing.
      failed.push({
        label,
        reason: 'pgfpagesUnknown',
        printedPage: entry.page,
        number: entry.number,
      });
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
      const slides = slideMismatch(aux, entry);
      if (slides) {
        // First on this route: it is a fact about THIS label, and every later check would only
        // confirm the shifted page — the folios of a `resize to` deck print the true slide
        // numbers, so the page the shifted record names reads exactly as it.
        failed.push({
          label,
          reason: 'slideMismatch',
          printedPage: entry.page,
          number: entry.number,
          slides,
        });
        continue;
      }
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
      if (restartedAt) {
        // Every label, not only those on a repeated number: once one arabic number stands for
        // two pages, the folio check below can confirm the wrong one of them — the main paper's
        // page 1 reads "1" and its page 2 reads "2", exactly as the supplement's would.
        failed.push({ label, reason: 'restarted', printedPage: entry.page });
        continue;
      }
      const check = verifyCandidatePage(page, entry.page, evidence);
      if (check) {
        failed.push({
          label,
          reason: 'unverifiedPage',
          printedPage: entry.page,
          number: entry.number,
          unverified: check.unverified,
          ...(check.folios ? { folios: check.folios } : {}),
          ...(check.neighbours ? { neighbours: check.neighbours } : {}),
          ...(check.unverified === 'pastEndOfPdf' ? { pageCount: evidence?.pageCount } : {}),
        });
        continue;
      }
      if (lastPage) {
        failed.push({
          label,
          reason: 'unverifiedPage',
          printedPage: entry.page,
          number: entry.number,
          unverified: 'lastPageMismatch',
          lastPage,
        });
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
    return { resolved: [], failed, pages: [], ...verdicts };
  }
  return { resolved, failed, pages, ...verdicts };
}

/** The PDF pages whose folios can corroborate candidate page `page`: its predecessor and its
 *  successor, each only when it exists in the PDF. One helper, so the pages
 *  {@link pagesToVerify} asks to read and the pages {@link verifyCandidatePage} consults cannot
 *  drift apart. */
function neighbourPages(page: number, pageCount: number): number[] {
  return [page - 1, page + 1].filter((q) => q >= 1 && q <= pageCount);
}

/**
 * `undefined` when PDF page `page` is verified to print `printedPage`; otherwise why not. The
 * comparison is exact and literal, like every printed-page match in this file: the `.aux`
 * records `\thepage` as TeX expanded it, and the folio is the same expansion drawn on the page.
 *
 * A page that reads exactly `printedPage` is still not believed on its own (fact 3's residuals:
 * what was read may be a section number or a table cell). It is believed when a NEIGHBOUR agrees:
 * PDF page `page - 1` reads exactly `page - 1`, or PDF page `page + 1` reads exactly `page + 1`.
 * A section mark persists or lags across pages and a table cell does not repeat, so a forged
 * reading is not followed by its successor number on the next page, while a real folio is. The
 * adjacent numbers are decimal (`page` is), so a roman neighbour never corroborates — the page
 * where roman front matter gives way to arabic has to be corroborated by its successor. A one-page
 * PDF has no neighbour and needs none: its only page is the only page the label can be on.
 */
function verifyCandidatePage(
  page: number,
  printedPage: string,
  evidence: LabelPageEvidence | undefined,
): { unverified: UnverifiedReason; folios?: string[]; neighbours?: NeighbourFolio[] } | undefined {
  if (!evidence) return { unverified: 'noEvidence' };
  if (page > evidence.pageCount) return { unverified: 'pastEndOfPdf' };
  const lines = evidence.text.get(page);
  if (!lines) return { unverified: 'noEvidence' };
  const folios = readFolios(lines);
  if (folios.length === 0) return { unverified: 'noFolio' };
  const matching = folios.filter((f) => f === printedPage).length;
  if (matching !== folios.length) {
    return { unverified: matching === 0 ? 'folioMismatch' : 'ambiguousFolio', folios };
  }
  if (evidence.pageCount === 1) return undefined;
  const neighbours: NeighbourFolio[] = neighbourPages(page, evidence.pageCount).map((q) => {
    const text = evidence.text.get(q);
    return { page: q, folios: text ? readFolios(text) : null };
  });
  const corroborated = neighbours.some(
    (n) => n.folios !== null && n.folios.length === 1 && n.folios[0] === String(n.page),
  );
  return corroborated ? undefined : { unverified: 'uncorroboratedFolio', folios, neighbours };
}

/**
 * `undefined` when the document's numbering reaches the end of the PDF in step with it — as far
 * as the LAST page can say — otherwise that page and what it read as.
 *
 * The candidate check is local: a page reads its printed page and a neighbour the adjacent
 * number. An arabic restart defeats it wherever the `.aux` shows no decrease
 * ({@link findNumberingRestart}): a supplement after `\setcounter{page}{1}` whose first label
 * sits on a printed page no lower than the main paper's last one, an equal restart, or arabic
 * front matter followed by `\pagenumbering{arabic}`. Every one of those prints some number twice,
 * and the main paper's copy of it passes the local check for the supplement's label. What such a
 * document cannot hide is its last page, which prints a number SMALLER than the page count. So on
 * this route the last page must read as the page count when it reads as any decimal number at
 * all.
 *
 * What passes: a last page reading the page count (among its readings — a head that reads two
 * ways and includes it is not evidence against), one with no folio (a back cover,
 * `\pagestyle{empty}`), and one reading only roman numerals (an index numbered apart), since none
 * of those says the arabic numbering went wrong. What refuses: any decimal reading other than the
 * page count, and a last page whose text was never read — an absent page is not a pass. It costs
 * correct answers: every label of a restarted document refuses, main paper included, and so does
 * every label of an unrestarted document whose last page shows another number where the folio is
 * looked for — a table cell above an empty foot, the number of a section heading opening a last
 * page that prints no folio (`\thispagestyle{empty}`; the head is read when the foot is empty),
 * or an appended `\includepdf` page carrying its own folio. The refusal therefore names both
 * readings rather than asserting a restart. Refusing is the direction to err in.
 */
function lastPageVerdict(evidence: LabelPageEvidence): NeighbourFolio | undefined {
  const page = evidence.pageCount;
  const text = evidence.text.get(page);
  if (!text) return { page, folios: null };
  const folios = readFolios(text);
  if (folios.includes(String(page))) return undefined;
  return folios.some((f) => DECIMAL_PAGE.test(f)) ? { page, folios } : undefined;
}

/**
 * The pages whose text {@link planLabelPages} will check on the printed-page route: the candidate
 * page of every requested label that reaches the check, followed by its in-range neighbours (the
 * pages that can corroborate its folio) — at most three pages per label, each page once across
 * the whole call, in request order — then the LAST page of the PDF, once, for
 * {@link lastPageVerdict}. Only pages inside the PDF (a candidate past the end is refused without
 * reading anything, and the renderer would throw for it). Empty unless the build's records were
 * read and name no `pgfpages` (`aux.pgfpages === false`: every label is refused as
 * `'pgfpagesLayout'` or `'pgfpagesUnknown'` otherwise), and empty when the document shows roman
 * renumbering or an arabic restart, or no label reaches the check, since nothing is checked then.
 */
export function pagesToVerify(labels: string[], aux: AuxFloatsResult, pageCount: number): number[] {
  if (aux.pgfpages !== false) return [];
  if (aux.floats.some((entry) => isRomanPage(entry.page))) return [];
  if (findNumberingRestart(aux.floats)) return [];
  const wanted = new Set(labels);
  const counts = new Map<string, number>();
  for (const entry of aux.floats) {
    if (wanted.has(entry.label)) counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
  }
  const pages: number[] = [];
  for (const entry of aux.floats) {
    if (counts.get(entry.label) !== 1) continue;
    if (slideMismatch(aux, entry)) continue;
    const page = parsePrintedPage(entry.page);
    if (page === undefined || page > pageCount) continue;
    for (const p of [page, ...neighbourPages(page, pageCount)]) {
      if (!pages.includes(p)) pages.push(p);
    }
  }
  if (pages.length > 0 && !pages.includes(pageCount)) pages.push(pageCount);
  return pages;
}

/** What {@link resolveLabelPages} reads out of the PDF. Plain functions, so the resolution is
 *  unit-testable against canned data; {@link pdfLabelPageReader} adapts the real renderer. */
export interface LabelPageReader {
  pageLabels(): Promise<readonly string[] | null>;
  pageCount(): Promise<number>;
  /** The text layer of each requested (in-range) page. */
  pageText(pages: number[]): Promise<ReadonlyMap<number, readonly string[]>>;
}

/**
 * Resolve labels to pages against the PDF itself: `/PageLabels` when it has a usable tree (no
 * page text is read at all — and a beamer deck's tree never, see {@link usablePageLabelIndex}),
 * otherwise the printed page, checked against the text of the candidate pages and their
 * neighbours (at most three pages per label, each read once per call), plus the last page. This
 * is what the tools call — it gathers exactly the evidence {@link planLabelPages} checks, and no
 * more.
 */
export async function resolveLabelPages(
  labels: string[],
  aux: AuxFloatsResult,
  reader: LabelPageReader,
): Promise<LabelPagePlan> {
  const pageLabels = await reader.pageLabels();
  if (usablePageLabelIndex(aux, pageLabels).index) {
    return planLabelPages(labels, aux, pageLabels);
  }
  const pageCount = await reader.pageCount();
  const wanted = pagesToVerify(labels, aux, pageCount);
  const text = wanted.length > 0 ? await reader.pageText(wanted) : new Map<number, string[]>();
  return planLabelPages(labels, aux, pageLabels, { pageCount, text });
}

/**
 * {@link LabelPageReader} over the render service. `text` answers at most `MAX_TEXT_PAGES` pages
 * per call and returns the rest as `skippedPages`, so this asks again for those until every page
 * came back — a page left out would otherwise be `'noEvidence'`, a refusal of a label whose page
 * was never looked at.
 */
export function pdfLabelPageReader(
  renderer: Pick<PdfRenderService, 'pageLabels' | 'pageCount' | 'text'>,
  pdfPath: string,
): LabelPageReader {
  return {
    pageLabels: () => renderer.pageLabels(pdfPath),
    pageCount: () => renderer.pageCount(pdfPath),
    pageText: async (pages) => {
      const text = new Map<number, readonly string[]>();
      let rest = pages;
      while (rest.length > 0) {
        const result = await renderer.text({ pdfPath, pages: rest });
        for (const page of result.pages) text.set(page.page, page.lines);
        // A call that made no progress would loop forever; what it did not return stays absent
        // and is refused as 'noEvidence' rather than retried.
        if (result.skippedPages.length >= rest.length) break;
        rest = result.skippedPages;
      }
      return text;
    },
  };
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
    if (failure.reason === 'multiplyDefined') {
      const recorded = (failure.printedPages ?? []).map(quoteLabel).join(', ');
      const omitted = failure.printedPagesOmitted ?? 0;
      const count = (failure.printedPages?.length ?? 0) + omitted;
      lines.push(
        `  - ${quoteLabel(failure.label)}: multiply defined — the .aux records it ${count} times, ` +
          `on printed page(s) ${recorded}${omitted > 0 ? `, and ${omitted} more` : ''}. LaTeX ` +
          'warns about this and \\ref/\\pageref print the LAST definition, but which \\label ' +
          'was meant is not something the .aux can say. Give each \\label a unique key, compile ' +
          'again, then retry.',
      );
      continue;
    }
    if (failure.reason === 'unverifiedPage') {
      lines.push(`  - ${quoteLabel(failure.label)}: ${unverifiedText(failure)}`);
      continue;
    }
    if (failure.reason === 'pgfpagesLayout') {
      const number =
        failure.number && failure.number !== ''
          ? ` Its number is ${quoteLabel(failure.number)}, if you search for the page yourself.`
          : '';
      lines.push(
        `  - ${quoteLabel(failure.label)}: the .aux records it on printed page ` +
          `${quoteLabel(failure.printedPage ?? '')}, but this build's records (its recorder file ` +
          'or log) name pgfpages.sty or pgfmorepages.sty, and a pgfpages layout ' +
          '(\\pgfpagesuselayout{resize to}, {2 on 1}) holds each page back until the next one ' +
          'is built, so every label records a later page than its own — and the /PageLabels ' +
          'tree and the printed page numbers move with it, so nothing in the PDF can show the ' +
          'shift. No page was assumed.' +
          number,
      );
      continue;
    }
    if (failure.reason === 'pgfpagesUnknown') {
      const number =
        failure.number && failure.number !== ''
          ? ` Its number is ${quoteLabel(failure.number)}, if you search for the page yourself.`
          : '';
      lines.push(
        `  - ${quoteLabel(failure.label)}: the .aux records it on printed page ` +
          `${quoteLabel(failure.printedPage ?? '')}, but neither the build's recorder file ` +
          '(.fls) nor its .log could be read beside the .aux, so whether a pgfpages layout ' +
          '(\\pgfpagesuselayout{resize to}, {2 on 1}) shifted every label a page late cannot ' +
          'be told — and nothing in the PDF would show that shift. No page was assumed.' +
          number,
      );
      continue;
    }
    if (failure.reason === 'slideMismatch') {
      const slides = (failure.slides ?? []).map(quoteLabel).join(' and ');
      const number =
        failure.number && failure.number !== ''
          ? ` Its number is ${quoteLabel(failure.number)}, if you search for the page yourself.`
          : '';
      lines.push(
        `  - ${quoteLabel(failure.label)}: the .aux records it on printed page ` +
          `${quoteLabel(failure.printedPage ?? '')}, but beamer's own record of the slide its ` +
          `\\label ran on (\\beamer@slide) says slide ${slides}. The two disagree when the page ` +
          'moved after the \\label ran — a label in an allowframebreaks frame can land on a later ' +
          "part — and which of the two is this label's PDF page cannot be told from the .aux, " +
          'so neither was assumed.' +
          number,
      );
      continue;
    }
    if (failure.reason === 'restarted') {
      const before = plan.restartedAt?.before;
      const after = plan.restartedAt?.after;
      lines.push(
        `  - ${quoteLabel(failure.label)}: prints on page ${quoteLabel(failure.printedPage ?? '')}, ` +
          'but this document restarts its page numbering — the .aux records ' +
          `${quoteLabel(before?.label ?? '')} on printed page ${quoteLabel(before?.page ?? '')} ` +
          `and the later ${quoteLabel(after?.label ?? '')} on printed page ` +
          `${quoteLabel(after?.page ?? '')} (labels are written as their pages ship, so a page ` +
          'number that goes DOWN is a restart) — so one printed number stands for more than one ' +
          'PDF page here, and which one this label is on cannot be told from the .aux or the ' +
          'folios.',
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
    if ((aux.unreadInputs ?? 0) > 0) {
      // Recompiling does not read a file past a cap, and the note already says what does: a
      // closing "compile again" here would send the caller round the same loop.
      lines.push(
        '  The label may be defined in one of the .aux inputs that were not read (above) — ' +
          'recompiling alone does not change that; the note says what will. Otherwise, a label ' +
          'added or moved since the last compile, or whose reference has not converged yet, is ' +
          'absent until the next compile.',
      );
    } else {
      lines.push(
        '  A label added, moved, or whose reference has not converged yet ("Label(s) may have ' +
          'changed. Rerun to get cross-references right.") is absent until the next compile — ' +
          'compile again and retry.',
      );
    }
  }
  const restarted = plan.failed.some((f) => f.reason === 'restarted');
  if (restarted || plan.failed.some((f) => f.unverified === 'lastPageMismatch')) {
    lines.push(
      (restarted ? '  A' : '  If the numbering does restart: a') +
        ' restarted arabic numbering is ambiguous on either route: /PageLabels (hyperref) ' +
        'prints the repeated numbers too. Numbering the restarted part distinctly (e.g. ' +
        '\\renewcommand{\\thepage}{S\\arabic{page}} for a supplement) and loading hyperref ' +
        "makes it an exact lookup; or find the page yourself: search extract_text's output (or " +
        'pdf_geometry kinds: ["text"]) for the label\'s number.',
    );
  }
  if (plan.failed.some((f) => f.reason === 'pgfpagesLayout')) {
    lines.push(
      '  A pgfpages layout shifts the page of every label in the document, so no label of this ' +
        'build is resolved, whatever the document class and whether or not hyperref is loaded. ' +
        "The build's records show only that the file was opened, not that a layout is in use, " +
        'so this refusal is spurious — and still made — when the document loads pgfpages ' +
        'without \\pgfpagesuselayout or only tests for the file ' +
        '(\\IfFileExists{pgfpages.sty}); removing that load or test lets the lookup run. To look ' +
        'pages up by label, compile without pgfpages (it changes only how pages are laid out on ' +
        "paper); or find the page yourself: search extract_text's output (or pdf_geometry " +
        'kinds: ["text"]) for the label\'s number and pass pages:. To show the last page ' +
        "(lastpage's LastPage, say), pass pages: with the PDF's page count.",
    );
  }
  if (plan.failed.some((f) => f.reason === 'pgfpagesUnknown')) {
    lines.push(
      '  A compile leaves a .log beside the .aux, so compile again and retry; or find the page ' +
        'yourself: search extract_text\'s output (or pdf_geometry kinds: ["text"]) for the ' +
        "label's number and pass pages:.",
    );
  }
  if (plan.failed.some((f) => f.reason === 'slideMismatch')) {
    // Only a build whose records were read and name no pgfpages reaches 'slideMismatch' (the
    // others refuse as 'pgfpagesLayout' or 'pgfpagesUnknown' first), so one message fits.
    lines.push(
      "  This build's records name neither pgfpages nor pgfmorepages, so the disagreement is not a " +
        'pgfpages shift: the usual cause is a \\label in an allowframebreaks frame, which ' +
        'beamer records under the slide the frame began on, and such a label cannot be ' +
        "looked up by label. Find the page yourself: search extract_text's output (or " +
        'pdf_geometry kinds: ["text"]) for the label\'s number and pass pages:.',
    );
  }
  if (plan.failed.some((f) => f.reason === 'unverifiedPage')) {
    if (plan.pageLabelsIgnored === 'beamer') {
      lines.push(
        "  This PDF's /PageLabels tree was not used: the .aux shows a beamer deck, whose page " +
          'labels are FRAME numbers — every overlay slide of a frame repeats its number — ' +
          'while each label records its SLIDE number, so a lookup lands on a later slide (and ' +
          'pgfpages layouts shift the labels even when the tree numbers the pages 1..N). The ' +
          "slide number is used as the PDF page index only when that slide's own footline " +
          'prints it and a neighbouring slide prints the adjacent number. A footline that prints ' +
          'the slide number (\\insertpagenumber, not \\insertframenumber) makes that check ' +
          "pass; or find the page yourself: search extract_text's output (or pdf_geometry " +
          'kinds: ["text"]) for the label\'s number.',
      );
    } else {
      lines.push(
        '  This PDF has no /PageLabels tree, so a printed page is used as the PDF page index only ' +
          "when that PDF page's own folio (the page number in its footer or running head) reads " +
          'the same, and a neighbouring page reads as the adjacent number — a title page, a ' +
          'titlepage environment, \\setcounter{page} or unlabelled roman front matter all shift ' +
          'it, and a section number or table cell can stand where the folio is looked for. ' +
          'Loading hyperref writes /PageLabels, which turns this into an exact lookup (though a ' +
          'title page with no printed number is still labelled like the first numbered page, and ' +
          "that stays ambiguous); or find the page yourself: search extract_text's output (or " +
          'pdf_geometry kinds: ["text"]) for the label\'s number.',
      );
    }
  }
  lines.push(
    '  Nothing was rendered and no page was guessed. To choose a page yourself, read the index ' +
      'with pdf_geometry kinds: ["floats"] and pass pages: explicitly.',
  );
  return lines.join('\n');
}

function unverifiedText(failure: LabelFailure): string {
  const printed = quoteLabel(failure.printedPage ?? '');
  const page = failure.printedPage ?? '';
  const folios = (failure.folios ?? []).map(quoteLabel);
  const number =
    failure.number && failure.number !== ''
      ? ` Its number is ${quoteLabel(failure.number)}, if you search for the page yourself.`
      : '';
  switch (failure.unverified) {
    case 'pastEndOfPdf':
      return (
        `the .aux records printed page ${printed}, but this PDF has ${failure.pageCount ?? '?'} ` +
        'page(s) — either that .aux is stale relative to the PDF beside it (compile ' +
        'again), or the document starts its numbering high (\\setcounter{page}); without ' +
        '/PageLabels the two cannot be told apart.'
      );
    case 'noEvidence':
      return (
        `the .aux records printed page ${printed}, but the text of that PDF page could not be ` +
        'read to check it, and an unchecked page is not rendered.' +
        number
      );
    case 'folioMismatch':
      return (
        `the .aux records printed page ${printed}, but PDF page ${page} reads as page number ` +
        `${folios.join(' or ')}, not ${printed} (what was read may be its folio or a section ` +
        "mark in its place), so it is not taken to be the label's page, and the real one is not " +
        'guessed.' +
        number
      );
    case 'uncorroboratedFolio': {
      const around = (failure.neighbours ?? [])
        .map((n) =>
          n.folios === null
            ? `PDF page ${n.page} could not be read`
            : n.folios.length === 0
              ? `PDF page ${n.page} reads as no page number`
              : `PDF page ${n.page} reads as ${n.folios.map(quoteLabel).join(' or ')}`,
        )
        .join(', and ');
      return (
        `the .aux records printed page ${printed}, and PDF page ${page} reads as ${printed}, but ` +
        `no neighbouring page reads as the adjacent number (${around}) — a section number or a ` +
        'table cell can read as a page number on one page, a folio continues on the next — so ' +
        `the page is not confirmed to be printed page ${printed}, and it was not assumed to be.` +
        number
      );
    }
    case 'lastPageMismatch': {
      const last = failure.lastPage;
      const count = last?.page ?? '?';
      const why =
        last?.folios === null || last === undefined
          ? 'could not be read, so nothing shows the numbering reaches it in step — an arabic ' +
            'restart (\\setcounter{page}{1} before a supplement, a second ' +
            '\\pagenumbering{arabic}) would not'
          : `reads as page number ${last.folios.map(quoteLabel).join(' or ')}, not the page ` +
            `count ${count} — a restarted numbering (\\setcounter{page}{1} before a supplement, ` +
            'a second \\pagenumbering{arabic}), under which one printed number stands for two ' +
            'PDF pages, or a last page whose running head or appended content shows a different ' +
            'number (a section heading opening an unnumbered last page, an \\includepdf page ' +
            'with its own folio); the text layer cannot tell the two apart';
      return (
        `the .aux records printed page ${printed}, and PDF page ${page} reads as ${printed} with ` +
        `a neighbour agreeing, but the last PDF page, ${count}, ${why} — so the page is not ` +
        `confirmed to be printed page ${printed}, and it was not assumed to be.` +
        number
      );
    }
    case 'ambiguousFolio':
      return (
        `the .aux records printed page ${printed}, but PDF page ${page}'s running head reads as ` +
        `page number ${folios.join(' or ')} — a section number in the head and the folio look ` +
        'alike in the text layer — so the page does not confirm it is printed page ' +
        `${printed}, and it was not assumed to be.` +
        number
      );
    default:
      return (
        `the .aux records printed page ${printed}, but PDF page ${page} shows no page number ` +
        '(no folio in its footer or running head — a title page, or \\pagestyle{empty}), so ' +
        `nothing on it confirms it is printed page ${printed}, and it was not assumed to be.` +
        number
      );
  }
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
      : "which records each label's PRINTED page. " +
        (plan.pageLabelsIgnored === 'beamer'
          ? "This PDF's /PageLabels tree was not used — the .aux shows a beamer deck, whose " +
            'page labels number frames while each label records its slide — so the '
          : 'This PDF carries no /PageLabels tree, so the ') +
        "printed page was taken as the page index only after that PDF page's own folio (the " +
        'page number in its footer or running head, read from its text layer) was found to ' +
        'read the same, a neighbouring page read as the adjacent number, and the last page read ' +
        'as no decimal page number other than the page count (a restarted numbering usually ' +
        'ends on a smaller one) — evidence, not proof: a restart ' +
        'whose last page shows no page number goes unseen, and a number standing where the ' +
        'folio is looked for (a table cell, or a line such as "3/9" or "– 3 –", above an empty ' +
        'foot) can read like one, so check the result' +
        (plan.pageLabelsIgnored === 'beamer' ? '' : ', and load hyperref for an exact lookup');
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

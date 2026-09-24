/**
 * Deciding how much of `extract_text`'s per-page lines may be returned, against ONE character
 * budget for the whole call, charged on what is RENDERED in both channels the lines ship in. A
 * pure planner over plain data, the same shape as `src/lib/geometryBudget.ts` (the sibling PDF
 * tool) and `src/lib/statusBudget.ts`: a budget, a plan, a human-readable `note`, and a tool layer
 * that only maps the plan onto the response. It imports nothing from the tool layer or the PDF
 * service and touches no fs/process/clock, so it stays testable on its own.
 *
 * Why it exists. The only bound was the PDF service's per-PAGE budget — 20000 characters held on
 * one page, counted over the line strings alone — applied to up to four pages, after which every
 * kept line shipped twice: joined into the text channel and JSON-escaped into `structuredContent`.
 * Four dense pages therefore returned ~160k characters with every counter at 0, and an ordinary
 * paper ~53k — past, or near, the ~67k a client rejected undelivered in #68. A per-page count of
 * held characters is not a bound on what a client receives; this is.
 *
 * **Both channels are charged, by calling their templates.** A kept line costs its raw length plus
 * its newline in the text channel, and its JSON encoding (escaping and all — LaTeX output is
 * backslash- and quote-dense) plus its comma in `structuredContent.pages[].lines`. The text
 * channel's per-page block is rendered here ({@link renderTextPageBlock}), and the JSON side is a
 * real `JSON.stringify` of the exact page object the tool emits ({@link emitTextPage}); the cost
 * functions call both, so there is no overhead constant to drift out from under a template. The
 * accounting is an UPPER bound: each array element is charged its separator, and each page's
 * scaffold is charged with its counters and cut marker at their worst case.
 *
 * **Pages are lanes of one cause, so strict priority is the wrong reading** (the `statusBudget.ts`
 * rule). One dense document fills every page at once; a pool spent page by page gave page 1 the
 * whole budget and pages 2-4 nothing — an answer about one page to a question about four. So every
 * page is guaranteed an equal share first, and the surplus left by pages that wanted less (a title
 * page, a figure page) is then spent in the caller's page order.
 *
 * **The cut is a suffix of each page**, never a budget-packed selection: the first line that does
 * not fit ends that page's lane. The caller is reading, and a prefix of the page in drawing order
 * is readable where scattered lines are not. This is the ONLY cut: the PDF service returns every
 * merged line whole (it once cut each page at 20000 characters and truncated a longer line to that
 * plus "…", which this plan then counted at the truncated length — PB3). Its `TextPage` still
 * carries counters, and they are merged here, so a page's `linesOmitted`/`charsOmitted` would
 * count the whole gap after its `lines` even if the service ever cut a suffix of its own.
 */
import { CONFLICT_CONTENT_BUDGET } from './conflictBudget.js';

/**
 * Total character budget for one `extract_text` result's pages, across BOTH channels combined.
 *
 * The house figure (20000), imported rather than restated: one number, one place to change it.
 * Charged across both channels, so a call carries at most ~10000 characters of page text — two
 * dense two-column pages (~5000 each) whole, or a fair share of four.
 */
export const EXTRACT_TEXT_CONTENT_BUDGET = CONFLICT_CONTENT_BUDGET;

/** One page as the PDF service produced it: every merged line, whole, in drawing order. */
export interface TextPageLike {
  page: number;
  lines: readonly string[];
  /** Lines the service's own cut left out (a suffix) — 0 from today's service, which cuts nothing. */
  linesOmitted: number;
  /** Characters those lines held. */
  charsOmitted: number;
}

/** A page exactly as it ships in `structuredContent.pages[]` — key order included. */
export interface ExtractedTextPage {
  page: number;
  lines: string[];
  /** Every line after `lines`, whichever cut left it out. */
  linesOmitted: number;
  /** The characters those lines held. */
  charsOmitted: number;
}

export interface TextBudgetPlan {
  /** Every input page, in input order, each cut to a prefix, with merged counters. */
  pages: ExtractedTextPage[];
  /** Lines THIS budget cut, over all pages (the service's own cut is not included). */
  linesOmittedBySize: number;
  /** Characters those lines held. */
  charsOmittedBySize: number;
  /** What the plan charged — an upper bound on the rendered size of the page payload. */
  charged: number;
  /** Present only when something was cut. */
  note?: string;
}

/** The `[` and `]` of the `pages` array itself. */
export const PAGES_ARRAY_JSON_OVERHEAD = 2;
/** The `\n` joining one text-channel page block to the next line of the result text. */
export const TEXT_BLOCK_SEPARATOR_OVERHEAD = 1;
/** The `,` separating one array element from the next in `structuredContent`. */
export const ELEMENT_SEPARATOR_OVERHEAD = 1;

/** The page object as the tool emits it. One constructor, so the cost and the output agree. */
export function emitTextPage(p: TextPageLike): ExtractedTextPage {
  return {
    page: p.page,
    lines: [...p.lines],
    linesOmitted: p.linesOmitted,
    charsOmitted: p.charsOmitted,
  };
}

/**
 * The text-channel block for one page: a header, the kept lines verbatim, and — only when
 * something was cut — one marker line saying how much. The tool joins these with `\n`.
 *
 * Lines are kept verbatim, an empty one included: filtering empty strings out of the text channel
 * would make it disagree with `structuredContent` about what the page holds.
 */
export function renderTextPageBlock(p: ExtractedTextPage): string {
  const parts = [`--- page ${p.page} ---`, ...p.lines];
  if (p.linesOmitted > 0) {
    parts.push(
      `  … ${p.linesOmitted} further line(s) (${p.charsOmitted} chars) cut from the end of this page`,
    );
  }
  return parts.join('\n');
}

const EMPTY_BLOCK_LENGTH = renderTextPageBlock({
  page: 0,
  lines: [],
  linesOmitted: 0,
  charsOmitted: 0,
}).length;

/**
 * What one kept line costs, both channels: its increment to the rendered text block (measured by
 * rendering it) plus its JSON encoding and separator in the `lines` array.
 */
export function textLineCost(line: string): number {
  const textSide =
    renderTextPageBlock({ page: 0, lines: [line], linesOmitted: 0, charsOmitted: 0 }).length -
    EMPTY_BLOCK_LENGTH;
  return textSide + JSON.stringify(line).length + ELEMENT_SEPARATOR_OVERHEAD;
}

/**
 * What a page costs with NO lines kept — header, cut marker and JSON scaffold — plus its separator
 * in each channel. The counters are rendered at their worst case (every line cut), so whatever the
 * plan finally writes can only be shorter.
 */
export function textPageSkeletonCost(p: TextPageLike): number {
  let chars = p.charsOmitted;
  for (const l of p.lines) chars += l.length;
  const worst: ExtractedTextPage = {
    page: p.page,
    lines: [],
    linesOmitted: p.linesOmitted + p.lines.length,
    charsOmitted: chars,
  };
  return (
    renderTextPageBlock(worst).length +
    TEXT_BLOCK_SEPARATOR_OVERHEAD +
    JSON.stringify(emitTextPage(worst)).length +
    ELEMENT_SEPARATOR_OVERHEAD
  );
}

interface Lane {
  source: readonly string[];
  kept: number;
}

/**
 * Plan which lines fit.
 *
 * Every page's scaffold is charged first, as mandatory content (bounded: at most `MAX_TEXT_PAGES`
 * pages of fixed fields). What is left is spent in two passes over the pages:
 *
 *  - **Pass 1 gives every page an equal guaranteed share**, so no page is starved by the ones
 *    ahead of it (see the module note — the lanes overlap).
 *  - **Pass 2 spends everything left in page order**, resuming each page where pass 1 stopped, so
 *    a page that wanted less than its share releases the surplus to the pages that want more.
 *
 * No keep-at-least-one rule: a page whose first line alone outruns what is left comes back with
 * `lines: []` and counters saying exactly what was cut, which is unconfusable with a page that has
 * no text (`lines: []`, both counters 0).
 */
export function planExtractedText(
  pages: readonly TextPageLike[],
  opts: { budget?: number } = {},
): TextBudgetPlan {
  const budget = opts.budget ?? EXTRACT_TEXT_CONTENT_BUDGET;

  let charged = PAGES_ARRAY_JSON_OVERHEAD;
  for (const p of pages) charged += textPageSkeletonCost(p);
  let remaining = budget - charged;

  const lanes: Lane[] = pages.map((p) => ({ source: p.lines, kept: 0 }));
  const share = lanes.length > 0 ? Math.floor(Math.max(remaining, 0) / lanes.length) : 0;
  for (const pass of [share, Number.POSITIVE_INFINITY]) {
    for (const lane of lanes) {
      let laneRemaining = Math.min(Math.max(remaining, 0), pass);
      while (lane.kept < lane.source.length) {
        const cost = textLineCost(lane.source[lane.kept]!);
        if (cost > laneRemaining) break;
        laneRemaining -= cost;
        remaining -= cost;
        charged += cost;
        lane.kept += 1;
      }
    }
  }

  let linesOmittedBySize = 0;
  let charsOmittedBySize = 0;
  const servicePages: Array<{ page: number; lines: number; chars: number }> = [];
  const cutPages: ExtractedTextPage[] = [];
  const out = pages.map((p, i) => {
    const lane = lanes[i]!;
    const cut = p.lines.slice(lane.kept);
    let cutChars = 0;
    for (const l of cut) cutChars += l.length;
    linesOmittedBySize += cut.length;
    charsOmittedBySize += cutChars;
    if (p.linesOmitted > 0) {
      servicePages.push({ page: p.page, lines: p.linesOmitted, chars: p.charsOmitted });
    }
    const emitted = emitTextPage({
      page: p.page,
      lines: p.lines.slice(0, lane.kept),
      linesOmitted: p.linesOmitted + cut.length,
      charsOmitted: p.charsOmitted + cutChars,
    });
    if (emitted.linesOmitted > 0) cutPages.push(emitted);
    return emitted;
  });

  const plan: TextBudgetPlan = { pages: out, linesOmittedBySize, charsOmittedBySize, charged };
  if (cutPages.length > 0) {
    plan.note = buildTextBudgetNote({
      cutPages,
      linesOmittedBySize,
      charsOmittedBySize,
      servicePages,
      pageCount: pages.length,
      budget,
    });
  }
  return plan;
}

/**
 * The note for a cut. Names only the cut(s) that actually fired — this call-wide budget, a cut
 * the PDF service reported making itself, or both — lists every cut page (at most `MAX_TEXT_PAGES`, so bounded),
 * and says honestly what a caller can do about it.
 */
export function buildTextBudgetNote(args: {
  cutPages: readonly ExtractedTextPage[];
  linesOmittedBySize: number;
  charsOmittedBySize: number;
  servicePages: ReadonlyArray<{ page: number; lines: number; chars: number }>;
  pageCount: number;
  budget?: number;
}): string {
  const budget = args.budget ?? EXTRACT_TEXT_CONTENT_BUDGET;
  const perPage = args.cutPages
    .map((p) => `page ${p.page} (${p.linesOmitted} line(s), ${p.charsOmitted} chars)`)
    .join(', ');
  const causes: string[] = [];
  if (args.linesOmittedBySize > 0) {
    causes.push(
      `the call's ${budget}-character text budget (charged on the rendered text in both ` +
        'channels, each page guaranteed an equal share): ' +
        `${args.linesOmittedBySize} line(s), ${args.charsOmittedBySize} chars`,
    );
  }
  if (args.servicePages.length > 0) {
    const lines = args.servicePages.reduce((n, p) => n + p.lines, 0);
    causes.push(`the PDF extractor's own cut: ${lines} line(s)`);
  }
  const narrower =
    args.pageCount > 1
      ? 'Ask for fewer pages (pages: [n]) to give each a larger share, or use'
      : 'Use';
  return (
    `The end of ${args.cutPages.length} page(s) was cut: ${perPage}. ` +
    `Cut by ${causes.join('; and by ')}. Counted per page in linesOmitted/charsOmitted; the cut lines are ` +
    `not in this result. ${narrower} pdf_geometry kinds: ["text"] to see where the remaining ` +
    'lines sit.'
  );
}

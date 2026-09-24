/**
 * Deciding how much of `pdf_geometry`'s per-page boxes may be returned, against a character budget
 * charged on the RENDERED (JSON-encoded) `pages` array. A pure planner over plain data, the same
 * shape as `src/lib/floatsBudget.ts` (the same tool's other lane) and `src/lib/statusBudget.ts`: a
 * budget, a plan, a human-readable `note`, and a tool layer that only maps the plan onto the
 * response. It imports nothing from the tool layer or the PDF service and touches no
 * fs/process/clock, so it stays testable on its own.
 *
 * Why it exists. The page payload was bounded by COUNT alone — `MAX_GEOMETRY_PAGES` (4) pages x
 * `MAX_TEXT_LINES_PER_PAGE` (300) text boxes, plus `MAX_IMAGE_RECTS_PER_PAGE` (100) image boxes
 * per page. Every text box carries a document-controlled `text` label of up to 160 characters and
 * roughly a hundred characters of JSON around it, so a default call on an ordinary six-page
 * two-column paper returned ~76k characters of `structuredContent` (past the ~67k a client
 * rejected undelivered in #68) with `textOmitted: 0`, and the count caps allowed ~370k. A count
 * cap is not a bound on what a client receives; this is.
 *
 * **Which channel is charged.** The text channel of `pdf_geometry` renders COUNTS per page — "N
 * text line(s)", "N image rect(s)" — never a box or a label, so the boxes ship in exactly one
 * channel, `structuredContent`, and are charged once, on their JSON encoding. If the text channel
 * ever starts rendering boxes, this module must charge that rendering too (the rule every budget
 * here keeps: charge every channel a payload ships in).
 *
 * **Charged by calling the renderer, not by a constant.** Every cost below is a real
 * `JSON.stringify(...).length` of the exact object the tool emits — a box's own encoding, and a
 * page's skeleton (every field but its boxes) encoded as it will ship, the new counters included.
 * So there is no overhead constant to drift out from under the template: the "template" is JSON,
 * and the cost function calls it. The accounting is an exact UPPER bound on
 * `JSON.stringify(pages).length`: each array element is charged its trailing comma, so every
 * array comes out exactly one character high, never low.
 *
 * **Lanes overlap, so strict priority is the wrong reading** (the `statusBudget.ts` rule). One
 * cause — a dense document — fills every page's text lane at once, so spending the pool page by
 * page gave page 1 its 300 lines and left pages 2-4 empty: a result that measures one page and
 * says nothing of three the caller asked for. So every lane (one per page per requested kind) is
 * guaranteed an equal share first, and the surplus left by lanes that wanted less (a page with
 * three figures, a sparse title page) is redistributed equally among the lanes that want more.
 */
import { FLOATS_CONTENT_BUDGET } from './floatsBudget.js';

/**
 * Total character budget for the `pages` array of one `pdf_geometry` result, JSON-encoded.
 *
 * The house figure (20000), imported from the same tool's floats budget rather than restated: one
 * number, one place to change it. The two are separate ALLOCATIONS of it because they are
 * separate lanes of one result with nothing to trade between them — the float index is
 * document-wide and the boxes are per page — so the worst case for the whole result is two
 * budgets plus a small fixed scaffold, ~40k, well inside the ~67k #68 saw rejected.
 */
export const GEOMETRY_CONTENT_BUDGET = FLOATS_CONTENT_BUDGET;

/** The kinds of box a page carries. */
export type GeometryLaneKind = 'images' | 'text';

/**
 * Priority for the last crumbs of the budget (see {@link planGeometryPayload}), highest first.
 * Image rects before text lines: an image rect is the figure
 * frame a text box is measured AGAINST (the question the tool exists for is "does this text
 * overlap that figure"), a page carries a handful of them, and without them the text boxes have
 * nothing to be compared with. Text lanes are the ones that are large in practice, so ranking the
 * small lane first costs the large one almost nothing. Within a kind, pages are funded in the
 * order the result lists them — the caller's own order.
 */
export const ALLOCATION_ORDER: readonly GeometryLaneKind[] = ['images', 'text'];

/** One page as the PDF service produced it: whatever it carries, plus the two box lists. */
export interface GeometryPageLike {
  text?: readonly object[];
  images?: readonly object[];
}

/** A page as it ships: the input page with its lists cut to a prefix and two size counters added. */
export type BudgetedGeometryPage<P extends GeometryPageLike> = P & {
  /** Text boxes cut from the END of this page's list by the size budget. 0 when it never fired. */
  textOmittedBySize: number;
  /** Image boxes cut from the END of this page's list by the size budget. 0 when it never fired. */
  imagesOmittedBySize: number;
};

export interface GeometryPlan<P extends GeometryPageLike> {
  /** Every input page, in the input's order, each with its lists cut to a prefix. */
  pages: BudgetedGeometryPage<P>[];
  /** Totals of the per-page counters, for the note and the text channel. */
  textOmittedBySize: number;
  imagesOmittedBySize: number;
  /** Present only when the budget cut something. */
  note?: string;
}

/** What one box costs as an element of its array: its exact encoding plus its separator. */
export function boxCost(box: object): number {
  return JSON.stringify(box).length + 1;
}

/**
 * What a page costs with EMPTY lists — its scaffold, keys, numbers and the `[]` of each requested
 * list — plus its separator in the `pages` array. The size counters are encoded at their worst
 * case (the whole list cut), so the digits the plan finally writes can only be fewer.
 */
export function pageSkeletonCost(page: GeometryPageLike): number {
  const skeleton = {
    ...page,
    text: page.text === undefined ? undefined : [],
    images: page.images === undefined ? undefined : [],
    textOmittedBySize: page.text?.length ?? 0,
    imagesOmittedBySize: page.images?.length ?? 0,
  };
  return JSON.stringify(skeleton).length + 1;
}

/** The `[` and `]` of the `pages` array itself. */
export const PAGES_ARRAY_JSON_OVERHEAD = 2;

interface Lane {
  source: readonly object[];
  /** How many boxes, from the front, are kept so far. */
  kept: number;
}

/**
 * Plan which boxes fit.
 *
 * Every page's scaffold is charged first, as mandatory content (it is bounded: at most
 * `MAX_GEOMETRY_PAGES` pages of fixed fields). What is left is spent over the lanes — one lane per
 * page per requested kind, ordered by {@link ALLOCATION_ORDER} and then by page — by
 * water-filling:
 *
 *  - **The first round gives every lane an equal guaranteed share**, so no page is starved by the
 *    pages ahead of it (see the module note — the lanes overlap).
 *  - **Every later round splits the surplus equally among the lanes that still want more**, so a
 *    lane that wanted less than its share (a page's three figure frames, a sparse title page)
 *    releases the rest to the others, and a page is never short-changed merely for coming later.
 *    Pages are lanes of equal standing — the caller asked for each of them — so spending the
 *    surplus top-to-bottom instead gave a real six-page paper 115 lines on page 1 and ~20 on each
 *    of pages 2-4.
 *  - **The crumbs** — what is left once no hungry lane's next box fits its split — go in strict
 *    {@link ALLOCATION_ORDER}, which is the only place that order decides anything.
 *
 * Within a lane the boxes are charged in drawing order and the kept part is a **prefix**: the cut
 * is always a suffix, nothing is reordered and small boxes are never preferred, because a
 * cherry-picked list of lines is a different answer to "what is on this page, from the top".
 *
 * "Cut" stays distinguishable from "absent": a requested list is never removed, only shortened,
 * and every cut box is counted in its page's `textOmittedBySize`/`imagesOmittedBySize` — so
 * `text: []` with a non-zero counter means "all cut", and a missing `text` still means only "not
 * requested". No keep-at-least-one rule is needed for that, and none is applied: with the house
 * budget and at most eight lanes a share is ~2400 characters, and the largest box the service can
 * produce (a 160-character label of escaped control characters) is ~1100.
 */
export function planGeometryPayload<P extends GeometryPageLike>(
  pages: readonly P[],
  opts: { budget?: number } = {},
): GeometryPlan<P> {
  const budget = opts.budget ?? GEOMETRY_CONTENT_BUDGET;

  let remaining = budget - PAGES_ARRAY_JSON_OVERHEAD;
  for (const p of pages) remaining -= pageSkeletonCost(p);

  const lanesByPage = pages.map((p) => ({
    text: p.text === undefined ? undefined : ({ source: p.text, kept: 0 } as Lane),
    images: p.images === undefined ? undefined : ({ source: p.images, kept: 0 } as Lane),
  }));
  const ordered: Lane[] = [];
  for (const kind of ALLOCATION_ORDER) {
    for (const lanes of lanesByPage) {
      const lane = lanes[kind];
      if (lane) ordered.push(lane);
    }
  }

  // Water-filling: every round splits what is left equally among the lanes that still want more,
  // and each takes boxes up to its split. The first round is the guaranteed equal share; later
  // rounds redistribute what the lanes that wanted less released. It stops when a round keeps
  // nothing — every hungry lane's next box is bigger than its split — and the crumbs left then go
  // in strict priority order, so they are spent rather than wasted. Terminates: every round but
  // the last keeps at least one box, and there are finitely many.
  const fill = (lane: Lane, allowance: number): number => {
    let spent = 0;
    while (lane.kept < lane.source.length) {
      const cost = boxCost(lane.source[lane.kept]!);
      if (spent + cost > allowance) break;
      spent += cost;
      lane.kept += 1;
    }
    remaining -= spent;
    return spent;
  };
  for (;;) {
    const hungry = ordered.filter((l) => l.kept < l.source.length);
    if (hungry.length === 0 || remaining <= 0) break;
    const share = Math.floor(remaining / hungry.length);
    let progressed = false;
    for (const lane of hungry) if (fill(lane, share) > 0) progressed = true;
    if (!progressed) {
      for (const lane of ordered) fill(lane, Math.max(remaining, 0));
      break;
    }
  }

  let textOmittedBySize = 0;
  let imagesOmittedBySize = 0;
  const out = pages.map((p, i) => {
    const lanes = lanesByPage[i]!;
    const textCut = lanes.text ? lanes.text.source.length - lanes.text.kept : 0;
    const imagesCut = lanes.images ? lanes.images.source.length - lanes.images.kept : 0;
    textOmittedBySize += textCut;
    imagesOmittedBySize += imagesCut;
    return {
      ...p,
      text: lanes.text ? lanes.text.source.slice(0, lanes.text.kept) : undefined,
      images: lanes.images ? lanes.images.source.slice(0, lanes.images.kept) : undefined,
      textOmittedBySize: textCut,
      imagesOmittedBySize: imagesCut,
    } as BudgetedGeometryPage<P>;
  });

  const plan: GeometryPlan<P> = { pages: out, textOmittedBySize, imagesOmittedBySize };
  if (textOmittedBySize > 0 || imagesOmittedBySize > 0) {
    plan.note = buildGeometryNote(textOmittedBySize, imagesOmittedBySize, pages.length, budget);
  }
  return plan;
}

/**
 * The note for a cut. Names only what actually fired, and says honestly what a caller can do: the
 * cut boxes are not fetchable from this result, and asking for fewer pages (or one kind) gives the
 * rest of the budget to what is left.
 */
export function buildGeometryNote(
  textCut: number,
  imagesCut: number,
  pageCount: number,
  budget: number = GEOMETRY_CONTENT_BUDGET,
): string {
  const parts: string[] = [];
  if (textCut > 0) parts.push(`${textCut} text line(s)`);
  if (imagesCut > 0) parts.push(`${imagesCut} image rect(s)`);
  const narrower =
    pageCount > 1
      ? 'Ask for fewer pages (pages: [n]) or fewer kinds to give what remains a larger share.'
      : 'Ask for one kind at a time to give it the whole budget.';
  return (
    `${parts.join(' and ')} cut from the end of their page(s): the page geometry hit its ` +
    `${budget}-character budget (charged on the JSON-encoded boxes, each page guaranteed an ` +
    'equal share). Counted per page in textOmittedBySize / imagesOmittedBySize; the cut boxes ' +
    `are not fetchable from this result. ${narrower}`
  );
}

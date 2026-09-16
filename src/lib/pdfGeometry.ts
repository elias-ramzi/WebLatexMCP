/**
 * Pure PDF geometry math: matrices, boxes, and text-line merging. No `pdfjs-dist` import here —
 * that is what makes this module unit-testable without pdf.js or a real PDF (see pdfRender.ts,
 * which is the one place that walks a real operator list and text-content stream and feeds this
 * module plain numbers).
 */

/** A PDF transformation matrix [a, b, c, d, e, f], applied to a row-vector point as
 *  `[x' y'] = [x*a + y*c + e, x*b + y*d + f]` — the PDF/pdf.js convention. */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * Compose: the matrix that applies `m` and then `base` (PDF order — this is what a `cm` operator
 * does to the current transformation matrix: a point in the new, innermost coordinate system is
 * mapped by `m` into the space `base` already maps to the page).
 */
export function multiply(m: Matrix, base: Matrix): Matrix {
  const [ma, mb, mc, md, me, mf] = m;
  const [ba, bb, bc, bd, be, bf] = base;
  return [
    ba * ma + bc * mb,
    bb * ma + bd * mb,
    ba * mc + bc * md,
    bb * mc + bd * md,
    ba * me + bc * mf + be,
    bb * me + bd * mf + bf,
  ];
}

/** A box in PDF points. Origin **top-left** of the page unless documented otherwise — callers get
 *  there by mapping through a pdf.js viewport's own `transform` (see `transformedBoxBounds`),
 *  never by a manual y-flip: that transform is rotation- and MediaBox-origin-aware, a hand y-flip
 *  is not. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Axis-aligned bounding box of an arbitrary box transformed by `m`, in the space `m` maps into.
 * `unitSquareBounds` is the special case where `box` is [0,0]-[1,1] — this general form also
 * backs a form XObject's own `/BBox`, which need not be the unit square.
 */
export function transformedBoxBounds(box: Box, m: Matrix): Box {
  const [a, b, c, d, e, f] = m;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const x of [box.x0, box.x1]) {
    for (const y of [box.y0, box.y1]) {
      xs.push(x * a + y * c + e);
      ys.push(x * b + y * d + f);
    }
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * Axis-aligned bounding box of the unit square [0,1]x[0,1] transformed by `m`, in user space
 * (origin bottom-left, the same space `m` operates in). A PDF image XObject is always painted
 * into the unit square, so this is the placement rectangle a CTM alone gives for one.
 */
export function unitSquareBounds(m: Matrix): Box {
  return transformedBoxBounds({ x0: 0, y0: 0, x1: 1, y1: 1 }, m);
}

/** Round every edge to `dp` decimal places (default 2) so results are stable and compact. */
export function roundBox(b: Box, dp = 2): Box {
  const factor = 10 ** dp;
  const r = (v: number) => Math.round(v * factor) / factor;
  return { x0: r(b.x0), y0: r(b.y0), x1: r(b.x1), y1: r(b.y1) };
}

/** The slice of a pdf.js text item this module needs — kept independent of pdf.js's own type so
 *  this module never imports it. */
export interface TextItemLike {
  str: string;
  /** pdf.js text-item transform: [a,b,c,d,e,f], with (e,f) the glyph origin in user space. */
  transform: Matrix;
  width: number;
  height: number;
}

export interface TextLine {
  text: string;
  /** User space, origin bottom-left; the caller maps it to page space with the viewport's own
   *  `transform` (via `transformedBoxBounds`), never a manual y-flip. */
  box: Box;
  /** How many text items were merged into this line. */
  items: number;
}

const DEFAULT_BASELINE_TOLERANCE_PT = 1;
const DEFAULT_GAP_TOLERANCE_PT = 6;
const DEFAULT_MAX_TEXT_CHARS = 160;

/** An item's axis-aligned box in user space: (transform[4], transform[5]) is the glyph origin,
 *  and pdf.js already reports width/height in user-space units for a text item. */
function itemBox(item: TextItemLike): Box {
  const x0 = item.transform[4];
  const y0 = item.transform[5];
  return { x0, y0, x1: x0 + item.width, y1: y0 + item.height };
}

function unionBox(a: Box, b: Box): Box {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * Merge pdf.js text items into per-line boxes. Two items join a line when their baselines
 * (transform[5]) agree within `baselineTolerancePt` and they are horizontally adjacent or
 * overlapping within `gapTolerancePt`; otherwise a new line starts.
 *
 * Order-sensitive over `items` as pdf.js yields them (the document's drawing order) — never
 * sorted, so two interleaved columns are not silently reordered into one line.
 */
export function mergeTextLines(
  items: TextItemLike[],
  opts?: { baselineTolerancePt?: number; gapTolerancePt?: number; maxTextChars?: number },
): TextLine[] {
  const baselineTolerancePt = opts?.baselineTolerancePt ?? DEFAULT_BASELINE_TOLERANCE_PT;
  const gapTolerancePt = opts?.gapTolerancePt ?? DEFAULT_GAP_TOLERANCE_PT;
  const maxTextChars = opts?.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;

  interface Building {
    text: string;
    box: Box;
    items: number;
    baseline: number;
  }

  const lines: Building[] = [];
  let current: Building | undefined;

  for (const item of items) {
    if (item.str.trim() === '') {
      continue;
    }
    const box = itemBox(item);
    const baseline = item.transform[5];

    if (current) {
      const sameBaseline = Math.abs(baseline - current.baseline) <= baselineTolerancePt;
      // Horizontally adjacent or overlapping: the gap between the new item's left edge and the
      // running line's right edge is within tolerance. A negative gap (overlap) always joins.
      const gap = box.x0 - current.box.x1;
      const adjacent = gap <= gapTolerancePt;
      if (sameBaseline && adjacent) {
        current.text += item.str;
        current.box = unionBox(current.box, box);
        current.items += 1;
        continue;
      }
    }

    if (current) {
      lines.push(current);
    }
    current = { text: item.str, box, items: 1, baseline };
  }
  if (current) {
    lines.push(current);
  }

  return lines.map((l) => ({
    text: truncate(l.text, maxTextChars),
    box: l.box,
    items: l.items,
  }));
}

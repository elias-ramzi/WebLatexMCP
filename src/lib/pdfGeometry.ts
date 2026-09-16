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

/** Whether a unit axis (a direction or up vector, already normalized) is usable — both components
 *  must come out finite, since a document-controlled matrix can normalize to a NaN/Infinity
 *  component (see itemBox's own comment on why that matters). */
function isFiniteAxis(axis: readonly [number, number]): boolean {
  return Number.isFinite(axis[0]) && Number.isFinite(axis[1]);
}

/** Whether any edge of `b` is `NaN` or `Infinity`/`-Infinity`. A document-controlled matrix (an
 *  overflowing text-rendering matrix here, or a `cm`/`/Matrix` operand in pdfRender.ts's image/
 *  form walk) can produce one, and the tool's `z.number()` schema rejects both AFTER the MCP
 *  handler returns — outside its try/catch, so an escaping non-finite edge is never scrubbed by
 *  `errorResult` and fails the *whole* call, discarding every other page's geometry with it. Used
 *  both here (mergeTextLines drops a poisoned item before it can be unioned into a line) and in
 *  pdfRender.ts (the image/form push sites, and the text-box mapping) — one rule, enforced at
 *  every point a box could pick up a non-finite edge. */
export function hasNonFiniteEdge(b: Box): boolean {
  return (
    !Number.isFinite(b.x0) ||
    !Number.isFinite(b.y0) ||
    !Number.isFinite(b.x1) ||
    !Number.isFinite(b.y1)
  );
}

/** An item's axis-aligned box in user space, built from the text-rendering matrix itself rather
 *  than from +x/+y: `(transform[4], transform[5])` is the glyph origin, `width` is the advance
 *  measured along the matrix's own text-direction axis `(a,b)`, and `height` is the em size
 *  measured along its up axis `(c,d)` (pdf.js already reports both in transformed units — it sets
 *  `height = Math.hypot(c, d)`). Both are applied along the *unit* vectors of those two axes, so a
 *  rotated item (e.g. any text on a `pdflscape` landscape page, whose /Rotate 90 rotates the
 *  content, not just the MediaBox) gets a box aligned to its own direction rather than transposed
 *  onto +x/+y. For an unrotated item (`b = c = 0`, so `dir = (1,0)` and `up = (0,1)`) this reduces
 *  exactly to the old axis-aligned `{x0:e, y0:f, x1:e+width, y1:f+height}` — no rounding drift.
 *
 *  The direction/up AXES get a sane fallback when non-finite (see isFiniteAxis, above) — falling
 *  back to the unrotated unit vectors keeps a usable box. The item's ORIGIN (`e`, `f`) and its
 *  `width`/`height` get no equivalent fallback here: unlike a unit axis, there is no sane default
 *  position or extent for a document-controlled origin/size, so a box built from a non-finite one
 *  is left for the caller to detect via `hasNonFiniteEdge` and drop outright (mergeTextLines does
 *  this immediately below, before the box can be unioned into a running line). */
function itemBox(item: TextItemLike): Box {
  const [a, b, c, d, e, f] = item.transform;
  // A unit axis is usable only when BOTH its components come out finite. `len > 0` alone is not
  // enough: a text matrix is document-controlled, and an infinite component makes `hypot`
  // infinite too, so the division yields NaN rather than a direction — which would reach the
  // caller as a NaN box, be rejected by the tool's `z.number()` AFTER the handler returned, and
  // so escape `errorResult` and lose the whole call. Falling back to the unrotated axes keeps a
  // finite box; a zero-length or NaN axis takes the same path (`NaN > 0` is false).
  const dirLen = Math.hypot(a, b);
  const dirRaw: readonly [number, number] = dirLen > 0 ? [a / dirLen, b / dirLen] : [1, 0];
  const dir: readonly [number, number] = isFiniteAxis(dirRaw) ? dirRaw : [1, 0];
  const upLen = Math.hypot(c, d);
  const upRaw: readonly [number, number] = upLen > 0 ? [c / upLen, d / upLen] : [0, 1];
  const up: readonly [number, number] = isFiniteAxis(upRaw) ? upRaw : [0, 1];

  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of [0, item.width]) {
    for (const t of [0, item.height]) {
      xs.push(e + s * dir[0] + t * up[0]);
      ys.push(f + s * dir[1] + t * up[1]);
    }
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
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
 * (transform[5]) agree within `baselineTolerancePt` **and** they are horizontally adjacent: the
 * gap between the new item's left edge and the running line's right edge must be no more than
 * `gapTolerancePt` forward, and no more than `overlapTolerancePt` backward (a negative gap is an
 * overlap) — default, per item, the item's own `height` floored at 1pt, since accents and
 * combining glyphs legitimately paint back over the preceding glyph but nothing farther.
 * Otherwise a new line starts. The gap is bounded on **both** sides deliberately: an unbounded
 * lower bound let an item anywhere to the left of the running line's union box join it, merging
 * two far-apart runs (e.g. two TikZ nodes on the same baseline) into one box spanning the blank
 * paper between them, in reverse reading order.
 *
 * Order-sensitive over `items` as pdf.js yields them (the document's drawing order) — never
 * sorted, so two interleaved columns are not silently reordered into one line.
 *
 * Grouped by `transform[5]` (the glyph origin's y), which is a baseline only for unrotated text —
 * for a 90°-rotated line (e.g. inside a `pdflscape` landscape page) the items of one visual line
 * share an x, not a y, so they are never merged here and each is reported as its own box; several
 * correct boxes beat one wrong one, and rotation-aware merging is out of scope for this function.
 */
export function mergeTextLines(
  items: TextItemLike[],
  opts?: {
    baselineTolerancePt?: number;
    gapTolerancePt?: number;
    maxTextChars?: number;
    overlapTolerancePt?: number;
  },
): TextLine[] {
  const baselineTolerancePt = opts?.baselineTolerancePt ?? DEFAULT_BASELINE_TOLERANCE_PT;
  const gapTolerancePt = opts?.gapTolerancePt ?? DEFAULT_GAP_TOLERANCE_PT;
  const maxTextChars = opts?.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const overlapTolerancePt = opts?.overlapTolerancePt;

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
    if (hasNonFiniteEdge(box)) {
      // The item's origin/width/height are document-controlled and, unlike the direction/up axes
      // itemBox already guards, there is no sane fallback position or extent for them — so the
      // item is dropped outright here, the same way pdfRender.ts's walkImageGeometry drops (never
      // approximates) a non-finite image/form box. Dropping it BEFORE it can join a running line
      // matters: unionBox has no notion of "ignore this edge", so merging even one poisoned item
      // would turn an otherwise-good merged line's box into Infinity/NaN too.
      continue;
    }
    const baseline = item.transform[5];

    if (current) {
      const sameBaseline = Math.abs(baseline - current.baseline) <= baselineTolerancePt;
      // Horizontally adjacent or overlapping: the gap between the new item's left edge and the
      // running line's right edge is within tolerance forward, and bounded backward too — an
      // overlap may not exceed this item's own em size (floored at 1pt), or an explicit override.
      const gap = box.x0 - current.box.x1;
      const minGap = -(overlapTolerancePt ?? Math.max(item.height, 1));
      const adjacent = gap <= gapTolerancePt && gap >= minGap;
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

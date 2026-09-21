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
 *  this module never imports it.
 *
 *  `ascent` and `vertical` do not live on a pdf.js `TextItem`: they come from
 *  `TextContent.styles[item.fontName]`, which is a per-FONT record the caller has to join onto
 *  each item (pdfRender.ts does that join, in one place, for both of its text walks). They are
 *  optional here rather than required because a caller that cannot supply them must get today's
 *  behaviour unchanged rather than a different box — see `ascentExtent`. */
export interface TextItemLike {
  str: string;
  /** pdf.js text-item transform: [a,b,c,d,e,f], with (e,f) the glyph origin in user space. */
  transform: Matrix;
  width: number;
  height: number;
  /**
   * The font's declared ascent **as a fraction of the em**, from `TextContent.styles[fontName]`.
   *
   * The unit is established, not assumed. pdf.js normalizes every producer into an em fraction
   * before it reaches `styles`: the `/Ascent` font-descriptor route divides by
   * `PDF_GLYPH_SPACE_UNITS` (1000) in the worker's `Font` constructor, and the embedded-TrueType
   * route overwrites it with `hhea.ascender / head.unitsPerEm`. pdf.js's own text layer then uses
   * it the same way this module does — `fontAscent = fontHeight * getAscent(...)`, where
   * `fontHeight` is `hypot(trm[2], trm[3])`, i.e. the same em this item reports as `height`.
   * Measured, too, against the installed pdfjs-dist 6.1.200: a `/Helvetica` page reports
   * `ascent: 0.718` and a `/Times-Roman` page `0.683` — exactly the 718/1000 and 683/1000 of
   * pdf.js's own standard-font metrics table.
   *
   * **Absent, zero, negative, non-finite or greater than one means "not declared usably" and the
   * box falls back to the full em** — never to pdf.js's own 0.8 text-layer default. See
   * `ascentExtent` for why that direction is the only safe one.
   */
  ascent?: number;
  /**
   * Vertical writing mode (`TextContent.styles[fontName].vertical`, i.e. a CMap with `WMode 1`).
   * pdf.js measures such an item the other way round — `width` is the em (`hypot(trm[0],
   * trm[1])`) and `height` is the accumulated ADVANCE — so an item flagged here is boxed by
   * `verticalExtent` rather than by the horizontal rule.
   */
  vertical?: boolean;
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

/**
 * How closely two items' frames must agree before their glyphs may join one line: the cosine of the
 * largest angle tolerated between their direction axes, and between their up axes. `cos(1°)` is
 * ~0.9998477, so up to about one degree of disagreement still reads as the same line.
 *
 * One degree rather than something tighter because a text-rendering matrix is rebuilt per item out
 * of the document's own numbers and can carry a fraction of a degree of drift between the items of
 * one line. Rather than something looser, because this comparison is what separates two visually
 * distinct lines that merely share a page coordinate.
 *
 * **How much drift actually survives is decided by the baseline clause, not by this constant, and
 * it is much less than a degree away from the origin.** `across` projects an item's ORIGIN onto
 * its OWN up axis, so a frame difference of d shifts `across` by about |origin| * sin(d), judged
 * against `baselineTolerancePt` (1pt). Near the origin a full degree survives; at the far corner
 * of an A4 page (|origin| ~ 860pt) anything past roughly 0.07 degrees already reads as a different
 * baseline and splits. So this gate is the outer bound, not the operative one, over most of a
 * page. That is left as it is deliberately — the error direction is safe (a rotated line comes
 * back as several correct boxes, never as one box spanning two lines, which is the pre-existing
 * behaviour this merging improves on rather than a regression) and tightening the coupling means
 * projecting both origins onto the LINE's up axis, a behaviour change worth its own issue. What
 * is not acceptable is a comment claiming a capability the code does not deliver, so: this
 * constant bounds frame disagreement; it does not by itself hold a drifting rotated line together.
 *
 * Compared as a dot product rather than an angle: both axes are already unit vectors (`itemAxes`),
 * so it costs two multiplies and no trigonometry.
 */
const DIRECTION_TOLERANCE_COS = Math.cos(Math.PI / 180);

/** A unit vector in user space: an item's text-direction axis or its up axis. */
type Axis = readonly [number, number];

/** Whether a unit axis (a direction or up vector, already normalized) is usable — both components
 *  must come out finite, since a document-controlled matrix can normalize to a NaN/Infinity
 *  component (see itemAxes' own comment on why that matters). */
function isFiniteAxis(axis: Axis): boolean {
  return Number.isFinite(axis[0]) && Number.isFinite(axis[1]);
}

/** Dot product of two unit axes, i.e. the cosine of the angle between them. */
function dot(a: Axis, b: Axis): number {
  return a[0] * b[0] + a[1] * b[1];
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

/** The item's own frame: the unit direction axis `(a,b)/|(a,b)|` that the advance (`width`) is
 *  measured along, and the unit up axis `(c,d)/|(c,d)|` that the em size (`height`) is measured
 *  along. Pulled out of `itemFrame` so the box and mergeTextLines' line grouping cannot drift apart
 *  in how they guard a poisoned matrix: they would then disagree about which items even share a
 *  frame, and a box measured in one frame would be grouped by another's.
 *
 *  A unit axis is usable only when BOTH its components come out finite. `len > 0` alone is not
 *  enough: a text matrix is document-controlled, and an infinite component makes `hypot` infinite
 *  too, so the division yields NaN rather than a direction — which would reach the caller as a NaN
 *  box, be rejected by the tool's `z.number()` AFTER the handler returned, and so escape
 *  `errorResult` and lose the whole call. Falling back to the unrotated axes keeps a finite box; a
 *  zero-length or NaN axis takes the same path (`NaN > 0` is false). */
function itemAxes(transform: Matrix): { dir: Axis; up: Axis } {
  const [a, b, c, d] = transform;
  const dirLen = Math.hypot(a, b);
  const dirRaw: Axis = dirLen > 0 ? [a / dirLen, b / dirLen] : [1, 0];
  const upLen = Math.hypot(c, d);
  const upRaw: Axis = upLen > 0 ? [c / upLen, d / upLen] : [0, 1];
  return {
    dir: isFiniteAxis(dirRaw) ? dirRaw : [1, 0],
    up: isFiniteAxis(upRaw) ? upRaw : [0, 1],
  };
}

/** An item measured in its own frame: the axis-aligned box the caller gets back, the two axes that
 *  frame is built on, and the item's extent expressed in that frame. */
interface ItemFrame {
  box: Box;
  dir: Axis;
  up: Axis;
  /** The baseline coordinate, generalized: the item's ORIGIN projected onto the up axis. For an
   *  unrotated item this is `transform[5]` itself, which is what the page-axis version of this
   *  function compared. */
  across: number;
  /** The item's extent along the direction axis — for an unrotated item, `box.x0` and `box.x1`. */
  alongMin: number;
  alongMax: number;
}

/** An item's extent **in its own frame**: how far it reaches along the direction axis (`s`) and
 *  along the up axis (`t`), before either is turned into user-space corners. Both ends of each
 *  are explicit because neither starts at the origin in every case: a vertical-mode item straddles
 *  the baseline along `s` and runs BACKWARD along `t`. */
interface FrameExtent {
  sMin: number;
  sMax: number;
  tMin: number;
  tMax: number;
}

/**
 * Today's extent, and the ONLY one `mergeTextLines` ever groups on: the advance along the
 * direction axis and the full em along the up axis, both measured from the glyph origin.
 *
 * Kept as its own function, and kept as the grouping frame for every item including a vertical
 * one, because the box math and the merge rule change independently: the box below now spends a
 * declared ascent where it has one, and a change in the corners would otherwise move
 * `alongMin`/`alongMax` with it and silently regroup a SHEARED line (whose up axis has a
 * component along the direction axis, so the along-extent does depend on the up extent). Grouping
 * is therefore computed from these corners in every case, which makes "the merge rule is
 * unchanged" a property of the code rather than a claim about it.
 */
function emExtent(item: TextItemLike): FrameExtent {
  return { sMin: 0, sMax: item.width, tMin: 0, tMax: item.height };
}

/**
 * The font's declared ascent as a usable fraction of the em, or `undefined`.
 *
 * **This guard is the whole feature; the multiplication is the easy part.** Today's box spans the
 * baseline to the full em, which OVER-covers the ink — for the collision question this tool
 * exists to answer that is a false positive, the harmless direction. A box built from a guessed
 * ascent UNDER-covers, which is a false negative: the tool reports clearance where ink touches.
 * So the declared ascent is spent only where the font actually declares one, and everything else
 * falls back to the full em:
 *
 * - **absent** — no `styles` entry (a caller that does not join them at all, or pdf.js's
 *   `ErrorFont`, which carries no `ascent` property whatsoever);
 * - **non-finite** — reachable, not theoretical: pdf.js's own standard-font metrics table holds
 *   `ascent: Math.NaN` for `Symbol` and `ZapfDingbats`, and a PDF that uses either (LaTeX's math
 *   fonts routinely do) reports `NaN` here;
 * - **zero or negative** — not a height;
 * - **greater than one** — a declared ascent taller than the em would GROW the box. Growing is
 *   the safe direction, but an unbounded grow is not a measurement: a font descriptor is
 *   document-controlled and `/Ascent 1000000` would produce a box a kilometre tall. Falling back
 *   here costs nothing a caller has today, since today's box is the em for every font.
 *
 * What is never used is pdf.js's own text-layer default of 0.8 for a font that declares nothing:
 * that number is a rendering nicety, and applying it here would shrink every box under an
 * undeclared font by a fifth of an em on no evidence at all.
 */
function usableAscent(ascent: number | undefined): number | undefined {
  if (typeof ascent !== 'number' || !Number.isFinite(ascent) || ascent <= 0 || ascent > 1) {
    return undefined;
  }
  return ascent;
}

/**
 * The extent the EMITTED box is built from: the em extent, with the up axis cut to the declared
 * ascent where there is a usable one, and replaced outright for a vertical-mode item.
 *
 * A vertical item is measured the other way round by pdf.js (`ensureTextContentItem`): `width` is
 * `hypot(trm[0], trm[1])`, the em ACROSS the column, and `height` is the accumulated advance, run
 * DOWN the column and reported as `Math.abs(totalHeight)`. So:
 *
 * - along the up axis the run goes from the origin BACKWARD by that advance (`tMin = -height`),
 *   because text-space y decreases as vertical text advances (`translateTextMatrix(0, scaledDim)`
 *   with a negative `scaledDim`, absolute-valued only when accumulated). Measuring it forward, as
 *   the horizontal rule does, puts the box entirely on the wrong side of the text — which is what
 *   this function's absence did;
 * - across the column it is centred on the baseline (`±width/2`), which is the PDF's own default
 *   vertical origin `v = (w0/2, DW2[0])` and what pdf.js itself assumes when a glyph has no
 *   `/W2` entry (`defaultVMetrics = [dw2[1], defaultWidth * 0.5, dw2[0]]`, and the canvas
 *   back-end shifts each glyph by `-width * 0.5`).
 *
 * The ascent is not spent on a vertical item: there `height` is an advance, not an em, so
 * scaling it by an ascent fraction would shorten the RUN rather than trim the ink above a
 * baseline.
 */
function inkExtent(item: TextItemLike): FrameExtent {
  if (item.vertical === true) {
    const half = item.width / 2;
    return { sMin: -half, sMax: half, tMin: -item.height, tMax: 0 };
  }
  const ascent = usableAscent(item.ascent);
  return {
    sMin: 0,
    sMax: item.width,
    tMin: 0,
    tMax: ascent === undefined ? item.height : item.height * ascent,
  };
}

/** The four user-space corners of one frame extent, and their projections onto the direction
 *  axis. One function so the box corners and the grouping corners can only ever differ by the
 *  extent they were given, never by how they were built. */
function frameCorners(
  origin: readonly [number, number],
  dir: Axis,
  up: Axis,
  extent: FrameExtent,
): { xs: number[]; ys: number[]; along: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  const along: number[] = [];
  for (const s of [extent.sMin, extent.sMax]) {
    for (const t of [extent.tMin, extent.tMax]) {
      const x = origin[0] + s * dir[0] + t * up[0];
      const y = origin[1] + s * dir[1] + t * up[1];
      xs.push(x);
      ys.push(y);
      along.push(x * dir[0] + y * dir[1]);
    }
  }
  return { xs, ys, along };
}

/** An item's box and frame in user space, built from the text-rendering matrix itself rather than
 *  from +x/+y: `(transform[4], transform[5])` is the glyph origin, `width` is the advance measured
 *  along the matrix's own text-direction axis `(a,b)`, and `height` is the em size measured along
 *  its up axis `(c,d)` (pdf.js already reports both in transformed units — it sets
 *  `height = Math.hypot(c, d)`). Both are applied along the *unit* vectors of those two axes, so a
 *  rotated item (e.g. any text on a `pdflscape` landscape page, whose /Rotate 90 rotates the
 *  content, not just the MediaBox) gets a box aligned to its own direction rather than transposed
 *  onto +x/+y. For an unrotated item (`b = c = 0`, so `dir = (1,0)` and `up = (0,1)`) this reduces
 *  exactly to the old axis-aligned `{x0:e, y0:f, x1:e+width, y1:f+height}` — no rounding drift.
 *
 *  Because the two axes are the matrix's OWN columns, normalized, and `width`/`height` are the
 *  lengths pdf.js already measured along them, this is the exact parallelogram the text matrix
 *  spans — SHEAR included. With `dir = (a,b)/|(a,b)|` and `up = (c,d)/|(c,d)|`, the corner at
 *  `t = height` is `origin + (c,d)` exactly, whatever angle `(c,d)` makes with `(a,b)`; nothing
 *  is orthogonalized anywhere. Rebuilding the corners from the raw matrix instead would
 *  double-apply the scale, since `width` and `height` already carry it.
 *
 *  `across`/`alongMin`/`alongMax` are projections of four corners built by the very same function
 *  as the box's, computed here rather than in mergeTextLines so that they cannot be the corners of
 *  some other, separately guarded frame. They are deliberately taken from the `emExtent` corners
 *  rather than from the box's own: the box may now be cut to a declared ascent (or rebuilt for a
 *  vertical item), and under a sheared matrix that would move the along-extent too and regroup
 *  lines that group today. The merge rule is being held still while the box math changes — see
 *  `emExtent`. For every item that has no usable ascent and is not vertical the two extents are
 *  the same numbers, so this is one computation done twice, not two rules.
 *
 *  That sharing is also what makes the unrotated reduction exact rather than approximate: with
 *  `dir = (1,0)` the projection `x * 1 + y * 0` IS each corner's x, so `alongMin`/`alongMax` are
 *  literally the numbers `box.x0`/`box.x1` carry, and `across` is literally `transform[5]`.
 *
 *  The direction/up AXES get a sane fallback when non-finite (see itemAxes, above) — falling back
 *  to the unrotated unit vectors keeps a usable box. The item's ORIGIN (`e`, `f`) and its
 *  `width`/`height` get no equivalent fallback here: unlike a unit axis, there is no sane default
 *  position or extent for a document-controlled origin/size, so a box built from a non-finite one
 *  is left for the caller to detect via `hasNonFiniteEdge` and drop outright (mergeTextLines does
 *  this immediately below, before the box can be unioned into a running line). */
function itemFrame(item: TextItemLike): ItemFrame {
  const [, , , , e, f] = item.transform;
  const { dir, up } = itemAxes(item.transform);
  const origin: readonly [number, number] = [e, f];

  const ink = frameCorners(origin, dir, up, inkExtent(item));
  // The grouping corners. Both extents are built from the same `width`/`height`/origin, so a
  // document-controlled non-finite one poisons both together and mergeTextLines' single
  // `hasNonFiniteEdge` check on the box below still catches it — an ascent fraction is finite by
  // construction (`usableAscent`) and `width / 2` cannot turn a finite width non-finite.
  const em = frameCorners(origin, dir, up, emExtent(item));
  return {
    box: {
      x0: Math.min(...ink.xs),
      y0: Math.min(...ink.ys),
      x1: Math.max(...ink.xs),
      y1: Math.max(...ink.ys),
    },
    dir,
    up,
    across: e * up[0] + f * up[1],
    alongMin: Math.min(...em.along),
    alongMax: Math.max(...em.along),
  };
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
 * Merge pdf.js text items into per-line boxes, measured in each item's OWN frame rather than in the
 * page's axes. Two items join a line when all three of these hold:
 *
 * - **Their frames agree**: the new item's direction axis is within `DIRECTION_TOLERANCE_COS` of
 *   the running line's, and so is its up axis. Both, not just the direction — the direction alone
 *   does not distinguish a mirrored or flipped up axis, so text set upside down along the same
 *   reading direction would otherwise be folded into the line above it.
 * - **Their baselines agree** within `baselineTolerancePt`, the baseline coordinate now being the
 *   item's origin projected onto its up axis.
 * - **They are adjacent along the direction axis**: the gap between the new item's near edge and
 *   the running line's far edge, both measured along that axis, is no more than `gapTolerancePt`
 *   forward and no more than `overlapTolerancePt` backward (a negative gap is an overlap) —
 *   default, per item, the item's own `height` floored at 1pt, since accents and combining glyphs
 *   legitimately paint back over the preceding glyph but nothing farther. The gap is bounded on
 *   **both** sides deliberately: an unbounded lower bound let an item anywhere behind the running
 *   line join it, merging two far-apart runs (e.g. two TikZ nodes on the same baseline) into one
 *   box spanning the blank paper between them, in reverse reading order.
 *
 * Otherwise a new line starts. The running line keeps its FIRST item's baseline coordinate and
 * frame, and tracks the far edge as a running maximum.
 *
 * All three quantities come off the same four corners `itemFrame` builds the box from, projected
 * onto that item's own axes, so the unrotated case reduces to the page-axis rule this function used
 * before — exactly, not approximately. With `b = c = 0` the frame is `dir = (1,0)`, `up = (0,1)`,
 * so the baseline coordinate is `transform[5]` and the two extents are the numbers `box.x0`/`box.x1`
 * already carry. An unrotated document's output is therefore unchanged, edge for edge.
 *
 * What changed is only which items get unioned; the emitted box is the same user-space axis-aligned
 * union it always was. That does narrow merging in one case, deliberately: two items sharing a
 * `transform[5]` but rotated differently used to join into a single box spanning two visually
 * separate lines, and now do not. Before this, the items of a 90°-rotated line (e.g. inside a
 * `pdflscape` landscape page) shared an x rather than a y and so never merged at all, and a caller
 * asking how wide a rotated heading is got one answer per glyph run.
 *
 * Order-sensitive over `items` as pdf.js yields them (the document's drawing order) — never sorted,
 * so two interleaved columns are not silently reordered into one line.
 *
 * What the box does and does not claim, all documented in the tool's schema and docs/tools.md too:
 *
 * - **Shear is modelled** — it always was, since the rotation work, and the comment that used to
 *   stand here saying otherwise was wrong. `itemFrame` builds its corners from the matrix's own
 *   two columns, normalized, scaled by the two lengths pdf.js measured along them; that is the
 *   exact parallelogram of a slanted matrix, not an orthogonal approximation of it. See
 *   `itemFrame`.
 * - **The box is cut to the declared ascent where the font declares a usable one**, and spans the
 *   full em where it does not — see `usableAscent`, which is a guard, not an optimisation: an
 *   ascent-sized box under-covers when the ascent is a guess, and under-covering is the false
 *   NEGATIVE this tool exists to avoid. Under a font with no usable ascent every box is exactly
 *   what it always was.
 * - **Descenders are still outside the box, always.** It runs from the baseline UP; `g`, `p`, `y`
 *   drop below `y0` (below `y1` once the caller has flipped to a top-left origin) whether or not
 *   an ascent was spent. Spending the declared DESCENT would close that, and is deliberately not
 *   done here: it would grow every box downward for every metrics-carrying font in one change
 *   that was meant to shrink them truthfully.
 * - **A vertical writing-mode item gets a vertical box, but a vertical LINE is still not merged.**
 *   `inkExtent` boxes such an item down the column and centred on its baseline instead of
 *   measuring it as though horizontal (which put the box entirely above the text). The grouping
 *   rule below is unchanged, and it groups on a shared origin-projected-onto-up: consecutive
 *   items down one column differ in exactly that coordinate, so they stay one box each rather
 *   than merging into one column box. Correct boxes, uncombined — not a full close.
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
    /** The first item's frame and baseline coordinate, kept for the whole line — the running line
     *  is grouped by the frame it was opened in, never by whatever the last item drifted to. */
    across: number;
    alongMax: number;
    dir: Axis;
    up: Axis;
  }

  const lines: Building[] = [];
  let current: Building | undefined;

  for (const item of items) {
    if (item.str.trim() === '') {
      continue;
    }
    const frame = itemFrame(item);
    if (hasNonFiniteEdge(frame.box)) {
      // The item's origin/width/height are document-controlled and, unlike the direction/up axes
      // itemAxes already guards, there is no sane fallback position or extent for them — so the
      // item is dropped outright here, the same way pdfRender.ts's walkImageGeometry drops (never
      // approximates) a non-finite image/form box. Dropping it BEFORE it can join a running line
      // matters: unionBox has no notion of "ignore this edge", so merging even one poisoned item
      // would turn an otherwise-good merged line's box into Infinity/NaN too.
      continue;
    }

    if (current) {
      // Both axes have to agree, not just the direction: the direction alone cannot tell a line
      // from one set along the same reading direction with a mirrored or flipped up axis, and
      // those are two lines, not one. Both axes are finite by construction — itemAxes has already
      // substituted the unrotated unit vectors for anything that did not normalize — so this
      // comparison never sees a NaN, and an earlier version of this comment describing what
      // happens when it does was describing an unreachable state. The guard for a poisoned matrix
      // is itemAxes' fallback plus hasNonFiniteEdge on the box, both above; not this line.
      const sameFrame =
        dot(frame.dir, current.dir) >= DIRECTION_TOLERANCE_COS &&
        dot(frame.up, current.up) >= DIRECTION_TOLERANCE_COS;
      const sameBaseline = Math.abs(frame.across - current.across) <= baselineTolerancePt;
      // Adjacent or overlapping ALONG THE DIRECTION AXIS: the gap between the new item's near edge
      // and the running line's far edge is within tolerance forward, and bounded backward too — an
      // overlap may not exceed this item's own em size (floored at 1pt), or an explicit override.
      // Measured in the frame rather than in page x, or a rotated line's own advance reads as a
      // baseline change and every glyph run becomes its own box.
      const gap = frame.alongMin - current.alongMax;
      const minGap = -(overlapTolerancePt ?? Math.max(item.height, 1));
      const adjacent = gap <= gapTolerancePt && gap >= minGap;
      if (sameFrame && sameBaseline && adjacent) {
        current.text += item.str;
        current.box = unionBox(current.box, frame.box);
        current.items += 1;
        // Running maximum, mirroring what the union box's far edge did before: an item that ends
        // short of the line's reach must not pull the next item's gap measurement back with it.
        current.alongMax = Math.max(current.alongMax, frame.alongMax);
        continue;
      }
    }

    if (current) {
      lines.push(current);
    }
    current = {
      text: item.str,
      box: frame.box,
      items: 1,
      across: frame.across,
      alongMax: frame.alongMax,
      dir: frame.dir,
      up: frame.up,
    };
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

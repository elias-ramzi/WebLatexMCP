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
 * **This constant is the operative bound on frame disagreement, and holds a drifting rotated line
 * together anywhere on the page.** It did not always. `across` used to project an item's ORIGIN
 * onto its OWN cross axis, so a frame difference of d shifted `across` by about |origin| * sin(d),
 * judged against `baselineTolerancePt` (1pt): near the page origin a full degree survived, but
 * 860pt out anything past roughly 0.07 degrees already read as a different baseline and split the
 * line, and this gate never got to speak. (860pt is a point in the upper reaches of an A4 page,
 * not its corner — the corner is `hypot(595.28, 841.89)` = 1031pt, where the effective bound was
 * tighter still at about 0.056 degrees. The 860/0.07 pair is the figure the pre-fix comment and
 * issue #140 both used, kept here so the two read against each other.) `mergeTextLines`
 * now projects a candidate's origin onto the RUNNING LINE's position axis (`positionAxis`), so
 * `baselineTolerancePt` measures the candidate's PERPENDICULAR DISTANCE from that line's own
 * baseline, in points, with no |origin| term in it at all. A drifting item that is still on the
 * line stays on it wherever the line sits.
 *
 * What the baseline clause still bounds, and must, is genuine positional separation: two visually
 * distinct lines 12pt apart remain two lines. What it no longer does is convert frame drift into
 * a position error — that is this constant's job alone now.
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

/**
 * The two axes the MERGE RULE runs on: the item's own frame axes for a horizontal item, and the
 * same two swapped (and one negated) for a vertical-mode one.
 *
 * - `advance` is the axis the run progresses along — the direction axis for horizontal text, and
 *   the NEGATED up axis for vertical text, whose run goes BACKWARD along `up` (see `emExtent`).
 * - `cross` is the axis the line's position is measured ALONG — `up` for horizontal text (the
 *   generalized baseline coordinate), and the direction axis for vertical text (which column the
 *   run sits in). It is not itself the coordinate axis the merge rule uses: `positionAxis` first
 *   removes whatever component of it leans along `advance`, which is what a sheared matrix puts
 *   there. For an unsheared frame the two are the same vector, exactly.
 *
 * Grouping every item on the horizontal pairing is what left a vertical line unmerged: consecutive
 * items down a column differ in exactly the coordinate that pairing calls the baseline, so every
 * glyph run came back as its own box. Swapping the pair for a vertical item turns "same baseline,
 * adjacent along the run" into "same column, adjacent down it" — the same rule, read in the frame
 * the writing mode actually uses.
 *
 * These axes are NOT what keeps a vertical line and a horizontal one apart, and cannot be: a
 * 270-degree-rotated horizontal item (`dir = (0,-1)`, `up = (1,0)`) and an upright vertical item
 * (`dir = (1,0)`, `up = (0,1)`) yield the SAME advance/cross pair, while being two visually
 * distinct lines — a sideways caption and an upright CJK column. So `mergeTextLines` keeps
 * comparing the raw `dir`/`up` axes, as it always did, and requires the writing mode itself to
 * match on top of them.
 */
function groupingAxes(dir: Axis, up: Axis, vertical: boolean): { advance: Axis; cross: Axis } {
  return vertical ? { advance: [-up[0], -up[1]], cross: dir } : { advance: dir, cross: up };
}

/**
 * The axis a line's POSITION is actually measured on: `cross` with any component along `advance`
 * removed, renormalized — i.e. the unit normal to the advance axis, oriented the way `cross`
 * points.
 *
 * Why not `cross` itself. Under shear the up axis leans into the direction axis (`up · dir != 0`),
 * so walking one item forward ALONG the advance axis moves the cross coordinate by
 * `advance * (dir · up)` — past `baselineTolerancePt` after a glyph or two. Measured on the
 * normal instead, walking along the advance axis moves the coordinate by exactly nothing, which
 * is what "the next glyph is on the same line" has to mean for a slanted run. The quantity this
 * returns an axis for is therefore the candidate's perpendicular distance from the running line's
 * baseline, in points — a real distance, which is the unit `baselineTolerancePt` is expressed in.
 *
 * **For an unsheared frame this is `cross` itself, bit for bit, which is the whole safety
 * property.** `lean` is then exactly 0, the subtraction is `cross - 0 * advance` (whose products
 * are +/-0 and change nothing), and the length of a unit vector is exactly 1, so the division
 * returns the same two doubles. That holds for every axis-aligned horizontal item — where
 * `itemAxes` yields exactly `dir = (1,0)`, `up = (0,1)` — and for an upright vertical one, and for
 * any rotation whose two axes come out exactly orthogonal. Only a genuinely sheared frame gets a
 * different vector, which is exactly the case this exists for.
 *
 * Degenerate frames fall back to `cross`, the same way `itemAxes` falls back to the unrotated unit
 * vectors: if `cross` is parallel to `advance` the text matrix has collapsed to a line and there
 * is no position axis to find, and if the normalization does not come out finite there is nothing
 * to prefer it over. Either way the result stays a unit-ish vector, so a projection of a finite
 * origin stays finite and no box can be poisoned by this.
 */
function positionAxis(advance: Axis, cross: Axis): Axis {
  const lean = dot(cross, advance);
  const px = cross[0] - lean * advance[0];
  const py = cross[1] - lean * advance[1];
  const len = Math.hypot(px, py);
  if (!(len > 0)) {
    return cross;
  }
  const axis: Axis = [px / len, py / len];
  return isFiniteAxis(axis) ? axis : cross;
}

/** One user-space point projected onto a unit axis. */
function projectPoint(p: readonly [number, number], axis: Axis): number {
  return p[0] * axis[0] + p[1] * axis[1];
}

/** The extent of a set of user-space corners along a unit axis. Taken over the SAME four corners
 *  `frameCorners` built, in the same order, so switching which axis they are projected onto is the
 *  only thing that ever changes about this number. */
function projectExtent(
  corners: readonly (readonly [number, number])[],
  axis: Axis,
): { min: number; max: number } {
  const along: number[] = [];
  for (const c of corners) {
    along.push(c[0] * axis[0] + c[1] * axis[1]);
  }
  return { min: Math.min(...along), max: Math.max(...along) };
}

/** The item's EM size: `height` for a horizontal item, `width` for a vertical one, because pdf.js
 *  measures a vertical item the other way round (see `emExtent`). Used for the default
 *  backward-overlap allowance, whose rationale is "one glyph may paint back over the one before
 *  it, nothing farther" — that is an em in either writing mode, never a vertical item's
 *  accumulated advance, which is as long as the run and would let an item most of a column behind
 *  the line join it. */
function emSize(item: TextItemLike): number {
  return item.vertical === true ? item.width : item.height;
}

/** An item measured in its own frame: the axis-aligned box the caller gets back, the two axes that
 *  frame is built on, and the raw geometry the merge rule needs in order to re-measure the item in
 *  SOMEBODY ELSE'S frame — the running line's.
 *
 *  It deliberately carries no `across`/`alongMin`/`alongMax` of its own. Those used to live here,
 *  each projected onto the ITEM's axes, and comparing two of them was comparing two coordinates
 *  read off two different rulers: a frame difference of d then showed up as a position difference
 *  of about |origin| * sin(d), and a sheared step along the advance axis showed up as a baseline
 *  change (issue #140). The projections are done in `mergeTextLines` instead, against the axes of
 *  the line being joined, so both sides of every comparison are read off one ruler. */
interface ItemFrame {
  box: Box;
  dir: Axis;
  up: Axis;
  /** The item's writing mode, normalized to a boolean — part of the frame because two items in
   *  different writing modes are never one line, however well their axes agree (`groupingAxes`). */
  vertical: boolean;
  /** The axes a line OPENED BY THIS ITEM is measured on: the advance axis from `groupingAxes`, and
   *  the position axis (`positionAxis`) the line's own baseline coordinate runs on. An item that
   *  joins an existing line is measured on that line's pair instead, never on these. */
  advance: Axis;
  position: Axis;
  /** The glyph origin, `(transform[4], transform[5])`. */
  origin: readonly [number, number];
  /** The four user-space corners of the item's FULL EM extent (`emExtent`) — never the box's own,
   *  which may have been cut to a declared ascent. Kept as corners rather than as an extent so the
   *  merge rule can project them onto the running line's advance axis. */
  emCorners: readonly (readonly [number, number])[];
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
 * The item's FULL, untrimmed extent in its own frame — the ONLY one `mergeTextLines` ever groups
 * on, and the one the emitted box starts from before any ascent is spent.
 *
 * For a horizontal item that is the advance along the direction axis and the full em along the up
 * axis, both measured from the glyph origin. A vertical item is measured the other way round by
 * pdf.js (`ensureTextContentItem`): `width` is `hypot(trm[0], trm[1])`, the em ACROSS the column,
 * and `height` is the accumulated advance, run DOWN the column and reported as
 * `Math.abs(totalHeight)`. So for one of those:
 *
 * - along the up axis the run goes from the origin BACKWARD by that advance (`tMin = -height`),
 *   because text-space y decreases as vertical text advances (`translateTextMatrix(0, scaledDim)`
 *   with a negative `scaledDim`, absolute-valued only when accumulated). Measuring it forward, as
 *   the horizontal rule does, puts the extent entirely on the wrong side of the text;
 * - across the column it is centred on the baseline (`±width/2`), which is the PDF's own default
 *   vertical origin `v = (w0/2, DW2[0])` and what pdf.js itself assumes when a glyph has no
 *   `/W2` entry (`defaultVMetrics = [dw2[1], defaultWidth * 0.5, dw2[0]]`, and the canvas
 *   back-end shifts each glyph by `-width * 0.5`).
 *
 * Kept as its own function, separate from `inkExtent`, because the box math and the merge rule
 * change independently: the box spends a declared ascent where it has one, and a change in the
 * corners would otherwise move the along-extent the gap clause measures and silently regroup a
 * SHEARED line (whose up axis has a component along the direction axis, so the along-extent does
 * depend on the up extent). Grouping is therefore computed from THESE corners in every case
 * (`ItemFrame.emCorners`), which makes "an ascent cannot move the merge rule" a property of the
 * code rather than a claim about it.
 *
 * The vertical branch is what changed when vertical lines learned to merge. Grouping used to use
 * the horizontal reading for every item, which put a vertical item's along-extent a whole advance
 * behind where its glyphs actually sit; the gap between two vertical items then came out right
 * only for as long as their advances happened to be equal. It costs the emitted box nothing,
 * because a vertical item never spends an ascent — see `inkExtent`, where the two extents are the
 * same object for one.
 */
function emExtent(item: TextItemLike): FrameExtent {
  if (item.vertical === true) {
    const half = item.width / 2;
    return { sMin: -half, sMax: half, tMin: -item.height, tMax: 0 };
  }
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
 * The extent the EMITTED box is built from: `emExtent`, with the up axis cut to the declared
 * ascent where there is a usable one.
 *
 * The ascent is not spent on a vertical item: there `height` is an advance, not an em, so scaling
 * it by an ascent fraction would shorten the RUN rather than trim the ink above a baseline. So a
 * vertical item's emitted box IS its full extent, returned here unchanged — which is also why
 * grouping a vertical line on the full extent (`emExtent`) can never disagree with the box it
 * reports.
 */
function inkExtent(item: TextItemLike): FrameExtent {
  const em = emExtent(item);
  if (item.vertical === true) {
    return em;
  }
  const ascent = usableAscent(item.ascent);
  return ascent === undefined ? em : { ...em, tMax: item.height * ascent };
}

/** The four user-space corners of one frame extent. One function so the box corners and the
 *  grouping corners can only ever differ by the extent they were given, never by how they were
 *  built. Projection onto an axis is `projectExtent`'s job, and is deliberately NOT done here:
 *  the grouping corners are projected onto the RUNNING LINE's advance axis, which this function
 *  has no business knowing about (issue #140). */
function frameCorners(
  origin: readonly [number, number],
  dir: Axis,
  up: Axis,
  extent: FrameExtent,
): readonly (readonly [number, number])[] {
  const corners: (readonly [number, number])[] = [];
  for (const s of [extent.sMin, extent.sMax]) {
    for (const t of [extent.tMin, extent.tMax]) {
      corners.push([
        origin[0] + s * dir[0] + t * up[0],
        origin[1] + s * dir[1] + t * up[1],
      ] as const);
    }
  }
  return corners;
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
 *  `emCorners` are four corners built by the very same function as the box's, computed here rather
 *  than in mergeTextLines so that they cannot be the corners of some other, separately guarded
 *  frame. They are deliberately the `emExtent` corners rather than the box's own: the box may be
 *  cut to a declared ascent, and under a sheared matrix that would move the along-extent too and
 *  regroup lines that group today. The merge rule is held still while the box math changes — see
 *  `emExtent`. For every item that has no usable ascent the two extents are the same numbers, so
 *  this is one computation done twice, not two rules.
 *
 *  They are returned unprojected. `mergeTextLines` projects them onto the RUNNING LINE's advance
 *  axis and the item's ORIGIN onto the running line's position axis, so that a comparison is never
 *  between two coordinates read in two different frames — issue #140, whose two symptoms (a
 *  rotated line splitting at the far corner of a page, a sheared run splitting after one glyph)
 *  were both that. `advance`/`position` here are only what a line OPENED by this item would be
 *  measured on.
 *
 *  Which axes those are comes from `groupingAxes` — the item's own `dir`/`up` pair for a
 *  horizontal item and the swapped one for a vertical item — with `positionAxis` then taking the
 *  shear out of the cross axis. See `mergeTextLines` for why the writing mode is part of the frame
 *  on top of them.
 *
 *  That sharing is also what makes the unrotated horizontal reduction exact rather than
 *  approximate: with `dir = (1,0)` the advance axis IS `dir`, so the projection `x * 1 + y * 0` is
 *  each corner's x, the along-extent is literally the numbers `box.x0`/`box.x1` carry, the position
 *  axis is exactly `(0,1)` (`positionAxis` subtracts a zero lean and divides by a length of
 *  exactly 1), and the line coordinate is literally `transform[5]`.
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
  const vertical = item.vertical === true;
  const { advance, cross } = groupingAxes(dir, up, vertical);
  const origin: readonly [number, number] = [e, f];

  const ink = frameCorners(origin, dir, up, inkExtent(item));
  // The grouping corners. Both extents are built from the same `width`/`height`/origin, so a
  // document-controlled non-finite one poisons both together and mergeTextLines' single
  // `hasNonFiniteEdge` check on the box below still catches it — an ascent fraction is finite by
  // construction (`usableAscent`) and `width / 2` cannot turn a finite width non-finite.
  const em = frameCorners(origin, dir, up, emExtent(item));
  const xs = ink.map((c) => c[0]);
  const ys = ink.map((c) => c[1]);
  return {
    box: {
      x0: Math.min(...xs),
      y0: Math.min(...ys),
      x1: Math.max(...xs),
      y1: Math.max(...ys),
    },
    dir,
    up,
    vertical,
    advance,
    position: positionAxis(advance, cross),
    origin,
    emCorners: em,
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
 *   the running line's, and so is its up axis, and its WRITING MODE is the same. Both axes, not
 *   just the direction — the direction alone does not distinguish a mirrored or flipped up axis,
 *   so text set upside down along the same reading direction would otherwise be folded into the
 *   line above it. And the writing mode on top of them, because the axes cannot tell those two
 *   apart: a 270-degree-rotated horizontal item and an upright vertical one have the same advance
 *   and cross axes (`groupingAxes`) while being a sideways caption and an upright CJK column —
 *   two lines, not one.
 * - **Their line positions agree** within `baselineTolerancePt`, that coordinate being the item's
 *   origin projected onto the RUNNING LINE's POSITION axis — the perpendicular to the line's
 *   advance axis, oriented the way its cross axis points (`positionAxis`). So the quantity
 *   compared is the candidate's perpendicular distance from the line's own baseline (its own
 *   column, in vertical mode), in points.
 * - **They are adjacent along the RUNNING LINE's ADVANCE axis**: the gap between the new item's
 *   near edge and the running line's far edge, both measured along that axis, is no more than
 *   `gapTolerancePt`
 *   forward and no more than `overlapTolerancePt` backward (a negative gap is an overlap) —
 *   default, per item, the item's own EM (`emSize`: `height` horizontally, `width` vertically)
 *   floored at 1pt, since accents and combining glyphs legitimately paint back over the preceding
 *   glyph but nothing farther. The gap is bounded on **both** sides deliberately: an unbounded
 *   lower bound let an item anywhere behind the running line join it, merging two far-apart runs
 *   (e.g. two TikZ nodes on the same baseline) into one box spanning the blank paper between
 *   them, in reverse reading order.
 *
 * Otherwise a new line starts. The running line keeps its FIRST item's baseline coordinate and
 * frame, and tracks the far edge as a running maximum.
 *
 * All three quantities come off the same four corners `itemFrame` builds the box from, projected
 * onto THE LINE's axes rather than onto each item's own. That is the part issue #140 changed, and
 * it is the difference between comparing two coordinates and comparing two coordinates read off
 * the same ruler. Projected per item, a frame difference of d moved the line coordinate by about
 * |origin| * sin(d) — so a rotated line drifting by a twentieth of a degree split at the far
 * corner of an A4 page while merging near the page origin — and, under shear, stepping one item
 * forward along the advance axis moved the item's own cross coordinate by `advance * (dir · up)`,
 * so a naturally-placed slanted run split after a glyph or two, in both writing modes. Neither
 * depended on where the text actually was, only on which ruler each end of the comparison used.
 *
 * The unrotated horizontal case still reduces to the page-axis rule this function used before —
 * exactly, not approximately, and unchanged by #140. With `b = c = 0` and no vertical flag
 * `itemAxes` returns `dir = (1,0)` and `up = (0,1)` EXACTLY (the divisions are `a/|a|`, `0/|a|`,
 * `0/|d|`, `d/|d|`), so every item of such a line has the same axes as the line it joins,
 * `positionAxis` gives back `(0,1)` bit for bit, the baseline coordinate is `transform[5]` and the
 * two extents are the numbers `box.x0`/`box.x1` already carry. Projecting onto the line's axes and
 * projecting onto the item's own are then the identical floating-point expression. An unrotated
 * document's output is unchanged, edge for edge — pinned against an independent reimplementation
 * of the page-axis rule in `test/unit/pdfGeometry.test.ts`.
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
 * - **Shear is modelled, in the box and now in the merge rule too.** The box always was, since
 *   the rotation work, and the comment that used to stand here saying otherwise was wrong:
 *   `itemFrame` builds its corners from the matrix's own two columns, normalized, scaled by the
 *   two lengths pdf.js measured along them; that is the exact parallelogram of a slanted matrix,
 *   not an orthogonal approximation of it. The merge rule did NOT, until issue #140: under shear
 *   `up · dir` is non-zero, so a run stepping forward along its advance axis moved its own cross
 *   coordinate every item and a naturally-placed slanted line came back as one box per item.
 *   Measuring the line position on the perpendicular to the advance axis (`positionAxis`) is what
 *   fixed it, and it is why a sheared line's position coordinate is a distance from the line
 *   rather than a coordinate along the up axis. The one thing this loosens is a frame so
 *   flattened that `up` is nearly parallel to `dir`: there the perpendicular separation of two
 *   real lines shrinks toward zero and they could merge. It takes the up axis within about 5
 *   degrees of the direction axis to bring a 12pt leading inside a 1pt tolerance — a text matrix
 *   with essentially no height left — and every angle short of that separates as it always did.
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
 * - **A vertical writing-mode line is boxed down the column AND merged into one box.**
 *   `emExtent` measures such an item down the column and centred on its baseline instead of as
 *   though horizontal (which put the box entirely above the text), and `groupingAxes` reads the
 *   merge rule in the frame that mode actually uses: the column takes the place of the baseline
 *   and the run down it takes the place of the advance. Grouping every item on the horizontal
 *   pairing was what left a vertical line as one box per glyph run — consecutive items down a
 *   column differ in exactly the coordinate that pairing calls the baseline. Two neighbouring
 *   columns still do not merge (their cross coordinates differ by a column width), and neither
 *   does a horizontal line that happens to share a coordinate with a vertical one (the writing
 *   mode is part of the frame).
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
    /** The first item's frame and line-position coordinate, kept for the whole line — the running
     *  line is grouped by the frame it was opened in, never by whatever the last item drifted
     *  to. `advance`/`position` are the axes EVERY later candidate is measured on, which is what
     *  makes the two ends of each comparison commensurable (issue #140); `across` and `alongMax`
     *  are already expressed on them. */
    across: number;
    alongMax: number;
    dir: Axis;
    up: Axis;
    vertical: boolean;
    advance: Axis;
    position: Axis;
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
      // The writing mode is compared alongside the axes, not derived from them: a
      // 270-degree-rotated horizontal item and an upright vertical one agree on both advance and
      // cross axes (see groupingAxes) yet are a sideways caption and an upright CJK column — and
      // their extents are measured by opposite conventions, so unioning them would describe
      // neither.
      const sameFrame =
        frame.vertical === current.vertical &&
        dot(frame.dir, current.dir) >= DIRECTION_TOLERANCE_COS &&
        dot(frame.up, current.up) >= DIRECTION_TOLERANCE_COS;
      // Both projections are taken against the RUNNING LINE's axes, never the candidate's own.
      // Read per item, the line coordinate was a coordinate on a different ruler whenever the
      // frames disagreed at all: a frame difference of d displaced it by about |origin| * sin(d),
      // and under shear each step along the advance axis displaced it by `advance * (dir · up)`.
      // Both split lines that are one line (issue #140). Measured here, `across` is the
      // candidate's perpendicular distance from THIS line's baseline and the gap is measured
      // along THIS line's advance, so the tolerances mean what they say in points.
      const across = projectPoint(frame.origin, current.position);
      const along = projectExtent(frame.emCorners, current.advance);
      const sameBaseline = Math.abs(across - current.across) <= baselineTolerancePt;
      // Adjacent or overlapping ALONG THE ADVANCE AXIS: the gap between the new item's near edge
      // and the running line's far edge is within tolerance forward, and bounded backward too — an
      // overlap may not exceed this item's own em size (floored at 1pt), or an explicit override.
      // Measured in the frame rather than in page x, or a rotated line's own advance reads as a
      // baseline change and every glyph run becomes its own box. `emSize`, not `item.height`: a
      // vertical item's `height` is the whole run's advance, which as a backward allowance would
      // let an item most of a column behind the line join it.
      const gap = along.min - current.alongMax;
      const minGap = -(overlapTolerancePt ?? Math.max(emSize(item), 1));
      const adjacent = gap <= gapTolerancePt && gap >= minGap;
      if (sameFrame && sameBaseline && adjacent) {
        current.text += item.str;
        current.box = unionBox(current.box, frame.box);
        current.items += 1;
        // Running maximum, mirroring what the union box's far edge did before: an item that ends
        // short of the line's reach must not pull the next item's gap measurement back with it.
        current.alongMax = Math.max(current.alongMax, along.max);
        continue;
      }
    }

    if (current) {
      lines.push(current);
    }
    // Opening a line: this item IS the frame, so its own axes are the line's and these two
    // projections are the ones the comparisons above will keep using.
    current = {
      text: item.str,
      box: frame.box,
      items: 1,
      across: projectPoint(frame.origin, frame.position),
      alongMax: projectExtent(frame.emCorners, frame.advance).max,
      dir: frame.dir,
      up: frame.up,
      vertical: frame.vertical,
      advance: frame.advance,
      position: frame.position,
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

import { describe, it, expect } from 'vitest';
import {
  multiply,
  unitSquareBounds,
  transformedBoxBounds,
  roundBox,
  mergeTextLines,
  IDENTITY,
  type Box,
  type Matrix,
  type TextItemLike,
} from '../../src/lib/pdfGeometry.js';

describe('multiply', () => {
  it('composes a translate applied first, then a scale — hand-computed', () => {
    const translate: Matrix = [1, 0, 0, 1, 3, 4];
    const scale: Matrix = [2, 0, 0, 2, 0, 0];
    const combined = multiply(translate, scale);
    // (0,0) -> translate -> (3,4) -> scale by 2 -> (6,8)
    expect(combined).toEqual([2, 0, 0, 2, 6, 8]);
  });

  it('composing with IDENTITY as base is a no-op', () => {
    const m: Matrix = [2, 0.5, -0.5, 3, 10, 20];
    expect(multiply(m, IDENTITY)).toEqual(m);
  });

  it('composing IDENTITY as m onto a base is a no-op', () => {
    const base: Matrix = [2, 0.5, -0.5, 3, 10, 20];
    expect(multiply(IDENTITY, base)).toEqual(base);
  });
});

describe('unitSquareBounds', () => {
  it('bounds a pure scale', () => {
    const m: Matrix = [100, 0, 0, 50, 0, 0];
    expect(unitSquareBounds(m)).toEqual({ x0: 0, y0: 0, x1: 100, y1: 50 });
  });

  it('bounds a scale plus translate', () => {
    const m: Matrix = [100, 0, 0, 50, 10, 20];
    expect(unitSquareBounds(m)).toEqual({ x0: 10, y0: 20, x1: 110, y1: 70 });
  });

  it('a rotated unit square has a larger bounding box than its own side length', () => {
    // 45-degree rotation matrix, unit square side 1.
    const angle = Math.PI / 4;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const m: Matrix = [cos, sin, -sin, cos, 0, 0];
    const bounds = unitSquareBounds(m);
    const width = bounds.x1 - bounds.x0;
    const height = bounds.y1 - bounds.y0;
    // A unit square rotated 45deg has a bounding box diagonal-sized: sqrt(2) per side.
    expect(width).toBeGreaterThan(1);
    expect(height).toBeGreaterThan(1);
    expect(width).toBeCloseTo(Math.SQRT2, 10);
    expect(height).toBeCloseTo(Math.SQRT2, 10);
  });
});

describe('transformedBoxBounds', () => {
  it('agrees with unitSquareBounds for the unit box', () => {
    const m: Matrix = [2, 0, 0, 3, 5, 7];
    expect(transformedBoxBounds({ x0: 0, y0: 0, x1: 1, y1: 1 }, m)).toEqual(unitSquareBounds(m));
  });

  it('bounds an arbitrary box under identity as itself', () => {
    const box = { x0: 10, y0: 20, x1: 30, y1: 40 };
    expect(transformedBoxBounds(box, IDENTITY)).toEqual(box);
  });
});

describe('transformedBoxBounds under a viewport transform', () => {
  it('a plain top-left flip (no rotation, MediaBox at the origin) matches the old toTopLeft math', () => {
    // [1,0,0,-1,0,pageHeightPt] is exactly what pdf.js's PageViewport.transform is for scale:1,
    // rotation 0, and a MediaBox starting at (0,0) — verified against the installed pdf.js source
    // (PageViewport constructor, legacy/build/pdf.mjs).
    const b = { x0: 10, y0: 0, x1: 20, y1: 5 };
    const viewportTransform: Matrix = [1, 0, 0, -1, 0, 100];
    expect(transformedBoxBounds(b, viewportTransform)).toEqual({ x0: 10, y0: 95, x1: 20, y1: 100 });
  });

  it('under a /Rotate 90 style viewport transform, axes swap and bounds stay normalized', () => {
    // Matches pdf.js's PageViewport.transform for rotation 90, scale 1, viewBox [0,0,W,H]:
    // [0,1,1,0,0,0] (derived from the PageViewport constructor and pinned here so a future
    // pdf.js that changes this convention is caught by this test, not discovered in production).
    const rotate90: Matrix = [0, 1, 1, 0, 0, 0];
    const b = { x0: 10, y0: 20, x1: 30, y1: 25 };
    const bounds = transformedBoxBounds(b, rotate90);
    // (x,y) -> (y, x) under this matrix, so the box's x-range and y-range trade places.
    expect(bounds).toEqual({ x0: 20, y0: 10, x1: 25, y1: 30 });
    // Normalized bounds, not raw corner order: x0 < x1 and y0 < y1 regardless of rotation.
    expect(bounds.x0).toBeLessThan(bounds.x1);
    expect(bounds.y0).toBeLessThan(bounds.y1);
  });
});

describe('roundBox', () => {
  it('rounds to 2 decimal places by default', () => {
    const b = { x0: 1.017, y0: 2.004, x1: 3.996, y1: 4.9999 };
    expect(roundBox(b)).toEqual({ x0: 1.02, y0: 2, x1: 4, y1: 5 });
  });

  it('rounds to a custom precision', () => {
    const b = { x0: 1.2345, y0: 0, x1: 0, y1: 0 };
    expect(roundBox(b, 1)).toEqual({ x0: 1.2, y0: 0, x1: 0, y1: 0 });
  });
});

function item(str: string, x: number, y: number, width: number, height = 10): TextItemLike {
  return { str, transform: [1, 0, 0, 1, x, y], width, height };
}

describe('mergeTextLines', () => {
  it('merges two items on the same baseline, horizontally adjacent, into one line', () => {
    const items = [item('Hello ', 0, 100, 40), item('world', 40, 100, 30)];
    const lines = mergeTextLines(items);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('Hello world');
    expect(lines[0]?.items).toBe(2);
    expect(lines[0]?.box).toEqual({ x0: 0, y0: 100, x1: 70, y1: 110 });
  });

  it("measures the next gap from the line's REACH, not from the last item's own end", () => {
    // The running maximum in mergeTextLines (`current.alongMax = Math.max(...)`). Every other
    // multi-item test here advances monotonically, so `alongMax = frame.alongMax` — dropping the
    // max entirely — passes all of them: this is the one shape that tells the two apart, and
    // without it the line is a comment with no test under it.
    //
    // A short middle item that ends well inside the line's reach: 'A' spans [0,60], 'B' is a
    // one-point item at [55,56] (a kerned glyph, an accent, a \hspace-adjusted run), 'C' starts
    // at 63. Against the line's reach the gap is 63-60 = 3, inside the default 6pt tolerance.
    // Against B's own end it would be 63-56 = 7, and C would split off into its own box.
    const items = [item('A', 0, 100, 60), item('B', 55, 100, 1), item('C', 63, 100, 10)];
    const lines = mergeTextLines(items);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('ABC');
    expect(lines[0]?.items).toBe(3);
    // And the box still spans the union, not the last item alone.
    expect(lines[0]?.box).toEqual({ x0: 0, y0: 100, x1: 73, y1: 110 });
  });

  it('does not merge items on different baselines', () => {
    const items = [item('Line one', 0, 100, 60), item('Line two', 0, 88, 60)];
    const lines = mergeTextLines(items);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.text).toBe('Line one');
    expect(lines[1]?.text).toBe('Line two');
  });

  it('starts a new line when the horizontal gap exceeds gapTolerancePt, same baseline', () => {
    const items = [item('Left', 0, 100, 30), item('Right', 200, 100, 30)];
    const lines = mergeTextLines(items, { gapTolerancePt: 6 });
    expect(lines).toHaveLength(2);
    expect(lines[0]?.text).toBe('Left');
    expect(lines[1]?.text).toBe('Right');
  });

  it('joins items within gapTolerancePt on the same baseline', () => {
    const items = [item('AB', 0, 100, 20), item('CD', 25, 100, 20)]; // gap = 5
    const lines = mergeTextLines(items, { gapTolerancePt: 6 });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('ABCD');
  });

  it('skips whitespace-only items entirely', () => {
    const items = [item('Hello', 0, 100, 30), item('   ', 30, 100, 20), item('world', 60, 100, 30)];
    const lines = mergeTextLines(items, { gapTolerancePt: 6 });
    // The whitespace item is skipped, so "world" is compared against "Hello"'s box directly:
    // gap = 60 - 30 = 30, past tolerance -> two lines, and the whitespace text never appears.
    expect(lines.map((l) => l.text)).toEqual(['Hello', 'world']);
  });

  it('truncates a long merged line with a trailing ellipsis at maxTextChars', () => {
    const longWord = 'x'.repeat(200);
    const items = [item(longWord, 0, 100, 500)];
    const lines = mergeTextLines(items, { maxTextChars: 160 });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text.length).toBe(161); // 160 chars + the ellipsis character
    expect(lines[0]?.text.endsWith('…')).toBe(true);
  });

  it('returns an empty array for no input', () => {
    expect(mergeTextLines([])).toEqual([]);
  });

  it('returns an empty array when every item is whitespace-only', () => {
    expect(mergeTextLines([item('  ', 0, 0, 10), item('\t', 20, 0, 10)])).toEqual([]);
  });

  it('reports a box aligned to the text-direction axis for a 90-degree-rotated item, not transposed onto +x/+y (Finding 1)', () => {
    // Text-rendering matrix for a 90-degree-CCW-rotated item at fontSize 10, origin (0,0):
    // direction axis (a,b) = (0,10) i.e. +y, up axis (c,d) = (-10,0) i.e. -x — pdf.js's own
    // convention for a rotated text matrix (as produced by pdflscape's page-content rotation).
    const rotated: TextItemLike = {
      str: 'Rotated',
      transform: [0, 10, -10, 0, 0, 0],
      width: 50,
      height: 8,
    };
    const lines = mergeTextLines([rotated]);
    expect(lines).toHaveLength(1);
    const box = lines[0]!.box;
    // A 50pt-long, 8pt-tall run of rotated text must come back TALL and NARROW (8 wide, 50 tall).
    // The old itemBox added `width` along +x and `height` along +y regardless of rotation, which
    // for this matrix produced a WIDE, SHORT box (50 wide, 8 tall) instead.
    expect(box).toEqual({ x0: -8, y0: 0, x1: 0, y1: 50 });
    expect(box.y1 - box.y0).toBeGreaterThan(box.x1 - box.x0);
  });

  it('reduces to the exact old axis-aligned box for an unrotated item at a scaled font size (Finding 1 no-op check)', () => {
    // transform = [fontSize,0,0,fontSize,e,f]: b=c=0, so dir=(1,0) and up=(0,1) exactly — the
    // fix must not perturb this case by even a rounding step.
    const items: TextItemLike[] = [
      { str: 'Hi', transform: [12, 0, 0, 12, 5, 7], width: 20, height: 10 },
    ];
    const lines = mergeTextLines(items);
    expect(lines[0]?.box).toEqual({ x0: 5, y0: 7, x1: 25, y1: 17 });
  });

  it('does not merge an item whose left edge is far to the left of the running line (Finding 2)', () => {
    // Same shape as the TikZ right-node/left-node repro: two items on one baseline, emitted
    // right-then-left, ~260pt apart. The old code bounded the gap only above (gap<=gapTolerancePt),
    // so a large NEGATIVE gap (item far to the left) always joined the running line.
    const items = [item('RIGHT', 300, 100, 40), item('LEFT', 0, 100, 40)];
    const lines = mergeTextLines(items);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.text)).toEqual(['RIGHT', 'LEFT']);
  });

  it('still merges a small backward overlap within the joining item own height (Finding 2, default per-item rule)', () => {
    const items = [item('e', 0, 100, 10, 12), item('́', 8, 100, 0, 12)]; // gap = 8-10 = -2, height 12
    const lines = mergeTextLines(items);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('é');
  });

  it('floors the default backward-overlap allowance at 1pt for a zero-height item (Finding 2)', () => {
    const items = [item('A', 0, 100, 10, 0), item('B', 9, 100, 10, 0)]; // gap = 9-10 = -1, item height = 0
    const lines = mergeTextLines(items);
    expect(lines).toHaveLength(1);
  });

  it.each([
    ['a non-finite text-direction component', [Infinity, 0, 0, 10, 5, 7]],
    ['a non-finite up component', [10, 0, Infinity, 0, 5, 7]],
    ['a NaN text matrix', [NaN, NaN, 0, 10, 5, 7]],
    ['an all-zero text matrix', [0, 0, 0, 0, 5, 7]],
  ])(
    'never emits a non-finite box edge for %s — the matrix is document-controlled, and a NaN edge is rejected by the tool schema AFTER the handler returns, outside errorResult',
    (_name, transform) => {
      const lines = mergeTextLines([
        { str: 'x', transform: transform as unknown as Matrix, width: 20, height: 10 },
      ]);
      const box = lines[0]?.box;
      expect(box).toBeDefined();
      for (const edge of [box!.x0, box!.y0, box!.x1, box!.y1]) {
        expect(Number.isFinite(edge)).toBe(true);
      }
      // Falls back to the unrotated axes rather than to a degenerate point.
      expect(box).toEqual({ x0: 5, y0: 7, x1: 25, y1: 17 });
    },
  );

  it.each([
    ['a non-finite origin x (transform[4])', [10, 0, 0, 10, Infinity, 7], 20, 10],
    ['a non-finite origin y (transform[5])', [10, 0, 0, 10, 5, Infinity], 20, 10],
    ['a NaN origin', [10, 0, 0, 10, NaN, 7], 20, 10],
    ['a non-finite width', [10, 0, 0, 10, 5, 7], Infinity, 10],
    ['a non-finite height', [10, 0, 0, 10, 5, 7], 20, Infinity],
    ['a NaN width', [10, 0, 0, 10, 5, 7], NaN, 10],
  ])(
    'drops the item outright for %s — unlike a non-finite AXIS there is no sane fallback ' +
      'position/extent to fall back to (Finding 1, origin/width/height)',
    (_name, transform, width, height) => {
      const lines = mergeTextLines([
        {
          str: 'x',
          transform: transform as unknown as Matrix,
          width: width as number,
          height: height as number,
        },
      ]);
      // Unlike the axis-fallback cases above (which stay present with a safe box), there is no
      // sane default position or extent for a non-finite origin/width/height, so the item — and
      // any "line" it would have been — is dropped entirely rather than reported with a
      // NaN/Infinity edge.
      expect(lines).toEqual([]);
    },
  );

  it('drops a poisoned item without corrupting a neighboring good item merged into the same line (Finding 1)', () => {
    const items: TextItemLike[] = [
      { str: 'Good', transform: [1, 0, 0, 1, 0, 100], width: 30, height: 10 },
      // Adjacent to 'Good' on the same baseline (gap = 30-30 = 0, within tolerance), so it would
      // merge into the same running line under the old code.
      { str: 'Bad', transform: [1, 0, 0, 1, 30, 100], width: Infinity, height: 10 },
    ];
    const lines = mergeTextLines(items);
    // Before this fix, unionBox('Good' box, 'Bad' box) turned the WHOLE merged line's box into
    // NaN/Infinity, even though 'Good' on its own is perfectly finite geometry, and the merged
    // text became "GoodBad" — reporting a line that includes text from an item whose own geometry
    // was never actually measured.
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('Good');
    for (const edge of [lines[0]!.box.x0, lines[0]!.box.y0, lines[0]!.box.x1, lines[0]!.box.y1]) {
      expect(Number.isFinite(edge)).toBe(true);
    }
  });

  it('honors an explicit overlapTolerancePt override in place of the default per-item rule (Finding 2)', () => {
    const items = [item('AB', 20, 100, 10), item('CD', 0, 100, 10)]; // gap = 0-30 = -30
    const linesDefault = mergeTextLines(items); // default minGap = -10 (item height) -> splits
    expect(linesDefault).toHaveLength(2);
    const linesOverride = mergeTextLines(items, { overlapTolerancePt: 40 }); // -30 >= -40 -> merges
    expect(linesOverride).toHaveLength(1);
  });
});

/** A 90-degree-CCW-rotated text item (fontSize 10): direction axis +y, up axis -x. The matrix is
 *  written out literally rather than via `Math.cos(Math.PI / 2)` (which is 6.1e-17, not 0), so the
 *  expected boxes below are exact numbers and not near-misses hidden behind `toBeCloseTo`. */
function rot90(str: string, x: number, y: number, width: number, height = 10): TextItemLike {
  return { str, transform: [0, 10, -10, 0, x, y], width, height };
}

/** A 270-degree (90-degree-CW) rotated text item: direction axis -y, up axis +x. */
function rot270(str: string, x: number, y: number, width: number, height = 10): TextItemLike {
  return { str, transform: [0, -10, 10, 0, x, y], width, height };
}

/** A text item rotated by `deg` about the page origin, at fontSize 10. Used only where the angle
 *  itself is the thing under test (the direction tolerance), so the inexactness of cos/sin at these
 *  angles is irrelevant — the assertions are merge/no-merge, not edge coordinates. */
function rotatedItem(
  str: string,
  deg: number,
  x: number,
  y: number,
  width: number,
  height = 10,
): TextItemLike {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { str, transform: [10 * cos, 10 * sin, -10 * sin, 10 * cos, x, y], width, height };
}

describe('mergeTextLines — rotated lines (issue #80 section 6, third bullet)', () => {
  it('merges the three items of a 90-degree-rotated line into one box', () => {
    // The items of a rotated line share an x, not a y, so grouping by transform[5] reported three
    // separate boxes and a caller asking "how wide is this rotated heading" got three answers.
    const items = [rot90('Ro', 100, 50, 40), rot90('ta', 100, 90, 40), rot90('ted', 100, 130, 40)];
    const lines = mergeTextLines(items);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.items).toBe(3);
    expect(lines[0]?.text).toBe('Rotated');
    // Each item spans 40pt along +y and 10pt back along -x from its origin at x=100.
    expect(lines[0]?.box).toEqual({ x0: 90, y0: 50, x1: 100, y1: 170 });
  });

  it('merges the three items of a 270-degree-rotated line into one box', () => {
    const items = [
      rot270('Down', 100, 200, 40),
      rot270('ward', 100, 160, 40),
      rot270('s', 100, 120, 40),
    ];
    const lines = mergeTextLines(items);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.items).toBe(3);
    expect(lines[0]?.text).toBe('Downwards');
    // Direction axis is -y here, so successive origins DECREASE in y while the run advances.
    expect(lines[0]?.box).toEqual({ x0: 100, y0: 80, x1: 110, y1: 200 });
  });

  it('merges the three items of a 45-degree-rotated line into one box', () => {
    const c = Math.SQRT1_2;
    const items: TextItemLike[] = [0, 1, 2].map((k) => ({
      str: 'ab',
      transform: [10 * c, 10 * c, -10 * c, 10 * c, 40 * k * c, 40 * k * c] as Matrix,
      width: 40,
      height: 10,
    }));
    const lines = mergeTextLines(items);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.items).toBe(3);
    const box = lines[0]!.box;
    // Hand-computed union of the three rotated boxes: the run reaches 120pt along (c,c) and 10pt
    // along the up axis (-c,c), so x spans [-10c, 120c] and y spans [0, 130c].
    expect(box.x0).toBeCloseTo(-10 * c, 6);
    expect(box.y0).toBeCloseTo(0, 6);
    expect(box.x1).toBeCloseTo(120 * c, 6);
    expect(box.y1).toBeCloseTo(130 * c, 6);
  });

  it('does not merge two items that share a transform[5] but are rotated differently', () => {
    // The narrowing half of this change: grouping by transform[5] alone joined an unrotated run to
    // a rotated one sitting on the same page y, producing one box across two visual lines.
    const items = [item('Across', 0, 100, 40), rot90('Up', 40, 100, 40)];
    const lines = mergeTextLines(items);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.text)).toEqual(['Across', 'Up']);
    expect(lines[0]?.box).toEqual({ x0: 0, y0: 100, x1: 40, y1: 110 });
  });

  it('applies gapTolerancePt along the rotated direction, not along the page x axis', () => {
    const items = [
      rot90('Near', 100, 50, 40), // spans 50..90 along +y
      rot90('est', 100, 90, 40), // starts at 90: gap 0, merges
      rot90('Far', 100, 200, 40), // starts at 200: gap 70, past tolerance
    ];
    const lines = mergeTextLines(items);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.items)).toEqual([2, 1]);
    expect(lines[0]?.box).toEqual({ x0: 90, y0: 50, x1: 100, y1: 130 });
    expect(lines[1]?.box).toEqual({ x0: 90, y0: 200, x1: 100, y1: 240 });
  });

  it('measures baselineTolerancePt across the rotated frame (the up axis), on both sides of the bound', () => {
    // Under a 90-degree rotation the baseline coordinate is -x, so a drifting baseline shows up as a
    // difference in transform[4], which the page-frame test could never see.
    const inside = [rot90('A', 100, 50, 40), rot90('B', 100.5, 90, 40)];
    expect(mergeTextLines(inside)).toHaveLength(1);
    const outside = [rot90('A', 100, 50, 40), rot90('B', 101.5, 90, 40)];
    expect(mergeTextLines(outside)).toHaveLength(2);
  });

  it('bounds the backward overlap along the rotated direction, on both sides of the bound', () => {
    // Default allowance is the joining item's own height (10pt here), floored at 1pt.
    const inside = [rot90('e', 100, 50, 40), rot90('́', 100, 80, 40)]; // gap = 80 - 90 = -10
    const merged = mergeTextLines(inside);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.box).toEqual({ x0: 90, y0: 50, x1: 100, y1: 120 });
    const outside = [rot90('e', 100, 50, 40), rot90('́', 100, 79, 40)]; // gap = -11
    expect(mergeTextLines(outside)).toHaveLength(2);
  });

  it('joins frames that differ by less than the direction tolerance and splits ones that differ by more', () => {
    // Pins the ~1 degree DIRECTION_TOLERANCE_COS from the outside: 0.9 degrees is inside it and
    // 1.1 degrees is not, so the constant cannot drift far without this failing.
    const near = [item('Base', 0, 100, 40), rotatedItem('Tilt', 0.9, 40, 100, 40)];
    expect(mergeTextLines(near)).toHaveLength(1);
    const far = [item('Base', 0, 100, 40), rotatedItem('Tilt', 1.1, 40, 100, 40)];
    expect(mergeTextLines(far)).toHaveLength(2);
    // And well past it: a 5-degree tilt shares a transform[5] and overlaps in page x, so the old
    // rule merged it into the horizontal line.
    const way = [item('Base', 0, 100, 40), rotatedItem('Tilt', 5, 40, 100, 40)];
    expect(mergeTextLines(way)).toHaveLength(2);
  });

  it('still produces exactly the pre-existing box and item count for a canned unrotated line', () => {
    // The reduction check: with b = c = 0 the frame is dir=(1,0), up=(0,1), so `across` is
    // transform[5] and the along-extents ARE the box's x0/x1 — no drift, no new rounding step.
    const items = [item('Foo', 0, 100, 30), item('Bar', 30, 100, 30), item('Baz', 60, 100, 30)];
    const lines = mergeTextLines(items);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.items).toBe(3);
    expect(lines[0]?.text).toBe('FooBarBaz');
    expect(lines[0]?.box).toEqual({ x0: 0, y0: 100, x1: 90, y1: 110 });
  });

  it('keeps a guarded-fallback axis item out of a real line rather than letting it widen that box', () => {
    // The direction axis normalizes to NaN and falls back to (1,0), but the up axis is a real -x:
    // the frames disagree, so the item stays its own line instead of stretching the horizontal
    // one it happens to share a transform[5] and an x-overlap with.
    const items: TextItemLike[] = [
      { str: 'Real', transform: [10, 0, 0, 10, 0, 100], width: 40, height: 10 },
      { str: 'Poison', transform: [0, Infinity, -10, 0, 45, 100] as Matrix, width: 20, height: 10 },
    ];
    const lines = mergeTextLines(items);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.text).toBe('Real');
    expect(lines[0]?.box).toEqual({ x0: 0, y0: 100, x1: 40, y1: 110 });
    for (const l of lines) {
      for (const edge of [l.box.x0, l.box.y0, l.box.x1, l.box.y1]) {
        expect(Number.isFinite(edge)).toBe(true);
      }
    }
  });

  it('drops a non-finite-extent item before it can reach a rotated line it would have joined', () => {
    // hasNonFiniteEdge still fires first, ahead of any frame comparison: the dropped item neither
    // poisons the union box nor breaks the run in two, exactly as in the unrotated case.
    const items: TextItemLike[] = [
      rot90('A', 100, 50, 40),
      { str: 'Bad', transform: [0, 10, -10, 0, 100, 90] as Matrix, width: Infinity, height: 10 },
      rot90('C', 100, 90, 40),
    ];
    const lines = mergeTextLines(items);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.items).toBe(2);
    expect(lines[0]?.text).toBe('AC');
    expect(lines[0]?.box).toEqual({ x0: 90, y0: 50, x1: 100, y1: 130 });
  });
});

/**
 * The box math before font metrics existed, reimplemented here as an INDEPENDENT reference: the
 * item's four corners at `origin + s*dir + t*up` for `s in [0, width]`, `t in [0, height]`, with
 * the same non-finite-axis fallback `itemAxes` applies. Copied from the shipped code as it stood
 * before this change rather than called into, since the whole point is to detect the day the two
 * stop agreeing — a reference that delegates to the code under test proves nothing.
 */
function legacyBox(it: TextItemLike): { x0: number; y0: number; x1: number; y1: number } {
  const [a, b, c, d, e, f] = it.transform;
  const dirLen = Math.hypot(a, b);
  let dir: [number, number] = dirLen > 0 ? [a / dirLen, b / dirLen] : [1, 0];
  if (!Number.isFinite(dir[0]) || !Number.isFinite(dir[1])) dir = [1, 0];
  const upLen = Math.hypot(c, d);
  let up: [number, number] = upLen > 0 ? [c / upLen, d / upLen] : [0, 1];
  if (!Number.isFinite(up[0]) || !Number.isFinite(up[1])) up = [0, 1];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of [0, it.width]) {
    for (const t of [0, it.height]) {
      xs.push(e + s * dir[0] + t * up[0]);
      ys.push(f + s * dir[1] + t * up[1]);
    }
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

describe('mergeTextLines — declared font ascent (issue #80 section 6, bullet 1)', () => {
  it('cuts the top of the box to the declared ascent, as a fraction of the em', () => {
    // 0.718 is Helvetica's, measured out of the installed pdf.js rather than assumed: a page
    // drawing /Helvetica reports styles[fontName].ascent === 0.718 (718/1000 of its own
    // standard-font metrics table), and pdf.js's text layer uses it the same way — as a
    // multiplier of hypot(trm[2], trm[3]), which is the very `height` this item carries.
    const lines = mergeTextLines([
      { str: 'Hg', transform: [10, 0, 0, 10, 20, 100], width: 30, height: 10, ascent: 0.718 },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.box).toEqual({ x0: 20, y0: 100, x1: 50, y1: 107.18 });
  });

  it.each([
    ['absent', undefined],
    // Reachable, not theoretical: pdf.js's standard-font metrics table carries
    // `ascent: Math.NaN` for Symbol and ZapfDingbats, and a LaTeX document using either
    // (math fonts routinely do) reports NaN straight through `styles`.
    ['NaN (Symbol, ZapfDingbats)', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['zero', 0],
    ['negative', -0.7],
    // Above the em: growing the box is the SAFE direction, but an /Ascent descriptor is
    // document-controlled and unbounded, so a hostile one would produce a box a kilometre tall.
    ['just above one', 1.0001],
    ['absurdly large (a hostile /Ascent)', 1e6],
  ])('falls back to the full em height for a %s ascent, never to a default', (_label, ascent) => {
    const lines = mergeTextLines([
      { str: 'Hg', transform: [10, 0, 0, 10, 20, 100], width: 30, height: 10, ascent },
    ]);
    // The full em: 100 -> 110. Emphatically NOT 108, which is what pdf.js's own text-layer
    // default of 0.8 would give — that number is a rendering nicety, and spending it here would
    // shrink every box under a metrics-less font by a fifth of an em on no evidence at all.
    expect(lines[0]?.box).toEqual({ x0: 20, y0: 100, x1: 50, y1: 110 });
    expect(lines[0]?.box.y1).not.toBe(108);
  });

  it('spends the ascent along the UP axis of a rotated item, not along page +y', () => {
    // 90deg CCW: up axis is -x, so the ascent shortens the box's x extent, not its y one.
    const lines = mergeTextLines([
      { str: 'Up', transform: [0, 10, -10, 0, 0, 0], width: 50, height: 10, ascent: 0.7 },
    ]);
    expect(lines[0]?.box).toEqual({ x0: -7, y0: 0, x1: 0, y1: 50 });
  });

  it('agrees edge-for-edge with the pre-metrics box for every item that declares no usable ascent', () => {
    // Invariant: an item with no usable metrics must come out byte-identical to what the code
    // produced before metrics existed — under rotation and shear too, not only in the plain case.
    const cases: TextItemLike[] = [];
    for (const deg of [0, 17, 45, 90, 180, 270, 359]) {
      const rad = (deg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      for (const size of [1, 9.9632, 24]) {
        for (const k of [0, 0.25]) {
          const a = size * cos;
          const b = size * sin;
          const c = size * (k * cos - sin);
          const d = size * (k * sin + cos);
          for (const ascent of [undefined, Number.NaN, 0, 1.5]) {
            cases.push({
              str: 'x',
              transform: [a, b, c, d, 13.5, -7.25] as Matrix,
              width: 3.25 * size,
              height: Math.hypot(c, d),
              ...(ascent === undefined ? {} : { ascent }),
            });
          }
        }
      }
    }
    // Universally quantified over `cases`, so the set's own size is asserted too: an empty or
    // accidentally-truncated generator would make every expectation below vacuous.
    expect(cases.length).toBeGreaterThanOrEqual(168);
    for (const c of cases) {
      const box = mergeTextLines([c])[0]?.box;
      const want = legacyBox(c);
      // Object.is per edge (toBe), not toBeCloseTo: identical arithmetic on identical inputs must
      // give identical bits, or something in the path changed.
      expect(box?.x0).toBe(want.x0);
      expect(box?.y0).toBe(want.y0);
      expect(box?.x1).toBe(want.x1);
      expect(box?.y1).toBe(want.y1);
    }
  });
});

describe('mergeTextLines — sheared text matrices (issue #80 section 6, bullet 2)', () => {
  it('bounds the true parallelogram of a sheared matrix, derived independently through the matrix itself', () => {
    // The numbers are pdf.js's own, measured on a hand-built PDF against the installed
    // pdfjs-dist 6.1.200: `BT /F3 12 Tf 12 0 3 12 20 40 Tm (Shear) Tj ET` comes back as
    // transform [144, 0, 36, 144, 20, 40], width 327.888, height 148.43180252223578.
    const it: TextItemLike = {
      str: 'Shear',
      transform: [144, 0, 36, 144, 20, 40],
      width: 327.888,
      height: 148.43180252223578,
    };
    // Ground truth, derived the other way round: the glyphs occupy [0, advance] x [0, 1] in TEXT
    // space (2.277 ems wide, one em tall), and the text matrix maps that rectangle into user
    // space. transformedBoxBounds is tested independently above, and this route never touches a
    // normalized axis — so an implementation that orthogonalized the up axis, or that rebuilt
    // corners from the raw matrix and double-applied its scale, would disagree here.
    const want = transformedBoxBounds({ x0: 0, y0: 0, x1: 327.888 / 144, y1: 1 }, it.transform);
    const box = mergeTextLines([it])[0]!.box;
    expect(box.x0).toBeCloseTo(want.x0, 9);
    expect(box.y0).toBeCloseTo(want.y0, 9);
    expect(box.x1).toBeCloseTo(want.x1, 9);
    expect(box.y1).toBeCloseTo(want.y1, 9);
    // And concretely: the skew widens the box by the up axis's own x component (36pt), so it is
    // NOT the 327.888-wide axis-aligned rectangle an orthogonal approximation would give.
    expect(box.x1 - box.x0).toBeCloseTo(327.888 + 36, 9);
  });

  it('keeps the merge rule on the full-em frame, so a declared ascent cannot regroup a sheared line', () => {
    // A sheared pair placed where the merge rule can actually see them as one line: the up axis
    // of [40, 0, 40, 40, ...] is (40, 40), so two origins agree on `across` (the origin projected
    // onto the up axis) when their offset is perpendicular to it — hence (0, 100) and
    // (145, -45). That is the only construction in which the em-vs-ink choice is observable at
    // all, which is why it looks contrived.
    //
    // The em-frame reach of the first item is 0 + 100 (advance) + 40 (the up axis's own x lean
    // over one em) = 140, and the second starts at 145: a 5pt gap, inside the 6pt default. Cut
    // the top to half an em and that reach becomes 120, the gap becomes 25pt, and the line
    // splits. Grouping is therefore computed from the em corners whatever the box does, and this
    // test is what says so.
    const shear = (width: number, x: number, y: number, ascent?: number): TextItemLike => ({
      str: width > 50 ? 'Slant' : 'ed',
      transform: [40, 0, 40, 40, x, y],
      width,
      height: Math.hypot(40, 40),
      ...(ascent === undefined ? {} : { ascent }),
    });
    const plain = [shear(100, 0, 100), shear(40, 145, -45)];
    expect(mergeTextLines(plain)).toHaveLength(1);
    const withAscent = [shear(100, 0, 100, 0.5), shear(40, 145, -45, 0.5)];
    const lines = mergeTextLines(withAscent);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('Slanted');
    // The boxes still shrank — this is not "the ascent was ignored", it is "the ascent did not
    // move the grouping".
    expect(lines[0]!.box.y1).toBeLessThan(mergeTextLines(plain)[0]!.box.y1);
  });
});

describe('mergeTextLines — vertical writing mode (issue #80 section 6)', () => {
  /** A vertical-mode item as pdf.js reports one: `width` is the em ACROSS the column
   *  (hypot(trm[0], trm[1])) and `height` is the accumulated advance DOWN it. */
  function verticalItem(str: string, x: number, y: number, advance: number, em = 12): TextItemLike {
    return { str, transform: [em, 0, 0, em, x, y], width: em, height: advance, vertical: true };
  }

  it('runs the box DOWN the column from the origin and centres it across the baseline', () => {
    const lines = mergeTextLines([verticalItem('縦書き', 100, 700, 48)]);
    expect(lines).toHaveLength(1);
    // Down: y from 700-48 to 700. Across: centred on x=100 (the PDF's own default vertical
    // origin v = (w0/2, DW2[0]), which is what pdf.js assumes too).
    expect(lines[0]?.box).toEqual({ x0: 94, y0: 652, x1: 106, y1: 700 });
  });

  it('no longer puts the box entirely on the wrong side of the text', () => {
    // The pre-change measurement treated `height` as an em measured UP the up axis, so the box
    // sat above the origin — over blank paper — while every glyph hung below it. Nothing about
    // the two boxes overlapped except the baseline itself.
    const it = verticalItem('縦', 100, 700, 48);
    const box = mergeTextLines([it])[0]!.box;
    const before = legacyBox(it);
    expect(before).toEqual({ x0: 100, y0: 700, x1: 112, y1: 748 });
    expect(box.y1).toBeLessThanOrEqual(700);
    expect(box.y0).toBeLessThan(before.y0);
  });

  it('does not spend an ascent on a vertical item, whose height is an advance and not an em', () => {
    const plain = mergeTextLines([verticalItem('縦', 100, 700, 48)])[0]!.box;
    const withAscent = mergeTextLines([{ ...verticalItem('縦', 100, 700, 48), ascent: 0.5 }])[0]!
      .box;
    // Halving it would have shortened the RUN, dropping 24pt of real glyphs off the bottom.
    expect(withAscent).toEqual(plain);
  });

  it('leaves a horizontal item untouched when the flag is false or absent', () => {
    const base: TextItemLike = {
      str: 'H',
      transform: [12, 0, 0, 12, 100, 700],
      width: 12,
      height: 12,
    };
    const want = { x0: 100, y0: 700, x1: 112, y1: 712 };
    expect(mergeTextLines([base])[0]?.box).toEqual(want);
    expect(mergeTextLines([{ ...base, vertical: false }])[0]?.box).toEqual(want);
  });

  it('merges the items of one column into a single column box (issue #80 section 6, vertical merge)', () => {
    // The gap this closes. Grouping used to run on the HORIZONTAL pairing for every item —
    // baseline = origin projected onto the up axis — and consecutive items down a column differ
    // in exactly that coordinate, so each glyph run came back as its own box: correct boxes,
    // uncombined. The column is now the cross axis and the run down it is the advance.
    const lines = mergeTextLines([
      verticalItem('縦', 100, 700, 48),
      verticalItem('書', 100, 652, 48),
      verticalItem('き', 100, 604, 48),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.items).toBe(3);
    expect(lines[0]?.text).toBe('縦書き');
    // Down from y=700 through three 48pt advances to y=556, and 12pt wide centred on x=100.
    expect(lines[0]?.box).toEqual({ x0: 94, y0: 556, x1: 106, y1: 700 });
  });

  it('measures the gap down a column from the glyphs, not from the origin — a run of UNEQUAL advances still merges', () => {
    // Pins the vertical branch of `emExtent` specifically, not merely the axis swap. Grouping a
    // vertical item on the horizontal extent puts its along-extent a whole advance behind where
    // its glyphs sit; two items then measure a gap of (advance_i - advance_{i+1}), which is 0
    // only while the advances happen to be equal. Every other column test here uses one advance
    // throughout and so passes either way: this is the shape that tells them apart.
    const lines = mergeTextLines([
      verticalItem('長い行', 100, 700, 48),
      verticalItem('。', 100, 652, 12),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.items).toBe(2);
    expect(lines[0]?.box).toEqual({ x0: 94, y0: 640, x1: 106, y1: 700 });
  });

  it('does not merge two neighbouring columns', () => {
    // The narrowing half: the cross axis of a vertical item is its DIRECTION axis, so two columns
    // one em apart differ by 12pt there — far past the 1pt tolerance — even though they overlap
    // completely in the coordinate the run advances along.
    const lines = mergeTextLines([
      verticalItem('右', 112, 700, 48),
      verticalItem('列', 112, 652, 48),
      verticalItem('左', 100, 700, 48),
      verticalItem('列', 100, 652, 48),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.text)).toEqual(['右列', '左列']);
    expect(lines[0]?.box).toEqual({ x0: 106, y0: 604, x1: 118, y1: 700 });
    expect(lines[1]?.box).toEqual({ x0: 94, y0: 604, x1: 106, y1: 700 });
  });

  it('never merges a vertical item with a horizontal one, even when their frame axes are identical and their coordinates line up', () => {
    // The writing mode is compared on top of the axes because the axes cannot carry this. Both
    // items below have dir = (1,0) and up = (0,1) — the SAME frame — but the vertical one's
    // position is read off its x and its run off -y, while the horizontal one's are read off its
    // y and its x. Line them up and, without the writing-mode clause, the rule compares the
    // vertical item's x against the horizontal item's y (both 100) and their runs across
    // opposite axes (gap 0), merging a line at y=100 with a column at y=-40 into one box
    // spanning 150pt of blank paper.
    //
    // The construction is contrived precisely BECAUSE it has to force two coordinate systems into
    // agreement — but a text matrix is document-controlled and can put an origin anywhere, so it
    // is reachable, and the cost of being wrong is a box covering paper no glyph touches.
    const horizontal: TextItemLike = {
      str: 'H',
      transform: [10, 0, 0, 10, 0, 100],
      width: 40,
      height: 10,
    };
    const vertical: TextItemLike = {
      str: 'V',
      transform: [10, 0, 0, 10, 100, -40],
      width: 10,
      height: 48,
      vertical: true,
    };
    const lines = mergeTextLines([horizontal, vertical]);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.text)).toEqual(['H', 'V']);
    expect(lines[0]?.box).toEqual({ x0: 0, y0: 100, x1: 40, y1: 110 });
    expect(lines[1]?.box).toEqual({ x0: 95, y0: -88, x1: 105, y1: -40 });
  });

  it('does not merge a 270-degree-rotated horizontal run into a column it is flush with', () => {
    // The other aliasing pair, and the one a real document can produce: a sideways caption and an
    // upright CJK column running down the same strip of page have the SAME advance and cross axes
    // — (0,-1) and (1,0) — so only the writing mode and the raw frame axes separate them.
    const sideways: TextItemLike = {
      str: 'sideways',
      transform: [0, -12, 12, 0, 100, 652],
      width: 48,
      height: 12,
    };
    const lines = mergeTextLines([verticalItem('縦', 100, 700, 48), sideways]);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.text)).toEqual(['縦', 'sideways']);
  });

  it('merges a ROTATED column, so a vertical line on a pdflscape page is one box too', () => {
    // 90deg CCW: dir = (0,1), up = (-1,0), so the column runs along +x and its cross axis is +y.
    const rotatedVertical = (str: string, x: number, y: number): TextItemLike => ({
      str,
      transform: [0, 12, -12, 0, x, y],
      width: 12,
      height: 48,
      vertical: true,
    });
    const lines = mergeTextLines([
      rotatedVertical('縦', 100, 700),
      rotatedVertical('書', 148, 700),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.items).toBe(2);
    expect(lines[0]?.box).toEqual({ x0: 100, y0: 694, x1: 196, y1: 706 });
  });

  it('applies gapTolerancePt down the column, on both sides of the bound', () => {
    const inside = [verticalItem('縦', 100, 700, 48), verticalItem('書', 100, 648, 48)]; // gap 4
    expect(mergeTextLines(inside)).toHaveLength(1);
    const outside = [verticalItem('縦', 100, 700, 48), verticalItem('書', 100, 642, 48)]; // gap 10
    expect(mergeTextLines(outside)).toHaveLength(2);
  });

  it("bounds a backward overlap by the vertical item's EM, not by its accumulated advance", () => {
    // The default allowance is one em — "a glyph may paint back over the one before it, nothing
    // farther". A vertical item's em is its `width` (12 here); its `height` is the whole run's
    // advance (48). Taking `height` would let an item 48pt back up the column — four glyphs — join
    // the line, which is the blank-paper merge the backward bound exists to refuse.
    const inside = [verticalItem('縦', 100, 700, 48), verticalItem('書', 100, 662, 48)]; // gap -10
    expect(mergeTextLines(inside)).toHaveLength(1);
    const outside = [verticalItem('縦', 100, 700, 48), verticalItem('書', 100, 672, 48)]; // gap -20
    expect(mergeTextLines(outside)).toHaveLength(2);
  });

  it('honors an explicit overlapTolerancePt down a column as well', () => {
    const items = [verticalItem('縦', 100, 700, 48), verticalItem('書', 100, 672, 48)]; // gap -20
    expect(mergeTextLines(items)).toHaveLength(2);
    expect(mergeTextLines(items, { overlapTolerancePt: 25 })).toHaveLength(1);
  });

  it('drops a non-finite-extent item before it can reach a column it would have joined', () => {
    const items: TextItemLike[] = [
      verticalItem('縦', 100, 700, 48),
      { ...verticalItem('bad', 100, 652, 48), height: Infinity },
      verticalItem('書', 100, 652, 48),
    ];
    const lines = mergeTextLines(items);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.items).toBe(2);
    expect(lines[0]?.text).toBe('縦書');
    expect(lines[0]?.box).toEqual({ x0: 94, y0: 604, x1: 106, y1: 700 });
  });
});

/**
 * A run of `n` items laid out CONTIGUOUSLY in the merge rule's own terms, from an explicit matrix
 * shape — `deg` of rotation, `k` of shear, a font size, and a writing mode. Nothing here calls
 * into pdfGeometry: the placement is derived from the matrix by hand, so a run that fails to merge
 * is a statement about the code under test and not about the fixture.
 *
 * Each step moves the origin perpendicular to the line's CROSS axis (so the line position does not
 * drift) by exactly the run's reach along its ADVANCE axis (so the gap is zero). Under shear the
 * up axis leans into the direction axis, which is why the reach carries a `|dir·up|` term and why
 * the step is not simply "advance along dir": stepping along dir under shear moves the cross
 * coordinate too, and the line splits — the pre-existing limitation the hand-built shear test
 * above works around the same way.
 */
function contiguousRun(opts: {
  deg: number;
  k: number;
  size: number;
  vertical: boolean;
  n: number;
  advance: number;
  origin: readonly [number, number];
}): TextItemLike[] {
  const { deg, k, size, vertical, n, advance, origin } = opts;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const a = size * cos;
  const b = size * sin;
  const c = size * (k * cos - sin);
  const d = size * (k * sin + cos);
  const dirLen = Math.hypot(a, b);
  const upLen = Math.hypot(c, d);
  const dir: readonly [number, number] = [a / dirLen, b / dirLen];
  const up: readonly [number, number] = [c / upLen, d / upLen];
  // pdf.js measures a vertical item the other way round: `width` is the em ACROSS the column and
  // `height` is the advance DOWN it.
  const width = vertical ? dirLen : advance;
  const height = vertical ? advance : upLen;
  const lean = Math.abs(dir[0] * up[0] + dir[1] * up[1]);
  const reach = vertical ? width * lean + height : width + height * lean;
  // The cross axis is `up` for a horizontal item and `dir` for a vertical one; the step is its
  // perpendicular, scaled so the projection onto the advance axis is exactly `reach`.
  const cross = vertical ? dir : up;
  const denom = dir[0] * up[1] - dir[1] * up[0]; // never 0: the determinant is size^2 > 0
  const alpha = reach / denom;
  const step: readonly [number, number] = [alpha * cross[1], -alpha * cross[0]];
  const items: TextItemLike[] = [];
  for (let i = 0; i < n; i += 1) {
    items.push({
      str: `s${i}`,
      transform: [a, b, c, d, origin[0] + i * step[0], origin[1] + i * step[1]] as Matrix,
      width,
      height,
      ...(vertical ? { vertical: true } : {}),
    });
  }
  return items;
}

/** Whether `outer` covers `inner`, with a slack of one ten-thousandth of a point — far below
 *  anything reportable (boxes are rounded to 2dp downstream) and far above the float error of the
 *  projections involved. */
function covers(outer: Box, inner: Box): boolean {
  const eps = 1e-4;
  return (
    outer.x0 <= inner.x0 + eps &&
    outer.y0 <= inner.y0 + eps &&
    outer.x1 >= inner.x1 - eps &&
    outer.y1 >= inner.y1 - eps
  );
}

describe('mergeTextLines — a merged box covers every item merged into it', () => {
  it('holds over generated rotated, sheared, horizontal and vertical runs — and those runs do merge', () => {
    // The error direction that matters for pdf_geometry is a box that is TOO SMALL: a false
    // negative on "does this text touch that figure". So the property is coverage, asserted
    // directly over generated frames rather than on one hand-built example.
    //
    // Coverage alone would be satisfied vacuously by a rule that never merged anything — a box
    // trivially covers itself — which is exactly the state a vertical line was in before this
    // change. So the merge count is asserted too, per writing mode, as a MINIMUM over the same
    // generated set: on the pre-change code every vertical run comes back as four one-item lines
    // and this fails.
    const degs = [0, 17, 45, 90, 180, 270, 343];
    const shears = [0, 0.25, -0.4];
    const sizes = [1, 9.9632, 24];
    const n = 4;
    let cases = 0;
    const fullyMerged = { horizontal: 0, vertical: 0 };
    for (const deg of degs) {
      for (const k of shears) {
        for (const size of sizes) {
          for (const vertical of [false, true]) {
            const items = contiguousRun({
              deg,
              k,
              size,
              vertical,
              n,
              advance: 3.25 * size,
              origin: [13.5, -7.25],
            });
            const lines = mergeTextLines(items);
            const label = `deg=${deg} k=${k} size=${size} vertical=${vertical}`;
            // Nothing generated here is non-finite, so no item is dropped and the lines partition
            // the items in drawing order: the j-th line consumed the next `items` of them. That
            // reconstruction is what lets the coverage check name the right items per line.
            expect(
              lines.reduce((t, l) => t + l.items, 0),
              label,
            ).toBe(items.length);
            let at = 0;
            for (const line of lines) {
              for (let i = 0; i < line.items; i += 1) {
                const own = mergeTextLines([items[at + i]!])[0]!.box;
                expect(covers(line.box, own), `${label} item ${at + i}`).toBe(true);
              }
              at += line.items;
            }
            if (lines.length === 1 && lines[0]!.items === n) {
              if (vertical) fullyMerged.vertical += 1;
              else fullyMerged.horizontal += 1;
            }
            cases += 1;
          }
        }
      }
    }
    // The generator's own size is asserted, so a truncated or empty sweep cannot make the
    // expectations above vacuous.
    expect(cases).toBe(degs.length * shears.length * sizes.length * 2);
    const perMode = degs.length * shears.length * sizes.length;
    expect(fullyMerged.horizontal).toBe(perMode);
    expect(fullyMerged.vertical).toBe(perMode);
  });
});

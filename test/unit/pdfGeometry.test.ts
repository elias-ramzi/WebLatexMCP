import { describe, it, expect } from 'vitest';
import {
  multiply,
  unitSquareBounds,
  transformedBoxBounds,
  roundBox,
  mergeTextLines,
  IDENTITY,
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

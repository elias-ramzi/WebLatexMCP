import { describe, it, expect } from 'vitest';
import {
  planGeometryPayload,
  boxCost,
  pageSkeletonCost,
  buildGeometryNote,
  GEOMETRY_CONTENT_BUDGET,
  PAGES_ARRAY_JSON_OVERHEAD,
} from '../../src/lib/geometryBudget.js';
import { FLOATS_CONTENT_BUDGET } from '../../src/lib/floatsBudget.js';
import type { GeometryBox, GeometryPage } from '../../src/services/pdfRender.js';

/** A text box shaped exactly as the service emits one. */
function textBox(i: number, label = `line ${i} `.padEnd(160, 'x')): GeometryBox {
  return {
    x0: 72.12,
    y0: 100 + i * 12.5,
    x1: 523.45,
    y1: 110.25 + i * 12.5,
    text: label,
    mergedItems: 7,
  };
}

function imageBox(i: number): GeometryBox {
  return { x0: 72, y0: 50 + i, x1: 300.5, y1: 200.75 + i, source: 'image' };
}

/** A page shaped exactly as the service emits one (GeometryPage), so the skeleton is real. */
function page(n: number, text?: number, images?: number): GeometryPage {
  return {
    page: n,
    pageWidthPt: 612,
    pageHeightPt: 792,
    text: text === undefined ? undefined : Array.from({ length: text }, (_, i) => textBox(i)),
    images:
      images === undefined ? undefined : Array.from({ length: images }, (_, i) => imageBox(i)),
    textOmitted: 0,
    imagesOmitted: 0,
    annotationImagesSkipped: 0,
  };
}

function charged(pages: readonly GeometryPage[], plan: ReturnType<typeof planGeometryPayload>) {
  let total = PAGES_ARRAY_JSON_OVERHEAD;
  pages.forEach((p) => (total += pageSkeletonCost(p)));
  for (const p of plan.pages) {
    for (const b of p.text ?? []) total += boxCost(b);
    for (const b of p.images ?? []) total += boxCost(b);
  }
  return total;
}

describe('GEOMETRY_CONTENT_BUDGET', () => {
  it('is the house figure, imported rather than restated', () => {
    expect(GEOMETRY_CONTENT_BUDGET).toBe(FLOATS_CONTENT_BUDGET);
    expect(GEOMETRY_CONTENT_BUDGET).toBe(20000);
  });
});

describe('planGeometryPayload', () => {
  it('passes a payload that fits through untouched, with zero counters and no note', () => {
    const pages = [page(1, 5, 2), page(2, 3)];
    const plan = planGeometryPayload(pages);
    expect(plan.pages.map((p) => p.text?.length)).toEqual([5, 3]);
    expect(plan.pages.map((p) => p.images?.length)).toEqual([2, undefined]);
    expect(plan.pages.every((p) => p.textOmittedBySize === 0 && p.imagesOmittedBySize === 0)).toBe(
      true,
    );
    expect(plan.note).toBeUndefined();
  });

  it('keeps a list absent when it was not requested, and empty-but-counted when all of it was cut', () => {
    const plan = planGeometryPayload([page(1, 10)], { budget: 200 });
    expect(plan.pages[0]!.images).toBeUndefined();
    expect(plan.pages[0]!.imagesOmittedBySize).toBe(0);
    expect(plan.pages[0]!.text).toEqual([]);
    expect(plan.pages[0]!.textOmittedBySize).toBe(10);
  });

  it('bounds the RENDERED pages array — the accounting is an upper bound, and a tight one', () => {
    const pages = [page(1, 300, 40), page(2, 300, 3), page(3, 300), page(4, 300, 100)];
    const plan = planGeometryPayload(pages);
    const rendered = JSON.stringify(plan.pages).length;
    const accounted = charged(pages, plan);
    // Never low: what ships is at most what was charged, and what was charged fits the budget.
    expect(rendered).toBeLessThanOrEqual(accounted);
    expect(accounted).toBeLessThanOrEqual(GEOMETRY_CONTENT_BUDGET);
    // Never padded into meaninglessness: the over-charge is one comma per array (at most one
    // `pages` array + two lists per page) plus the counter digits charged at their worst case.
    expect(accounted - rendered).toBeLessThanOrEqual(1 + pages.length * (2 + 2 * 3));
    // And the budget is actually used, not left mostly idle.
    expect(rendered).toBeGreaterThan(GEOMETRY_CONTENT_BUDGET - 2 * boxCost(textBox(0)));
  });

  it('charges escaping: a control-character label costs its JSON width, not its length', () => {
    const nasty = textBox(0, '\u0001'.repeat(160));
    expect(boxCost(nasty)).toBe(JSON.stringify(nasty).length + 1);
    expect(boxCost(nasty)).toBeGreaterThan(160 * 6);
    const pages: GeometryPage[] = [{ ...page(1, 0), text: Array(100).fill(nasty) }];
    const plan = planGeometryPayload(pages);
    expect(JSON.stringify(plan.pages).length).toBeLessThanOrEqual(GEOMETRY_CONTENT_BUDGET);
    expect(plan.pages[0]!.textOmittedBySize).toBeGreaterThan(0);
  });

  it('cuts a suffix: the kept boxes are the first ones, in order', () => {
    const pages = [page(1, 300)];
    const plan = planGeometryPayload(pages);
    const kept = plan.pages[0]!.text!;
    expect(kept).toEqual(pages[0]!.text!.slice(0, kept.length));
    expect(kept.length + plan.pages[0]!.textOmittedBySize).toBe(300);
  });

  it('guarantees every page a share: a dense page 1 does not starve pages 2-4', () => {
    const pages = [page(1, 300), page(2, 300), page(3, 300), page(4, 300)];
    const plan = planGeometryPayload(pages);
    const kept = plan.pages.map((p) => p.text!.length);
    // Four equal lanes of one cause: equal shares, to within the couple of boxes the last crumbs
    // of the budget buy in priority order.
    expect(Math.max(...kept) - Math.min(...kept)).toBeLessThanOrEqual(2);
    expect(Math.min(...kept)).toBeGreaterThan(0);
  });

  it('redistributes the surplus a sparse page leaves EQUALLY among the pages that want more', () => {
    // Page 1 is a title page with three lines; pages 2-4 are dense. Page 1's unused share goes
    // to the other three — equally, not all to whichever comes next.
    const pages = [page(1, 3), page(2, 300), page(3, 300), page(4, 300)];
    const plan = planGeometryPayload(pages);
    const kept = plan.pages.map((p) => p.text!.length);
    expect(kept[0]).toBe(3);
    const dense = kept.slice(1);
    expect(Math.max(...dense) - Math.min(...dense)).toBeLessThanOrEqual(2);

    // And each dense page got MORE than the flat four-way share it would have had otherwise.
    const flat = planGeometryPayload([page(1, 300), page(2, 300), page(3, 300), page(4, 300)]);
    expect(Math.min(...dense)).toBeGreaterThan(flat.pages[1]!.text!.length);
  });

  it("funds a page's few image rects inside its own share, and gives the rest to text", () => {
    // The shape of a default call on a real paper: text AND images per page, a few figures.
    const pages = [page(1, 300, 2), page(2, 300, 1), page(3, 300, 0), page(4, 300, 3)];
    const plan = planGeometryPayload(pages);
    expect(plan.pages.map((p) => p.images!.length)).toEqual([2, 1, 0, 3]);
    expect(plan.imagesOmittedBySize).toBe(0);
    const kept = plan.pages.map((p) => p.text!.length);
    // Image lanes' unused share flows back to the text lanes, evenly — never all to page 1.
    expect(Math.max(...kept) - Math.min(...kept)).toBeLessThanOrEqual(2);
  });

  it('bounds the image lane too — it is document-controlled and count-capped only', () => {
    const pages = [
      page(1, undefined, 100),
      page(2, undefined, 100),
      page(3, undefined, 100),
      page(4, undefined, 100),
    ];
    // Large coordinates are finite, so they ship; they widen every box.
    for (const p of pages) {
      p.images = p.images!.map((b) => ({
        ...b,
        x0: 123456789.12,
        x1: 987654321.98,
        unreliableCtm: true,
      }));
    }
    const plan = planGeometryPayload(pages);
    expect(JSON.stringify(plan.pages).length).toBeLessThanOrEqual(GEOMETRY_CONTENT_BUDGET);
    expect(plan.imagesOmittedBySize).toBeGreaterThan(0);
    expect(plan.pages.every((p) => p.images!.length > 0)).toBe(true);
  });

  it('writes a note naming only what was cut, and totals that match the per-page counters', () => {
    const plan = planGeometryPayload([page(1, 300), page(2, 300)]);
    expect(plan.textOmittedBySize).toBe(plan.pages.reduce((n, p) => n + p.textOmittedBySize, 0));
    expect(plan.note).toContain(`${plan.textOmittedBySize} text line(s)`);
    expect(plan.note).not.toContain('image rect');
    expect(plan.note).toContain('textOmittedBySize');
  });
});

describe('buildGeometryNote', () => {
  it('suggests fewer pages when there are several, and fewer kinds when there is one', () => {
    expect(buildGeometryNote(5, 0, 4)).toMatch(/fewer pages/);
    expect(buildGeometryNote(5, 1, 1)).toMatch(/one kind at a time/);
    expect(buildGeometryNote(5, 1, 1)).toMatch(/5 text line\(s\) and 1 image rect\(s\)/);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, cp, rm, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { LatexmkCompiler } from '../../src/services/compiler.js';
import { PdfRenderer, HARD_MAX_EDGE_PX } from '../../src/services/pdfRender.js';

/**
 * Rasterization against a **real** compiled PDF.
 *
 * The unit tests render hand-written PDFs, which proves the geometry but not that a document TeX
 * actually produced comes back as legible pixels. Gated on latexmk like every other smoke here, so
 * it skips in the fast CI job and runs in the dedicated `tex-smoke` one.
 */

const compiler = new LatexmkCompiler();
const available = await compiler.isAvailable();

const FIXTURE = fileURLToPath(new URL('../fixtures/sample-latex', import.meta.url));

/**
 * How many distinct gray levels a PNG contains. A page that rendered nothing is one flat colour;
 * a page with text on it is not. Decoding needs the same native canvas backend the render itself
 * used, so it is certainly present by the time this runs — required through a variable specifier
 * so that a machine without the optional dependency still typechecks.
 */
async function distinctGrays(png: Uint8Array): Promise<number> {
  interface CanvasModule {
    loadImage(src: Uint8Array): Promise<{ width: number; height: number }>;
    createCanvas(
      w: number,
      h: number,
    ): {
      getContext(kind: '2d'): {
        drawImage(img: unknown, x: number, y: number): void;
        getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
      };
    };
  }
  const mod = createRequire(import.meta.url)('@napi-rs/canvas') as CanvasModule;
  const img = await mod.loadImage(png);
  const canvas = mod.createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);
  const seen = new Set<number>();
  for (let i = 0; i < data.length; i += 4) seen.add(data[i] ?? 0);
  return seen.size;
}

describe.skipIf(!available)('render_pages smoke (real latexmk PDF)', () => {
  let dir: string;
  let outDir: string;
  let pdfPath: string;
  let log: string;
  const renderer = new PdfRenderer();

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-render-'));
    outDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-renderout-'));
    await cp(FIXTURE, dir, { recursive: true });
    const outcome = await compiler.compile({ projectDir: dir, rootFile: 'main.tex' });
    expect(outcome.success).toBe(true);
    expect(outcome.pdfPath).toBeDefined();
    pdfPath = outcome.pdfPath!;
    log = outcome.log;
  }, 90_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  it("agrees with the log's own page count", async () => {
    // Two independent sources for the same fact: the count this server reads out of the PDF, and
    // the "Output written on … (N pages" line TeX wrote. If they ever disagree, the number
    // `compile` reports is not the document's.
    //
    // `[\s\S]*?` rather than `.*?` because TeX hard-wraps the log at 79 columns, and the build dir
    // is a temp path long enough to push the "(N pages" onto the next line. That wrap is the whole
    // argument for reading the count from the PDF instead of from here.
    const fromLog = /Output written on [\s\S]*?\((\d+) pages?/.exec(log);
    expect(fromLog).not.toBeNull();
    expect(await renderer.pageCount(pdfPath)).toBe(Number(fromLog![1]));
  });

  it('renders a page that actually has ink on it', async () => {
    const result = await renderer.render({ pdfPath, outDir, pages: [1], maxEdgePx: 800 });

    const page = result.pages[0];
    expect(page).toBeDefined();
    expect(Math.max(page!.widthPx, page!.heightPx)).toBe(800);
    // A4 in points, give or take the class's paper size — the page box is what a figure clipped by
    // its own too-small box shows up in, so it must be a real measurement, not a placeholder.
    expect(page!.pageWidthPt).toBeGreaterThan(100);
    expect(page!.pageHeightPt).toBeGreaterThan(page!.pageWidthPt);
    expect([...page!.png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    // The assertion that separates "rendered" from "wrote a blank canvas".
    expect(await distinctGrays(page!.png)).toBeGreaterThan(1);

    expect(await readdir(outDir)).toContain('page-1.png');
  }, 30_000);

  it('crops to a clip without changing the resolution', async () => {
    const full = await renderer.render({ pdfPath, outDir, pages: [1], dpi: 72 });
    const left = await renderer.render({
      pdfPath,
      outDir,
      pages: [1],
      dpi: 72,
      clip: { x0: 0, y0: 0, x1: 0.5, y1: 1 },
    });

    expect(left.pages[0]!.dpi).toBe(full.pages[0]!.dpi);
    expect(left.pages[0]!.heightPx).toBe(full.pages[0]!.heightPx);
    expect(Math.abs(left.pages[0]!.widthPx - full.pages[0]!.widthPx / 2)).toBeLessThanOrEqual(1);
    // A crop is a separate file, never an overwrite of the full page.
    expect(left.pages[0]!.pngPath).not.toBe(full.pages[0]!.pngPath);
  }, 30_000);

  it('clamps an absurd dpi rather than trying to allocate it', async () => {
    // A 140x100cm poster at 150 dpi is 8268px on its long edge. The cap is what keeps that from
    // becoming a multi-hundred-megabyte canvas; on this small page a very high dpi stands in.
    const result = await renderer.render({ pdfPath, outDir, pages: [1], dpi: 4000 });

    const page = result.pages[0]!;
    expect(page.clamped).toBe(true);
    expect(Math.max(page.widthPx, page.heightPx)).toBe(HARD_MAX_EDGE_PX);
    expect(page.dpi).toBeLessThan(4000);
  }, 60_000);
});

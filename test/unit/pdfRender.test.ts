import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import {
  PdfRenderer,
  PdfRenderError,
  validateClip,
  fitScale,
  effectiveDpi,
  selectPages,
  pngName,
  DEFAULT_MAX_EDGE_PX,
  HARD_MAX_EDGE_PX,
  isNativeCanvasMissing,
  MAX_PAGES_PER_CALL,
} from '../../src/services/pdfRender.js';
import { minimalPdf } from '../helpers/minimalPdf.js';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

describe('PdfRenderer', () => {
  let dir: string;
  let pdfPath: string;
  const renderer = new PdfRenderer();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-pdf-'));
    pdfPath = path.join(dir, 'doc.pdf');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('pageCount', () => {
    it('returns the number of pages in the document', async () => {
      await writeFile(pdfPath, minimalPdf(3));
      await expect(renderer.pageCount(pdfPath)).resolves.toBe(3);
    });

    it('throws a PdfRenderError naming the path for non-PDF bytes', async () => {
      const badPath = path.join(dir, 'not-a.pdf');
      await writeFile(badPath, Buffer.from('this is definitely not a pdf file'));
      let caught: unknown;
      try {
        await renderer.pageCount(badPath);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PdfRenderError);
      expect((caught as PdfRenderError).name).toBe('PdfRenderError');
      expect((caught as Error).message).toContain(badPath);
    });
  });

  describe('render', () => {
    it('writes one PNG per page, in order, with correct bytes/png consistency', async () => {
      await writeFile(pdfPath, minimalPdf(3));
      const outDir = path.join(dir, 'out');
      const result = await renderer.render({ pdfPath, outDir });

      expect(result.pageCount).toBe(3);
      expect(result.pages.map((p) => p.page)).toEqual([1, 2, 3]);
      expect(result.skippedPages).toEqual([]);

      for (const page of result.pages) {
        const onDisk = await readdir(outDir);
        expect(onDisk).toContain(path.basename(page.pngPath));
        expect(Array.from(page.png.slice(0, 4))).toEqual(PNG_MAGIC);
        expect(page.bytes).toBe(page.png.length);
      }
    });

    it('renders only the requested page', async () => {
      await writeFile(pdfPath, minimalPdf(3));
      const outDirPage1 = path.join(dir, 'out1');
      const outDirPage2 = path.join(dir, 'out2');

      const page1Result = await renderer.render({ pdfPath, outDir: outDirPage1, pages: [1] });
      const page2Result = await renderer.render({ pdfPath, outDir: outDirPage2, pages: [2] });

      expect(page2Result.pages).toHaveLength(1);
      const page2 = page2Result.pages[0];
      expect(page2).toBeDefined();
      expect(page2?.pngPath.endsWith('page-2.png')).toBe(true);

      const page1 = page1Result.pages[0];
      expect(page1).toBeDefined();
      expect(Buffer.from(page2!.png).equals(Buffer.from(page1!.png))).toBe(false);
    });

    it('rejects a page number below 1', async () => {
      await writeFile(pdfPath, minimalPdf(3));
      await expect(
        renderer.render({ pdfPath, outDir: path.join(dir, 'out'), pages: [0] }),
      ).rejects.toThrow(PdfRenderError);
    });

    it('rejects a page number above the page count, naming both numbers', async () => {
      await writeFile(pdfPath, minimalPdf(3));
      let caught: unknown;
      try {
        await renderer.render({ pdfPath, outDir: path.join(dir, 'out'), pages: [4] });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PdfRenderError);
      const message = (caught as Error).message;
      expect(message).toContain('4');
      expect(message).toContain('3');
    });

    it('accepts the last valid page number as the boundary just inside', async () => {
      await writeFile(pdfPath, minimalPdf(3));
      const result = await renderer.render({ pdfPath, outDir: path.join(dir, 'out'), pages: [3] });
      expect(result.pages.map((p) => p.page)).toEqual([3]);
    });

    it('caps rendering at MAX_PAGES_PER_CALL and reports the rest as skipped', async () => {
      await writeFile(pdfPath, minimalPdf(10));
      const outDir = path.join(dir, 'out');
      const result = await renderer.render({ pdfPath, outDir });

      expect(result.pages).toHaveLength(MAX_PAGES_PER_CALL);
      expect(result.pages.map((p) => p.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(result.skippedPages).toEqual([9, 10]);

      const onDisk = await readdir(outDir);
      expect(onDisk).toHaveLength(MAX_PAGES_PER_CALL);
    });

    it('collapses duplicate requested pages, keeping first-occurrence order', async () => {
      await writeFile(pdfPath, minimalPdf(3));
      const result = await renderer.render({
        pdfPath,
        outDir: path.join(dir, 'out'),
        pages: [2, 2, 1],
      });
      expect(result.pages.map((p) => p.page)).toEqual([2, 1]);
    });

    it('renders a left-half clip at half the unclipped width, same height, at a fixed dpi', async () => {
      await writeFile(pdfPath, minimalPdf(1, 200, 100));
      const dpi = 144;

      const full = await renderer.render({ pdfPath, outDir: path.join(dir, 'full'), dpi });
      const half = await renderer.render({
        pdfPath,
        outDir: path.join(dir, 'half'),
        dpi,
        clip: { x0: 0, y0: 0, x1: 0.5, y1: 1 },
      });

      const fullPage = full.pages[0];
      const halfPage = half.pages[0];
      expect(fullPage).toBeDefined();
      expect(halfPage).toBeDefined();
      expect(Math.abs(halfPage!.widthPx - fullPage!.widthPx / 2)).toBeLessThanOrEqual(1);
      expect(halfPage!.heightPx).toBe(fullPage!.heightPx);
    });

    it('creates outDir when it does not exist and writes only the expected files inside it', async () => {
      await writeFile(pdfPath, minimalPdf(2));
      const outDir = path.join(dir, 'nested', 'does', 'not', 'exist', 'yet');
      const result = await renderer.render({ pdfPath, outDir });

      const onDisk = await readdir(outDir);
      const expectedNames = new Set(result.pages.map((p) => path.basename(p.pngPath)));
      expect(new Set(onDisk)).toEqual(expectedNames);
      expect(onDisk).toHaveLength(2);
    });

    // A full render writes nothing to stdout, which is this server's JSON-RPC channel. Note what
    // this does and does not pin: it catches any `console.log`/`console.info` reaching stdout from
    // the render path, but it does NOT prove `verbosity: 0` is load-bearing — pdf.js's `info()`
    // only fires at verbosity >= INFOS (5) and the default is WARNINGS (1), while `warn()` goes to
    // console.warn, i.e. stderr. Dropping `verbosity: 0` leaves this test green (verified). It is
    // kept in the service as defence in depth, since anything that raises the verbosity, or a
    // future pdf.js that demotes a message to `info()`, would put bytes on stdout.
    it('never writes to stdout (the JSON-RPC channel)', async () => {
      await writeFile(pdfPath, minimalPdf(2));
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await renderer.render({ pdfPath, outDir: path.join(dir, 'out') });
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('canRasterize', () => {
    it('resolves true on this machine and never throws', async () => {
      let result: boolean | undefined;
      let threw = false;
      try {
        result = await renderer.canRasterize();
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(result).toBe(true);
    });
  });
});

describe('validateClip', () => {
  it('rejects zero width', () => {
    expect(() => validateClip({ x0: 0, y0: 0, x1: 0, y1: 1 })).toThrow(PdfRenderError);
  });

  it('rejects zero height', () => {
    expect(() => validateClip({ x0: 0, y0: 0, x1: 1, y1: 0 })).toThrow(PdfRenderError);
  });

  it('rejects inverted x', () => {
    expect(() => validateClip({ x0: 0.6, y0: 0, x1: 0.5, y1: 1 })).toThrow(PdfRenderError);
  });

  it('rejects x0 below 0', () => {
    expect(() => validateClip({ x0: -0.01, y0: 0, x1: 1, y1: 1 })).toThrow(PdfRenderError);
  });

  it('rejects x1 above 1', () => {
    expect(() => validateClip({ x0: 0, y0: 0, x1: 1.01, y1: 1 })).toThrow(PdfRenderError);
  });

  it('rejects a NaN edge', () => {
    expect(() => validateClip({ x0: 0, y0: NaN, x1: 1, y1: 1 })).toThrow(PdfRenderError);
  });

  it('accepts the full-page boundary', () => {
    expect(() => validateClip({ x0: 0, y0: 0, x1: 1, y1: 1 })).not.toThrow();
  });
});

describe('fitScale', () => {
  it('uses dpi directly when given, unclamped', () => {
    const { scale, clamped } = fitScale(500, 300, { dpi: 144 });
    expect(scale).toBe(2);
    expect(clamped).toBe(false);
  });

  it('derives scale from maxEdgePx over the longest edge when no dpi is given', () => {
    const widthPt = 800;
    const heightPt = 400;
    const { scale, clamped } = fitScale(widthPt, heightPt, {});
    expect(scale).toBeCloseTo(DEFAULT_MAX_EDGE_PX / widthPt, 10);
    expect(clamped).toBe(false);
  });

  it('respects an explicit maxEdgePx', () => {
    const widthPt = 1000;
    const heightPt = 500;
    const maxEdgePx = 2000;
    const { scale, clamped } = fitScale(widthPt, heightPt, { maxEdgePx });
    expect(scale).toBeCloseTo(maxEdgePx / widthPt, 10);
    expect(clamped).toBe(false);
  });

  it('is not clamped when the unclamped scale lands exactly on HARD_MAX_EDGE_PX', () => {
    const longestPt = 1000;
    const { scale, clamped } = fitScale(longestPt, 500, { maxEdgePx: HARD_MAX_EDGE_PX });
    expect(clamped).toBe(false);
    expect(longestPt * scale).toBe(HARD_MAX_EDGE_PX);
  });

  it('clamps when the unclamped scale would land just past HARD_MAX_EDGE_PX', () => {
    const longestPt = 1000;
    const { scale, clamped } = fitScale(longestPt, 500, { maxEdgePx: HARD_MAX_EDGE_PX + 1 });
    expect(clamped).toBe(true);
    expect(longestPt * scale).toBe(HARD_MAX_EDGE_PX);
  });
});

describe('effectiveDpi', () => {
  it('converts scale 2 to 144 dpi', () => {
    expect(effectiveDpi(2)).toBe(144);
  });

  it('rounds a fractional dpi to one decimal place', () => {
    const scale = 1.23456;
    // scale * 72 = 88.88832 -> rounds to 88.9
    expect(effectiveDpi(scale)).toBe(88.9);
  });
});

describe('selectPages', () => {
  it('defaults to every page when none are requested', () => {
    expect(selectPages(undefined, 3)).toEqual({ pages: [1, 2, 3], skipped: [] });
  });

  it('throws naming the offending page and the page count when out of range', () => {
    expect(() => selectPages([4], 3)).toThrow(PdfRenderError);
    try {
      selectPages([4], 3);
      throw new Error('expected selectPages to throw');
    } catch (err) {
      expect((err as Error).message).toContain('4');
      expect((err as Error).message).toContain('3');
    }
  });

  it('throws on a non-integer page', () => {
    expect(() => selectPages([1.5], 3)).toThrow(PdfRenderError);
  });
});

describe('pngName', () => {
  it('produces the unclipped form', () => {
    expect(pngName(3)).toBe('page-3.png');
  });

  it('produces the clipped form with fractions x1000, zero-padded to 4 digits', () => {
    expect(pngName(3, { x0: 0, y0: 0, x1: 0.5, y1: 0.3 })).toBe(
      'page-3-clip-0000-0000-0500-0300.png',
    );
  });

  it('gives two different clips of the same page different names', () => {
    const a = pngName(1, { x0: 0, y0: 0, x1: 0.5, y1: 1 });
    const b = pngName(1, { x0: 0.5, y0: 0, x1: 1, y1: 1 });
    expect(a).not.toBe(b);
  });
});

describe('isNativeCanvasMissing', () => {
  // The backend is load-bearing in two places, and only one of them is obvious. Rendering a page
  // fails with MODULE_NOT_FOUND from pdf.js's own `require('@napi-rs/canvas')`. But *opening* a
  // document fails too, because pdf.js reaches for DOM geometry globals in Node and this backend
  // is what supplies them — so `getDocument` dies on `DOMMatrix is not defined` before any canvas
  // is asked for. Both must be reported as "install the backend", never as a broken PDF, which is
  // what the second case used to look like.
  it('recognizes the module simply not being installed', () => {
    const err = new Error("Cannot find module '@napi-rs/canvas'") as NodeJS.ErrnoException;
    err.code = 'MODULE_NOT_FOUND';
    expect(isNativeCanvasMissing(err)).toBe(true);
  });

  it('recognizes the ESM spelling of the same failure', () => {
    const err = new Error(
      "Cannot find package '@napi-rs/canvas' imported from /app/node_modules/pdfjs-dist/legacy/build/pdf.mjs",
    ) as NodeJS.ErrnoException;
    err.code = 'ERR_MODULE_NOT_FOUND';
    expect(isNativeCanvasMissing(err)).toBe(true);
  });

  it('does not blame the canvas backend when a DIFFERENT module is the one missing', () => {
    // `openDocument` imports pdfjs-dist before anything else, so a broken install of *that*
    // arrives here with the same error code. Telling the user to install @napi-rs/canvas — which
    // is sitting right there — sends them after the wrong package.
    const err = new Error(
      "Cannot find package 'pdfjs-dist' imported from /app/dist/services/",
    ) as NodeJS.ErrnoException;
    err.code = 'ERR_MODULE_NOT_FOUND';
    expect(isNativeCanvasMissing(err)).toBe(false);
  });

  it('recognizes the missing DOM globals that stop a PDF being opened at all', () => {
    expect(isNativeCanvasMissing(new Error('DOMMatrix is not defined'))).toBe(true);
    expect(isNativeCanvasMissing(new Error('ImageData is not defined'))).toBe(true);
    expect(isNativeCanvasMissing(new Error('Path2D is not defined'))).toBe(true);
  });

  it('does not mistake a genuinely broken PDF for a missing backend', () => {
    // The value just outside: a real parse failure must keep its own message, or a corrupt
    // document sends the user off installing a package that is already there.
    expect(isNativeCanvasMissing(new Error('Invalid PDF structure'))).toBe(false);
    expect(isNativeCanvasMissing(new Error('The PDF file is empty'))).toBe(false);
    // Not an Error at all.
    expect(isNativeCanvasMissing('DOMMatrix is not defined')).toBe(false);
  });
});

describe('a machine without the native canvas backend', () => {
  // The case that shipped unpinned the first time. pdf.js needs @napi-rs/canvas for the DOM
  // geometry globals it uses in Node, so with the backend absent it cannot even OPEN a document —
  // it dies on "DOMMatrix is not defined", which reads as a corrupt PDF. These drive the real
  // methods through an injected loader, so deleting the classification in `openDocument`'s catch
  // makes them fail; testing `isNativeCanvasMissing` alone does not.
  const backendMissing = () => {
    throw new Error('DOMMatrix is not defined');
  };

  let dir: string;
  let pdfPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'pdfrender-nocanvas-'));
    pdfPath = path.join(dir, 'doc.pdf');
    await writeFile(pdfPath, minimalPdf(2));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('tells pageCount callers to install the backend, not that the PDF is broken', async () => {
    const renderer = new PdfRenderer(backendMissing);
    await expect(renderer.pageCount(pdfPath)).rejects.toThrow(/@napi-rs\/canvas/);
    // The failure it must NOT be reported as: the document is perfectly valid.
    await expect(renderer.pageCount(pdfPath)).rejects.not.toThrow(/Failed to open PDF/);
  });

  it('tells render callers the same thing', async () => {
    const renderer = new PdfRenderer(backendMissing);
    await expect(
      renderer.render({ pdfPath, outDir: path.join(dir, 'out'), pages: [1] }),
    ).rejects.toThrow(/@napi-rs\/canvas/);
  });

  it('still reports a genuinely broken PDF as a broken PDF', async () => {
    // The value just outside: with a working loader, a bad document keeps its own message rather
    // than being blamed on a missing package.
    const broken = path.join(dir, 'broken.pdf');
    await writeFile(broken, Buffer.from('%PDF-1.4\nnot a pdf\n', 'latin1'));
    const renderer = new PdfRenderer();
    await expect(renderer.pageCount(broken)).rejects.not.toThrow(/@napi-rs\/canvas/);
  });

  it('reports canRasterize false rather than throwing', async () => {
    await expect(new PdfRenderer(backendMissing).canRasterize()).resolves.toBe(false);
  });
});

describe('fitScale precedence', () => {
  it('lets dpi beat maxEdgePx when both are given', () => {
    // The documented rule — "dpi sets the scale directly and beats maxEdgePx" — is stated in the
    // tool description, docs/tools.md and the CHANGELOG, and every other test passes exactly one
    // of the two knobs. Without this case the precedence could be inverted and stay green.
    const { scale, clamped } = fitScale(1000, 500, { dpi: 144, maxEdgePx: 200 });
    expect(scale).toBe(2); // 144/72, not 200/1000
    expect(clamped).toBe(false);
  });

  it('still applies the hard cap when dpi asks for more than it allows', () => {
    // dpi wins over maxEdgePx, but not over the 4000px ceiling.
    const { scale, clamped } = fitScale(1000, 500, { dpi: 7200, maxEdgePx: 200 });
    expect(clamped).toBe(true);
    expect(1000 * scale).toBe(HARD_MAX_EDGE_PX);
  });
});

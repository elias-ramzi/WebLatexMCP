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
  installDomMatrixStub,
  nativeCanvasLoadable,
  createCanvasProbe,
  createPdfjsLoader,
  MAX_PAGES_PER_CALL,
  MAX_GEOMETRY_PAGES,
  MAX_TEXT_LINES_PER_PAGE,
  MAX_IMAGE_RECTS_PER_PAGE,
  MAX_TEXT_PAGES,
} from '../../src/services/pdfRender.js';
import type { PdfjsLoader } from '../../src/services/pdfRender.js';
import { planExtractedText } from '../../src/lib/extractTextBudget.js';
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
  it('keeps the plain name for a default render: no clip, no dpi, no maxEdgePx', () => {
    expect(pngName(3)).toBe('page-3.png');
  });

  it('names a clipped render page-N-<hash>.png — readable, and nothing illegal on Windows', () => {
    expect(pngName(3, { x0: 0, y0: 0, x1: 0.5, y1: 0.3 })).toMatch(/^page-3-[0-9a-f]{12}\.png$/);
  });

  it('is deterministic: the same request names the same file', () => {
    const clip = { x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.9 };
    expect(pngName(2, clip, { dpi: 150 })).toBe(pngName(2, { ...clip }, { dpi: 150 }));
  });

  it('gives two different clips of the same page different names', () => {
    const a = pngName(1, { x0: 0, y0: 0, x1: 0.5, y1: 1 });
    const b = pngName(1, { x0: 0.5, y0: 0, x1: 1, y1: 1 });
    expect(a).not.toBe(b);
  });

  // The build dir is shared across sessions, so a name two different renders share is an earlier
  // result's pngPath silently naming a later image. Rounding the clip to three decimals did that
  // for any two crops closer than 0.0005, and leaving the scale out did it for every dpi.
  it('gives clips that differ by less than 0.0005 different names', () => {
    const a = pngName(1, { x0: 0.2, y0: 0.2, x1: 0.2001, y1: 0.2001 });
    const b = pngName(1, { x0: 0.2, y0: 0.2, x1: 0.2002, y1: 0.2002 });
    expect(a).not.toBe(b);
  });

  it('gives two renders of one page at different dpi different names, clipped or not', () => {
    expect(pngName(1, undefined, { dpi: 72 })).not.toBe(pngName(1, undefined, { dpi: 300 }));
    expect(pngName(1, undefined, { dpi: 72 })).not.toBe(pngName(1));
    const clip = { x0: 0, y0: 0, x1: 0.5, y1: 0.5 };
    expect(pngName(1, clip, { dpi: 72 })).not.toBe(pngName(1, clip, { dpi: 300 }));
  });

  it('gives two renders of one page at different maxEdgePx different names', () => {
    expect(pngName(1, undefined, { maxEdgePx: 800 })).not.toBe(
      pngName(1, undefined, { maxEdgePx: 1200 }),
    );
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
  // What the backend is still needed for, and what it is not. Only RASTERIZING needs it: pdf.js
  // used to need it just to be imported (a module-scope `new DOMMatrix()`), which the default
  // loader now stubs — pinned for real, in a fresh process with the backend hidden, by
  // test/integration/pdfWithoutCanvas.test.ts, since this process imported pdf.js long ago with the
  // backend present. What this block pins is the classification: which failure is reported as
  // what, driven through the real methods via the injectable loader and canvas probe.
  const domGlobalMissing = () => {
    throw new Error('DOMMatrix is not defined');
  };
  // The Claude Desktop extension's failure, verbatim in shape: `.mcpbignore` once dropped pdf.js's
  // legacy Node build, so the import itself found nothing.
  const pdfjsModuleMissing = () => {
    const err = new Error(
      "Cannot find module '/bundle/node_modules/pdfjs-dist/legacy/build/pdf.mjs' imported from " +
        '/bundle/dist/services/pdfRender.js',
    ) as NodeJS.ErrnoException;
    err.code = 'ERR_MODULE_NOT_FOUND';
    throw err;
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

  it('refuses render up front, naming the Desktop extension and not only `npm i`', async () => {
    let loads = 0;
    const renderer = new PdfRenderer(
      async () => {
        loads += 1;
        return (await import('pdfjs-dist/legacy/build/pdf.mjs')) as never;
      },
      () => false,
    );
    const err = await renderer
      .render({ pdfPath, outDir: path.join(dir, 'out'), pages: [1] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfRenderError);
    const message = (err as Error).message;
    expect(message).toMatch(/@napi-rs\/canvas/);
    expect(message).toMatch(/render_pages/);
    // `npm i` means nothing inside a Desktop extension, whose bundle can never carry the binary.
    expect(message).toMatch(/Desktop extension/);
    // ...and the tools that DO work without it are not dragged down with it.
    expect(message).not.toMatch(/extract_text and \/PageLabels reading need it/);
    // Refused before any work — nothing opened, nothing written. pdf.js is LOADED once (to tell a
    // missing canvas from a missing pdf.js, which the canvas probe cannot), but no document is.
    expect(loads).toBe(1);
    await expect(readdir(dir)).resolves.toEqual(['doc.pdf']);
  });

  it('tells a user whose backend IS installed to restart, since the refusal outlives the cause', async () => {
    // The canvas probe keeps a definitive "no" for the life of the process, and pins "no" once the
    // DOMMatrix stub went in after a transient load failure — pdf.js was imported over the stub
    // and cannot use a backend that loads later. So a user who installs the package, or who hit
    // an EMFILE, stays refused until a restart, and "install @napi-rs/canvas" alone sends them to
    // install what is already there.
    const renderer = new PdfRenderer(
      async () => (await import('pdfjs-dist/legacy/build/pdf.mjs')) as never,
      () => false,
    );
    const err = await renderer
      .render({ pdfPath, outDir: path.join(dir, 'out'), pages: [1] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfRenderError);
    expect((err as Error).message).toMatch(/already installed[^.]*restart the server/);
  });

  it('names pdf.js, not the canvas, when render finds pdf.js itself unusable', async () => {
    // The default canvas probe resolves @napi-rs/canvas from pdf.js's own location, so a missing
    // pdfjs-dist reads as "no canvas" too. Refusing with the canvas message then sends the user to
    // install a package that is already there — the same wrong-package failure
    // `isNativeCanvasMissing` is keyed narrowly to avoid.
    const renderer = new PdfRenderer(pdfjsModuleMissing, () => false);
    const err = await renderer
      .render({ pdfPath, outDir: path.join(dir, 'out'), pages: [1] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfRenderError);
    const message = (err as Error).message;
    expect(message).toMatch(/pdfjs-dist/);
    expect(message).toMatch(/not a problem with the document/);
    expect(message).not.toMatch(/@napi-rs\/canvas/);
    await expect(readdir(dir)).resolves.toEqual(['doc.pdf']);
  });

  it('reads page counts regardless of the canvas probe', async () => {
    // The probe gates rasterizing only. Wired into pageCount by mistake, it would take compile's
    // pageCount down on every Desktop install again.
    const renderer = new PdfRenderer(undefined, () => false);
    await expect(renderer.pageCount(pdfPath)).resolves.toBe(2);
  });

  it('reports a missing pdf.js module as a broken install, not a broken PDF or a missing canvas', async () => {
    const renderer = new PdfRenderer(pdfjsModuleMissing);
    const err = await renderer.pageCount(pdfPath).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfRenderError);
    const message = (err as Error).message;
    expect(message).not.toMatch(/Failed to open PDF/);
    expect(message).toMatch(/pdfjs-dist/);
    expect(message).toMatch(/not a problem with the document/);
    // The canvas is a separate, optional package this failure says nothing about.
    expect(message).not.toMatch(/@napi-rs\/canvas/);
  });

  it('still points a missing DOM global at the backend, and still not at the PDF', async () => {
    const renderer = new PdfRenderer(domGlobalMissing);
    const err = await renderer.pageCount(pdfPath).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/@napi-rs\/canvas/);
    expect((err as Error).message).not.toMatch(/Failed to open PDF/);
  });

  it('still reports a genuinely broken PDF as a broken PDF', async () => {
    // The value just outside: with a working loader, a bad document keeps its own message rather
    // than being blamed on a missing package.
    const broken = path.join(dir, 'broken.pdf');
    await writeFile(broken, Buffer.from('%PDF-1.4\nnot a pdf\n', 'latin1'));
    const renderer = new PdfRenderer();
    const err = await renderer.pageCount(broken).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/Failed to open PDF/);
    expect((err as Error).message).not.toMatch(/@napi-rs\/canvas|pdfjs-dist/);
  });

  it('reports canRasterize false rather than throwing', async () => {
    await expect(new PdfRenderer(domGlobalMissing).canRasterize()).resolves.toBe(false);
  });

  describe('canReadPdf', () => {
    it('answers ok on this machine', async () => {
      await expect(new PdfRenderer().canReadPdf()).resolves.toEqual({ ok: true });
    });

    it('answers ok without the canvas — reading needs none', async () => {
      await expect(new PdfRenderer(undefined, () => false).canReadPdf()).resolves.toEqual({
        ok: true,
      });
    });

    it('carries the loader failure rather than throwing', async () => {
      const answer = await new PdfRenderer(pdfjsModuleMissing).canReadPdf();
      expect(answer.ok).toBe(false);
      expect(answer.ok === false && answer.error).toMatch(/pdfjs-dist/);
    });
  });
});

describe('installDomMatrixStub', () => {
  it('installs a stub when the backend does not load and nothing defines the global', () => {
    const globals: { DOMMatrix?: unknown } = {};
    expect(installDomMatrixStub(() => false, globals)).toBe(true);
    // pdf.js's module scope does exactly this; it must not throw.
    const Ctor = globals.DOMMatrix as new () => unknown;
    expect(() => new Ctor()).not.toThrow();
  });

  it('leaves the global to pdf.js when the backend loads', () => {
    // With the backend present pdf.js installs the REAL DOMMatrix; a stub there would shadow it
    // and break rasterizing.
    const globals: { DOMMatrix?: unknown } = {};
    expect(installDomMatrixStub(() => true, globals)).toBe(false);
    expect(globals.DOMMatrix).toBeUndefined();
  });

  it('never replaces a DOMMatrix something else already defined', () => {
    let probed = false;
    const existing = class {};
    const globals: { DOMMatrix?: unknown } = { DOMMatrix: existing };
    expect(
      installDomMatrixStub(() => {
        probed = true;
        return false;
      }, globals),
    ).toBe(false);
    expect(globals.DOMMatrix).toBe(existing);
    // Short-circuits before loading a native module it has no use for.
    expect(probed).toBe(false);
  });
});

describe('nativeCanvasLoadable', () => {
  it('finds the backend on this machine, where it is installed', () => {
    // Every CI platform installs the optional dependency; the render tests above depend on it.
    expect(nativeCanvasLoadable()).toBe(true);
  });
});

describe('createCanvasProbe', () => {
  const errno = (message: string, code: string): Error =>
    Object.assign(new Error(message), { code });

  it('remembers a definitive "not installed" and does not load again', () => {
    let loads = 0;
    const probe = createCanvasProbe(() => {
      loads += 1;
      throw errno("Cannot find module '@napi-rs/canvas'", 'MODULE_NOT_FOUND');
    });
    expect(probe.loadable()).toBe(false);
    expect(probe.loadable()).toBe(false);
    expect(loads).toBe(1);
  });

  it('remembers a missing per-platform binary as definitive too', () => {
    let loads = 0;
    const probe = createCanvasProbe(() => {
      loads += 1;
      throw new Error('Cannot find native binding. npm has a bug related to optional dependencies');
    });
    expect(probe.loadable()).toBe(false);
    expect(probe.loadable()).toBe(false);
    expect(loads).toBe(1);
  });

  it('does not cache a transient failure, so a later call can still succeed', () => {
    // EMFILE under fd pressure says nothing about whether the backend is installed; caching it
    // disabled render_pages for the rest of the process.
    let loads = 0;
    const probe = createCanvasProbe(() => {
      loads += 1;
      if (loads === 1) throw errno('EMFILE: too many open files', 'EMFILE');
    });
    expect(probe.loadable()).toBe(false);
    expect(probe.loadable()).toBe(true);
    expect(probe.loadable()).toBe(true);
    expect(loads).toBe(2);
  });

  it('finds a transient errno anywhere in the cause chain (the napi-rs loader wraps it)', () => {
    let loads = 0;
    const probe = createCanvasProbe(() => {
      loads += 1;
      if (loads === 1) {
        throw new Error('Cannot find native binding.', {
          cause: new Error('libcanvas.node: cannot open shared object file: Too many open files'),
        });
      }
    });
    expect(probe.loadable()).toBe(false);
    expect(probe.loadable()).toBe(true);
  });

  it('stays unavailable once pinned, even if the backend would now load', () => {
    // Pinned when the DOMMatrix stub was installed: pdf.js only polyfills DOMMatrix when the
    // global is undefined, and built its module-scope matrix from the stub, so a real canvas loaded
    // afterwards would rasterize against an inert matrix.
    let loads = 0;
    const probe = createCanvasProbe(() => {
      loads += 1;
    });
    probe.pinUnavailable();
    expect(probe.loadable()).toBe(false);
    expect(loads).toBe(0);
  });
});

describe('createPdfjsLoader', () => {
  it('pins the probe unavailable when it installs the DOMMatrix stub after a transient failure', async () => {
    let loads = 0;
    const probe = createCanvasProbe(() => {
      loads += 1;
      if (loads === 1) {
        throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      }
    });
    const globals: { DOMMatrix?: unknown } = {};
    const fake = { OPS: {} } as never;
    const load = createPdfjsLoader(probe, async () => fake, globals);
    await expect(load()).resolves.toBe(fake);
    expect(globals.DOMMatrix).toBeDefined();
    // The transient failure alone would have let the next call succeed; the stub forbids it.
    expect(probe.loadable()).toBe(false);
    expect(loads).toBe(1);
  });

  it('leaves the probe alone when the backend loads and no stub is installed', async () => {
    const probe = createCanvasProbe(() => undefined);
    const globals: { DOMMatrix?: unknown } = {};
    const load = createPdfjsLoader(probe, async () => ({ OPS: {} }) as never, globals);
    await load();
    expect(globals.DOMMatrix).toBeUndefined();
    expect(probe.loadable()).toBe(true);
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

// The op codes `geometry` looks for. Arbitrary but distinct numbers, playing the role of pdf.js's
// real OPS table — the geometry walk never hardcodes these values, only reads them off the loaded
// module, so a fake with different numbers still proves the walk is driven by the table.
const FAKE_OPS = {
  save: 101,
  restore: 102,
  transform: 103,
  paintImageXObject: 104,
  paintImageMaskXObject: 105,
  paintFormXObjectBegin: 106,
  paintFormXObjectEnd: 107,
  beginGroup: 108,
  endGroup: 109,
  beginAnnotation: 110,
  endAnnotation: 111,
  paintInlineImageXObject: 112,
  paintSolidColorImageMask: 113,
};

interface FakeTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  /** The key into `FakePage.styles`, as pdf.js's own items carry (its internal loaded name,
   *  `g_d0_f1`, not the document's `/F1`). Optional: an item without one gets no font metrics,
   *  which is what every pre-existing case in this file exercises. */
  fontName?: string;
}

/** One entry of `getTextContent()`'s `styles` map. Every field optional for the same reason the
 *  service's own type has them optional: pdf.js reports `ascent: NaN` for Symbol/ZapfDingbats
 *  and omits it entirely for a font it could not translate. */
interface FakeTextStyle {
  ascent?: number;
  descent?: number;
  vertical?: boolean;
  fontFamily?: string;
}

interface FakeViewport {
  width: number;
  height: number;
  transform: number[];
}

interface FakePage {
  viewport: FakeViewport;
  textItems?: FakeTextItem[];
  /** Left undefined by every pre-existing case, which is itself a case worth keeping: a content
   *  object with no `styles` map at all must produce exactly the boxes it always did. */
  styles?: Record<string, FakeTextStyle>;
  fnArray?: number[];
  argsArray?: unknown[][];
}

/**
 * A viewport with no rotation and a MediaBox at the origin — the identity case, where the
 * viewport transform is exactly the old manual y-flip (`[1,0,0,-1,0,height]`; verified against
 * pdf.js's `PageViewport` constructor). Every pre-existing test in this file uses this, so none of
 * their expected numbers change under the FIX2 rewrite (geometryForPage/walkImageGeometry now
 * compose through `viewport.transform` instead of calling a manual `toTopLeft`).
 */
function idViewport(width: number, height: number): FakeViewport {
  return { width, height, transform: [1, 0, 0, -1, 0, height] };
}

/** Build a PdfjsLoader whose document has one page per entry in `pages`, driven by FAKE_OPS. */
function fakeGeometryLoader(pages: FakePage[]): PdfjsLoader {
  return (async () => ({
    OPS: FAKE_OPS,
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pages.length,
        canvasFactory: {},
        getPage: (n: number) => {
          const p = pages[n - 1];
          if (!p) throw new Error(`no such fake page ${n}`);
          return Promise.resolve({
            getViewport: () => p.viewport,
            render: () => ({ promise: Promise.resolve() }),
            cleanup: () => {},
            getTextContent: () =>
              Promise.resolve({
                items: (p.textItems ?? []) as unknown[],
                ...(p.styles === undefined ? {} : { styles: p.styles }),
              }),
            getOperatorList: () =>
              Promise.resolve({ fnArray: p.fnArray ?? [], argsArray: p.argsArray ?? [] }),
          });
        },
      }),
      destroy: () => Promise.resolve(),
    }),
  })) as unknown as PdfjsLoader;
}

describe('PdfRenderer.geometry', () => {
  let dir: string;
  let pdfPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-geom-'));
    // openDocument reads real bytes off disk before ever calling the injected loader — the fake
    // loader ignores their content, so any non-empty file works.
    pdfPath = path.join(dir, 'doc.pdf');
    await writeFile(pdfPath, minimalPdf(1));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('maps text items to merged, top-left, rounded boxes for the requested page', async () => {
    const renderer = new PdfRenderer(
      fakeGeometryLoader([
        {
          viewport: idViewport(600, 800),
          textItems: [
            { str: 'Hello ', transform: [1, 0, 0, 1, 10, 700], width: 40, height: 10 },
            { str: 'world', transform: [1, 0, 0, 1, 50, 700], width: 30, height: 10 },
          ],
        },
      ]),
    );

    const result = await renderer.geometry({ pdfPath, kinds: ['text'] });
    expect(result.pages).toHaveLength(1);
    const page = result.pages[0]!;
    expect(page.pageWidthPt).toBe(600);
    expect(page.pageHeightPt).toBe(800);
    expect(page.images).toBeUndefined();
    expect(page.imagesOmitted).toBe(0);
    expect(page.text).toHaveLength(1);
    // User space box was {x0:10,y0:700,x1:80,y1:710}; flipped to top-left at pageHeight 800:
    // y0' = 800-710=90, y1'=800-700=100.
    expect(page.text![0]).toEqual({
      x0: 10,
      y0: 90,
      x1: 80,
      y1: 100,
      text: 'Hello world',
      mergedItems: 2,
    });
  });

  it('walks save/transform/paintImageXObject/restore to the right rectangle, and restore pops', async () => {
    const renderer = new PdfRenderer(
      fakeGeometryLoader([
        {
          viewport: idViewport(200, 100),
          fnArray: [
            FAKE_OPS.save,
            FAKE_OPS.transform,
            FAKE_OPS.paintImageXObject,
            FAKE_OPS.restore,
            FAKE_OPS.paintImageXObject,
          ],
          argsArray: [
            [],
            [2, 0, 0, 2, 0, 0], // scale by 2 inside the save/restore pair
            ['img1', 10, 10],
            [],
            ['img2', 10, 10],
          ],
        },
      ]),
    );

    const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
    const page = result.pages[0]!;
    expect(page.text).toBeUndefined();
    expect(page.images).toHaveLength(2);
    // Inside the save/restore: CTM is scale-by-2, so the unit square -> [0,0]-[2,2] in user
    // space, flipped to top-left at pageHeight 100: y0'=98, y1'=100.
    expect(page.images![0]).toEqual({ x0: 0, y0: 98, x1: 2, y1: 100, source: 'image' });
    // After restore: CTM is back to identity — the outer matrix, NOT the inner scale-by-2. This
    // is the assertion that pins CTM stack tracking: without a working pop, this would equal the
    // first box instead of the identity-unit-square box.
    expect(page.images![1]).toEqual({ x0: 0, y0: 99, x1: 1, y1: 100, source: 'image' });
    expect(page.images![0]).not.toEqual(page.images![1]);
  });

  it('does not throw when restore runs against an empty CTM stack', async () => {
    const renderer = new PdfRenderer(
      fakeGeometryLoader([
        {
          viewport: idViewport(100, 100),
          fnArray: [FAKE_OPS.restore, FAKE_OPS.paintImageXObject],
          argsArray: [[], ['img', 1, 1]],
        },
      ]),
    );

    const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
    const page = result.pages[0]!;
    // The bogus leading restore left the CTM at identity (nothing to pop), so the image still
    // reports the identity-unit-square box rather than the call throwing.
    expect(page.images).toEqual([{ x0: 0, y0: 99, x1: 1, y1: 100, source: 'image' }]);
  });

  it('resolves a form XObject placement using its own /BBox when one is given', async () => {
    const renderer = new PdfRenderer(
      fakeGeometryLoader([
        {
          viewport: idViewport(200, 200),
          fnArray: [FAKE_OPS.paintFormXObjectBegin, FAKE_OPS.paintFormXObjectEnd],
          argsArray: [[null, [5, 5, 25, 15]], []],
        },
      ]),
    );

    const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
    const page = result.pages[0]!;
    expect(page.images).toEqual([{ x0: 5, y0: 185, x1: 25, y1: 195, source: 'form' }]);
  });

  // A transparency-group form XObject reports `paintFormXObjectBegin`'s own bbox arg as null —
  // the real bbox moves onto an `OPS.beginGroup` emitted immediately before it instead (verified
  // against pdfjs-dist 6.1.200's `buildFormXObject`). Before FIX1 this fell back to the ~1x1
  // unit-square approximation, silently reporting a figure's placement as a ~2pt box.
  describe('a transparency-group form XObject (beginGroup/endGroup)', () => {
    it('uses the group bbox under the CTM, not the unit-square fallback', async () => {
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(400, 300),
            fnArray: [
              FAKE_OPS.beginGroup,
              FAKE_OPS.paintFormXObjectBegin,
              FAKE_OPS.paintFormXObjectEnd,
              FAKE_OPS.endGroup,
            ],
            argsArray: [
              [{ bbox: [0, 0, 56, 28], matrix: null }],
              [null, null], // the form's own bbox arg is null — grouped
              [],
              [{ bbox: [0, 0, 56, 28], matrix: null }],
            ],
          },
        ]),
      );

      const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
      const page = result.pages[0]!;
      // Watched failing on the pre-fix code: it reported the identity-unit-square fallback
      // ({x0:0,y0:299,x1:1,y1:300}) instead of the real 56x28 group bbox.
      expect(page.images).toEqual([{ x0: 0, y0: 272, x1: 56, y1: 300, source: 'form' }]);
    });

    it('still lets an explicit form bbox win over a pending group bbox', async () => {
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(200, 200),
            fnArray: [
              FAKE_OPS.beginGroup,
              FAKE_OPS.paintFormXObjectBegin,
              FAKE_OPS.paintFormXObjectEnd,
              FAKE_OPS.endGroup,
            ],
            argsArray: [
              [{ bbox: [0, 0, 56, 28], matrix: null }],
              [null, [5, 5, 25, 15]], // explicit form bbox present despite a pending group bbox
              [],
              [{ bbox: [0, 0, 56, 28], matrix: null }],
            ],
          },
        ]),
      );

      const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
      const page = result.pages[0]!;
      expect(page.images).toEqual([{ x0: 5, y0: 185, x1: 25, y1: 195, source: 'form' }]);
    });

    // Finding 2: every other beginGroup fixture in this file passes `matrix: null`, so
    // `multiply(pending.matrix, pending.ctm)` is never exercised — a reversed composition
    // (`multiply(pending.ctm, pending.matrix)`) would silently misplace the box and nothing here
    // would catch it. This is the discriminating case: a non-null group matrix under a
    // non-identity CTM at beginGroup time.
    it('composes a non-null group matrix with the CTM at beginGroup time in the documented order', async () => {
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(200, 200),
            fnArray: [
              FAKE_OPS.transform, // establishes a non-identity CTM before beginGroup runs
              FAKE_OPS.beginGroup,
              FAKE_OPS.paintFormXObjectBegin,
              FAKE_OPS.paintFormXObjectEnd,
              FAKE_OPS.endGroup,
            ],
            argsArray: [
              [1, 0, 0, 1, 100, 50],
              [{ bbox: [0, 0, 10, 10], matrix: [2, 0, 0, 3, 5, 7] }],
              [null, null], // the form's own bbox arg is null — grouped
              [],
              [],
            ],
          },
        ]),
      );

      const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
      const page = result.pages[0]!;
      // ctm = multiply([2,0,0,3,5,7], [1,0,0,1,100,50]) = [2,0,0,3,105,57]; bbox [0,0,10,10]
      // under that ctm is user-space [105,57]-[125,87]; through idViewport(200,200)'s
      // [1,0,0,-1,0,200] that is [105,113]-[125,143]. The reversed composition
      // multiply([1,0,0,1,100,50], [2,0,0,3,5,7]) = [2,0,0,3,205,157] instead, which would have
      // produced a box offset by (100,100) from this one.
      expect(page.images).toEqual([{ x0: 105, y0: 113, x1: 125, y1: 143, source: 'form' }]);
    });

    it('never lets a pending group bbox leak onto a second, later form that has neither', async () => {
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(400, 300),
            fnArray: [
              FAKE_OPS.beginGroup,
              FAKE_OPS.paintFormXObjectBegin,
              FAKE_OPS.paintFormXObjectEnd,
              FAKE_OPS.endGroup,
              FAKE_OPS.paintFormXObjectBegin, // a second, unrelated, ungrouped form
              FAKE_OPS.paintFormXObjectEnd,
            ],
            argsArray: [
              [{ bbox: [0, 0, 56, 28], matrix: null }],
              [null, null],
              [],
              [{ bbox: [0, 0, 56, 28], matrix: null }],
              [null, null],
              [],
            ],
          },
        ]),
      );

      const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
      const page = result.pages[0]!;
      expect(page.images).toHaveLength(2);
      expect(page.images![0]).toEqual({ x0: 0, y0: 272, x1: 56, y1: 300, source: 'form' });
      // The second form has no own bbox and no live pending group bbox (consumed by the first
      // paintFormXObjectBegin, and cleared again defensively at endGroup) — it must fall back to
      // the flagged unit-square approximation, never reuse the first form's group bbox.
      expect(page.images![1]).toEqual({
        x0: 0,
        y0: 299,
        x1: 1,
        y1: 300,
        source: 'form',
        approximate: true,
      });
    });
  });

  // Finding 1: a document-controlled operand (a hand-built content stream, not anything pdf.js
  // itself validates for finiteness) can overflow a `cm`/`/Matrix` multiply to Infinity/NaN. Left
  // unguarded, that poisons the walk's own CTM for the rest of the page, and any box built from it
  // fails the tool's zod `z.number()` schema *after* the handler returns — outside its try/catch,
  // so the error is neither scrubbed nor does it leave the rest of the page's geometry intact.
  describe('a document-controlled CTM/bbox that overflows to a non-finite value', () => {
    it('keeps the last good CTM (and emits no non-finite box) when a transform operand overflows', async () => {
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(100, 100),
            fnArray: [FAKE_OPS.transform, FAKE_OPS.paintImageXObject],
            argsArray: [
              // Overflows to Infinity; the multiply than mixes in 0*Infinity = NaN in other slots.
              [Number.MAX_VALUE * 10, 0, 0, 1, 0, 0],
              ['img', 1, 1],
            ],
          },
        ]),
      );

      const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
      const page = result.pages[0]!;
      // Watched failing pre-fix: the poisoned CTM propagated non-finite values into the box, so
      // the returned rect did not equal the identity-unit-square box below (a NaN component
      // instead of one of 0/1/99/100).
      //
      // The coordinates are unchanged by #80 §2 — keeping the last known-good CTM is still the
      // right call — but they no longer come back bare: this box IS one measured under a refused
      // transform, so it now says so. That flag is the whole of §2; see the `unreliableCtm`
      // describe block below for what it is and is not.
      expect(page.images).toEqual([
        { x0: 0, y0: 99, x1: 1, y1: 100, source: 'image', unreliableCtm: true },
      ]);
      for (const box of page.images ?? []) {
        expect(Number.isFinite(box.x0)).toBe(true);
        expect(Number.isFinite(box.y0)).toBe(true);
        expect(Number.isFinite(box.x1)).toBe(true);
        expect(Number.isFinite(box.y1)).toBe(true);
      }
    });

    it('drops a text line outright (never counted into textOmitted) when an item carries a non-finite width, without dropping an unrelated good line', async () => {
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(200, 200),
            textItems: [
              { str: 'Good', transform: [1, 0, 0, 1, 0, 100], width: 30, height: 10 },
              // On its own baseline (far from 'Good'), so it cannot merge into 'Good's line —
              // isolates the "drop the poisoned line, keep everything else" guarantee.
              { str: 'Bad', transform: [1, 0, 0, 1, 0, 50], width: Infinity, height: 10 },
            ],
          },
        ]),
      );

      const result = await renderer.geometry({ pdfPath, kinds: ['text'] });
      const page = result.pages[0]!;
      // Watched failing pre-fix: page.text had 2 entries, and the 'Bad' one carried an Infinity
      // edge — rejected by the tool's z.number() schema AFTER the handler returns, outside
      // errorResult, failing the whole call and discarding every other page's geometry with it.
      expect(page.text).toHaveLength(1);
      expect(page.text![0]?.text).toBe('Good');
      // Mirrors imagesOmitted: a dropped non-finite line is never counted as "omitted" — that
      // count is reserved for lines cut by the per-page cap.
      expect(page.textOmitted).toBe(0);
      for (const box of page.text ?? []) {
        expect(Number.isFinite(box.x0)).toBe(true);
        expect(Number.isFinite(box.y0)).toBe(true);
        expect(Number.isFinite(box.x1)).toBe(true);
        expect(Number.isFinite(box.y1)).toBe(true);
      }
    });

    it('drops a text line whose box only overflows to non-finite AFTER the viewport-transform mapping (service-level filter, distinct from the pdfGeometry.ts item guard)', async () => {
      // Item geometry alone is finite (Number.MAX_VALUE is a finite double), so pdfGeometry.ts's
      // mergeTextLines never sees a non-finite box here and does not drop it — this isolates the
      // pdfRender.ts-level filter on the *mapped* box, which is a separate place a finite
      // user-space box can still overflow: a custom, non-unit-scale viewport transform (a=2 here)
      // multiplies it past Number.MAX_VALUE to Infinity.
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: { width: 100, height: 200, transform: [2, 0, 0, -1, 0, 200] },
            textItems: [
              { str: 'Huge', transform: [1, 0, 0, 1, Number.MAX_VALUE, 7], width: 20, height: 10 },
              { str: 'Good', transform: [1, 0, 0, 1, 0, 50], width: 20, height: 10 },
            ],
          },
        ]),
      );

      const result = await renderer.geometry({ pdfPath, kinds: ['text'] });
      const page = result.pages[0]!;
      // Watched failing pre-fix: page.text had 2 entries, the 'Huge' one carrying an Infinity
      // edge (Number.MAX_VALUE * 2 overflows) that the pdfGeometry.ts-level guard cannot catch,
      // since it only ever sees the pre-viewport-transform user-space box.
      expect(page.text).toHaveLength(1);
      expect(page.text![0]?.text).toBe('Good');
      expect(page.textOmitted).toBe(0);
    });

    it('drops a form box outright when its own bbox arg carries a non-finite edge, rather than emitting it', async () => {
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(200, 200),
            fnArray: [
              FAKE_OPS.paintFormXObjectBegin,
              FAKE_OPS.paintFormXObjectEnd,
              FAKE_OPS.paintImageXObject,
            ],
            argsArray: [
              [null, [5, 5, Infinity, 15]], // a document-controlled bbox carrying Infinity
              [],
              ['img', 1, 1],
            ],
          },
        ]),
      );

      const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
      const page = result.pages[0]!;
      // Watched failing pre-fix: the form's box (x1: Infinity) reached the output as a second
      // entry alongside the image box, instead of being dropped.
      expect(page.images).toEqual([{ x0: 0, y0: 199, x1: 1, y1: 200, source: 'image' }]);
    });
  });

  it('paintFormXObjectBegin/End still push/pop an implicit CTM save with no paired save/restore op', async () => {
    // pdf.js's own CanvasGraphics.paintFormXObjectBegin calls this.save() internally; the
    // evaluator emits no OPS.save/OPS.restore pair around the op. This test pins that the walk's
    // own push/pop reproduces it: deleting both (they look redundant, since nothing in the fake
    // op lists below ever emits a paired save/restore) would still leave every other geometry
    // test in this file green — only a form with a non-identity matrix, followed by something
    // painted after paintFormXObjectEnd, can catch a regression here.
    const renderer = new PdfRenderer(
      fakeGeometryLoader([
        {
          viewport: idViewport(100, 100),
          fnArray: [
            FAKE_OPS.paintFormXObjectBegin,
            FAKE_OPS.paintFormXObjectEnd,
            FAKE_OPS.paintImageXObject,
          ],
          argsArray: [
            [[2, 0, 0, 2, 50, 50], null], // a non-identity form matrix, no bbox of any kind
            [],
            ['img', 1, 1],
          ],
        },
      ]),
    );

    const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
    const page = result.pages[0]!;
    expect(page.images).toHaveLength(2);
    expect(page.images![0]).toMatchObject({ source: 'form', approximate: true });
    // The image painted AFTER paintFormXObjectEnd must sit at the OUTER CTM (identity), not the
    // form's own [2,0,0,2,50,50] matrix — proof that paintFormXObjectEnd popped back to what was
    // pushed at paintFormXObjectBegin.
    expect(page.images![1]).toEqual({ x0: 0, y0: 99, x1: 1, y1: 100, source: 'image' });
  });

  it('wraps a per-page failure in a PdfRenderError naming the page number and the original cause', async () => {
    const cause = new Error('boom: malformed content stream');
    const okPage = () => ({
      getViewport: () => idViewport(100, 100),
      render: () => ({ promise: Promise.resolve() }),
      cleanup: () => {},
      getTextContent: () => Promise.resolve({ items: [] }),
      getOperatorList: () => Promise.resolve({ fnArray: [], argsArray: [] }),
    });
    const renderer = new PdfRenderer((async () => ({
      OPS: FAKE_OPS,
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 2,
          canvasFactory: {},
          getPage: (n: number) =>
            n === 2
              ? Promise.resolve({ ...okPage(), getTextContent: () => Promise.reject(cause) })
              : Promise.resolve(okPage()),
        }),
        destroy: () => Promise.resolve(),
      }),
    })) as unknown as PdfjsLoader);

    let caught: unknown;
    try {
      await renderer.geometry({ pdfPath, kinds: ['text'] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PdfRenderError);
    // Watched failing pre-fix: nothing wrapped the per-page call, so the error was the bare
    // "boom: malformed content stream" with no page number in it at all.
    expect((caught as Error).message).toContain('page 2');
    expect((caught as Error).cause).toBe(cause);
  });

  it('maps a text box through a viewport transform for a non-zero MediaBox origin (no rotation)', async () => {
    const renderer = new PdfRenderer(
      fakeGeometryLoader([
        {
          // pdf.js's own PageViewport.transform for a MediaBox [100 50 300 150] at scale 1,
          // rotation 0 (verified against the installed pdf.js's PageViewport constructor).
          viewport: { width: 200, height: 100, transform: [1, 0, 0, -1, -100, 150] },
          textItems: [{ str: 'x', transform: [1, 0, 0, 1, 120, 70], width: 10, height: 12 }],
        },
      ]),
    );
    const result = await renderer.geometry({ pdfPath, kinds: ['text'] });
    const page = result.pages[0]!;
    // Watched failing pre-fix: toTopLeft only flips y and never rebases the MediaBox origin, so
    // x0 came back unchanged at 120 instead of 20.
    expect(page.text![0]).toMatchObject({ x0: 20, y0: 68, x1: 30, y1: 80 });
  });

  it('composes the CTM with the viewport transform in the documented order (image geometry)', async () => {
    const renderer = new PdfRenderer(
      fakeGeometryLoader([
        {
          // A /Rotate-90-style viewport transform (pdf.js's PageViewport for rotation 90).
          viewport: { width: 150, height: 300, transform: [0, 1, 1, 0, 0, 0] },
          fnArray: [FAKE_OPS.transform, FAKE_OPS.paintImageXObject],
          argsArray: [
            [1, 0, 0, 1, 10, 20],
            ['img', 1, 1],
          ],
        },
      ]),
    );
    const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
    const page = result.pages[0]!;
    // multiply(current, viewportTransform): the CTM (in the image's own local space) applies
    // first, then the viewport transform. The reversed composition produces a different, equally
    // plausible-looking rectangle here — this is the case the task specifically warns looks fine
    // in an identity-base test but is wrong for anything not at the origin.
    expect(page.images).toEqual([{ x0: 20, y0: 10, x1: 21, y1: 11, source: 'image' }]);
  });

  it('kinds: ["text"] leaves images undefined and imagesOmitted at 0', async () => {
    const renderer = new PdfRenderer(
      fakeGeometryLoader([
        {
          viewport: idViewport(100, 100),
          fnArray: [FAKE_OPS.paintImageXObject],
          argsArray: [['img', 1, 1]],
          textItems: [{ str: 'x', transform: [1, 0, 0, 1, 0, 0], width: 5, height: 5 }],
        },
      ]),
    );
    const result = await renderer.geometry({ pdfPath, kinds: ['text'] });
    const page = result.pages[0]!;
    expect(page.images).toBeUndefined();
    expect(page.imagesOmitted).toBe(0);
    expect(page.text).toHaveLength(1);
  });

  it('caps text lines and image rects per page, reporting the omitted counts', async () => {
    const manyLines = Array.from({ length: MAX_TEXT_LINES_PER_PAGE + 5 }, (_, i) => ({
      str: `line${i}`,
      // Each on its own baseline, far enough apart never to merge.
      transform: [1, 0, 0, 1, 0, i * 100],
      width: 10,
      height: 5,
    }));
    const manyImages = Array.from(
      { length: MAX_IMAGE_RECTS_PER_PAGE + 3 },
      () => FAKE_OPS.paintImageXObject,
    );
    const renderer = new PdfRenderer(
      fakeGeometryLoader([
        {
          viewport: idViewport(10000, 10000),
          textItems: manyLines,
          fnArray: manyImages,
          argsArray: manyImages.map(() => ['img', 1, 1]),
        },
      ]),
    );

    const result = await renderer.geometry({ pdfPath, kinds: ['text', 'images'] });
    const page = result.pages[0]!;
    expect(page.text).toHaveLength(MAX_TEXT_LINES_PER_PAGE);
    expect(page.textOmitted).toBe(5);
    expect(page.images).toHaveLength(MAX_IMAGE_RECTS_PER_PAGE);
    expect(page.imagesOmitted).toBe(3);
  });

  it('caps the page list at MAX_GEOMETRY_PAGES and fills skippedPages', async () => {
    const pages: FakePage[] = Array.from({ length: MAX_GEOMETRY_PAGES + 2 }, () => ({
      viewport: idViewport(100, 100),
    }));
    const renderer = new PdfRenderer(fakeGeometryLoader(pages));

    const result = await renderer.geometry({ pdfPath, kinds: ['text'] });
    expect(result.pageCount).toBe(MAX_GEOMETRY_PAGES + 2);
    expect(result.pages).toHaveLength(MAX_GEOMETRY_PAGES);
    expect(result.pages.map((p) => p.page)).toEqual([1, 2, 3, 4]);
    expect(result.skippedPages).toEqual([5, 6]);
  });

  it('surfaces the native-canvas message, not a broken-PDF one, when the loader cannot open a document', async () => {
    const backendMissing: PdfjsLoader = async () => {
      throw new Error('DOMMatrix is not defined');
    };
    const renderer = new PdfRenderer(backendMissing);
    await expect(renderer.geometry({ pdfPath, kinds: ['text'] })).rejects.toThrow(
      /@napi-rs\/canvas/,
    );
    await expect(renderer.geometry({ pdfPath, kinds: ['text'] })).rejects.not.toThrow(
      /Failed to open PDF/,
    );
  });

  // Issue #80 §1. Annotation appearance streams are concatenated into the SAME operator list
  // `page.getOperatorList()` returns, and pdf.js's `CanvasGraphics.beginAnnotation` rebases the
  // whole graphics state on `baseTransform` before painting them — a base the walk never sees.
  // Carrying the walk's stale CTM across that boundary put every image painted inside an
  // annotation at the wrong place, and consecutive annotations accumulated the drift. The
  // resolved call is to emit nothing in there and count it, not to model `baseTransform`: a gap
  // that is counted is better than a rectangle nobody can vouch for. Reachable via `pdfcomment`,
  // form fields, and `pdfpages` with links — NOT from plain `hyperref`: with no `/AP` the worker
  // takes `_getOperatorListNoAppearance()` and emits no ops at all.
  describe('an annotation appearance stream (beginAnnotation/endAnnotation)', () => {
    // What pdf.js actually puts in the operator list for OPS.beginAnnotation:
    // [id, rect, transform, matrix, isUsingOwnCanvas], with a sixth `canvasName` appended for
    // checkbox/radio widgets. The walk reads NONE of them — deliberately, see walkImageGeometry's
    // doc comment — so they are here only to keep the fake faithful to the real shape.
    const annotArgs = (id: string) => [
      id,
      [0, 0, 100, 100],
      [1, 0, 0, 1, 0, 0],
      [1, 0, 0, 1, 0, 0],
      false,
    ];

    it('emits no box for an image painted inside an annotation, counts it, and still emits one painted before it', async () => {
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(100, 100),
            fnArray: [
              FAKE_OPS.paintImageXObject,
              FAKE_OPS.beginAnnotation,
              FAKE_OPS.paintImageXObject,
              FAKE_OPS.endAnnotation,
            ],
            argsArray: [['page-img', 1, 1], annotArgs('a1'), ['annot-img', 1, 1], []],
          },
        ]),
      );

      const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
      const page = result.pages[0]!;
      // Watched failing pre-fix: beginAnnotation/endAnnotation were unknown ops the walk ignored,
      // so the annotation's image was measured under the page CTM and reported as a second,
      // confidently-placed rectangle, with nothing counted.
      expect(page.images).toEqual([{ x0: 0, y0: 99, x1: 1, y1: 100, source: 'image' }]);
      expect(page.annotationImagesSkipped).toBe(1);
      // A counted gap is NOT a cap omission: imagesOmitted is reserved for boxes cut by
      // MAX_IMAGE_RECTS_PER_PAGE, and folding the two together would destroy that distinction.
      expect(page.imagesOmitted).toBe(0);
    });

    it('does not let a transform inside an annotation move the CTM a later paint operator sees', async () => {
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(100, 100),
            fnArray: [
              FAKE_OPS.beginAnnotation,
              FAKE_OPS.transform,
              FAKE_OPS.endAnnotation,
              FAKE_OPS.paintImageXObject,
            ],
            argsArray: [annotArgs('a1'), [2, 0, 0, 2, 50, 50], [], ['img', 1, 1]],
          },
        ]),
      );

      const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
      const page = result.pages[0]!;
      // Exactly the rectangle this operator gets with the whole annotation block deleted — the
      // identity unit square. Watched failing pre-fix: the annotation's own `cm` leaked out and
      // the box came back at {x0:50,y0:48,x1:52,y1:50}.
      expect(page.images).toEqual([{ x0: 0, y0: 99, x1: 1, y1: 100, source: 'image' }]);
      expect(page.annotationImagesSkipped).toBe(0);
    });

    it('does not accumulate drift across consecutive annotations', async () => {
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(100, 100),
            fnArray: [
              FAKE_OPS.beginAnnotation,
              FAKE_OPS.transform,
              FAKE_OPS.endAnnotation,
              FAKE_OPS.beginAnnotation,
              FAKE_OPS.transform,
              FAKE_OPS.endAnnotation,
              FAKE_OPS.paintImageXObject,
            ],
            argsArray: [
              annotArgs('a1'),
              [2, 0, 0, 2, 50, 50],
              [],
              annotArgs('a2'),
              [3, 0, 0, 3, 10, 10],
              [],
              ['img', 1, 1],
            ],
          },
        ]),
      );

      const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
      const page = result.pages[0]!;
      // Same identity unit square as with BOTH blocks deleted. This is the accumulation case the
      // issue names: pre-fix the two `cm`s composed onto each other and onto the page CTM.
      expect(page.images).toEqual([{ x0: 0, y0: 99, x1: 1, y1: 100, source: 'image' }]);
      expect(page.annotationImagesSkipped).toBe(0);
    });

    it('ignores an endAnnotation with no matching beginAnnotation rather than throwing or suppressing what follows', async () => {
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(100, 100),
            fnArray: [
              FAKE_OPS.endAnnotation,
              FAKE_OPS.paintImageXObject,
              FAKE_OPS.beginAnnotation,
              FAKE_OPS.paintImageXObject,
              FAKE_OPS.endAnnotation,
              FAKE_OPS.paintImageXObject,
            ],
            argsArray: [
              [],
              ['before', 1, 1],
              annotArgs('a1'),
              ['inside', 1, 1],
              [],
              ['after', 1, 1],
            ],
          },
        ]),
      );

      const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
      const page = result.pages[0]!;
      // The stray end must not drive the depth counter negative: a depth of -1 would leave the
      // following real beginAnnotation at depth 0, and the annotation's image would be emitted as
      // a page rectangle. Both page-level images are still here, the annotation's is not.
      expect(page.images).toEqual([
        { x0: 0, y0: 99, x1: 1, y1: 100, source: 'image' },
        { x0: 0, y0: 99, x1: 1, y1: 100, source: 'image' },
      ]);
      expect(page.annotationImagesSkipped).toBe(1);
    });

    it('suppresses and counts a form XObject inside an annotation while keeping the CTM stack balanced', async () => {
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(100, 100),
            fnArray: [
              FAKE_OPS.beginAnnotation,
              FAKE_OPS.paintFormXObjectBegin,
              FAKE_OPS.paintFormXObjectEnd,
              FAKE_OPS.endAnnotation,
              FAKE_OPS.paintImageXObject,
            ],
            argsArray: [
              annotArgs('a1'),
              // A non-identity form matrix and no bbox of any kind: pre-fix this produced an
              // `approximate: true` unit-square box under the annotation's CTM.
              [[2, 0, 0, 2, 50, 50], null],
              [],
              [],
              ['img', 1, 1],
            ],
          },
        ]),
      );

      const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
      const page = result.pages[0]!;
      // Only the page-level image survives; the form inside the annotation is a counted gap.
      expect(page.images).toEqual([{ x0: 0, y0: 99, x1: 1, y1: 100, source: 'image' }]);
      expect(page.annotationImagesSkipped).toBe(1);
      // And the walk is still balanced afterwards: the image above lands at the OUTER CTM
      // (identity), not the form's own [2,0,0,2,50,50].
      expect(page.images![0]).not.toMatchObject({ x0: 50 });
    });
  });

  // Issue #80 §2. `applyCtm` refusing a poisoned multiply is right — propagating Infinity/NaN
  // would turn one bad operand into wall-to-wall garbage — but it used to be SILENT, so every
  // later box on the page was computed against a transform the document did not ask for and came
  // back finite, plausible and unflagged. By this codebase's own standard (`approximate` means
  // "never use this for a collision computation"; source snippets are shown "only where they can
  // be vouched for") such a box belongs in the same bucket.
  describe('a box measured under a CTM the walk had to refuse (unreliableCtm)', () => {
    // Already Infinity before applyCtm sees it (`Number.MAX_VALUE * 10` overflows when the
    // literal is evaluated); the multiply then yields NaN in the slots where it meets a 0.
    const poisonMatrix = [Number.MAX_VALUE * 10, 0, 0, 1, 0, 0];

    it('flags every box drawn after a refused transform and stops flagging at the matching restore', async () => {
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(200, 200),
            fnArray: [
              FAKE_OPS.save,
              FAKE_OPS.transform,
              FAKE_OPS.paintImageXObject,
              FAKE_OPS.transform,
              FAKE_OPS.paintImageXObject,
              FAKE_OPS.transform,
              FAKE_OPS.paintImageXObject,
              FAKE_OPS.restore,
              FAKE_OPS.paintImageXObject,
            ],
            argsArray: [
              [],
              [1, 0, 0, 1, 10, 10],
              ['good', 1, 1],
              poisonMatrix,
              ['poisoned', 1, 1],
              // A perfectly legitimate `cm` — but composed onto the WRONG base, which is exactly
              // the case the issue's worked table calls indistinguishable from a measurement.
              [1, 0, 0, 1, 5, 5],
              ['composed-onto-wrong-base', 1, 1],
              [],
              ['good-again', 1, 1],
            ],
          },
        ]),
      );

      const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
      const page = result.pages[0]!;
      // Watched failing pre-fix: all four boxes came back identical to these but with no
      // `unreliableCtm` anywhere — boxes 2 and 3 were indistinguishable from measurements.
      expect(page.images).toEqual([
        { x0: 10, y0: 189, x1: 11, y1: 190, source: 'image' },
        { x0: 10, y0: 189, x1: 11, y1: 190, source: 'image', unreliableCtm: true },
        { x0: 15, y0: 184, x1: 16, y1: 185, source: 'image', unreliableCtm: true },
        { x0: 0, y0: 199, x1: 1, y1: 200, source: 'image' },
      ]);
      // The first and last carry no such property at all — not `undefined`, absent — so a caller
      // reading `'unreliableCtm' in box` gets the same answer as one reading the value.
      expect(Object.hasOwn(page.images![0]!, 'unreliableCtm')).toBe(false);
      expect(Object.hasOwn(page.images![3]!, 'unreliableCtm')).toBe(false);
    });

    it('pops a poison latched by a form XObject own /Matrix at the matching paintFormXObjectEnd', async () => {
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(200, 200),
            fnArray: [
              FAKE_OPS.paintFormXObjectBegin,
              FAKE_OPS.paintImageXObject,
              FAKE_OPS.paintFormXObjectEnd,
              FAKE_OPS.paintImageXObject,
            ],
            argsArray: [
              [poisonMatrix, [0, 0, 10, 10]],
              ['inside-form', 1, 1],
              [],
              ['after-form', 1, 1],
            ],
          },
        ]),
      );

      const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
      const page = result.pages[0]!;
      // The form's own box is measured under the refused matrix, so it is flagged too; so is the
      // image inside it; the image after paintFormXObjectEnd is clean, because the implicit save
      // the walk pushes at paintFormXObjectBegin carries the poison flag alongside the CTM.
      expect(page.images).toEqual([
        { x0: 0, y0: 190, x1: 10, y1: 200, source: 'form', unreliableCtm: true },
        { x0: 0, y0: 199, x1: 1, y1: 200, source: 'image', unreliableCtm: true },
        { x0: 0, y0: 199, x1: 1, y1: 200, source: 'image' },
      ]);
      expect(Object.hasOwn(page.images![2]!, 'unreliableCtm')).toBe(false);
    });

    it('keeps a poison latched at depth 0 with no enclosing save for the rest of the page', async () => {
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(100, 100),
            fnArray: [
              FAKE_OPS.transform,
              FAKE_OPS.paintImageXObject,
              FAKE_OPS.transform,
              FAKE_OPS.paintImageXObject,
              // A bare restore against an empty stack: it pops nothing, so it must clear nothing
              // either. There is no known-good state to go back to at depth 0.
              FAKE_OPS.restore,
              FAKE_OPS.paintImageXObject,
            ],
            argsArray: [
              poisonMatrix,
              ['a', 1, 1],
              [1, 0, 0, 1, 10, 10],
              ['b', 1, 1],
              [],
              ['c', 1, 1],
            ],
          },
        ]),
      );

      const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
      const page = result.pages[0]!;
      expect(page.images).toEqual([
        { x0: 0, y0: 99, x1: 1, y1: 100, source: 'image', unreliableCtm: true },
        { x0: 10, y0: 89, x1: 11, y1: 90, source: 'image', unreliableCtm: true },
        { x0: 10, y0: 89, x1: 11, y1: 90, source: 'image', unreliableCtm: true },
      ]);
    });

    it('drops a poisoned box whose edges come out non-finite rather than emitting it flagged', async () => {
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(200, 200),
            fnArray: [
              FAKE_OPS.transform,
              FAKE_OPS.paintFormXObjectBegin,
              FAKE_OPS.paintFormXObjectEnd,
              FAKE_OPS.paintImageXObject,
            ],
            argsArray: [
              poisonMatrix,
              // A document-controlled bbox carrying Infinity, measured while poisoned: the drop
              // guard runs first and wins. Flagging is for a box that is still a number.
              [null, [0, 0, Infinity, 10]],
              [],
              ['after', 1, 1],
            ],
          },
        ]),
      );

      const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
      const page = result.pages[0]!;
      // Exactly one box: the form's was dropped outright, never emitted with `unreliableCtm` on
      // it. Drop still beats flag.
      expect(page.images).toEqual([
        { x0: 0, y0: 199, x1: 1, y1: 200, source: 'image', unreliableCtm: true },
      ]);
      for (const box of page.images ?? []) {
        expect(Number.isFinite(box.x0)).toBe(true);
        expect(Number.isFinite(box.y0)).toBe(true);
        expect(Number.isFinite(box.x1)).toBe(true);
        expect(Number.isFinite(box.y1)).toBe(true);
      }
    });
  });

  describe('the two reachable rarer paint operators (#80 §5)', () => {
    // Both paint the unit square under the current CTM, verified against the installed pdf.js
    // 6.1.200 rather than assumed: CanvasGraphics.paintInlineImageXObject scales by
    // (1/width, -1/height) and draws (0, -height, width, height), which composes to [0,1]x[0,1]
    // before the CTM; paintSolidColorImageMask is a literal fillRect(0, 0, 1, 1).
    //
    // The four BATCHED operators issue #80 lists alongside these are deliberately NOT handled, and
    // there is no test for them because there is nothing to test: they exist only as an output of
    // pdf.js's QueueOptimizer, and page.getOperatorList() selects the NullOptimizer, whose
    // _optimize() is a no-op. No operator list this walk can receive contains one. Writing a test
    // that feeds one through FAKE_OPS would prove the walk handles an input it cannot be given —
    // the shape of vacuous test this file's own comments warn about.
    it('measures an inline image exactly as it measures an image XObject', async () => {
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(100, 100),
            fnArray: [
              FAKE_OPS.transform,
              FAKE_OPS.paintInlineImageXObject,
              FAKE_OPS.paintImageXObject,
            ],
            argsArray: [[10, 0, 0, 20, 30, 40], [{ width: 4, height: 8 }], ['img', 1, 1]],
          },
        ]),
      );

      const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
      // Identical rectangles from the two operators under one CTM: the inline image's own pixel
      // dimensions are NOT its placement (pdf.js divides them straight back out), so a walk that
      // used args[0].width/height would put this box at 4x8 and be wrong by construction.
      expect(result.pages[0]!.images).toEqual([
        { x0: 30, y0: 40, x1: 40, y1: 60, source: 'image' },
        { x0: 30, y0: 40, x1: 40, y1: 60, source: 'image' },
      ]);
    });

    it('measures a solid-colour image mask, which carries no args at all', async () => {
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(100, 100),
            fnArray: [FAKE_OPS.transform, FAKE_OPS.paintSolidColorImageMask],
            argsArray: [[2, 0, 0, 2, 5, 5], []],
          },
        ]),
      );

      const result = await renderer.geometry({ pdfPath, kinds: ['images'] });
      expect(result.pages[0]!.images).toEqual([{ x0: 5, y0: 93, x1: 7, y1: 95, source: 'image' }]);
    });

    it('suppresses and counts both of them inside an annotation, like every other paint op', async () => {
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(100, 100),
            fnArray: [
              FAKE_OPS.beginAnnotation,
              FAKE_OPS.paintInlineImageXObject,
              FAKE_OPS.paintSolidColorImageMask,
              FAKE_OPS.endAnnotation,
            ],
            argsArray: [
              ['a1', [0, 0, 100, 100], [1, 0, 0, 1, 0, 0], [1, 0, 0, 1, 0, 0], false],
              [{ width: 4, height: 8 }],
              [],
              [],
            ],
          },
        ]),
      );

      const page = (await renderer.geometry({ pdfPath, kinds: ['images'] })).pages[0]!;
      // A new paint operator that emits a box but skips the annotation guard would be a fresh
      // instance of the bug #80 §1 fixed, in a branch nobody re-read.
      expect(page.images).toEqual([]);
      expect(page.annotationImagesSkipped).toBe(2);
    });

    it('flags them unreliableCtm under a refused transform, like every other paint op', async () => {
      // The same matrix the unreliableCtm describe block uses, and for a reason worth recording:
      // `Number.MAX_VALUE * 10` is already Infinity when the array literal is evaluated, so
      // applyCtm's multiply produces non-finite slots and REFUSES. Plain Number.MAX_VALUE is
      // finite, so the walk would compose it happily, the boxes would come out infinite and be
      // DROPPED by hasNonFiniteEdge, and this test would have asserted nothing about the flag
      // while looking like it did — which is what it did on the first attempt.
      const poisonMatrix = [Number.MAX_VALUE * 10, 0, 0, 1, 0, 0];
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(100, 100),
            fnArray: [
              FAKE_OPS.transform,
              FAKE_OPS.paintInlineImageXObject,
              FAKE_OPS.paintSolidColorImageMask,
            ],
            argsArray: [poisonMatrix, [{ width: 1, height: 1 }], []],
          },
        ]),
      );

      const page = (await renderer.geometry({ pdfPath, kinds: ['images'] })).pages[0]!;
      expect(page.images).toEqual([
        { x0: 0, y0: 99, x1: 1, y1: 100, source: 'image', unreliableCtm: true },
        { x0: 0, y0: 99, x1: 1, y1: 100, source: 'image', unreliableCtm: true },
      ]);
    });
  });

  describe('an annotation must not leak a pending group bbox in either direction', () => {
    const annotArgs = ['a1', [0, 0, 100, 100], [1, 0, 0, 1, 0, 0], [1, 0, 0, 1, 0, 0], false];
    const groupArgs = [{ bbox: [0, 0, 56, 28], matrix: null }];

    it('does not hand a group bbox opened inside an annotation to a form outside it', async () => {
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(100, 100),
            fnArray: [
              FAKE_OPS.beginAnnotation,
              FAKE_OPS.beginGroup,
              FAKE_OPS.endAnnotation,
              FAKE_OPS.paintFormXObjectBegin,
              FAKE_OPS.paintFormXObjectEnd,
            ],
            argsArray: [annotArgs, groupArgs, [], [null, null], []],
          },
        ]),
      );

      const page = (await renderer.geometry({ pdfPath, kinds: ['images'] })).pages[0]!;
      // Watched failing pre-fix: pendingGroup was the one piece of walk state the annotation
      // snapshot left out, so the form after the bracket was measured with the ANNOTATION's
      // 56x28 group bbox — a confidently-placed rectangle, no `approximate` flag, entirely wrong.
      // With no bbox it can vouch for, the form falls back to the flagged unit square.
      expect(page.images).toEqual([
        { x0: 0, y0: 99, x1: 1, y1: 100, source: 'form', approximate: true },
      ]);
    });

    it('gives a form after the bracket the group bbox that was pending BEFORE it', async () => {
      const renderer = new PdfRenderer(
        fakeGeometryLoader([
          {
            viewport: idViewport(100, 100),
            fnArray: [
              FAKE_OPS.beginGroup,
              FAKE_OPS.beginAnnotation,
              FAKE_OPS.paintFormXObjectBegin,
              FAKE_OPS.paintFormXObjectEnd,
              FAKE_OPS.endAnnotation,
              FAKE_OPS.paintFormXObjectBegin,
              FAKE_OPS.paintFormXObjectEnd,
            ],
            argsArray: [groupArgs, annotArgs, [null, null], [], [], [null, null], []],
          },
        ]),
      );

      const page = (await renderer.geometry({ pdfPath, kinds: ['images'] })).pages[0]!;
      // The other direction, and the reason the snapshot has to RESTORE rather than merely clear:
      // the form inside the annotation consumes pendingGroup (that consume runs before the
      // annotation guard, so the matching End stays balanced), which pre-fix left the real form
      // after the bracket with nothing and downgraded it to the approximate unit square.
      expect(page.images).toEqual([{ x0: 0, y0: 72, x1: 56, y1: 100, source: 'form' }]);
      expect(page.annotationImagesSkipped).toBe(1);
    });
  });
});

describe('pdf.js OPS table', () => {
  // Every other geometry test in this file drives a hand-rolled FAKE_OPS with arbitrary numbers,
  // which proves the walk is driven by whatever table it is handed but proves nothing about
  // whether that table's *names* still exist in the real, installed pdf.js. `PdfjsOps` is a
  // locally-declared TypeScript interface over a module obtained at runtime and cast from
  // `unknown` (see the comment on PdfjsOps in pdfRender.ts) — a rename or removal on pdf.js's
  // side is invisible to the compiler and produces `undefined` at runtime, which silently matches
  // no `fnArray` entry (always a number). This test is the one thing that actually catches that.
  it('defines every op the geometry walk uses as a number in the real, installed pdf.js', async () => {
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
      OPS: Record<string, unknown>;
    };
    // Mirrors PdfjsOps in src/services/pdfRender.ts exactly.
    const names = [
      'save',
      'restore',
      'transform',
      'paintImageXObject',
      'paintImageMaskXObject',
      'paintFormXObjectBegin',
      'paintFormXObjectEnd',
      'beginGroup',
      'endGroup',
      'beginAnnotation',
      'endAnnotation',
      'paintInlineImageXObject',
      'paintSolidColorImageMask',
    ];
    for (const name of names) {
      expect(typeof pdfjs.OPS[name]).toBe('number');
    }
  });

  it('pins the pdf.js major the batched-operator claim was verified against', async () => {
    // The schema, docs/tools.md and the CHANGELOG all now state as FACT that pdf.js's four
    // batched paint operators cannot reach this tool. That is true of 6.x and was verified by
    // reading the chain: getOperatorList() passes isOpList, which sets RenderingIntentFlag.OPLIST,
    // which selects NullOptimizer (whose _optimize() is empty) instead of QueueOptimizer — and
    // those four opcodes are emitted ONLY by QueueOptimizer splices.
    //
    // The walk has no branch for them, so if a future pdf.js changed that selection, or emitted
    // them from the evaluator, the failure would be SILENTLY MISSING RECTANGLES on a page that
    // has figures — the exact direction this tool exists to avoid, and worse than the documented
    // gap the claim replaced. Nothing else in the suite would notice.
    //
    // This does not detect the change; it forces a human to re-derive the claim on a major bump,
    // which is the cheap half. The four opcodes are asserted to exist so that "we are talking
    // about the same table" stays true, and so a rename does not read as a fix. The other half —
    // an actual detector, driving a real batchable page through the real getOperatorList() — is
    // the describe block below; keep both, since a rename defeats the detector (the opcode it
    // counts stops existing) and a behaviour change defeats this one.
    const pkg = (await import('pdfjs-dist/package.json', {
      with: { type: 'json' },
    })) as unknown as {
      default: { version: string };
    };
    expect(pkg.default.version.split('.')[0]).toBe('6');

    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
      OPS: Record<string, unknown>;
    };
    for (const name of [
      'paintImageXObjectRepeat',
      'paintInlineImageXObjectGroup',
      'paintImageMaskXObjectGroup',
      'paintImageMaskXObjectRepeat',
    ]) {
      expect(typeof pdfjs.OPS[name]).toBe('number');
    }
  });
});

/**
 * The exact number of `q <cm> <paint> Q` quads `batchableImagePdf` writes per paint operator.
 *
 * Above every threshold pdf.js's `QueueOptimizer` batches at (3 for `paintImageXObjectRepeat`,
 * 10 for the two `*Group` forms and for `paintImageMaskXObjectRepeat`), with room to spare — the
 * spare matters, because pdf.js emits a one-off `OPS.dependency` INSIDE the first quad of each
 * run, so only 11 of the 12 are consecutive and a fixture sized exactly 10 would miss the
 * 10-thresholds by one and pass for the wrong reason.
 */
const BATCHABLE_QUADS = 12;

/**
 * A one-page PDF whose content stream is nothing but the quad pattern pdf.js's `QueueOptimizer`
 * matches on — `q <cm> <paint> Q`, repeated — in three runs, one per paint operator that has a
 * batched form: a referenced image XObject (`paintImageXObject`), a referenced image mask
 * (`paintImageMaskXObject`) and an inline image (`paintInlineImageXObject`). Between them those
 * three runs are the trigger for all four batched opcodes.
 *
 * Details that are load-bearing rather than arbitrary, all read off the installed pdf.js 6.1.200:
 *  - The image run keeps `b`/`c` at 0 and `a`/`d` identical across placements, varying only the
 *    translation, because `iterateImageGroup`'s `checkFn` requires exactly that (and the same
 *    objId) before `paintImageXObjectRepeat` is even considered.
 *  - The mask run uses `b !== c` (0.1 vs 0.2) so that `foundImageMaskGroup` takes its
 *    `isSameImage === false` branch and would produce `paintImageMaskXObjectGroup`. The
 *    `paintImageMaskXObjectRepeat` sibling is covered by the image run's shape being asserted
 *    absent too — both opcodes come out of the same state, and the test counts all four.
 *  - The images are 8x8, not 1x1: a referenced XObject is never turned into an inline image (the
 *    `SMALL_IMAGE_DIMENSIONS` shortcut in the evaluator is gated on `isInline`), but a
 *    single-pixel mask takes a `constructPath` shortcut instead of emitting a mask op at all.
 *
 * Hand-written rather than compiled so this needs no TeX, and kept local rather than folded into
 * `test/helpers/minimalPdf.ts` because nothing else wants a page of 36 images.
 */
function batchableImagePdf(): Buffer {
  const imgData = '\xff'.repeat(64); // 8x8 DeviceGray, 8 bits per component
  const maskData = '\x00'.repeat(8); // 8x8 image mask, 1 bit per component
  const inlineData = '\xaa'.repeat(16); // 4x4 DeviceGray, 8 bits per component

  const quads: string[] = [];
  for (let i = 0; i < BATCHABLE_QUADS; i++) {
    quads.push(`q 10 0 0 10 ${10 + i * 12} 20 cm /Im0 Do Q`);
  }
  for (let i = 0; i < BATCHABLE_QUADS; i++) {
    quads.push(`q 10 0.1 0.2 10 ${10 + i * 12} 40 cm /Msk Do Q`);
  }
  for (let i = 0; i < BATCHABLE_QUADS; i++) {
    quads.push(`q 5 0 0 5 ${10 + i * 12} 60 cm BI /W 4 /H 4 /CS /G /BPC 8 ID ${inlineData} EI Q`);
  }
  const stream = quads.join('\n');

  const objs = new Map<number, string>([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [5 0 R] /Count 1 >>'],
    [
      3,
      `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray ` +
        `/BitsPerComponent 8 /Length ${imgData.length} >>\nstream\n${imgData}\nendstream`,
    ],
    [
      4,
      `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ImageMask true /Decode [0 1] ` +
        `/Length ${maskData.length} >>\nstream\n${maskData}\nendstream`,
    ],
    [
      5,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 6 0 R ' +
        '/Resources << /XObject << /Im0 3 0 R /Msk 4 0 R >> >> >>',
    ],
    [6, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`],
  ]);

  let out = '%PDF-1.4\n';
  const offsets = new Map<number, number>();
  const maxObjNum = Math.max(...objs.keys());
  for (let i = 1; i <= maxObjNum; i++) {
    offsets.set(i, out.length);
    out += `${i} 0 obj\n${objs.get(i)}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${maxObjNum + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxObjNum; i++) {
    out += `${String(offsets.get(i) ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${maxObjNum + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * The longest run of CONSECUTIVE `save, transform, <paint>, restore` quads in an operator list —
 * the shape `QueueOptimizer`'s state machine matches on and splices out. Counting this rather
 * than counting `paint` operators is what makes the assertion below non-vacuous: twelve paint
 * ops scattered among other operators would not be batchable in the first place, so finding no
 * batched opcode over them would prove nothing.
 */
function longestQuadRun(
  fnArray: readonly number[],
  ops: Record<string, number>,
  paint: number,
): number {
  let best = 0;
  let i = 0;
  while (i < fnArray.length) {
    let run = 0;
    let j = i;
    while (
      fnArray[j] === ops.save &&
      fnArray[j + 1] === ops.transform &&
      fnArray[j + 2] === paint &&
      fnArray[j + 3] === ops.restore
    ) {
      run++;
      j += 4;
    }
    best = Math.max(best, run);
    i = run > 0 ? j : i + 1;
  }
  return best;
}

describe('pdf.js operator-list batching (#80 §5)', () => {
  // Why this block exists at all. `walkImageGeometry` has no branch for pdf.js's four BATCHED
  // paint operators, on the grounds that `page.getOperatorList()` selects `NullOptimizer` (the
  // OPLIST rendering-intent flag) and only `QueueOptimizer` ever emits them. That claim is now
  // stated as fact in the `PdfjsOps` doc comment, in the tool's schema and in docs/tools.md, and
  // the failure mode if it ever stops being true is silent: a page full of figures would come
  // back with a fraction of its rectangles and every counter reading zero, which for a collision
  // question is the dangerous direction. The sibling "pdf.js OPS table" block pins the version
  // and the opcode names; this one pins the BEHAVIOUR, against a page pdf.js would batch.
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-batch-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('yields one paint op per placement — never a batched opcode — over a page built to be batched', async () => {
    // Driven through the very module `PdfRenderer`'s default loader imports, and through
    // `page.getOperatorList()` with no arguments, because the claim is about that exact call:
    // it is what sets RenderingIntentFlag.OPLIST, and a `render()` of the same page WOULD batch.
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
      OPS: Record<string, number>;
      getDocument(src: { data: Uint8Array; verbosity?: number }): {
        promise: Promise<{
          getPage(n: number): Promise<{
            getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
            cleanup(): void;
          }>;
        }>;
      };
    };
    const { OPS } = pdfjs;
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(batchableImagePdf()),
      verbosity: 0,
    }).promise;
    const page = await doc.getPage(1);
    const { fnArray } = await page.getOperatorList();
    page.cleanup();

    // Anti-vacuity first, and it is the half that actually rots: if a future pdf.js stopped
    // emitting one of these three per-placement ops for this fixture (an evaluator shortcut, a
    // changed inline-image threshold), the "no batched opcode" assertion below would still pass
    // while testing nothing. These minimums are pdf.js's own thresholds, read off the installed
    // worker's optimizer states: MIN_IMAGES_IN_BLOCK = 3 for the image-XObject state,
    // MIN_IMAGES_IN_MASKS_BLOCK = 10 and MIN_IMAGES_IN_INLINE_IMAGES_BLOCK = 10.
    expect(longestQuadRun(fnArray, OPS, OPS.paintImageXObject!)).toBeGreaterThanOrEqual(3);
    expect(longestQuadRun(fnArray, OPS, OPS.paintImageMaskXObject!)).toBeGreaterThanOrEqual(10);
    expect(longestQuadRun(fnArray, OPS, OPS.paintInlineImageXObject!)).toBeGreaterThanOrEqual(10);

    // The claim itself. Counted, not merely `toContain`-negated, so a partial batching (one run
    // collapsed, two left alone) fails as loudly as a total one.
    for (const name of [
      'paintImageXObjectRepeat',
      'paintInlineImageXObjectGroup',
      'paintImageMaskXObjectGroup',
      'paintImageMaskXObjectRepeat',
    ] as const) {
      const code = OPS[name];
      expect(typeof code).toBe('number');
      expect({ [name]: fnArray.filter((fn) => fn === code).length }).toEqual({ [name]: 0 });
    }
  });

  it('measures every placement on that page, so a future batching shows up as missing rectangles', async () => {
    // The consequence, asserted end to end through the real walk with the real loader rather
    // than inferred from the operator list above: 36 placements, 36 boxes. This is the assertion
    // that would actually FAIL (not merely stop proving anything) the day pdf.js batches here —
    // the count would collapse to the number of un-batched runs, which is the silent gap the
    // deferral in #80 §5 was originally filed about.
    const pdfPath = path.join(dir, 'batchable.pdf');
    await writeFile(pdfPath, batchableImagePdf());

    const result = await new PdfRenderer().geometry({ pdfPath, kinds: ['images'] });
    const geomPage = result.pages[0]!;
    expect(geomPage.images).toHaveLength(BATCHABLE_QUADS * 3);
    expect(geomPage.imagesOmitted).toBe(0);
    expect(geomPage.annotationImagesSkipped).toBe(0);
    // Every box is a real measurement: nothing here is drawn under a refused CTM, and the walk
    // never falls back to a unit square for an image op. A batched opcode arriving unhandled
    // would not trip these — it would simply remove boxes — which is why the length above is the
    // load-bearing assertion and these two are the corroboration.
    expect(geomPage.images!.some((b) => b.unreliableCtm)).toBe(false);
    expect(geomPage.images!.some((b) => b.approximate)).toBe(false);
  });
});

describe('PdfRenderer.pageLabels', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-pagelabels-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the /PageLabels tree, whatever scheme the labels imitate', async () => {
    // The point of reading the tree at all: a roman front matter and an appendix scheme come
    // back verbatim, where the .aux alone gives no way to turn either into a page index.
    const pdfPath = path.join(dir, 'labelled.pdf');
    await writeFile(pdfPath, minimalPdf(5, 200, 100, { pageLabels: ['i', 'ii', '1', '2', 'A-1'] }));
    await expect(new PdfRenderer().pageLabels(pdfPath)).resolves.toEqual([
      'i',
      'ii',
      '1',
      '2',
      'A-1',
    ]);
  });

  it('answers null — not an error — for a PDF with no tree, which is the common case', async () => {
    // A plain `article` has no /PageLabels. Treating that as a failure would break every
    // label-resolved render on the documents this server exists for.
    const pdfPath = path.join(dir, 'plain.pdf');
    await writeFile(pdfPath, minimalPdf(3));
    await expect(new PdfRenderer().pageLabels(pdfPath)).resolves.toBeNull();
  });

  it('answers the tree and the page count together, and refuses the same pdf.js', async () => {
    // pageLabelsAndCount is what a label lookup reads (one load for both answers); it must say
    // exactly what the two single answers say, refusal included.
    const pdfPath = path.join(dir, 'labelled.pdf');
    await writeFile(pdfPath, minimalPdf(3, 200, 100, { pageLabels: ['i', '1', '2'] }));
    await expect(new PdfRenderer().pageLabelsAndCount(pdfPath)).resolves.toEqual({
      pageLabels: ['i', '1', '2'],
      pageCount: 3,
    });
    await writeFile(pdfPath, minimalPdf(2));
    await expect(new PdfRenderer().pageLabelsAndCount(pdfPath)).resolves.toEqual({
      pageLabels: null,
      pageCount: 2,
    });
    const renderer = new PdfRenderer(fakeGeometryLoader([{ viewport: idViewport(100, 100) }]));
    await expect(renderer.pageLabelsAndCount(pdfPath)).rejects.toThrow(/getPageLabels/);
  });

  it('refuses a pdf.js with no getPageLabels rather than calling it "no page labels"', async () => {
    // fakeGeometryLoader's document deliberately does not implement the method. Answering null
    // here would silently downgrade every renumbered document back to the inferred route this
    // lookup replaces — a wrong page reported as a resolved one.
    const pdfPath = path.join(dir, 'doc.pdf');
    await writeFile(pdfPath, minimalPdf(1));
    const renderer = new PdfRenderer(fakeGeometryLoader([{ viewport: idViewport(100, 100) }]));
    await expect(renderer.pageLabels(pdfPath)).rejects.toThrow(/getPageLabels/);
  });

  it('tells the caller to install the native backend rather than blaming the PDF', async () => {
    const pdfPath = path.join(dir, 'doc.pdf');
    await writeFile(pdfPath, minimalPdf(1));
    const renderer = new PdfRenderer(() => {
      throw new Error('DOMMatrix is not defined');
    });
    await expect(renderer.pageLabels(pdfPath)).rejects.toThrow(/@napi-rs\/canvas/);
    await expect(renderer.pageLabels(pdfPath)).rejects.not.toThrow(/Failed to open PDF/);
  });
});

describe('PdfRenderer.text', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-text-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns each page’s text layer as merged lines, in drawing order', async () => {
    const pdfPath = path.join(dir, 'doc.pdf');
    await writeFile(
      pdfPath,
      minimalPdf(2, 300, 200, { text: (n) => `page ${n} first line\npage ${n} second line` }),
    );

    const result = await new PdfRenderer().text({ pdfPath });
    expect(result.pageCount).toBe(2);
    expect(result.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(result.pages[0]?.lines).toEqual(['page 1 first line', 'page 1 second line']);
    expect(result.pages[1]?.lines).toEqual(['page 2 first line', 'page 2 second line']);
    expect(result.pages[0]?.linesOmitted).toBe(0);
    expect(result.pages[0]?.charsOmitted).toBe(0);
  });

  it('reports a page with no text layer as no lines rather than failing', async () => {
    const pdfPath = path.join(dir, 'doc.pdf');
    await writeFile(pdfPath, minimalPdf(1));
    const result = await new PdfRenderer().text({ pdfPath });
    expect(result.pages[0]?.lines).toEqual([]);
  });

  it(`caps the call at ${MAX_TEXT_PAGES} pages and names the rest in skippedPages`, async () => {
    const pdfPath = path.join(dir, 'doc.pdf');
    await writeFile(pdfPath, minimalPdf(MAX_TEXT_PAGES + 2, 200, 100, { text: (n) => `p${n}` }));
    const result = await new PdfRenderer().text({ pdfPath });
    expect(result.pages).toHaveLength(MAX_TEXT_PAGES);
    expect(result.skippedPages).toEqual([MAX_TEXT_PAGES + 1, MAX_TEXT_PAGES + 2]);
  });

  it('throws the same out-of-range message selectPages gives every other caller', async () => {
    const pdfPath = path.join(dir, 'doc.pdf');
    await writeFile(pdfPath, minimalPdf(2));
    await expect(new PdfRenderer().text({ pdfPath, pages: [9] })).rejects.toThrow(
      /Page 9 is out of range/,
    );
  });

  it('returns every merged line whole and uncounted — the cutting is the tool budget’s job', async () => {
    // PB3. This service used to cut each page to 20000 characters and truncate a single longer
    // line to 20000 + "…" before `extract_text`'s call-wide budget (`extractTextBudget.ts`) saw
    // it, so that budget reported the truncated length (20001) as the gap. The call-wide budget
    // is smaller than that per-page cap and already cuts a suffix and counts it, so the per-page
    // cut changed only what the counters said, and said it wrong. What is returned here must be
    // the lines exactly as merged, so the one budget that cuts can count them at their length.
    //
    // A 30000-character line (over the old cap) between shorter ones: pre-fix it came back as
    // 20001 characters and ended the page, with 6 lines "omitted".
    const fifteen = Array.from({ length: 15 }, () => 'x'.repeat(1000));
    const lineTexts = [
      ...fifteen,
      'y'.repeat(30_000),
      ...Array.from({ length: 5 }, () => 'z'.repeat(100)),
    ];
    const items = lineTexts.map((str, i) => ({
      str,
      transform: [1, 0, 0, 1, 10, 2000 - i * 20],
      width: 100,
      height: 10,
    }));
    const pdfPath = path.join(dir, 'doc.pdf');
    await writeFile(pdfPath, minimalPdf(1));
    const renderer = new PdfRenderer(
      fakeGeometryLoader([{ viewport: idViewport(600, 2200), textItems: items }]),
    );

    const page = (await renderer.text({ pdfPath })).pages[0]!;
    expect(page.lines).toEqual(lineTexts);
    expect(page.linesOmitted).toBe(0);
    expect(page.charsOmitted).toBe(0);

    // And composed with the budget that does cut: the gap is counted at the line's true length.
    const planned = planExtractedText([page]).pages[0]!;
    const cut = lineTexts.slice(planned.lines.length);
    expect(planned.lines).toEqual(lineTexts.slice(0, planned.lines.length));
    expect(planned.linesOmitted).toBe(cut.length);
    expect(planned.charsOmitted).toBe(cut.reduce((n, l) => n + l.length, 0));
    expect(cut).toContain('y'.repeat(30_000));
  });

  it('does not apply pdf_geometry’s 160-character line label cap to the content', async () => {
    // The one place the two text paths deliberately differ: geometry truncates a line to a short
    // LABEL for a box, which would silently mangle the text this tool exists to return.
    const long = 'y'.repeat(500);
    const pdfPath = path.join(dir, 'doc.pdf');
    await writeFile(pdfPath, minimalPdf(1));
    const renderer = new PdfRenderer(
      fakeGeometryLoader([
        {
          viewport: idViewport(600, 800),
          textItems: [{ str: long, transform: [1, 0, 0, 1, 10, 700], width: 100, height: 10 }],
        },
      ]),
    );
    expect((await renderer.text({ pdfPath })).pages[0]?.lines).toEqual([long]);
  });

  it('tells the caller to install the native backend rather than blaming the PDF', async () => {
    const pdfPath = path.join(dir, 'doc.pdf');
    await writeFile(pdfPath, minimalPdf(1));
    const renderer = new PdfRenderer(() => {
      throw new Error('DOMMatrix is not defined');
    });
    await expect(renderer.text({ pdfPath })).rejects.toThrow(/@napi-rs\/canvas/);
  });
});

describe('PdfRenderer.geometry — font metrics from getTextContent().styles (#80 §6)', () => {
  let dir: string;
  let pdfPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-geomfont-'));
    pdfPath = path.join(dir, 'doc.pdf');
    await writeFile(pdfPath, minimalPdf(1));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('joins styles onto each item by fontName and cuts the box to the declared ascent', async () => {
    const renderer = new PdfRenderer(
      fakeGeometryLoader([
        {
          viewport: idViewport(600, 800),
          styles: { g_d0_f1: { ascent: 0.718, descent: -0.207, vertical: false } },
          textItems: [
            {
              str: 'Hg',
              transform: [1, 0, 0, 1, 10, 700],
              width: 40,
              height: 10,
              fontName: 'g_d0_f1',
            },
          ],
        },
      ]),
    );
    const page = (await renderer.geometry({ pdfPath, kinds: ['text'] })).pages[0]!;
    // User space {x0:10, y0:700, x1:50, y1:707.18}; flipped at page height 800.
    expect(page.text![0]).toEqual({
      x0: 10,
      y0: 92.82,
      x1: 50,
      y1: 100,
      text: 'Hg',
      mergedItems: 1,
    });
  });

  it('keeps the full-em box when the content carries no styles map at all', async () => {
    const renderer = new PdfRenderer(
      fakeGeometryLoader([
        {
          viewport: idViewport(600, 800),
          textItems: [
            {
              str: 'Hg',
              transform: [1, 0, 0, 1, 10, 700],
              width: 40,
              height: 10,
              fontName: 'g_d0_f1',
            },
          ],
        },
      ]),
    );
    const page = (await renderer.geometry({ pdfPath, kinds: ['text'] })).pages[0]!;
    expect(page.text![0]?.y0).toBe(90);
  });

  it.each([
    ['a fontName with no entry in the map', 'g_d0_f9', {}],
    ['a NaN ascent (Symbol, ZapfDingbats)', 'g_d0_f1', { g_d0_f1: { ascent: Number.NaN } }],
    ['a style with no ascent property (an untranslatable font)', 'g_d0_f1', { g_d0_f1: {} }],
  ])('keeps the full-em box for %s', async (_label, fontName, styles) => {
    const renderer = new PdfRenderer(
      fakeGeometryLoader([
        {
          viewport: idViewport(600, 800),
          styles,
          textItems: [
            { str: 'Hg', transform: [1, 0, 0, 1, 10, 700], width: 40, height: 10, fontName },
          ],
        },
      ]),
    );
    const page = (await renderer.geometry({ pdfPath, kinds: ['text'] })).pages[0]!;
    // 800 - (700 + 10). Not 92 (a 0.8 default), not 92.82 (some other font's metrics).
    expect(page.text![0]?.y0).toBe(90);
  });

  it('carries the vertical flag through, so a vertical item is boxed down its column', async () => {
    const renderer = new PdfRenderer(
      fakeGeometryLoader([
        {
          viewport: idViewport(600, 800),
          styles: { g_d0_f1: { ascent: 0.88, vertical: true } },
          textItems: [
            // pdf.js's vertical shape: width is the em ACROSS the column, height the advance DOWN it.
            {
              str: '縦書',
              transform: [12, 0, 0, 12, 100, 700],
              width: 12,
              height: 48,
              fontName: 'g_d0_f1',
            },
          ],
        },
      ]),
    );
    const page = (await renderer.geometry({ pdfPath, kinds: ['text'] })).pages[0]!;
    // User space {x0:94, y0:652, x1:106, y1:700} -> top-left at page height 800.
    expect(page.text![0]?.x0).toBe(94);
    expect(page.text![0]?.x1).toBe(106);
    expect(page.text![0]?.y0).toBe(100);
    expect(page.text![0]?.y1).toBe(148);
  });

  it('reads a REAL Helvetica ascent out of the installed pdf.js, in fractions of the em', async () => {
    // The units claim, pinned against the real library rather than against a fake: pdf.js
    // normalizes every ascent producer (the /Ascent descriptor over PDF_GLYPH_SPACE_UNITS, or
    // hhea.ascender over head.unitsPerEm) into a FRACTION OF THE EM before it reaches `styles`.
    // Helvetica's is 718/1000. If that normalization ever changed — or if this code started
    // treating the number as points or as thousandths — this box would be wrong by ~1000x and
    // the assertion below could not pass.
    const realPdf = path.join(dir, 'real.pdf');
    const pageHeight = 100;
    await writeFile(realPdf, minimalPdf(1, 200, pageHeight, { text: () => 'Helvetica' }));
    const page = (await new PdfRenderer().geometry({ pdfPath: realPdf, kinds: ['text'] }))
      .pages[0]!;
    expect(page.text).toHaveLength(1);
    const box = page.text![0]!;
    expect(box.text).toBe('Helvetica');
    // Drawn by the helper at 12pt with its baseline at user-space y = pageHeight - 30.
    const baselineTopLeft = 30;
    expect(box.y1).toBeCloseTo(baselineTopLeft, 6);
    const height = box.y1 - box.y0;
    expect(height).toBeCloseTo(12 * 0.718, 2);
    // Emphatically neither the full em (12) nor pdf.js's own 0.8 text-layer default (9.6).
    expect(height).toBeLessThan(12);
    expect(Math.abs(height - 9.6)).toBeGreaterThan(0.5);
  });
});

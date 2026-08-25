import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_MAX_EDGE_PX = 1600;
export const HARD_MAX_EDGE_PX = 4000;
export const MAX_PAGES_PER_CALL = 8;

/** A crop, as fractions of the page box, origin top-left, both ends in [0,1]. */
export interface ClipFractions {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface RenderRequest {
  pdfPath: string;
  /** Directory the PNGs are written to; created if absent. Never inside a project. */
  outDir: string;
  /** 1-based page numbers, in the order given. Defaults to every page. */
  pages?: number[];
  /** Target resolution. When given it sets the scale directly and beats `maxEdgePx`. */
  dpi?: number;
  /** Longest edge of the *returned* image in px. Default DEFAULT_MAX_EDGE_PX. */
  maxEdgePx?: number;
  clip?: ClipFractions;
}

export interface RenderedPage {
  page: number;
  pngPath: string;
  /** The PNG bytes, so a caller can inline them without a second read. */
  png: Uint8Array;
  widthPx: number;
  heightPx: number;
  /** Resolution actually rendered at, one decimal place. */
  dpi: number;
  /** True when the request was reduced to fit HARD_MAX_EDGE_PX. */
  clamped: boolean;
  /** The page box in PostScript points (72pt = 1in) — a figure whose own box is a few pt too small shows up here. */
  pageWidthPt: number;
  pageHeightPt: number;
  bytes: number;
}

export interface RenderResult {
  pageCount: number;
  pages: RenderedPage[];
  /** Pages asked for (or implied by the default) that the per-call cap left out. */
  skippedPages: number[];
}

export class PdfRenderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PdfRenderError';
  }
}

export interface PdfRenderService {
  pageCount(pdfPath: string): Promise<number>;
  render(req: RenderRequest): Promise<RenderResult>;
  /** Whether the native canvas backend rasterization needs is installed and loadable. */
  canRasterize(): Promise<boolean>;
}

/** Throws PdfRenderError unless every edge is finite, within [0,1], and x1>x0, y1>y0. */
export function validateClip(clip: ClipFractions): void {
  const { x0, y0, x1, y1 } = clip;
  for (const [name, v] of [
    ['x0', x0],
    ['y0', y0],
    ['x1', x1],
    ['y1', y1],
  ] as const) {
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      throw new PdfRenderError(
        `Invalid clip: ${name}=${v} is not a finite number in [0, 1] (clip: ${JSON.stringify(clip)})`,
      );
    }
  }
  if (!(x1 > x0)) {
    throw new PdfRenderError(
      `Invalid clip: x1 (${x1}) must be greater than x0 (${x0}) (clip: ${JSON.stringify(clip)})`,
    );
  }
  if (!(y1 > y0)) {
    throw new PdfRenderError(
      `Invalid clip: y1 (${y1}) must be greater than y0 (${y0}) (clip: ${JSON.stringify(clip)})`,
    );
  }
}

/**
 * The scale to render at, and whether the hard pixel cap reduced it.
 * `widthPt`/`heightPt` are the *clipped* dimensions — the budget is about the returned image.
 */
export function fitScale(
  widthPt: number,
  heightPt: number,
  opts: { dpi?: number; maxEdgePx?: number },
): { scale: number; clamped: boolean } {
  const longestPt = Math.max(widthPt, heightPt);
  // A page box of zero area is malformed, but it reaches here from a document rather than from the
  // caller, so it must not divide by zero and hand back a NaN canvas size two lines later.
  if (!(longestPt > 0)) {
    throw new PdfRenderError(
      `Cannot render a page whose box has no area (${widthPt} x ${heightPt} pt).`,
    );
  }
  const base =
    opts.dpi !== undefined ? opts.dpi / 72 : (opts.maxEdgePx ?? DEFAULT_MAX_EDGE_PX) / longestPt;
  if (longestPt * base > HARD_MAX_EDGE_PX) {
    return { scale: HARD_MAX_EDGE_PX / longestPt, clamped: true };
  }
  return { scale: base, clamped: false };
}

/** scale -> dpi, rounded to one decimal place. dpi = scale * 72. */
export function effectiveDpi(scale: number): number {
  return Math.round(scale * 72 * 10) / 10;
}

/**
 * Which pages to render and which the cap left out.
 * `undefined` means every page. Throws PdfRenderError naming the page and the page count for a
 * page outside [1, pageCount] or a non-integer. Duplicates are collapsed, first occurrence wins.
 * At most MAX_PAGES_PER_CALL are rendered; the remainder come back as `skipped`.
 */
export function selectPages(
  requested: number[] | undefined,
  pageCount: number,
): { pages: number[]; skipped: number[] } {
  const source = requested ?? Array.from({ length: pageCount }, (_, i) => i + 1);
  const seen = new Set<number>();
  const unique: number[] = [];
  for (const p of source) {
    if (!Number.isInteger(p) || p < 1 || p > pageCount) {
      throw new PdfRenderError(
        `Page ${p} is out of range: this document has ${pageCount} page(s).`,
      );
    }
    if (!seen.has(p)) {
      seen.add(p);
      unique.push(p);
    }
  }
  const pages = unique.slice(0, MAX_PAGES_PER_CALL);
  const skipped = unique.slice(MAX_PAGES_PER_CALL);
  return { pages, skipped };
}

/**
 * Deterministic file name. Unclipped: `page-3.png`. Clipped: the fractions x1000, zero-padded to
 * 4 digits, so two different crops of one page never overwrite each other and nothing in the name
 * is illegal on Windows: `page-3-clip-0000-0000-0500-0300.png`.
 */
export function pngName(page: number, clip?: ClipFractions): string {
  if (!clip) {
    return `page-${page}.png`;
  }
  const part = (v: number) => String(Math.round(v * 1000)).padStart(4, '0');
  return `page-${page}-clip-${part(clip.x0)}-${part(clip.y0)}-${part(clip.x1)}-${part(clip.y1)}.png`;
}

const FULL_CLIP: ClipFractions = { x0: 0, y0: 0, x1: 1, y1: 1 };

const NAPI_CANVAS = '@napi-rs/canvas';

interface PngCanvas {
  toBuffer(mime: 'image/png'): Buffer;
}

interface CanvasEntry {
  canvas: PngCanvas;
  context: unknown;
}

interface CanvasFactoryLike {
  create(width: number, height: number): CanvasEntry;
  destroy(entry: CanvasEntry): void;
}

/**
 * Whether a thrown error means "the native canvas backend is not installed".
 *
 * Two shapes, because the backend is load-bearing in two different places. The obvious one is the
 * `require('@napi-rs/canvas')` inside pdf.js's `NodeCanvasFactory`, which fails with
 * MODULE_NOT_FOUND when a page is rendered. The non-obvious one is that **opening** a document
 * fails too: pdf.js expects DOM geometry globals in Node, and it is `@napi-rs/canvas` that
 * installs them — so with the backend absent, `getDocument` dies on `DOMMatrix is not defined`
 * long before any canvas is asked for. That is why `pageCount` needs the backend as much as
 * `render` does, and why neither may report the failure as a broken PDF.
 */
export function isNativeCanvasMissing(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  // Deliberately keyed on the message naming the backend, NOT on a bare MODULE_NOT_FOUND code:
  // `openDocument` imports pdfjs-dist first, so a broken install of *that* also arrives here with
  // ERR_MODULE_NOT_FOUND, and telling the user to install @napi-rs/canvas — which is already there
  // — sends them after the wrong package. Node's message always names the module it could not
  // find, so the narrower test loses nothing.
  const code = (err as NodeJS.ErrnoException).code;
  if (
    (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') &&
    err.message.includes(NAPI_CANVAS)
  ) {
    return true;
  }
  if (err.message.includes(NAPI_CANVAS)) {
    return true;
  }
  // The DOM globals pdf.js reaches for in Node, all supplied by the same backend.
  return /\b(DOMMatrix|ImageData|Path2D|OffscreenCanvas) is not defined\b/.test(err.message);
}

function nativeCanvasError(cause: unknown): PdfRenderError {
  return new PdfRenderError(
    'Reading the PDF needs the native canvas backend @napi-rs/canvas, which is not installed on ' +
      'this machine (it is an optional dependency, skipped on unsupported platforms or by ' +
      "--omit=optional). Install it with `npm i @napi-rs/canvas` in the server's directory. " +
      'This affects render_pages and the pageCount compile reports, and nothing else — compiling, ' +
      'the viewer, editing and the whole git side work without it.',
    { cause },
  );
}

/** The slice of pdf.js's runtime API this service uses. */
interface PdfjsLike {
  getDocument(src: { data: Uint8Array; verbosity?: number }): {
    promise: Promise<PdfjsDocument>;
    destroy(): Promise<void>;
  };
}

/**
 * How pdf.js is obtained. Injectable for one reason: the interesting failure of this service is a
 * machine without the native canvas backend, where pdf.js cannot open a document at all — and a
 * test cannot uninstall an optional dependency. Without this seam that path is only reachable by
 * patching the module loader, which is why it shipped unpinned the first time.
 */
export type PdfjsLoader = () => Promise<PdfjsLike>;

const loadPdfjsDefault: PdfjsLoader = async () =>
  (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsLike;

/**
 * A one-page, empty PDF used only to probe that pdf.js can open and rasterize on this machine.
 * Built rather than embedded so the byte offsets in its xref table cannot rot.
 */
function probePdf(): Uint8Array {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Resources << >> >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

export class PdfRenderer implements PdfRenderService {
  private readonly loadPdfjs: PdfjsLoader;

  constructor(loadPdfjs: PdfjsLoader = loadPdfjsDefault) {
    this.loadPdfjs = loadPdfjs;
  }

  async pageCount(pdfPath: string): Promise<number> {
    const { doc, destroy } = await this.openDocument(pdfPath);
    try {
      return doc.numPages;
    } finally {
      await destroy();
    }
  }

  async render(req: RenderRequest): Promise<RenderResult> {
    const clip = req.clip;
    if (clip) {
      validateClip(clip);
    }
    const effectiveClip = clip ?? FULL_CLIP;

    const { doc, destroy } = await this.openDocument(req.pdfPath);
    try {
      const pageCount = doc.numPages;
      const { pages: selected, skipped } = selectPages(req.pages, pageCount);

      await mkdir(req.outDir, { recursive: true });

      const rendered: RenderedPage[] = [];
      for (const pageNum of selected) {
        rendered.push(
          await this.renderOnePage(doc, pageNum, req.outDir, effectiveClip, {
            dpi: req.dpi,
            maxEdgePx: req.maxEdgePx,
          }),
        );
      }

      return { pageCount, pages: rendered, skippedPages: skipped };
    } finally {
      await destroy();
    }
  }

  /**
   * Open and rasterize a one-page probe document.
   *
   * This asks the question `doctor` actually reports on, rather than a proxy for it. Requiring
   * `@napi-rs/canvas` from *this* module and finding it says little: pdf.js resolves the backend
   * from its own location (the same under a hoisted npm install, not necessarily under a nested or
   * pnpm layout), and it needs specific globals — `DOMMatrix`, `Path2D` — that a backend version
   * could stop supplying while still importing cleanly. Driving a real document through the real
   * code path cannot be wrong about either. Never throws.
   */
  async canRasterize(): Promise<boolean> {
    try {
      const { doc, destroy } = await this.openBytes(probePdf(), '<probe>');
      try {
        const page = await doc.getPage(1);
        const factory = doc.canvasFactory as CanvasFactoryLike;
        const entry = factory.create(1, 1);
        try {
          await page.render({
            canvas: entry.canvas,
            viewport: page.getViewport({ scale: 1 }),
            background: '#ffffff',
          }).promise;
        } finally {
          factory.destroy(entry);
          page.cleanup();
        }
        return true;
      } finally {
        await destroy();
      }
    } catch {
      return false;
    }
  }

  private async openDocument(
    pdfPath: string,
  ): Promise<{ doc: PdfjsDocument; destroy: () => Promise<void> }> {
    let data: Uint8Array;
    try {
      data = new Uint8Array(await readFile(pdfPath));
    } catch (err) {
      throw new PdfRenderError(`Could not read PDF at ${pdfPath}: ${(err as Error).message}`, {
        cause: err,
      });
    }
    return this.openBytes(data, pdfPath);
  }

  /** Open already-read bytes. Split out so the probe document never needs a file on disk. */
  private async openBytes(
    data: Uint8Array,
    label: string,
  ): Promise<{ doc: PdfjsDocument; destroy: () => Promise<void> }> {
    try {
      const pdfjs = await this.loadPdfjs();
      // `verbosity: 0` (ERRORS) because stdout is this server's JSON-RPC channel and pdf.js's
      // `info()` writes to `console.info`, which in Node is stdout. It is defence in depth
      // rather than a live fix: `info()` only fires at verbosity >= INFOS (5) and the default is
      // WARNINGS (1), while `warn()` goes to stderr — so no message reaches stdout today. Keep it
      // anyway, since the cost is one property and the failure it prevents is a corrupted channel.
      const loadingTask = pdfjs.getDocument({ data, verbosity: 0 });
      const doc = await loadingTask.promise;
      return { doc, destroy: () => loadingTask.destroy() };
    } catch (err) {
      // Ask this first: with the backend absent every PDF fails here, and calling that "failed to
      // open" sends the caller to look for a corrupt document that is perfectly fine.
      if (isNativeCanvasMissing(err)) {
        throw nativeCanvasError(err);
      }
      throw new PdfRenderError(`Failed to open PDF at ${label}: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }

  private async renderOnePage(
    doc: PdfjsDocument,
    pageNum: number,
    outDir: string,
    clip: ClipFractions,
    opts: { dpi?: number; maxEdgePx?: number },
  ): Promise<RenderedPage> {
    const page = await doc.getPage(pageNum);
    try {
      const base = page.getViewport({ scale: 1 });
      const pageWidthPt = base.width;
      const pageHeightPt = base.height;

      const clippedWidthPt = pageWidthPt * (clip.x1 - clip.x0);
      const clippedHeightPt = pageHeightPt * (clip.y1 - clip.y0);

      const { scale, clamped } = fitScale(clippedWidthPt, clippedHeightPt, opts);

      const widthPx = Math.max(1, Math.round(clippedWidthPt * scale));
      const heightPx = Math.max(1, Math.round(clippedHeightPt * scale));

      const viewport = page.getViewport({
        scale,
        offsetX: -pageWidthPt * scale * clip.x0,
        offsetY: -pageHeightPt * scale * clip.y0,
      });

      const factory = doc.canvasFactory as CanvasFactoryLike;
      const entry = factory.create(widthPx, heightPx);
      try {
        try {
          await page.render({ canvas: entry.canvas, viewport, background: '#ffffff' }).promise;
        } catch (err) {
          if (isNativeCanvasMissing(err)) {
            throw nativeCanvasError(err);
          }
          throw err;
        }

        const png = entry.canvas.toBuffer('image/png');
        const pngPath = path.join(outDir, pngName(pageNum, clip === FULL_CLIP ? undefined : clip));
        await writeFile(pngPath, png);

        return {
          page: pageNum,
          pngPath,
          png: new Uint8Array(png),
          widthPx,
          heightPx,
          dpi: effectiveDpi(scale),
          clamped,
          pageWidthPt,
          pageHeightPt,
          bytes: png.length,
        };
      } finally {
        factory.destroy(entry);
      }
    } finally {
      page.cleanup();
    }
  }
}

// Minimal structural typing over the pieces of pdfjs-dist's runtime API this service uses.
// pdfjs-dist types `canvasFactory` as `Object` (see api.d.ts), so we narrow it ourselves at the
// one call site above rather than threading `any` through the class.
interface PdfjsViewport {
  width: number;
  height: number;
}

interface PdfjsPage {
  getViewport(opts: { scale: number; offsetX?: number; offsetY?: number }): PdfjsViewport;
  render(opts: { canvas: PngCanvas; viewport: PdfjsViewport; background?: string }): {
    promise: Promise<void>;
  };
  cleanup(): void;
}

interface PdfjsDocument {
  numPages: number;
  canvasFactory: unknown;
  getPage(pageNumber: number): Promise<PdfjsPage>;
}

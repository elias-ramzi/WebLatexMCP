import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Box, Matrix, TextItemLike } from '../lib/pdfGeometry.js';
import {
  IDENTITY,
  multiply,
  transformedBoxBounds,
  roundBox,
  mergeTextLines,
  hasNonFiniteEdge,
} from '../lib/pdfGeometry.js';

export const DEFAULT_MAX_EDGE_PX = 1600;
export const HARD_MAX_EDGE_PX = 4000;
export const MAX_PAGES_PER_CALL = 8;
/** Pages per pdf_geometry call. Lower than MAX_PAGES_PER_CALL: a page of text lines is a lot of
 *  structured output, where a page of PNG is one image. */
export const MAX_GEOMETRY_PAGES = 4;
/** Per-page caps, so a dense page cannot produce unbounded output. */
export const MAX_TEXT_LINES_PER_PAGE = 300;
export const MAX_IMAGE_RECTS_PER_PAGE = 100;

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

export type GeometryKind = 'text' | 'images';

export interface GeometryBox extends Box {
  /** Present on text boxes only. */
  text?: string;
  /** Present on text boxes only: how many pdf.js text items (`mergeTextLines`) were merged into
   *  this line — a rough signal of merge quality, not part of the box geometry itself. */
  mergedItems?: number;
  /** Present on image boxes only: 'image' for an image XObject, 'form' for a form XObject. */
  source?: 'image' | 'form';
  /**
   * Present (and `true`) only on a 'form' box for which no real bounding box could be recovered —
   * neither the form's own explicit `/BBox` nor a transparency group's — so the walk fell back to
   * the unit square under the accumulated CTM. This is NOT a measured placement rectangle; it is
   * frequently far smaller (or otherwise unrelated) than the actual figure, and must never be used
   * for a collision computation against another box.
   */
  approximate?: true;
  /**
   * Present (and `true`) on a box computed while the walk's CTM was known to be unusable — a
   * document-controlled `cm` operand, or a form XObject's own `/Matrix`, whose multiply overflowed
   * to a non-finite value and was therefore refused (see `applyCtm`). The refusal keeps the last
   * known-good CTM, so the numbers below are finite and plausible, but they are measured against a
   * transform the document did not ask for. This is NOT a measured placement and must NEVER be
   * used for a collision computation against another box.
   *
   * Distinct from `approximate`, and a box can carry both: `approximate` says the box's *extent*
   * could not be recovered (the unit-square fallback stood in for a real bbox), while
   * `unreliableCtm` says its *position* was computed under a transform that is not the document's.
   * The flag is stack-scoped — it is pushed and popped with the CTM by `save`/`restore` and by the
   * implicit save/restore around `paintFormXObjectBegin`/`End` — so a poison latched inside a `q`
   * stops at the matching `Q`, while one latched at depth 0 with no enclosing `save` correctly
   * marks every remaining box on the page.
   */
  unreliableCtm?: true;
}

export interface GeometryPage {
  page: number;
  pageWidthPt: number;
  pageHeightPt: number;
  text?: GeometryBox[];
  images?: GeometryBox[];
  textOmitted: number;
  imagesOmitted: number;
  /**
   * Image/form paint operators skipped because they were inside an annotation appearance stream
   * (`beginAnnotation`…`endAnnotation`), where the walk cannot vouch for a rectangle — see
   * `walkImageGeometry`. A counted gap, not a zero: the figures are there and this says how many
   * of them went unreported.
   *
   * Counted SEPARATELY from `imagesOmitted`, which this file's comments reserve strictly for boxes
   * cut by the per-page cap (`MAX_IMAGE_RECTS_PER_PAGE`). Folding the two together would say a
   * rectangle existed and was trimmed for size when in fact none was ever computed. Required, not
   * optional, so a future page-shape construction site cannot forget to say which it is.
   */
  annotationImagesSkipped: number;
}

export interface GeometryRequest {
  pdfPath: string;
  pages?: number[];
  kinds: GeometryKind[];
}

export interface GeometryResult {
  pageCount: number;
  pages: GeometryPage[];
  skippedPages: number[];
}

export interface PdfRenderService {
  pageCount(pdfPath: string): Promise<number>;
  render(req: RenderRequest): Promise<RenderResult>;
  /** Whether the native canvas backend rasterization needs is installed and loadable. */
  canRasterize(): Promise<boolean>;
  /** Text-line and image/form-XObject placement geometry for the requested pages, in PDF points. */
  geometry(req: GeometryRequest): Promise<GeometryResult>;
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
 * At most `cap` (default MAX_PAGES_PER_CALL) are selected; the remainder come back as `skipped`.
 * `cap` is a parameter — not always MAX_PAGES_PER_CALL — because `pdf_geometry` uses the same
 * dedup/range-check contract at its own, lower MAX_GEOMETRY_PAGES cap; every existing call site
 * that omits it keeps today's behaviour unchanged.
 */
export function selectPages(
  requested: number[] | undefined,
  pageCount: number,
  cap: number = MAX_PAGES_PER_CALL,
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
  const pages = unique.slice(0, cap);
  const skipped = unique.slice(cap);
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
      'This affects render_pages, pdf_geometry, and the pageCount compile reports, and nothing ' +
      'else — compiling, the viewer, editing and the whole git side work without it.',
    { cause },
  );
}

/**
 * The operator codes `geometry` walks. Named individually — not a generic `Record<string,
 * number>` — so a typo in *this file's own* references (`ops.saev`) is a compile error.
 *
 * That is NOT the same guarantee as "a renamed op in a future pdf.js surfaces as a type error",
 * which an earlier version of this comment claimed: `PdfjsOps` is a locally-declared interface
 * over a module obtained via `PdfjsLoader` and cast from `unknown` (see `PdfjsLike` below), so
 * nothing here checks these names against the real pdf.js `OPS` table. If pdf.js renamed or
 * removed one of these, `ops.<name>` would simply be `undefined` at runtime — which never equals
 * a real `fnArray` entry (always a number), so the walk would silently find nothing for that op
 * and stay green. See the "pdf.js OPS table" describe block in test/unit/pdfRender.test.ts, which
 * pins every name here against the real, installed pdf.js module and is the thing that actually
 * catches a rename.
 */
interface PdfjsOps {
  save: number;
  restore: number;
  transform: number;
  paintImageXObject: number;
  paintImageMaskXObject: number;
  /** An image written inline in the content stream (`BI`…`ID`…`EI`) rather than referenced as an
   *  XObject — plausible from some PDF converters. Painted into the unit square under the current
   *  CTM exactly as `paintImageXObject` is: pdf.js's `CanvasGraphics.paintInlineImageXObject`
   *  scales by `(1/width, -1/height)` and then draws `(0, -height, width, height)`, which composes
   *  to `[0,1]x[0,1]` before the CTM. Verified against the installed pdf.js 6.1.200. */
  paintInlineImageXObject: number;
  /** A one-colour image mask, which pdf.js paints as a literal `fillRect(0, 0, 1, 1)` under the
   *  current CTM — the unit square again. Verified against the installed pdf.js 6.1.200.
   *
   *  These two are handled while the four BATCHED forms in issue #80 §5
   *  (`paintImageXObjectRepeat`, `paintInlineImageXObjectGroup`, `paintImageMaskXObjectGroup`,
   *  `paintImageMaskXObjectRepeat`) are deliberately not, and the difference is reachability, not
   *  effort: those four exist only as an output of pdf.js's `QueueOptimizer`, and
   *  `page.getOperatorList()` requests `RenderingIntentFlag.OPLIST`, which selects `NullOptimizer`
   *  — whose `_optimize()` is a no-op. So no operator list this walk can ever receive contains
   *  one. These two, by contrast, are emitted by the EVALUATOR itself (`addImageOps(
   *  OPS.paintInlineImageXObject, …)` and `fn = OPS.paintSolidColorImageMask` in the worker), so
   *  they reach the walk unchanged. */
  paintSolidColorImageMask: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  /** Emitted around a form XObject that carries a `/Group` (transparency): the group's own
   *  `/BBox`/`/Matrix` move here because the form's own `paintFormXObjectBegin` args carry a null
   *  bbox in that case (see `buildFormXObject` in pdf.js's evaluator). */
  beginGroup: number;
  endGroup: number;
  /** The bracket pdf.js emits around each annotation's appearance stream, which is concatenated
   *  onto the page's own operator list. The walk uses this pair **only** to suppress emission
   *  between them and count what it suppressed — it deliberately does not model the annotation's
   *  own transform/matrix args, nor pdf.js's `baseTransform` (see `walkImageGeometry`). */
  beginAnnotation: number;
  endAnnotation: number;
}

/** The slice of pdf.js's runtime API this service uses. */
interface PdfjsLike {
  getDocument(src: { data: Uint8Array; verbosity?: number }): {
    promise: Promise<PdfjsDocument>;
    destroy(): Promise<void>;
  };
  /** Module-level operator-code table, used only by `geometry` to walk a page's operator list. */
  OPS: PdfjsOps;
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
   * Text-line and image/form-XObject placement geometry, in PDF points, origin top-left.
   *
   * Deliberately NOT general vector path geometry (`\fbox` rules, TikZ strokes): pdf.js hands
   * back raw path-construction operators in untransformed space, and replaying them is a graphics-
   * state interpreter — out of scope, per the tool's own description. A page that fails partway
   * (a malformed operator list) is rethrown as a PdfRenderError naming the page and the original
   * cause — a silent empty result would misreport real geometry as absent, which is worse than an
   * error naming the page.
   */
  async geometry(req: GeometryRequest): Promise<GeometryResult> {
    const { doc, destroy } = await this.openDocument(req.pdfPath);
    try {
      // Loaded *after* openDocument, not before: openDocument's catch is what classifies a
      // missing-backend failure into nativeCanvasError. Calling loadPdfjs() directly first would
      // let that same failure (pdf.js needs the backend just to import cleanly on some setups)
      // escape here as a raw "DOMMatrix is not defined" instead. By this point the module is
      // already loaded (openDocument just used it), so this second call is effectively free.
      const pdfjs = await this.loadPdfjs();
      const pageCount = doc.numPages;
      const { pages: selected, skipped } = selectPages(req.pages, pageCount, MAX_GEOMETRY_PAGES);

      const pages: GeometryPage[] = [];
      for (const pageNum of selected) {
        try {
          pages.push(await this.geometryForPage(doc, pageNum, req.kinds, pdfjs.OPS));
        } catch (err) {
          throw new PdfRenderError(
            `Failed to compute geometry for page ${pageNum}: ${(err as Error).message}`,
            { cause: err },
          );
        }
      }

      return { pageCount, pages, skippedPages: skipped };
    } finally {
      await destroy();
    }
  }

  private async geometryForPage(
    doc: PdfjsDocument,
    pageNum: number,
    kinds: GeometryKind[],
    ops: PdfjsOps,
  ): Promise<GeometryPage> {
    const page = await doc.getPage(pageNum);
    try {
      const viewport = page.getViewport({ scale: 1 });
      const pageWidthPt = viewport.width;
      const pageHeightPt = viewport.height;
      // pdf.js's own transform: user space -> viewport space, rotation and MediaBox origin
      // already applied (see PageViewport in the installed pdf.js). Using this instead of a
      // manual y-flip is what makes a page with a non-zero MediaBox origin or a /Rotate entry
      // (pdflscape landscape pages, most notably) come out right rather than silently wrong.
      const viewportTransform = viewport.transform as unknown as Matrix;

      let text: GeometryBox[] | undefined;
      let textOmitted = 0;
      if (kinds.includes('text')) {
        const content = await page.getTextContent();
        const items: TextItemLike[] = [];
        for (const raw of content.items) {
          // Marked-content items (only present when includeMarkedContent is requested, which this
          // call never does) carry neither field — skip anything that isn't a real text item, and
          // whitespace-only strings are handled by mergeTextLines itself.
          if (raw.transform === undefined || typeof raw.str !== 'string') {
            continue;
          }
          items.push({
            str: raw.str,
            transform: raw.transform as unknown as Matrix,
            width: raw.width ?? 0,
            height: raw.height ?? 0,
          });
        }
        const lines = mergeTextLines(items);
        const mapped = lines.map((l) => ({
          // Bounds of all four corners of the user-space box under the viewport transform, not
          // just two: under a 90/270 rotation the corners swap axes, and taking only two corners
          // (as a manual y-flip effectively did) silently mixes up width and height.
          ...roundBox(transformedBoxBounds(l.box, viewportTransform)),
          text: l.text,
          mergedItems: l.items,
        }));
        // Mirrors the image/form push sites below: a box whose edges come out non-finite is
        // dropped outright rather than reported, since a NaN/Infinity is not a measurement and
        // the tool's z.number() schema would otherwise reject it AFTER the handler returns —
        // outside errorResult, failing the whole call. mergeTextLines already drops a poisoned
        // item before it can contaminate a merged line's box (see pdfGeometry.ts), but the
        // viewport-transform multiply just above is a second place a finite user-space box can
        // still overflow (an item near the edge of the representable range, under a non-trivial
        // scale) — so this filter is defence in depth, not a duplicate of that guard. As with
        // imagesOmitted, a dropped non-finite line is never counted into textOmitted, which is
        // reserved for lines cut by the per-page cap below.
        const finite = mapped.filter((b) => !hasNonFiniteEdge(b));
        const capped = finite.slice(0, MAX_TEXT_LINES_PER_PAGE);
        textOmitted = finite.length - capped.length;
        text = capped;
      }

      let images: GeometryBox[] | undefined;
      let imagesOmitted = 0;
      // Kept apart from imagesOmitted on purpose: one counts rectangles the walk computed and then
      // trimmed for size, the other counts paint operators it never measured at all. See the field
      // doc comments on GeometryPage.
      let annotationImagesSkipped = 0;
      if (kinds.includes('images')) {
        const opList = await page.getOperatorList();
        const walked = walkImageGeometry(opList, ops, viewportTransform);
        const capped = walked.boxes.slice(0, MAX_IMAGE_RECTS_PER_PAGE);
        imagesOmitted = walked.boxes.length - capped.length;
        annotationImagesSkipped = walked.annotationImagesSkipped;
        images = capped;
      }

      return {
        page: pageNum,
        pageWidthPt,
        pageHeightPt,
        text,
        images,
        textOmitted,
        imagesOmitted,
        annotationImagesSkipped,
      };
    } finally {
      page.cleanup();
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
          // Encode too, not just paint: `render` proves the canvas can be created and drawn on,
          // but what the caller ultimately gets is a PNG, and that is a separate code path in the
          // backend. Probing one and reporting on the other is how `doctor` ends up green while
          // `render_pages` fails.
          entry.canvas.toBuffer('image/png');
        } finally {
          // Separate blocks so a throw in one teardown cannot skip the other — `renderOnePage`
          // nests them the same way, and the two paths should not differ.
          try {
            factory.destroy(entry);
          } finally {
            page.cleanup();
          }
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
  /**
   * pdf.js's own user-space -> viewport-space matrix, `[a,b,c,d,e,f]` in the same convention as
   * `Matrix` in pdfGeometry.ts. Only `geometry` reads this (`render`'s viewport use is limited to
   * `width`/`height`, since it hands the viewport straight to `page.render`) — rotation- and
   * MediaBox-origin-aware, which is exactly why `geometryForPage` uses it instead of a manual
   * y-flip. Verified against the installed pdf.js (`PageViewport` in legacy/build/pdf.mjs): at
   * scale 1 with no rotation and a MediaBox at the origin it is `[1,0,0,-1,0,pageHeightPt]` —
   * the same effect the old manual y-flip had — and it changes correctly under `/Rotate` and a
   * non-zero MediaBox origin, which the manual flip did not.
   */
  transform: number[];
}

/** One item of `getTextContent()`'s `items` array. pdf.js's own type is `TextItem |
 *  TextMarkedContent`; a marked-content item carries neither `transform` nor `str`, which is why
 *  both are optional here and `geometry` skips an item missing either. */
interface PdfjsTextItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
}

interface PdfjsTextContent {
  items: PdfjsTextItem[];
}

/** `getOperatorList()`'s result: parallel arrays of op codes and their argument tuples. */
interface PdfjsOperatorList {
  fnArray: number[];
  argsArray: unknown[][];
}

interface PdfjsPage {
  getViewport(opts: { scale: number; offsetX?: number; offsetY?: number }): PdfjsViewport;
  render(opts: { canvas: PngCanvas; viewport: PdfjsViewport; background?: string }): {
    promise: Promise<void>;
  };
  cleanup(): void;
  getTextContent(): Promise<PdfjsTextContent>;
  getOperatorList(): Promise<PdfjsOperatorList>;
}

interface PdfjsDocument {
  numPages: number;
  canvasFactory: unknown;
  getPage(pageNumber: number): Promise<PdfjsPage>;
}

/** A form's own bbox, or a pending transparency-group bbox, before either is bounds-checked. */
function boxOf(b: readonly number[]): Box {
  return { x0: b[0] as number, y0: b[1] as number, x1: b[2] as number, y1: b[3] as number };
}

/** The image/form-XObject unit square, in the local space a CTM/bbox maps out of. */
const UNIT_BOX: Box = { x0: 0, y0: 0, x1: 1, y1: 1 };

/**
 * `multiply(m, current)`, but conservatively keeps `current` unchanged when the result carries a
 * non-finite entry. `m` is document-controlled (a `cm` operator's operands, or a form XObject's
 * own `/Matrix`) and pdf.js checks its arity but not its finiteness — a hand-built content stream
 * carrying an oversized number overflows to `Infinity`, and `0 * Infinity` is `NaN`, so one bad
 * operand can turn `current` into a matrix full of non-finite entries. Left alone, that poisoned
 * CTM would apply to *every subsequent operator on the page*, not just the one that produced it —
 * turning one bad `cm` into wall-to-wall NaN boxes. Keeping the last known-good CTM instead is the
 * conservative choice: the page's remaining geometry stays usable, at the cost of one region that
 * is under-reported rather than reported as garbage.
 *
 * That choice is still right, but it is no longer *silent*. A refusal means every box drawn after
 * it is measured against a transform the document did not ask for, and comes back finite,
 * plausible and — until the caller is told — indistinguishable from a measurement. So the outcome
 * is reported rather than inferred. The flag exists because a refusal is not recoverable from the
 * return value: `multiply` allocates a fresh array every time, so `next === current` is never true
 * and could not have served as the test (an earlier version of this comment warned against it as
 * though it could); and comparing the six numbers instead would call a page poisoned for a
 * perfectly legitimate identity `cm`. Neither reading works, so the outcome is returned.
 */
function applyCtm(m: Matrix, current: Matrix): CtmUpdate {
  const next = multiply(m, current);
  return next.every((v) => Number.isFinite(v))
    ? { matrix: next, refused: false }
    : { matrix: current, refused: true };
}

/** The outcome of one `applyCtm` — the CTM to carry forward, and whether it is the document's. */
interface CtmUpdate {
  /** The composed matrix, or `current` unchanged when the multiply had to be refused. */
  matrix: Matrix;
  /** True when `matrix` is the last known-good CTM rather than what the document asked for. */
  refused: boolean;
}

/**
 * One entry of the walk's own CTM stack. The poison flag travels with the matrix rather than
 * beside it because the two are restored together: a `Q` that puts back a CTM from before a
 * refused `cm` also puts back the fact that nothing had been refused yet, and a flag kept in a
 * bare variable would outlive the state it describes and mark the rest of the page.
 */
interface CtmFrame {
  ctm: Matrix;
  poisoned: boolean;
}

/**
 * A transparency group's bbox/matrix, captured at `OPS.beginGroup` and consumed by the
 * `paintFormXObjectBegin` that immediately follows it when that form's own bbox arg is null (see
 * the function doc comment for why the two are equivalent).
 */
interface PendingGroupBox {
  bbox: readonly number[];
  /** The group's own matrix (`groupOptions.matrix` in pdf.js — the form's `/Matrix`, or null),
   *  applied to `bbox` before `ctm`. */
  matrix: Matrix | null;
  /** The CTM as it stood at `beginGroup` — i.e. *before* the form's own matrix multiply that the
   *  paired `paintFormXObjectBegin` applies. */
  ctm: Matrix;
}

/**
 * Walk a page's raw operator list to recover image/form XObject placement rectangles, mapped
 * through the page's own viewport transform (see `geometryForPage`) to top-left viewport space.
 *
 * The CTM stack tracked here is our own — it is not fed by pdf.js's `save`/`restore` execution
 * (that only happens when a page is actually rendered to a canvas). Three things about the stack
 * are load-bearing:
 *  - `OPS.restore` on an empty stack must not throw: a malformed/truncated content stream is a
 *    real condition a document-controlled operator list can produce, and a thrown error here
 *    would fail the whole page's geometry over one bad operator well past the images already
 *    found.
 *  - A `cm` operand (or a form's own `/Matrix`) is document-controlled and pdf.js checks its
 *    arity, not its finiteness — an oversized number overflows to `Infinity`/`NaN` (see
 *    `applyCtm`'s doc comment). Applying it anyway would poison the CTM for the rest of the page,
 *    so the update is skipped and the last known-good CTM is kept instead, and any box that still
 *    ends up with a non-finite edge (`hasNonFiniteEdge`) — e.g. from a directly non-finite bbox
 *    arg — is dropped rather than emitted, since a zod `z.number()` in the tool schema rejects
 *    both and the MCP SDK's post-handler output validation would otherwise fail the *whole* call
 *    with an unscrubbed, un-caught `McpError`, discarding every other page's geometry with it.
 *    Keeping the last good CTM leaves every *later* box on the page measured against a transform
 *    the document did not ask for, finite and plausible and, until #80 §2, unflagged — which is
 *    exactly the "a rectangle in the wrong place reads like a measurement" failure this tool
 *    exists to avoid. So a refusal latches a `poisoned` flag and every box emitted under it
 *    carries `unreliableCtm: true`. The flag lives on the CTM stack frame, not beside it, so it
 *    pops with the CTM at `restore`/`paintFormXObjectEnd`; one latched at depth 0 with no
 *    enclosing `save` therefore marks the rest of the page, which is correct — there is no
 *    known-good state left to return to. The `hasNonFiniteEdge` drop runs FIRST and still wins:
 *    a poisoned box whose edges come out non-finite is dropped, never emitted with a flag on it,
 *    because a flag describes a number and a NaN is not one.
 *  - `OPS.beginAnnotation`/`OPS.endAnnotation` bracket an annotation's appearance stream, which
 *    the worker concatenates onto the page's own operator list (reachable via `pdfcomment`, form
 *    fields, and `pdfpages` with links — NOT from plain `hyperref`: with no `/AP` the worker takes
 *    `_getOperatorListNoAppearance()` and emits no ops at all). pdf.js's own
 *    `CanvasGraphics.beginAnnotation` rebases the entire graphics state on `baseTransform` —
 *    `#restoreInitialState()` drains the whole state stack, then `resetCtxToDefault()`, then
 *    `setTransform(baseTransform)`, then the op's own transform and matrix — a base this walk
 *    never sees and cannot reconstruct from the operator list alone. Carrying the stale CTM across
 *    that boundary put every image inside an annotation at the wrong place, and consecutive
 *    annotations accumulated the drift. The resolved call is to emit NOTHING between the two ops
 *    and count what was suppressed (`annotationImagesSkipped`), rather than to model
 *    `baseTransform`: a gap that is counted is better than a rectangle nobody can vouch for, which
 *    is the same standard `omittedSnippetLocations` holds compile diagnostics to. The paint ops
 *    inside still run their stack bookkeeping — `paintFormXObjectBegin`/`End` push and pop as
 *    usual — so only the emission is suppressed and the walk stays balanced.
 *
 *    Leaving the bracket restores the state snapshotted on entry (a *copy* of the stack array,
 *    the current CTM and the poison flag). That is isolation, not `baseTransform` modelling, and
 *    it is deliberately not what pdf.js does: pdf.js drains the state stack at `beginAnnotation`
 *    and `endAnnotation` is asymmetric — it takes no args, never calls `restore()` and never puts
 *    the CTM back, so after an annotation pdf.js's own CTM is not the pre-annotation one either.
 *    Nothing normally follows an annotation block (they are appended last, one flat
 *    non-overlapping sequence per annotation), so in practice the restored state is never used;
 *    if a malformed stream did put content after one, the pre-annotation state is the only thing
 *    this walk still holds that it can vouch for. The stack is restored by splicing the snapshot
 *    back in rather than truncating to its old length, because an annotation's ops can pop BELOW
 *    the snapshot depth and a bare `length = n` would grow the array back with holes. An
 *    `endAnnotation` with no matching `beginAnnotation` is ignored outright — never allowed to
 *    drive the depth negative, which would leave the next real annotation unsuppressed — for the
 *    same reason `restore` on an empty stack does not throw: a truncated or malformed operator
 *    list is a real thing a document can produce.
 *  - Four paint operators emit a box, and all four are the SAME box: the unit square under the
 *    current CTM. `paintImageXObject` and `paintImageMaskXObject` were always handled;
 *    `paintInlineImageXObject` and `paintSolidColorImageMask` are #80 §5's two reachable gaps,
 *    closed here. See `PdfjsOps` for why the other four operators that issue names are NOT gaps
 *    this walk can ever see — the optimizer that produces them is never the one in play.
 *  - `paintFormXObjectBegin`/`paintFormXObjectEnd` push/pop their own CTM even though no explicit
 *    `OPS.save`/`OPS.restore` appears in the operator list around them — pdf.js's own
 *    `CanvasGraphics.paintFormXObjectBegin` calls `this.save()` internally when executing this op
 *    against a canvas, and this walk has to reproduce that rather than rely on paired save/restore
 *    operators that the evaluator never emits here.
 *  - A form XObject that carries a `/Group` (transparency) — common: pdfTeX copies an included
 *    PDF page's `/Group` onto the Form XObject, and Inkscape/matplotlib/TikZ output with
 *    isolation or `opacity` all carry one — reports its own `paintFormXObjectBegin` bbox arg as
 *    null; the evaluator moves the real bbox onto an `OPS.beginGroup` emitted immediately before
 *    it instead (`buildFormXObject` in the installed pdf.js's evaluator, confirmed against
 *    pdfjs-dist 6.1.200). Verified against `CanvasGraphics.beginGroup`/`paintFormXObjectBegin` in
 *    the same install: at the moment `beginGroup` runs, the ctx's current transform is the CTM
 *    *before* the form's own matrix has been applied (that happens inside the paired
 *    `paintFormXObjectBegin`, which runs next), and the group's bbox is clipped by that CTM after
 *    first being mapped through the group's own `matrix` (`groupOptions.matrix`, which is exactly
 *    the form's own `/Matrix`) — i.e. group.matrix is applied to the bbox BEFORE the CTM in force
 *    at `beginGroup` time. That pending bbox/matrix/CTM is captured here and consumed by the very
 *    next `paintFormXObjectBegin` when its own bbox arg is null, then cleared either way so it
 *    can never leak onto a later, unrelated form. When neither a form bbox nor a pending group
 *    bbox is available, the walk falls back to the unit square under the CTM (as before), but now
 *    flags the box `approximate: true` so a caller cannot mistake a ~1pt fallback rectangle for a
 *    measured placement.
 */
function walkImageGeometry(
  opList: PdfjsOperatorList,
  ops: PdfjsOps,
  viewportTransform: Matrix,
): { boxes: GeometryBox[]; annotationImagesSkipped: number } {
  const boxes: GeometryBox[] = [];
  const stack: CtmFrame[] = [];
  let current: Matrix = IDENTITY;
  let poisoned = false;
  let pendingGroup: PendingGroupBox | null = null;
  /** Nesting depth of beginAnnotation…endAnnotation. Non-zero means "emit nothing, count it".
   *  A depth rather than a boolean only because a malformed stream could nest the bracket; real
   *  annotation oplists arrive as a flat, non-overlapping sequence. */
  let annotationDepth = 0;
  let annotationImagesSkipped = 0;
  /** The walk's state as it stood at the OUTERMOST beginAnnotation, put back at the matching
   *  endAnnotation. See the doc comment: isolation, not baseTransform modelling.
   *
   *  `pendingGroup` is in here for the same reason the CTM is, and leaving it out was a real leak
   *  in both directions: a `beginGroup` inside the annotation whose form never arrived left its
   *  bbox sitting in the variable for the next form AFTER the bracket, which would then be
   *  measured with an annotation's extent; and a `pendingGroup` set before the bracket was
   *  consumed and cleared by the first form inside it (the consume runs before the
   *  annotationDepth check, so that the matching End stays balanced), silently downgrading the
   *  real post-bracket form to its `approximate` unit-square fallback. Snapshot everything the
   *  walk carries across operators, not only the parts with a stack. */
  let preAnnotation: {
    stack: CtmFrame[];
    current: Matrix;
    poisoned: boolean;
    pendingGroup: PendingGroupBox | null;
  } | null = null;

  const toViewport = (box: Box, ctm: Matrix): Box =>
    roundBox(transformedBoxBounds(box, multiply(ctm, viewportTransform)));

  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];

    if (fn === ops.save) {
      stack.push({ ctm: current, poisoned });
    } else if (fn === ops.restore) {
      const prev = stack.pop();
      if (prev !== undefined) {
        current = prev.ctm;
        // Popped together with the CTM it describes: going back to a matrix from before a refused
        // `cm` also goes back to not having refused one. A bare restore against an empty stack
        // clears nothing, because there is no known-good state to go back to.
        poisoned = prev.poisoned;
      }
    } else if (fn === ops.beginAnnotation) {
      // Snapshot only on the way in to the OUTERMOST bracket — an inner one would otherwise
      // overwrite the state the outer one has to put back. The stack is COPIED, not aliased:
      // the annotation's own ops mutate the live array in place.
      if (annotationDepth === 0) {
        preAnnotation = { stack: [...stack], current, poisoned, pendingGroup };
      }
      annotationDepth++;
    } else if (fn === ops.endAnnotation) {
      // An unmatched end is ignored rather than driving the depth negative, which would leave the
      // NEXT real annotation at depth 0 and unsuppressed — the same fail-safe rule as restore on
      // an empty stack, and for the same reason.
      if (annotationDepth > 0) {
        annotationDepth--;
        if (annotationDepth === 0 && preAnnotation) {
          // splice, not `stack.length = n`: the annotation's ops can pop below the snapshot depth,
          // and truncating an already-shorter array would grow it back full of holes.
          stack.splice(0, stack.length, ...preAnnotation.stack);
          current = preAnnotation.current;
          poisoned = preAnnotation.poisoned;
          pendingGroup = preAnnotation.pendingGroup;
          preAnnotation = null;
        }
      }
    } else if (fn === ops.transform) {
      // Guarded, not a bare multiply: see applyCtm's doc comment — a document-controlled operand
      // here must not poison every box drawn for the rest of the page. The refusal is latched
      // rather than dropped on the floor, so the boxes that follow say they were measured under a
      // CTM that is not the document's.
      const update = applyCtm(args as unknown as Matrix, current);
      current = update.matrix;
      if (update.refused) {
        poisoned = true;
      }
    } else if (
      fn === ops.paintImageXObject ||
      fn === ops.paintImageMaskXObject ||
      fn === ops.paintInlineImageXObject ||
      fn === ops.paintSolidColorImageMask
    ) {
      if (annotationDepth > 0) {
        // Inside an annotation appearance stream the walk has no base transform it can vouch for,
        // so the placement is a counted gap rather than a rectangle. See the doc comment.
        annotationImagesSkipped++;
        continue;
      }
      const box = toViewport(UNIT_BOX, current);
      // A non-finite edge here means this operator list is not something we can measure — never
      // something we approximated — so, unlike the `approximate` fallback below, the box is
      // dropped outright rather than emitted flagged. This runs BEFORE the unreliableCtm flag is
      // applied, and wins: drop still beats flag, because a flag qualifies a number and a
      // NaN/Infinity edge is not one.
      if (!hasNonFiniteEdge(box)) {
        boxes.push({
          ...box,
          source: 'image',
          ...(poisoned ? { unreliableCtm: true as const } : {}),
        });
      }
    } else if (fn === ops.beginGroup) {
      const groupOptions = (Array.isArray(args) ? args[0] : undefined) as
        | { bbox?: ArrayLike<number> | null; matrix?: number[] | null }
        | undefined;
      const bbox = groupOptions?.bbox;
      if (bbox && bbox.length === 4) {
        const m = groupOptions?.matrix;
        pendingGroup = {
          bbox: Array.from(bbox),
          matrix: Array.isArray(m) && m.length === 6 ? (m as unknown as Matrix) : null,
          ctm: current,
        };
      } else {
        pendingGroup = null;
      }
    } else if (fn === ops.endGroup) {
      // Cleared unconditionally: normally already consumed by the paired paintFormXObjectBegin,
      // but a truncated/malformed stream could reach endGroup without one ever running.
      pendingGroup = null;
    } else if (fn === ops.paintFormXObjectBegin) {
      // Implicit save (see the doc comment above) — always pushed, even when the form carries no
      // matrix of its own, so the matching End always has something to pop. This runs inside an
      // annotation too: only the EMISSION is suppressed in there, never the bookkeeping, or the
      // walk would come out of the bracket unbalanced.
      stack.push({ ctm: current, poisoned });
      const [matrix, bbox] = (Array.isArray(args) ? args : [null, null]) as [
        number[] | null,
        number[] | null,
      ];
      if (matrix) {
        // Same guard as OPS.transform: the form's own /Matrix is document-controlled too, and a
        // refusal here latches the same flag — the form's own box is the first thing measured
        // under the CTM it just failed to update.
        const update = applyCtm(matrix as unknown as Matrix, current);
        current = update.matrix;
        if (update.refused) {
          poisoned = true;
        }
      }
      // Consume (and clear) any pending group bbox now, whether or not it ends up used below, so
      // it can never be reused by a later, unrelated form.
      const pending = pendingGroup;
      pendingGroup = null;

      if (annotationDepth > 0) {
        // As for images: a counted gap, not a rectangle. Reached only after the push and the
        // matrix bookkeeping above, so the matching paintFormXObjectEnd still pops what it should.
        annotationImagesSkipped++;
        continue;
      }

      let box: Box;
      let ctm: Matrix;
      let approximate: true | undefined;
      if (bbox && bbox.length === 4) {
        box = boxOf(bbox);
        ctm = current;
      } else if (pending) {
        box = boxOf(pending.bbox);
        ctm = pending.matrix ? multiply(pending.matrix, pending.ctm) : pending.ctm;
      } else {
        box = UNIT_BOX;
        ctm = current;
        approximate = true;
      }
      const viewportBox = toViewport(box, ctm);
      // As above: a NaN/Infinity edge here (a poisoned bbox arg, or a group bbox mapped through a
      // non-finite matrix) means "not measurable", so the box is dropped rather than flagged
      // approximate — approximate is documented as a real placement the walk could not bound,
      // which a non-finite box is not.
      if (!hasNonFiniteEdge(viewportBox)) {
        boxes.push({
          ...viewportBox,
          source: 'form',
          ...(approximate ? { approximate } : {}),
          // A form box can carry both flags: `approximate` says its extent is a fallback,
          // `unreliableCtm` says its position is not the document's. They answer different
          // questions, so neither subsumes the other.
          ...(poisoned ? { unreliableCtm: true as const } : {}),
        });
      }
    } else if (fn === ops.paintFormXObjectEnd) {
      const prev = stack.pop();
      if (prev !== undefined) {
        current = prev.ctm;
        poisoned = prev.poisoned;
      }
    }
    // Everything else (path construction, text, colour, shading, ...) is ignored: general vector
    // path geometry is explicitly out of scope (see the class method's doc comment).
  }

  return { boxes, annotationImagesSkipped };
}

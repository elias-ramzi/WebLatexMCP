import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { detectRootFile } from '../lib/rootFile.js';
import { locateProjectPdf } from '../lib/pdfLocate.js';
import { toPosixOut } from '../lib/paths.js';
import { buildDir } from '../services/compiler.js';
import { HARD_MAX_EDGE_PX, MAX_PAGES_PER_CALL, PdfRenderError } from '../services/pdfRender.js';
import type { RenderResult } from '../services/pdfRender.js';
import { planInlining } from '../lib/inlineBudget.js';
import { readAuxFloats } from '../lib/auxFloats.js';
import {
  planLabelPages,
  labelRefusalMessage,
  labelResolutionNote,
  labelPageRangeMessage,
  describeResolvedLabels,
  LABEL_LOOKUP_MAX,
  MAX_LABELS_PER_CALL,
} from '../lib/labelPages.js';
import type { LabelPagePlan } from '../lib/labelPages.js';

const inputSchema = {
  project: z.string().optional(),
  rootFile: z
    .string()
    .optional()
    .describe(
      'Root .tex file, used to select the build-dir PDF to read when the surfaced workspace ' +
        'copy is not being used (workspace-local mode prefers <workspace>/<id>.pdf and never ' +
        'consults this). Auto-detected when omitted.',
    ),
  pages: z
    .array(z.number().int().positive())
    .min(1, 'Omit pages for every page — an empty array selects zero pages, not "all".')
    .optional()
    .describe(
      '1-based page numbers, in the order given. Defaults to every page, capped at ' +
        `${MAX_PAGES_PER_CALL} (MAX_PAGES_PER_CALL) per call. Omit the field for every page; an ` +
        'empty array is rejected rather than silently rendering nothing. Cannot be combined with ' +
        '`labels`.',
    ),
  labels: z
    .array(z.string().min(1))
    .min(1, 'Omit labels rather than passing an empty array — it selects nothing, not "all".')
    .max(MAX_LABELS_PER_CALL)
    .optional()
    .describe(
      'Render the page each \\label{...} landed on, instead of naming page numbers — the actual ' +
        'question after moving a float ("which page did the restructured table end up on?"), ' +
        'where the page number is exactly what is unknown. Resolved through the build-directory ' +
        '.aux of the LAST COMPILE (the same index pdf_geometry kinds: ["floats"] reports), so a ' +
        'label added since, one that moved, or one whose reference has not converged yet ' +
        '(LaTeX\'s "Label(s) may have changed. Rerun to get cross-references right.") resolves ' +
        'to a STALE page or not at all — compile first, and the result echoes every label -> ' +
        "page it used so you can see what was actually rendered. The .aux records each label's " +
        'PRINTED page, which is the PDF page index only while the document numbers its pages in ' +
        'one arabic run: a label printing as "iv", and every label in a document that renumbers ' +
        '(roman front matter, \\frontmatter), is REFUSED rather than mapped onto a page that ' +
        'would be wrong. Any label that cannot be resolved refuses the whole call — no page is ' +
        'ever guessed, and nothing partial is rendered. Cannot be combined with `pages`; two ' +
        'labels on one page render it once and both are echoed. At most ' +
        `${MAX_LABELS_PER_CALL} per call.`,
    ),
  dpi: z
    .number()
    .positive()
    .max(1200)
    .optional()
    .describe(
      'Sets the resolution directly and beats maxEdgePx, bounded only by the ' +
        `${HARD_MAX_EDGE_PX}px hard cap. This is the precise path — clip one column and ask for ` +
        '150 dpi.',
    ),
  maxEdgePx: z
    .number()
    .int()
    .min(64)
    .max(HARD_MAX_EDGE_PX)
    .optional()
    .describe(
      'Longest edge of the *returned* image, default 1600. The budget-friendly knob and the ' +
        'default: enough to see whether the layout broke or the columns are balanced, without a ' +
        'huge image.',
    ),
  clip: z
    .object({
      x0: z.number().min(0).max(1),
      y0: z.number().min(0).max(1),
      x1: z.number().min(0).max(1),
      y1: z.number().min(0).max(1),
    })
    .optional()
    .describe(
      'Crop, as fractions of the page box, origin top-left (x1 must exceed x0, y1 must exceed ' +
        'y0). On a poster or a wide figure the question is usually about one column, and a full ' +
        'page at legible dpi is a large image — clip to the part that matters instead.',
    ),
  inline: z
    .boolean()
    .optional()
    .describe(
      'Return the PNGs as image content as well as paths. Default true. Set false for a client ' +
        'that cannot render images, or to save tokens.',
    ),
};

const pageShape = z.object({
  page: z.number().describe('1-based page number.'),
  pngPath: z
    .string()
    .describe('Absolute path to the rendered PNG on disk. POSIX (`/`-separated) on every OS.'),
  widthPx: z.number().describe('Rendered image width in pixels.'),
  heightPx: z.number().describe('Rendered image height in pixels.'),
  dpi: z.number().describe('Resolution actually rendered at, one decimal place.'),
  clamped: z
    .boolean()
    .describe(`True when the request was reduced to fit the ${HARD_MAX_EDGE_PX}px hard cap.`),
  pageWidthPt: z
    .number()
    .describe(
      'The page box width in PostScript points (72pt = 1in) — how a figure clipped by its own ' +
        'too-small box shows up.',
    ),
  pageHeightPt: z
    .number()
    .describe(
      'The page box height in PostScript points (72pt = 1in) — how a figure clipped by its own ' +
        'too-small box shows up.',
    ),
  bytes: z.number().describe('Size of the PNG file in bytes.'),
  inlined: z.boolean().describe('Whether this page was also returned as an image content block.'),
});

const outputSchema = {
  pdfPath: z
    .string()
    .describe('The compiled PDF that was rasterized. POSIX (`/`-separated) on every OS.'),
  pageCount: z.number().describe('Pages in the PDF — not the number of pages rendered.'),
  outDir: z
    .string()
    .describe(
      'Directory the PNGs were written to (a temp build dir, never inside the project). ' +
        'POSIX (`/`-separated) on every OS.',
    ),
  pages: z.array(pageShape).describe('One entry per page actually rendered, in page order.'),
  skippedPages: z
    .array(z.number())
    .describe(
      `Pages asked for (or implied by the default) that the ${MAX_PAGES_PER_CALL}-per-call cap ` +
        'left out.',
    ),
  resolvedLabels: z
    .array(
      z.object({
        label: z.string().describe('The \\label{...} key, as it was passed in.'),
        printedPage: z
          .string()
          .describe(
            'The printed page the .aux records for it, verbatim — what \\pageref would print.',
          ),
        page: z
          .number()
          .describe(
            'The 1-based PDF page index actually rendered for it: the printed page read as a ' +
              'decimal integer. Equal to printedPage for a document with one arabic numbering ' +
              'run; a document where they could differ is refused rather than reported here.',
          ),
      }),
    )
    .optional()
    .describe(
      'Present only when `labels` was used: what each label resolved to, in request order, so ' +
        'the page that was rendered is visible rather than implied. Two labels on one page both ' +
        'appear here while `pages` holds that page once. These numbers come from the LAST ' +
        "COMPILE's .aux (see `note`), not from the source on disk.",
    ),
  note: z
    .string()
    .optional()
    .describe(
      'Explains the inline situation when it is not the default: nothing inlined because ' +
        'inline was false, or which later pages the 5 MB inline budget (on the base64-encoded ' +
        'payload) left as paths-only. When `labels` was used it also carries the provenance of ' +
        'the page numbers: they came from the build-directory .aux the LAST COMPILE wrote, so ' +
        'they are as stale as that compile is.',
    ),
};

export function registerRenderPages(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'render_pages',
    {
      title: 'Rasterize compiled pages to PNG for the model to look at',
      description:
        'Read-only over the last compiled PDF — it never compiles. Rasterizes the requested pages ' +
        '(default: every page, capped at 8 per call) to PNG so the model can see the actual ' +
        'layout: did a restructured column push a row onto the next page, are columns balanced, ' +
        'is a figure panel clipped by its own PDF box. Returns each PNG inlined as image content ' +
        '(unless inline: false) plus its path, width/height in pixels, the resolution rendered at, ' +
        'and the page box in PostScript points. Use dpi for a precise crop (e.g. 150 dpi on one ' +
        'clipped column) or maxEdgePx for a budget-friendly overview (default 1600px longest edge). ' +
        'For sub-point measurement (matching two table heights, checking rule alignment), clip a ' +
        'narrow band and push dpi toward its 1200 cap instead of rendering a whole page — a tight ' +
        'clip at high dpi resolves well under a point per pixel. ' +
        'Pass `labels` instead of `pages` when the question is "which page did this float land ' +
        'on?": each \\label is resolved through the build-directory .aux of the LAST COMPILE and ' +
        'the label -> page mapping comes back in the result. A label that cannot be resolved — ' +
        'absent from that .aux, or printing on a page that is not a PDF page index (roman front ' +
        'matter) — refuses the call rather than rendering a guessed page. ' +
        'Fails with a message to run compile first when nothing has been compiled yet.',
      inputSchema,
      outputSchema,
    },
    async ({ project, rootFile, pages, labels, dpi, maxEdgePx, clip, inline }) => {
      try {
        // Rejected, never silently resolved — the house rule `diff` already applies to
        // `ref` + `staged`. Either one could be made to win, and whichever were chosen would
        // silently render something the caller did not ask for half the time they hit it.
        if (labels && pages) {
          throw new Error(
            'Pass either `pages` or `labels`, not both: `labels` resolves to page numbers, so ' +
              'combining them would mean silently ignoring one of the two.',
          );
        }
        // Invariant: requireProjectDir, NEVER requireGitProject — this tool must work for a
        // mode:'local' project exactly like compile and viewer. Git-gating it would be wrong.
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        // Invariant: runExclusive is taken even though this tool is read-only with respect to the
        // project's source files. It is a deliberate exception to "read-only tools don't lock":
        // it reads the build-dir PDF that a peer session's `compile` can rewrite mid-read, and it
        // writes PNGs into that same build dir (buildDir(dir)/render) — both need the per-project
        // mutex + lock file that serializes against a concurrent compile. The lock is held across
        // the whole rasterization (up to MAX_PAGES_PER_CALL pages), so a very large multi-page
        // render can make a peer session's write wait — bounded by the 30s lock timeout in
        // src/lib/fileLock.ts. This is a deliberate, documented trade, not a bug.
        return await ctx.projectManager.runExclusive(id, async () => {
          // No recordBaseline: nothing here reads a caller-named file through FileService, and
          // detectRootFile itself records no baseline (see rootFile.ts) — recording one here would
          // wrongly claim the caller could now base a write on a file it only used to find a PDF.
          const root = rootFile ?? (await detectRootFile(ctx.files, dir));
          const pdfPath = await locateProjectPdf(ctx.config, id, dir, root);
          if (!pdfPath) {
            throw new Error(
              `No compiled PDF found for project "${id}". Run compile first, then render_pages.`,
            );
          }
          // Invariant: nothing is ever written inside the project directory. PNGs go under the
          // temp build dir's own "render" subdirectory — for a local (in-place) project this is
          // the difference between reading/editing in place and littering it with PNGs.
          const outDir = path.join(buildDir(dir), 'render');

          // Label resolution reads the build-dir .aux, which is the very file a peer session's
          // compile rewrites in place — so it belongs INSIDE this runExclusive closure, alongside
          // the PDF read it feeds, not before the lock. Reading it outside would let a peer's
          // compile land between the lookup and the render, and the page rendered would then be
          // from a different build than the page number was.
          //
          // No baseline is recorded for it either: readAuxFloats goes through node:fs directly,
          // never FileService, and the .aux is not a caller-named project file the caller could
          // base a write on. Same reasoning as pdf_geometry's "floats" kind.
          let labelPlan: LabelPagePlan | undefined;
          if (labels) {
            const aux = await readAuxFloats(dir, root, { max: LABEL_LOOKUP_MAX });
            labelPlan = planLabelPages(labels, aux);
            // An assertion, never an inference: one unresolvable label refuses the whole call.
            // Rendering the labels that did resolve would hand back images the caller reads as
            // the answer to every label they asked about.
            if (labelPlan.failed.length > 0) {
              throw new Error(labelRefusalMessage(labelPlan, aux));
            }
          }
          const effectivePages = labelPlan ? labelPlan.pages : pages;

          let result: RenderResult;
          try {
            result = await ctx.pdfRenderer.render({
              pdfPath,
              outDir,
              pages: effectivePages,
              dpi,
              maxEdgePx,
              clip,
            });
          } catch (err) {
            // A page resolved from a label that the PDF on disk does not have is the one stale-
            // .aux symptom that IS detectable, and the renderer's own message ("Page 9 is out of
            // range: this document has 3 page(s).") blames the caller for a number they never
            // chose. Narrowed to that one message from selectPages — a backend or canvas failure
            // must not collect a "your .aux is stale" suffix it did not earn.
            if (
              labelPlan &&
              err instanceof PdfRenderError &&
              err.message.includes('out of range')
            ) {
              throw new Error(labelPageRangeMessage(labelPlan, err.message), { cause: err });
            }
            throw err;
          }

          const inlineRequested = inline ?? true;
          const { inlined: inlinePlan, note: inlineNote } = planInlining(
            result.pages.map((p) => ({ page: p.page, bytes: p.bytes })),
            { inline: inlineRequested },
          );
          const rendered = result.pages.map((p, i) => ({ ...p, inlined: inlinePlan[i] ?? false }));

          // The response boundary: everything above needed the native spelling (the renderer wrote
          // these very paths on the real filesystem), and nothing below touches a disk. Converting
          // here, once, is what keeps the result text and structuredContent rendered from the same
          // value instead of one being native and the other POSIX.
          const { pdfPath: outPdfPath, outDir: outOutDir } = toPosixOut({ pdfPath, outDir });
          const pagesOut = rendered.map((p) => ({
            page: p.page,
            ...toPosixOut({ pngPath: p.pngPath }),
            widthPx: p.widthPx,
            heightPx: p.heightPx,
            dpi: p.dpi,
            clamped: p.clamped,
            pageWidthPt: p.pageWidthPt,
            pageHeightPt: p.pageHeightPt,
            bytes: p.bytes,
            inlined: p.inlined,
          }));

          // Joined, never overwritten — the two notes answer different questions (what was
          // inlined, and where the page numbers came from) and both can hold at once: a
          // label-resolved render of several pages can also hit the inline budget. Same shape as
          // pdf_geometry's note joining.
          const note =
            [labelPlan ? labelResolutionNote(labelPlan) : undefined, inlineNote]
              .filter(Boolean)
              .join(' ') || undefined;

          // structuredContent must never carry base64 (it would double the payload) — the image
          // bytes only ever reach `content`, below.
          const structuredContent = {
            pdfPath: outPdfPath,
            pageCount: result.pageCount,
            outDir: outOutDir,
            pages: pagesOut,
            skippedPages: result.skippedPages,
            resolvedLabels: labelPlan ? labelPlan.resolved : undefined,
            note,
          };

          const header = `rendered ${rendered.length} of ${result.pageCount} page(s) from ${outPdfPath}`;
          // Mapped over pagesOut, not `rendered`: the line must name the same pngPath
          // structuredContent reports, and pagesOut is where the converted one lives. The base64
          // loop below stays on `rendered`, which is the only side carrying the image bytes.
          const pageLines = pagesOut.map((p) => {
            const clampedTag = p.clamped ? ' (clamped)' : '';
            return (
              `  page ${p.page}: ${p.widthPx}x${p.heightPx} px @${p.dpi} dpi${clampedTag} — ` +
              `page box ${p.pageWidthPt.toFixed(1)}x${p.pageHeightPt.toFixed(1)} pt — ${p.pngPath}`
            );
          });
          const skippedLine =
            result.skippedPages.length > 0
              ? `  … ${result.skippedPages.length} page(s) not rendered (at most ` +
                `${MAX_PAGES_PER_CALL} per call): ${result.skippedPages.join(', ')}`
              : '';
          // The resolved mapping goes in the TEXT channel as well as structuredContent: a client
          // that only reads the text would otherwise see "page 3" with no way to know which label
          // asked for it, which is the whole point of resolving one.
          const labelLine = labelPlan
            ? `  labels (from the last compile's .aux): ${describeResolvedLabels(labelPlan.resolved)}`
            : '';
          const noteLine = note ? `  … ${note}` : '';
          const text = [header, labelLine, ...pageLines, skippedLine, noteLine]
            .filter(Boolean)
            .join('\n');

          const content: Array<
            { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' }
          > = [{ type: 'text', text }];
          for (const p of rendered) {
            if (p.inlined) {
              content.push({
                type: 'image',
                data: Buffer.from(p.png).toString('base64'),
                mimeType: 'image/png',
              });
            }
          }

          return { content, structuredContent: { ...structuredContent } };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

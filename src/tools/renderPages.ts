import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { detectRootFile } from '../lib/rootFile.js';
import { locateProjectPdf } from '../lib/pdfLocate.js';
import { buildDir } from '../services/compiler.js';
import { HARD_MAX_EDGE_PX, MAX_PAGES_PER_CALL } from '../services/pdfRender.js';
import { planInlining } from '../lib/inlineBudget.js';

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
        'empty array is rejected rather than silently rendering nothing.',
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
  pngPath: z.string().describe('Absolute path to the rendered PNG on disk.'),
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
  pdfPath: z.string().describe('The compiled PDF that was rasterized.'),
  pageCount: z.number().describe('Pages in the PDF — not the number of pages rendered.'),
  outDir: z
    .string()
    .describe('Directory the PNGs were written to (a temp build dir, never inside the project).'),
  pages: z.array(pageShape).describe('One entry per page actually rendered, in page order.'),
  skippedPages: z
    .array(z.number())
    .describe(
      `Pages asked for (or implied by the default) that the ${MAX_PAGES_PER_CALL}-per-call cap ` +
        'left out.',
    ),
  note: z
    .string()
    .optional()
    .describe(
      'Explains the inline situation when it is not the default: nothing inlined because ' +
        'inline was false, or which later pages the 5 MB inline budget (on the base64-encoded ' +
        'payload) left as paths-only.',
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
        'Fails with a message to run compile first when nothing has been compiled yet.',
      inputSchema,
      outputSchema,
    },
    async ({ project, rootFile, pages, dpi, maxEdgePx, clip, inline }) => {
      try {
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
          const result = await ctx.pdfRenderer.render({
            pdfPath,
            outDir,
            pages,
            dpi,
            maxEdgePx,
            clip,
          });

          const inlineRequested = inline ?? true;
          const { inlined: inlinePlan, note } = planInlining(
            result.pages.map((p) => ({ page: p.page, bytes: p.bytes })),
            { inline: inlineRequested },
          );
          const rendered = result.pages.map((p, i) => ({ ...p, inlined: inlinePlan[i] ?? false }));

          const pagesOut = rendered.map((p) => ({
            page: p.page,
            pngPath: p.pngPath,
            widthPx: p.widthPx,
            heightPx: p.heightPx,
            dpi: p.dpi,
            clamped: p.clamped,
            pageWidthPt: p.pageWidthPt,
            pageHeightPt: p.pageHeightPt,
            bytes: p.bytes,
            inlined: p.inlined,
          }));

          // structuredContent must never carry base64 (it would double the payload) — the image
          // bytes only ever reach `content`, below.
          const structuredContent = {
            pdfPath,
            pageCount: result.pageCount,
            outDir,
            pages: pagesOut,
            skippedPages: result.skippedPages,
            note,
          };

          const header = `rendered ${rendered.length} of ${result.pageCount} page(s) from ${pdfPath}`;
          const pageLines = rendered.map((p) => {
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
          const noteLine = note ? `  … ${note}` : '';
          const text = [header, ...pageLines, skippedLine, noteLine].filter(Boolean).join('\n');

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

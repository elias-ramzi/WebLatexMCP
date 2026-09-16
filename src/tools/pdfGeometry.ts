import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { detectRootFile } from '../lib/rootFile.js';
import { locateProjectPdf } from '../lib/pdfLocate.js';
import {
  MAX_GEOMETRY_PAGES,
  MAX_TEXT_LINES_PER_PAGE,
  MAX_IMAGE_RECTS_PER_PAGE,
} from '../services/pdfRender.js';
import type { GeometryKind, GeometryResult } from '../services/pdfRender.js';
import { readAuxFloats, DEFAULT_MAX_FLOATS } from '../lib/auxFloats.js';

const inputSchema = {
  project: z.string().optional(),
  rootFile: z
    .string()
    .optional()
    .describe(
      'Root .tex file, used to select the build-dir PDF (and, for kinds: ["floats"], the ' +
        'build-dir .aux) to read. Auto-detected when omitted, exactly as for compile and ' +
        'render_pages.',
    ),
  pages: z
    .array(z.number().int().positive())
    .min(1, 'Omit pages for every page — an empty array selects zero pages, not "all".')
    .optional()
    .describe(
      '1-based page numbers, in the order given. Defaults to every page, capped at ' +
        `${MAX_GEOMETRY_PAGES} (MAX_GEOMETRY_PAGES) per call — lower than render_pages' cap, ` +
        'because a page of text-line boxes is a lot more structured output than one PNG. Omit ' +
        'the field for every page (up to the cap); an empty array is rejected rather than ' +
        'silently reporting nothing.',
    ),
  kinds: z
    .array(z.enum(['text', 'images', 'floats']))
    .min(1)
    .optional()
    .describe(
      'Which geometry to report. Defaults to ["text", "images"]. "floats" is opt-in and separate ' +
        'from the rest: it is document-wide (a label -> printed-page index from the .aux), not ' +
        'per-page, and can be long. "images" is image/form XObject PLACEMENT RECTANGLES ONLY — ' +
        'what an \\includegraphics figure occupies — NOT vector drawing geometry: a frame drawn ' +
        'with \\fbox rules or a TikZ stroke and no embedded image is never reported by this tool. ' +
        'kinds: ["floats"] alone never opens the compiled PDF at all (it only reads the .aux), so ' +
        'it works even without the optional native canvas backend installed.',
    ),
};

const geometryBoxShape = z.object({
  x0: z.number(),
  y0: z.number(),
  x1: z.number(),
  y1: z.number(),
  text: z
    .string()
    .optional()
    .describe('Present on a text box only: the merged line, truncated — a label, not content.'),
  mergedItems: z
    .number()
    .optional()
    .describe(
      'Present on a text box only: how many pdf.js text items were merged into this line ' +
        '(shared baseline and horizontal adjacency) — a rough signal of merge quality.',
    ),
  source: z
    .enum(['image', 'form'])
    .optional()
    .describe('Present on an image box only: "image" for an image XObject, "form" for a form one.'),
  approximate: z
    .literal(true)
    .optional()
    .describe(
      'Present (and true) ONLY on a "form" box for which no real bounding box could be ' +
        "recovered — neither the form's own /BBox nor a transparency group's — so this is the " +
        'unit-square CTM fallback, not a measured placement rectangle. Often far smaller (or ' +
        'otherwise unrelated) than the real figure; NEVER use it for a collision computation.',
    ),
});

const geometryPageShape = z.object({
  page: z.number().describe('1-based page number.'),
  pageWidthPt: z.number().describe('Page box width in PostScript points (72pt = 1in).'),
  pageHeightPt: z.number().describe('Page box height in PostScript points (72pt = 1in).'),
  text: z
    .array(geometryBoxShape)
    .optional()
    .describe(
      'Per-line text boxes, in drawing order. Absent (not empty) when "text" was not requested. ' +
        'Each box is [baseline, baseline + height], i.e. from the text baseline UP to the ' +
        "ascent (pdf.js's height is measured up from the baseline, roughly the font size) — " +
        'descenders (g, p, y, ...) extend BELOW y1 and are not included, so a descender touching ' +
        'a figure below it is a real collision this tool reports as clearance. Also: this box is ' +
        "axis-aligned from the item's origin/width/height alone — text rotated WITHIN an " +
        'unrotated page (e.g. a sideways table cell or a rotated axis label, as opposed to a ' +
        "/Rotate'd page, which this tool does handle) ignores that rotation and is simply wrong.",
    ),
  images: z
    .array(geometryBoxShape)
    .optional()
    .describe(
      'Image/form XObject placement rectangles, in drawing order. Absent (not empty) when ' +
        '"images" was not requested. Covers paintImageXObject, paintImageMaskXObject and ' +
        'paintFormXObjectBegin only — paintInlineImageXObject (plausible from some converters), ' +
        'paintImageXObjectRepeat, paintImageMaskXObjectGroup, paintImageMaskXObjectRepeat and ' +
        'paintSolidColorImageMask (the *Repeat/*Group forms only fire at several identical ' +
        'repeated placements, so unlikely in a paper) produce no rectangle and no count — a gap, ' +
        'not a zero.',
    ),
  textOmitted: z
    .number()
    .describe(
      `Text lines past the ${MAX_TEXT_LINES_PER_PAGE}-per-page cap (MAX_TEXT_LINES_PER_PAGE).`,
    ),
  imagesOmitted: z
    .number()
    .describe(
      `Image rects past the ${MAX_IMAGE_RECTS_PER_PAGE}-per-page cap (MAX_IMAGE_RECTS_PER_PAGE).`,
    ),
});

const floatShape = z.object({
  label: z.string().describe('The \\label{...} key.'),
  number: z.string().describe('The float\'s printed number, e.g. "3" or "2.1".'),
  page: z.string().describe('The printed page the label resolved to (may be "iv", "3", ...).'),
});

const outputSchema = {
  pdfPath: z.string().describe('The compiled PDF that was inspected.'),
  pageCount: z
    .number()
    .optional()
    .describe(
      'Pages in the PDF — not the number of pages reported on. ABSENT when kinds was ["floats"] ' +
        'alone: that path never opens the PDF (only the .aux), so this cannot be known without ' +
        'lying about it.',
    ),
  pages: z
    .array(geometryPageShape)
    .describe(
      'One entry per page actually inspected, in page order. Empty when kinds was ["floats"] ' +
        'alone — no page geometry was requested, and none was computed.',
    ),
  skippedPages: z
    .array(z.number())
    .describe(
      `Pages asked for (or implied by the default) that the ${MAX_GEOMETRY_PAGES}-per-call cap ` +
        '(MAX_GEOMETRY_PAGES) left out.',
    ),
  floats: z
    .array(floatShape)
    .optional()
    .describe(
      'Present only when "floats" was requested: labels parsed from the build-dir .aux, ' +
        'excluding cleveref\'s internal `<label>@cref` shadow records (their "page" field is a ' +
        'bracketed cross-reference code, not a printed page).',
    ),
  floatsOmitted: z
    .number()
    .optional()
    .describe(
      `Present only when "floats" was requested: real (non-shadow) labels past the ` +
        `${DEFAULT_MAX_FLOATS} cap, counted against the true total found — never against a ` +
        'smaller internal parse cutoff.',
    ),
  note: z
    .string()
    .optional()
    .describe(
      'Explains an unusual situation: "floats" requested but no .aux was found in the build ' +
        'directory (nothing has been compiled with that root file yet, or the backend in use ' +
        'does not write one).',
    ),
};

export function registerPdfGeometry(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'pdf_geometry',
    {
      title: 'Measure text-line and figure geometry on the compiled PDF, in points',
      description:
        'Read-only over the last compiled PDF — it never compiles. Run compile first. Reports ' +
        'geometry in PostScript points (72pt = 1 inch), origin TOP-LEFT of the page — the same ' +
        "convention as render_pages' clip, so the two tools compose: render_pages to look, " +
        "pdf_geometry to measure. Answers questions eyeballing a PNG cannot: does this table's " +
        'text box overlap the figure frame above it, and by how many points. ' +
        '"text" reports per-line boxes (pdf.js text items merged by shared baseline and ' +
        'horizontal adjacency); the "text" string on each box is truncated — it is a label for ' +
        "the box, not the document's content, so use read_file for that. A text box runs from " +
        'the baseline up to the ascent only — a descender (g, p, y) extends below it, and text ' +
        'rotated within an unrotated page (not the page itself) is not accounted for; see the ' +
        'schema field description for both caveats. ' +
        '"images" reports image and form XObject PLACEMENT RECTANGLES — what an \\includegraphics ' +
        'figure actually occupies — and NOTHING ELSE: general vector path geometry (\\fbox rules, ' +
        'TikZ strokes) is explicitly out of scope, because pdf.js only exposes those as raw ' +
        'path-construction operators in untransformed space, and replaying them correctly is a ' +
        'full graphics-state interpreter. A frame drawn purely with rules or strokes and no ' +
        'embedded image is not reported at all — a caller who assumes otherwise will measure a ' +
        'collision that is not there, or miss one that is. A handful of rarer paint operators ' +
        '(inline images, and repeated-placement forms) are not handled either — see the schema ' +
        'field description. A form whose own bounding box could not be recovered is flagged ' +
        '"approximate": true and must never be used for a collision computation. ' +
        '"floats" (opt-in, since it is document-wide rather than per-page) reports a label -> ' +
        'printed-page index parsed from the build-dir .aux, so it reflects the LAST COMPILE: a ' +
        'label added since, or one whose reference has not converged yet (LaTeX\'s "may have ' +
        'changed, rerun" case), is absent until the next compile. Requesting kinds: ["floats"] ' +
        'alone never opens the compiled PDF at all. ' +
        `Caps: ${MAX_GEOMETRY_PAGES} pages per call (MAX_GEOMETRY_PAGES, lower than render_pages’ ` +
        `cap — a page of boxes is a lot more output than one PNG), ${MAX_TEXT_LINES_PER_PAGE} text ` +
        `lines and ${MAX_IMAGE_RECTS_PER_PAGE} image rects per page, ${DEFAULT_MAX_FLOATS} floats ` +
        'total — each with its own *Omitted count, so a truncated result is never silent. ' +
        'Reading per-page geometry needs the optional native canvas backend @napi-rs/canvas, ' +
        "same as render_pages and compile's pageCount reports — without it this fails naming " +
        'that package, not the PDF as broken (kinds: ["floats"] alone is unaffected).',
      inputSchema,
      outputSchema,
    },
    async ({ project, rootFile, pages, kinds }) => {
      try {
        // Invariant: requireProjectDir, NEVER requireGitProject — this tool must work for a
        // mode:'local' project exactly like compile and render_pages. Git-gating it would be wrong.
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        // Invariant: runExclusive is taken even though this tool writes nothing at all. It is a
        // deliberate exception to "read-only tools don't lock", mirroring render_pages: it reads
        // the build-dir PDF (and, for "floats", the build-dir .aux) that a peer session's compile
        // can rewrite mid-read.
        return await ctx.projectManager.runExclusive(id, async () => {
          // No recordBaseline anywhere in this handler: nothing here reads a caller-named project
          // file through FileService. detectRootFile records no baseline itself (see rootFile.ts),
          // and the .aux read (readAuxFloats) goes through node:fs directly, never FileService —
          // recording a baseline would wrongly claim the caller could now base a write on a file
          // it only used to locate a PDF/aux.
          const root = rootFile ?? (await detectRootFile(ctx.files, dir));
          const pdfPath = await locateProjectPdf(ctx.config, id, dir, root);
          if (!pdfPath) {
            throw new Error(
              `No compiled PDF found for project "${id}". Run compile first, then pdf_geometry.`,
            );
          }

          const requestedKinds = kinds ?? ['text', 'images'];
          const pageKinds = requestedKinds.filter((k): k is GeometryKind => k !== 'floats');

          // This tool writes nothing, anywhere — no PNGs, no temp files, no output directory. For
          // a mode:'local' project the whole point is reading in place, not littering in place.
          //
          // Skip opening the PDF entirely when no page-level kind was requested (kinds: ["floats"]
          // alone): geometry() needs the native canvas backend just to open a document at all, so
          // a pure .aux text parse would otherwise fail on a machine without it, or open the
          // document to produce a result that discards text/images either way. pageCount is
          // therefore honestly unknown in this path (see the schema field), not computed and
          // hidden.
          const result:
            | GeometryResult
            | { pageCount: undefined; pages: never[]; skippedPages: never[] } =
            pageKinds.length > 0
              ? await ctx.pdfRenderer.geometry({ pdfPath, pages, kinds: pageKinds })
              : { pageCount: undefined, pages: [], skippedPages: [] };

          let floats: Array<{ label: string; number: string; page: string }> | undefined;
          let floatsOmitted: number | undefined;
          let note: string | undefined;
          if (requestedKinds.includes('floats')) {
            const auxResult = await readAuxFloats(dir, root);
            floats = auxResult.floats;
            floatsOmitted = auxResult.omitted;
            note = auxResult.note;
          }

          const structuredContent = {
            pdfPath,
            pageCount: result.pageCount,
            pages: result.pages,
            skippedPages: result.skippedPages,
            floats,
            floatsOmitted,
            note,
          };

          const pageCountText =
            result.pageCount !== undefined
              ? `${result.pages.length} of ${result.pageCount} page(s) from ${pdfPath}`
              : `${pdfPath} (no page opened — kinds: floats only)`;
          const header = `geometry for ${pageCountText} (kinds: ${requestedKinds.join(', ')})`;
          const pageLines = result.pages.map((p) => {
            const parts = [
              `page ${p.page}: ${p.pageWidthPt.toFixed(1)}x${p.pageHeightPt.toFixed(1)} pt`,
            ];
            if (p.text !== undefined) {
              parts.push(`${p.text.length} text line(s)`);
              if (p.textOmitted > 0) parts.push(`${p.textOmitted} text line(s) omitted`);
            }
            if (p.images !== undefined) {
              parts.push(`${p.images.length} image rect(s)`);
              if (p.imagesOmitted > 0) parts.push(`${p.imagesOmitted} image rect(s) omitted`);
            }
            return `  ${parts.join(' — ')}`;
          });
          const skippedLine =
            result.skippedPages.length > 0
              ? `  … ${result.skippedPages.length} page(s) not inspected (at most ` +
                `${MAX_GEOMETRY_PAGES} per call): ${result.skippedPages.join(', ')}`
              : '';
          const floatsLine =
            floats !== undefined
              ? `  floats: ${floats.length} label(s)` +
                (floatsOmitted ? ` (${floatsOmitted} omitted)` : '')
              : '';
          const noteLine = note ? `  … ${note}` : '';
          const text = [header, ...pageLines, skippedLine, floatsLine, noteLine]
            .filter(Boolean)
            .join('\n');

          return {
            content: [{ type: 'text' as const, text }],
            structuredContent: { ...structuredContent },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

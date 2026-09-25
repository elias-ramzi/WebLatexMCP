import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { detectRootFile } from '../lib/rootFile.js';
import { locateRootPdf } from '../lib/pdfLocate.js';
import { toPosixOut } from '../lib/paths.js';
import {
  MAX_GEOMETRY_PAGES,
  MAX_TEXT_LINES_PER_PAGE,
  MAX_IMAGE_RECTS_PER_PAGE,
} from '../services/pdfRender.js';
import type { GeometryKind, GeometryResult } from '../services/pdfRender.js';
import { readAuxFloats, DEFAULT_MAX_FLOATS, PARSE_BOUND } from '../lib/auxFloats.js';
import { shippedNothing } from '../lib/labelPages.js';
import { planFloatsPayload, FLOATS_CONTENT_BUDGET } from '../lib/floatsBudget.js';
import { planGeometryPayload, GEOMETRY_CONTENT_BUDGET } from '../lib/geometryBudget.js';

const inputSchema = {
  project: z.string().optional(),
  rootFile: z
    .string()
    .optional()
    .describe(
      'Root .tex file whose build this reads: its build-dir PDF (and, for kinds: ["floats"], ' +
        'its .aux), in every workspace mode — pass the same rootFile you compiled with to read ' +
        'a non-default root. Auto-detected when omitted. Only when it is omitted and no .aux is ' +
        'read does a missing build PDF fall back to the surfaced <workspace>/<id>.pdf ' +
        '(workspace-local mode), which holds whichever root compiled last.',
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
        'it works even before any PDF exists (a compile that wrote an .aux and then died).',
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
        "(a shared line position and adjacency along the run, in the item's own frame) — a " +
        'rough signal of merge quality.',
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
  unreliableCtm: z
    .literal(true)
    .optional()
    .describe(
      'Present (and true) on an IMAGE OR FORM box only — the text path has no CTM latch and ' +
        'never sets this, so its absence on a text box says nothing about that box. On an image ' +
        'or form box it means the POSITION was computed under a transform the document did not ' +
        "ask for: a cm operand (or a form's own /Matrix) overflowed to a non-finite " +
        'value, the walk refused the multiply and carried the last known-good transform forward, ' +
        'and this box was measured against that. The numbers are finite and plausible and are ' +
        'NOT a measurement — NEVER use one for a collision computation. Distinct from ' +
        '"approximate", and a box can carry both: "approximate" says the EXTENT is a unit-square ' +
        "fallback, this says the PLACEMENT is not the document's. Only a content stream with an " +
        'overflowing operand reaches this at all; no TeX toolchain emits one.',
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
        "Each box runs from the text baseline UP by the font's DECLARED ascent when the font " +
        'declares a usable one (pdf.js reports it per font, as a fraction of the em), and by the ' +
        'full em otherwise — a missing, zero, non-finite (Symbol and ZapfDingbats literally ' +
        'report NaN) or above-one ascent keeps the full-em box rather than taking a guessed one, ' +
        'because a box built from a guess UNDER-covers and this tool must not report clearance ' +
        'where there is ink. So a box still never under-runs the ink at the top, and under a ' +
        'no-metrics font it still overshoots it by a few points. Descenders (g, p, y, ...) ' +
        'extend BELOW the box and are not included either way — a descender touching a figure ' +
        'below it is a real collision this tool reports as clearance. The box is built ' +
        "from the item's own text matrix (advance along its text direction, em along its up " +
        'direction), so a ROTATED item — a sideways table cell, a rotated axis label, or every ' +
        'line on a pdflscape landscape page, where the content is rotated inside the page as well ' +
        'as the page carrying /Rotate — gets a correct axis-aligned box, and a rotated line made ' +
        'of several items IS merged into one: items are grouped in their own frame (shared ' +
        'direction and up axes to within a degree AND the same writing mode, each origin ' +
        "projected onto the RUNNING LINE'S position axis — the perpendicular to that line's " +
        "advance axis, so the quantity compared is a candidate's perpendicular distance from " +
        "that line's baseline rather than a coordinate in its own frame — and adjacency " +
        "measured along that same line's ADVANCE axis), not by page-axis y. SHEAR (a slanted, " +
        "non-orthogonal text matrix) is modelled too — the corners come from the matrix's own " +
        'two column directions, so a skewed item gets the true bounds of its parallelogram, not ' +
        'an orthogonal approximation. VERTICAL writing mode (a CJK WMode 1 font) gets a correct ' +
        'box — down the column from the baseline, centred across it — and the items of one ' +
        'vertical line ARE merged into a single column box: the column is read as the line ' +
        'position and the run down it as the advance. Two neighbouring columns stay separate, ' +
        'and a vertical line is never merged with a horizontal one even where they share a ' +
        'coordinate. A line whose items drift in frame by up to a degree IS merged wherever it ' +
        'sits on the page, and so is a genuinely sheared contiguous run, in either writing ' +
        'mode: the one-degree frame tolerance is the whole bound, with no hidden dependence on ' +
        'distance from the page origin. ' +
        'As for ' +
        'images, a line whose coordinates come out non-finite (a content stream whose operands ' +
        'overflow) is dropped rather than reported, and is not counted in textOmitted — that ' +
        'field is the per-page cap alone — since a NaN is not a measurement. Lines cut by the ' +
        'size budget are counted in textOmittedBySize, and are always a suffix: the lines kept ' +
        'are the first ones in drawing order.',
    ),
  images: z
    .array(geometryBoxShape)
    .optional()
    .describe(
      'Image/form XObject placement rectangles, in drawing order. Absent (not empty) when ' +
        '"images" was not requested. Covers paintImageXObject, paintImageMaskXObject, ' +
        'paintInlineImageXObject, paintSolidColorImageMask and paintFormXObjectBegin. ' +
        "pdf.js's batched forms (paintImageXObjectRepeat, paintInlineImageXObjectGroup, " +
        'paintImageMaskXObjectGroup, paintImageMaskXObjectRepeat) are NOT a gap here, despite ' +
        "what an earlier version of this text said: they are produced only by pdf.js's " +
        'QueueOptimizer, and reading an operator list selects the NullOptimizer instead, so no ' +
        'list this tool can receive ever contains one. What IS still unreported: an image ' +
        'painted inside an ANNOTATION appearance stream (pdfcomment, form fields, pdfpages ' +
        'links — not plain hyperref) is skipped rather than placed, because pdf.js rebases the ' +
        'graphics state on an annotation base transform this walk does not model; those are ' +
        'COUNTED, per page, in annotationImagesSkipped. And a box whose coordinates come out ' +
        'non-finite (a content stream whose cm operands overflow) is dropped rather than ' +
        'reported, since a NaN is not a measurement; the walk then carries the last usable ' +
        'transform forward, and every later box measured against it is flagged ' +
        'unreliableCtm: true rather than passed off as a measurement. Only a stream with an ' +
        'overflowing operand reaches that at all; no TeX toolchain emits one.',
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
  textOmittedBySize: z
    .number()
    .describe(
      'Text lines cut from the END of this page because the page geometry hit its ' +
        `${GEOMETRY_CONTENT_BUDGET}-character budget, charged on the JSON-encoded boxes of every ` +
        'page in the result (each text label is document-controlled, so a count cap alone is not ' +
        'a bound on what you receive). Every page is guaranteed an equal share, and what a sparse ' +
        'page leaves unused is split among the rest, so one dense page never starves another. ' +
        'Counted apart from textOmitted (the per-page count cap) because it is a different ' +
        'cause; the cut lines are not fetchable from this result — ask for fewer pages or ' +
        'fewer kinds to give each page more. 0 when the budget did not fire, and when "text" ' +
        'was not requested.',
    ),
  imagesOmittedBySize: z
    .number()
    .describe(
      'Image rects cut from the END of this page by the same size budget as ' +
        "textOmittedBySize: every page's image list gets the same guaranteed share as its text " +
        'list, and a page carries only a handful of figure frames, so this is almost always 0. ' +
        'Counted apart from imagesOmitted (the per-page count cap) and annotationImagesSkipped ' +
        '(never measured at all).',
    ),
  annotationImagesSkipped: z
    .number()
    .describe(
      'Image/form paint operators found INSIDE an annotation appearance stream (pdfcomment, ' +
        'form fields, pdfpages links — not plain hyperref, which emits no appearance ops at ' +
        'all) and deliberately not measured: pdf.js rebases the graphics state on its own ' +
        'annotation base transform there, which this walk does not model, so any rectangle it ' +
        'produced would be in the wrong place. A counted gap, NOT a zero — the figures are ' +
        'there and this says how many went unreported. Counted separately from imagesOmitted, ' +
        'which is the per-page cap alone: folding them together would claim a rectangle was ' +
        'computed and trimmed for size when in fact none was ever computed.',
    ),
});

const floatShape = z.object({
  label: z.string().describe('The \\label{...} key.'),
  number: z.string().describe('The float\'s printed number, e.g. "3" or "2.1".'),
  page: z.string().describe('The printed page the label resolved to (may be "iv", "3", ...).'),
});

const outputSchema = {
  pdfPath: z
    .string()
    .optional()
    .describe(
      'The compiled PDF this call read, when there is one. NOT a claim that it was opened: with ' +
        'kinds ["floats"] alone only the .aux is read, and this field just names the PDF that ' +
        'happens to be there. ABSENT when kinds was ["floats"] alone and no PDF ' +
        'exists: that path never opens the PDF (only the .aux, and only to find labels), so a ' +
        'compile that produced an .aux but died before a PDF (a missing package, an undefined ' +
        'control sequence) still lets the float index be read — there is simply no PDF to name. ' +
        'POSIX (`/`-separated) on every OS.',
    ),
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
        'bracketed cross-reference code, not a printed page). Every OTHER \\newlabel is reported, ' +
        "so this is not a float-only list: varioref's `<n>@vr`/`@xvr` records (empty number) and " +
        "subcaption's `sub@<label>` duplicates of each subfigure appear here too, as does every " +
        '\\label on a section or an equation. Match on the label key you care about rather than ' +
        'assuming a row is a figure or a table.',
    ),
  floatsOmitted: z
    .number()
    .optional()
    .describe(
      `Present only when "floats" was requested: real (non-shadow) labels past the ` +
        `${DEFAULT_MAX_FLOATS} cap. Counted against the true total found, never against a ` +
        `smaller internal parse cutoff — exact for any .aux holding at most ${PARSE_BOUND} ` +
        '\\newlabel markers, which is far past any real document; past that the scan stops (the ' +
        'file is document-controlled, so the work it can cost is bounded) and this count ' +
        'saturates with it.',
    ),
  floatsOmittedBySize: z
    .number()
    .optional()
    .describe(
      'Present only when "floats" was requested: entries cut because the floats payload hit its ' +
        `${FLOATS_CONTENT_BUDGET}-character budget, charged on the JSON-ENCODED size of the ` +
        'array (escaping included — a \\label key is backslash-dense LaTeX and roughly doubles ' +
        'in width once encoded), not on the sum of the field lengths. Every byte of this payload ' +
        'comes from the document, so a count cap alone is not a bound on what you receive. ' +
        'Counted apart from floatsOmitted (the entry cap) and floatsDropped (found but ' +
        'unreportable) because it is a different cause. The entries kept are the first ones in ' +
        "the .aux's own order — never reordered, never cherry-picked by size — and the omitted " +
        'ones are not fetchable from this result. Almost always 0.',
    ),
  floatsDropped: z
    .number()
    .optional()
    .describe(
      'Present only when "floats" was requested: real (non-shadow) \\newlabel entries that were ' +
        'found in the .aux but could not be reported — either a label/number/page field ran past ' +
        "the per-field length cap, or the entry's own \\newlabel group was longer than the " +
        'parser will scan (the .aux is document-controlled, so the work one entry can cost is ' +
        'bounded). Almost always 0. Counted separately from floatsOmitted, which is the ' +
        'reporting cap, so neither kind of loss is ever silent.',
    ),
  floatsRefused: z
    .number()
    .optional()
    .describe(
      'Present only when "floats" was requested: \\newlabel-SHAPED text found inside another ' +
        "entry's argument, where no closing brace could be located within the parser's scan " +
        'budget, and declined rather than reported. NOT a second floatsDropped and never added ' +
        'to it: floatsDropped means "there was a real entry here and you are not getting it" — ' +
        'a loss — while this means the opposite, that something LOOKED like an entry and was not ' +
        'believed. Nothing is missing from the index because of it. Almost always 0; a non-zero ' +
        'value says the .aux is malformed or hostile, not that the float index is incomplete.',
    ),
  floatsIndeterminate: z
    .number()
    .optional()
    .describe(
      'Present only when "floats" was requested: \\newlabel markers whose own label key was ' +
        "opened with a { that no closing brace could be found for within the parser's scan " +
        'budget, so nothing at all about them could be read — not even the key, which means ' +
        'they cannot be told apart from a cleveref shadow record. It means only that a marker ' +
        'was there and nothing can be said about it. NOT added to floatsDropped, ' +
        'floatsRefused, floatsOmitted or floatsOmittedBySize, and never folded into any of ' +
        'them: floatsDropped means "a real entry is missing", floatsRefused means "nothing is ' +
        'missing, something that looked like an entry was declined", and this means neither. ' +
        'Almost always 0; a non-zero value says the .aux is malformed or hostile.',
    ),
  floatsPagesShifted: z
    .boolean()
    .optional()
    .describe(
      'Present (true) only when "floats" was requested and the build\'s records (its .fls or ' +
        '.log) name pgfpages.sty or pgfmorepages.sty: a \\pgfpagesuselayout (`resize to`, ' +
        '`2 on 1`) holds each page back until the next is built, so every `page` in `floats` is ' +
        "likely LATER than the page the label is on — don't pass it to render_pages as `pages:`; " +
        'find the page with extract_text instead. Label keys and numbers are unaffected. Loading ' +
        'the package without a layout shifts nothing, but is flagged too. Absent when the build ' +
        'shows no pgfpages. Also absent when neither file could be read (a missing or empty file ' +
        'counts as unread), or when the .log holds no [n] shipout mark beside a PDF that has ' +
        "pages (another run's record, or an empty file) — `note` then says the pages are " +
        'unverified instead, since nothing shows the package was loaded.',
    ),
  note: z
    .string()
    .optional()
    .describe(
      "Explains an unusual situation, several joined when more than one applies: the build's " +
        'records name pgfpages, so the floats pages are likely shifted (see floatsPagesShifted), or ' +
        'neither its .fls nor its .log could be read (a missing or empty file counts as ' +
        'unread), or its .log holds no [n] shipout mark beside a PDF that has pages (it ' +
        "records a compile that shipped no page, or is empty, so it is not that PDF's run), so " +
        'whether they are shifted could not be checked; the page ' +
        'geometry hit its size budget (see textOmittedBySize); "floats" requested but no .aux ' +
        'was found in the build directory (nothing has been compiled with that root file yet, ' +
        'or the backend in use does not write one), or the .aux reader could not read an ' +
        'included file; and/or the floats payload hit its size budget, in which case it names ' +
        'the bound that fired. (There is a second, single-oversized-entry bound behind ' +
        'that one, but the .aux reader caps every field at 200 characters, so one entry cannot ' +
        'render anywhere near the whole budget and callers will not see it fire — it is ' +
        'defence in depth, not a case to code against.)',
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
        '"text" reports per-line boxes (pdf.js text items merged by a shared line position ' +
        'and adjacency along the run, both measured in the item\'s own frame); the "text" ' +
        'string on each box is truncated — it is a label for ' +
        "the box, not the document's content, so use read_file for that. A text box runs from " +
        "the baseline up by the font's declared ascent where there is a usable one and by the " +
        'full em otherwise, so it never under-runs the ink above — and it excludes descenders ' +
        '(g, p, y) below either way. Rotated text IS accounted for — a sideways table cell, a ' +
        'rotated axis label and a pdflscape landscape page all get correct boxes, and a rotated ' +
        'line of several items is merged into one — and so is a sheared (slanted, ' +
        'non-orthogonal) text matrix. Vertical writing mode is handled too: a correct box per ' +
        'item AND its items merged into one column line; see the schema field description for ' +
        'all of it. ' +
        '"images" reports image and form XObject PLACEMENT RECTANGLES — what an \\includegraphics ' +
        'figure actually occupies — and NOTHING ELSE: general vector path geometry (\\fbox rules, ' +
        'TikZ strokes) is explicitly out of scope, because pdf.js only exposes those as raw ' +
        'path-construction operators in untransformed space, and replaying them correctly is a ' +
        'full graphics-state interpreter. A frame drawn purely with rules or strokes and no ' +
        'embedded image is not reported at all — a caller who assumes otherwise will measure a ' +
        'collision that is not there, or miss one that is. Anything painted inside an ' +
        'ANNOTATION appearance stream is not measured either, because pdf.js rebases the ' +
        'graphics state there on a base transform this tool does not model — those are counted ' +
        'per page in annotationImagesSkipped rather than going silently missing. ' +
        'A form whose own bounding box could not be recovered is flagged "approximate": true ' +
        'and must never be used for a collision computation, and neither must a box measured ' +
        'after an overflowing cm operand forced the walk to keep an older transform ' +
        '("unreliableCtm": true). ' +
        '"floats" (opt-in, since it is document-wide rather than per-page) reports a label -> ' +
        'printed-page index parsed from the build-dir .aux, so it reflects the LAST COMPILE: a ' +
        'label added since, or one whose reference has not converged yet (LaTeX\'s "may have ' +
        'changed, rerun" case), is absent until the next compile. It is every \\newlabel, not ' +
        'only floats, so section, equation, varioref and subcaption records appear too. ' +
        'Requesting kinds: ["floats"] alone never opens the compiled PDF at all, and does not ' +
        'even need one to exist — a compile that wrote an .aux and then died still has a ' +
        'readable float index. ' +
        `Caps: ${MAX_GEOMETRY_PAGES} pages per call (MAX_GEOMETRY_PAGES, lower than render_pages’ ` +
        `cap — a page of boxes is a lot more output than one PNG), ${MAX_TEXT_LINES_PER_PAGE} text ` +
        `lines and ${MAX_IMAGE_RECTS_PER_PAGE} image rects per page, ${DEFAULT_MAX_FLOATS} floats ` +
        'total — each with its own *Omitted count, so a truncated result is never silent — and a ' +
        `${GEOMETRY_CONTENT_BUDGET}-character budget on the page boxes (every page guaranteed a ` +
        'share; cuts counted per page in textOmittedBySize / imagesOmittedBySize) and another on ' +
        'the floats, because every text label and \\label key is document-controlled. ' +
        'Writes nothing into the project or its build directory. It does take the per-project ' +
        "lock, exactly as render_pages does (a peer session's compile can rewrite the build dir " +
        'mid-read), so it creates <workspace>/.sessions/<project>/ if that is not already there, ' +
        'and it can wait on — or time out against — a peer holding that lock. ' +
        'It never rasterizes, so it does not need the optional native canvas backend ' +
        '(@napi-rs/canvas) that render_pages does.',
      inputSchema,
      outputSchema,
    },
    async ({ project, rootFile, pages, kinds }) => {
      try {
        // Invariant: requireProjectDir, NEVER requireGitProject — this tool must work for a
        // mode:'local' project exactly like compile and render_pages. Git-gating it would be wrong.
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        // Invariant: runExclusive is taken even though this tool writes no project file. It is a
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
          const requestedKinds = kinds ?? ['text', 'images'];
          // The ROOT's build PDF, never the surfaced copy once a root is named or "floats" reads
          // the .aux: the surfaced copy holds whichever root compiled last, and measuring it
          // beside this root's float index would join two different documents (locateRootPdf).
          const pdfPath = await locateRootPdf(ctx.config, id, dir, root, {
            rootNamed: rootFile !== undefined,
            readsAux: requestedKinds.includes('floats'),
          });

          const pageKinds = requestedKinds.filter((k): k is GeometryKind => k !== 'floats');

          // This tool writes nothing into the project or its build directory — no PNGs, no temp
          // files, no output directory. For a mode:'local' project the whole point is reading in
          // place, not littering in place. (The one thing it does create is the project lock's
          // own <workspace>/.sessions/<id>/ directory, via runExclusive above — outside every
          // clone, and the same directory every other locking tool uses.)
          //
          // Skip opening the PDF entirely when no page-level kind was requested (kinds: ["floats"]
          // alone): a pure .aux text parse has no use for the document, and must keep working when
          // a compile wrote an .aux and then died before any PDF existed. pageCount is
          // therefore honestly unknown in this path (see the schema field), not computed and
          // hidden. A page-level request, by contrast, needs the PDF and must fail loudly and
          // early when there isn't one — nested here (rather than as an earlier standalone guard)
          // so the throw is what lets TypeScript narrow pdfPath to string for the geometry() call
          // right below it.
          let result:
            | GeometryResult
            | { pageCount: undefined; pages: never[]; skippedPages: never[] };
          if (pageKinds.length > 0) {
            if (!pdfPath) {
              throw new Error(
                `No compiled PDF found for project "${id}". Run compile first, then pdf_geometry.`,
              );
            }
            result = await ctx.pdfRenderer.geometry({ pdfPath, pages, kinds: pageKinds });
          } else {
            result = { pageCount: undefined, pages: [], skippedPages: [] };
          }
          // The size budget, over whatever survived the service's per-page count caps. Every text
          // box carries a document-controlled label, so the count caps alone let a default call on
          // an ordinary paper past the ~67k a client rejected undelivered (#68). The planner's
          // pages are emitted as they are: they are the objects it charged. See geometryBudget.ts.
          const geometryPlan = planGeometryPayload(result.pages);

          let floats: Array<{ label: string; number: string; page: string }> | undefined;
          let floatsOmitted: number | undefined;
          let floatsOmittedBySize: number | undefined;
          let floatsDropped: number | undefined;
          let floatsRefused: number | undefined;
          let floatsIndeterminate: number | undefined;
          let floatsNote: string | undefined;
          let floatsPagesShifted: true | undefined;
          if (requestedKinds.includes('floats')) {
            // `shipouts: true` for one question only: whether the .log records a compile that
            // shipped no page (the nothing-shipped note below). The marks check nothing else here.
            const auxResult = await readAuxFloats(dir, root, { shipouts: true });
            // The size budget is applied AFTER the reader's count cap, over whatever survived it,
            // because the two bound different things and the count cap is the cheaper one: there
            // is no point charging rendered characters against entries that were never going to
            // be returned. Every byte here is document-controlled (`\label` keys straight out of
            // the .aux), and a count cap alone is not a bound on what the client receives — the
            // #68 lesson, applied to the field issue #80 flagged for it. See floatsBudget.ts.
            const plan = planFloatsPayload(auxResult.floats);
            floats = plan.floats;
            floatsOmitted = auxResult.omitted;
            // A THIRD counter rather than folded into floatsOmitted, for the same reason
            // annotationImagesSkipped is not imagesOmitted: floatsOmitted means "past the
            // DEFAULT_MAX_FLOATS entry cap" and floatsDropped means "found but unreportable".
            // A size cut is neither, and reporting it as either names a cause that did not fire.
            floatsOmittedBySize = plan.omittedBySize;
            floatsDropped = auxResult.dropped;
            // A FOURTH counter, and the reason is the mirror image of floatsDropped's: a refused
            // \newlabel-shaped string is not an entry the caller lost, it is a fabrication the
            // reader declined to believe (see AuxFloatsResult.refused). Folding it into
            // floatsDropped would report a loss that did not happen; dropping it on the floor
            // (which is what this tool did until now) hides the only signal that the .aux is
            // malformed at all.
            floatsRefused = auxResult.refused;
            // A FIFTH counter, and the reason it is not one of the four above is that it makes
            // a weaker claim than any of them: a \newlabel marker was there and its key never
            // closed, so there is no label to call lost (floatsDropped) and no grounds to call
            // the bytes a fabrication either (floatsRefused). With no key there is nothing to
            // test for a cleveref shadow, so folding it into floatsDropped could report a
            // shadow record — excluded from the index by design — as a missing float. Until
            // #139 these markers were counted nowhere at all and simply vanished.
            floatsIndeterminate = auxResult.indeterminate;
            // Joined, never overwritten: the reader's note (no .aux at all, or an \@input file it
            // could not read — the latter alongside floats the budget may well cut) and the budget
            // note answer different questions, and both can be set at once.
            // The same evidence that makes labels: refuse the build (labelPages.ts,
            // 'pgfpagesLayout'). The index is still returned — its keys and numbers are true, and
            // it is data the caller asked for — but its pages are not, so it says so, first.
            floatsPagesShifted = auxResult.pgfpages === true ? true : undefined;
            const shiftedNote = floatsPagesShifted
              ? "This build's records name pgfpages.sty: a \\pgfpagesuselayout holds each page back until the " +
                'next is built, so every floats page is likely one later than the page the label ' +
                'is on (see floatsPagesShifted). Find the page with extract_text rather than ' +
                'passing these to render_pages.'
              : undefined;
            // The same state in which labels: refuses every label ('pgfpagesUnknown'): an .aux
            // with entries, but neither the .fls nor the .log beside it could be read (a missing
            // or empty file counts as unread), so a layout cannot be ruled out. Said in the note
            // only — floatsPagesShifted says the build's records name pgfpages, which nothing here
            // shows. Gated on `total` because the no-.aux result also carries no pgfpages
            // evidence, and it has no pages to call unverified (nor does an .aux with no entries).
            const unverifiedNote =
              auxResult.pgfpages === undefined && auxResult.total > 0
                ? 'Whether this build used a pgfpages layout could not be checked (neither its ' +
                  '.fls nor its .log could be read beside the .aux; a missing or empty file ' +
                  'counts as unread), so these pages are unverified: a \\pgfpagesuselayout ' +
                  "would make every one a page later than the label's own. render_pages " +
                  'labels: refuses such a build; compile again to restore the records.'
                : undefined;
            // The same state in which labels: refuses every label ('nothingShipped'): the records
            // were read and name no pgfpages, but the .log holds no shipout mark (a compile that
            // shipped no page, or an empty log) beside a PDF that has pages, so it (and any .fls)
            // is another run's — a compile that stopped in the preamble leaves the earlier .aux
            // and PDF — and its `false` says nothing about this build. Said in the note only, like
            // the unverified note above, and only where neither note above applies (pgfpages is
            // `false`). Whether the PDF has pages: its page count when geometry opened it; for
            // kinds: ["floats"] alone the PDF is never opened, and a build PDF that exists stands
            // in, since pdfTeX, XeTeX and LuaTeX write no PDF for a run that shipped nothing ("No
            // pages of output.").
            const pdfHasPages =
              result.pageCount !== undefined ? result.pageCount >= 1 : pdfPath !== undefined;
            const nothingShippedNote =
              auxResult.pgfpages === false &&
              auxResult.total > 0 &&
              shippedNothing(auxResult, pdfHasPages)
                ? "The build's .log holds no [n] shipout mark (it records a compile that " +
                  'shipped no page, or is empty) while the PDF beside it has pages, so it — like ' +
                  'any .fls beside it — is not a record of the run that wrote this .aux: ' +
                  'typically the last compile stopped on an error in the preamble, leaving the ' +
                  "earlier run's .aux and PDF. Whether that run used a pgfpages layout cannot " +
                  'be told, so these pages are unverified: a \\pgfpagesuselayout would make ' +
                  "every one a page later than the label's own. render_pages labels: refuses " +
                  'such a build; fix what stopped the last compile and compile again.'
                : undefined;
            floatsNote =
              [shiftedNote, unverifiedNote, nothingShippedNote, auxResult.note, plan.note]
                .filter(Boolean)
                .join(' ') || undefined;
          }
          const note = [geometryPlan.note, floatsNote].filter(Boolean).join(' ') || undefined;

          // The response boundary. It sits below the geometry() call deliberately: that call reads
          // the PDF off the real filesystem and needs the native spelling, and the `!pdfPath` throw
          // inside it is what narrows the type. From here the path is a display value only.
          const { pdfPath: outPdfPath } = toPosixOut({ pdfPath });
          const structuredContent = {
            pdfPath: outPdfPath,
            pageCount: result.pageCount,
            pages: geometryPlan.pages,
            skippedPages: result.skippedPages,
            floats,
            floatsOmitted,
            floatsOmittedBySize,
            floatsDropped,
            floatsRefused,
            floatsIndeterminate,
            floatsPagesShifted,
            note,
          };

          const pageCountText =
            result.pageCount !== undefined
              ? `${result.pages.length} of ${result.pageCount} page(s) from ${outPdfPath}`
              : outPdfPath !== undefined
                ? `${outPdfPath} (no page opened — kinds: floats only)`
                : 'no PDF (kinds: floats only, and none was ever compiled)';
          const header = `geometry for ${pageCountText} (kinds: ${requestedKinds.join(', ')})`;
          const pageLines = geometryPlan.pages.map((p) => {
            const parts = [
              `page ${p.page}: ${p.pageWidthPt.toFixed(1)}x${p.pageHeightPt.toFixed(1)} pt`,
            ];
            if (p.text !== undefined) {
              parts.push(`${p.text.length} text line(s)`);
              if (p.textOmitted > 0) parts.push(`${p.textOmitted} text line(s) omitted`);
              if (p.textOmittedBySize > 0) {
                parts.push(`${p.textOmittedBySize} text line(s) past the size budget`);
              }
            }
            if (p.images !== undefined) {
              parts.push(`${p.images.length} image rect(s)`);
              if (p.imagesOmitted > 0) parts.push(`${p.imagesOmitted} image rect(s) omitted`);
              if (p.imagesOmittedBySize > 0) {
                parts.push(`${p.imagesOmittedBySize} image rect(s) past the size budget`);
              }
              // Surfaced in the text channel as well as structuredContent, and named as a
              // different thing from the cap: a client reading only the text would otherwise see
              // "3 image rect(s)" on a page holding five figures and have no way to know two of
              // them were never measured. Same reason omittedSnippetLocations is reported rather
              // than left as a silent gap.
              if (p.annotationImagesSkipped > 0) {
                parts.push(`${p.annotationImagesSkipped} in annotation(s), not measured`);
              }
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
                (floatsOmitted ? ` (${floatsOmitted} past the cap)` : '') +
                (floatsOmittedBySize ? ` (${floatsOmittedBySize} past the size budget)` : '') +
                (floatsDropped ? ` (${floatsDropped} unreportable)` : '') +
                // Worded apart from "unreportable" on purpose: nothing was lost here, so the
                // text channel must not read as though something was. See floatsRefused.
                (floatsRefused ? ` (${floatsRefused} refused as not an entry)` : '') +
                // Worded apart from BOTH of the above: nothing is claimed lost and nothing is
                // claimed fabricated, only that a marker could not be read. See
                // floatsIndeterminate.
                (floatsIndeterminate
                  ? ` (${floatsIndeterminate} marker(s) too malformed to judge)`
                  : '') +
                (floatsPagesShifted ? ' (pages likely shifted by pgfpages — see the note)' : '')
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

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { detectRootFile } from '../lib/rootFile.js';
import { locateRootPdf } from '../lib/pdfLocate.js';
import { toPosixOut } from '../lib/paths.js';
import { MAX_TEXT_PAGES, PdfRenderError } from '../services/pdfRender.js';
import type { TextResult } from '../services/pdfRender.js';
import { readAuxFloats } from '../lib/auxFloats.js';
import {
  resolveLabelPages,
  pdfLabelPageReader,
  labelRefusalMessage,
  labelResolutionNote,
  labelPageRangeMessage,
  describeResolvedLabels,
  LABEL_LOOKUP_MAX,
  MAX_LABELS_PER_CALL,
} from '../lib/labelPages.js';
import type { LabelPagePlan } from '../lib/labelPages.js';
import {
  EXTRACT_TEXT_CONTENT_BUDGET,
  planExtractedText,
  renderTextPageBlock,
} from '../lib/extractTextBudget.js';

const inputSchema = {
  project: z.string().optional(),
  rootFile: z
    .string()
    .optional()
    .describe(
      'Root .tex file whose build this reads: its build-dir PDF (and, for `labels`, its ' +
        '.aux), in every workspace mode — pass the same rootFile you compiled with to read a ' +
        'non-default root. Auto-detected when omitted. Only when it is omitted and no .aux is ' +
        'read does a missing build PDF fall back to the surfaced <workspace>/<id>.pdf ' +
        '(workspace-local mode), which holds whichever root compiled last.',
    ),
  pages: z
    .array(z.number().int().positive())
    .min(1, 'Omit pages for every page — an empty array selects zero pages, not "all".')
    .optional()
    .describe(
      '1-based page numbers, in the order given. Defaults to every page, capped at ' +
        `${MAX_TEXT_PAGES} (MAX_TEXT_PAGES) per call — the rest come back in skippedPages. Omit ` +
        'the field for every page; an empty array is rejected rather than silently extracting ' +
        'nothing. Cannot be combined with `labels`.',
    ),
  labels: z
    .array(z.string().min(1))
    .min(1, 'Omit labels rather than passing an empty array — it selects nothing, not "all".')
    .max(MAX_LABELS_PER_CALL)
    .optional()
    .describe(
      'Read the text of the page each \\label{...} landed on, instead of naming page numbers. ' +
        'Resolved exactly as render_pages resolves it — through the build-directory .aux of the ' +
        "LAST COMPILE, converted to a page index through the PDF's own /PageLabels tree when it " +
        'has one — so a label added since the last compile, or one whose reference has not ' +
        'converged, resolves to a STALE page or not at all. Refused in the same cases too, ' +
        'including every label of a build whose records name pgfpages, cannot be read, or ' +
        'hold no shipout mark (see render_pages `labels`). Any label that cannot be resolved ' +
        'refuses the whole call; no page is ever guessed. Cannot be combined with `pages`. At ' +
        `most ${MAX_LABELS_PER_CALL} per call.`,
    ),
};

const pageShape = z.object({
  page: z.number().describe('1-based page number.'),
  lines: z
    .array(z.string())
    .describe(
      "The page's text layer, one entry per merged line, in the order the PDF DRAWS them — " +
        'reading order for ordinary LaTeX output, but never re-sorted, so two interleaved ' +
        'columns come back interleaved rather than in an invented order.',
    ),
  linesOmitted: z
    .number()
    .describe(
      `Lines left out of this page by the call's ${EXTRACT_TEXT_CONTENT_BUDGET}-character text ` +
        'budget (shared by every page of the call, charged on the rendered text in both ' +
        'channels). They are always a suffix of the page, so `lines` is a contiguous prefix ' +
        'rather than a filtered selection.',
    ),
  charsOmitted: z
    .number()
    .describe('How many characters those omitted lines held — the size of the gap, not its count.'),
});

const outputSchema = {
  pdfPath: z
    .string()
    .describe('The compiled PDF the text was read from. POSIX (`/`-separated) on every OS.'),
  pageCount: z.number().describe('Pages in the PDF — not the number of pages extracted.'),
  pages: z.array(pageShape).describe('One entry per page actually extracted, in request order.'),
  skippedPages: z
    .array(z.number())
    .describe(
      `Pages asked for (or implied by the default) that the ${MAX_TEXT_PAGES}-per-call cap left ` +
        'out.',
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
        page: z.number().describe('The 1-based PDF page index its text was read from.'),
      }),
    )
    .optional()
    .describe(
      'Present only when `labels` was used: what each label resolved to, in request order. ' +
        "These numbers come from the LAST COMPILE's .aux (see `note`), not from the source on " +
        'disk.',
    ),
  note: z
    .string()
    .optional()
    .describe(
      'Present when something about the answer is not the default: which pages were cut, by ' +
        'which budget, and — when `labels` was used — the provenance of the page numbers.',
    ),
};

export function registerExtractText(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'extract_text',
    {
      title: "Read the compiled page's text layer",
      description:
        'Read-only over the last compiled PDF — it never compiles. Returns the TYPESET text of ' +
        'the requested pages, line by line, which is the only way to check something that is a ' +
        'few pixels wide in a render: whether an \\xspace macro left a spurious space before a ' +
        "\\textsubscript, whether a ligature or a hyphenation broke a term, what a float's " +
        'caption actually reads after macro expansion. Also the way to read a compiled page at ' +
        'all on a client that cannot display images. ' +
        'Pass `labels` instead of `pages` when the question is about a float rather than a page ' +
        'number — resolved exactly as render_pages resolves it, and refused rather than guessed. ' +
        'Complements the other two: render_pages to LOOK at a page, pdf_geometry to MEASURE it ' +
        '(its `text` kind returns the same merged lines with their boxes, capped much tighter ' +
        'because it is labelling geometry, not returning content), extract_text to READ it. ' +
        'What comes back is the PDF text layer, not the source: macros are expanded, ' +
        'hyphenation is applied, and a line break here is a typeset line, not a source line — ' +
        'use read_file or search_files for the source. Lines come in the order the PDF draws ' +
        `them and are never re-sorted. At most ${MAX_TEXT_PAGES} pages per call, and ONE ` +
        `${EXTRACT_TEXT_CONTENT_BUDGET}-character budget for the whole call, charged on the ` +
        'text as rendered in both channels (roughly half of it is page text) — every page is ' +
        'guaranteed an equal share and a page that needs less passes the rest on, so ask for ' +
        'fewer pages to read more of each. Each page is cut from its end, and whatever a budget ' +
        'cut is counted in linesOmitted/charsOmitted, never dropped silently. ' +
        'Writes nothing into the project or its build directory, but it is NOT free of side ' +
        'effects: like render_pages and pdf_geometry it takes the per-project lock, because a ' +
        "peer session's compile can rewrite the build dir mid-read — so it creates " +
        '<workspace>/.sessions/<project>/ if absent, and can wait on or time out against a peer ' +
        'holding that lock. ' +
        'It never rasterizes, so it does not need the optional native canvas backend ' +
        '(@napi-rs/canvas) that render_pages does. ' +
        'Fails with a message to run compile first when nothing has been compiled yet.',
      inputSchema,
      outputSchema,
    },
    async ({ project, rootFile, pages, labels }) => {
      try {
        // Rejected, never silently resolved — the same house rule render_pages and `diff` apply.
        if (labels && pages) {
          throw new Error(
            'Pass either `pages` or `labels`, not both: `labels` resolves to page numbers, so ' +
              'combining them would mean silently ignoring one of the two.',
          );
        }
        // Invariant: requireProjectDir, NEVER requireGitProject — this reads a build artifact,
        // which a mode:'local' project has exactly as a git-backed one does.
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        // Invariant: runExclusive on a read-only tool, the third deliberate exception after
        // render_pages and pdf_geometry and for the same single reason — what it reads is the
        // temp build dir's PDF (and, for `labels`, its .aux), which a peer session's `compile`
        // rewrites in place. Nothing here writes to the project or the build dir; the lock is
        // about what is being read, not about what is being written. It is bounded by the 30s
        // lock timeout in src/lib/fileLock.ts.
        return await ctx.projectManager.runExclusive(id, async () => {
          // No recordBaseline: nothing here reads a caller-named file through FileService, and a
          // baseline would wrongly claim the caller could now base a write on a file it only
          // used to find a PDF. Same reasoning as render_pages.
          const root = rootFile ?? (await detectRootFile(ctx.files, dir));
          // The ROOT's build PDF — same rule and reason as render_pages (see locateRootPdf).
          const pdfPath = await locateRootPdf(ctx.config, id, dir, root, {
            rootNamed: rootFile !== undefined,
            readsAux: labels !== undefined,
          });
          if (!pdfPath) {
            throw new Error(
              `No compiled PDF found for project "${id}". Run compile first, then extract_text.`,
            );
          }

          // Inside the lock for the same reason render_pages resolves labels inside it: the .aux
          // and the PDF must come from the same build, or the page number and the page would be
          // from different ones. The lock keeps a peer's compile out; locateRootPdf is what makes
          // them the same ROOT's build.
          let labelPlan: LabelPagePlan | undefined;
          if (labels) {
            const aux = await readAuxFloats(dir, root, { max: LABEL_LOOKUP_MAX, shipouts: true });
            labelPlan = await resolveLabelPages(
              labels,
              aux,
              pdfLabelPageReader(ctx.pdfRenderer, pdfPath),
            );
            if (labelPlan.failed.length > 0) {
              throw new Error(labelRefusalMessage(labelPlan, aux));
            }
          }
          const effectivePages = labelPlan ? labelPlan.pages : pages;

          let result: TextResult;
          try {
            result = await ctx.pdfRenderer.text({ pdfPath, pages: effectivePages });
          } catch (err) {
            // Narrowed to selectPages' own message, exactly as render_pages narrows it: a
            // backend or canvas failure must not collect a "your .aux is stale" suffix it did
            // not earn.
            if (
              labelPlan &&
              err instanceof PdfRenderError &&
              err.message.includes('out of range')
            ) {
              throw new Error(labelPageRangeMessage(labelPlan, err.message), { cause: err });
            }
            throw err;
          }

          // One budget for the whole call, over both channels, and the only cut: the service
          // returns every line whole, so the counters are the true gap (see extractTextBudget.ts).
          const plan = planExtractedText(result.pages);
          // Joined, never overwritten — the two notes answer different questions and both can
          // hold at once. Same shape as render_pages' and pdf_geometry's note joining.
          const note =
            [labelPlan ? labelResolutionNote(labelPlan) : undefined, plan.note]
              .filter(Boolean)
              .join(' ') || undefined;

          const { pdfPath: outPdfPath } = toPosixOut({ pdfPath });
          const structuredContent = {
            pdfPath: outPdfPath,
            pageCount: result.pageCount,
            pages: plan.pages,
            skippedPages: result.skippedPages,
            resolvedLabels: labelPlan ? labelPlan.resolved : undefined,
            note,
          };

          const header = `text of ${result.pages.length} of ${result.pageCount} page(s) from ${outPdfPath}`;
          const labelLine = labelPlan
            ? `  labels (from the last compile's .aux): ${describeResolvedLabels(labelPlan.resolved)}`
            : '';
          // Rendered from the already-cut plan, never from `result`: the text channel is the
          // other half of what the budget charged.
          const pageBlocks = plan.pages.map(renderTextPageBlock);
          const skippedLine =
            result.skippedPages.length > 0
              ? `  … ${result.skippedPages.length} page(s) not extracted (at most ` +
                `${MAX_TEXT_PAGES} per call): ${result.skippedPages.join(', ')}`
              : '';
          const noteLine = note ? `  … ${note}` : '';
          const text = [header, labelLine, ...pageBlocks, skippedLine, noteLine]
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

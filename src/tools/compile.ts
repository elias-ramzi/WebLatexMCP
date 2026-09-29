import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { detectRootFile } from '../lib/rootFile.js';
import { toFileUrl, toPosix, toPosixOut } from '../lib/paths.js';
import { surfaceCompiledPdf } from '../lib/pdfSurface.js';
import { compileViewerHint, viewerShowsForCompile } from '../lib/viewerHint.js';
import { attachErrorSnippets } from '../lib/errorSnippets.js';
import {
  unopenablePaths,
  withoutUnopenableLocation,
  MAX_REPORTED_PATH_CHECKS,
} from '../lib/sourceSnippet.js';
import {
  planDiagnosticsPayload,
  DIAGNOSTICS_CONTENT_BUDGET,
  DIAGNOSTICS_MAX_ERRORS,
  DIAGNOSTICS_MAX_WARNINGS,
} from '../lib/diagnosticsBudget.js';
import {
  parseLog,
  fitFilteredLog,
  logTail,
  engineShellEscapeBanner,
  findMissingPackages,
  LOG_TAIL_LINE_CAP,
} from '../services/logParser.js';
import { makeWarningJudge } from '../lib/warningFilter.js';
import {
  applyOverlay,
  describeEvictionFailure,
  evictionFailureHint,
  evictVariants,
  overlayFilesNeverRead,
  overlaySnippetReader,
  refuseLinkedRootDir,
  sourceChangedHint,
  stageVariant,
  variantHandle,
  variantPaths,
  watchSource,
  MAX_OVERLAY_EDITS,
  MAX_OVERLAY_FILES,
  MAX_VARIANTS,
} from '../lib/variants.js';
import type { SourceCheck } from '../lib/variants.js';
import {
  buildRoot,
  engineNotFoundHint,
  ensureBuildRoot,
  shellEscapeOverriddenHint,
  shellEscapeRefusedHint,
  shellEscapeRequested,
  tikzShellEscapeHint,
} from '../services/compiler.js';
import { quoteId } from '../lib/projectId.js';
import { editItemSchema } from './editFile.js';
import type { CompilerKind } from '../types.js';

/** Raw-tail size when `rawLog` is set — generous enough to include the full noise tail. */
const RAW_TAIL_LINES = 400;

/**
 * Characters the never-read hint's list of names may take, rendered, summed over BOTH channels the
 * hint ships in — each quoted name and the `, ` between them, charged once as the text channel
 * prints it and once in its JSON form inside `structuredContent` (where every `"` and `\` of a
 * quoted name costs two). The caller receives the sum, so charging only the larger channel let the
 * list reach twice this figure. The house figure for a merely diagnostic share (as
 * `sourceChangedHint`'s `SOURCE_CHANGES_NAMES_BUDGET`): the names only point back at entries of
 * the caller's own `overlay`, which it already holds in full.
 */
export const OVERLAY_UNREAD_NAMES_BUDGET = 2000;

/**
 * The `hint` for overlaid files the variant build never opened (#216): ONE line for all of them,
 * not one per file. The names are the caller's own paths — up to `MAX_OVERLAY_FILES` of them, each
 * up to PATH_MAX — and the hint ships in both channels, so the list is budgeted by its rendered
 * size in the two summed ({@link OVERLAY_UNREAD_NAMES_BUDGET}), the `capList` shape: names in
 * order while they fit, the rest counted as `, and N more` in the same sentence. The named set is a prefix, and a name is
 * never cut short — a truncated path is not one the caller can find in its overlay. There is no
 * separate count cap: the overlay itself is capped at `MAX_OVERLAY_FILES` (20, the house figure),
 * so a count cap of 20 here could never fire; the character budget is the bound that binds.
 *
 * `success` picks the claim: a successful build that never opened the file had the overlay change
 * nothing (overlay the path TeX actually opens); a failed one may simply have stopped first.
 */
export function overlayNeverReadHint(paths: string[], success: boolean): string {
  const named: string[] = [];
  let used = 0;
  for (const p of paths) {
    const shown = quoteId(p);
    // Text channel: the name as printed. structuredContent: JSON.stringify(x).length - 2, the name
    // as the JSON string carries it, without the quotes that belong to the whole hint.
    const cost =
      (named.length > 0 ? 2 * ', '.length : 0) + shown.length + JSON.stringify(shown).length - 2;
    if (used + cost > OVERLAY_UNREAD_NAMES_BUDGET) break;
    named.push(shown);
    used += cost;
  }
  const more = paths.length - named.length;
  const one = paths.length === 1;
  const list =
    named.length === 0
      ? `${paths.length} overlaid file(s) (their names are too long to list here)`
      : `overlaid ${one ? 'file' : 'files'} ${named.join(', ')}` +
        (more > 0 ? `, and ${more} more` : '');
  const records = `(neither its .fls nor its .fdb_latexmk lists ${one ? 'it' : 'them'})`;
  return success
    ? `The build never read the ${list} ${records}, so the overlay had no effect on ` +
        `${one ? 'it' : 'them'} — overlay the path TeX actually opens instead (the target of a ` +
        'symbolic link, or the name the document inputs).'
    : `The build stopped before reading the ${list} ${records}, so whether the document reads ` +
        `${one ? 'it' : 'them'} is not known yet — fix the errors and compile again.`;
}

const inputSchema = {
  project: z.string().optional(),
  rootFile: z.string().optional().describe('Root .tex file. Auto-detected when omitted.'),
  engine: z.enum(['pdflatex', 'xelatex', 'lualatex']).optional().describe('Default pdflatex.'),
  compiler: z
    .enum(['latexmk', 'tectonic'])
    .optional()
    .describe(
      'Compile backend for this one call, overriding WEB_LATEX_MCP_COMPILER — so a backend that ' +
        'is not installed can be switched without editing the client config and restarting. ' +
        'Naming one here is an assertion: it is never substituted, and a backend that is not on ' +
        'PATH is an error naming what is installed. Omitted, the configured backend is used, and ' +
        'if it is merely the default (WEB_LATEX_MCP_COMPILER names no backend) and missing, an ' +
        'installed one ' +
        'is substituted and reported in `hint`. `compiler` in the result always names what ran.',
    ),
  clean: z.boolean().optional().describe('Force a full rebuild.'),
  timeoutSec: z.number().int().positive().optional().describe('Compile timeout (default 120s).'),
  restrictedShellEscape: z
    .boolean()
    .optional()
    .describe(
      "Pass -shell-restricted, allowing only TeX's allow-listed helper binaries to run " +
        '(repstopdf, makeindex, extractbb, …). Default false — and false means OFF: without it or ' +
        'shellEscape a latexmk compile passes -no-shell-escape, overriding TeX Live’s own default ' +
        '(which is this restricted mode), so a document whose .eps figures are converted by ' +
        'repstopdf, or that runs makeindex through \\write18, needs this set (`hint` says so when ' +
        'the log shows a refused command). The cost: those helpers run in the project directory ' +
        'and can write files there (makeindex -o can overwrite a source file). Prefer this over ' +
        'shellEscape for those helpers. It does NOT enable TikZ externalization ' +
        '(\\tikzexternalize): that runs the engine itself, which the allow-list never holds — ' +
        'only shellEscape does. Tectonic has no restricted mode and ignores it.',
    ),
  shellEscape: z
    .boolean()
    .optional()
    .describe(
      'Pass -shell-escape, letting the .tex run ARBITRARY shell commands during compilation. ' +
        'Default false. SECURITY: only enable for a project you trust — the document comes from a ' +
        'shared remote others can write to. Never enabled automatically, and only when the caller ' +
        'explicitly wants it. The one flag that enables TikZ externalization (\\tikzexternalize), ' +
        "which runs the engine itself — no helper on TeX's allow-list. For a refused repstopdf or " +
        'makeindex, try restrictedShellEscape first.',
    ),
  rawLog: z
    .boolean()
    .optional()
    .describe(
      'Return the raw, unfiltered log tail instead of the de-noised default. Default false: ' +
        'logTail keeps only errors, warnings, and the "Output written on" summary, dropping the ' +
        'font/memory noise. The full log is always at logPath. Raw means raw: rawLog: true is ' +
        'never trimmed by warningsFilter either — only the default, de-noised logTail is. ' +
        '`warnings[]` is still filtered (and warningsOmitted still counts it) either way.',
    ),
  warningsFilter: z
    .object({
      file: z
        .array(z.string())
        .optional()
        .describe(
          'Keep only warnings whose file is exactly one of these — project-relative POSIX, ' +
            'matched EXACTLY as warnings[].file reports it (no globs, no prefixes): the way to ' +
            'get the spelling right is to read it off a previous compile result. A warning the ' +
            'log named no file for is dropped when this is set, even though it would otherwise ' +
            'survive — there is nothing to compare it against, and filtering to one file is not ' +
            'what you want mixed with warnings of unknown origin.',
        ),
      rule: z
        .array(z.string())
        .optional()
        .describe(
          'Keep only warnings whose rule is exactly one of these — the values warnings[].rule ' +
            'carries: "Overfull \\hbox", "Underfull \\vbox", "LaTeX", or a package/class name ' +
            'like "hyperref" — including one carrying a dot or a hyphen, e.g. "pdftex.def" or ' +
            '"tikz-cd". Matched exactly, never a prefix.',
        ),
      excludeRule: z
        .array(z.string())
        .optional()
        .describe(
          'Drop warnings whose rule is exactly one of these. A warning with no rule is never ' +
            'excluded by this — only rule and file ever drop a rule-less/file-less warning.',
        ),
    })
    .optional()
    .describe(
      'Trim warnings[] to the ones you actually want, on a document whose warning-heavy log ' +
        'otherwise dominates the result. Applies to logTail too, in lockstep with warnings[] — ' +
        'an Overfull \\hbox line otherwise ships twice, once structured and once as raw text — ' +
        'except when rawLog: true, where logTail stays whole (see rawLog). Never filters errors, ' +
        'only warnings: a document that fails to compile is not made to look cleaner by a filter ' +
        'meant for box-warning noise. warningsOmitted reports how many warnings this removed. An ' +
        'EMPTY array constrains nothing rather than matching nothing — {file: []} returns every ' +
        'warning, not none — so a list you built programmatically and that came out empty widens ' +
        'the result instead of narrowing it.',
    ),
  overlay: z
    .array(
      z.object({
        file: z.string().describe('Project file to edit for this build, relative to the root.'),
        edits: z
          .array(editItemSchema)
          .min(1)
          .describe(
            "edit_file's edits, with edit_file's rules (string or line-range edits, " +
              'excludeComments; never rewrite preservation), applied in memory to this file.',
          ),
      }),
    )
    .min(1)
    .max(MAX_OVERLAY_FILES)
    .optional()
    .describe(
      'Compile a what-if VARIANT instead of the project: these files with these edits applied ' +
        'in memory, everything else as it is — to measure a change (page count, where a float ' +
        'lands, whether a table still fits) without the server writing the source. The server ' +
        'leaves the source, the main build, the surfaced PDF and the viewer as they were, and ' +
        'records nothing as a change of this session. Like every compile, an overlay compile ' +
        'runs NO shell command unless shellEscape or restrictedShellEscape is set — here that is ' +
        'also what keeps the build from writing the source through the variant, so opting in ' +
        'costs more than usual (see below) — and `hint` says so when a document needed one ' +
        '(makeindex, repstopdf, TikZ externalization); and a latexmkrc / ' +
        '.latexmkrc may not be overlaid (latexmk runs it as Perl). Some routes stay open: the ' +
        "project's own latexmkrc still runs and can turn shell escape back on, lualatex's Lua " +
        "io.open needs no shell escape, and tectonic's \\openout writes any absolute path. So " +
        "the project's files — following its symbolic links, which the build can write " +
        'through — are compared (size, mode, inode and times; no content read) — of a .git ' +
        'directory at the project root only what the next git command runs or reads its ' +
        'configuration from (hooks/, config, …), since the rest of .git changes on every git ' +
        'call — before and after the build: ' +
        'any that ' +
        'changed are named in `hint` — check them and discard what you did not mean — and a ' +
        'log showing shell escape enabled against the request is reported. The result ' +
        'carries a `variant` handle; pass it to render_pages / extract_text / pdf_geometry to ' +
        'inspect that build. Name each file ' +
        `once (all its edits in one entry); at most ${MAX_OVERLAY_FILES} files and ` +
        `${MAX_OVERLAY_EDITS} edits in total. A .bib may be overlaid without confirmBibEdit — ` +
        'the real file is never written. Line numbers in the diagnostics (and snippets) for an ' +
        "overlaid file refer to the variant's text, not the file on disk. shellEscape or " +
        'restrictedShellEscape in an overlay compile lets the document write wherever a normal ' +
        "compile can — including into the source, through the variant's links to it. The " +
        `${MAX_VARIANTS} most recently compiled variants per project are kept; older ones are ` +
        'removed. Recompiling the same overlay reuses its variant (incrementally). rootFile ' +
        'must be relative to the project root — not absolute or drive-qualified (C:), with no ' +
        '".." segment, and not reached through a linked directory — or the overlay compile is ' +
        'refused before anything is read. The variant mirrors the project and not its parent: ' +
        './ and ../ inputs resolve as in the project while they stay inside it, but a ../ input ' +
        'that leaves the project fails here, where a normal compile reads it.',
    ),
};

/** Shared by both arrays; only errors ever carry source context (see {@link errorShape}). */
const diagnosticShape = z.object({
  severity: z.enum(['error', 'warning']),
  file: z
    .string()
    .optional()
    .describe(
      'Source file — project-relative, so a path you can pass straight to read_file (a diagnostic ' +
        'inside the TeX installation itself names an absolute path instead). Absent when the log ' +
        'named none, and dropped for two different reasons, which the result text tells apart: ' +
        'the path leaves the project through a symlink (the log is written by the document, so a ' +
        'path out of it is not one this server hands back), OR it was never resolved at all — ' +
        `checking where a log’s paths lead is capped at ${MAX_REPORTED_PATH_CHECKS} distinct ` +
        'files per compile, and anything past that is withheld the same way but reported as ' +
        'unchecked rather than as an escape. So a missing `file` is not by itself evidence of a ' +
        'symlink.',
    ),
  line: z.number().optional(),
  message: z.string(),
  rule: z.string().optional(),
});

const warningShape = diagnosticShape;

const errorShape = diagnosticShape.extend({
  snippet: z
    .string()
    .optional()
    .describe(
      'The 5 source lines around `line` (2 either side, clamped at the file bounds) — a LaTeX ' +
        'message is often uninterpretable without them, so this usually saves a read_file. ' +
        'At most 10 distinct locations per compile, and never a guess: a diagnostic with no ' +
        'file/line, one whose file the log did not name outright (which is every diagnostic ' +
        'under tectonic, whose logs carry no file:line at all), one the log itself contradicts, ' +
        'and one pointing past the end of its file all carry none. Where several errors share a ' +
        'line they share one snippet, attached to the first of them; the result text prints it ' +
        'once too. See omittedSnippetLocations for how many locations went without.',
    ),
  snippetStartLine: z
    .number()
    .optional()
    .describe("1-based source line of `snippet`'s first line, so the caller can number it."),
});

const outputSchema = {
  success: z.boolean(),
  rootFile: z.string(),
  compiler: z
    .enum(['latexmk', 'tectonic'])
    .describe(
      'The backend that actually ran. Usually the configured one, but when that is only a default ' +
        '(WEB_LATEX_MCP_COMPILER names no backend) and is not on PATH, an installed backend is ' +
        'substituted ' +
        'and `hint` says so. Worth checking before reading the diagnostics: tectonic produces no ' +
        'source snippets at all, since its log names no file:line.',
    ),
  pdfPath: z
    .string()
    .optional()
    .describe(
      'Path to the compiled PDF. For workspace-local clones this is <workspace>/.web_latex_mcp/' +
        '<project>.pdf, surfaced beside the clone for easy opening; otherwise the temp build path. ' +
        "For an overlay compile it is always the variant's own PDF, in its temp build dir " +
        '(variants/<handle>/out/) — a variant is never surfaced. POSIX (`/`-separated) on every OS.',
    ),
  pdfUrl: z
    .string()
    .optional()
    .describe('Clickable file:// URL of the compiled PDF, when produced.'),
  pageCount: z
    .number()
    .optional()
    .describe(
      'How many pages the compiled PDF has, read from the PDF itself rather than the log. This is ' +
        'the cheapest way to catch what a log cannot report: a layout that silently spilled onto a ' +
        'second page is not an error or a warning in TeX’s eyes — it is just `pageCount: 2`. ' +
        'Absent when no PDF was produced, or when it could not be read (run doctor: page ' +
        'counting needs the PDF library, not the optional native canvas backend that only ' +
        'rasterization needs). Use render_pages to actually look at those pages.',
    ),
  durationSec: z
    .number()
    .describe(
      'Seconds the backend run itself took — the compile only, not any wait for the project ' +
        'lock beforehand (see lockWaitSec).',
    ),
  rebuilt: z
    .boolean()
    .describe(
      'Whether this run wrote a fresh PDF. false means the backend found nothing to do — the ' +
        "PDF is a previous run's, often a peer session's that just compiled the same clone — " +
        'not a rebuild from your edits; pass clean: true to force one.',
    ),
  pdfMtime: z
    .string()
    .optional()
    .describe(
      'ISO time the PDF was last written, read from the build output — not from the surfaced copy.',
    ),
  lockWaitSec: z
    .number()
    .describe(
      'Seconds this call waited for the project lock before compiling; 0 when uncontended. Not ' +
        'included in durationSec.',
    ),
  lockHeldBy: z
    .string()
    .optional()
    .describe(
      'The session that held the lock while this call waited — a peer process, or this very ' +
        'session when a concurrent call in the same process still held it.',
    ),
  errors: z
    .array(errorShape)
    .describe(
      "The compile errors, in the order the log reports them — TeX's first error is usually the " +
        'cause and the ones after it the cascade, so this is cut as a TAIL, never reordered. ' +
        `At most ${DIAGNOSTICS_MAX_ERRORS} of them (plus any later one carrying a snippet, so a ` +
        'source excerpt the server already vouched for is never thrown away by the cap), and ' +
        `fewer when the ${DIAGNOSTICS_CONTENT_BUDGET}-character result budget bites first. ` +
        'Warnings are cut before errors, and at least one error is always returned. What went is ' +
        'counted in errorsOmittedByCap and explained in note; the complete set is in the log at ' +
        'logPath.',
    ),
  warnings: z
    .array(warningShape)
    .describe(
      `At most ${DIAGNOSTICS_MAX_WARNINGS} warnings, and fewer when the ` +
        `${DIAGNOSTICS_CONTENT_BUDGET}-character result budget (shared with errors[], which is ` +
        'allocated first) bites — a normal build emits hundreds, and an unbounded list is how a ' +
        'result gets rejected by a client and delivers nothing at all. Cut as a tail, in log ' +
        'order. TWO different things can shorten this list and they are counted apart: ' +
        'warningsOmitted is what YOUR warningsFilter removed, warningsOmittedByCap is what did ' +
        'not fit. Either way the latest box lines are still in logTail (which keeps its own share ' +
        'of the budget) and everything is in logPath.',
    ),
  errorsOmittedByCap: z
    .number()
    .describe(
      'How many errors this result does not carry because they did not fit — over the ' +
        `${DIAGNOSTICS_MAX_ERRORS}-error cap, or over the ${DIAGNOSTICS_CONTENT_BUDGET}-character ` +
        'budget charged across both channels (the first errors are rendered into the result text ' +
        'with their snippets as well as into structuredContent). 0 means errors[] is the whole ' +
        'set. Never a filter: warningsFilter does not touch errors. `note` says which bound ' +
        'fired; read the omitted ones in the log at logPath.',
    ),
  warningsOmittedByCap: z
    .number()
    .describe(
      'How many warnings this result does not carry because they did not fit — over the ' +
        `${DIAGNOSTICS_MAX_WARNINGS}-warning cap, or over the shared ` +
        `${DIAGNOSTICS_CONTENT_BUDGET}-character budget, for which errors[] is allocated first. ` +
        'This is NOT warningsOmitted: that one counts what your own warningsFilter removed at ' +
        'your request, which is a different claim, and the two are never added together. A ' +
        'non-zero value here on a call you passed no filter to means the document simply has ' +
        'more warnings than one result can carry — narrow warningsFilter to spend the budget on ' +
        'the ones you want, or read logPath.',
    ),
  warningsOmitted: z
    .number()
    .describe(
      'How many entries warningsFilter removed from warnings[] — 0 when no filter was given, or ' +
        'when it matched everything. Non-zero means the list you are reading is a subset by your ' +
        'own request: re-run without the filter, or read logPath, to see the rest. It counts ' +
        'warnings[] entries ONLY, and is deliberately not a line count for logTail: the same ' +
        'filter runs over the log, but the log carries warning lines that were never structured ' +
        'warnings (a "LaTeX Font Warning:", a bare "pdfTeX warning") which drop without being ' +
        'counted here, while a rerun hint ("Label(s) may have changed") is a structured warning ' +
        'that is kept in the tail regardless. Read this number against warnings[], never against ' +
        'the size of logTail. It is also NOT a count of what the result-size budget cut — that is ' +
        'warningsOmittedByCap, a different claim about a different cause, and adding the two ' +
        'together is never right.',
    ),
  missingPackages: z
    .array(z.string())
    .describe(
      'LaTeX packages/classes the compile could not find, e.g. ["fontawesome"] — pulled out of the ' +
        'log\'s "File `x.sty\' not found" errors so you do not have to parse them yourself. Only ' +
        '.sty/.cls names appear here: a missing image or .bbl is a problem with the document, not a ' +
        'missing package. Empty when nothing is missing.',
    ),
  logTail: z
    .string()
    .describe(
      'De-noised log excerpt: only errors, warnings, and the "Output written on" summary (font ' +
        'and memory noise stripped). Bounded in characters as well as lines: each line is cut at ' +
        `${LOG_TAIL_LINE_CAP} characters with a marker saying how many went, and the whole tail ` +
        `is charged against the ${DIAGNOSTICS_CONTENT_BUDGET}-character result budget — sharing ` +
        'what errors[] leaves with warnings[] — so on a long log its EARLIEST lines are dropped, ' +
        'counted in its first line and in note. warningsFilter runs over this too, by the same ' +
        'rule it ' +
        'applies to warnings[], so a warning you filtered out does not still ship here as raw ' +
        'text — that duplication is most of what makes a warning-heavy result large. The two are ' +
        'not line-for-line equal, and warningsOmitted is not a count of what left here: see that ' +
        'field. Errors, their l.<n> context, rerun hints and the output summary are never ' +
        'filtered. When a filter rejects every diagnostic line, this says so in one sentence ' +
        'rather than falling back to the raw tail, which would hand back the very lines you ' +
        'excluded. Pass rawLog: true for the unfiltered tail — never trimmed by warningsFilter, ' +
        'nor cut or charged by the budget; logPath has the full log.',
    ),
  logPath: z
    .string()
    .optional()
    .describe('Path to the full compile log. POSIX (`/`-separated) on every OS.'),
  omittedSnippetLocations: z
    .number()
    .describe(
      'How many distinct error **locations** carry no `snippet` — over the 10-location cap, or ' +
        'unreadable, or not named outright by the log, or contradicted by it, or naming a path ' +
        'that leaves the project through a symlink, or naming one past the ' +
        `${MAX_REPORTED_PATH_CHECKS}-file cap on resolving where the log’s paths lead (never ` +
        'checked, which is not the same claim as an escape). 0 means every ' +
        'located error IN THIS RESULT has its source context: co-located errors share one ' +
        'snippet, so an error without one is not a gap when 0. Counted where the snippets are ' +
        'attached, which is BEFORE the result-size cap, so it answers "what could the log be ' +
        'vouched for" and not "what fit": an error the cap dropped takes its snippet with it and ' +
        'is counted in errorsOmittedByCap instead — never here, since nothing about that ' +
        'location went unvouched. Read the two together; either being non-zero is the flag for ' +
        '"there is more to see".',
    ),
  note: z
    .string()
    .optional()
    .describe(
      'What the result-size cap cut from errors[]/warnings[]/logTail (or from the message of ' +
        'the one error always kept) and how to get the rest. Present ' +
        'only when something actually was cut, and it names only the bound that fired. Distinct ' +
        'from `hint`, which is about the compile itself (a missing package, a needed ' +
        'shell-escape retry) rather than about what this result could carry.',
    ),
  variant: z
    .string()
    .optional()
    .describe(
      'Present only for an overlay compile: the handle of the what-if build it made. Pass it as ' +
        '`variant` to render_pages, extract_text or pdf_geometry to read that build rather than ' +
        'the main one. Evicted once it is no longer among the ' +
        `${MAX_VARIANTS} most recently compiled variants of the project.`,
    ),
  hint: z
    .string()
    .optional()
    .describe(
      'Server advice about this compile, one item per line — and not only on failure. First, ' +
        'when the configured backend was only a default and was not installed, which backend was ' +
        'substituted for it: this appears on a SUCCESSFUL compile too, since it changes how to ' +
        'read everything else (tectonic yields no snippets). Then any known remedy for a ' +
        'failure: the LaTeX engine latexmk tried to run (pdflatex/xelatex/lualatex) is not ' +
        'installed — said only when the log names no error of its own — or the document uses ' +
        'TikZ externalization and needs a shell-escape retry, or the engine refused a shell ' +
        'command the document ran (repstopdf for an .eps figure, makeindex: shell escape is off ' +
        'unless you opt in) — naming the flag that runs it and what enabling it costs — or the ' +
        "engine's log shows shell escape enabled although this call left it off (a latexmkrc " +
        'overrode -no-shell-escape, so the document could run shell commands), or a ' +
        'package is missing from the ' +
        'local TeX installation. For an overlay compile, also: first, the project files the ' +
        'build changed while it ran (the one thing here you may have to undo); after the engine ' +
        "note, the overlaid files the build never opened (by the variant's .fls and " +
        '.fdb_latexmk — so never under tectonic, which writes no .fls), or, on a failed build, ' +
        'the ones it stopped before reading — one line naming them in order while they fit ' +
        `${OVERLAY_UNREAD_NAMES_BUDGET} characters (text and structuredContent together), the ` +
        'rest counted as "and N more"; and last, ' +
        'an older variant that could not be removed. ' +
        'Absent when there is nothing to say.',
    ),
};

/**
 * What to do about packages the compile could not find. The server never installs anything itself,
 * so this is advice, not an action — and it depends on which backend ran: latexmk draws on a system
 * TeX installation, where the answer is that distribution's own installer and its no-root variant
 * (a missing package on a shared machine is usually a permissions problem rather than a missing
 * mirror), while tectonic has no system installation to install into at all.
 */
function missingPackageHint(names: string[], backend: CompilerKind): string {
  const args = names.join(' ');
  // Graded against the backend that actually ran, not the configured one — a default-configured
  // user on a machine with no TeX is now routed onto tectonic by the fallback, and `tlmgr` is
  // neither installed there nor able to affect tectonic's cache. Sending them after it is exactly
  // the wrong-path detour this whole change exists to stop.
  if (backend === 'tectonic') {
    return (
      `Not in tectonic's bundle, or not fetched: ${names.join(', ')}. tectonic downloads what a ` +
      'document needs into its own cache, so this is usually either no network on a cold cache ' +
      '(retry once connected) or a package its bundle genuinely does not carry. `tlmgr` and ' +
      '`mpm` do not apply — they manage a system TeX installation, which is not what compiled ' +
      'this. If the package is essential, compile with latexmk against a full TeX distribution ' +
      '(set WEB_LATEX_MCP_COMPILER=latexmk, or pass compiler: "latexmk"); if the document does ' +
      'not actually need it, drop the \\usepackage line instead.'
    );
  }
  return (
    `Missing from your local TeX installation: ${names.join(', ')}. Install with your TeX ` +
    `distribution and compile again — TeX Live: \`tlmgr install ${args}\` (or ` +
    `\`tlmgr --usermode install ${args}\` when you have no root); MiKTeX: ` +
    `\`mpm --install=${names[0] ?? ''}\`. If that install itself fails, run doctor — it reports ` +
    'whether this machine can reach a package repository at all. If the document does not ' +
    'actually need it, drop the \\usepackage line instead.'
  );
}

export function registerCompile(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'compile',
    {
      title: 'Compile the project locally',
      description:
        'Compile the project locally (latexmk by default, or tectonic — pass `compiler` to pick ' +
        'one for this call, and read it back in the result to see which actually ran) and return success, ' +
        'the PDF path, and structured errors/warnings (each attributed to its source .tex file ' +
        'when known — an error also carries the 5 source lines around it, so you rarely need a ' +
        'read_file to interpret it) plus a de-noised log tail — only errors, warnings, and the output summary, ' +
        'not the font/memory dump (pass rawLog: true for the unfiltered tail). Does not touch the ' +
        'Overleaf remote. TikZ externalization (\\tikzexternalize) runs the engine through a ' +
        'system call, which only shellEscape: true allows (restrictedShellEscape does not: TeX’s ' +
        'allow-list holds no engine) — it lets the .tex run ARBITRARY shell commands, so only ' +
        'enable it for a trusted project. Shell escape is ' +
        'never enabled automatically: without either flag latexmk gets -no-shell-escape, so not ' +
        'even TeX Live’s default restricted allow-list runs (an .eps figure needing repstopdf, or ' +
        'makeindex via \\write18, then needs restrictedShellEscape: true), and when the log shows ' +
        'a command refused, or a compile fails for lack of shell escape, the result carries a ' +
        'hint. (A latexmkrc can still re-enable it: latexmk hands the flag to the engine through ' +
        '%O.) ' +
        'A failure caused by a package the local TeX installation does not have names it in ' +
        'missingPackages, so you can act on it without parsing the log. On a warning-heavy ' +
        'document, warningsFilter trims warnings[] AND logTail together (warningsOmitted counts ' +
        'the removed ones) — never errors. The result is budgeted either way ' +
        `(${DIAGNOSTICS_CONTENT_BUDGET} characters across both channels for errors, warnings and ` +
        'logTail, warnings cut before errors, what went counted in ' +
        'errorsOmittedByCap/warningsOmittedByCap and explained in note; only rawLog: true is ' +
        'exempt), so a build with hundreds of box warnings comes back bounded instead of being ' +
        'rejected by the client and delivering nothing. Also reports whether the ' +
        'backend actually wrote a fresh PDF (`rebuilt` — false means a peer session already ' +
        'compiled this shared clone and there was nothing to do) and how long this call waited ' +
        'for the project lock before compiling (`lockWaitSec`, with `lockHeldBy` when contended). ' +
        'Pass `overlay` to compile a what-if variant instead — some files with edit_file-style ' +
        'edits applied in memory — and measure it (pageCount, render_pages / extract_text / ' +
        'pdf_geometry with the returned `variant`) without the server writing the source or the ' +
        'main build ' +
        '(any project file the build still changed is named in `hint`).',
      inputSchema,
      outputSchema,
    },
    async ({
      project,
      rootFile,
      engine,
      clean,
      timeoutSec,
      rawLog,
      shellEscape,
      restrictedShellEscape,
      compiler,
      warningsFilter,
      overlay,
    }) => {
      try {
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        // Preflight the backend before taking the project lock: choosing one is global, touches no
        // project file, and throwing here costs nothing. Without it a missing backend surfaced as a
        // raw `spawn latexmk ENOENT`, naming neither the env var nor the backend that would work.
        const backend = await ctx.compiler.select(compiler);
        return await ctx.projectManager.runExclusive(id, async (lock) => {
          const root = rootFile ?? (await detectRootFile(ctx.files, dir));
          // An overlay compile builds a variant: the edited text is applied in memory (read
          // through FileService under the project's link policy, never written back, no baseline)
          // and compiled in a link farm with its own build dir — see src/lib/variants.ts.
          let variant:
            | {
                handle: string;
                contents: Map<string, string>;
                outDir: string;
                workDir: string;
                sourceChanges: () => Promise<SourceCheck>;
              }
            | undefined;
          if (overlay) {
            // The root's spelling and directory path are judged before the overlay is read: a
            // refusal here must not wait on (or be masked by) an overlay entry's own error.
            await refuseLinkedRootDir(dir, root);
            // The build root is created or verified before anything of the overlay runs — the
            // same fail-closed check every build dir gets (#215). Applying the overlay can already
            // write under the root (the case probe `applyOverlay` runs for several entries creates
            // the project's variants dir), and staging certainly does; checking only before
            // staging let a planted root receive both first.
            await ensureBuildRoot();
            const contents = await applyOverlay(ctx.files, dir, overlay);
            const handle = variantHandle({
              rootFile: root,
              engine,
              compiler: backend.kind,
              shellEscape,
              restrictedShellEscape,
              overlay,
            });
            const skip = [ctx.config.workspaceRoot, buildRoot()];
            // stageVariant judges the root again itself before it creates the variant's
            // directories: the check is one mkdir + lstat and deliberately never memoised.
            const paths = await stageVariant({
              projectDir: dir,
              handle,
              rootFile: root,
              engine: engine ?? 'pdflatex',
              compiler: backend.kind,
              contents,
              skip,
            });
            // Snapshot the source AFTER staging (on win32 staging hard-links and unlinks source
            // files, which moves their change time) and compare right after the build, before
            // eviction does the same. Some routes from the farm back into the source are not the
            // server's to close (see `snapshotSource`), so the result reports what the build
            // actually did to the project rather than asserting "untouched". The workspace is
            // skipped by equality alone (a local project may contain it, and a project link into
            // a sibling clone is written through like any other); the build root, which the build
            // writes by design, with everything under it.
            const sourceChanges = await watchSource(dir, {
              skip: [ctx.config.workspaceRoot],
              skipTree: [buildRoot()],
            });
            variant = { handle, contents, outDir: paths.out, workDir: paths.src, sourceChanges };
          }
          // Shell escape is off unless the caller opted in — for every compile, not only a
          // variant (#213): the backend passes latexmk `-no-shell-escape` whenever neither flag is
          // set, since TeX Live's default (`shell_escape = p`) otherwise runs its allow-list with
          // no flag at all, writing relative to the project (or, in a variant's farm, through its
          // links into the source).
          // "On" as the backend that runs reads the request: tectonic ignores restrictedShellEscape.
          const shellEscapeOn = shellEscapeRequested(
            { shellEscape, restrictedShellEscape },
            backend.kind,
          );
          const outcome = await backend.compiler.compile({
            projectDir: dir,
            rootFile: root,
            engine,
            clean,
            timeoutSec,
            shellEscape,
            restrictedShellEscape,
            ...(variant ? { workDir: variant.workDir, outDir: variant.outDir } : {}),
          });
          const sourceCheck = variant ? await variant.sourceChanges() : undefined;
          const changedSource = sourceCheck?.changed;
          // Why it could not be checked, for the variant line: a cause that stays (a committed
          // link loop) fails every check, so it has to be findable.
          const uncheckedReason =
            sourceCheck !== undefined && sourceCheck.changed === undefined
              ? sourceCheck.reason
              : undefined;
          // Retention runs after the compile, under the same lock, and never removes this one. It
          // is best-effort: an old variant that cannot be removed (a viewer holding its PDF open on
          // Windows) must not throw away the compile that just finished.
          let evictionFailure: string | undefined;
          if (variant) {
            try {
              await evictVariants(dir, MAX_VARIANTS, variant.handle);
            } catch (err) {
              evictionFailure = evictionFailureHint(err);
              console.error(
                `[compile] could not remove an old variant of ${quoteId(id)}: ` +
                  describeEvictionFailure(err),
              );
            }
          }
          // The log's paths are relative to the directory the engine ran in (latexmk's `-cd`), not
          // to the project root — rebase them there so a `file` is one the caller can open.
          // Captured output (no engine .log found) has no header anything may rest on.
          const logSource = { capturedOutput: outcome.capturedOutput === true };
          const { errors: parsedErrors, warnings } = parseLog(outcome.log, {
            baseDir: outcome.logBaseDir,
            ...logSource,
          });
          // Errors carry their source context; warnings do not — a normal build has hundreds of
          // them and attaching a snippet to each would bloat every successful compile's result.
          const { errors: located, omittedLocations: omittedSnippetLocations } =
            await attachErrorSnippets(
              // An overlaid file's snippet comes from the text that was compiled, not the disk.
              variant ? overlaySnippetReader(ctx.files, variant.contents) : ctx.files,
              dir,
              parsedErrors,
            );
          // A path out of the project through a symlink is not handed back as somewhere to read
          // next — for warnings as much as errors, since both come off the same document-written
          // log. Refusing only the snippet read would leave the guard one hop deep.
          const withheld = await unopenablePaths(ctx.files, dir, [...located, ...warnings]);
          // Note the order: `omittedSnippetLocations` was counted in the pass above, so a snippet
          // taken away here is not added to it. Only a past-the-cap location can lose one (a path
          // that escapes is refused the read, so it never had a snippet), and reaching that cap
          // takes 200+ distinct paths — the count is in the hundreds by then, so the promise that
          // matters, "0 means every located error has its source context", still holds: 0 is not
          // reachable in the one case that undercounts.
          const errors = located.map((e) => withoutUnopenableLocation(e, withheld.all));
          const shownWarnings = warnings.map((w) => withoutUnopenableLocation(w, withheld.all));
          // One judge, built once and handed to both channels — `warnings[]` here and `logTail`'s
          // `keepWarning` below — so they can never disagree about a warning. `undefined` means
          // the filter constrains nothing, and both channels skip the machinery entirely. See
          // `makeWarningJudge` for why the withholding is applied inside the predicate rather
          // than by the caller. Never filters errors: a failing document is not made to look
          // cleaner by a filter meant for warning noise.
          const judgeWarning = makeWarningJudge(withheld.all, warningsFilter);
          const shownFilteredWarnings = judgeWarning
            ? shownWarnings.filter(judgeWarning)
            : shownWarnings;
          const warningsOmitted = shownWarnings.length - shownFilteredWarnings.length;
          const missingPackages = findMissingPackages(outcome.log);
          // Never silently retry with shell escape — that would turn a compile into arbitrary code
          // execution without consent. Surface a hint and let the caller opt in explicitly.
          const hints: string[] = [];
          // First: it reframes everything below it. A substituted backend means the caller is not
          // reading the diagnostics they expected — under tectonic, notably, none of them carry a
          // snippet — so say which engine spoke before explaining what it said.
          if (backend.note) hints.push(backend.note);
          // Next: a variant build that wrote the project is the one thing here the caller may
          // have to undo.
          if (changedSource !== undefined && changedSource.length > 0) {
            hints.push(sourceChangedHint(changedSource));
          }
          // Then: an engine latexmk could not run explains a failure that otherwise reads as
          // "FAILED — 0 error(s)" and nothing else. The gate (failed, nothing parsed) and the
          // wording are the service's; this only places it.
          const engineHint = engineNotFoundHint(outcome, parsedErrors.length);
          if (engineHint) hints.push(engineHint);
          // An overlaid file the build never opened changed nothing, and the variant would read as
          // the main build without a word — say so, naming it. No .fls (tectonic): nothing claimed.
          // A FAILED build may simply have stopped before reaching it, so it is not told to
          // overlay another path.
          if (variant) {
            const unread = await overlayFilesNeverRead(variantPaths(dir, variant.handle), root, [
              ...variant.contents.keys(),
            ]);
            if (unread !== undefined && unread.length > 0) {
              hints.push(overlayNeverReadHint(unread, outcome.success));
            }
          }
          // The service words it: shellEscape: true only, since TeX's restricted allow-list never
          // holds the engine call externalization makes.
          const tikzHint = tikzShellEscapeHint(outcome.log, {
            ...logSource,
            shellEscapeOn,
            backend: backend.kind,
          });
          if (tikzHint) hints.push(tikzHint);
          // Shell escape was off (above), so a command the installation's default would have run
          // — repstopdf for an .eps figure, makeindex — was refused: say which switch brings it
          // back and what flipping it costs. One hint for every compile; the service words it.
          const refusedHint = shellEscapeRefusedHint(outcome.log, {
            ...logSource,
            shellEscapeOn,
            overlay: variant !== undefined,
            backend: backend.kind,
          });
          if (refusedHint) hints.push(refusedHint);
          // The opposite surprise: the caller left shell escape off, and the engine's own banner
          // says it was on anyway — for every compile, not only a variant's line below.
          const overriddenHint = shellEscapeOverriddenHint(outcome.log, {
            ...logSource,
            shellEscapeOn,
            backend: backend.kind,
          });
          if (overriddenHint) hints.push(overriddenHint);
          if (missingPackages.length > 0)
            hints.push(missingPackageHint(missingPackages, backend.kind));
          // Last: housekeeping, not this compile — an older variant that could not be removed.
          if (evictionFailure !== undefined) hints.push(evictionFailure);
          const hint = hints.length > 0 ? hints.join('\n') : undefined;
          // For workspace-local clones, copy the PDF beside the clone (<workspace>/<id>.pdf) so
          // the user can open the latest build from their editor instead of hunting the temp dir.
          // Never for a variant: the surfaced copy is the project's latest build, which an
          // overlay compile does not change.
          let pdfPath = outcome.pdfPath;
          if (pdfPath && ctx.config.workspaceIsLocal && !variant) {
            pdfPath = await surfaceCompiledPdf(ctx.config.workspaceRoot, id, pdfPath);
          }
          const pdfUrl = pdfPath ? toFileUrl(pdfPath) : undefined;
          // Read the page count off the PDF, not the log's "Output written on … (N pages" line:
          // that line is absent from a failed run that still produced a PDF, and the PDF is the
          // thing the caller actually has. Never fatal — a compile that produced a document must
          // not be reported as failed because a count could not be read (the count needs only
          // pdf.js, not the optional canvas backend, but a broken install or an unreadable PDF
          // can still make it fail).
          let pageCount: number | undefined;
          if (pdfPath) {
            try {
              pageCount = await ctx.pdfRenderer.pageCount(pdfPath);
            } catch {
              pageCount = undefined;
            }
          }
          // The response boundary, and it sits below everything above rather than one line
          // earlier. `ctx.pdfRenderer.pageCount` opens the PDF off the real filesystem, so it needs
          // the host's own spelling — that half is load-bearing. `toFileUrl` would accept either
          // (`pathToFileURL` resolves through `path.win32.resolve`, so `C:\a\b` and `C:/a/b` give
          // the same URL); it stays above the line because it takes a filesystem path rather than a
          // string chosen for a reader, not because the URL would otherwise break. Past this point
          // nothing touches a disk, and the paths are converted in one call so the text channel and
          // structuredContent cannot disagree about a separator.
          const { pdfPath: outPdfPath, logPath: outLogPath } = toPosixOut({
            pdfPath,
            logPath: outcome.logPath,
          });
          const lockWaitSec = Math.round(lock.waitedMs / 100) / 10;
          const lockHeldBy = lock.waitedOn;
          // ONE plan drives both channels (issue #162) and every document-controlled payload in
          // them: `errors[]`, `warnings[]`, and the de-noised `logTail`, whose 80-line bound was
          // never a character bound (each line is an un-wrapped logical line). The plan carries the
          // text rendering of the errors it KEPT, so the text channel cannot re-render the full
          // set behind the budget's back (the rule `diff.ts` and `searchFiles.ts` follow), and it
          // fits `logTail` through the same `judgeWarning` that trimmed `warnings[]` above, so the
          // two channels still cannot disagree about a warning. `rawLog: true` is not a lane:
          // raw means raw, so it is neither charged nor cut, and the plan returns no tail for it.
          const diagnostics = planDiagnosticsPayload(
            errors,
            shownFilteredWarnings,
            rawLog
              ? {}
              : {
                  fitLogTail: (maxChars) =>
                    fitFilteredLog(outcome.log, {
                      maxChars,
                      ...(judgeWarning
                        ? { baseDir: outcome.logBaseDir, keepWarning: judgeWarning }
                        : {}),
                    }),
                },
          );
          const structuredContent = {
            success: outcome.success,
            rootFile: root,
            compiler: backend.kind,
            pdfPath: outPdfPath,
            pdfUrl,
            pageCount,
            durationSec: outcome.durationSec,
            rebuilt: outcome.rebuilt,
            pdfMtime: outcome.pdfMtime,
            lockWaitSec,
            lockHeldBy,
            errors: diagnostics.errors,
            warnings: diagnostics.warnings,
            errorsOmittedByCap: diagnostics.errorsOmittedByCap,
            warningsOmittedByCap: diagnostics.warningsOmittedByCap,
            warningsOmitted,
            missingPackages,
            // The plan fitted a tail exactly when `rawLog` is off; otherwise this is the raw one.
            logTail: diagnostics.logTail ?? logTail(outcome.log, RAW_TAIL_LINES),
            logPath: outLogPath,
            omittedSnippetLocations,
            ...(diagnostics.note ? { note: diagnostics.note } : {}),
            ...(variant ? { variant: variant.handle } : {}),
            hint,
          };
          // Name the backend in the text too, not only structuredContent: which engine spoke
          // decides how to read what follows (tectonic attaches no snippets to anything), and the
          // client this rendering exists for is the one that cannot read structuredContent at all.
          let headline = outcome.timedOut
            ? `compile${variant ? ` of variant ${variant.handle}` : ''} timed out after ${outcome.durationSec.toFixed(1)}s (${backend.kind})`
            : `${outcome.success ? 'compiled' : 'FAILED'} ${variant ? `variant ${variant.handle} of ` : ''}${root} with ${backend.kind} in ${outcome.durationSec.toFixed(1)}s — ` +
              `${pageCount !== undefined ? `${pageCount} page(s), ` : ''}` +
              `${errors.length} error(s), ${shownFilteredWarnings.length} warning(s)` +
              (warningsOmitted > 0 ? ` (${warningsOmitted} filtered out)` : '');
          // A fast "success" right after a peer session compiled the same clone is easy to
          // mistake for a rebuild from this call's own edits — say plainly when it wasn't one.
          if (outcome.success && !outcome.rebuilt) headline += ' (up to date — not rebuilt)';
          if (lockWaitSec >= 0.5) {
            headline +=
              `; waited ${lockWaitSec.toFixed(1)}s for the lock` +
              (lockHeldBy ? ` held by "${lockHeldBy}"` : '');
          }
          // Render the source context into the text too, not only structuredContent: a client that
          // strips structured output (see lib/outputSchemaCompat) would otherwise never see it.
          // Errors sharing a location print the snippet once. Which errors the text lists, and
          // what that costs, is one decision made in `diagnosticsBudget.ts` — rendered here from
          // the errors the budget KEPT, never from the full array beside it.
          const errorLines = diagnostics.errorLines;
          const dropped = [
            diagnostics.errors.length > diagnostics.errorsInText
              ? `  … ${diagnostics.errors.length - diagnostics.errorsInText} more error(s) — see structuredContent or ${outLogPath ?? 'the log'}`
              : '',
            // Said in the text as well as in structuredContent, and charged there: the client this
            // rendering exists for is the one that cannot read the counters at all, and a list
            // silently missing two thirds of a build's warnings is exactly what a budget must not
            // produce.
            diagnostics.note ? `  … ${diagnostics.note}` : '',
            omittedSnippetLocations > 0
              ? `  … no source context for ${omittedSnippetLocations} error location(s) — the log ` +
                `did not name the file and line outright (every diagnostic, under tectonic), or ` +
                `they are unreadable, contradicted by the log, or past the 10-location cap`
              : '',
            withheld.escaped > 0
              ? `  … ${withheld.escaped} path(s) the log named leave the project through a symlink; ` +
                `reported without file/line, since a path the document chose is not one to open`
              : '',
            // Kept apart from the line above on purpose: past the cap nothing was resolved, so
            // nothing is known — calling these escapes sends the caller after a link that is not
            // there, and blames the document for the server's own bound.
            withheld.unchecked > 0
              ? `  … ${withheld.unchecked} path(s) past the ${MAX_REPORTED_PATH_CHECKS}-file limit ` +
                `on resolving where a log's paths lead; reported without file/line because they ` +
                `were never checked, not because anything is wrong with them`
              : '',
          ]
            .filter(Boolean)
            .join('\n');
          // Surface the live viewer whenever there's something to look at: its URL if it's already
          // running — saying whether it now shows THIS build, since it follows the auto-detected
          // root and not `rootFile` — else a pointer that the tool exists.
          // Not for a variant: the viewer shows the project's own build, which this did not touch.
          const viewerUrl =
            pdfPath && !variant && ctx.viewer.isRunning() ? ctx.viewer.urlFor(id) : undefined;
          const viewerLine =
            pdfPath && !variant
              ? compileViewerHint(
                  viewerUrl
                    ? {
                        url: viewerUrl,
                        builtRoot: toPosix(root),
                        shows: await viewerShowsForCompile(ctx.files, ctx.config, id, dir, root),
                      }
                    : undefined,
                )
              : '';
          // Every claim here is one the build's own record backs: the source's state from the
          // before/after comparison, shell escape's from the engine's banner — the latexmk flag
          // alone reaches the engine only through %O, which a project latexmkrc can override.
          // The banner is read from the log's header only, which the engine writes before the
          // document: one the document `\typeout`s into the body would blame a latexmkrc that
          // does not exist. "Off" needs the header READ and holding no banner ('none'); with no
          // header to read (no engine .log found — latexmk's captured output stood in) neither
          // "on" nor "off" is claimed, whatever that output opens with. Tectonic reads no
          // latexmkrc, so there the flag it was given is the whole answer.
          const headerBanner = engineShellEscapeBanner(outcome.log, logSource);
          const escapeReenabled =
            !shellEscapeOn && (headerBanner === 'full' || headerBanner === 'restricted');
          const escapeOffConfirmed = headerBanner === 'none' || backend.kind === 'tectonic';
          const variantLine = variant
            ? `variant ${variant.handle}: pass variant to render_pages / extract_text / ` +
              'pdf_geometry to inspect it. ' +
              (changedSource === undefined
                ? 'The main build, the surfaced PDF and the viewer are untouched; whether the ' +
                  'build wrote a project file could not be checked this time' +
                  (uncheckedReason !== undefined ? ` (${uncheckedReason}).` : '.')
                : changedSource.length > 0
                  ? `The build CHANGED ${changedSource.length} project file(s) (see hint); ` +
                    'the main build, the surfaced PDF and the viewer are untouched.'
                  : 'The source (checked: no project file changed while it built — of a .git ' +
                    'directory at the project root, if there is one, only what git runs or ' +
                    'reads its configuration from, such as hooks/ and config, is checked), the ' +
                    'main build, the surfaced PDF and the viewer are untouched.') +
              (shellEscapeOn
                ? " Shell escape was on, so the document's shell commands could write anywhere — " +
                  "the source included, through the variant's links to it."
                : escapeReenabled
                  ? ' Shell escape was requested off, but the log shows it enabled: a ' +
                    "latexmkrc (the project's own, or a user or system one) overrode the flag, " +
                    "so the document's shell commands could run."
                  : escapeOffConfirmed
                    ? ' Shell escape was off for this build.'
                    : ' Whether shell escape was off for this build could not be confirmed: no ' +
                      'engine log with a readable header was found for it (a latexmkrc that ' +
                      'renames the job leaves the log where the server does not look).')
            : '';
          const text = [
            headline,
            variantLine,
            pdfUrl ? `PDF: ${pdfUrl}` : '',
            errorLines,
            dropped,
            hint ? `hint: ${hint}` : '',
            viewerLine,
          ]
            .filter(Boolean)
            .join('\n');
          return {
            content: [{ type: 'text', text }],
            structuredContent,
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

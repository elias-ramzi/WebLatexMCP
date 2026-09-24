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
  needsShellEscape,
  findMissingPackages,
  LOG_TAIL_LINE_CAP,
} from '../services/logParser.js';
import { makeWarningJudge } from '../lib/warningFilter.js';
import type { CompilerKind } from '../types.js';

/** Raw-tail size when `rawLog` is set — generous enough to include the full noise tail. */
const RAW_TAIL_LINES = 400;

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
      "Pass -shell-restricted, allowing only TeX's allow-listed helper binaries to run. This is " +
        'the safer way to enable TikZ externalization (\\tikzexternalize) and is enough for most ' +
        'setups. Default false. Prefer this over shellEscape.',
    ),
  shellEscape: z
    .boolean()
    .optional()
    .describe(
      'Pass -shell-escape, letting the .tex run ARBITRARY shell commands during compilation. ' +
        'Default false. SECURITY: only enable for a project you trust — the document comes from a ' +
        'shared remote others can write to. Never enabled automatically; try restrictedShellEscape ' +
        'first, and enable this only when the caller explicitly wants it.',
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
        'POSIX (`/`-separated) on every OS.',
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
  hint: z
    .string()
    .optional()
    .describe(
      'Server advice about this compile, one item per line — and not only on failure. First, ' +
        'when the configured backend was only a default and was not installed, which backend was ' +
        'substituted for it: this appears on a SUCCESSFUL compile too, since it changes how to ' +
        'read everything else (tectonic yields no snippets). Then any known remedy for a ' +
        'failure: the document uses TikZ externalization and needs a shell-escape retry, or a ' +
        'package is missing from the local TeX installation. Absent when there is nothing to say.',
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
        'Overleaf remote. TikZ externalization (\\tikzexternalize) needs system calls: retry with ' +
        'restrictedShellEscape: true (preferred) or shellEscape: true — the latter lets the .tex ' +
        'run ARBITRARY shell commands, so only enable it for a trusted project. Shell escape is ' +
        'never enabled automatically; when a compile fails for lack of it, the result carries a hint. ' +
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
        'for the project lock before compiling (`lockWaitSec`, with `lockHeldBy` when contended).',
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
    }) => {
      try {
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        // Preflight the backend before taking the project lock: choosing one is global, touches no
        // project file, and throwing here costs nothing. Without it a missing backend surfaced as a
        // raw `spawn latexmk ENOENT`, naming neither the env var nor the backend that would work.
        const backend = await ctx.compiler.select(compiler);
        return await ctx.projectManager.runExclusive(id, async (lock) => {
          const root = rootFile ?? (await detectRootFile(ctx.files, dir));
          const outcome = await backend.compiler.compile({
            projectDir: dir,
            rootFile: root,
            engine,
            clean,
            timeoutSec,
            shellEscape,
            restrictedShellEscape,
          });
          // The log's paths are relative to the directory the engine ran in (latexmk's `-cd`), not
          // to the project root — rebase them there so a `file` is one the caller can open.
          const { errors: parsedErrors, warnings } = parseLog(outcome.log, {
            baseDir: outcome.logBaseDir,
          });
          // Errors carry their source context; warnings do not — a normal build has hundreds of
          // them and attaching a snippet to each would bloat every successful compile's result.
          const { errors: located, omittedLocations: omittedSnippetLocations } =
            await attachErrorSnippets(ctx.files, dir, parsedErrors);
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
          const shellEscapeOn = shellEscape || restrictedShellEscape;
          const hints: string[] = [];
          // First: it reframes everything below it. A substituted backend means the caller is not
          // reading the diagnostics they expected — under tectonic, notably, none of them carry a
          // snippet — so say which engine spoke before explaining what it said.
          if (backend.note) hints.push(backend.note);
          if (!shellEscapeOn && needsShellEscape(outcome.log)) {
            hints.push(
              'This document uses TikZ externalization, which needs system calls. Retry compile ' +
                'with restrictedShellEscape: true (preferred) or shellEscape: true. Only enable ' +
                'this for a project you trust — shell escape lets the .tex run arbitrary commands.',
            );
          }
          if (missingPackages.length > 0)
            hints.push(missingPackageHint(missingPackages, backend.kind));
          const hint = hints.length > 0 ? hints.join('\n') : undefined;
          // For workspace-local clones, copy the PDF beside the clone (<workspace>/<id>.pdf) so
          // the user can open the latest build from their editor instead of hunting the temp dir.
          let pdfPath = outcome.pdfPath;
          if (pdfPath && ctx.config.workspaceIsLocal) {
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
            hint,
          };
          // Name the backend in the text too, not only structuredContent: which engine spoke
          // decides how to read what follows (tectonic attaches no snippets to anything), and the
          // client this rendering exists for is the one that cannot read structuredContent at all.
          let headline = outcome.timedOut
            ? `compile timed out after ${outcome.durationSec.toFixed(1)}s (${backend.kind})`
            : `${outcome.success ? 'compiled' : 'FAILED'} ${root} with ${backend.kind} in ${outcome.durationSec.toFixed(1)}s — ` +
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
          const viewerUrl = pdfPath && ctx.viewer.isRunning() ? ctx.viewer.urlFor(id) : undefined;
          const viewerLine = pdfPath
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
          const text = [
            headline,
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

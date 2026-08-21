import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { detectRootFile } from '../lib/rootFile.js';
import { toFileUrl } from '../lib/paths.js';
import { surfaceCompiledPdf } from '../lib/pdfSurface.js';
import { compileViewerHint } from '../lib/viewerHint.js';
import { attachErrorSnippets } from '../lib/errorSnippets.js';
import {
  formatSnippet,
  unopenablePaths,
  withoutUnopenableLocation,
  MAX_REPORTED_PATH_CHECKS,
} from '../lib/sourceSnippet.js';
import {
  parseLog,
  filterLog,
  logTail,
  needsShellEscape,
  findMissingPackages,
} from '../services/logParser.js';

/** Raw-tail size when `rawLog` is set — generous enough to include the full noise tail. */
const RAW_TAIL_LINES = 400;

/** How many errors the result text lists before pointing at structuredContent and the log. */
const MAX_TEXT_ERRORS = 10;

const inputSchema = {
  project: z.string().optional(),
  rootFile: z.string().optional().describe('Root .tex file. Auto-detected when omitted.'),
  engine: z.enum(['pdflatex', 'xelatex', 'lualatex']).optional().describe('Default pdflatex.'),
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
        'font/memory noise. The full log is always at logPath.',
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
        'named none, and dropped when the one it named leaves the project through a symlink: the ' +
        'log is written by the document, so a path out of it is not one this server hands back.',
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
  pdfPath: z
    .string()
    .optional()
    .describe(
      'Path to the compiled PDF. For workspace-local clones this is <workspace>/.web_latex_mcp/' +
        '<project>.pdf, surfaced beside the clone for easy opening; otherwise the temp build path.',
    ),
  pdfUrl: z
    .string()
    .optional()
    .describe('Clickable file:// URL of the compiled PDF, when produced.'),
  durationSec: z.number(),
  errors: z.array(errorShape),
  warnings: z.array(warningShape),
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
        'and memory noise stripped). Pass rawLog: true for the unfiltered tail; logPath has the full log.',
    ),
  logPath: z.string().optional(),
  omittedSnippetLocations: z
    .number()
    .describe(
      'How many distinct error **locations** carry no `snippet` — over the 10-location cap, or ' +
        'unreadable, or not named outright by the log, or contradicted by it, or naming a path ' +
        'that leaves the project through a symlink. 0 means every ' +
        'located error has its source context: co-located errors share one snippet, so an error ' +
        'without one is not a gap when 0. This is the flag for "there is more to see".',
    ),
  hint: z
    .string()
    .optional()
    .describe(
      'An actionable next step surfaced when the failure has a known remedy — e.g. the document ' +
        'uses TikZ externalization and needs a shell-escape retry, or a package is missing from the ' +
        'local TeX installation. Absent when there is nothing to advise.',
    ),
};

/**
 * What to do about packages the local TeX installation does not have. The server never installs
 * anything itself, so this is advice, not an action: it names the distribution's own installer and
 * the no-root variant, since a missing package on a shared machine is usually a permissions problem
 * rather than a missing mirror.
 */
function missingPackageHint(names: string[]): string {
  const args = names.join(' ');
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
        'Compile the project locally (latexmk by default, or tectonic) and return success, ' +
        'the PDF path, and structured errors/warnings (each attributed to its source .tex file ' +
        'when known — an error also carries the 5 source lines around it, so you rarely need a ' +
        'read_file to interpret it) plus a de-noised log tail — only errors, warnings, and the output summary, ' +
        'not the font/memory dump (pass rawLog: true for the unfiltered tail). Does not touch the ' +
        'Overleaf remote. TikZ externalization (\\tikzexternalize) needs system calls: retry with ' +
        'restrictedShellEscape: true (preferred) or shellEscape: true — the latter lets the .tex ' +
        'run ARBITRARY shell commands, so only enable it for a trusted project. Shell escape is ' +
        'never enabled automatically; when a compile fails for lack of it, the result carries a hint. ' +
        'A failure caused by a package the local TeX installation does not have names it in ' +
        'missingPackages, so you can act on it without parsing the log.',
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
    }) => {
      try {
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        return await ctx.projectManager.runExclusive(id, async () => {
          const root = rootFile ?? (await detectRootFile(ctx.files, dir));
          const outcome = await ctx.compiler.compile({
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
          const errors = located.map((e) => withoutUnopenableLocation(e, withheld.all));
          const shownWarnings = warnings.map((w) => withoutUnopenableLocation(w, withheld.all));
          const missingPackages = findMissingPackages(outcome.log);
          // Never silently retry with shell escape — that would turn a compile into arbitrary code
          // execution without consent. Surface a hint and let the caller opt in explicitly.
          const shellEscapeOn = shellEscape || restrictedShellEscape;
          const hints: string[] = [];
          if (!shellEscapeOn && needsShellEscape(outcome.log)) {
            hints.push(
              'This document uses TikZ externalization, which needs system calls. Retry compile ' +
                'with restrictedShellEscape: true (preferred) or shellEscape: true. Only enable ' +
                'this for a project you trust — shell escape lets the .tex run arbitrary commands.',
            );
          }
          if (missingPackages.length > 0) hints.push(missingPackageHint(missingPackages));
          const hint = hints.length > 0 ? hints.join('\n') : undefined;
          // For workspace-local clones, copy the PDF beside the clone (<workspace>/<id>.pdf) so
          // the user can open the latest build from their editor instead of hunting the temp dir.
          let pdfPath = outcome.pdfPath;
          if (pdfPath && ctx.config.workspaceIsLocal) {
            pdfPath = await surfaceCompiledPdf(ctx.config.workspaceRoot, id, pdfPath);
          }
          const pdfUrl = pdfPath ? toFileUrl(pdfPath) : undefined;
          const structuredContent = {
            success: outcome.success,
            rootFile: root,
            pdfPath,
            pdfUrl,
            durationSec: outcome.durationSec,
            errors,
            warnings: shownWarnings,
            missingPackages,
            logTail: rawLog ? logTail(outcome.log, RAW_TAIL_LINES) : filterLog(outcome.log),
            logPath: outcome.logPath,
            omittedSnippetLocations,
            hint,
          };
          const headline = outcome.timedOut
            ? `compile timed out after ${outcome.durationSec.toFixed(1)}s`
            : `${outcome.success ? 'compiled' : 'FAILED'} ${root} in ${outcome.durationSec.toFixed(1)}s — ${errors.length} error(s), ${warnings.length} warning(s)`;
          // Render the source context into the text too, not only structuredContent: a client that
          // strips structured output (see lib/outputSchemaCompat) would otherwise never see it.
          // Errors sharing a location print the snippet once.
          // Which errors the text lists: the first MAX_TEXT_ERRORS, plus any later one carrying a
          // snippet. Snippets attach per location while this window counts errors, so capping
          // purely by position dropped excerpts the server had already paid to read — and the
          // client this rendering exists for is precisely the one that cannot read them out of
          // structuredContent. The snippet cap bounds how many extras this can add.
          let listed = 0;
          const printable = errors.filter((e) => {
            if (listed < MAX_TEXT_ERRORS) {
              listed++;
              return true;
            }
            return e.snippet !== undefined;
          });
          const errorLines = printable
            .map((e) => {
              const head = `  ${e.file ?? '?'}:${e.line ?? '?'} ${e.message}`;
              // Each snippet is carried once per location, so this prints every excerpt once.
              return e.snippet ? `${head}\n${formatSnippet(e, e.line)}` : head;
            })
            .join('\n');
          const dropped = [
            errors.length > printable.length
              ? `  … ${errors.length - printable.length} more error(s) — see structuredContent or ${outcome.logPath ?? 'the log'}`
              : '',
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
          // running (this build just hot-reloaded into it), else a pointer that the tool exists.
          const viewerLine = pdfPath
            ? compileViewerHint(ctx.viewer.isRunning() ? ctx.viewer.urlFor(id) : undefined)
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

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { detectRootFile } from '../lib/rootFile.js';
import { toFileUrl } from '../lib/paths.js';
import { surfaceCompiledPdf } from '../lib/pdfSurface.js';
import { compileViewerHint } from '../lib/viewerHint.js';
import {
  parseLog,
  filterLog,
  logTail,
  needsShellEscape,
  findMissingPackages,
} from '../services/logParser.js';

/** Raw-tail size when `rawLog` is set — generous enough to include the full noise tail. */
const RAW_TAIL_LINES = 400;

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

const errorShape = z.object({
  severity: z.enum(['error', 'warning']),
  file: z.string().optional(),
  line: z.number().optional(),
  message: z.string(),
  rule: z.string().optional(),
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
  warnings: z.array(errorShape),
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
        'when known) plus a de-noised log tail — only errors, warnings, and the output summary, ' +
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
          const { errors, warnings } = parseLog(outcome.log);
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
            warnings,
            missingPackages,
            logTail: rawLog ? logTail(outcome.log, RAW_TAIL_LINES) : filterLog(outcome.log),
            logPath: outcome.logPath,
            hint,
          };
          const headline = outcome.timedOut
            ? `compile timed out after ${outcome.durationSec.toFixed(1)}s`
            : `${outcome.success ? 'compiled' : 'FAILED'} ${root} in ${outcome.durationSec.toFixed(1)}s — ${errors.length} error(s), ${warnings.length} warning(s)`;
          const errorLines = errors
            .slice(0, 10)
            .map((e) => `  ${e.file ?? '?'}:${e.line ?? '?'} ${e.message}`)
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

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { detectRootFile } from '../lib/rootFile.js';
import { toFileUrl } from '../lib/paths.js';
import { surfaceCompiledPdf } from '../lib/pdfSurface.js';
import { parseLog, filterLog, logTail } from '../services/logParser.js';

/** Raw-tail size when `rawLog` is set — generous enough to include the full noise tail. */
const RAW_TAIL_LINES = 400;

const inputSchema = {
  project: z.string().optional(),
  rootFile: z.string().optional().describe('Root .tex file. Auto-detected when omitted.'),
  engine: z.enum(['pdflatex', 'xelatex', 'lualatex']).optional().describe('Default pdflatex.'),
  clean: z.boolean().optional().describe('Force a full rebuild.'),
  timeoutSec: z.number().int().positive().optional().describe('Compile timeout (default 120s).'),
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
  logTail: z
    .string()
    .describe(
      'De-noised log excerpt: only errors, warnings, and the "Output written on" summary (font ' +
        'and memory noise stripped). Pass rawLog: true for the unfiltered tail; logPath has the full log.',
    ),
  logPath: z.string().optional(),
};

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
        'Overleaf remote.',
      inputSchema,
      outputSchema,
    },
    async ({ project, rootFile, engine, clean, timeoutSec, rawLog }) => {
      try {
        const { id, dir } = await ctx.projectManager.requireClonedDir(project);
        return await ctx.projectManager.runExclusive(id, async () => {
          const root = rootFile ?? (await detectRootFile(ctx.files, dir));
          const outcome = await ctx.compiler.compile({
            projectDir: dir,
            rootFile: root,
            engine,
            clean,
            timeoutSec,
          });
          const { errors, warnings } = parseLog(outcome.log);
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
            logTail: rawLog ? logTail(outcome.log, RAW_TAIL_LINES) : filterLog(outcome.log),
            logPath: outcome.logPath,
          };
          const headline = outcome.timedOut
            ? `compile timed out after ${outcome.durationSec.toFixed(1)}s`
            : `${outcome.success ? 'compiled' : 'FAILED'} ${root} in ${outcome.durationSec.toFixed(1)}s — ${errors.length} error(s), ${warnings.length} warning(s)`;
          const errorLines = errors
            .slice(0, 10)
            .map((e) => `  ${e.file ?? '?'}:${e.line ?? '?'} ${e.message}`)
            .join('\n');
          const text = [headline, pdfUrl ? `PDF: ${pdfUrl}` : '', errorLines]
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

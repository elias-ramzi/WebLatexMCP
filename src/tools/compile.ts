import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { detectRootFile } from '../lib/rootFile.js';
import { parseLog, logTail } from '../services/logParser.js';

const inputSchema = {
  project: z.string().optional(),
  rootFile: z.string().optional().describe('Root .tex file. Auto-detected when omitted.'),
  engine: z.enum(['pdflatex', 'xelatex', 'lualatex']).optional().describe('Default pdflatex.'),
  clean: z.boolean().optional().describe('Force a full rebuild.'),
  timeoutSec: z.number().int().positive().optional().describe('Compile timeout (default 120s).'),
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
  pdfPath: z.string().optional(),
  durationSec: z.number(),
  errors: z.array(errorShape),
  warnings: z.array(errorShape),
  logTail: z.string(),
  logPath: z.string().optional(),
};

export function registerCompile(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'compile',
    {
      title: 'Compile the project locally',
      description:
        'Compile the project with latexmk locally and return success, the PDF path, and ' +
        'structured errors/warnings plus a raw log tail. Does not touch the Overleaf remote.',
      inputSchema,
      outputSchema,
    },
    async ({ project, rootFile, engine, clean, timeoutSec }) => {
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
          const structuredContent = {
            success: outcome.success,
            rootFile: root,
            pdfPath: outcome.pdfPath,
            durationSec: outcome.durationSec,
            errors,
            warnings,
            logTail: logTail(outcome.log),
            logPath: outcome.logPath,
          };
          const headline = outcome.timedOut
            ? `compile timed out after ${outcome.durationSec.toFixed(1)}s`
            : `${outcome.success ? 'compiled' : 'FAILED'} ${root} in ${outcome.durationSec.toFixed(1)}s — ${errors.length} error(s), ${warnings.length} warning(s)`;
          const errorLines = errors
            .slice(0, 10)
            .map((e) => `  ${e.file ?? '?'}:${e.line ?? '?'} ${e.message}`)
            .join('\n');
          const text = [headline, outcome.pdfPath ? `PDF: ${outcome.pdfPath}` : '', errorLines]
            .filter(Boolean)
            .join('\n');
          return {
            content: [{ type: 'text', text }],
            structuredContent,
          };
        });
      } catch (err) {
        return errorResult(err, ctx.git.secrets());
      }
    },
  );
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';

const inputSchema = {
  project: z.string().optional(),
  filter: z
    .enum(['tex', 'bib', 'assets', 'all'])
    .optional()
    .describe('tex -> .tex, bib -> .bib, assets -> images/pdf, all (default).'),
  subdir: z.string().optional().describe('Restrict listing to a subdirectory of the project.'),
};

const outputSchema = {
  files: z.array(
    z.object({
      path: z.string(),
      type: z.enum(['tex', 'bib', 'asset', 'other']),
      sizeBytes: z.number(),
    }),
  ),
};

export function registerListFiles(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'list_files',
    {
      title: 'List project files',
      description: 'List files in a cloned project, optionally filtered to .tex / .bib / assets.',
      inputSchema,
      outputSchema,
    },
    async ({ project, filter = 'all', subdir }) => {
      try {
        const { dir } = await ctx.projectManager.requireClonedDir(project);
        const files = await ctx.files.list(dir, { filter, subdir });
        const text =
          files.length === 0
            ? 'No matching files.'
            : files.map((f) => `${f.path} (${f.type}, ${f.sizeBytes}B)`).join('\n');
        return {
          content: [{ type: 'text', text }],
          structuredContent: { files },
        };
      } catch (err) {
        return errorResult(err, ctx.git.secrets());
      }
    },
  );
}

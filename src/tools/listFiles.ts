import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';

const inputSchema = {
  project: z.string().optional(),
  filter: z
    .enum(['tex', 'bib', 'docs', 'assets', 'all'])
    .optional()
    .describe(
      'tex -> .tex, bib -> .bib, docs -> prose documents (.md/.markdown/.txt/.rst/.org), ' +
        'assets -> images/pdf, all (default).',
    ),
  subdir: z.string().optional().describe('Restrict listing to a subdirectory of the project.'),
};

const outputSchema = {
  files: z.array(
    z.object({
      path: z.string(),
      type: z.enum(['tex', 'bib', 'doc', 'asset', 'other']),
      sizeBytes: z.number(),
    }),
  ),
};

export function registerListFiles(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'list_files',
    {
      title: 'List project files',
      description:
        'List files in a project, optionally filtered to .tex / .bib / prose documents / ' +
        'assets. Works on a local project as well as a clone.',
      inputSchema,
      outputSchema,
    },
    async ({ project, filter = 'all', subdir }) => {
      try {
        const { dir } = await ctx.projectManager.requireProjectDir(project);
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
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

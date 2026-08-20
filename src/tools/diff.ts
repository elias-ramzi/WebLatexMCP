import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';

const inputSchema = {
  project: z.string().optional(),
  path: z.string().optional().describe('Limit the diff to a single file.'),
  staged: z.boolean().optional().describe('Show staged (cached) changes instead of working tree.'),
};

const outputSchema = {
  diff: z.string(),
  files: z.array(z.object({ path: z.string(), added: z.number(), removed: z.number() })),
};

export function registerDiff(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'diff',
    {
      title: 'Git diff',
      description:
        'Show the unified diff plus per-file added/removed line counts, for review before committing.',
      inputSchema,
      outputSchema,
    },
    async ({ project, path: relPath, staged }) => {
      try {
        ctx.projectManager.requireGitProject(project, 'diff against');
        const { dir } = await ctx.projectManager.requireProjectDir(project);
        const result = await ctx.git.diff(dir, { path: relPath, staged });
        const summary = result.files.length
          ? result.files.map((f) => `${f.path} +${f.added} -${f.removed}`).join('\n')
          : 'No changes.';
        return {
          content: [{ type: 'text', text: result.diff ? `${summary}\n\n${result.diff}` : summary }],
          structuredContent: { ...result },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

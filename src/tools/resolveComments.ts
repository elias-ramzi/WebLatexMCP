import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';

const inputSchema = {
  project: z.string().optional(),
  ids: z
    .array(z.string())
    .optional()
    .describe('Comment ids to mark resolved. Omit to resolve every open comment.'),
};

const outputSchema = {
  resolved: z.number().describe('How many comments were marked resolved.'),
};

export function registerResolveComments(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'resolve_comments',
    {
      title: 'Mark PDF comments resolved',
      description:
        'Mark PDF review comments as resolved after addressing them, so the viewer dims their ' +
        'markers. Pass specific `ids` (from list_comments) or omit to resolve every open comment ' +
        'for the project. Does not edit files or push.',
      inputSchema,
      outputSchema,
    },
    async ({ project, ids }) => {
      try {
        const { id } = await ctx.projectManager.requireProjectDir(project);
        const resolved = ctx.comments.resolve(id, ids);
        return {
          content: [{ type: 'text', text: `Resolved ${resolved} comment(s).` }],
          structuredContent: { resolved },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

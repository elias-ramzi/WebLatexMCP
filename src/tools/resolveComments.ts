import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { commentSurface } from '../lib/docComments.js';

const inputSchema = {
  project: z.string().optional(),
  ids: z
    .array(z.string())
    .optional()
    .describe('Comment ids to mark resolved. Omit to resolve every open comment.'),
  document: z
    .string()
    .optional()
    .describe(
      'With `ids` omitted: resolve only the open comments of this markdown document (as passed ' +
        'to `viewer`). Ignored when `ids` is given.',
    ),
  pdfOnly: z
    .boolean()
    .optional()
    .describe(
      'With `ids` omitted: only the comments made on the compiled PDF — none from documents. ' +
        'Ignored when `document` is given.',
    ),
};

const outputSchema = {
  resolved: z.number().describe('How many comments were marked resolved.'),
};

export function registerResolveComments(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'resolve_comments',
    {
      title: 'Mark viewer comments resolved',
      description:
        'Mark viewer review comments (on the PDF or on a markdown document) as resolved after ' +
        'addressing them, so the viewer clears them. Pass specific `ids` (from list_comments), or ' +
        "omit them to resolve every open comment of the project — or only one document's, with " +
        "`document`, or only the PDF's, with `pdfOnly`. Does not edit files or push.",
      inputSchema,
      outputSchema,
    },
    async ({ project, ids, document, pdfOnly }) => {
      try {
        const { id } = await ctx.projectManager.requireProjectDir(project);
        const resolved = ctx.comments.resolve(id, ids, commentSurface(document, pdfOnly));
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

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { bibEditBlockedMessage, isBibFile } from '../lib/bib.js';

const inputSchema = {
  project: z.string().optional(),
  path: z.string().describe('Path relative to the project root.'),
  confirmBibEdit: z
    .boolean()
    .optional()
    .describe('Required to delete a .bib file. Only set this after the user approves it.'),
};

const outputSchema = {
  path: z.string(),
  deleted: z.boolean(),
};

export function registerDeleteFile(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'delete_file',
    {
      title: 'Delete a project file',
      description: 'Delete a file from the project working tree. Commit afterwards to persist it.',
      inputSchema,
      outputSchema,
    },
    async ({ project, path: relPath, confirmBibEdit }) => {
      try {
        if (isBibFile(relPath) && !confirmBibEdit) {
          throw new Error(bibEditBlockedMessage(relPath));
        }
        const { id, dir } = await ctx.projectManager.requireClonedDir(project);
        return await ctx.projectManager.runExclusive(id, async () => {
          const res = await ctx.files.delete(dir, relPath);
          return {
            content: [{ type: 'text', text: `deleted ${res.path}` }],
            structuredContent: { path: res.path, deleted: true },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

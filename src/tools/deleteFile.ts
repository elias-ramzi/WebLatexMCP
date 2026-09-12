import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { bibEditBlockedMessage, isBibFile } from '../lib/bib.js';

const inputSchema = {
  project: z.string().optional(),
  path: z.string().describe('Path relative to the project root.'),
  overrideExternalChanges: z
    .boolean()
    .optional()
    .describe(
      'Delete even if the file changed on disk since it was last read through this server ' +
        '(e.g. edited directly by the user).',
    ),
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
    async ({ project, path: relPath, overrideExternalChanges, confirmBibEdit }) => {
      try {
        if (isBibFile(relPath) && !confirmBibEdit) {
          throw new Error(bibEditBlockedMessage(relPath));
        }
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        // No linkTarget check here (unlike write_file/edit_file/add_asset): FileService.delete
        // ends in rm(abs), which unlinks the symlink itself — the .bib at the far end is never
        // touched, so refusing "figures/x.png -> ../refs.bib" would only block removing a stale
        // link a collaborator committed, while confirmBibEdit: true would "approve" a bibliography
        // change that never actually happens. The literal isBibFile(relPath) check above is the
        // whole guard for delete_file.
        return await ctx.projectManager.runExclusive(id, async () => {
          const res = await ctx.files.delete(dir, relPath, { overrideExternalChanges });
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

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { bibEditBlockedMessage, isBibFile } from '../lib/bib.js';

const inputSchema = {
  project: z.string().optional(),
  path: z.string().describe('Path relative to the project root.'),
  content: z.string().describe('Full file content to write.'),
  createDirs: z.boolean().optional().describe('Create missing parent directories (default false).'),
  confirmBibEdit: z
    .boolean()
    .optional()
    .describe(
      'Required to write a .bib file directly. Add references via add_citation instead; ' +
        'only set this after the user approves a manual bibliography change.',
    ),
};

const outputSchema = {
  path: z.string(),
  bytesWritten: z.number(),
  created: z.boolean(),
  diff: z.string(),
};

export function registerWriteFile(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'write_file',
    {
      title: 'Write a project file',
      description:
        'Create a new file or fully overwrite an existing one. Prefer edit_file for ' +
        'surgical changes to existing files.',
      inputSchema,
      outputSchema,
    },
    async ({ project, path: relPath, content, createDirs, confirmBibEdit }) => {
      try {
        if (isBibFile(relPath) && !confirmBibEdit) {
          throw new Error(bibEditBlockedMessage(relPath));
        }
        const { id, dir } = await ctx.projectManager.requireClonedDir(project);
        return await ctx.projectManager.runExclusive(id, async () => {
          const res = await ctx.files.write(dir, { path: relPath, content, createDirs });
          const { diff } = await ctx.git.diff(dir, { path: relPath });
          return {
            content: [
              {
                type: 'text',
                text: `${res.created ? 'created' : 'wrote'} ${res.path} (${res.bytesWritten} bytes)`,
              },
            ],
            structuredContent: { ...res, diff },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

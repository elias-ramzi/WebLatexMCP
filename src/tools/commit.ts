import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';

const inputSchema = {
  project: z.string().optional(),
  message: z.string().min(1).describe('Commit message.'),
  paths: z
    .array(z.string())
    .optional()
    .describe('Specific paths to stage. Defaults to all changes.'),
  allowEmpty: z.boolean().optional().describe('Allow a commit with no changes.'),
};

const outputSchema = {
  committed: z.boolean(),
  sha: z.string(),
  filesChanged: z.number(),
};

export function registerCommit(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'commit',
    {
      title: 'Commit changes',
      description:
        'Stage and commit changes locally. Does NOT push — use the push tool, after reviewing ' +
        'with status/diff, to send commits to Overleaf.',
      inputSchema,
      outputSchema,
    },
    async ({ project, message, paths, allowEmpty }) => {
      try {
        const { id, dir } = await ctx.projectManager.requireClonedDir(project);
        return await ctx.projectManager.runExclusive(id, async () => {
          const res = await ctx.git.commit(dir, { message, paths, allowEmpty });
          return {
            content: [
              {
                type: 'text',
                text: `committed ${res.sha.slice(0, 8)} (${res.filesChanged} file(s)) — not yet pushed`,
              },
            ],
            structuredContent: { ...res },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.git.secrets());
      }
    },
  );
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';

const inputSchema = {
  project: z.string().optional(),
  paths: z
    .array(z.string())
    .optional()
    .describe('Limit the discard to these paths. Defaults to all changes.'),
  confirm: z
    .literal(true)
    .describe('Must be true — discarding permanently loses uncommitted changes.'),
};

const outputSchema = {
  discarded: z.boolean(),
};

export function registerDiscard(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'discard',
    {
      title: 'Discard uncommitted changes',
      description:
        'Revert the working tree to the last commit (and remove untracked files), optionally ' +
        'limited to paths. Destructive — requires confirm=true.',
      inputSchema,
      outputSchema,
    },
    async ({ project, paths }) => {
      try {
        const { id, dir } = await ctx.projectManager.requireClonedDir(project);
        return await ctx.projectManager.runExclusive(id, async () => {
          const res = await ctx.git.discard(dir, paths);
          return {
            content: [{ type: 'text', text: 'discarded uncommitted changes' }],
            structuredContent: { ...res },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

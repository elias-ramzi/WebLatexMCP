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
        ctx.projectManager.requireGitProject(project, 'discard changes in');
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        return await ctx.projectManager.runExclusive(id, async () => {
          const res = await ctx.git.discard(dir, paths);
          // The working tree was rewritten to HEAD; drop baselines so the reverted content
          // isn't later mistaken for an out-of-band user edit.
          ctx.files.resetBaselines(dir);
          // Discard is not session-scoped — it throws away every session's uncommitted work, so
          // every session's record of that work has to go too, or later edits get misattributed.
          await ctx.shadows.clearAll(id);
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

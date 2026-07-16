import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';

const inputSchema = {
  project: z.string().optional(),
};

const outputSchema = {
  branch: z.string(),
  ahead: z.number(),
  behind: z.number(),
  clean: z.boolean(),
  staged: z.array(z.string()),
  unstaged: z.array(z.string()),
  untracked: z.array(z.string()),
  externalChanges: z
    .array(z.string())
    .describe('Files changed on disk directly (not via this server this session).'),
};

export function registerStatus(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'status',
    {
      title: 'Git status',
      description: 'Show branch, ahead/behind counts, and staged/unstaged/untracked files.',
      inputSchema,
      outputSchema,
    },
    async ({ project }) => {
      try {
        const { dir } = await ctx.projectManager.requireClonedDir(project);
        const status = await ctx.git.status(dir);
        // Flag files a human edited directly (as opposed to changes the tools made), so the
        // agent acknowledges them before writing over them.
        const externalChanges = await ctx.files.externalModifications(dir, [
          ...status.unstaged,
          ...status.untracked,
        ]);
        const text = [
          `branch ${status.branch} (ahead ${status.ahead}, behind ${status.behind})`,
          status.clean ? 'working tree clean' : 'working tree has changes',
          status.staged.length ? `staged: ${status.staged.join(', ')}` : '',
          status.unstaged.length ? `unstaged: ${status.unstaged.join(', ')}` : '',
          status.untracked.length ? `untracked: ${status.untracked.join(', ')}` : '',
          externalChanges.length
            ? `⚠ changed directly (not via tools): ${externalChanges.join(', ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n');
        return {
          content: [{ type: 'text', text }],
          structuredContent: { ...status, externalChanges },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

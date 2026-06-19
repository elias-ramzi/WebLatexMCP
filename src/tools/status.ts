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
        const text = [
          `branch ${status.branch} (ahead ${status.ahead}, behind ${status.behind})`,
          status.clean ? 'working tree clean' : 'working tree has changes',
          status.staged.length ? `staged: ${status.staged.join(', ')}` : '',
          status.unstaged.length ? `unstaged: ${status.unstaged.join(', ')}` : '',
          status.untracked.length ? `untracked: ${status.untracked.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        return {
          content: [{ type: 'text', text }],
          structuredContent: { ...status },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { redact } from '../lib/redact.js';

const inputSchema = {
  project: z.string().optional(),
  confirm: z
    .literal(true)
    .describe('Must be set to true to confirm pushing committed changes to Overleaf.'),
};

const outputSchema = {
  pushed: z.boolean(),
  remote: z.string(),
  summary: z.string(),
};

export function registerPush(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'push',
    {
      title: 'Push to Overleaf',
      description:
        'Push committed changes to the Overleaf remote. Requires confirm=true. Refuses if the ' +
        'local clone is behind/diverged from the remote — run project_sync first.',
      inputSchema,
      outputSchema,
    },
    async ({ project }) => {
      try {
        const cfg = ctx.projectManager.getProjectConfig(project);
        const { id, dir } = await ctx.projectManager.requireClonedDir(cfg.id);
        return await ctx.projectManager.runExclusive(id, async () => {
          const res = await ctx.git.push(dir, cfg.gitUrl);
          const safeRemote = redact(res.remote, ctx.git.secrets());
          return {
            content: [{ type: 'text', text: res.summary }],
            structuredContent: { ...res, remote: safeRemote },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.git.secrets());
      }
    },
  );
}

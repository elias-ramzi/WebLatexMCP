import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { syncState, syncSummary } from '../lib/syncState.js';

const inputSchema = {
  project: z.string().optional(),
};

const commitSchema = z.object({ hash: z.string(), message: z.string() });

const outputSchema = {
  branch: z.string(),
  ahead: z.number().describe('Local commits not on the remote (unpushed).'),
  behind: z
    .number()
    .describe(
      'Remote commits not local. Non-zero means origin moved since the last sync — a push may conflict.',
    ),
  syncState: z
    .enum(['in-sync', 'ahead', 'behind', 'diverged'])
    .describe(
      'Clone state vs the tracked remote branch, from ahead/behind. "behind"/"diverged" mean ' +
        'origin moved; sync (project_sync) before pushing. Counts reflect the last fetch, not a live remote.',
    ),
  clean: z.boolean(),
  staged: z.array(z.string()),
  unstaged: z.array(z.string()),
  untracked: z.array(z.string()),
  aheadCommits: z
    .array(commitSchema)
    .describe('Local commits not yet on the remote (what a push would send).'),
  behindCommits: z
    .array(commitSchema)
    .describe('Remote commits not yet local (what landed upstream since the last sync).'),
  externalChanges: z
    .array(z.string())
    .describe('Files changed on disk directly (not via this server this session).'),
};

export function registerStatus(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'status',
    {
      title: 'Git status',
      description:
        'Show branch, sync state (ahead/behind vs the tracked remote — a non-zero "behind" means ' +
        'origin moved since the last sync and a push may conflict), and staged/unstaged/untracked ' +
        'files. Counts reflect the last fetch; run project_sync to refresh them.',
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
        const commitLine = (c: { hash: string; message: string }): string =>
          `  ${c.hash.slice(0, 8)} ${c.message}`;
        const text = [
          `branch ${status.branch} — ${syncSummary(status.branch, status.ahead, status.behind)}`,
          status.clean ? 'working tree clean' : 'working tree has changes',
          status.staged.length ? `staged: ${status.staged.join(', ')}` : '',
          status.unstaged.length ? `unstaged: ${status.unstaged.join(', ')}` : '',
          status.untracked.length ? `untracked: ${status.untracked.join(', ')}` : '',
          status.behindCommits.length
            ? `landed upstream:\n${status.behindCommits.map(commitLine).join('\n')}`
            : '',
          status.aheadCommits.length
            ? `to push:\n${status.aheadCommits.map(commitLine).join('\n')}`
            : '',
          externalChanges.length
            ? `⚠ changed directly (not via tools): ${externalChanges.join(', ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n');
        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            ...status,
            syncState: syncState(status.ahead, status.behind),
            externalChanges,
          },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

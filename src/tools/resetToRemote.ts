import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';

const inputSchema = {
  project: z.string().optional().describe('Project id. Defaults to the configured default.'),
  confirm: z
    .literal(true)
    .describe(
      'Must be true — this permanently discards local commits and uncommitted changes to rewind ' +
        'onto the remote.',
    ),
};

const commitSchema = z.object({ hash: z.string(), message: z.string() });

const outputSchema = {
  branch: z.string(),
  remoteHead: z.string().describe('The commit now checked out (current origin/<branch> tip).'),
  discardedCommits: z
    .array(commitSchema)
    .describe('Local commits that were ahead of the remote and have now been discarded.'),
  hadUncommittedChanges: z
    .boolean()
    .describe('Whether uncommitted working-tree changes were discarded by the reset.'),
  reset: z.boolean(),
};

export function registerResetToRemote(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'reset_to_remote',
    {
      title: 'Reset the clone to the remote head',
      description:
        'Recover from a push conflict without dropping to raw git: fetch, then hard-reset the local ' +
        'clone to origin/<branch> and remove untracked files, leaving a clean working tree at exactly ' +
        'what is on the remote so you can re-apply your edits onto the current remote. Destructive — ' +
        'it permanently discards local commits ahead of the remote and any uncommitted changes, and ' +
        'reports exactly what it discarded. Never merges or pushes. Requires confirm=true.',
      inputSchema,
      outputSchema,
    },
    async ({ project }) => {
      try {
        const cfg = ctx.projectManager.requireGitProject(project, 'reset to');
        const { id, dir } = await ctx.projectManager.requireProjectDir(cfg.id);
        const auth = await ctx.credentials.resolve(cfg);
        return await ctx.projectManager.runExclusive(id, async () => {
          const res = await ctx.git.resetToRemote(dir, cfg.gitUrl, auth);
          // The reset rewrote the working tree to the remote head; drop stale revision baselines so a
          // later edit isn't misread as an out-of-band change (as project_sync/discard do).
          ctx.files.resetBaselines(dir);
          // Every session's uncommitted work was thrown away with the tree, so no session's
          // record of it is meaningful any more.
          await ctx.shadows.clearAll(id);

          const discarded: string[] = [];
          if (res.discardedCommits.length) {
            discarded.push(
              `${res.discardedCommits.length} local commit(s):`,
              ...res.discardedCommits.map((c) => `  ${c.hash.slice(0, 8)} ${c.message}`),
            );
          }
          if (res.hadUncommittedChanges) discarded.push('uncommitted working-tree changes');
          const text = [
            `Reset ${res.branch} to origin/${res.branch} (${res.remoteHead.slice(0, 8)}).`,
            discarded.length
              ? `Discarded ${discarded.join('\n')}`
              : 'Nothing to discard (already at the remote head).',
            'Working tree is clean at the remote head — re-apply your edits, then push.',
          ].join('\n');
          return {
            content: [{ type: 'text', text }],
            structuredContent: { ...res },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

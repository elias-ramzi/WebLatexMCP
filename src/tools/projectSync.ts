import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import type { SyncResult } from '../services/gitService.js';

const inputSchema = {
  project: z
    .string()
    .optional()
    .describe('Project id. Defaults to the configured default project.'),
  mode: z
    .enum(['auto', 'clone', 'pull'])
    .optional()
    .describe('auto = clone if missing else ff-only pull (default).'),
  gitUrl: z
    .string()
    .optional()
    .describe('Register a new project at this Overleaf git URL (requires project id).'),
};

const outputSchema = {
  project: z.string(),
  path: z.string(),
  action: z.enum(['cloned', 'pulled', 'up-to-date', 'diverged']),
  ahead: z.number(),
  behind: z.number(),
  diverged: z.boolean(),
};

export function registerProjectSync(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'project_sync',
    {
      title: 'Sync an Overleaf project',
      description:
        'Clone the project if it is not present locally, otherwise fast-forward pull (ff-only). ' +
        'If the local and remote histories have diverged, reports the divergence instead of merging.',
      inputSchema,
      outputSchema,
    },
    async ({ project, mode = 'auto', gitUrl }) => {
      try {
        if (gitUrl) {
          if (!project) {
            throw new Error('Registering a project with gitUrl also requires a project id.');
          }
          ctx.projectManager.registerProject({ id: project, gitUrl });
        }
        const cfg = ctx.projectManager.requireGitProject(project, 'sync with');
        const dir = ctx.projectManager.projectPath(cfg.id);
        const cloned = await ctx.projectManager.hasClone(cfg.id);
        const auth = await ctx.credentials.resolve(cfg);

        let result: SyncResult;
        if (!cloned) {
          if (mode === 'pull') {
            throw new Error(`Project "${cfg.id}" is not cloned yet; use mode "clone" or "auto".`);
          }
          await ctx.git.clone(cfg.gitUrl, dir, auth, cfg.branch);
          const ab = await ctx.git.aheadBehind(dir);
          result = { action: 'cloned', ahead: ab.ahead, behind: ab.behind, diverged: false };
        } else {
          if (mode === 'clone') {
            throw new Error(`Project "${cfg.id}" is already cloned; use mode "pull" or "auto".`);
          }
          result = await ctx.git.syncPull(cfg.gitUrl, dir, auth);
        }

        // A clone or ff-pull rewrites files on disk; drop stale baselines so post-sync content
        // isn't misread as an out-of-band user edit.
        if (result.action === 'cloned' || result.action === 'pulled') {
          ctx.files.resetBaselines(dir);
        }
        if (result.action === 'pulled') {
          // A pull moves HEAD but keeps uncommitted work, so this session's changes are still
          // real — carry them onto the new HEAD rather than forgetting whose they are. Peers do
          // the same lazily on their next call.
          await ctx.shadows.refresh(cfg.id, dir);
        }

        const payload = { project: cfg.id, path: dir, ...result };
        return {
          content: [
            {
              type: 'text',
              text: `${cfg.id}: ${result.action} (ahead ${result.ahead}, behind ${result.behind})${
                result.diverged ? ' — diverged, resolve manually before pushing' : ''
              }`,
            },
          ],
          structuredContent: { ...payload },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

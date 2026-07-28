import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';

const inputSchema = {
  project: z.string().min(1).describe('Project id used in tool calls and as the clone dir name.'),
  gitUrl: z
    .string()
    .min(1)
    .describe('Git remote URL (Overleaf, GitHub, or any git host) — stored tokenless.'),
  rootFile: z
    .string()
    .min(1)
    .optional()
    .describe('Explicit LaTeX root file (e.g. main.tex). Auto-detected when omitted.'),
  branch: z.string().min(1).optional().describe('Branch to clone/track. Defaults to the remote.'),
  username: z
    .string()
    .min(1)
    .optional()
    .describe('HTTPS username override (otherwise a per-host default is used).'),
  tokenEnv: z
    .string()
    .min(1)
    .optional()
    .describe('Name of the env var holding this project’s token (overrides host defaults).'),
  clone: z
    .boolean()
    .optional()
    .describe('Clone the project right away if it is not present locally (default true).'),
};

const outputSchema = {
  project: z.string(),
  path: z.string(),
  persisted: z.boolean(),
  cloned: z.boolean(),
};

export function registerRegisterProject(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'register_project',
    {
      title: 'Register a project (persisted)',
      description:
        'Register a git-hosted LaTeX project (Overleaf, GitHub, or any git remote) by id + git URL ' +
        'and persist it to the workspace, so it survives a restart and is available to other ' +
        'sessions — no need to set WEB_LATEX_MCP_PROJECTS. Useful for Claude Desktop, where ' +
        'editing the env config is awkward: just paste your Overleaf git URL in the chat. By default ' +
        'it also clones the project immediately. The token is never stored; it is resolved per host ' +
        'at git time (see the auth docs).',
      inputSchema,
      outputSchema,
    },
    async ({ project, gitUrl, rootFile, branch, username, tokenEnv, clone = true }) => {
      try {
        return await ctx.projectManager.runExclusive(project, async () => {
          await ctx.projectManager.registerAndPersist(project, gitUrl, {
            rootFile,
            branch,
            username,
            tokenEnv,
          });

          const cfg = ctx.projectManager.getProjectConfig(project);
          const dir = ctx.projectManager.projectPath(cfg.id);
          let cloned = await ctx.projectManager.hasClone(cfg.id);

          if (clone && !cloned) {
            const auth = await ctx.credentials.resolve(cfg);
            await ctx.git.clone(cfg.gitUrl, dir, auth, cfg.branch);
            ctx.files.resetBaselines(dir);
            cloned = true;
          }

          const payload = { project: cfg.id, path: dir, persisted: true, cloned };
          const text =
            `Registered "${cfg.id}" -> ${cfg.gitUrl} (persisted to the workspace registry). ` +
            (cloned
              ? `Cloned at ${dir}.`
              : 'Not cloned yet — run project_sync to clone when you are ready.');
          return {
            content: [{ type: 'text', text }],
            structuredContent: { ...payload },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

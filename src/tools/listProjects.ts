import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';

const outputSchema = {
  projects: z.array(
    z.object({
      project: z.string(),
      path: z.string(),
      mode: z
        .enum(['git', 'local'])
        .describe(
          '"git": a clone of a remote, with the full sync/commit/push workflow. "local": a ' +
            'directory edited in place, which the git tools do not apply to.',
        ),
      gitUrl: z.string().optional().describe('The remote — git projects only.'),
      cloned: z
        .boolean()
        .describe('Git: whether it is cloned yet. Local: whether the directory is there.'),
    }),
  ),
};

export function registerListProjects(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'List every project this server knows about — from the environment and from the workspace ' +
        'registry — with its local path, its mode ("git", a clone of a remote; "local", a ' +
        'directory edited in place) and whether it is there yet. Start here: if nothing is ' +
        'registered, the result says how to add one.',
      inputSchema: {},
      outputSchema,
    },
    async () => {
      const projects = await ctx.projectManager.listProjects();
      // An empty workspace is the one moment the caller definitely does not know the workflow, so
      // spend the empty state teaching it rather than reporting a bare "none".
      const text =
        projects.length === 0
          ? 'No projects registered yet. Add one with register_project({ project: "<id>", ' +
            'gitUrl: "<git remote>" }) — an Overleaf, GitHub, or any git URL. It is persisted to ' +
            'the workspace, so it survives a restart and is visible to your other sessions, and it ' +
            'is cloned right away unless you pass clone: false.'
          : projects
              .map((p) => {
                const state =
                  p.mode === 'local'
                    ? p.cloned
                      ? 'local, in place'
                      : 'local, MISSING'
                    : p.cloned
                      ? 'cloned'
                      : 'not cloned';
                return `- ${p.project} [${state}] -> ${p.path}`;
              })
              .join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: { projects },
      };
    },
  );
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';

const outputSchema = {
  projects: z.array(
    z.object({
      project: z.string(),
      path: z.string(),
      gitUrl: z.string(),
      cloned: z.boolean(),
    }),
  ),
};

export function registerListProjects(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'list_projects',
    {
      title: 'List Overleaf projects',
      description:
        'List all configured Overleaf projects and whether each has been cloned locally yet.',
      inputSchema: {},
      outputSchema,
    },
    async () => {
      const projects = await ctx.projectManager.listProjects();
      const text =
        projects.length === 0
          ? 'No projects configured. Set OVERLEAF_MCP_PROJECTS to register projects.'
          : projects
              .map((p) => `- ${p.project} [${p.cloned ? 'cloned' : 'not cloned'}] -> ${p.path}`)
              .join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: { projects },
      };
    },
  );
}

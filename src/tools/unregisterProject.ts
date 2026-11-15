import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { toPosix } from '../lib/paths.js';
import { isLocalProject } from '../lib/projectMode.js';
import { assertValidProjectId, quoteId } from '../lib/projectId.js';

const inputSchema = {
  project: z.string().min(1).describe('Id of the registered project to forget.'),
};

const outputSchema = {
  project: z.string(),
  mode: z
    .enum(['git', 'local'])
    .describe('"git": a clone in the workspace. "local": a directory used in place.'),
  path: z
    .string()
    .describe(
      'Where its files are — left exactly as they were. Registering the same id again uses them.',
    ),
  wasDefault: z
    .boolean()
    .describe('Whether it was the default project; no project is the default afterwards.'),
};

export function registerUnregisterProject(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'unregister_project',
    {
      title: 'Forget a project',
      description:
        'Remove a project from the registry, so it is no longer listed or usable by name. Deletes ' +
        'NOTHING: the clone (or local folder), its compiled PDF and its session state stay on ' +
        'disk, and register_project with the same id picks them up again. Other sessions drop it ' +
        'at their next list_projects. A project configured through WEB_LATEX_MCP_PROJECTS cannot ' +
        'be removed here — edit that variable.',
      inputSchema,
      outputSchema,
    },
    async ({ project }) => {
      try {
        assertValidProjectId(project);
        return await ctx.projectManager.runExclusive(project, async () => {
          const { config, dir, wasDefault } = await ctx.projectManager.unregister(project);
          const local = isLocalProject(config);
          const where = toPosix(dir);
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `Forgot ${quoteId(project)}${wasDefault ? ' (it was the default project)' : ''}. ` +
                  (local
                    ? `Its folder ${where} is untouched.`
                    : `Its files stay at ${where}; register it again with the same id to use them.`),
              },
            ],
            structuredContent: {
              project,
              mode: local ? ('local' as const) : ('git' as const),
              path: where,
              wasDefault,
            },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

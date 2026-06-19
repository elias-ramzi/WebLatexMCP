import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';

const inputSchema = {
  project: z.string().optional(),
  path: z.string().describe('Path relative to the project root.'),
  startLine: z.number().int().positive().optional().describe('1-based first line (inclusive).'),
  endLine: z.number().int().positive().optional().describe('1-based last line (inclusive).'),
};

const outputSchema = {
  path: z.string(),
  content: z.string(),
  totalLines: z.number(),
  truncated: z.boolean(),
  note: z.string().optional(),
};

export function registerReadFile(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'read_file',
    {
      title: 'Read a project file',
      description:
        'Read a text file from the project (optionally a line range). Binary/large files ' +
        'are not returned inline — their path is reported instead.',
      inputSchema,
      outputSchema,
    },
    async ({ project, path: relPath, startLine, endLine }) => {
      try {
        const { dir } = await ctx.projectManager.requireClonedDir(project);
        const result = await ctx.files.read(dir, { path: relPath, startLine, endLine });
        return {
          content: [{ type: 'text', text: result.note ?? result.content }],
          structuredContent: { ...result },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

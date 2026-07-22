import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { getServerVersion } from '../lib/version.js';
import { toPosix } from '../lib/paths.js';

const outputSchema = {
  name: z.string(),
  version: z.string(),
  workspaceRoot: z.string(),
  workspaceLocal: z.boolean(),
  compiler: z.string(),
};

export function registerServerInfo(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'server_info',
    {
      title: 'Server info',
      description:
        'Report the web-latex-mcp server version and runtime configuration (workspace root, ' +
        'whether the workspace is local to the launch dir, and the configured compiler). ' +
        'Use this to confirm which version of the MCP server is running.',
      inputSchema: {},
      outputSchema,
    },
    async () => {
      const info = {
        name: 'web-latex-mcp',
        version: getServerVersion(),
        workspaceRoot: toPosix(ctx.config.workspaceRoot),
        workspaceLocal: ctx.config.workspaceIsLocal ?? false,
        compiler: ctx.config.compiler ?? 'latexmk',
      };
      const text =
        `web-latex-mcp v${info.version}\n` +
        `workspace: ${info.workspaceRoot} (${info.workspaceLocal ? 'local' : 'shared'})\n` +
        `compiler: ${info.compiler}`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: { ...info },
      };
    },
  );
}

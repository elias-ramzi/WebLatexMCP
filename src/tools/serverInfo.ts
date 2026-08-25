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
  workspaceExcludePattern: z
    .string()
    .optional()
    .describe(
      'When the workspace is local to the launch dir and that dir is a git repo, the pattern the ' +
        "server added to the host repo's .git/info/exclude so the clones are not committed. Its " +
        'presence means the directory is already handled — do not add a .gitignore entry for it. ' +
        'Absent when nothing was excluded.',
    ),
  compiler: z
    .string()
    .describe(
      'The *configured* compile backend, which is not always the one that runs: when it is only ' +
        'the default (WEB_LATEX_MCP_COMPILER names no backend) and is not installed, compile ' +
        'substitutes a ' +
        'backend that is. This field does not probe PATH — run doctor for what is actually ' +
        "installed, or read a compile result's own `compiler` for what ran.",
    ),
};

export function registerServerInfo(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'server_info',
    {
      title: 'Server info',
      description:
        'Report the web-latex-mcp server version and runtime configuration (workspace root, ' +
        'whether the workspace is local to the launch dir, whether the clone dir was git-excluded ' +
        'from the host repo, and the configured compiler — which is not necessarily the backend a ' +
        'compile runs, since an uninstalled default is substituted; doctor reports what is really ' +
        'there). Use this to confirm which version of ' +
        'the MCP server is running.',
      inputSchema: {},
      outputSchema,
    },
    async () => {
      const info = {
        name: 'web-latex-mcp',
        version: getServerVersion(),
        workspaceRoot: toPosix(ctx.config.workspaceRoot),
        workspaceLocal: ctx.config.workspaceIsLocal ?? false,
        workspaceExcludePattern: ctx.config.workspaceExcludePattern,
        compiler: ctx.config.compiler ?? 'latexmk',
      };
      // Say it out loud: the exclude is real but lives in .git/info/exclude, which is invisible to
      // anyone who did not run this server — the user may still want a tracked .gitignore entry.
      const excludeLine = info.workspaceExcludePattern
        ? `git: clones are excluded from the host repo as "${info.workspaceExcludePattern}" via ` +
          '.git/info/exclude (local to this checkout only — collaborators will not see it)\n'
        : '';
      const text =
        `web-latex-mcp v${info.version}\n` +
        `workspace: ${info.workspaceRoot} (${info.workspaceLocal ? 'local' : 'shared'})\n` +
        excludeLine +
        `compiler: ${info.compiler}`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: { ...info },
      };
    },
  );
}

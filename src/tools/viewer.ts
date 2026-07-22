import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { openBrowser } from '../lib/openBrowser.js';
import { shouldOpenExternally, viewerHint } from '../lib/viewerHint.js';

const inputSchema = {
  project: z.string().optional(),
  target: z
    .enum(['browser', 'vscode'])
    .optional()
    .describe(
      'Where you intend to open the viewer: "browser" (default — auto-opens your OS browser) or ' +
        '"vscode" (returns the URL to open as a Simple Browser editor tab; never auto-opens a ' +
        'browser). Defaults to WEB_LATEX_MCP_VIEWER_TARGET, else "browser".',
    ),
  open: z
    .boolean()
    .optional()
    .describe(
      'For target "browser": also open the URL in the default browser (default true). Ignored for ' +
        '"vscode".',
    ),
};

const outputSchema = {
  url: z.string().describe('Localhost viewer URL for the project.'),
  opened: z.boolean().describe('Whether a browser was launched.'),
  target: z.enum(['browser', 'vscode']),
};

export function registerViewer(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'viewer',
    {
      title: 'Open a live PDF viewer (browser or VSCode tab)',
      description:
        'Start (if needed) a local viewer for the compiled PDF and return its URL. The page renders ' +
        'the PDF with pdf.js (zoom/scroll/search, select-to-comment) and hot-reloads on every ' +
        'compile, preserving your page and scroll position. For clients without a PDF surface ' +
        '(e.g. Claude Desktop) it auto-opens your browser; in VSCode pass target:"vscode" (or set ' +
        'WEB_LATEX_MCP_VIEWER_TARGET=vscode) to get the URL to open as a Simple Browser tab. The ' +
        'server binds to loopback only and starts on demand. Run compile to populate it.',
      inputSchema,
      outputSchema,
    },
    async ({ project, open, target }) => {
      try {
        // Resolve to a concrete id (validates the project) without requiring a clone — the viewer
        // can be opened first and will fill in once compile runs.
        const { id } = ctx.projectManager.getProjectConfig(project);

        const base = await ctx.viewer.start(ctx.config.viewerPort);
        if (!base) {
          return {
            content: [
              {
                type: 'text',
                text: 'Could not start the PDF viewer (no free loopback port). Set WEB_LATEX_MCP_VIEWER_PORT to a free port and retry.',
              },
            ],
          };
        }

        const url = ctx.viewer.urlFor(id)!;
        const resolvedTarget = target ?? ctx.config.viewerTarget ?? 'browser';
        const opened = shouldOpenExternally(resolvedTarget, open) ? await openBrowser(url) : false;

        return {
          content: [{ type: 'text', text: viewerHint(url, resolvedTarget, opened) }],
          structuredContent: { url, opened, target: resolvedTarget },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

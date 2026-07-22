import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { openBrowser } from '../lib/openBrowser.js';

const inputSchema = {
  project: z.string().optional(),
  open: z
    .boolean()
    .optional()
    .describe(
      'Also open the URL in the default browser (default true). Set false to just return it.',
    ),
};

const outputSchema = {
  url: z.string().describe('Localhost viewer URL for the project.'),
  opened: z.boolean().describe('Whether a browser was launched.'),
};

export function registerViewer(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'viewer',
    {
      title: 'Open a live PDF viewer in the browser',
      description:
        'Start (if needed) a local browser viewer for the compiled PDF and return its URL. The ' +
        'page renders the PDF with pdf.js (zoom/scroll/search) and hot-reloads on every compile, ' +
        'preserving your current page and scroll position — open it once and keep it beside the ' +
        'chat. Intended for clients without a PDF surface (e.g. Claude Desktop). The server binds ' +
        'to loopback only and starts on demand (not at boot). Run compile to populate it; until ' +
        'then the page waits.',
      inputSchema,
      outputSchema,
    },
    async ({ project, open }) => {
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
        const shouldOpen = open ?? true;
        const opened = shouldOpen ? await openBrowser(url) : false;

        const text =
          `PDF viewer: ${url}\n` +
          (opened
            ? 'Opened in your browser — it refreshes automatically each time you compile.'
            : 'Open this URL in a browser; it refreshes automatically each time you compile.');

        return {
          content: [{ type: 'text', text }],
          structuredContent: { url, opened },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

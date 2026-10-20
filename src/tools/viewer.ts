import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { openBrowser } from '../lib/openBrowser.js';
import { describeViewerRoot, shouldOpenExternally, viewerHint } from '../lib/viewerHint.js';
import { quoteId } from '../lib/projectId.js';

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
  document: z
    .string()
    .optional()
    .describe(
      'Open this markdown document (.md/.markdown, project-relative — e.g. a review report such ' +
        'as paper-review.local/<run>/final-review.md) instead of the PDF. The user selects text in ' +
        'it to comment; list_comments with the same `document` reads the comments back with the ' +
        'source line. Read through the project sandbox; works for local projects too.',
    ),
};

const outputSchema = {
  url: z
    .string()
    .describe(
      'Localhost viewer URL for the project — its PDF, or the `document` when one was given.',
    ),
  document: z
    .string()
    .optional()
    .describe(
      'The markdown document the URL shows, normalised (POSIX, no `./`) — the spelling to pass ' +
        'to list_comments and resolve_comments. Absent when the URL shows the PDF.',
    ),
  opened: z.boolean().describe('Whether a browser was launched.'),
  target: z.enum(['browser', 'vscode']),
  rootFile: z
    .string()
    .optional()
    .describe(
      "The root .tex the viewer follows. It shows that root's build, or — in workspace-local " +
        'mode, while that root has no build — the surfaced <workspace>/<id>.pdf, which holds ' +
        'whichever root compiled last (a comment made on it carries no source location). Absent ' +
        'when it cannot be told yet (the project is not cloned, or holds no .tex).',
    ),
  rootSource: z
    .enum(['registered', 'detected'])
    .optional()
    .describe(
      '"registered": the rootFile the project was registered with. "detected": auto-detected, ' +
        'because none was registered — register the project with a rootFile to show another.',
    ),
};

export function registerViewer(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'viewer',
    {
      title: 'Open a live PDF or markdown viewer (browser or VSCode tab)',
      description:
        'Start (if needed) a local viewer for the compiled PDF and return its URL. It follows the ' +
        'root file the project was registered with (rootFile), else the auto-detected one (a ' +
        'top-level main.tex, else the shallowest .tex with a \\documentclass), named in the ' +
        "result, and renders that root's build (in workspace-local mode, while it has none, the " +
        'surfaced copy of whichever root compiled last) with pdf.js (zoom/scroll/search, ' +
        'select-to-comment), hot-reloading whenever it is recompiled and preserving your page ' +
        'and scroll position. For clients ' +
        'without a PDF surface (e.g. Claude Desktop) it auto-opens your browser; in VSCode pass ' +
        'target:"vscode" (or set WEB_LATEX_MCP_VIEWER_TARGET=vscode) to get the URL to open as a ' +
        'Simple Browser tab. Pass `document` to open a markdown document of the project (a review ' +
        'report, a summary) instead: it is rendered, reloads when the file changes, and takes ' +
        'comments the same way. The server binds to loopback only, refuses other sites, and ' +
        'starts on demand. Run compile to populate the PDF view.',
      inputSchema,
      outputSchema,
    },
    async ({ project, open, target, document }) => {
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

        // A document is checked before anything is opened, by the same rules its page applies, so
        // a bad path is refused here rather than on a page the user opens later.
        const doc =
          document === undefined ? undefined : await ctx.viewer.checkDocument(id, document);
        const url =
          doc === undefined ? ctx.viewer.urlFor(id)! : ctx.viewer.urlForDocument(id, doc)!;
        const resolvedTarget = target ?? ctx.config.viewerTarget ?? 'browser';
        const opened = shouldOpenExternally(resolvedTarget, open) ? await openBrowser(url) : false;
        if (doc !== undefined) {
          return {
            content: [
              {
                type: 'text',
                text:
                  viewerHint(url, resolvedTarget, opened) +
                  `\nIt shows the document ${quoteId(doc)}: select text to comment, then ` +
                  `list_comments with document ${quoteId(doc)} reads the comments back.`,
              },
            ],
            structuredContent: { url, opened, target: resolvedTarget, document: doc },
          };
        }
        const root = await ctx.viewer.rootFor(id);
        // The viewer is never handed a root by a call, so 'argument' cannot come back here.
        const rootSource = root?.source === 'registered' ? 'registered' : 'detected';
        const text =
          viewerHint(url, resolvedTarget, opened) +
          (root ? `\nIt follows ${describeViewerRoot(root.rootFile, root.source)}.` : '');

        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            url,
            opened,
            target: resolvedTarget,
            ...(root ? { rootFile: root.rootFile, rootSource } : {}),
          },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

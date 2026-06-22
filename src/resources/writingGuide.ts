import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** URI under which the LaTeX writing guide is exposed as an MCP resource. */
export const WRITING_GUIDE_URI = 'guide://latex/writing-guide';

/**
 * Expose the LaTeX writing guide as a fetchable MCP resource, so a user can
 * re-open it on demand and clients that ignore the server `instructions` hint
 * can still reach it. The text is a startup snapshot — the same content surfaced
 * via `instructions` — so this is only registered when a guide is present.
 */
export function registerWritingGuide(server: McpServer, guide: string): void {
  server.registerResource(
    'writing-guide',
    WRITING_GUIDE_URI,
    {
      title: 'LaTeX writing guide',
      description:
        'Style and conventions for writing and editing .tex files through this server ' +
        '(tense, writing style, figures, equations, bibliography, English usage).',
      mimeType: 'text/markdown',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: guide,
        },
      ],
    }),
  );
}

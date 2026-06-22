import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** URI under which the concurrency / safe-push guide is exposed as an MCP resource. */
export const CONCURRENCY_GUIDE_URI = 'guide://latex/concurrency';

/**
 * Expose the concurrency / safe-push guide as a fetchable MCP resource, so a user
 * can re-open it on demand (e.g. after a `conflict` result) and clients that ignore
 * the server `instructions` hint can still reach it. Mirrors the writing-guide
 * resource; only registered when a guide is present.
 */
export function registerConcurrencyGuide(server: McpServer, guide: string): void {
  server.registerResource(
    'concurrency-guide',
    CONCURRENCY_GUIDE_URI,
    {
      title: 'Concurrency & safe-push guide',
      description:
        'How this server pushes without clobbering concurrent edits: pull-rebase before pushing, ' +
        'never force-push, surface conflicts for a human, and the optional branch-review flow.',
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

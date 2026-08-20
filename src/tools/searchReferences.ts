import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { DblpHit } from '../services/dblp.js';
import { errorResult } from '../lib/errors.js';

const inputSchema = {
  query: z
    .string()
    .min(1)
    .describe('Free-text query: title words, authors, venue — e.g. "deep residual learning he".'),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe('Max hits to return (default 10).'),
};

const hitSchema = z.object({
  key: z.string(),
  title: z.string(),
  authors: z.array(z.string()),
  year: z.number().optional(),
  venue: z.string().optional(),
  type: z.string().optional(),
  doi: z.string().optional(),
  url: z.string().optional(),
});

const outputSchema = {
  query: z.string(),
  count: z.number(),
  results: z.array(hitSchema),
};

function formatHit(hit: DblpHit): string {
  const authors = hit.authors.length ? hit.authors.join(', ') : 'unknown authors';
  const where = [hit.venue, hit.year].filter(Boolean).join(' ');
  return `• ${hit.title}\n  ${authors}${where ? ` — ${where}` : ''}\n  key: ${hit.key}`;
}

export function registerSearchReferences(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'search_references',
    {
      title: 'Search DBLP for references',
      description:
        'Look a publication UP on DBLP — the external computer-science bibliography at ' +
        'dblp.org, over the network. It does NOT search the project: it never reads the ' +
        'project’s .bib and never changes anything. To search the references the project ' +
        'already has, use list_references instead. Reach for this to find a paper’s canonical ' +
        'metadata — to check an entry the project cites, or to add one it does not. Each ' +
        'result carries a DBLP `key`; pass that key to add_citation to append the entry, ' +
        'fetched from DBLP rather than written by hand. DBLP rate-limits: call it one paper at ' +
        'a time, never in parallel bursts.',
      inputSchema,
      outputSchema,
    },
    async ({ query, maxResults }) => {
      try {
        const results = await ctx.dblp.search(query, { maxResults });
        const text = results.length
          ? `${results.length} result(s) for "${query}":\n\n${results.map(formatHit).join('\n\n')}`
          : `No DBLP results for "${query}".`;
        return {
          content: [{ type: 'text', text }],
          structuredContent: { query, count: results.length, results },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

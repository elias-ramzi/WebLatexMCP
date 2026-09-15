import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { ReferenceHit } from '../services/referenceBackend.js';
import { REFERENCE_SOURCES } from '../lib/referenceKey.js';
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
  source: z
    .enum(REFERENCE_SOURCES)
    .optional()
    .describe(
      'Pin the bibliography to search: "dblp" (computer science, richest cite keys), ' +
        '"crossref" (broadest coverage, any discipline) or "openalex" (broad, open). ' +
        'Naming one is an assertion: only that backend is tried, and if it cannot be reached ' +
        'the call fails rather than quietly searching a different bibliography. Omit it to let ' +
        'the server try them in order and substitute one that is unreachable — the result then ' +
        'reports which actually answered.',
    ),
};

const hitSchema = z.object({
  key: z.string(),
  source: z.string(),
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
  /** The backend that actually answered — not necessarily the configured or default one. */
  source: z.string(),
  /** Set only when the backend that answered substituted for one that could not be reached. */
  fallbackFrom: z.string().optional(),
  /** Why the substitution happened. Present iff `fallbackFrom` is. */
  hint: z.string().optional(),
  results: z.array(hitSchema),
};

function formatHit(hit: ReferenceHit): string {
  const authors = hit.authors.length ? hit.authors.join(', ') : 'unknown authors';
  const where = [hit.venue, hit.year].filter(Boolean).join(' ');
  return `• ${hit.title}\n  ${authors}${where ? ` — ${where}` : ''}\n  key: ${hit.key}`;
}

export function registerSearchReferences(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'search_references',
    {
      title: 'Search a bibliography for references',
      description:
        'Look a publication UP in an external bibliography — DBLP, Crossref or OpenAlex — over ' +
        'the network. It does NOT search the project: it never reads the project’s .bib and ' +
        'never changes anything. To search the references the project already has, use ' +
        'list_references instead. Reach for this to find a paper’s canonical metadata — to check ' +
        'an entry the project cites, or to add one it does not. Each result carries a namespaced ' +
        '`key` (e.g. "dblp:conf/cvpr/HeZRS16", "crossref:10.1109/CVPR.2016.90"); pass that key to ' +
        'add_citation to append the entry, fetched from the source rather than written by hand. ' +
        'By default the server tries DBLP, then Crossref, then OpenAlex, and substitutes one that ' +
        'cannot be reached — `source` in the result says which answered. These services ' +
        'rate-limit: call this one paper at a time, never in parallel bursts.',
      inputSchema,
      outputSchema,
    },
    async ({ query, maxResults, source }) => {
      try {
        const found = await ctx.references.search(query, { maxResults, source });
        const results = found.hits;
        const header = results.length
          ? `${results.length} result(s) for "${query}" from ${found.source}:`
          : `No results for "${query}" on ${found.source}.`;
        const body = results.length ? `\n\n${results.map(formatHit).join('\n\n')}` : '';
        // The substitution is reported in the text channel too, not only in structuredContent:
        // a caller that reads only the text must still learn which bibliography answered.
        const note = found.note ? `\n\nNote: ${found.note}` : '';
        return {
          content: [{ type: 'text', text: `${header}${body}${note}` }],
          structuredContent: {
            query,
            count: results.length,
            source: found.source,
            ...(found.fallbackFrom ? { fallbackFrom: found.fallbackFrom } : {}),
            ...(found.note ? { hint: found.note } : {}),
            results,
          },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

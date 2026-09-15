import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { ReferenceHit } from '../services/referenceBackend.js';
import { REFERENCE_SOURCES } from '../lib/referenceKey.js';
import { errorResult } from '../lib/errors.js';

/**
 * What `source` means, minus what OMITTING it does — which depends on how this server is
 * configured, exactly as the tool description's middle clause does.
 */
const SOURCE_FIELD_HEAD =
  'Pin the bibliography to search: "dblp" (computer science, richest cite keys), ' +
  '"crossref" (broadest coverage, any discipline) or "openalex" (broad, open). ' +
  'Naming one is an assertion: only that backend is tried, and if it cannot be reached ' +
  'the call fails rather than quietly searching a different bibliography.';

/** What omitting `source` does on a server with nothing pinned — the ordinary case. */
const SOURCE_OMIT_DEFAULT =
  'Omit it to let the server try them in order and substitute one that is unreachable — the ' +
  'result then reports which actually answered.';

/**
 * The `source` field's own description carried the *same* promise as the tool description's
 * middle clause ("omit it and the server substitutes one that is unreachable"), two fields away
 * — so fixing only the tool description left the lie sitting in the schema, where a model reads
 * it while filling the call in. Both now come from `config`, so they cannot disagree.
 */
function describeSourceField(config: AppContext['config'] | undefined): string {
  if (config?.referenceSourceInvalid) {
    return `${SOURCE_FIELD_HEAD} On THIS server you must pass it: WEB_LATEX_MCP_REFERENCE_SOURCE names no backend, so omitting it is REFUSED rather than falling back.`;
  }
  if (config?.referenceSource) {
    // Mirrors `describeSourceSelection`'s two states for the same reason — see there.
    return config.referenceSourceExplicit
      ? `${SOURCE_FIELD_HEAD} Omitting it searches "${config.referenceSource}" alone on THIS server (WEB_LATEX_MCP_REFERENCE_SOURCE pins it), and an unreachable backend is then an error, not a substitution.`
      : `${SOURCE_FIELD_HEAD} Omitting it tries "${config.referenceSource}" first on THIS server, then the others only if it cannot be reached.`;
  }
  return `${SOURCE_FIELD_HEAD} ${SOURCE_OMIT_DEFAULT}`;
}

/**
 * Built per registration rather than once at module load, because the `source` field's text
 * depends on this server's configuration. `config` is tolerated as absent for the same reason
 * `describeSourceSelection` tolerates it — see there.
 */
function buildInputSchema(config: AppContext['config'] | undefined) {
  return {
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
    source: z.enum(REFERENCE_SOURCES).optional().describe(describeSourceField(config)),
  };
}

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

/**
 * The parts of the registered description that are true whatever is configured. Kept apart from
 * the one clause that is not, so the three variants below share one body rather than being three
 * near-identical strings that drift apart the next time the tool's behaviour changes.
 */
const DESCRIPTION_HEAD =
  'Look a publication UP in an external bibliography — DBLP, Crossref or OpenAlex — over ' +
  'the network. It does NOT search the project: it never reads the project’s .bib and ' +
  'never changes anything. To search the references the project already has, use ' +
  'list_references instead. Reach for this to find a paper’s canonical metadata — to check ' +
  'an entry the project cites, or to add one it does not. Each result carries a namespaced ' +
  '`key` (e.g. "dblp:conf/cvpr/HeZRS16", "crossref:10.1109/CVPR.2016.90"); pass that key to ' +
  'add_citation to append the entry, fetched from the source rather than written by hand.';

const DESCRIPTION_TAIL =
  'These services rate-limit: call this one paper at a time, never in parallel bursts.';

/** What an unconfigured server does: the resolver owns the fallback order across the three. */
const UNPINNED_CLAUSE =
  'By default the server tries DBLP, then Crossref, then OpenAlex, and substitutes one that ' +
  'cannot be reached — `source` in the result says which answered.';

/**
 * The one clause that depends on how this server is configured. The model reads a description
 * first and always, so promising "tries DBLP, then Crossref, then OpenAlex" while an unpinned
 * call is actually REFUSED sends it to recover from an error it was told could not happen —
 * `server_info` already refuses to describe the fallback order in that state for the same reason.
 *
 * This reads the answer `parseReferenceSource` already derived; it derives nothing of its own.
 * `referenceSourceExplicit` is never true alongside `referenceSourceInvalid` (a rejected value is
 * nobody's choice), so the order of these branches cannot matter — but invalid is tested first
 * anyway, since that is the branch whose promise would be a lie.
 *
 * `config` is accepted as possibly-absent on purpose. This runs at REGISTRATION time, not in a
 * handler, and registration is the one thing in this server that must survive an unpopulated
 * dependency bag — `server.test.ts` registers every tool against `{} as AppContext` precisely
 * because nothing used to read the context that early. An absent config describes the default,
 * which is what a server with nothing configured actually does, so the tolerance costs no
 * accuracy: the two non-default branches are reached only by a config that says so.
 */
function describeSourceSelection(config: AppContext['config'] | undefined): string {
  if (!config) return UNPINNED_CLAUSE;
  const ids = REFERENCE_SOURCES.map((id) => `"${id}"`).join(', ');
  if (config.referenceSourceInvalid) {
    return (
      'NOTE, on THIS server: WEB_LATEX_MCP_REFERENCE_SOURCE is set to a value that names no ' +
      'backend, so a call that omits source: is REFUSED — there is no fallback order in this ' +
      `state, and no bibliography is searched. Pass source: (${ids}) to search; that is its own ` +
      'assertion and still works. server_info reports the offending value, and every other tool ' +
      'is unaffected.'
    );
  }
  if (config.referenceSource) {
    // Two states, not one. `referenceSourceExplicit` is the whole licence for a substitution, and
    // `ReferenceResolver.unpinnedOrder` tries a configured-but-unchosen source FIRST and then
    // substitutes it — so describing only the explicit case would promise "tries DBLP, then
    // Crossref, then OpenAlex" while the server actually leads with something else. That is the
    // same class of lie this function exists to remove, one layer up. Unreachable today, since
    // `parseReferenceSource` marks every source it returns as explicit; written out anyway,
    // because the resolver deliberately handles the state and these two must not disagree about it.
    return config.referenceSourceExplicit
      ? 'On THIS server WEB_LATEX_MCP_REFERENCE_SOURCE pins the bibliography to ' +
          `"${config.referenceSource}": a call that omits source: searches only that backend, and ` +
          'one that cannot be reached is an error rather than a substitution.'
      : `On THIS server "${config.referenceSource}" is tried first when source: is omitted, and ` +
          'the others are tried after it only if it cannot be reached — the result reports which ' +
          'actually answered.';
  }
  return UNPINNED_CLAUSE;
}

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
      description: [DESCRIPTION_HEAD, describeSourceSelection(ctx.config), DESCRIPTION_TAIL].join(
        ' ',
      ),
      inputSchema: buildInputSchema(ctx.config),
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

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { REFERENCE_SOURCES } from '../lib/referenceKey.js';
import { errorResult } from '../lib/errors.js';
import { redact } from '../lib/redact.js';
import {
  BATCH_MAX_QUERIES,
  BATCH_START_DEADLINE_MS,
  runReferenceBatch,
  type BatchDeps,
} from '../lib/referenceBatch.js';
import { planReferenceBatch, renderReferenceBatchText } from '../lib/referenceBatchBudget.js';
import { ReferenceSourceInvalidError } from '../services/referenceResolver.js';
import { describeSourceField, describeSourceSelection, hitSchema } from './searchReferences.js';

/** Longest accepted query: a title plus a surname and a year, with room to spare. */
export const BATCH_MAX_QUERY_CHARS = 300;

/** Hits per query when `maxResults` is omitted: a verification mostly needs the top match. */
export const BATCH_DEFAULT_RESULTS = 3;

function buildInputSchema(config: AppContext['config'] | undefined) {
  return {
    queries: z
      .array(z.string().min(1).max(BATCH_MAX_QUERY_CHARS))
      .min(1)
      .max(BATCH_MAX_QUERIES)
      .describe(
        `Up to ${BATCH_MAX_QUERIES} free-text queries, one per paper — title words plus the first ` +
          "author's surname and the year work best. Answered in this order.",
      ),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe(`Max hits per query (default ${BATCH_DEFAULT_RESULTS}).`),
    source: z.enum(REFERENCE_SOURCES).optional().describe(describeSourceField(config)),
  };
}

const itemSchema = z.object({
  query: z.string(),
  /** `ok`: answered (possibly with zero hits). `error`: this query failed. `notRun`: never started. */
  status: z.enum(['ok', 'error', 'notRun']),
  /** Hits the backend returned — `ok` only. More than `results` holds when the budget cut some. */
  count: z.number().optional(),
  source: z.string().optional(),
  fallbackFrom: z.string().optional(),
  hint: z.string().optional(),
  error: z.string().optional(),
  results: z.array(hitSchema),
  resultsOmitted: z.number(),
});

const outputSchema = {
  /** Queries asked; `searched + failed + notRun`. */
  queries: z.number(),
  searched: z.number(),
  failed: z.number(),
  notRun: z.number(),
  /** Hits returned by the backends but left out of this result by the size budget. */
  resultsOmitted: z.number(),
  /** Set when the batch ended early: repeated failures, or the per-call time limit. */
  stopped: z.enum(['failures', 'deadline']).optional(),
  note: z.string().optional(),
  items: z.array(itemSchema),
};

const DESCRIPTION_HEAD =
  'Look up MANY publications in an external bibliography — DBLP, Crossref or OpenAlex — in one ' +
  'call: the server runs the queries one at a time, spaced out and backing off when a service ' +
  'refuses, so a whole bibliography can be checked without tripping the rate limits. Each query ' +
  'is exactly a search_references call (same backends, same substitution, same keys to pass to ' +
  'add_citation). It does NOT search the project — use list_references for that. Read-only.';

const DESCRIPTION_TAIL =
  `Each query reports its own outcome, in order: answered, failed (with the reason), or not run. ` +
  `The batch stops early after three failures in a row or once ${BATCH_START_DEADLINE_MS / 1000} ` +
  's have passed; send the queries marked not run again. Hits are capped by size, kept whole and ' +
  "in rank order — every query's top hit first — and the cut is counted in resultsOmitted. Send " +
  'batches one after another, never in parallel.';

export function registerSearchReferencesBatch(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'search_references_batch',
    {
      title: 'Search a bibliography for many references',
      description: [DESCRIPTION_HEAD, describeSourceSelection(ctx.config), DESCRIPTION_TAIL].join(
        ' ',
      ),
      inputSchema: buildInputSchema(ctx.config),
      outputSchema,
    },
    async ({ queries, maxResults, source }) => {
      try {
        const secrets = ctx.credentials.allSecrets();
        const deps: BatchDeps = {
          search: (query) =>
            ctx.references.search(query, {
              maxResults: maxResults ?? BATCH_DEFAULT_RESULTS,
              source,
            }),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: () => performance.now(),
          redact: (message) => redact(message, secrets),
          // The one refusal every query would meet identically: raised whole, as
          // search_references raises it, rather than reported twenty times.
          isFatal: (err) => err instanceof ReferenceSourceInvalidError,
        };
        const run = await runReferenceBatch(queries, deps);
        const plan = planReferenceBatch(run);
        return {
          content: [{ type: 'text', text: renderReferenceBatchText(plan) }],
          structuredContent: {
            queries: plan.items.length,
            searched: plan.searched,
            failed: plan.failed,
            notRun: plan.notRun,
            resultsOmitted: plan.resultsOmitted,
            ...(plan.stopped ? { stopped: plan.stopped } : {}),
            ...(plan.note ? { note: plan.note } : {}),
            items: plan.items,
          },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

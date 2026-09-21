/**
 * Deciding how much of `search_files`' payload may be returned, against a character budget on the
 * RENDERED (JSON-encoded) result. A pure planner over plain data, the same shape as
 * `src/lib/floatsBudget.ts` for `pdf_geometry` and `src/lib/conflictBudget.ts` (issue #68) for a
 * rebase conflict report: a budget, a plan, a human-readable `note`, and a tool layer that only
 * maps the plan onto response shapes.
 *
 * Why it exists here: **every byte of a search result is document-controlled**. The paths come
 * from walking the project, the `text` of each hit is a line of the user's own source, and the
 * pattern that selects them is the caller's. A count cap alone bounds none of that — 200 hits in
 * a generated `.tex`, each line 200 characters with four context lines, is ~200KB, which is the
 * exact defect #68 fixed for push conflicts, where a report of ~67k characters sailed past a
 * client's result cap and was therefore never delivered. A payload nobody receives is strictly
 * worse than a truncated one that says what it cut.
 *
 * Two departures from `floatsBudget.ts`, both deliberate:
 *
 *  1. **Each entry is charged its own `JSON.stringify(entry).length`, not a pinned per-entry
 *     constant.** A float entry is three fixed string fields, so a constant can be measured and
 *     pinned. A match entry is not: `before`/`after` are present only when context was asked for,
 *     hold a caller-chosen number of lines, and every one of them is document text whose escaped
 *     width (`\\`, `\"`, `\t`, `\u001b`) is nothing like its raw width. Stringifying the entry
 *     that will actually be sent is the exact cost and cannot drift when a field is added — which
 *     is the property the pinned constant was there to protect, obtained directly instead.
 *  2. **`skipped` has its own budget rather than sharing the matches' one.** It is the record of
 *     files that were NOT searched (a binary, an oversized file, an unreadable one), and "not
 *     searched" must not be crowded out by a long list of hits: those are different claims, and
 *     losing the second turns "not searched" into an indistinguishable "no match".
 *
 * The planner charges exactly what the tool sends, so the tool must hand these very objects
 * through to `structuredContent` — a test pins `JSON.stringify(plan.matches).length` against the
 * budget to keep that honest.
 */

/**
 * Total character budget for the `matches` array as JSON-encoded into `structuredContent`.
 *
 * 20000 is this codebase's house figure for "one document-controlled field's share of a tool
 * result" — `CONFLICT_CONTENT_BUDGET`, and `FLOATS_CONTENT_BUDGET` after it — sized so the worst
 * case lands well under the ~67k a client actually rejected, while leaving room for the rest of
 * the result alongside it. Nothing about search argues for a different number, and two budgets
 * for the same class of defect only invite the question of which is right.
 */
export const SEARCH_CONTENT_BUDGET = 20000;

/**
 * Separate, much smaller budget for the `skipped` array. Small because it is diagnostic: a caller
 * needs to know that files were not searched and roughly which, not to receive every path in a
 * project of figures. What does not fit is counted, never dropped silently.
 */
export const SEARCH_SKIPPED_BUDGET = 2000;

/**
 * Hard ceiling on how many matches are ever returned, whatever they cost.
 *
 * Not redundant with the size budget: it is what makes a search over a 5000-hit pattern return
 * *promptly and legibly* rather than "the first N that happened to fit", and it is the bound the
 * `note` can point at when a caller should be narrowing the pattern instead of paging. 200 is the
 * same order as `CONFLICT_MAX_FILES` (20) scaled to a line-oriented result.
 */
export const SEARCH_MAX_MATCHES = 200;

/** Hard ceiling on entries in `skipped`, matching `capList`'s house value of 20. */
export const SEARCH_MAX_SKIPPED = 20;

/** The `[` and `]` around an array, charged up front — see `floatsBudget.ts` on why. */
const ARRAY_JSON_OVERHEAD = 2;

/** The comma between two elements, charged per element (over-charging the last by one). */
const ELEMENT_SEPARATOR_OVERHEAD = 1;

export interface SearchPlan<M, S> {
  /** The kept matches, in the order given — never reordered, never cherry-picked by size. */
  matches: M[];
  /** Matches dropped by {@link SEARCH_MAX_MATCHES}. */
  omittedByCap: number;
  /** Matches dropped by {@link SEARCH_CONTENT_BUDGET}. */
  omittedBySize: number;
  /** The kept skipped-file records. */
  skipped: S[];
  /** Skipped-file records dropped, by either the count cap or the skipped budget. */
  skippedOmitted: number;
  /** Present only when something was actually cut; names only the bound that fired. */
  note?: string;
}

export interface SearchBudgetOptions {
  contentBudget?: number;
  skippedBudget?: number;
  maxMatches?: number;
  maxSkipped?: number;
}

/**
 * Plan which matches and skipped-file records fit in the returned payload.
 *
 * Entries are walked in the order given — file order, then line order — and each is charged its
 * rendered cost until the next would push the running total past the budget; that entry and
 * every one after it are cut and counted. **The order is never changed and small entries are
 * never preferred**: a caller reads a search result as a list of places to go look, and a
 * reordered or cherry-picked list is a different answer to the question asked. Cutting the tail
 * keeps the kept prefix the hits nearest the top of the project, which is where a reader starts.
 *
 * **A single entry that does not fit the whole budget is still kept, if it is the first.** An
 * empty array tells a caller nothing at all, where one over-budget row is still an answer and
 * the `note` says the budget fired. The exception cannot compound: the running total absorbs the
 * full cost, so everything after it is cut.
 */
export function planSearchPayload<M, S>(
  matches: readonly M[],
  skipped: readonly S[],
  opts: SearchBudgetOptions = {},
): SearchPlan<M, S> {
  const contentBudget = opts.contentBudget ?? SEARCH_CONTENT_BUDGET;
  const skippedBudget = opts.skippedBudget ?? SEARCH_SKIPPED_BUDGET;
  const maxMatches = opts.maxMatches ?? SEARCH_MAX_MATCHES;
  const maxSkipped = opts.maxSkipped ?? SEARCH_MAX_SKIPPED;

  const kept = fill(matches, contentBudget, maxMatches);
  const keptSkipped = fill(skipped, skippedBudget, maxSkipped);

  const plan: SearchPlan<M, S> = {
    matches: kept.kept,
    omittedByCap: kept.omittedByCap,
    omittedBySize: kept.omittedBySize,
    skipped: keptSkipped.kept,
    skippedOmitted: keptSkipped.omittedByCap + keptSkipped.omittedBySize,
  };
  const note = describe(plan, {
    total: matches.length,
    contentBudget,
    maxMatches,
    oversizedFirst: kept.oversizedFirst,
    skippedByCap: keptSkipped.omittedByCap,
    maxSkipped,
  });
  if (note) plan.note = note;
  return plan;
}

interface FillResult<T> {
  kept: T[];
  omittedByCap: number;
  omittedBySize: number;
  /** Rendered cost of a first entry that alone exceeded the budget, else 0. */
  oversizedFirst: number;
}

/**
 * Fill one array against one budget. At most ONE of `omittedByCap` and `omittedBySize` can come
 * back non-zero, by construction: the count cap can only fire while entries are still being
 * kept, and nothing is kept after the size budget has cut one. That is what lets the `note`
 * name a single bound without having to choose between two that both fired.
 */
function fill<T>(items: readonly T[], budget: number, maxItems: number): FillResult<T> {
  const kept: T[] = [];
  let used = ARRAY_JSON_OVERHEAD;
  let omittedByCap = 0;
  let omittedBySize = 0;
  let oversizedFirst = 0;

  for (const item of items) {
    if (kept.length >= maxItems || omittedByCap > 0) {
      omittedByCap++;
      continue;
    }
    // Exactly what this element will contribute to the encoded array: its own JSON, escapes and
    // all, plus the comma that separates it from the next.
    const cost = JSON.stringify(item).length + ELEMENT_SEPARATOR_OVERHEAD;
    if (omittedBySize === 0 && used + cost <= budget) {
      used += cost;
      kept.push(item);
      continue;
    }
    if (kept.length === 0 && omittedBySize === 0) {
      // Keep-at-least-one. `used` absorbs the full cost so every later entry is cut rather than
      // small ones being squeezed in behind a row that already broke the budget.
      used += cost;
      kept.push(item);
      oversizedFirst = cost;
      continue;
    }
    omittedBySize++;
  }
  return { kept, omittedByCap, omittedBySize, oversizedFirst };
}

/**
 * The `note`, naming ONLY the bound that actually fired. Reporting a cap that did not fire sends
 * the reader looking for a cause that is not there — the rule `conflictBudget.ts` states for its
 * per-side / aggregate / file-count caps, and `floatsBudget.ts` for its one oversized entry.
 */
function describe<M, S>(
  plan: SearchPlan<M, S>,
  ctx: {
    total: number;
    contentBudget: number;
    maxMatches: number;
    oversizedFirst: number;
    skippedByCap: number;
    maxSkipped: number;
  },
): string | undefined {
  const parts: string[] = [];
  // "of the N that reached this budget", never "of N in the project": the planner is handed
  // whatever the search collected, which on a very large result is itself already bounded. The
  // project-wide count is reported separately, by the caller that actually counted it.
  const of = `of the ${ctx.total} matching line(s) that reached this budget`;
  if (plan.omittedByCap > 0) {
    parts.push(
      `${plan.omittedByCap} ${of} were omitted: at most ${ctx.maxMatches} are returned per ` +
        'call. Narrow the search (subdir, filter, a more specific pattern) rather than paging — ' +
        'the omitted ones are not fetchable from this result.',
    );
  }
  if (plan.omittedBySize > 0) {
    parts.push(
      ctx.oversizedFirst > 0
        ? `${plan.omittedBySize} ${of} were omitted: the first match alone renders to ` +
            `${ctx.oversizedFirst} chars, over the whole ${ctx.contentBudget}-char payload ` +
            'budget — it is returned regardless, and everything after it was cut.'
        : `${plan.omittedBySize} ${of} were omitted: the ${ctx.contentBudget}-char payload ` +
            'budget (charged on the JSON-encoded size of the matches array, escaping included) ' +
            'was reached. Narrow the search, or lower contextLines.',
    );
  }
  if (plan.skippedOmitted > 0) {
    parts.push(
      `${plan.skippedOmitted} file(s) that were not searched are missing from "skipped": ` +
        (ctx.skippedByCap > 0
          ? `it lists at most ${ctx.maxSkipped} paths.`
          : 'its own small character budget was reached.'),
    );
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

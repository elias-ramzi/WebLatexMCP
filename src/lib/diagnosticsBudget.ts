/**
 * Deciding how much of `compile`'s `errors[]` and `warnings[]` may be returned, against count caps
 * and a character budget charged on the RENDERED size in **both** channels. A pure planner over
 * plain data, the same shape as `src/lib/conflictBudget.ts` (issue #68), `src/lib/searchBudget.ts`,
 * `src/lib/citationsBudget.ts` and `src/lib/diffBudget.ts`: a budget, a plan, a human-readable
 * `note`, and a tool layer that only maps the plan onto response shapes. It imports nothing from
 * the tool layer and touches no fs/process/clock, so it stays testable without a live MCP client.
 *
 * Why it exists (issue #162). `compile` budgeted one of its two document-controlled channels and
 * not the other: `logTail` is bounded by `filterLog`'s `maxLines` (80), while `errors[]` and
 * `warnings[]` went into `structuredContent` uncapped. The tool's own comment says why that hurts
 * — "a normal build has hundreds of [warnings]" — which bounded the *per-warning* cost (no
 * snippets on warnings) and left the *count* open. A thesis-length document with a wide table
 * emits an `Overfull \hbox` per line; ~1500 of them at ~120 characters of rendered JSON each is
 * ~180k, past the ~67k a client rejected **undelivered** in #68, on a **successful** compile. And
 * `compile` is the most-called tool in the server: this fires on the loop the agent is already in,
 * not on a tool someone reaches for deliberately.
 *
 * Four decisions carry this module.
 *
 *  1. **{@link ALLOCATION_ORDER}: errors are allocated first, so warnings are cut first.** The
 *     thing that breaks the build is cut last — `citationsBudget.ts`'s rule, and
 *     `conflictBudget.ts`'s before it. Spending one pool in declaration order would cut the errors
 *     because the advisory list ran first, and on a failing warning-heavy document that is exactly
 *     the inversion that happens: the log carries hundreds of box warnings and three errors.
 *
 *  2. **The two channels are charged differently, because they ARE different.** The result text
 *     re-renders a bounded window of the errors *with their snippets* (see
 *     {@link textPrintedErrors}), so those ship twice — the #153 defect; warnings ship once, in
 *     `structuredContent` only. Averaging a "×2" factor over both would over-charge every warning
 *     (cutting warnings that would have fit) and under-charge a snippet-bearing error (the item
 *     that actually costs). So the cost of an error is its JSON **plus** its text rendering when
 *     and only when it will be rendered, and {@link renderErrorLine} is the same call the tool
 *     ships — the `diffBudget.ts` technique of putting the render template beside the cost
 *     function so the two cannot drift.
 *
 *  3. **The text channel is rendered from the already-cut payload**, never from the full one:
 *     {@link DiagnosticsPlan.errorLines} is built from the kept errors inside this module, so a
 *     tool that used the plan for `structuredContent` and re-rendered the text from its own arrays
 *     cannot exist. Half a budget reads as though it worked (`searchBudget.ts` states the same
 *     rule).
 *
 *  4. **A cap omission is not a filter omission.** `compile.warningsOmitted` counts what the
 *     caller's own `warningsFilter` removed *at their request*, and its schema text says so at
 *     length. Folding a size cut into it would make a documented field lie, so the cuts here get
 *     their own counters — {@link DiagnosticsPlan.errorsOmittedByCap} and
 *     {@link DiagnosticsPlan.warningsOmittedByCap}, the `…ByCap` suffix being what tells the two
 *     claims apart.
 *
 * What this budget does **not** govern, deliberately: `logTail` (already bounded at 80 lines by
 * `filterLog`, and left exactly as it is — it is the fallback evidence for a `warnings[]` this
 * module cut, and moving it would perturb the byte-identical output `filterLog` promises a caller
 * that passes no `keepWarning`), `hint` (fixed server-authored templates plus package names) and
 * the headline. Those are bounded by construction; `errors`/`warnings` were bounded by nothing.
 */

import { formatSnippet } from './sourceSnippet.js';

/**
 * Total character budget for `errors[]` and `warnings[]` together, across BOTH channels.
 *
 * 20000 is this codebase's house figure for a rendered content budget — `CONFLICT_CONTENT_BUDGET`,
 * `FLOATS_CONTENT_BUDGET`, `SEARCH_CONTENT_BUDGET`, `CITATIONS_CONTENT_BUDGET`,
 * `DIFF_CONTENT_BUDGET` — sized so the worst case lands well under the ~67k a client actually
 * rejected. Nothing about a diagnostic argues for a different number, and a second figure for the
 * same class of defect only invites the question of which one is right.
 */
export const DIAGNOSTICS_CONTENT_BUDGET = 20000;

/**
 * Hard ceiling on `errors[]`, before the character budget is consulted. 20 is the house figure for
 * a capped list (`capList`, `CONFLICT_MAX_FILES`, `DIFF_MAX_FILES`, `CITATIONS_MAX_FINDINGS`).
 *
 * Not redundant with the size budget: a failed compile can emit a thousand cascade errors that are
 * all consequences of the first, and a caller reads the top of that list, never the bottom. The
 * full set is always in `logPath`.
 *
 * One exception, and it is the same rule the text channel already applied at the tool layer: an
 * error **carrying a snippet** is kept past this cap (see {@link capErrors}).
 */
export const DIAGNOSTICS_MAX_ERRORS = 20;

/**
 * Hard ceiling on `warnings[]`. 200 rather than 20, matching `SEARCH_MAX_MATCHES`: a warning is
 * one line of the log, and a caller scans the list for a *pattern* ("which file overflows?")
 * rather than reading each entry, which is exactly how search hits are read. On any real document
 * the character budget below is the bound that actually fires first — this one is what keeps a log
 * of 5000 trivially short warnings from spending the whole pool on noise.
 */
export const DIAGNOSTICS_MAX_WARNINGS = 200;

/**
 * How many errors the result text lists before pointing at `structuredContent` and the log. Lives
 * here, beside the cost function that charges the text rendering, rather than in the tool: the
 * number that decides what is rendered and the number that decides what is charged must be one
 * number.
 */
export const MAX_TEXT_ERRORS = 10;

/**
 * Withheld from the budget to pay for the single `note`, which ships in both channels (rendered
 * into the result text AND carried in `structuredContent`), so the allowance is charged twice
 * over. The note describes the cuts, so charging it per-part would be circular; a flat reserve
 * pinned by a test that the longest note this module can produce fits inside it gives the same
 * guarantee without the circularity — `diffBudget.ts`'s `DIFF_NOTE_RESERVE` technique.
 */
export const DIAGNOSTICS_NOTE_RESERVE = 1600;

/** The `[` and `]` around a JSON array, charged up front — see `floatsBudget.ts` on why. */
const ARRAY_JSON_OVERHEAD = 2;

/** The comma between two JSON array elements, charged per element (over-charging the last by 1). */
const ELEMENT_SEPARATOR_OVERHEAD = 1;

/** The `\n` that joins one rendered error line to the next in the text channel. */
const TEXT_LINE_SEPARATOR_OVERHEAD = 1;

/**
 * The order the character budget is ALLOCATED in — so, read back to front, the cut order.
 *
 *  1. `warnings` is cut first. A warning is advisory: the document compiled, and an
 *     `Overfull \hbox` is a typographic note about a line that is 3pt too wide. It is also the
 *     list that runs to the hundreds on an ordinary build, so it is both the cheapest to lose and
 *     the whole reason this budget exists. Losing it is not silence either — the box lines are
 *     still in `logTail`, and every one of them is in `logPath`.
 *  2. `errors` is cut last. An error is why the PDF is not there. It is also the more expensive
 *     item (a `message`, and for up to ten locations a five-line `snippet` that ships in both
 *     channels), which is precisely why an order is needed rather than a shared pool walked in
 *     whatever sequence the tool happens to build its arrays in: `compile` builds errors first
 *     today, so a naive pool would look correct while being one refactor away from spending
 *     itself on box warnings and returning none of the three errors that broke the build.
 *
 * There is no third rank, and the two are never interleaved: once the errors have been fitted the
 * warnings take what is left, and if the errors were themselves cut by size the warnings get
 * nothing at all (`citationsBudget.ts`'s rule — letting a cheap advisory entry slip in behind a
 * cut higher-priority list inverts the order for the sake of a few characters).
 */
export const ALLOCATION_ORDER = ['errors', 'warnings'] as const;

/** The fields {@link renderErrorLine} needs; anything else on the object is carried untouched. */
export interface RenderableError {
  file?: string;
  line?: number;
  message: string;
  snippet?: string;
  snippetStartLine?: number;
}

/**
 * Which of the kept errors the result text lists: the first {@link MAX_TEXT_ERRORS}, plus any
 * later one carrying a snippet.
 *
 * This is the tool's own long-standing rule, moved here unchanged so the cost function and the
 * renderer share it. Its reason is unchanged too: snippets attach per *location* while this window
 * counts *errors*, so capping purely by position drops excerpts the server already paid to read —
 * and the client this rendering exists for is precisely the one that cannot read them out of
 * `structuredContent`. The snippet cap (10 locations) bounds how many extras it can add.
 */
export function textPrintedErrors<E extends RenderableError>(errors: readonly E[]): E[] {
  let listed = 0;
  return errors.filter((e) => {
    if (listed < MAX_TEXT_ERRORS) {
      listed++;
      return true;
    }
    return e.snippet !== undefined;
  });
}

/**
 * One error as the result text renders it: its location and message, and under it the numbered
 * source lines when the location earned a snippet.
 *
 * Nothing here decides *whether* a snippet exists — that is `attachErrorSnippets`' provenance
 * guard, and this module never relaxes it. It renders what is already there.
 */
export function renderErrorLine(e: RenderableError): string {
  const head = `  ${e.file ?? '?'}:${e.line ?? '?'} ${e.message}`;
  // Each snippet is carried once per location, so this prints every excerpt once.
  return e.snippet ? `${head}\n${formatSnippet(e, e.line)}` : head;
}

/** The text channel's error block, rendered from whichever errors were kept. */
export function renderErrorLines<E extends RenderableError>(errors: readonly E[]): string {
  return textPrintedErrors(errors).map(renderErrorLine).join('\n');
}

/** What the planner decided, and everything the tool needs to render both channels from it. */
export interface DiagnosticsPlan<E, W> {
  /** The errors to send, a prefix of the input (plus snippet-carriers kept past the count cap). */
  errors: E[];
  /** The warnings to send, a prefix of the input. */
  warnings: W[];
  /**
   * Errors this result does not carry, cut to fit it — by the count cap or by the character
   * budget. **Never** the caller's filter: `warningsFilter` does not touch errors at all.
   */
  errorsOmittedByCap: number;
  /**
   * Warnings this result does not carry, cut to fit it. Distinct from `compile`'s
   * `warningsOmitted`, which counts only what the caller's own `warningsFilter` removed — two
   * different claims, deliberately two counters (see this module's header).
   */
  warningsOmittedByCap: number;
  /** The text channel's error block, built from {@link DiagnosticsPlan.errors} and nothing else. */
  errorLines: string;
  /** How many of the kept errors that block lists, so the tool can say what it left for JSON. */
  errorsInText: number;
  /** What was cut and how to get it. Present only when something actually was. */
  note?: string;
}

export interface DiagnosticsBudgetOptions {
  budget?: number;
  maxErrors?: number;
  maxWarnings?: number;
}

/**
 * Apply the error count cap, keeping the first `max` **plus every later error that carries a
 * snippet**.
 *
 * The exception exists so a cut never throws away source context the server already read and
 * vouched for: snippets attach to the first error at each of up to ten distinct locations, and a
 * location's first error can sit well past position 20 on a log that repeats a handful of
 * locations. It is bounded by that same ten-location cap, so it can add at most ten entries.
 *
 * It also keeps one invariant the schema depends on: an error that HAD a snippet still has it in
 * the result, so `omittedSnippetLocations` (counted upstream, at attach time) stays readable as
 * "locations the server could not vouch for" rather than silently also meaning "locations that did
 * not fit".
 */
function capErrors<E extends RenderableError>(errors: readonly E[], max: number): E[] {
  if (errors.length <= max) return [...errors];
  return errors.filter((e, i) => i < max || e.snippet !== undefined);
}

/**
 * Plan which errors and warnings fit, in two passes: the count caps, then the character budget
 * walked in {@link ALLOCATION_ORDER}.
 *
 * Both lists are cut as a **tail**, never reordered and never cherry-picked by size. For errors
 * that is not merely stability: TeX's first error is usually the cause and the ones after it the
 * cascade, so the kept prefix is the half a reader wants. For warnings it is file order, which is
 * how a caller correlates them with the document.
 *
 * **Keep-at-least-one applies to errors only.** A failed compile that returns an empty `errors[]`
 * tells the caller nothing at all — not even which file broke — so one error is kept even when it
 * alone exceeds the whole budget (`searchBudget.ts` and `citationsBudget.ts` make the same
 * exception for the same reason, and both confine it to the highest-priority list). Warnings get
 * no such exception, and not by omission: a warning's `message` is document-controlled free text,
 * and an empty `warnings[]` is not silence here, because the box lines are still in `logTail` and
 * `warningsOmittedByCap` says how many went.
 */
export function planDiagnosticsPayload<E extends RenderableError, W>(
  errors: readonly E[],
  warnings: readonly W[],
  opts: DiagnosticsBudgetOptions = {},
): DiagnosticsPlan<E, W> {
  const budget = opts.budget ?? DIAGNOSTICS_CONTENT_BUDGET;
  const maxErrors = opts.maxErrors ?? DIAGNOSTICS_MAX_ERRORS;
  const maxWarnings = opts.maxWarnings ?? DIAGNOSTICS_MAX_WARNINGS;

  // Pass 1 — the count caps.
  const cappedErrors = capErrors(errors, maxErrors);
  const cappedWarnings = warnings.slice(0, maxWarnings);
  const errorsCutByCount = errors.length - cappedErrors.length;
  const warningsCutByCount = warnings.length - cappedWarnings.length;

  // Pass 2 — the character budget. Both arrays' JSON brackets are charged up front; the note's
  // reserve is withheld whether or not a note is produced, which can only over-charge.
  let remaining = budget - DIAGNOSTICS_NOTE_RESERVE - 2 * ARRAY_JSON_OVERHEAD;

  const keptErrors: E[] = [];
  let listed = 0;
  let errorsCutBySize = 0;
  for (const e of cappedErrors) {
    if (errorsCutBySize > 0) {
      errorsCutBySize++;
      continue;
    }
    // The text window is evaluated against the errors actually KEPT, with the same running
    // counter `textPrintedErrors` uses — so what is charged is what will be rendered, entry for
    // entry, and a cut error frees its text cost as well as its JSON cost.
    const printed = listed < MAX_TEXT_ERRORS || e.snippet !== undefined;
    const cost =
      JSON.stringify(e).length +
      ELEMENT_SEPARATOR_OVERHEAD +
      (printed ? renderErrorLine(e).length + TEXT_LINE_SEPARATOR_OVERHEAD : 0);
    if (cost <= remaining || keptErrors.length === 0) {
      // Keep-at-least-one absorbs the full cost, so `remaining` can go negative and everything
      // after it is cut rather than small entries squeezing in behind an oversized first.
      remaining -= cost;
      keptErrors.push(e);
      if (listed < MAX_TEXT_ERRORS) listed++;
      continue;
    }
    errorsCutBySize = 1;
  }

  // Strict priority: once the errors have been cut by size the pool is spent, and the warnings get
  // nothing. Letting a short warning slip into what is left would invert the allocation order for
  // the sake of a few characters (`citationsBudget.ts`'s `spent()`).
  if (errorsCutBySize > 0) remaining = 0;

  const keptWarnings: W[] = [];
  let warningsCutBySize = 0;
  for (const w of cappedWarnings) {
    if (warningsCutBySize > 0) {
      warningsCutBySize++;
      continue;
    }
    const cost = JSON.stringify(w).length + ELEMENT_SEPARATOR_OVERHEAD;
    if (cost <= remaining) {
      remaining -= cost;
      keptWarnings.push(w);
      continue;
    }
    warningsCutBySize = 1;
  }

  const plan: DiagnosticsPlan<E, W> = {
    errors: keptErrors,
    warnings: keptWarnings,
    errorsOmittedByCap: errorsCutByCount + errorsCutBySize,
    warningsOmittedByCap: warningsCutByCount + warningsCutBySize,
    errorLines: renderErrorLines(keptErrors),
    errorsInText: textPrintedErrors(keptErrors).length,
  };
  const note = describeDiagnosticCuts(
    {
      errorsCutByCount,
      errorsCutBySize,
      warningsCutByCount,
      warningsCutBySize,
      errorsShown: keptErrors.length,
      warningsShown: keptWarnings.length,
    },
    { budget, maxErrors, maxWarnings },
  );
  if (note) plan.note = note;
  return plan;
}

interface CutCounts {
  errorsCutByCount: number;
  errorsCutBySize: number;
  warningsCutByCount: number;
  warningsCutBySize: number;
  errorsShown: number;
  warningsShown: number;
}

/**
 * The `note`, naming ONLY the bound that actually fired — reporting a cap that did not fire sends
 * the reader looking for a cause that is not there (`conflictBudget.ts`'s rule, and every budget
 * in the family after it).
 *
 * It also has to say that this is *not* `warningsFilter`, in as many words: a caller reading
 * "warnings were omitted" on a call they passed no filter to would otherwise reach for the one
 * documented explanation and find it does not apply.
 */
function describeDiagnosticCuts(
  cuts: CutCounts,
  ctx: { budget: number; maxErrors: number; maxWarnings: number },
): string | undefined {
  const parts: string[] = [];
  const errorsOmitted = cuts.errorsCutByCount + cuts.errorsCutBySize;
  const warningsOmitted = cuts.warningsCutByCount + cuts.warningsCutBySize;
  if (errorsOmitted > 0) {
    const why: string[] = [];
    if (cuts.errorsCutByCount > 0) {
      why.push(`${cuts.errorsCutByCount} over the ${ctx.maxErrors}-error cap`);
    }
    if (cuts.errorsCutBySize > 0) {
      why.push(`${cuts.errorsCutBySize} over the ${ctx.budget}-character budget`);
    }
    parts.push(
      `errors: showing ${cuts.errorsShown} of ${cuts.errorsShown + errorsOmitted} ` +
        `(${why.join(', ')})`,
    );
  }
  if (warningsOmitted > 0) {
    const why: string[] = [];
    if (cuts.warningsCutByCount > 0) {
      why.push(`${cuts.warningsCutByCount} over the ${ctx.maxWarnings}-warning cap`);
    }
    if (cuts.warningsCutBySize > 0) {
      why.push(`${cuts.warningsCutBySize} over the ${ctx.budget}-character budget`);
    }
    parts.push(
      `warnings: showing ${cuts.warningsShown} of ${cuts.warningsShown + warningsOmitted} ` +
        `(${why.join(', ')})`,
    );
  }
  if (parts.length === 0) return undefined;
  return (
    `${parts.join('; ')}. This is the result-size cap, NOT warningsFilter — that is counted ` +
    'separately in warningsOmitted. The budget is charged across both channels (the first ' +
    'errors are rendered into the result text with their snippets as well as into ' +
    'structuredContent), and warnings are cut before errors. The full set is in the log at ' +
    'logPath; narrow warnings[] with warningsFilter to spend the budget on the ones you want.'
  );
}

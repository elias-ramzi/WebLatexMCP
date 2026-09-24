/**
 * Deciding how much of `check_citations`' four finding lists may be returned, against per-list
 * count caps and a character budget on the RENDERED (JSON-encoded) payload. A pure planner over
 * plain data, the same shape as `src/lib/conflictBudget.ts` for a rebase conflict report,
 * `src/lib/floatsBudget.ts` for `pdf_geometry` and `src/lib/searchBudget.ts` for `search_files`:
 * a budget, a plan, a human-readable `note`, and a tool layer that only maps the plan onto
 * response shapes. It imports nothing from the tool layer and touches no fs/process/clock, so it
 * stays testable without a live MCP client.
 *
 * Why it exists (issue #154): `check_citations` had no bound of any kind — no cap, no
 * `maxResults`, no budget, no counter — and **every byte of all four lists is
 * document-controlled**: the keys come from the user's `\cite` calls, the paths from walking the
 * project, and `uncitedEntries[].title` is a raw BibTeX `title` field of unbounded length. The
 * ordinary case is the one that bites: a group `.bib` carried in the project with 300 entries and
 * a paper citing 80 of them yields ~220 uncited entries, each with a title, in both channels — the
 * DEFAULT result for a perfectly normal paper. The `bibliographyProject` path already forces
 * `uncitedEntries` empty for exactly this reason; the same reasoning applies when the shared `.bib`
 * lives *in* the project, and there nothing bounded it at all.
 *
 * Three things this planner gets right on purpose, each of them a lesson already paid for
 * elsewhere in this codebase:
 *
 *  1. **Per-list caps with an explicit priority, never one global budget spent in declaration
 *     order.** See {@link ALLOCATION_ORDER}. The four lists differ sharply in value per entry, so
 *     a single shared budget consumed in the order the tool happens to build them would spend it
 *     on the advisory list and cut the one that breaks the build — the ordering mistake
 *     `conflictBudget.ts` avoids by allocating `hunks` before the sides.
 *
 *  2. **Nest-aware counting.** Capping the outer list alone leaves one entry with 400 `uses`
 *     uncut: one missing key cited 400 times is a single finding carrying 400 `{path,line}`
 *     objects. The inner arrays are cut first, each with its own counter, and the outer entry is
 *     then charged the cost of what it will actually send.
 *
 *  3. **The budget is charged against rendered size, not content size, and every entry is charged
 *     its own `JSON.stringify(entry).length`** rather than a pinned per-entry constant — the
 *     `searchBudget.ts` departure from `floatsBudget.ts`, for the same reason: these entries have
 *     optional fields (`title`, `type`) and optional counters, so there is no fixed shape to pin,
 *     and stringifying the object that will actually be sent is the exact cost and cannot drift
 *     when a field is added. Charging raw `.length` would under-count badly anyway: a BibTeX title
 *     is LaTeX, and LaTeX is backslash-dense.
 *
 * The planner charges exactly what the tool sends, so the tool must hand these very objects
 * through to `structuredContent` — a test pins the plan's JSON size against the budget.
 *
 * It also bounds the report's two FILE lists, `documents` and `bibliographySources`, which the
 * four-list budget above never covered: `documents` names every non-empty `.tex`/prose file the
 * scan read, so a local project of 1500 markdown notes returned all 1500 paths — ~84 KB of
 * `structuredContent`, past the ~67k a client rejected undelivered (#68) with not one finding in
 * it. See {@link CITATIONS_MAX_FILES} and {@link CITATIONS_FILES_BUDGET}.
 */

import { SEARCH_SKIPPED_BUDGET } from './searchBudget.js';

/**
 * Hard ceiling on entries in each of the four finding lists, before the character budget is even
 * consulted. 20 is this codebase's house figure for a capped list (`capList` in
 * `src/services/gitService.ts`, `CONFLICT_MAX_FILES` in `src/lib/conflictBudget.ts`,
 * `SEARCH_MAX_SKIPPED`), and nothing about a citation finding argues for a different one.
 *
 * Not redundant with the size budget: it is what makes the report *legible* rather than "as many
 * as happened to fit", and it is the bound the `note` can point a caller at when they should be
 * narrowing `documents`/`bibliography` — or raising `maxResults` — instead of reading 220 rows.
 */
export const CITATIONS_MAX_FINDINGS = 20;

/**
 * Hard ceiling on the nested arrays inside one finding — `undefinedCitations[].uses`,
 * `duplicateKeys[].occurrences` and `incompleteEntries[].missing`. Same house figure, because
 * these are lists in exactly the same sense.
 *
 * `missing` is bounded at 5 by construction today (it is filtered from `REQUIRED_FIELDS`, a fixed
 * table in `src/lib/references.ts`, whose longest row has five specs), so `missingOmitted` is
 * expected to stay 0 and a unit test pins that the table cannot outgrow this cap unnoticed. It is
 * capped anyway rather than exempted: the cap costs nothing, and the exemption would have to be
 * re-justified by whoever next adds an entry type.
 */
export const CITATIONS_MAX_PLACES = 20;

/**
 * Total character budget for the four finding lists together, as they will be JSON-encoded into
 * `structuredContent`.
 *
 * 20000 is this codebase's house figure for "one document-controlled field's share of a tool
 * result" — `CONFLICT_CONTENT_BUDGET`, then `FLOATS_CONTENT_BUDGET`, then
 * `SEARCH_CONTENT_BUDGET` — sized so the worst case lands well under the ~67k a client actually
 * rejected (issue #68), while leaving room for the rest of the result alongside it. Nothing about
 * a citation report argues for a different number, and two budgets for the same class of defect
 * only invite the question of which one is right.
 */
export const CITATIONS_CONTENT_BUDGET = 20000;

/**
 * Hard ceiling on the paths listed in EACH of `documents` and `bibliographySources` — the house
 * figure for a capped list, reused from {@link CITATIONS_MAX_FINDINGS} rather than restated.
 *
 * Deliberately NOT raised by `maxResults`: that input is documented as the cap on the four
 * finding lists, and these two are provenance, not findings — which files were read, not what is
 * wrong with them. The report's header still counts every file (shown + omitted); a caller who
 * needs the names narrows `documents` or `bibliography`, which it already knows how to do.
 */
export const CITATIONS_MAX_FILES = CITATIONS_MAX_FINDINGS;

/**
 * Character budget for EACH file list, charged on its rendered JSON. The house figure for a
 * merely diagnostic share — reused from `search_files`' `skipped` list, the same kind of thing (a
 * list of paths telling the caller what the tool touched, not an answer) — rather than restated.
 *
 * Why a budget on top of the count cap: path length is document-controlled too (a checkout's own
 * directory layout), so 20 paths are not a bounded payload on their own. Why a pool of its own
 * rather than a slice of {@link CITATIONS_CONTENT_BUDGET}: the finding lists must not lose room
 * to a long directory name, and a strict-priority pool would have to rank provenance above or
 * below `undefinedCitations`, neither of which is right. Why one allocation PER list rather than
 * one shared: the lists are independent and small in the ordinary case (`bibliographySources` is
 * usually one `.bib`), so a shared pool could only ever let a long `documents` crowd out the one
 * `.bib` name a caller needs to read an `uncitedEntries` path against.
 */
export const CITATIONS_FILES_BUDGET = SEARCH_SKIPPED_BUDGET;

/** Upper bound the tool's `maxResults` input accepts, matching `list_references`' own. */
export const CITATIONS_MAX_RESULTS = 1000;

/** The `[` and `]` around an array, charged up front — see `floatsBudget.ts` on why. */
const ARRAY_JSON_OVERHEAD = 2;

/** The comma between two elements, charged per element (over-charging the last by one). */
const ELEMENT_SEPARATOR_OVERHEAD = 1;

/**
 * The order the character budget is ALLOCATED in — highest value per entry first, so the list
 * that is cut FIRST is the one written last. Reading it as a cut priority, back to front:
 *
 *  1. `uncitedEntries` is cut first. It is advisory — "dead weight, not an error", in the output
 *     schema's own words — and it is also the longest and the most expensive per entry, since it
 *     is the only one carrying a document-controlled `title`.
 *  2. `incompleteEntries` next. A missing required field degrades how a reference renders; the
 *     document still builds and still cites the right work.
 *  3. `duplicateKeys` next. A key defined twice means the later definition is silently ignored, so
 *     a citation can render the wrong paper — wrong output, but output.
 *  4. `undefinedCitations` is cut LAST. A cited key with no entry breaks the build. It is also the
 *     cheapest list to carry (a key and up to 20 `{path,line}` pairs, no free text), so protecting
 *     it costs the others almost nothing.
 *
 * This is the whole reason the budget is not one global slice spent in declaration order: the tool
 * builds `undefinedCitations` first but `uncitedEntries` is the list that runs long, and a shared
 * budget walked in build order would be exhausted by the advisory list before the important one
 * was reached on a report whose lists were built the other way round.
 */
export const ALLOCATION_ORDER = [
  'undefinedCitations',
  'duplicateKeys',
  'incompleteEntries',
  'uncitedEntries',
] as const;

/** Where one citation is used, or one entry defined. */
export interface PlaceLike {
  path: string;
  line: number;
}

/** A cited key with no bibliography entry, as the tool builds it. */
export interface UndefinedCitationLike {
  key: string;
  uses: PlaceLike[];
}

/** A bibliography entry nothing cites, as the tool builds it. */
export interface UncitedEntryLike {
  key: string;
  path: string;
  line: number;
  title?: string;
}

/** A cite key defined more than once, as the tool builds it. */
export interface DuplicateKeyLike {
  key: string;
  occurrences: PlaceLike[];
}

/** A BibTeX entry missing a field its type requires, as the tool builds it. */
export interface IncompleteEntryLike {
  key: string;
  path: string;
  line: number;
  /** BibTeX entry type (`article`, `inproceedings`, …) — it says which field set applies. */
  type?: string;
  missing: string[];
}

/** {@link UndefinedCitationLike} once its `uses` have been cut. */
export interface UndefinedCitation extends UndefinedCitationLike {
  /** Uses dropped by {@link CITATIONS_MAX_PLACES}. Absent when nothing was dropped. */
  usesOmitted?: number;
}

/** {@link DuplicateKeyLike} once its `occurrences` have been cut. */
export interface DuplicateKey extends DuplicateKeyLike {
  /** Occurrences dropped by {@link CITATIONS_MAX_PLACES}. Absent when nothing was dropped. */
  occurrencesOmitted?: number;
}

/** {@link IncompleteEntryLike} once its `missing` has been cut. */
export interface IncompleteEntry extends IncompleteEntryLike {
  /** Field specs dropped by {@link CITATIONS_MAX_PLACES}. Absent when nothing was dropped. */
  missingOmitted?: number;
}

/** The four uncut lists, exactly as the tool derives them, plus the two uncut file lists. */
export interface CitationsFindings {
  undefinedCitations: UndefinedCitationLike[];
  uncitedEntries: UncitedEntryLike[];
  duplicateKeys: DuplicateKeyLike[];
  incompleteEntries: IncompleteEntryLike[];
  /** Every document whose citations were collected. Absent means none. */
  documents?: string[];
  /** Every file the reference entries came from. Absent means none. */
  bibliographySources?: string[];
}

/**
 * What the tool may send.
 *
 * One counter per list, not two. Elsewhere this codebase insists on counting two reasons apart
 * (`unopenablePaths` vs. paths past `MAX_REPORTED_PATH_CHECKS`), but there the two reasons are
 * different CLAIMS — "resolved and found to leave" against "never resolved at all". Here both
 * reasons make the identical claim: this finding exists and is not shown. Which bound fired is a
 * fact about what the caller should do next, not about what the report means, so it is stated in
 * `note` rather than doubling four fields into eight in every result.
 */
export interface CitationsPlan {
  undefinedCitations: UndefinedCitation[];
  uncitedEntries: UncitedEntryLike[];
  duplicateKeys: DuplicateKey[];
  incompleteEntries: IncompleteEntry[];
  /** Findings not shown, by list. Never a silent cut: `total = shown + omitted`, always. */
  undefinedCitationsOmitted: number;
  uncitedEntriesOmitted: number;
  duplicateKeysOmitted: number;
  incompleteEntriesOmitted: number;
  /** At most {@link CITATIONS_MAX_FILES} paths, and within {@link CITATIONS_FILES_BUDGET}. */
  documents: string[];
  bibliographySources: string[];
  /** Paths not listed. `total = shown + omitted`, always; 0 — never absent — when none were cut. */
  documentsOmitted: number;
  bibliographySourcesOmitted: number;
  /** Present only when something was actually cut; names which bound fired for which list. */
  note?: string;
}

function cutInner<P>(items: P[], max: number): { kept: P[]; omitted: number } {
  if (items.length <= max) return { kept: items, omitted: 0 };
  return { kept: items.slice(0, max), omitted: items.length - max };
}

/** What one entry costs as an element of its array, charged on the object that will be sent. */
function entryRenderCost(entry: unknown): number {
  return JSON.stringify(entry).length + ELEMENT_SEPARATOR_OVERHEAD;
}

/**
 * Fit one list into what is left of the budget, cutting a TAIL.
 *
 * The lists arrive sorted by cite key, so the tail is the alphabetically-later keys — arbitrary
 * but stable and predictable, which is what a caller re-running the tool needs. Entries are never
 * reordered and the small ones are never preferred: a cherry-picked list is a different answer to
 * the question asked, the same reason `floatsBudget.ts` and `inlineBudget.ts` cut tails.
 *
 * `keepFirst` is passed only for the highest-priority list. A report that lists nothing at all
 * tells the caller nothing — not even which key breaks their build — so one entry is kept even if
 * it alone exceeds the budget. The exception is cheap precisely because it applies to
 * `undefinedCitations`: a key plus at most {@link CITATIONS_MAX_PLACES} `{path,line}` pairs, with
 * no document-controlled free text in it. The lists that DO carry free text never get it.
 */
function fitList<T>(
  entries: T[],
  remaining: number,
  keepFirst: boolean,
): { kept: T[]; cutBySize: number; remaining: number } {
  let left = remaining - ARRAY_JSON_OVERHEAD;
  const kept: T[] = [];
  for (const entry of entries) {
    const cost = entryRenderCost(entry);
    if (cost > left && !(keepFirst && kept.length === 0)) {
      return { kept, cutBySize: entries.length - kept.length, remaining: left };
    }
    kept.push(entry);
    left -= cost;
  }
  return { kept, cutBySize: 0, remaining: left };
}

interface Lane {
  field: string;
  shown: number;
  cutByCap: number;
  cutBySize: number;
}

function laneNote(lane: Lane, budget: number): string | undefined {
  const omitted = lane.cutByCap + lane.cutBySize;
  if (omitted === 0) return undefined;
  const reasons: string[] = [];
  if (lane.cutByCap > 0) reasons.push(`${lane.cutByCap} over the per-list cap`);
  if (lane.cutBySize > 0) reasons.push(`${lane.cutBySize} over the ${budget}-character budget`);
  return `${lane.field}: showing ${lane.shown} of ${lane.shown + omitted} (${reasons.join(', ')})`;
}

/**
 * Plan which findings fit, in three passes: inner arrays first (so an entry is charged what it
 * will really send), then the per-list count cap, then the character budget walked in
 * {@link ALLOCATION_ORDER}. Once the budget is exhausted the lists after it in that order are cut
 * entirely and counted — which is the point of the order, not a side effect of it.
 */
export function planCitationsPayload(
  findings: CitationsFindings,
  opts: { maxResults?: number; budget?: number; filesBudget?: number } = {},
): CitationsPlan {
  const maxFindings = opts.maxResults ?? CITATIONS_MAX_FINDINGS;
  const budget = opts.budget ?? CITATIONS_CONTENT_BUDGET;
  const filesBudget = opts.filesBudget ?? CITATIONS_FILES_BUDGET;

  // Pass 1 — the nested arrays, before anything is measured.
  const undefinedAll: UndefinedCitation[] = findings.undefinedCitations.map((u) => {
    const { kept, omitted } = cutInner(u.uses, CITATIONS_MAX_PLACES);
    return { ...u, uses: kept, ...(omitted > 0 ? { usesOmitted: omitted } : {}) };
  });
  const duplicateAll: DuplicateKey[] = findings.duplicateKeys.map((d) => {
    const { kept, omitted } = cutInner(d.occurrences, CITATIONS_MAX_PLACES);
    return { ...d, occurrences: kept, ...(omitted > 0 ? { occurrencesOmitted: omitted } : {}) };
  });
  const incompleteAll: IncompleteEntry[] = findings.incompleteEntries.map((e) => {
    const { kept, omitted } = cutInner(e.missing, CITATIONS_MAX_PLACES);
    return { ...e, missing: kept, ...(omitted > 0 ? { missingOmitted: omitted } : {}) };
  });
  const uncitedAll = findings.uncitedEntries;

  // Pass 2 — the per-list count cap.
  const undefinedCapped = cutInner(undefinedAll, maxFindings);
  const duplicateCapped = cutInner(duplicateAll, maxFindings);
  const incompleteCapped = cutInner(incompleteAll, maxFindings);
  const uncitedCapped = cutInner(uncitedAll, maxFindings);

  // Pass 3 — the character budget, in ALLOCATION_ORDER. Once a list has been cut by size the
  // budget is spent, and every list after it in that order gets nothing: strict priority is the
  // whole point of the order, and letting a cheap advisory entry slip in behind a cut
  // higher-priority list would invert it for the sake of a few characters.
  const spent = (fit: { cutBySize: number; remaining: number }): number =>
    fit.cutBySize > 0 ? 0 : fit.remaining;
  const fitted = fitList(undefinedCapped.kept, budget, true);
  const fittedDuplicates = fitList(duplicateCapped.kept, spent(fitted), false);
  const fittedIncomplete = fitList(incompleteCapped.kept, spent(fittedDuplicates), false);
  const fittedUncited = fitList(uncitedCapped.kept, spent(fittedIncomplete), false);

  const lanes: Lane[] = [
    {
      field: 'undefinedCitations',
      shown: fitted.kept.length,
      cutByCap: undefinedCapped.omitted,
      cutBySize: fitted.cutBySize,
    },
    {
      field: 'duplicateKeys',
      shown: fittedDuplicates.kept.length,
      cutByCap: duplicateCapped.omitted,
      cutBySize: fittedDuplicates.cutBySize,
    },
    {
      field: 'incompleteEntries',
      shown: fittedIncomplete.kept.length,
      cutByCap: incompleteCapped.omitted,
      cutBySize: fittedIncomplete.cutBySize,
    },
    {
      field: 'uncitedEntries',
      shown: fittedUncited.kept.length,
      cutByCap: uncitedCapped.omitted,
      cutBySize: fittedUncited.cutBySize,
    },
  ];

  const innerOmitted =
    undefinedAll.reduce((n, u) => n + (u.usesOmitted ?? 0), 0) +
    duplicateAll.reduce((n, d) => n + (d.occurrencesOmitted ?? 0), 0) +
    incompleteAll.reduce((n, e) => n + (e.missingOmitted ?? 0), 0);

  const parts = lanes.map((l) => laneNote(l, budget)).filter((p): p is string => p !== undefined);
  if (innerOmitted > 0) {
    parts.push(
      `${innerOmitted} nested use/occurrence/field entr${innerOmitted === 1 ? 'y' : 'ies'} ` +
        `omitted (max ${CITATIONS_MAX_PLACES} per finding)`,
    );
  }
  const findingsNote =
    parts.length === 0
      ? undefined
      : `${parts.join('; ')}. Lists are cut in this order: uncitedEntries (advisory) first, then ` +
        'incompleteEntries, duplicateKeys, and undefinedCitations last — those break the build. ' +
        '`maxResults` raises the per-list cap; the character budget is fixed, so narrow ' +
        '`documents` or `bibliography` when it is the budget that fired.';

  // The file lists, each against its own cap and pool (see CITATIONS_FILES_BUDGET). Keep-first
  // holds here: one path is bounded by the filesystem's own path limit, and a list that names no
  // file at all while its counter says 1500 were read is less use than one that names one.
  const fileLane = (
    field: string,
    paths: string[],
  ): { kept: string[]; omitted: number; note: string | undefined } => {
    const capped = cutInner(paths, CITATIONS_MAX_FILES);
    const fitted = fitList(capped.kept, filesBudget, true);
    const lane: Lane = {
      field,
      shown: fitted.kept.length,
      cutByCap: capped.omitted,
      cutBySize: fitted.cutBySize,
    };
    return {
      kept: fitted.kept,
      omitted: capped.omitted + fitted.cutBySize,
      note: laneNote(lane, filesBudget),
    };
  };
  const documents = fileLane('documents', findings.documents ?? []);
  const sources = fileLane('bibliographySources', findings.bibliographySources ?? []);
  const fileParts = [documents.note, sources.note].filter((p): p is string => p !== undefined);
  const filesNote =
    fileParts.length === 0
      ? undefined
      : `${fileParts.join('; ')}. The file lists are capped apart from the findings (at most ` +
        `${CITATIONS_MAX_FILES} paths and ${filesBudget} characters each; \`maxResults\` does ` +
        'not raise them) and every file was still checked — pass `documents` or `bibliography` ' +
        'to name the ones you want listed.';

  const noteParts = [findingsNote, filesNote].filter((p): p is string => p !== undefined);
  const note = noteParts.length === 0 ? undefined : noteParts.join(' ');

  return {
    undefinedCitations: fitted.kept,
    uncitedEntries: fittedUncited.kept,
    duplicateKeys: fittedDuplicates.kept,
    incompleteEntries: fittedIncomplete.kept,
    undefinedCitationsOmitted: undefinedCapped.omitted + fitted.cutBySize,
    uncitedEntriesOmitted: uncitedCapped.omitted + fittedUncited.cutBySize,
    duplicateKeysOmitted: duplicateCapped.omitted + fittedDuplicates.cutBySize,
    incompleteEntriesOmitted: incompleteCapped.omitted + fittedIncomplete.cutBySize,
    documents: documents.kept,
    bibliographySources: sources.kept,
    documentsOmitted: documents.omitted,
    bibliographySourcesOmitted: sources.omitted,
    ...(note === undefined ? {} : { note }),
  };
}

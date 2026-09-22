/**
 * Deciding how much of `list_references`' `entries[].fields` may be returned, against a character
 * budget on the RENDERED (JSON-encoded) payload. A pure planner over plain data, the same shape as
 * `src/lib/floatsBudget.ts` for `pdf_geometry`, `src/lib/searchBudget.ts` for `search_files` and
 * `src/lib/conflictBudget.ts` (issue #68) for a rebase conflict report: a budget, a plan, a
 * human-readable `note`, and a tool layer that only maps the plan onto response shapes. It imports
 * nothing from the tool layer or from the parser, and touches no fs/process/clock.
 *
 * Why it exists (issue #137): `fields` is the raw BibTeX field map — lowercased names,
 * `@string` macros expanded — and **every byte of it is document-controlled**, names included. It
 * was reaching clients undeclared, because `entrySchema` never listed it and a zod object strips
 * rather than rejects; declaring it turns "a key that happens to be transmitted" into a promise,
 * and an open-ended `Record<string, string>` promised without a bound is a promise of unbounded
 * output. 200 entries (`maxResults`' default) x an arbitrary number of arbitrary-length fields is
 * the shape of defect #68 fixed for push conflicts, where a ~67k-character result sailed past a
 * client's cap and was therefore never delivered. A payload nobody receives is strictly worse than
 * a truncated one that says what it cut.
 *
 * Three decisions specific to this payload:
 *
 *  1. **The budget is charged on rendered size, the way `floatsBudget.ts` charges it — but only on
 *     the JSON, not on a text channel.** `conflictBudget.ts` additionally charges the marker
 *     boilerplate its text renderer wraps around every hunk, because `push` renders its conflict
 *     payload into the result *text* as well. `list_references` does not: `formatEntry` prints the
 *     key, title, authors, venue and location, and never a single raw field. So the rendered cost
 *     here is the JSON encoding and nothing else. It is still the JSON encoding rather than the raw
 *     `.length`: BibTeX values are brace- and backslash-dense (`{Deep} \emph{Residual}`), and
 *     `JSON.stringify` doubles every backslash and quote.
 *
 *  2. **An over-long name or value drops its field; nothing is ever truncated.** `bibtex` is the
 *     one format `references.ts` calls exact, and a silently shortened value presented in an exact
 *     field is a wrong answer, not a small one — the same reasoning that makes a snippet with
 *     doubtful provenance omitted rather than shown. `auxFloats.ts` already resolves this the same
 *     way, dropping an entry whose field exceeds `MAX_FIELD_LENGTH` instead of cutting it down.
 *
 *  3. **Cutting is cheap here in a way it is not elsewhere, and that is what licenses the tight
 *     caps.** Every entry also carries `raw`, the entry exactly as written, so a field this planner
 *     drops is still in the result verbatim — `fields` is a convenience over bytes the caller
 *     already has, not the only copy. `raw` has since been budgeted too (issue #147,
 *     `src/lib/referenceRawBudget.ts`), which qualifies that licence rather than withdrawing it:
 *     `raw` is cut only at the far end of a long result, it is cut to a marked PREFIX rather than
 *     dropped, and the entry says so in `rawOmitted`. So the remedy this module points at holds
 *     except where that count says otherwise, and the notes below say so instead of promising
 *     unconditionally. Issue #165 added the third planner of the family,
 *     `src/lib/referenceTypedBudget.ts`, over the PARSED fields (`title`, `authors[]`, `venue`,
 *     the identifiers). It does not qualify this licence further — a field dropped here is still
 *     in `raw` on the same terms — but it is the one of the three that is charged against the
 *     rendered TEXT as well as the JSON, because it is the only region `list_references` prints.
 *
 * The planner charges exactly what the tool sends, so the tool must hand these very objects through
 * to `structuredContent` — a test pins the accounting against `JSON.stringify` of the planned
 * entries to keep that honest.
 */

/**
 * Total character budget for every `fields` map in one result, as JSON-encoded into
 * `structuredContent`.
 *
 * 20000 is this codebase's house figure for "one document-controlled field's share of a tool
 * result" — `CONFLICT_CONTENT_BUDGET`, then `FLOATS_CONTENT_BUDGET`, then
 * `SEARCH_CONTENT_BUDGET` — sized so the worst case lands well under the ~67k a client actually
 * rejected, while leaving room for the rest of the result alongside it. Nothing about reference
 * fields argues for a different number, and two budgets for the same class of defect only invite
 * the question of which is right — which is why `referenceRawBudget.ts` re-exports THIS constant
 * for `raw`'s own allocation rather than declaring a figure of its own.
 */
export const REFERENCE_FIELDS_BUDGET = 20000;

/**
 * Hard ceiling on how many fields one entry's map may carry.
 *
 * 20 is `capList`'s house value for a capped list, and it is chosen rather than the larger house
 * figure of 200 because the whole of BibTeX's standard field set is under twenty names: an entry
 * past this cap is a Zotero/biblatex export carrying `abstract`, `keywords`, `file`, `urldate` and
 * friends, or a generated file, not a citation a reader is reading. The cut is a TAIL in the
 * document's own field order, so the fields conventionally written first (`title`, `author`,
 * `year`) are the ones kept, it is counted in the entry's `fieldsOmitted`, and what it drops is
 * still in that entry's `raw`.
 */
export const REFERENCE_MAX_FIELDS_PER_ENTRY = 20;

/**
 * A field whose NAME is longer than this is dropped (never truncated — see the header).
 *
 * 200 is `auxFloats.ts`'s `MAX_FIELD_LENGTH`, reused rather than re-invented. It is enormous for a
 * BibTeX field name — the longest standard one, `archiveprefix`, is 13 characters — which is the
 * point: the gate exists to bound what a malformed or hostile `.bib` can put in a KEY position of
 * a `Record<string, string>` the schema now promises, not to police spelling.
 */
export const REFERENCE_MAX_FIELD_NAME_LENGTH = 200;

/**
 * A field whose VALUE is longer than this is dropped (never truncated — see the header).
 *
 * 2000 is ten times the name gate, and the same order as the other "this is a lot of text for one
 * thing" figures in the codebase (`auxFloats.ts`'s `DEFAULT_MAX_LABELS`, `searchBudget.ts`'s
 * `SEARCH_SKIPPED_BUDGET`). It passes every bibliographic field anyone cites by — the longest
 * title or booktitle in a real `.bib` is a few hundred characters — and stops at the two fields
 * that are not bibliographic at all, a pasted `abstract` and a base64 `file`. Those are exactly
 * the fields a caller should be reading out of `raw` if they want them, and dropping one costs a
 * `fieldsOmitted` count rather than a wrong value.
 */
export const REFERENCE_MAX_FIELD_VALUE_LENGTH = 2000;

/**
 * What the `fields` property itself costs on an entry once JSON-encoded, excluding the pairs:
 * `,` (1) + `"fields"` (8) + `:` (1) + `{}` (2) = 12. Charged once per entry that actually emits a
 * map — the charge rides along with that entry's first kept pair, so an entry the budget cut
 * entirely (which sends no `fields` key at all) is charged nothing for a wrapper it never sends.
 */
export const FIELDS_MAP_JSON_OVERHEAD = 12;

/**
 * What one kept pair costs beyond its own encoded name and value: `:` (1) + the `,` separating it
 * from the next pair (1). Charging the separator per pair rather than per gap over-charges the
 * last pair of each map by one character, which is the direction an accounting has to err in —
 * the plan's total is an exact UPPER bound on the encoded length, never a low one.
 */
export const FIELD_PAIR_JSON_OVERHEAD = 2;

/**
 * The most one kept pair can cost, given the two length gates and JSON escaping at its worst (every
 * character an escape that doubles): 2*200 + 2*2000 + the quotes around each + the pair overhead.
 * A map's first pair also carries {@link FIELDS_MAP_JSON_OVERHEAD}, 12 more.
 *
 * This is why there is no keep-at-least-one exception here, unlike `floatsBudget.ts` and
 * `searchBudget.ts`: at the default budget the first field of the first entry ALWAYS fits, by four
 * orders of the constants rather than by hope, so the "an empty array tells the caller nothing"
 * case those planners have to excuse cannot arise. A test pins the inequality. A caller passing a
 * `budget` below this figure can still get an empty map, and that is the caller's arithmetic.
 */
export const MAX_FIELD_PAIR_COST =
  2 * REFERENCE_MAX_FIELD_NAME_LENGTH +
  2 * REFERENCE_MAX_FIELD_VALUE_LENGTH +
  4 +
  FIELD_PAIR_JSON_OVERHEAD;

/** Anything carrying the parser's optional raw-field map. Structural, so this stays a pure planner. */
export interface FieldsBearing {
  fields?: Record<string, string>;
}

/** An entry as it will be sent: its planned `fields`, plus the count of what was left out. */
export type BudgetedEntry<E> = E & {
  fields?: Record<string, string>;
  fieldsOmitted?: number;
};

export interface ReferenceFieldsPlan<E> {
  /** The entries in the order given, each with its planned `fields` — never reordered. */
  entries: Array<BudgetedEntry<E>>;
  /** Fields dropped because their name or value exceeded a length gate. */
  omittedOversize: number;
  /** Fields dropped by {@link REFERENCE_MAX_FIELDS_PER_ENTRY}. */
  omittedByCap: number;
  /** Fields dropped by the shared rendered-size budget. */
  omittedBySize: number;
  /** Present only when something was actually cut; names only the bound(s) that fired. */
  note?: string;
}

export interface ReferenceFieldsOptions {
  budget?: number;
  maxFields?: number;
  maxNameLength?: number;
  maxValueLength?: number;
}

/** What one pair contributes to the encoded map. */
function pairCost(name: string, value: string): number {
  return JSON.stringify(name).length + JSON.stringify(value).length + FIELD_PAIR_JSON_OVERHEAD;
}

/**
 * Plan which of each entry's raw BibTeX fields fit in the returned payload.
 *
 * Entries are walked in the order given, and within an entry the fields in the order the document
 * wrote them; each kept pair is charged its rendered cost against ONE budget shared by the whole
 * result. **Nothing is reordered and small fields are never preferred over large ones**: a caller
 * reads `fields` as "the entry's own fields", and a map cherry-picked by size is a different answer
 * to the question asked.
 *
 * The size cut is sticky across entries, not just within one: once the shared budget has refused a
 * field, every later field of every later entry is cut too, rather than small maps being squeezed
 * in behind an entry that already exhausted it. That is `inlineBudget.ts`'s rule — a cut-off tail a
 * caller can describe ("the first N entries have their fields") beats a hole in the middle
 * ("entries 1, 2 and 7 do") — and it also keeps the kept prefix the entries nearest the top of the
 * bibliography.
 *
 * An entry the parser gave no `fields` at all (`bibitem` and `prose` formats) passes through
 * untouched and is charged nothing: there is no map to send and no `fieldsOmitted` to report.
 */
export function planReferenceFields<E extends FieldsBearing>(
  entries: readonly E[],
  opts: ReferenceFieldsOptions = {},
): ReferenceFieldsPlan<E> {
  const budget = opts.budget ?? REFERENCE_FIELDS_BUDGET;
  const maxFields = opts.maxFields ?? REFERENCE_MAX_FIELDS_PER_ENTRY;
  const maxNameLength = opts.maxNameLength ?? REFERENCE_MAX_FIELD_NAME_LENGTH;
  const maxValueLength = opts.maxValueLength ?? REFERENCE_MAX_FIELD_VALUE_LENGTH;

  const planned: Array<BudgetedEntry<E>> = [];
  let used = 0;
  let omittedOversize = 0;
  let omittedByCap = 0;
  let omittedBySize = 0;
  let entriesWithFields = 0;

  for (const entry of entries) {
    if (!entry.fields) {
      planned.push(entry);
      continue;
    }
    entriesWithFields++;
    const source = Object.entries(entry.fields);
    const kept: Record<string, string> = {};
    let keptCount = 0;
    let omitted = 0;
    // The map wrapper is owed only once, and only by an entry that ends up sending a map, so it
    // rides along with the first pair that fits rather than being charged up front.
    let wrapperDue = FIELDS_MAP_JSON_OVERHEAD;

    for (const [name, value] of source) {
      if (name.length > maxNameLength || value.length > maxValueLength) {
        omittedOversize++;
        omitted++;
        continue;
      }
      if (keptCount >= maxFields) {
        omittedByCap++;
        omitted++;
        continue;
      }
      const cost = wrapperDue + pairCost(name, value);
      // Sticky: `omittedBySize > 0` keeps every later pair out, here and in every later entry.
      if (omittedBySize > 0 || used + cost > budget) {
        omittedBySize++;
        omitted++;
        continue;
      }
      used += cost;
      wrapperDue = 0;
      kept[name] = value;
      keptCount++;
    }

    if (keptCount === 0 && omitted > 0) {
      // Everything this entry had was cut. The `fields` key is left OFF rather than sent as `{}`:
      // `fieldsOmitted` alone says "this entry has fields and none of them fit", where an empty
      // map would say "this entry has no fields", which is a different and false claim — the same
      // distinction `conflictBudget.ts` keeps between a `null` side with an `elided` record and a
      // `null` side without one. It also stops a long result paying 12 characters per entry for
      // wrappers carrying nothing.
      const cut: BudgetedEntry<E> = { ...entry, fieldsOmitted: omitted };
      // Deleted, not set to `undefined`: an explicit undefined key is dropped by JSON encoding
      // anyway, but it survives every in-process assertion (`'fields' in entry`) and would let a
      // test that meant to check absence pass on a key that is still there.
      delete cut.fields;
      planned.push(cut);
      continue;
    }
    if (keptCount === 0) {
      // A BibTeX entry that genuinely declares no fields (`@misc{key}`). It sends `{}`, which is
      // true, so it is charged — the one charge that can carry the accounting past the budget,
      // bounded at 12 characters per such entry and only ever spent where there are no pairs to
      // spend it on instead.
      used += FIELDS_MAP_JSON_OVERHEAD;
    }
    const out: BudgetedEntry<E> = { ...entry, fields: kept };
    if (omitted > 0) out.fieldsOmitted = omitted;
    planned.push(out);
  }

  const plan: ReferenceFieldsPlan<E> = {
    entries: planned,
    omittedOversize,
    omittedByCap,
    omittedBySize,
  };
  const note = describe(plan, {
    entriesWithFields,
    budget,
    maxFields,
    maxNameLength,
    maxValueLength,
  });
  if (note) plan.note = note;
  return plan;
}

/**
 * The `note`, naming ONLY the bounds that actually fired — reporting a cap that did not fire sends
 * the reader looking for a cause that is not there (`conflictBudget.ts`'s rule for its per-side /
 * aggregate / file-count caps). Unlike those planners this one can legitimately name more than one:
 * the three cuts here are independent (a long value, a long list, a full budget), and any pair of
 * them can fire on the same result.
 *
 * Every part ends at the same place, because it is the same remedy: the dropped field is still in
 * that entry's `raw`.
 */
function describe<E>(
  plan: ReferenceFieldsPlan<E>,
  ctx: {
    entriesWithFields: number;
    budget: number;
    maxFields: number;
    maxNameLength: number;
    maxValueLength: number;
  },
): string | undefined {
  const parts: string[] = [];
  const of = `of the ${ctx.entriesWithFields} BibTeX entry/entries returned`;
  if (plan.omittedOversize > 0) {
    parts.push(
      `${plan.omittedOversize} raw field(s) ${of} were omitted: a field name over ` +
        `${ctx.maxNameLength} or a value over ${ctx.maxValueLength} characters is dropped whole ` +
        'rather than shortened, since a truncated value in an exact field would be wrong, not ' +
        'short.',
    );
  }
  if (plan.omittedByCap > 0) {
    parts.push(
      `${plan.omittedByCap} raw field(s) ${of} were omitted: at most ${ctx.maxFields} fields are ` +
        'returned per entry, keeping the first ones the document writes.',
    );
  }
  if (plan.omittedBySize > 0) {
    parts.push(
      `${plan.omittedBySize} raw field(s) ${of} were omitted: the ${ctx.budget}-char budget for ` +
        'all `fields` maps in one result (charged on their JSON-encoded size, escaping included) ' +
        'was reached, so the later entries carry fewer fields or none.',
    );
  }
  if (parts.length === 0) return undefined;
  return (
    `${parts.join(' ')} Every omitted field is still present verbatim in that entry's \`raw\`, ` +
    'except where that entry’s `rawOmitted` says `raw` was itself cut; per-entry counts are in ' +
    '`fieldsOmitted`. Narrow with `filter` or `path` for fuller maps.'
  );
}

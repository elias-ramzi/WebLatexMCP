/**
 * Deciding how much of `list_references`' `entries[].raw` may be returned, against a character
 * budget on the RENDERED (JSON-encoded) payload. A pure planner over plain data, the sibling of
 * `src/lib/referenceFieldsBudget.ts` (issue #137) and the same shape as `src/lib/floatsBudget.ts`,
 * `src/lib/searchBudget.ts` and `src/lib/conflictBudget.ts` (issue #68): a budget, a plan, a
 * human-readable `note`, and a tool layer that only maps the plan onto response shapes. It imports
 * nothing from the tool layer or from the parser, and touches no fs/process/clock.
 *
 * Why it exists (issue #147): #137 bounded `fields`, the *smaller* of this tool's two
 * document-controlled payloads, and left `raw` — the entry **verbatim** — open. Only `maxResults`
 * bounded the entry count; nothing bounded any single `raw` or their sum. A `.bib` is
 * document-controlled text, so one entry with a pasted `abstract`, a base64 `file` field or a long
 * `annote` is ordinary rather than hostile, and 200 of them is the default page: an ordinary
 * 200-entry bibliography already renders well past the ~67k characters a client rejected
 * undelivered in #68. A payload nobody receives is strictly worse than a truncated one that says
 * what it cut.
 *
 * Four decisions specific to this payload, three of which differ from the `fields` planner:
 *
 *  1. **A cut `raw` is MARKED AND COUNTED, never dropped whole and never silently sliced.**
 *     `references.ts` documents `raw` as the entry verbatim and the schema called it authoritative
 *     when a field is doubtful, so a shortened `raw` that does not say so is a wrong answer rather
 *     than a short one — which is the reasoning that made #137 drop an over-long *field* whole. But
 *     "drop it whole" is not available one level up: dropping a field was cheap precisely **because
 *     `raw` still had it**, and `raw` is the only copy of itself, the remedy every `fieldsOmitted`
 *     note points at, and a required property of the entry — dropping it would mean sending `''`
 *     or demoting a promise callers already read. So the cut keeps a **prefix** (the head of a
 *     BibTeX entry is its type, key and the fields the document writes first — what identifies the
 *     entry), appends {@link rawElisionMarker} so the text itself admits it is a prefix, and sets
 *     `rawOmitted` so the structured channel carries the count. Verbatim is recovered by narrowing
 *     with `path`/`filter`, or by `read_file` at the entry's own `path`:`line`.
 *
 *  2. **The marker is short on purpose; the explanation lives once in the `note`.** A per-entry
 *     marker is paid per entry, so a paragraph of it, repeated across a 200-entry result, would
 *     itself be the oversized payload this module exists to prevent (`conflictBudget.ts` charges
 *     its elision text for the same reason). The marker says what it must — that text is missing,
 *     and how much — and the remedy is stated once in the result-level note and in the schema.
 *
 *  3. **`raw` gets its own allocation of the house figure rather than sharing the `fields` pool.**
 *     They compete for the same result size, so sharing one budget is the tempting reading of "do
 *     not introduce a second number" — but whichever was planned second would then go dark on
 *     every real bibliography (a 200-entry `.bib` exhausts 20000 characters on its own), and the
 *     two answer different questions: `fields` is the parsed convenience, `raw` is the verbatim
 *     authority. Losing either entirely is worse than halving both. So the figure is not a second
 *     number at all — {@link REFERENCE_RAW_BUDGET} *is* `REFERENCE_FIELDS_BUDGET`, imported rather
 *     than restated, so there is one constant to change — and the worst case for the two together
 *     lands at ~40000 characters, still below the ~67k a client actually rejected.
 *
 *  4. **The budget is charged on rendered size**, as `floatsBudget.ts` charges it, and on the JSON
 *     only: `formatEntry` prints a parsed line per entry and reaches `raw` solely as a title
 *     fallback, so there is no text-channel boilerplate to charge the way `conflictBudget.ts` must.
 *     It is the JSON encoding rather than `.length` because BibTeX is brace- and backslash-dense
 *     (`{Deep} \emph{Residual}`), and `JSON.stringify` doubles every backslash and quote.
 *
 * The planner charges exactly what the tool sends, so the tool must hand these very objects through
 * to `structuredContent` — a test pins the accounting against `JSON.stringify` of the planned
 * entries to keep that honest.
 */
import {
  REFERENCE_FIELDS_BUDGET,
  REFERENCE_MAX_FIELD_VALUE_LENGTH,
} from './referenceFieldsBudget.js';

/**
 * Total character budget for every `raw` in one result, as JSON-encoded into `structuredContent`.
 *
 * Deliberately the `fields` budget itself rather than a number of its own — see decision 3 in the
 * header. One house figure (`CONFLICT_CONTENT_BUDGET`, `FLOATS_CONTENT_BUDGET`,
 * `SEARCH_CONTENT_BUDGET`, `REFERENCE_FIELDS_BUDGET`), one place to change it, two allocations of
 * it because the two payloads are separately load-bearing.
 */
export const REFERENCE_RAW_BUDGET = REFERENCE_FIELDS_BUDGET;

/**
 * The most of one entry's verbatim text that is ever returned, whatever the shared budget has left.
 *
 * Derived from the `fields` planner's value gate rather than invented: no single `raw` may cost
 * more than the largest single field value that planner will return. It reads as the right bound
 * for the same reason that one does — an ordinary BibTeX entry is a few hundred characters, and
 * what pushes one past two thousand is a pasted abstract or a base64 `file` field, which is
 * content a caller should be fetching from the file rather than from a listing of 200 entries.
 *
 * Not redundant with the shared budget: without it, one pathological first entry would spend the
 * whole result's allowance and blind every entry behind it (the sticky rule below means they would
 * all come back as markers). With it, the aggregate is spread over at least ten entries.
 */
export const REFERENCE_MAX_RAW_LENGTH = REFERENCE_MAX_FIELD_VALUE_LENGTH;

/**
 * What the `raw` property costs on an entry once JSON-encoded, excluding its value: `,` (1) +
 * `"raw"` (5) + `:` (1). Charged on every entry, since `raw` is required and always sent — the
 * budget bounds the whole `raw` channel, mandatory overhead included, so the plan's total stays an
 * exact UPPER bound on what the channel adds to the result.
 */
export const RAW_PROPERTY_JSON_OVERHEAD = 7;

/**
 * What a `rawOmitted` count costs beyond its digits: `,` (1) + `"rawOmitted"` (12) + `:` (1).
 * Charged only on an entry that was actually cut.
 */
export const RAW_OMITTED_JSON_OVERHEAD = 14;

/**
 * The marker appended to a cut `raw`, so the text itself says it is a prefix of the entry rather
 * than the entry. Kept to one line and one number (see decision 2 in the header): the reason and
 * the remedy are in the result's `rawNote` and in the schema, which are paid once, not per entry.
 *
 * The leading `…` is what a reader sees at the cut point; `rawOmitted` carries the same count in
 * the structured channel, so neither channel has to be read through the other.
 */
export function rawElisionMarker(omitted: number): string {
  return `… [+${omitted} characters omitted]`;
}

/**
 * The worst the marker can cost once rendered, computed from the marker itself so it cannot drift
 * away from it — a hand-written constant would be a second statement of the same fact, and the
 * cheaper one to get wrong. `Number.MAX_SAFE_INTEGER` bounds the digit count for any string a
 * runtime can hold.
 */
export const MAX_RAW_MARKER_COST = JSON.stringify(
  `\n${rawElisionMarker(Number.MAX_SAFE_INTEGER)}`,
).length;

/** Anything carrying the parser's verbatim entry text. Structural, so this stays a pure planner. */
export interface RawBearing {
  raw: string;
}

/** An entry as it will be sent: its planned `raw`, plus how much verbatim text is missing from it. */
export type RawBudgetedEntry<E> = E & {
  raw: string;
  rawOmitted?: number;
};

export interface ReferenceRawPlan<E> {
  /** The entries in the order given, each with its planned `raw` — never reordered. */
  entries: Array<RawBudgetedEntry<E>>;
  /** Entries cut because their own text exceeded {@link REFERENCE_MAX_RAW_LENGTH}. */
  truncatedOversize: number;
  /** Entries cut because the shared rendered-size budget was exhausted. */
  truncatedBySize: number;
  /** Characters of verbatim text missing from the result in total, across both cuts. */
  charactersOmitted: number;
  /** Present only when something was actually cut; names only the bound(s) that fired. */
  note?: string;
}

export interface ReferenceRawOptions {
  budget?: number;
  maxRawLength?: number;
}

/**
 * Cut `text` to at most `limit` UTF-16 code units without splitting a surrogate pair.
 *
 * A pair split down the middle renders as a replacement character and, worse, is a byte sequence
 * the document never contained — in a field whose whole promise is "as written", inventing one is
 * exactly the wrong direction. Dropping the leading half instead costs one character.
 */
function cutTo(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** The `raw` value as it will be sent: the kept prefix, then the marker on its own line. */
function withMarker(kept: string, omitted: number): string {
  const marker = rawElisionMarker(omitted);
  return kept ? `${kept}\n${marker}` : marker;
}

/** What one entry's `raw` (plus its `rawOmitted`, when cut) contributes to the encoded result. */
function rawCost(kept: string, omitted: number): number {
  const value = omitted > 0 ? withMarker(kept, omitted) : kept;
  const counter = omitted > 0 ? RAW_OMITTED_JSON_OVERHEAD + String(omitted).length : 0;
  return RAW_PROPERTY_JSON_OVERHEAD + JSON.stringify(value).length + counter;
}

/**
 * Plan how much of each entry's verbatim text fits in the returned payload.
 *
 * Entries are walked in the order given and charged their rendered cost against ONE budget shared
 * by the whole result. **Nothing is reordered and short entries are never preferred over long
 * ones**: a caller reads the list as "the bibliography's entries", and a list cherry-picked by size
 * is a different answer to the question asked.
 *
 * The size cut is sticky, as it is in `referenceFieldsBudget.ts` and `inlineBudget.ts`: once the
 * shared budget has refused an entry's text, every later entry is cut too, rather than short
 * entries being squeezed in behind a long one. A cut-off tail a caller can describe ("the first N
 * entries are verbatim") beats a hole in the middle ("entries 1, 2 and 7 are"), and it keeps the
 * verbatim prefix on the entries nearest the top of the bibliography. The per-entry length gate is
 * NOT sticky — it is a property of that one entry, exactly as an over-long field's gate is.
 *
 * One charge can carry the accounting past the budget, and it is bounded and deliberate: an entry
 * cut to nothing still sends its marker ({@link MAX_RAW_MARKER_COST} at worst), because a `raw` of
 * `''` would read as "the entry as written is empty". That is a handful of characters against a
 * per-entry scaffold (path, line, key, title, authors) that is already larger, and it is the price
 * of never sending an unmarked cut.
 */
export function planReferenceRaw<E extends RawBearing>(
  entries: readonly E[],
  opts: ReferenceRawOptions = {},
): ReferenceRawPlan<E> {
  const budget = opts.budget ?? REFERENCE_RAW_BUDGET;
  const maxRawLength = opts.maxRawLength ?? REFERENCE_MAX_RAW_LENGTH;

  const planned: Array<RawBudgetedEntry<E>> = [];
  let used = 0;
  let truncatedOversize = 0;
  let truncatedBySize = 0;
  let charactersOmitted = 0;
  let exhausted = false;

  for (const entry of entries) {
    const full = entry.raw;
    let kept = exhausted ? '' : cutTo(full, maxRawLength);
    let cutByBudget = exhausted;

    if (!exhausted) {
      const cost = rawCost(kept, full.length - kept.length);
      if (used + cost > budget) {
        // Sticky from here on: this entry and every later one keep nothing.
        exhausted = true;
        cutByBudget = true;
        kept = '';
      } else {
        used += cost;
      }
    }

    const omitted = full.length - kept.length;
    if (omitted > 0) {
      charactersOmitted += omitted;
      if (cutByBudget) {
        truncatedBySize++;
        // The marker-only entry is charged too, so `used` stays an honest running total even
        // where it exceeds the budget.
        used += rawCost('', omitted);
      } else {
        truncatedOversize++;
      }
      planned.push({ ...entry, raw: withMarker(kept, omitted), rawOmitted: omitted });
      continue;
    }
    planned.push({ ...entry, raw: full });
  }

  const plan: ReferenceRawPlan<E> = {
    entries: planned,
    truncatedOversize,
    truncatedBySize,
    charactersOmitted,
  };
  const note = describe(plan, { total: entries.length, budget, maxRawLength });
  if (note) plan.note = note;
  return plan;
}

/**
 * The `note`, naming ONLY the bounds that actually fired — reporting a cap that did not fire sends
 * the reader looking for a cause that is not there (`conflictBudget.ts`'s rule for its per-side /
 * aggregate / file-count caps). Both can fire on one result: a long entry early and an exhausted
 * budget later are independent events.
 *
 * Every part ends at the same place, because it is the same remedy: the verbatim entry is in the
 * file, one `read_file` away, and a narrower listing returns it in full.
 */
function describe<E>(
  plan: ReferenceRawPlan<E>,
  ctx: { total: number; budget: number; maxRawLength: number },
): string | undefined {
  const parts: string[] = [];
  if (plan.truncatedOversize > 0) {
    parts.push(
      `${plan.truncatedOversize} of the ${ctx.total} entry/entries returned had their \`raw\` ` +
        `cut to the first ${ctx.maxRawLength} characters: a single entry longer than that is a ` +
        'pasted abstract or an embedded file, not a citation.',
    );
  }
  if (plan.truncatedBySize > 0) {
    parts.push(
      `${plan.truncatedBySize} of the ${ctx.total} entry/entries returned carry no verbatim text ` +
        `at all: the ${ctx.budget}-char budget for every \`raw\` in one result (charged on its ` +
        'JSON-encoded size, escaping included) was reached, so the later entries are cut.',
    );
  }
  if (parts.length === 0) return undefined;
  return (
    `${parts.join(' ')} ${plan.charactersOmitted} character(s) of verbatim text were omitted in ` +
    'total; a cut `raw` ends in a `… [+N characters omitted]` marker and is a PREFIX of the ' +
    'entry, not the entry, so it is not authoritative — per-entry counts are in `rawOmitted`. ' +
    'Narrow with `filter` or `path` for verbatim entries, or read the file at the entry’s ' +
    '`path`:`line`.'
  );
}

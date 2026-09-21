/**
 * Deciding how much of `pdf_geometry`'s `floats` array may be returned, against a character budget
 * on the RENDERED (JSON-encoded) payload. A pure planner over plain data, the same shape as
 * `src/lib/conflictBudget.ts` solves for a rebase conflict report and `src/lib/inlineBudget.ts` for
 * `render_pages`: a budget, a plan, a human-readable `note`, and a tool layer that only maps the
 * plan onto response shapes. It imports nothing from the tool layer or from the `.aux` reader, and
 * touches no fs/process/clock, so it stays testable on its own.
 *
 * Why this exists: the `floats` payload is parsed out of the build directory's `.aux`, which is
 * written from the document's own `\label`s — so **every byte of it is document-controlled**. It
 * was bounded by COUNT only (200 entries, each field capped at 200 characters), which is roughly
 * 200 x 3 x 200 ~= 120 KB worst case and no bound at all on what a client will accept. That is the
 * exact defect issue #68 fixed for push conflicts, where a conflict report on one large file
 * rendered ~67k characters, sailed past a client's result cap, and was therefore never delivered —
 * a payload nobody receives is strictly worse than a truncated one that says what it cut.
 *
 * Two lessons from that fix are carried over here rather than re-learned:
 *
 *  1. **The budget is charged against rendered size, not content size.** `conflictBudget.ts`'s
 *     second round of bugs was precisely this: it counted only the content and never the
 *     boilerplate wrapped around each element, so a payload of many small elements blew the same
 *     limit with its content nowhere near it (10 files x 200 tiny hunks rendered 64k characters).
 *     A bound on an internal accounting fiction is not a bound on what the caller receives. Here
 *     the boilerplate is the JSON object around every entry, named and pinned as
 *     {@link FLOAT_ENTRY_JSON_OVERHEAD} / {@link FLOATS_ARRAY_JSON_OVERHEAD}.
 *
 *  2. **`structuredContent` is JSON, and `JSON.stringify` expands every backslash, quote, newline
 *     and control character.** A `\label` key is document-controlled LaTeX text, and LaTeX is
 *     backslash-dense: `\ref{fig:a}` doubles in width once encoded. `conflictBudget.ts` measured a
 *     6x under-count from charging raw `.length` on control-character-heavy content. Every value
 *     below is therefore charged its real `JSON.stringify(value).length`, never `value.length`.
 */

/**
 * Total character budget for the whole `floats` array as it will be JSON-encoded into
 * `structuredContent` — i.e. a bound on the characters this one field contributes to the tool
 * result the client receives, including the JSON punctuation around every entry, not on the sum of
 * the label/number/page strings.
 *
 * 20000 is `CONFLICT_CONTENT_BUDGET`'s number, deliberately: it is this codebase's established
 * house figure for "one document-controlled field's share of a tool result", sized there so the
 * worst case lands well under the ~67k that was actually rejected by a client, while leaving room
 * for the rest of the result (`pages`, `boxes`, the text channel) alongside it. Nothing about
 * floats argues for a different number, and two different budgets for the same class of defect
 * would only invite the question of which one is right.
 */
export const FLOATS_CONTENT_BUDGET = 20000;

/**
 * The literal characters ONE entry costs once JSON-encoded as an element of the `floats` array,
 * EXCLUDING the three values themselves (those are charged exactly, as their real
 * `JSON.stringify` cost, quotes and escapes included).
 *
 * Measured, not guessed: `{"label":` (9) + `,"number":` (10) + `,"page":` (8) + `}` (1) = 28 for
 * the object itself, plus 1 for the comma that separates it from the next element = 29. Key order
 * does not change the count (the same three key names, the same punctuation), so this holds
 * however the tool layer happens to build the object. Charging the separator per entry rather than
 * per gap deliberately over-charges by exactly one comma on the last element — see
 * {@link FLOATS_ARRAY_JSON_OVERHEAD}.
 *
 * Pinned by a test that builds its entries as the reader's own `AuxLabel` type, `JSON.stringify`s
 * the array that will actually be sent, and checks this constant still accounts for the
 * difference. Building them as `AuxLabel` rather than as an inline literal is the load-bearing
 * part: `planFloatsPayload` takes a structural `FloatEntryLike`, and the tool hands it a variable
 * rather than a fresh object literal, so TypeScript's excess-property check does NOT fire on a
 * grown payload shape. Without that tie the pin tests only itself, and a fourth field is
 * discovered later as a silent under-count — which is exactly what it exists to prevent.
 */
export const FLOAT_ENTRY_JSON_OVERHEAD = 29;

/**
 * The `[` and `]` around the array, charged up front. Small, but charged rather than ignored for
 * the same reason `conflictBudget.ts` charges its elision pointers: "this bit is too small to
 * matter" is how an accounting stops being a bound. Together with the per-entry separator charge
 * above, the plan's total accounting is an exact UPPER bound on the real encoded length — it comes
 * out one character high (the over-charged trailing comma pays for one bracket and one to spare),
 * never low, which is the direction a budget has to err in.
 */
export const FLOATS_ARRAY_JSON_OVERHEAD = 2;

/**
 * One float entry, declared structurally rather than imported from the `.aux` reader, so this
 * module stays a pure planner over plain data. All three are strings: `number` is a LaTeX float
 * number like `1` or `A.2`, and `page` is whatever the `.aux` recorded, which is not always a
 * decimal integer (roman front matter).
 *
 * **Structural does NOT mean the reader may grow extra fields.** An earlier version of this
 * comment said it did, which quietly voided {@link FLOAT_ENTRY_JSON_OVERHEAD}: the tool passes
 * the reader's array straight through to `structuredContent`, so a fourth field on `AuxLabel`
 * would be encoded into the payload and charged nothing, every entry would under-count, and the
 * "exact upper bound" below would stop being a bound with nothing failing. The pin test guards
 * this by building its entries as `AuxLabel`s, so a fourth field is a compile error there.
 * If the payload genuinely needs another field, change this interface, the constant and the pin
 * together — that is the point of pinning it.
 */
export interface FloatEntryLike {
  label: string;
  number: string;
  page: string;
}

export interface FloatsPlan {
  /** The kept entries, in the input's order — see {@link planFloatsPayload} on why order is load-bearing. */
  floats: FloatEntryLike[];
  /** How many entries the SIZE budget cut. Zero when the budget never fired. */
  omittedBySize: number;
  /** Present only when the size budget actually cut something. */
  note?: string;
}

/**
 * What one entry costs once encoded as an element of the array: the real `JSON.stringify` length
 * of each of its three values (quotes and escapes included — a backslash-heavy `\label` costs
 * roughly double its raw width) plus the fixed per-entry punctuation.
 */
function entryRenderCost(entry: FloatEntryLike): number {
  return (
    JSON.stringify(entry.label).length +
    JSON.stringify(entry.number).length +
    JSON.stringify(entry.page).length +
    FLOAT_ENTRY_JSON_OVERHEAD
  );
}

/**
 * Plan which float entries fit in the returned payload.
 *
 * Entries are walked in the order given and each is charged its rendered cost until the next one
 * would push the running total past the budget; that entry and every entry after it are cut and
 * counted in `omittedBySize`. **The order is never changed and the small entries are never
 * preferred**: the caller matches a float by its `label` key against the document it is reading,
 * and a reordered or cherry-picked list is a different answer to the question asked — the same
 * reason `inlineBudget.ts` cuts a tail rather than leaving a hole in the middle of a page range.
 * Cutting the tail also means the kept prefix is the entries nearest the front of the `.aux`,
 * which is document order.
 *
 * **A single entry that does not fit the whole budget on its own is still kept, if it is the
 * first.** A bound that returns an empty array tells a caller nothing at all — not even what the
 * document's first float is called — whereas one over-budget row is still an answer, and the
 * `note` says the budget fired. The cost of that exception is bounded by construction rather than
 * by hope: the `.aux` reader already caps each field at 200 characters, so one entry is at worst
 * ~1.2k characters even if every one of those 600 characters is a backslash that doubles when
 * escaped — two orders of magnitude inside the budget it is being excused from. Every entry after
 * it is cut as usual (the running total is already over), so this exception can never compound.
 */
export function planFloatsPayload(
  entries: readonly FloatEntryLike[],
  opts?: { budget?: number },
): FloatsPlan {
  const budget = opts?.budget ?? FLOATS_CONTENT_BUDGET;

  const floats: FloatEntryLike[] = [];
  let used = FLOATS_ARRAY_JSON_OVERHEAD;
  let omittedBySize = 0;
  // Recorded rather than re-derived in the note, because it names a DISTINCT cause — one enormous
  // entry, not a long list — the way `conflictBudget.ts` separates "the headers alone exhausted
  // the budget" from "the aggregate budget was reached". Reporting only the reason that actually
  // fired is the rule; a note blaming list length for a single oversized row sends the reader
  // looking for a cause that is not there.
  let oversizedFirstEntry = 0;

  for (const entry of entries) {
    const cost = entryRenderCost(entry);
    if (used + cost <= budget) {
      used += cost;
      floats.push(entry);
      continue;
    }
    // `floats` is empty only before the first entry is considered: the branch above pushes when it
    // fits and this one pushes when it does not, so from the second iteration on this is false and
    // every further over-budget entry falls through to the cut below.
    if (floats.length === 0) {
      // The keep-at-least-one exception above. `used` deliberately still absorbs the full cost, so
      // the loop below cuts every later entry rather than squeezing small ones in behind a row
      // that already broke the budget.
      used += cost;
      floats.push(entry);
      oversizedFirstEntry = cost;
      continue;
    }
    omittedBySize++;
  }

  if (omittedBySize === 0) return { floats, omittedBySize };

  const reason =
    oversizedFirstEntry > 0
      ? `the first float entry alone renders to ${oversizedFirstEntry} chars, exceeding the ` +
        `whole ${budget}-char floats payload budget — it is returned regardless, and everything ` +
        'after it was cut'
      : `the ${budget}-char floats payload budget (charged on the JSON-encoded size of the ` +
        'floats array, escaping included) was reached';
  return {
    floats,
    omittedBySize,
    // "of the N that reached this budget", never "of N in the document". This planner is handed
    // whatever survived the reader's own DEFAULT_MAX_FLOATS entry cap, so on a document with 500
    // labels `entries.length` is 200 — neither the document's count nor anything the caller could
    // name. Reporting it as a document total would be a number that is simply not true; the
    // entry cap is reported separately, as floatsOmitted.
    note:
      `${omittedBySize} of the ${entries.length} float(s) that reached this budget were omitted: ` +
      `${reason}. The floats returned are the first ones in the document order the .aux records; ` +
      'the omitted ones are not fetchable from this result.',
  };
}

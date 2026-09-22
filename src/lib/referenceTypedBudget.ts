/**
 * Deciding how much of `list_references`' PARSED fields — `title`, `authors[]`, `venue`, `doi`,
 * `url`, `arxivId`, and the identity pair `key`/`label` (plus `type`) — may be returned, against a
 * character budget on the RENDERED payload in BOTH channels it ships in. A pure planner over plain
 * data, the third sibling of `src/lib/referenceFieldsBudget.ts` (issue #137, `fields`) and
 * `src/lib/referenceRawBudget.ts` (issue #147, `raw`), and the same shape as `floatsBudget.ts`,
 * `searchBudget.ts`, `diffBudget.ts` and `conflictBudget.ts` (issue #68): a budget, a plan, a
 * human-readable `note`, and a tool layer that only maps the plan onto response shapes. It imports
 * nothing from the tool layer or from the parser, and touches no fs/process/clock.
 *
 * Why it exists (issue #165). `ReferenceEntry` has three document-controlled regions and the two
 * already budgeted are the two a reader looks at LAST. The parse shortens nothing: a
 * `title={…4000 characters…}` becomes a 4000-character `title`, and `authors` is an unbounded
 * ARRAY built by splitting on ` and `, so a 200-author collaboration entry is 200 strings — per
 * entry, at a default `maxResults` of 200. And for `format: 'bibitem'` and `'prose'` these fields
 * are heuristic slices of free text with no `.bib` anywhere in the path: a quoted-title match over
 * a paragraph claims however much text sat between the delimiters it found. This region is also
 * the only one of the three that `list_references` renders into the result **text**, so every
 * character of it ships twice.
 *
 * Five decisions specific to this payload, four of which differ from its two siblings:
 *
 *  1. **These are not droppable the way an over-long `fields` entry was.** #137 could drop a field
 *     whole *because `raw` still had it*; that licence is gone here in both directions. `key` is
 *     what `add_citation` and `\cite` are called with and `title` is how a caller recognises an
 *     entry, so losing either silently makes the result useless rather than short — and `raw`,
 *     which was the remedy, is now itself cuttable (#147). So the cut is graded by what the value
 *     IS, not by which key it arrives under:
 *
 *       - **Prose-shaped** (`title`, `venue`, each author name) — truncate and mark, keeping a
 *         readable prefix and appending {@link typedElisionMarker} so the value itself admits it
 *         is a prefix. A shortened title still identifies the paper; an absent one does not.
 *       - **Identifiers** (`doi`, `url`, `arxivId`, `type`) — dropped whole, NEVER truncated. Half
 *         a DOI is not a short DOI, it is a DOI that resolves to nothing, and handing one back is
 *         the same wrong-rather-than-short answer `referenceFieldsBudget.ts` refuses to give for an
 *         exact field value.
 *       - **Identity** (`key`, `label`) — never truncated *and* never refused by the shared
 *         budget. They are charged, so the accounting stays honest, but no other entry's text can
 *         cost an entry its name. What happens to a long one is the anomaly the issue asks about,
 *         and the answer is the identifier answer: a `key` over
 *         {@link REFERENCE_MAX_IDENTITY_LENGTH} is DROPPED whole rather than cut, because a
 *         truncated cite key is a key that does not exist — `add_citation` called with it misses,
 *         and it would be indistinguishable from a real one. The gate is 200 characters, so no
 *         bibliography anyone writes ever reaches it: "identity survives intact" is exact for
 *         every well-formed document and gives way only where the document is malformed. Such an
 *         entry is still located by `path`:`line`, which no budget touches.
 *
 *  2. **`authors[]` gets an element cap AND a character charge, because a list has two sizes.**
 *     A budget in characters alone would return 214 one-word names and call the payload bounded;
 *     {@link REFERENCE_MAX_AUTHORS} is `capList`'s house value of 20, and the count that did not
 *     fit is reported per entry in `authorsOmitted` ("first 20 of 214"). It is deliberately a
 *     separate counter from `truncatedAuthors`, which is the DOCUMENT saying `and others` — a
 *     defect of the bibliography — where `authorsOmitted` is this budget saying "not sent". A
 *     caller that conflated them would read a budget cut as a citation defect.
 *
 *  3. **This region gets a third allocation of the house figure, and it is charged across both
 *     channels — which is what keeps three allocations affordable.** Sharing a pool with `fields`
 *     or `raw` is the tempting reading of "do not introduce a second number", and it fails the
 *     same way it failed in #147, only harder: `fields` exists for `bibtex` entries alone, so a
 *     pool shared with it would let one `.bib`'s field maps starve the parsed line that a
 *     `bibitem`/`prose` bibliography has nothing else to offer; and a pool shared with `raw` would
 *     put the verbatim authority and the parsed answer in direct competition when each is the
 *     other's documented remedy. So {@link REFERENCE_TYPED_BUDGET} *is* `REFERENCE_FIELDS_BUDGET`,
 *     imported rather than restated — one house figure, one place to change it, three allocations
 *     because the three payloads are separately load-bearing.
 *
 *     What that costs, stated rather than assumed: `fields` and `raw` are charged on the JSON
 *     alone, this one on the JSON *and* the rendered text together, so the worst case for all
 *     three regions is 3 x 20000 = **~60000 rendered characters across both channels** — not
 *     3 x 20000 per channel — against the ~67000 a client actually rejected undelivered in #68.
 *     The ~40000 figure `referenceRawBudget.ts` quotes for two regions is amended there to match.
 *     One thing this does NOT bound, and it is named here rather than left to be discovered: the
 *     per-entry scaffold (`path`, `line`, `format`, `year`, and the identity strings above) scales
 *     with `maxResults` and with nothing a budget can refuse, exactly as it did before any of
 *     these three planners existed. `filter`, `path` and a smaller page remain the remedy for a
 *     result that is simply long — which is why #165 also lowered `maxResults`' default from 200
 *     to 50: at 200 an ordinary bibliography rendered ~120000 characters even with all three
 *     regions budgeted, and arrived stripped of the authors, venue and DOI a reader is there for;
 *     at 50 it comes back whole and under the cap. A page size is the only lever that reaches the
 *     scaffold, because no content budget can refuse it.
 *
 *  4. **Cut by declared priority, not in declaration order** — the pool is spent in
 *     {@link ALLOCATION_ORDER}, pass by pass over the WHOLE result, not entry by entry. Entry-wise
 *     spending is what makes a budget cut the wrong thing: an ordinary 200-entry bibliography
 *     spends ~250 characters of parsed text per entry, so a single pool walked entry-first hands
 *     the first ~45 entries a title, authors, venue, DOI and URL each and the remaining ~155
 *     nothing at all — including their titles, which is the one field this whole module exists to
 *     protect. Walked field-first, the same result spends ~16000 characters giving EVERY entry its
 *     title and then cuts the advisory fields from the tail. The order is written down, and each
 *     rank earns its place: `title` (recognition), `authors` (the other half of recognition, and
 *     what a verification compares), `doi`/`arxivId` (exact identifiers, a few tens of characters
 *     each, so ranking them high costs almost nothing and makes an entry resolvable without the
 *     file), `venue` (disambiguates same-title works), then `url` and `type` — the longest and the
 *     most redundant, since a DOI or `raw` gives the same link and the type is in `fields`.
 *
 *  5. **What is cut is structurally unconfusable from what the parser never claimed.** A prose
 *     field cut by a gate carries its marker, so its own value says so. Past the budget there is
 *     no room for a marker on every field — one per field per entry, repeated over a 200-entry
 *     result, is itself the oversized payload — so those fields are dropped and the entry carries
 *     `typedOmitted`, the character count that says "something here was cut"; an entry WITHOUT
 *     that counter promises that every absent field is one the parser never claimed. `title` is
 *     the single exception that keeps its marker even when nothing fits, for a reason that is not
 *     symmetry: the text renderer falls back to a 120-character slice of `raw` when an entry has
 *     no title, so a dropped title would put document text the budget just refused straight back
 *     into the channel it was refused from — half the feature, reading as though it worked.
 *
 * The planner charges exactly what the tool sends, and the tool must hand these very objects to
 * `structuredContent` *and* render its text from them through {@link renderReferenceLine}, which
 * lives here beside the cost function and is CALLED by it so the two cannot drift (`diffBudget.ts`'
 * rule). Tests pin the accounting against `JSON.stringify` of the planned entries plus the
 * rendered text.
 */
import {
  REFERENCE_FIELDS_BUDGET,
  REFERENCE_MAX_FIELD_NAME_LENGTH,
  REFERENCE_MAX_FIELD_VALUE_LENGTH,
} from './referenceFieldsBudget.js';
import { cutTo, rawElisionMarker } from './referenceRawBudget.js';

/**
 * Total character budget for every parsed field in one result, charged across the JSON encoding
 * and the rendered text together.
 *
 * Deliberately the `fields` budget itself rather than a number of its own — see decision 3 in the
 * header. One house figure (`CONFLICT_CONTENT_BUDGET`, `FLOATS_CONTENT_BUDGET`,
 * `SEARCH_CONTENT_BUDGET`, `REFERENCE_FIELDS_BUDGET`), one place to change it, three allocations
 * of it because the three payloads are separately load-bearing.
 */
export const REFERENCE_TYPED_BUDGET = REFERENCE_FIELDS_BUDGET;

/**
 * A prose-shaped value (a `title`, a `venue`, one author name) longer than this is cut to a marked
 * prefix; an identifier longer than this is dropped whole.
 *
 * `REFERENCE_MAX_FIELD_VALUE_LENGTH`, imported rather than re-invented, and for a reason stronger
 * than economy: a `title` **is** the value of the `title` field, the same bytes the `fields`
 * planner gates at 2000, so judging it by a second figure would mean one string is measured
 * differently depending on which key it arrives under.
 */
export const REFERENCE_MAX_TYPED_VALUE_LENGTH = REFERENCE_MAX_FIELD_VALUE_LENGTH;

/**
 * A `key` or `label` longer than this is dropped whole (never truncated — see decision 1).
 *
 * `REFERENCE_MAX_FIELD_NAME_LENGTH` (200), imported for the same structural reason: a cite key
 * sits where a field name sits — a short, machine-facing name in a key position — so it is gated
 * by the same figure. It is enormous for a cite key, which is the point: the gate bounds what a
 * malformed or hostile bibliography can put in an identity slot, it does not police naming.
 */
export const REFERENCE_MAX_IDENTITY_LENGTH = REFERENCE_MAX_FIELD_NAME_LENGTH;

/**
 * Hard ceiling on author names returned per entry — `capList`'s house value of 20.
 *
 * "First 20 of 214 authors" is a complete answer for a citation list, and the 214 is reported in
 * `authorsOmitted` rather than implied. The cut is a TAIL in the document's own order, so the
 * first author — the one a citation is spoken by — is always among those kept.
 */
export const REFERENCE_MAX_AUTHORS = 20;

/**
 * The marker appended to a cut prose value. The `raw` budget's marker, imported rather than
 * restated, so a caller who has learned one elision shape has learned all of them.
 *
 * It is appended INLINE here, where `referenceRawBudget.ts` puts it on its own line: a newline
 * belongs inside a multi-line BibTeX entry and does not belong inside a title.
 */
export const typedElisionMarker = rawElisionMarker;

/** What `,"authors":[]` costs once encoded: charged on every entry, since `authors` is required. */
export const AUTHORS_PROPERTY_JSON_OVERHEAD = 13;

/** What a `typedOmitted` count costs beyond its digits: `,` + `"typedOmitted"` + `:`. */
export const TYPED_OMITTED_JSON_OVERHEAD = 16;

/** What an `authorsOmitted` count costs beyond its digits: `,` + `"authorsOmitted"` + `:`. */
export const AUTHORS_OMITTED_JSON_OVERHEAD = 18;

/**
 * The worst one marker can cost once JSON-encoded, computed from the marker itself so it cannot
 * drift away from it. `Number.MAX_SAFE_INTEGER` bounds the digit count for any string a runtime
 * can hold.
 */
export const MAX_TYPED_MARKER_COST = JSON.stringify(
  typedElisionMarker(Number.MAX_SAFE_INTEGER),
).length;

/**
 * The most an entry's two per-entry counters can cost beyond the budget, in both channels: both
 * JSON overheads, both digit runs, and the ` (+N more)` the text renderer adds for
 * `authorsOmitted`. They are emitted even when the pool is gone — a cut nobody can see is the one
 * thing this module may not produce — so this is the documented, bounded overspend, the analogue
 * of `referenceRawBudget.ts`'s marker-only charge.
 */
export const MAX_ENTRY_COUNTER_COST =
  TYPED_OMITTED_JSON_OVERHEAD +
  AUTHORS_OMITTED_JSON_OVERHEAD +
  2 * String(Number.MAX_SAFE_INTEGER).length +
  ' (+ more)'.length +
  String(Number.MAX_SAFE_INTEGER).length;

/** How a field is cut when it does not fit. See decision 1. */
export type TypedFieldKind = 'identity' | 'prose' | 'identifier' | 'authors';

/** A step of {@link ALLOCATION_ORDER}: which field, how it is cut, and what it does past the pool. */
export interface TypedAllocationStep {
  field: 'key' | 'label' | 'title' | 'authors' | 'doi' | 'arxivId' | 'venue' | 'url' | 'type';
  kind: TypedFieldKind;
  /**
   * True for the one field that keeps a marker rather than vanishing when the pool is exhausted.
   * Only `title` sets it, and not for symmetry — see decision 5.
   */
  markerWhenExhausted?: boolean;
}

/**
 * The priority the shared pool is spent in, pass by pass over the whole result — NOT the order the
 * fields are declared in. See decision 4 for why each rank earns its place; changing this order
 * changes which field a long bibliography loses first, which is the whole behaviour of the module.
 */
export const ALLOCATION_ORDER: readonly TypedAllocationStep[] = [
  { field: 'key', kind: 'identity' },
  { field: 'label', kind: 'identity' },
  { field: 'title', kind: 'prose', markerWhenExhausted: true },
  { field: 'authors', kind: 'authors' },
  { field: 'doi', kind: 'identifier' },
  { field: 'arxivId', kind: 'identifier' },
  { field: 'venue', kind: 'prose' },
  { field: 'url', kind: 'identifier' },
  { field: 'type', kind: 'identifier' },
];

/**
 * Anything carrying the parser's typed fields. Structural, so this stays a pure planner: the tool
 * passes `ReferenceEntry & { path }`, and the planner never needs to know that.
 */
export interface TypedBearing {
  key?: string;
  label?: string;
  type?: string;
  title?: string;
  authors: string[];
  truncatedAuthors?: boolean;
  year?: number;
  venue?: string;
  doi?: string;
  url?: string;
  arxivId?: string;
  format?: string;
  path?: string;
  line?: number;
  raw?: string;
}

/** An entry as it will be sent: its planned fields, plus what was left out of them. */
export type TypedBudgetedEntry<E> = E & {
  /** Characters of parsed-field text missing from this entry, author names included. */
  typedOmitted?: number;
  /** Author names not returned, by the element cap or by the budget. */
  authorsOmitted?: number;
};

export interface ReferenceTypedPlan<E> {
  /** The entries in the order given, each with its planned fields — never reordered. */
  entries: Array<TypedBudgetedEntry<E>>;
  /** Prose-shaped values cut to a marked prefix by the per-value gate. */
  truncatedOversize: number;
  /** Identity/identifier values dropped whole by a length gate (never truncated). */
  omittedOversize: number;
  /** Values dropped because the shared rendered-size budget was exhausted. */
  omittedBySize: number;
  /** Author names dropped by {@link REFERENCE_MAX_AUTHORS}. */
  authorsOmittedByCap: number;
  /** Author names dropped because the shared budget was exhausted. */
  authorsOmittedBySize: number;
  /** Characters of parsed-field text missing from the result in total, across every cut. */
  charactersOmitted: number;
  /** Present only when something was actually cut; names only the bound(s) that fired. */
  note?: string;
}

export interface ReferenceTypedOptions {
  budget?: number;
  maxValueLength?: number;
  maxIdentityLength?: number;
  maxAuthors?: number;
}

/** The prose value as it will be sent: the kept prefix, then the marker, inline. */
function withMarker(kept: string, omitted: number): string {
  return `${kept}${typedElisionMarker(omitted)}`;
}

/** What adding one string property costs once encoded: `,` + `"name"` + `:` + the value. */
function propertyCost(name: string, value: string): number {
  return 2 + JSON.stringify(name).length + JSON.stringify(value).length;
}

/**
 * What one entry looks like in the result's TEXT channel — moved here from the tool so the cost
 * function can call it (decision 3 of the payload-budget family: put the render template beside
 * the cost function, or the two drift). `list_references` renders its body with this, from the
 * already-cut entries, so the channel that was supposed to be trimmed cannot reintroduce the
 * payload the budget just refused.
 *
 * Deliberately tolerant of a partially-planned entry, because the planner renders one mid-flight
 * to price each admission.
 */
export function renderReferenceLine(entry: TypedBudgetedEntry<TypedBearing>): string {
  const id = entry.key ?? (entry.label ? `[${entry.label}]` : '—');
  const names = entry.authors.length ? entry.authors.join(', ') : '';
  // A budget cut says so in the prose channel too: without it a caller reading only the text sees
  // twenty authors and no sign that 194 more were not sent.
  const more = entry.authorsOmitted ? `${names ? ' ' : ''}(+${entry.authorsOmitted} more)` : '';
  const authors =
    names || more
      ? `${names}${more}${entry.truncatedAuthors ? ' et al.' : ''}`
      : entry.format === 'prose'
        ? '(authors not split out — see raw)'
        : '(no author field)';
  const where = [entry.venue, entry.year].filter(Boolean).join(' ');
  // The `raw` fallback fires only for an entry the parser gave no title; a title the BUDGET cut
  // keeps its marker precisely so this cannot hand back text the budget refused (decision 5).
  const title = entry.title ?? (entry.raw ?? '').slice(0, 120);
  return (
    `${id} — ${title}\n  ${authors}${where ? ` — ${where}` : ''}\n` +
    `  ${entry.path}:${entry.line} (${entry.format})`
  );
}

/** Per-entry bookkeeping while the passes run. */
interface Slot<E> {
  source: E;
  out: TypedBudgetedEntry<E>;
  /** A writable view of `out`: the planner adds and removes typed keys by name. */
  bag: Record<string, unknown>;
  omitted: number;
  authorsOmitted: number;
}

/**
 * Plan which parsed fields, and how much of each, fit in the returned payload.
 *
 * The pool is spent in {@link ALLOCATION_ORDER}, one field at a time across every entry, and
 * within a pass the entries in the order given. **Nothing is reordered and no entry is preferred
 * over another by size**: a caller reads the list as "the bibliography's entries", and a list
 * cherry-picked by size is a different answer to the question asked.
 *
 * Exhaustion is sticky, as it is in `referenceFieldsBudget.ts`, `referenceRawBudget.ts` and
 * `inlineBudget.ts` — and priority passes give it a shape those two do not have: since the passes
 * run cheapest-to-lose last, an exhausted pool means every LOWER-PRIORITY field of every entry is
 * cut, rather than a hole in the middle of one. A caller can describe the result ("no URLs past
 * entry 60") instead of discovering it.
 *
 * Two charges can carry the accounting past the budget, both bounded and deliberate: a `title` cut
 * to nothing still sends its marker ({@link MAX_TYPED_MARKER_COST}), and an entry that lost
 * something still sends its counters ({@link MAX_ENTRY_COUNTER_COST}). Both are the price of never
 * making a cut invisible, and both are charged into the running total so it stays honest where it
 * exceeds the budget.
 */
export function planReferenceTyped<E extends TypedBearing>(
  entries: readonly E[],
  opts: ReferenceTypedOptions = {},
): ReferenceTypedPlan<E> {
  const budget = opts.budget ?? REFERENCE_TYPED_BUDGET;
  const maxValueLength = opts.maxValueLength ?? REFERENCE_MAX_TYPED_VALUE_LENGTH;
  const maxIdentityLength = opts.maxIdentityLength ?? REFERENCE_MAX_IDENTITY_LENGTH;
  const maxAuthors = opts.maxAuthors ?? REFERENCE_MAX_AUTHORS;

  let used = 0;
  let exhausted = false;
  let truncatedOversize = 0;
  let omittedOversize = 0;
  let omittedBySize = 0;
  let authorsOmittedByCap = 0;
  let authorsOmittedBySize = 0;
  let charactersOmitted = 0;

  // Every typed key is stripped first and put back only by the pass that can afford it, so a field
  // is never sent because nobody got round to removing it.
  const slots: Array<Slot<E>> = entries.map((source) => {
    const out = { ...source } as TypedBudgetedEntry<E>;
    const bag = out as unknown as Record<string, unknown>;
    for (const step of ALLOCATION_ORDER) delete bag[step.field];
    bag.authors = [];
    // `authors` is a required property, so its wrapper is owed by every entry whatever it holds.
    used += AUTHORS_PROPERTY_JSON_OVERHEAD;
    return { source, out, bag, omitted: 0, authorsOmitted: 0 };
  });

  /**
   * The entry as the text renderer sees it. A generic `E` is not assignable to its own constraint
   * through an intersection, so the view is taken off the writable bag — the same object.
   */
  const view = (slot: Slot<E>): TypedBudgetedEntry<TypedBearing> =>
    slot.bag as unknown as TypedBudgetedEntry<TypedBearing>;

  /** Price one admission in both channels: the JSON property and the rendered line it changes. */
  const admit = (slot: Slot<E>, name: string, value: string): boolean => {
    const before = renderReferenceLine(view(slot));
    slot.bag[name] = value;
    const after = renderReferenceLine(view(slot));
    // Clamped: a title replacing the `raw` fallback can SHORTEN the line, and a negative charge
    // would pay for one field with another's savings.
    const cost = propertyCost(name, value) + Math.max(0, after.length - before.length);
    if (used + cost > budget) {
      delete slot.bag[name];
      return false;
    }
    used += cost;
    return true;
  };

  for (const step of ALLOCATION_ORDER) {
    for (const slot of slots) {
      if (step.kind === 'authors') {
        planAuthors(slot);
        continue;
      }
      const value = slot.source[step.field] as string | undefined;
      if (value === undefined || value === '') continue;

      if (step.kind === 'identity') {
        if (value.length > maxIdentityLength) {
          // Dropped, not cut: a truncated cite key is a key that does not exist.
          omittedOversize++;
          charactersOmitted += value.length;
          slot.omitted += value.length;
          continue;
        }
        // Charged in both channels but never refused — no other entry's text may cost this one
        // its name.
        const before = renderReferenceLine(view(slot));
        slot.bag[step.field] = value;
        const after = renderReferenceLine(view(slot));
        used += propertyCost(step.field, value) + Math.max(0, after.length - before.length);
        continue;
      }

      if (step.kind === 'identifier') {
        if (value.length > maxValueLength) {
          omittedOversize++;
          charactersOmitted += value.length;
          slot.omitted += value.length;
          continue;
        }
        if (exhausted || !admit(slot, step.field, value)) {
          exhausted = true;
          omittedBySize++;
          charactersOmitted += value.length;
          slot.omitted += value.length;
        }
        continue;
      }

      // Prose-shaped: truncate and mark, never drop — except past the pool, where only `title`
      // can afford the marker (decision 5).
      const kept = exhausted ? '' : cutTo(value, maxValueLength);
      const omitted = value.length - kept.length;
      if (omitted === 0) {
        if (!admit(slot, step.field, kept)) {
          exhausted = true;
          omittedBySize++;
          charactersOmitted += value.length;
          slot.omitted += value.length;
        }
        continue;
      }
      const marked = withMarker(kept, omitted);
      const fits = !exhausted && admit(slot, step.field, marked);
      if (fits) {
        truncatedOversize++;
      } else {
        exhausted = true;
        omittedBySize++;
        if (step.markerWhenExhausted) {
          // Marker-only, charged although the pool is gone: this is the documented overspend.
          const marker = withMarker('', value.length);
          slot.bag[step.field] = marker;
          used += propertyCost(step.field, marker);
        }
      }
      charactersOmitted += omitted;
      slot.omitted += omitted;
    }
  }

  function planAuthors(slot: Slot<E>): void {
    const source = slot.source.authors ?? [];
    const kept: string[] = [];
    slot.bag.authors = kept;
    for (const name of source) {
      if (kept.length >= maxAuthors) {
        authorsOmittedByCap++;
        charactersOmitted += name.length;
        slot.omitted += name.length;
        continue;
      }
      if (exhausted) {
        authorsOmittedBySize++;
        charactersOmitted += name.length;
        slot.omitted += name.length;
        continue;
      }
      const cut = cutTo(name, maxValueLength);
      const omitted = name.length - cut.length;
      const value = omitted > 0 ? withMarker(cut, omitted) : cut;
      const before = renderReferenceLine(view(slot));
      kept.push(value);
      const after = renderReferenceLine(view(slot));
      // One element: its encoded self plus the comma that joins it to the previous one. The first
      // element has no comma, so this over-charges by one character per entry — the direction an
      // accounting has to err in.
      const cost = JSON.stringify(value).length + 1 + Math.max(0, after.length - before.length);
      if (used + cost > budget) {
        kept.pop();
        exhausted = true;
        authorsOmittedBySize++;
        charactersOmitted += name.length;
        slot.omitted += name.length;
        continue;
      }
      used += cost;
      if (omitted > 0) {
        truncatedOversize++;
        charactersOmitted += omitted;
        slot.omitted += omitted;
      }
    }
    slot.authorsOmitted = source.length - kept.length;
  }

  for (const slot of slots) {
    if (slot.authorsOmitted > 0) {
      slot.out.authorsOmitted = slot.authorsOmitted;
      used += AUTHORS_OMITTED_JSON_OVERHEAD + String(slot.authorsOmitted).length;
    }
    if (slot.omitted > 0) {
      slot.out.typedOmitted = slot.omitted;
      used += TYPED_OMITTED_JSON_OVERHEAD + String(slot.omitted).length;
    }
  }

  const plan: ReferenceTypedPlan<E> = {
    entries: slots.map((s) => s.out),
    truncatedOversize,
    omittedOversize,
    omittedBySize,
    authorsOmittedByCap,
    authorsOmittedBySize,
    charactersOmitted,
  };
  const note = describe(plan, {
    total: entries.length,
    budget,
    maxValueLength,
    maxIdentityLength,
    maxAuthors,
  });
  if (note) plan.note = note;
  return plan;
}

/**
 * The `note`, naming ONLY the bounds that actually fired — reporting a cap that did not fire sends
 * the reader looking for a cause that is not there (`conflictBudget.ts`'s rule). All four can fire
 * on one result: they are independent events.
 *
 * Every part ends at the same place, because it is the same remedy — and it is stated with the one
 * qualification #147 made necessary: the entry's own `raw` has the text, UNLESS `rawOmitted` says
 * that was cut too, in which case the file at `path`:`line` is the only whole copy.
 */
function describe<E>(
  plan: ReferenceTypedPlan<E>,
  ctx: {
    total: number;
    budget: number;
    maxValueLength: number;
    maxIdentityLength: number;
    maxAuthors: number;
  },
): string | undefined {
  const parts: string[] = [];
  if (plan.truncatedOversize > 0) {
    parts.push(
      `${plan.truncatedOversize} parsed value(s) of the ${ctx.total} entry/entries returned were ` +
        `cut to the first ${ctx.maxValueLength} characters and end in a ` +
        '`… [+N characters omitted]` marker: a title, venue or author name longer than that is a ' +
        'paragraph a heuristic claimed, not a field.',
    );
  }
  if (plan.omittedOversize > 0) {
    parts.push(
      `${plan.omittedOversize} parsed value(s) were dropped whole rather than shortened: a cite ` +
        `key or label over ${ctx.maxIdentityLength} characters, or a DOI, URL, arXiv id or entry ` +
        `type over ${ctx.maxValueLength}. Half an identifier is not a short identifier, it is one ` +
        'that resolves to nothing.',
    );
  }
  if (plan.authorsOmittedByCap > 0) {
    parts.push(
      `${plan.authorsOmittedByCap} author name(s) were omitted: at most ${ctx.maxAuthors} are ` +
        'returned per entry, keeping the first ones the document writes. Per-entry counts are in ' +
        '`authorsOmitted`.',
    );
  }
  if (plan.omittedBySize > 0 || plan.authorsOmittedBySize > 0) {
    parts.push(
      `${plan.omittedBySize} parsed value(s) and ${plan.authorsOmittedBySize} author name(s) were ` +
        `omitted: the ${ctx.budget}-char budget for every parsed field in one result (charged on ` +
        'its JSON-encoded size AND on the text this tool renders from it) was reached, so the ' +
        'later entries carry fewer fields. They are cut in reverse priority — `type` and `url` ' +
        'first, then `venue`, `doi`/`arxivId`, `authors`, and `title` last; `key` and `label` are ' +
        'never cut this way.',
    );
  }
  if (parts.length === 0) return undefined;
  return (
    `${parts.join(' ')} ${plan.charactersOmitted} character(s) of parsed text were omitted in ` +
    'total; an entry that lost any carries `typedOmitted`, and an entry without it has every ' +
    'field the parser claimed. The text is still in that entry’s `raw` — unless its `rawOmitted` ' +
    'says `raw` was cut as well, in which case the file at the entry’s `path`:`line` is the only ' +
    'whole copy. Narrow with `filter` or `path`, or ask for fewer entries: `maxResults`’ default ' +
    'is sized so an ordinary bibliography comes back whole, so a result cut this way usually ' +
    'means it was raised.'
  );
}

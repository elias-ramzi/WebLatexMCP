import { z } from 'zod';
import {
  fieldNameOf,
  isEntryType,
  scanBibtexBlocks,
  splitTopLevelSpans,
  type TextSpan,
} from './references.js';

/**
 * A project's citation field profile (#255): which BibTeX fields its bibliography carries.
 *
 * `add_citation` appends an entry exactly as DBLP, Crossref or DataCite issue it, so one
 * bibliography mixes shapes (Crossref's `publisher`/`month`/`issn`, DBLP's `bibsource`/
 * `timestamp`/`biburl`). A profile names the fields to leave out — `drop`, for every entry — and,
 * per entry type, the only fields to keep — `keep`. `add_citation` applies it to the fetched
 * entry before appending, `check_citations` reports entries that carry a field it would remove,
 * and `apply_citation_profile` removes those fields from entries already in a `.bib` (gated by
 * `confirmBibEdit`, like every other `.bib` change).
 *
 * **A profile only ever removes.** {@link applyProfile} deletes whole `name = value` fields from
 * the original bytes and nothing else: no value is written, reformatted, reordered or completed,
 * so a fetched entry stays exactly as verifiable as before — what is left is the issuing service's
 * own bytes, minus whole fields (`bibtexEntrySpan`'s "a cut is allowed, an insertion is not",
 * `src/services/referenceBackend.ts`). Every change is a deletion of one contiguous run of bytes;
 * `test/unit/citationProfile.test.ts` checks the result is a subsequence of the input.
 *
 * The cite key and entry type are never touched, and a part of an entry body that is not a
 * readable field (no `=`, a name BibTeX would not read) is never removed.
 *
 * `keep` is a list of `{ type, fields }`, not an object keyed by type: a key is a name the caller
 * chose, and zod's `record` mishandles a `__proto__` key (it can come back as the prototype
 * rather than an entry). Names are matched lower-cased, as `parseBibtex` reads them.
 */

/**
 * A BibTeX field name as a profile names it: what `fieldNameOf` reads. Stored as given and
 * compared lower-cased (no zod transform: the schema is also an `outputSchema`, and a transform
 * has no JSON Schema form).
 */
const fieldName = z
  .string()
  .regex(/^[A-Za-z][\w-]{0,63}$/, 'a BibTeX field name (letters, digits, "_" or "-")');

/** A BibTeX entry type as a profile names it: letters only, compared lower-cased. */
const entryTypeName = z.string().regex(/^[A-Za-z]{1,32}$/, 'a BibTeX entry type (letters only)');

/** Fields per list: far more than any entry type defines, small enough to bound the payload. */
export const PROFILE_MAX_FIELDS = 100;
/** Entry types `keep` may name. */
export const PROFILE_MAX_TYPES = 40;

export const citationProfileSchema = z
  .object({
    drop: z
      .array(fieldName)
      .max(PROFILE_MAX_FIELDS)
      .optional()
      .describe(
        'Fields to remove from every entry, e.g. ["publisher", "month", "issn", "bibsource", ' +
          '"timestamp", "biburl"]. Case does not matter.',
      ),
    keep: z
      .array(
        z
          .object({
            type: entryTypeName.describe('Entry type, e.g. "inproceedings".'),
            fields: z
              .array(fieldName)
              .min(1)
              .max(PROFILE_MAX_FIELDS)
              .describe('The only fields an entry of this type keeps.'),
          })
          .strict(),
      )
      .max(PROFILE_MAX_TYPES)
      .optional()
      .describe(
        'Per entry type, the ONLY fields to keep — every other field of an entry of that type ' +
          'is removed, e.g. [{ type: "inproceedings", fields: ["author", "title", "booktitle", ' +
          '"year"] }]. Types not listed keep every field (minus `drop`).',
      ),
  })
  .strict()
  .refine(
    (p) => new Set((p.keep ?? []).map((k) => k.type.toLowerCase())).size === (p.keep ?? []).length,
    'keep names an entry type more than once',
  );

export type CitationProfile = z.infer<typeof citationProfileSchema>;

/** Whether a profile removes nothing at all (no `drop`, no `keep`): the same as no profile. */
export function isEmptyProfile(profile: CitationProfile): boolean {
  return (profile.drop ?? []).length === 0 && (profile.keep ?? []).length === 0;
}

/** The fields of an entry of `type` a profile removes, from `names` (lower-cased), in order. */
export function fieldsRemovedBy(
  profile: CitationProfile,
  type: string,
  names: readonly string[],
): string[] {
  const lower = (names: readonly string[]): Set<string> =>
    new Set(names.map((n) => n.toLowerCase()));
  const drop = lower(profile.drop ?? []);
  const keep = (profile.keep ?? []).find((k) => k.type.toLowerCase() === type.toLowerCase());
  const kept = keep === undefined ? undefined : lower(keep.fields);
  return names.filter((n) => drop.has(n) || (kept !== undefined && !kept.has(n)));
}

/** One entry a profile changed. */
export interface ProfiledEntry {
  /** Cite key, as written. */
  key: string;
  /** Entry type, lower-cased. */
  type: string;
  /** 1-based line the entry starts on, in the text BEFORE the change. */
  line: number;
  /** Fields removed, lower-cased, in the order the entry had them (a repeated field repeats). */
  removed: string[];
}

export interface ProfileResult {
  /** The text with the fields removed; the input itself when nothing was. */
  text: string;
  /** Entries that lost at least one field, in document order. */
  changed: ProfiledEntry[];
}

/** 1-based line of a character offset. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Length of `s` with trailing whitespace removed. */
function trimmedEndLength(s: string): number {
  return s.replace(/\s+$/, '').length;
}

/**
 * The byte ranges to delete from one entry body (`body` = everything between the delimiters),
 * given which of its top-level comma-separated parts to remove. Offsets are into `body`.
 *
 * A removed part goes with the comma AFTER it — `title={T},` — so the layout around it is kept
 * whole: one field per line stays one per line, with no blank line left behind. The exception is
 * a final run of removed parts with no comma after the last one (`…, year={2016}\n}`): those go
 * with the comma BEFORE the run, up to the end of the last part's value, so the entry keeps the
 * whitespace before its closing brace and does not gain a trailing comma it never had. An entry
 * that had one (`year={2016},\n}`) keeps it.
 */
function deletions(body: string, parts: TextSpan[], remove: boolean[]): TextSpan[] {
  // A whitespace-only last part is what follows a trailing comma, never a field.
  const trailingComma = parts.length > 1 && body.slice(parts.at(-1)!.start).trim() === '';
  const last = trailingComma ? parts.length - 2 : parts.length - 1;
  let runStart = last + 1;
  if (!trailingComma) while (runStart - 1 >= 1 && remove[runStart - 1]) runStart--;
  const out: TextSpan[] = [];
  for (let i = 1; i <= last; i++) {
    if (!remove[i]) continue;
    if (i >= runStart) {
      // The final run, as one range: from the comma before it to the end of its last value.
      const lastPart = parts[last]!;
      out.push({
        start: parts[runStart]!.start - 1,
        end: lastPart.start + trimmedEndLength(body.slice(lastPart.start, lastPart.end)),
      });
      break;
    }
    out.push({ start: parts[i]!.start, end: parts[i]!.end + 1 });
  }
  return out;
}

/**
 * Remove from every entry of a BibTeX text the fields `profile` does not want. Pure; `keys`, when
 * given, limits the change to entries with those cite keys. `@string`, `@comment` and `@preamble`
 * blocks are never touched, nor is anything between entries.
 */
export function applyProfile(
  text: string,
  profile: CitationProfile,
  keys?: ReadonlySet<string>,
): ProfileResult {
  if (isEmptyProfile(profile)) return { text, changed: [] };
  const cuts: TextSpan[] = [];
  const changed: ProfiledEntry[] = [];
  for (const block of scanBibtexBlocks(text)) {
    if (!isEntryType(block.type)) continue;
    const bodyStart = block.open + 1;
    const body = text.slice(bodyStart, block.close);
    // Part 0 is the cite key; parts 1… are the fields. An entry with no comma has no fields.
    const parts = splitTopLevelSpans(body, ',');
    const key = body.slice(parts[0]!.start, parts[0]!.end).trim();
    if (parts.length < 2 || key === '' || (keys !== undefined && !keys.has(key))) continue;
    const names = parts.map((p, i) =>
      i === 0 ? undefined : fieldNameOf(body.slice(p.start, p.end)),
    );
    const removedNames = new Set(
      fieldsRemovedBy(
        profile,
        block.type,
        names.filter((n): n is string => n !== undefined),
      ),
    );
    const remove = names.map((n) => n !== undefined && removedNames.has(n));
    if (!remove.some(Boolean)) continue;
    for (const d of deletions(body, parts, remove)) {
      cuts.push({ start: bodyStart + d.start, end: bodyStart + d.end });
    }
    changed.push({
      key,
      type: block.type,
      line: lineOf(text, block.at),
      removed: names.filter((n, i): n is string => remove[i] === true && n !== undefined),
    });
  }
  if (cuts.length === 0) return { text, changed: [] };
  let out = '';
  let from = 0;
  for (const cut of cuts) {
    out += text.slice(from, cut.start);
    from = cut.end;
  }
  out += text.slice(from);
  return { text: out, changed };
}

/** A profile as one line of text: what a tool result says is in effect. */
export function describeProfile(profile: CitationProfile | null): string {
  if (profile === null || isEmptyProfile(profile)) return 'none';
  const parts: string[] = [];
  if ((profile.drop ?? []).length > 0) parts.push(`drop ${profile.drop!.join(', ')}`);
  for (const k of profile.keep ?? []) parts.push(`@${k.type} keeps only ${k.fields.join(', ')}`);
  return parts.join('; ');
}

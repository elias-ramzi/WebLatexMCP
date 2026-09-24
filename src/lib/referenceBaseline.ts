import type { ReferenceFormat } from './references.js';

/** What `wholeSources` needs of a returned entry: where it came from, what it carries, and cuts. */
export interface ShippedEntry {
  path: string;
  format: ReferenceFormat;
  raw: string;
  fieldsOmitted?: number;
  rawOmitted?: number;
  typedOmitted?: number;
  authorsOmitted?: number;
}

/**
 * ASCII whitespace only. The one kind of text outside an entry a file may carry and still count as
 * received whole — deliberately narrower than `\s`, whose Unicode spaces (a BOM, a no-break space)
 * are bytes a caller cannot see in a returned `raw` and so has not been shown.
 */
function isAsciiSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

/**
 * Whether `raws`, in order, separated only by whitespace, are the whole of `text` — i.e. the
 * caller who received those entries' verbatim text received every non-whitespace byte of the file.
 * Exact and anchored: each `raw` must start precisely where the previous one (plus whitespace)
 * ended, so an entry found out of order, or any byte between two entries, fails it.
 */
export function rawsCoverText(text: string, raws: readonly string[]): boolean {
  let at = 0;
  const skip = (): void => {
    while (at < text.length && isAsciiSpace(text[at]!)) at++;
  };
  skip();
  for (const raw of raws) {
    if (raw.length === 0 || !text.startsWith(raw, at)) return false;
    at += raw.length;
    skip();
  }
  return at === text.length;
}

/**
 * The files the caller genuinely received in full — the only ones `list_references` may claim the
 * out-of-band-edit baseline for (issues #171, and the entries-versus-bytes gap after it).
 *
 * The licence `FileService.read` grants is "the caller asked for this file and received ALL of
 * it". `list_references` returns ENTRIES, so a file qualifies only when its entries ARE the file:
 *
 * - every entry it contributed reached the result — nothing lost to `filter` or `maxResults` (the
 *   count must match `sources[].count`, which is taken before either applies);
 * - not one of those entries carries a cut counter from any of the three budgets (#147, #165);
 * - every entry is `bibtex` — a `\bibitem` or prose entry is a slice of a larger document (a whole
 *   paper around a `thebibliography`, a whole draft around a reference list), and its `raw` is
 *   trimmed or whitespace-collapsed besides, so it is never the file's bytes;
 * - and the returned `raw`s, in order, cover the file's text apart from whitespace. A `.bib`'s
 *   `@string`/`@preamble`/`@comment` blocks and `%` comments are never returned as entries, so a
 *   hand edit to one of them is text the caller never saw.
 *
 * Each clause only narrows, which is the direction this has to err in: not recording costs the
 * caller one refusal they can override, while recording wrongly RESETS the guard for a file the
 * user is editing by hand and the next blind write destroys that edit. A hand edit that changes
 * only whitespace between two entries is not detected — the one accepted gap, since whitespace
 * there carries nothing a write could lose.
 *
 * `texts` holds the exact bytes each source was parsed from; a source with no text is never
 * claimed.
 */
export function wholeSources(
  sources: ReadonlyArray<{ path: string; count: number }>,
  entries: readonly ShippedEntry[],
  texts: ReadonlyMap<string, string>,
): string[] {
  const byPath = new Map<string, ShippedEntry[]>();
  const disqualified = new Set<string>();
  for (const entry of entries) {
    const cut =
      entry.rawOmitted !== undefined ||
      entry.fieldsOmitted !== undefined ||
      entry.typedOmitted !== undefined ||
      entry.authorsOmitted !== undefined;
    if (cut || entry.format !== 'bibtex') disqualified.add(entry.path);
    const list = byPath.get(entry.path) ?? [];
    list.push(entry);
    byPath.set(entry.path, list);
  }
  return sources
    .filter((s) => {
      if (disqualified.has(s.path)) return false;
      const shipped = byPath.get(s.path) ?? [];
      if (shipped.length !== s.count) return false;
      const text = texts.get(s.path);
      if (text === undefined) return false;
      return rawsCoverText(
        text,
        shipped.map((e) => e.raw),
      );
    })
    .map((s) => s.path);
}

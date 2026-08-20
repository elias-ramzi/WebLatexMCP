import path from 'node:path';

/**
 * Parsing references out of a document, whatever shape they were written in.
 *
 * A bibliography is not always a `.bib`. A EuroHPC proposal in markdown, a paper with an inline
 * `thebibliography` environment, and an Overleaf project with a `ref.bib` all carry the same thing —
 * a list of works, each with a title, some authors, a venue and a year — but only the last one can be
 * read with a BibTeX parser. Verification (against DBLP) is identical in all three cases, so the
 * parsing is what has to bend.
 *
 * Three formats, in descending order of how much the extracted fields can be trusted:
 *
 * - `bibtex`   — a real grammar, so the fields are exact. `@string` macros are resolved.
 * - `bibitem`  — `\bibitem{key} <free text>`: the key is exact, the rest is prose.
 * - `prose`    — a markdown/plain-text reference list: everything is a heuristic.
 *
 * Every entry therefore carries its `raw` text verbatim alongside the parsed fields, and its
 * `format`, so a caller knows whether a missing `title` means "the entry has no title" or "this one
 * was too free-form to split up". Never present a `prose` field as authoritative.
 */

export type ReferenceFormat = 'bibtex' | 'bibitem' | 'prose';

export interface ReferenceEntry {
  /** Cite key — exact for `bibtex`/`bibitem`. Absent for prose entries, which are numbered instead. */
  key?: string;
  /** How a prose list refers to the entry ("1", "12", "Smith20"), when it is numbered/labelled. */
  label?: string;
  format: ReferenceFormat;
  /** BibTeX entry type (`article`, `inproceedings`, …). Only for `bibtex`. */
  type?: string;
  title?: string;
  /** Author names, normalized to "First Last". Empty when the format did not let them be split out. */
  authors: string[];
  /**
   * The author list is abbreviated — BibTeX `and others`, or a literal "et al.". The rendered
   * citation will not name everyone, which is a defect worth surfacing on its own.
   */
  truncatedAuthors: boolean;
  year?: number;
  /** Conference or journal: `booktitle`/`journal`/`series`/`publisher`/`howpublished`, or a guess. */
  venue?: string;
  doi?: string;
  url?: string;
  /** arXiv identifier (e.g. "2001.10773") when the entry names one. */
  arxivId?: string;
  /** 1-based line where the entry starts. */
  line: number;
  /** The entry exactly as written. The ground truth whenever a parsed field looks doubtful. */
  raw: string;
  /** Raw BibTeX fields, lowercased names, macro-expanded values. Only for `bibtex`. */
  fields?: Record<string, string>;
}

/** One place a document cites a key. */
export interface CitationUse {
  key: string;
  line: number;
  /** The command that produced it: a LaTeX macro name (`citep`) or `@` for pandoc-style markdown. */
  command: string;
}

const NON_ENTRY_TYPES = new Set(['string', 'comment', 'preamble']);
const CLOSING: Record<string, string> = { '{': '}', '(': ')' };

/** Extensions whose content is prose with a reference list rather than LaTeX or BibTeX. */
const DOC_EXT = new Set(['.md', '.markdown', '.txt', '.rst', '.org']);

/** Whether a path looks like a prose document (markdown/plain text) rather than LaTeX source. */
export function isProseDocument(relPath: string): boolean {
  return DOC_EXT.has(path.extname(relPath).toLowerCase());
}

/** 1-based line number of a character offset. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/**
 * Index of the delimiter closing the one at `open`, or -1 when unbalanced. Braces nest; a `"` only
 * quotes at depth 0, which is where BibTeX uses it as a field delimiter.
 */
function matchDelimiter(text: string, open: number): number {
  const opener = text[open]!;
  const closer = CLOSING[opener]!;
  let depth = 0;
  let inQuote = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (inQuote) {
      if (ch === '"') inQuote = false;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
      continue;
    }
    if (ch === '"' && depth === 1) inQuote = true;
    else if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return i;
    } else if (opener !== '{' && (ch === '{' || ch === '}')) {
      // `@article( … )` still uses braces around values; track them so a `)` inside one is ignored.
      depth += ch === '{' ? 1 : -1;
    }
  }
  return -1;
}

/** Split on a separator that only counts at brace depth 0 and outside quotes. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '"' && depth === 0) inQuote = !inQuote;
    else if (ch === separator && depth === 0 && !inQuote) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Turn a BibTeX value into readable text: resolve `#`-concatenation and `@string` macros, drop the
 * capitalization braces, and undo the escapes and accent commands that would otherwise leak into a
 * comparison against a plain-text database record.
 */
function evaluateValue(raw: string, macros: Map<string, string>): string {
  const pieces = splitTopLevel(raw, '#').map((piece) => {
    const part = piece.trim();
    if (part.startsWith('{') && part.endsWith('}')) return part.slice(1, -1);
    if (part.startsWith('"') && part.endsWith('"')) return part.slice(1, -1);
    const macro = macros.get(part.toLowerCase());
    return macro ?? part;
  });
  return cleanTeX(pieces.join(''));
}

/** Strip the LaTeX a bibliography value carries, leaving text comparable to a database record. */
export function cleanTeX(value: string): string {
  return (
    value
      // \'{e} / \'e / \"{o} / \c{c} — keep the letter, drop the accent command.
      .replace(/\\[`'^"~=.]\s*\{?\s*(\w)\s*\}?/g, '$1')
      .replace(/\\[a-zA-Z]+\s*\{\s*(\w)\s*\}/g, '$1')
      .replace(/\\&/g, '&')
      .replace(/\\([%$#_])/g, '$1')
      // Formatting commands (\emph, \textbf, \url…) survive the passes above; drop the command
      // and keep its argument, which is the text a database record would hold.
      .replace(/\\[a-zA-Z]+\s*/g, '')
      .replace(/[{}]/g, '')
      .replace(/\$([^$]*)\$/g, '$1')
      .replace(/~/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Author names as written, normalized from BibTeX's "Last, First" to "First Last" — the form DBLP
 * returns, so the two lists can be compared directly. The value has already been de-braced by
 * `evaluateValue`, so a braced corporate name (`{Barnes and Noble}`) splits like two authors; the
 * entry's `raw` text is the fallback when that matters.
 */
function splitBibAuthors(value: string): { authors: string[]; truncated: boolean } {
  const parts = value
    .split(/\s+and\s+/i)
    .map((a) => cleanTeX(a))
    .filter((a) => a.length > 0);
  let truncated = false;
  const authors: string[] = [];
  for (const part of parts) {
    if (/^(others|et\.?\s*al\.?)$/i.test(part)) {
      truncated = true;
      continue;
    }
    const comma = part.indexOf(',');
    if (comma !== -1) {
      const last = part.slice(0, comma).trim();
      const rest = part.slice(comma + 1).trim();
      authors.push(rest ? `${rest} ${last}` : last);
    } else {
      authors.push(part);
    }
  }
  return { authors, truncated };
}

const VENUE_FIELDS = [
  'booktitle',
  'journal',
  'journaltitle',
  'series',
  'publisher',
  'howpublished',
];

/** Parse `name = value` pairs from an entry body (everything after the cite key). */
function parseFields(body: string, macros: Map<string, string>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const chunk of splitTopLevel(body, ',')) {
    const eq = chunk.indexOf('=');
    if (eq === -1) continue;
    const name = chunk.slice(0, eq).trim().toLowerCase();
    if (!/^[a-z][\w-]*$/.test(name)) continue;
    fields[name] = evaluateValue(chunk.slice(eq + 1), macros);
  }
  return fields;
}

/**
 * Parse a BibTeX database. Tolerant by design: a malformed entry is skipped rather than aborting the
 * file, because the point is to report on a bibliography, not to validate its syntax.
 */
export function parseBibtex(text: string): ReferenceEntry[] {
  const entries: ReferenceEntry[] = [];
  const macros = new Map<string, string>();
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('@', i);
    if (at === -1) break;
    const header = /^@\s*([A-Za-z]+)\s*[{(]/.exec(text.slice(at));
    if (!header) {
      i = at + 1;
      continue;
    }
    const open = at + header[0].length - 1;
    const close = matchDelimiter(text, open);
    if (close === -1) break;
    const type = header[1]!.toLowerCase();
    const body = text.slice(open + 1, close);

    if (type === 'string') {
      const eq = body.indexOf('=');
      if (eq !== -1) {
        const name = body.slice(0, eq).trim().toLowerCase();
        if (name) macros.set(name, evaluateValue(body.slice(eq + 1), macros));
      }
    } else if (!NON_ENTRY_TYPES.has(type)) {
      const comma = body.indexOf(',');
      const key = (comma === -1 ? body : body.slice(0, comma)).trim();
      if (key) {
        const fields = comma === -1 ? {} : parseFields(body.slice(comma + 1), macros);
        const { authors, truncated } = splitBibAuthors(fields.author ?? fields.editor ?? '');
        const year = /(\d{4})/.exec(fields.year ?? fields.date ?? '')?.[1];
        entries.push({
          key,
          format: 'bibtex',
          type,
          title: fields.title || undefined,
          authors,
          truncatedAuthors: truncated,
          year: year ? Number(year) : undefined,
          venue: VENUE_FIELDS.map((f) => fields[f]).find((v) => v) || undefined,
          doi: fields.doi || undefined,
          url: fields.url || undefined,
          arxivId: arxivIdIn(`${fields.eprint ?? ''} ${fields.journal ?? ''} ${fields.url ?? ''}`),
          line: lineAt(text, at),
          raw: text.slice(at, close + 1),
          fields,
        });
      }
    }
    i = close + 1;
  }
  return entries;
}

/**
 * Parse `\bibitem` entries from a LaTeX `thebibliography` environment — the bibliography of a paper
 * that never had a `.bib`. The key is exact; the description is free text, so its fields go through
 * the same best-effort extraction as a prose list.
 */
export function parseBibitems(text: string): ReferenceEntry[] {
  const entries: ReferenceEntry[] = [];
  const re = /\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
  const matches = [...text.matchAll(re)];
  matches.forEach((m, idx) => {
    const start = m.index!;
    const bodyStart = start + m[0].length;
    const nextItem = matches[idx + 1]?.index ?? text.length;
    const envEnd = text.indexOf('\\end{thebibliography}', bodyStart);
    const end = envEnd !== -1 && envEnd < nextItem ? envEnd : nextItem;
    const description = cleanTeX(text.slice(bodyStart, end));
    entries.push({
      key: m[1]!.trim(),
      format: 'bibitem',
      ...describeFreeText(description),
      line: lineAt(text, start),
      raw: text.slice(start, end).trim(),
    });
  });
  return entries;
}

const HEADING_RE =
  /^(?:#{1,6}\s*|\**\s*)(?:\d+\.?\s*)?(references|bibliography|works\s+cited|literature\s+cited)\b.*$/i;
const ITEM_RE = /^\s*(?:[-*+•]|\[([^\]\s]+)\]|(\d+)[.)])\s+(.*)$/;
const YEAR_SIGNAL = /(?:\b(?:19|20)\d{2}\b|10\.\d{4,9}\/|https?:\/\/|arxiv)/i;

/**
 * Parse a reference list out of prose — a markdown or plain-text document. Everything here is a
 * heuristic, so it errs towards under-claiming: a field is only filled in when the text delimits it
 * unambiguously, and `raw` always carries the entry as written.
 *
 * When the document has a "References"/"Bibliography" heading, only that section is read and every
 * list item in it counts. Without one the whole file is scanned, and an item is only taken for a
 * reference when it carries a year, a DOI, a URL or an arXiv id — otherwise every bullet in the
 * document would come back as a citation.
 */
export function parseProseReferences(text: string): ReferenceEntry[] {
  const lines = text.split('\n');
  const headingIdx = lines.findIndex((l) => HEADING_RE.test(l.trim()));
  const scoped = headingIdx !== -1;
  const start = scoped ? headingIdx + 1 : 0;
  const end = scoped ? sectionEnd(lines, headingIdx) : lines.length;

  const entries: ReferenceEntry[] = [];
  let current: { lines: string[]; label?: string; line: number } | null = null;
  const flush = (): void => {
    if (!current) return;
    const raw = current.lines.join(' ').replace(/\s+/g, ' ').trim();
    const body = current.lines.join('\n').trim();
    if (raw && (scoped || YEAR_SIGNAL.test(raw))) {
      entries.push({
        label: current.label,
        format: 'prose',
        ...describeFreeText(raw),
        line: current.line,
        raw: body,
      });
    }
    current = null;
  };

  for (let i = start; i < end; i++) {
    const line = lines[i]!;
    const item = ITEM_RE.exec(line);
    if (item) {
      flush();
      current = { lines: [item[3]!], label: item[1] ?? item[2], line: i + 1 };
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (current) current.lines.push(line.trim());
    else if (scoped) current = { lines: [line.trim()], line: i + 1 };
  }
  flush();
  return entries;
}

/** Where a markdown section ends: the next heading at any level, or the end of the document. */
function sectionEnd(lines: string[], headingIdx: number): number {
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{1,6}\s+\S/.test(lines[i]!)) return i;
  }
  return lines.length;
}

const QUOTED_TITLE_RE = /["“«]([^"”»]{6,})["”»]|(?:^|\s)\*\*?([^*]{6,})\*\*?(?:\s|[.,]|$)/;
const PAREN_YEAR_RE = /\((\d{4})[a-z]?\)/;
const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>,;)\]]+)/i;
const URL_RE = /\bhttps?:\/\/[^\s<>)\]]+/i;
const ARXIV_RE = /arxiv[:\s/]*((?:\d{4}\.\d{4,5})(?:v\d+)?|[a-z-]+\/\d{7})/i;

function arxivIdIn(text: string): string | undefined {
  return ARXIV_RE.exec(text)?.[1];
}

/**
 * Best-effort fields for a free-text reference. Only what the text marks out explicitly is claimed:
 * a quoted or emphasized title, authors preceding a parenthesized year, and identifiers that have
 * unambiguous syntax. Anything else stays undefined rather than guessed — a wrong "title" sends the
 * DBLP lookup after the wrong paper, which is worse than no title at all.
 */
function describeFreeText(text: string): Omit<ReferenceEntry, 'format' | 'line' | 'raw'> {
  const flat = text.replace(/\s+/g, ' ').trim();
  const titleMatch = QUOTED_TITLE_RE.exec(flat);
  const title = (titleMatch?.[1] ?? titleMatch?.[2])?.replace(/[.,;]\s*$/, '').trim();

  const parenYear = PAREN_YEAR_RE.exec(flat);
  const allYears = [...flat.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => m[0]);
  const year = parenYear?.[1] ?? allYears[allYears.length - 1];

  let authors: string[] = [];
  if (parenYear && parenYear.index > 0) {
    authors = splitProseAuthors(flat.slice(0, parenYear.index));
  }

  return {
    title,
    authors,
    truncatedAuthors: /\bet\s*\.?\s*al\b/i.test(flat),
    year: year ? Number(year) : undefined,
    doi: DOI_RE.exec(flat)?.[1],
    url: URL_RE.exec(flat)?.[0],
    arxivId: arxivIdIn(flat),
  };
}

/** "Smith, J., Doe, A., & Roe, B." → the names, in the order written. */
function splitProseAuthors(chunk: string): string[] {
  return (
    chunk
      .replace(/\bet\s*\.?\s*al\.?/gi, '')
      .split(/,|;|\band\b|&/i)
      .map((a) => a.trim().replace(/[.,]$/, '').trim())
      .filter((a) => a.length > 0)
      // "Smith" and "J." arrive as separate pieces because the comma between them is also the
      // separator between authors; fold an initials-only piece back onto the name before it.
      .reduce<string[]>((acc, piece) => {
        if (/^(?:[A-Z]\.?\s*){1,3}$/.test(piece) && acc.length)
          acc[acc.length - 1] += `, ${piece}.`;
        else acc.push(piece);
        return acc;
      }, [])
  );
}

/**
 * Every reference in a document, whatever format it uses. BibTeX entries and `\bibitem`s are looked
 * for first because they are exact; the prose scan only runs when neither is present, so a `.tex`
 * with a real bibliography is never also mined for bullet points.
 */
export function parseReferences(text: string, relPath?: string): ReferenceEntry[] {
  const structured = [...parseBibtex(text), ...parseBibitems(text)];
  if (structured.length > 0) return structured.sort((a, b) => a.line - b.line);
  // A `.tex` or `.bib` with nothing structured in it has no bibliography — reading its bullet
  // points as references would turn every itemize into a reference list.
  const ext = relPath ? path.extname(relPath).toLowerCase() : '';
  if (ext === '.tex' || ext === '.bib') return [];
  return parseProseReferences(text);
}

/**
 * The fields BibTeX needs for an entry type to render correctly. `|` marks alternatives (any one
 * of them satisfies the requirement). Entry types not listed here — `misc`, `online`, and anything
 * exotic — have no hard requirement, so they are never reported as incomplete.
 */
const REQUIRED_FIELDS: Record<string, string[]> = {
  article: ['author', 'title', 'journal|journaltitle', 'year|date'],
  inproceedings: ['author', 'title', 'booktitle', 'year|date'],
  conference: ['author', 'title', 'booktitle', 'year|date'],
  incollection: ['author', 'title', 'booktitle', 'publisher', 'year|date'],
  inbook: ['author|editor', 'title', 'chapter|pages', 'publisher', 'year|date'],
  book: ['author|editor', 'title', 'publisher', 'year|date'],
  booklet: ['title'],
  phdthesis: ['author', 'title', 'school|institution', 'year|date'],
  mastersthesis: ['author', 'title', 'school|institution', 'year|date'],
  techreport: ['author', 'title', 'institution', 'year|date'],
  manual: ['title'],
  proceedings: ['title', 'year|date'],
  unpublished: ['author', 'title', 'note'],
};

/**
 * Required fields an entry does not have. Only meaningful for `bibtex` entries — a prose reference
 * has no field structure to be missing anything, so it always comes back clean.
 */
export function missingRequiredFields(entry: ReferenceEntry): string[] {
  if (entry.format !== 'bibtex' || !entry.fields || !entry.type) return [];
  const required = REQUIRED_FIELDS[entry.type];
  if (!required) return [];
  const fields = entry.fields;
  return required.filter((spec) => !spec.split('|').some((name) => fields[name]?.trim()));
}

/** Blank out TeX comments so a commented-out `\cite` is not counted as a citation. */
export function stripTexComments(text: string): string {
  return text.replace(/(^|[^\\])%.*$/gm, (_m, prefix: string) => prefix);
}

const LATEX_CITE_RE = /\\([A-Za-z]*[Cc]ite[A-Za-z]*)\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}/g;
const PANDOC_BRACKET_RE = /\[([^\]]*@[^\]]+)\]/g;
const PANDOC_BARE_RE = /(?<![\w/@.-])@([A-Za-z][\w:.#$%&+?<>~/-]*[\w])/g;

/**
 * Cite keys used by a document, with where each use is. Covers the LaTeX `\cite` family (including
 * `\citep`/`\textcite`/`\autocite` and their multi-key, optional-argument forms) and pandoc's
 * markdown `[@key]` / `@key` — which is how a markdown draft cites a shared bibliography.
 */
export function extractCitations(text: string, opts: { markdown?: boolean } = {}): CitationUse[] {
  const source = opts.markdown ? text : stripTexComments(text);
  const uses: CitationUse[] = [];
  for (const m of source.matchAll(LATEX_CITE_RE)) {
    const command = m[1]!;
    for (const key of m[2]!.split(',')) {
      const trimmed = key.trim();
      if (trimmed) uses.push({ key: trimmed, line: lineAt(source, m.index!), command });
    }
  }
  if (opts.markdown) {
    const seen = new Set<number>();
    for (const bracket of source.matchAll(PANDOC_BRACKET_RE)) {
      // `bracket[1]` starts one character past the `[`, so offsets shift by one back into `source`.
      const inner = bracket.index! + 1;
      for (const m of bracket[1]!.matchAll(PANDOC_BARE_RE)) {
        seen.add(inner + m.index!);
        uses.push({ key: m[1]!, line: lineAt(source, bracket.index!), command: '@' });
      }
    }
    for (const m of source.matchAll(PANDOC_BARE_RE)) {
      if (seen.has(m.index!)) continue;
      uses.push({ key: m[1]!, line: lineAt(source, m.index!), command: '@' });
    }
  }
  return uses.sort((a, b) => a.line - b.line);
}

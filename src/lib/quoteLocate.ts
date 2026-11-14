/**
 * Locate a viewer comment's quote — the text the user selected in the PDF — in the project's LaTeX
 * sources, for the comments SyncTeX could not place (no `.synctex.gz`, a build without it, a point
 * that maps nowhere).
 *
 * This is text search, not SyncTeX, so it answers only when the evidence is unambiguous:
 * **exactly one** place in all the sources holds the quote's words in order. Two matches, or none,
 * leave the comment without a location rather than show the wrong lines; `list_comments` reports
 * how a location was found (`locatedBy`), so a caller can weigh it.
 *
 * Both sides are reduced to a sequence of words before comparing:
 * - **PDF side**: Unicode-compatibility folded (`ﬁ` → `fi`), accents stripped, lower-cased, a word
 *   broken across a line with a hyphen (`exam- ple`) rejoined, then split on anything that is not
 *   a letter or digit.
 * - **Source side**: `%` comments dropped, a control word's name (`\emph`, `\cite`) skipped, an
 *   accent control symbol (`\'e`) and braces treated as part of the word they sit in
 *   (`caf\'e`, `\textbf{im}portant`), everything else split like the PDF side.
 *
 * What the PDF shows but the source does not spell — a `\cite` rendered as `[3]`, a macro's
 * expansion, a ligature written `--` — breaks a full match, so a long quote is also tried by its
 * leading and trailing {@link WINDOW_WORDS} words, each accepted only when unique. A quote of fewer
 * than {@link MIN_WORDS} words is never located: three common words match everywhere.
 */
export const MIN_WORDS = 3;
export const WINDOW_WORDS = 6;

export interface QuoteLocation {
  file: string;
  line: number;
}

interface Word {
  text: string;
  /** 1-based source line the word starts on. */
  line: number;
}

function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/** The PDF side: a quote's words. */
export function quoteWords(quote: string): string[] {
  const joined = fold(quote).replace(/(\p{L})-\s+(\p{L})/gu, '$1$2');
  return joined.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

const ACCENT_SYMBOLS = new Set(["'", '`', '^', '"', '~', '=', '.']);

/** The source side: a LaTeX file's words, each with the line it starts on. */
export function sourceWords(content: string): Word[] {
  const words: Word[] = [];
  let cur = '';
  let curLine = 0;
  let line = 1;
  const flush = (): void => {
    if (cur) words.push({ text: cur, line: curLine });
    cur = '';
  };
  for (let i = 0; i < content.length; i++) {
    const ch = content[i] ?? '';
    if (ch === '\n') {
      flush();
      line++;
      continue;
    }
    if (ch === '%') {
      // A comment runs to the end of the line; `\%` is handled with the other control symbols.
      flush();
      while (i + 1 < content.length && content[i + 1] !== '\n') i++;
      continue;
    }
    if (ch === '\\') {
      const next = content[i + 1] ?? '';
      if (/[A-Za-z@]/.test(next)) {
        // A control word: its name is markup, never text.
        flush();
        i++;
        while (i + 1 < content.length && /[A-Za-z@]/.test(content[i + 1] ?? '')) i++;
        continue;
      }
      i++; // a control symbol
      if (!ACCENT_SYMBOLS.has(next)) flush();
      continue;
    }
    if (ch === '{' || ch === '}') continue; // part of the word around it
    const f = fold(ch);
    if (/^[\p{L}\p{N}]+$/u.test(f)) {
      if (!cur) curLine = line;
      cur += f;
    } else {
      flush();
    }
  }
  flush();
  return words;
}

function occurrences(
  needle: string[],
  files: ReadonlyArray<{ file: string; words: Word[] }>,
  limit: number,
): QuoteLocation[] {
  const out: QuoteLocation[] = [];
  const first = needle[0];
  if (first === undefined) return out;
  for (const { file, words } of files) {
    for (let i = 0; i + needle.length <= words.length; i++) {
      if (words[i]?.text !== first) continue;
      let ok = true;
      for (let k = 1; k < needle.length; k++) {
        if (words[i + k]?.text !== needle[k]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        out.push({ file, line: words[i]?.line ?? 1 });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/**
 * Where `quote` sits in `sources` (project-relative path → content), or `null` unless exactly one
 * place holds it — tried whole, then by its leading words, then by its trailing words.
 */
export function locateQuote(
  quote: string,
  sources: ReadonlyArray<{ file: string; content: string }>,
): QuoteLocation | null {
  const needle = quoteWords(quote);
  if (needle.length < MIN_WORDS) return null;
  const files = sources.map((s) => ({ file: s.file, words: sourceWords(s.content) }));
  const whole = occurrences(needle, files, 2);
  if (whole.length === 1) return whole[0] ?? null;
  if (whole.length > 1 || needle.length <= WINDOW_WORDS) return null;
  // No whole match (something the PDF shows is not spelled in the source): the two ends, each
  // unique, and never contradicting each other — the lead is used only if the tail is absent or
  // lands after it in the same file, and the tail only if the lead was found nowhere.
  const lead = occurrences(needle.slice(0, WINDOW_WORDS), files, 2);
  const tail = occurrences(needle.slice(needle.length - WINDOW_WORDS), files, 2);
  const l = lead.length === 1 ? lead[0] : undefined;
  const t = tail.length === 1 ? tail[0] : undefined;
  if (l && (tail.length === 0 || (t && t.file === l.file && t.line >= l.line))) return l;
  if (t && lead.length === 0) return t;
  return null;
}

/** At most this many `.tex` files are searched, each up to {@link QUOTE_MAX_FILE_BYTES}. */
export const QUOTE_MAX_FILES = 500;
export const QUOTE_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** The slice of `FileService` the project search needs. */
export interface QuoteSourceReader {
  list(
    projectDir: string,
    opts: { filter: 'tex' },
  ): Promise<Array<{ path: string; sizeBytes: number }>>;
  readText(projectDir: string, relPath: string, opts: { strictLinks: boolean }): Promise<string>;
}

/**
 * {@link locateQuote} over the project's own `.tex` files. A server-initiative read, so it passes
 * `strictLinks` (a link out of the project is never followed for it) and records no baseline. A
 * project with more than {@link QUOTE_MAX_FILES} `.tex` files, or one too large or unreadable, is
 * not searched at all: "unique in the files we happened to read" is not unique.
 */
export async function locateQuoteInProject(
  files: QuoteSourceReader,
  projectDir: string,
  quote: string,
): Promise<QuoteLocation | null> {
  if (quoteWords(quote).length < MIN_WORDS) return null;
  const listed = await files.list(projectDir, { filter: 'tex' });
  if (listed.length > QUOTE_MAX_FILES) return null;
  const sources: Array<{ file: string; content: string }> = [];
  for (const f of listed) {
    if (f.sizeBytes > QUOTE_MAX_FILE_BYTES) return null;
    try {
      const content = await files.readText(projectDir, f.path, { strictLinks: true });
      sources.push({ file: f.path, content });
    } catch {
      // An unreadable file could hold the second match: refuse rather than call the first unique.
      return null;
    }
  }
  return locateQuote(quote, sources);
}

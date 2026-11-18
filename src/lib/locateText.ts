/**
 * `locate_text`: where does text copied out of the compiled PDF live in the LaTeX sources?
 *
 * The matching engine is `quoteLocate.ts` (word sequences: the PDF side folded and de-hyphenated,
 * the source side skipping `%` comments and control words), shared with `list_comments`. What this
 * module adds is the pasted text's own noise, and an answer that lists every candidate instead of
 * only a unique one:
 *
 * - **A trailing instruction.** A user who pastes the whole message ("<text> --> drop") has the
 *   instruction cut at the first `-->` ({@link dropInstruction}); the result says it was dropped.
 * - **Margin line numbers.** A review copy (CVPR, ICCV, NeurIPS …) prints a line number in the
 *   margin, and a copy out of the PDF glues it onto the first or last word of a physical line:
 *   `traf-103\nfic`, `except 105`, `119\ntion`. {@link stripMarginNumbers} removes a standalone
 *   1–4 digit token at the very start or end of a physical line (one glued after a hyphen counts as
 *   standalone), so the hyphen rejoin that follows sees `traf-\nfic` → `traffic`.
 *
 * Removing a number is a guess — `scores 74` may end a line of real text — so the text is always
 * tried **as pasted first**, and the stripped variant only when the pasted words are found
 * nowhere. A match reported from the stripped variant never relies on a removed number: it is a
 * match of the words that remain.
 *
 * Read-only, and a server-initiative read of every file it scans: `strictLinks`, no baseline.
 */
import { toPosix } from './paths.js';
import { quoteId } from './projectId.js';
import {
  MIN_WORDS,
  QUOTE_MAX_FILES,
  QUOTE_MAX_FILE_BYTES,
  fullMatches,
  quoteWords,
  sourceWords,
  windowMatches,
  type QuoteMatch,
  type QuoteSourceReader,
  type Word,
} from './quoteLocate.js';

/** The longest pasted text accepted (a paragraph or two of a paper, with room to spare). */
export const LOCATE_TEXT_MAX_CHARS = 4000;
export const LOCATE_TEXT_DEFAULT_RESULTS = 5;
export const LOCATE_TEXT_MAX_RESULTS = 20;

/** The instruction marker users write after the copied text: `<text> --> remove`. */
const INSTRUCTION_MARKER = '-->';

/** `pasted` cut at its first `-->`, and whether anything was cut. */
export function dropInstruction(pasted: string): { text: string; instructionDropped: boolean } {
  const at = pasted.indexOf(INSTRUCTION_MARKER);
  if (at === -1) return { text: pasted, instructionDropped: false };
  return { text: pasted.slice(0, at), instructionDropped: true };
}

/** A 1–4 digit token ending a physical line, standalone or glued after a hyphen. */
const TRAILING_NUMBER = /(^|[\s\-‐‑])\d{1,4}[ \t]*$/u;
/** A 1–4 digit token opening a physical line, followed by whitespace or the line's end. */
const LEADING_NUMBER = /^[ \t]*\d{1,4}(?=[ \t]|$)/u;

/**
 * The text with margin line numbers removed from the start and end of every physical line, and
 * how many were removed. Pure; the caller decides whether to believe the result.
 */
export function stripMarginNumbers(text: string): { text: string; removed: number } {
  let removed = 0;
  const lines = text.split(/(\r\n|\r|\n)/);
  for (let i = 0; i < lines.length; i += 2) {
    let line = lines[i] ?? '';
    if (TRAILING_NUMBER.test(line)) {
      line = line.replace(TRAILING_NUMBER, '$1');
      removed++;
    }
    if (LEADING_NUMBER.test(line)) {
      line = line.replace(LEADING_NUMBER, '');
      removed++;
    }
    lines[i] = line;
  }
  return { text: lines.join(''), removed };
}

/** Which reading of the pasted text located it. */
export type LocateVariant = 'as-pasted' | 'margin-numbers-removed';

export interface PastedTextReadings {
  /** The words of the text as pasted (instruction dropped). */
  asPasted: string[];
  /** The words with margin numbers removed, or `null` when removing them changed no word. */
  stripped: string[] | null;
  /** How many numbers {@link stripMarginNumbers} removed (0 when `stripped` is `null`). */
  marginNumbersRemoved: number;
  instructionDropped: boolean;
}

/** The two word sequences `locate_text` tries, in the order it tries them. */
export function pastedTextReadings(pasted: string): PastedTextReadings {
  const { text, instructionDropped } = dropInstruction(pasted);
  const asPasted = quoteWords(text);
  const { text: strippedText, removed } = stripMarginNumbers(text);
  const strippedWords = quoteWords(strippedText);
  const same =
    strippedWords.length === asPasted.length && strippedWords.every((w, i) => w === asPasted[i]);
  return {
    asPasted,
    stripped: removed > 0 && !same ? strippedWords : null,
    marginNumbersRemoved: removed > 0 && !same ? removed : 0,
    instructionDropped,
  };
}

/** A located candidate with the live source lines it spans. */
export interface LocatedCandidate extends QuoteMatch {
  /** Lines `line`..`endLine`, whole-line `%` comments left out. Uncut; the budget cuts. */
  snippetLines: string[];
}

export interface LocateTextOutcome {
  /** Every candidate, in file then position order. */
  candidates: LocatedCandidate[];
  /** `null` when nothing was located. */
  variant: LocateVariant | null;
  /** Numbers removed in the reading that located it — 0 for `as-pasted` or no match. */
  marginNumbersRemoved: number;
  instructionDropped: boolean;
  /** Words in the reading that located it (or in the pasted reading when none did). */
  wordsSearched: number;
  filesSearched: number;
  /** Files that were listed but not searched, so "one candidate" may not be unique. */
  skipped: Array<{ path: string; reason: 'too-large' | 'unreadable' }>;
}

/** A refusal phrased for the caller: too few words, too many files, a path that is no source. */
export class LocateTextRefusal extends Error {}

/** A caller-supplied path, short enough to quote in a message. */
function shown(p: string): string {
  return quoteId(p.length > 200 ? `${p.slice(0, 200)}…` : p);
}

function normalisePath(p: string): string {
  let s = toPosix(p.trim());
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

/**
 * The live (non-comment) lines `line`..`endLine` of a file already split on `\n` (once per file:
 * splitting per candidate made a repetitive file quadratic).
 */
function liveLines(all: readonly string[], line: number, endLine: number): string[] {
  // sourceWords counts lines by `\n`; a CR before it is not part of the line's text.
  const out: string[] = [];
  for (let n = line; n <= endLine; n++) {
    const text = (all[n - 1] ?? '').replace(/\r$/, '');
    if (/^\s*%/.test(text)) continue;
    out.push(text);
  }
  return out;
}

/**
 * Locate `pasted` in the project's `.tex` files (or only `paths`, which must be among them):
 * whole as pasted, whole with margin numbers removed, then by its leading and trailing windows in
 * the same order. Every candidate is returned; the caller caps and budgets them.
 */
export async function locateTextInProject(
  reader: QuoteSourceReader,
  projectDir: string,
  pasted: string,
  opts: { paths?: string[] } = {},
): Promise<LocateTextOutcome> {
  const readings = pastedTextReadings(pasted);
  const longest = Math.max(readings.asPasted.length, readings.stripped?.length ?? 0);
  if (longest < MIN_WORDS) {
    throw new LocateTextRefusal(
      `The text holds ${longest} word(s)${readings.instructionDropped ? ' once the "-->" instruction is dropped' : ''}; ` +
        `at least ${MIN_WORDS} are needed to locate it — a shorter phrase matches almost everywhere. ` +
        'Paste more of the surrounding sentence, or use search_files for an exact string.',
    );
  }

  const listed = await reader.list(projectDir, { filter: 'tex' });
  let chosen = listed;
  if (opts.paths && opts.paths.length > 0) {
    const byPath = new Map(listed.map((f) => [normalisePath(f.path), f]));
    const unknown = opts.paths.filter((p) => !byPath.has(normalisePath(p)));
    if (unknown.length > 0) {
      const names = unknown.slice(0, 20).map(shown).join(', ');
      const more = unknown.length > 20 ? ` and ${unknown.length - 20} more` : '';
      throw new LocateTextRefusal(
        `Not a .tex file of this project: ${names}${more}. Paths are project-relative and ` +
          'matched literally; list_files with filter "tex" names the candidates.',
      );
    }
    const wanted = new Set(opts.paths.map(normalisePath));
    chosen = listed.filter((f) => wanted.has(normalisePath(f.path)));
  }
  if (chosen.length > QUOTE_MAX_FILES) {
    throw new LocateTextRefusal(
      `The project has ${chosen.length} .tex files, more than the ${QUOTE_MAX_FILES} searched in ` +
        'one call. Name the files to search with `paths`.',
    );
  }

  const skipped: LocateTextOutcome['skipped'] = [];
  const files: Array<{ file: string; words: Word[]; content: string }> = [];
  for (const f of chosen) {
    if (f.sizeBytes > QUOTE_MAX_FILE_BYTES) {
      skipped.push({ path: toPosix(f.path), reason: 'too-large' });
      continue;
    }
    try {
      const content = await reader.readText(projectDir, f.path, { strictLinks: true });
      files.push({ file: toPosix(f.path), words: sourceWords(content), content });
    } catch {
      skipped.push({ path: toPosix(f.path), reason: 'unreadable' });
    }
  }

  const tries: Array<{ variant: LocateVariant; words: string[]; removed: number }> = [
    { variant: 'as-pasted', words: readings.asPasted, removed: 0 },
  ];
  if (readings.stripped) {
    tries.push({
      variant: 'margin-numbers-removed',
      words: readings.stripped,
      removed: readings.marginNumbersRemoved,
    });
  }
  const linesOf = new Map(files.map((f) => [f.file, f.content.split('\n')]));
  const outcome = (t: (typeof tries)[number] | null, matches: QuoteMatch[]): LocateTextOutcome => ({
    candidates: matches.map((m) => ({
      ...m,
      snippetLines: liveLines(linesOf.get(m.file) ?? [], m.line, m.endLine),
    })),
    variant: t ? t.variant : null,
    marginNumbersRemoved: t ? t.removed : 0,
    instructionDropped: readings.instructionDropped,
    wordsSearched: t ? t.words.length : readings.asPasted.length,
    filesSearched: files.length,
    skipped,
  });

  for (const t of tries) {
    const m = fullMatches(t.words, files);
    if (m.length > 0) return outcome(t, m);
  }
  for (const t of tries) {
    const m = windowMatches(t.words, files);
    if (m.length > 0) return outcome(t, m);
  }
  return outcome(null, []);
}

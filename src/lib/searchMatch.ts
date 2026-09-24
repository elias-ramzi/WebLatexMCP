/**
 * Matching one file's text against a compiled `search_files` pattern: which lines match, which
 * of them matched only inside a LaTeX `%` comment, and what text is reported for each.
 *
 * Pure — a string, a `RegExp` and options in, plain data out. It reads nothing, resolves no
 * path and knows nothing about projects, so the whole of `search_files`' matching behaviour
 * (comment handling, the per-line scan cap, the reported window) is unit-testable without a
 * filesystem, let alone a live MCP client.
 */

import { splitLines } from './lines.js';
import { commentStartIndex } from './latexComments.js';

/**
 * How much of one line is ever handed to the regex engine.
 *
 * This is the "positions" half of the cost estimate whose "work per position" half lives in
 * `searchPattern.ts`: the analyzer counts an unbounded repeat at this line cap
 * (`ANALYZED_LINE_CHARS`, pinned equal to it by a unit test) and caps the estimated steps per
 * starting position, so a line's cost grows with its length times that cap. At 2000 characters
 * the costliest accepted families (`\w*\w{19}!`, `.*a?a{9}b`) take 0.13-0.3s per line, and
 * the slowest accepted patterns known about 2 to 3 times the first of those (0.3-0.45s, and
 * over a second on a machine under heavy load) — the worst found, not a bound; `a*b` against
 * 2000 `a`s takes a few milliseconds, and what the analyzer refuses mostly takes seconds or
 * more.
 * That estimate is an approximation, not a proof, and for a
 * regex search it is not what bounds the time taken: the scans run in a worker the search
 * terminates at its deadline (`searchWorker.ts`), so one `exec` the analyzer misjudged costs at
 * most the deadline. For a literal search, whose escaped pattern has no quantifiers and scans a
 * line in linear time, the between-lines deadline ({@link MatchOptions.expired}) is the bound.
 *
 * A line longer than this is searched up to the cap and COUNTED (`linesTruncatedForScan`), never
 * silently half-searched: "no match" and "not fully searched" are different answers.
 */
export const MAX_LINE_SCAN_CHARS = 2000;

/**
 * Longest `text` reported for a match or a context line. The same figure, for the same reason,
 * as `MAX_SNIPPET_LINE_CHARS` in `sourceSnippet.ts`: a generated `.tex` can hold its whole body
 * on one line, and that line would otherwise land in the result twice (text channel and
 * `structuredContent`). Its own constant rather than an import, because the two are answering
 * different questions and neither should silently change with the other.
 */
export const MAX_MATCH_TEXT_CHARS = 200;

/** Characters of the matched line kept before the match when the line has to be windowed. */
const WINDOW_LEAD_CHARS = 40;

/**
 * Most context lines one call may ask for, on each side of a hit.
 *
 * Context exists so a hit can be judged without a follow-up `read_file` — a paragraph of it is a
 * different request, and `read_file` with `startLine`/`endLine` is already the tool for that.
 * Five is also what keeps the per-entry cost of the rendered-size budget in the same order as
 * the match itself: at the cap, one entry can carry eleven lines of document text.
 */
export const MAX_CONTEXT_LINES = 5;

export interface LineMatch {
  /** 1-based line number, counted as `splitLines` counts (CRLF and CR aware). */
  line: number;
  /**
   * The matching line, or a window of it around the first match when it is longer than
   * {@link MAX_MATCH_TEXT_CHARS}. Elided text is marked with `…`, so this is a label for the
   * hit, NOT bytes to paste into `edit_file`.
   */
  text: string;
  /** Lines before the match, nearest last. Present only when `contextLines > 0` and some exist. */
  before?: string[];
  /** Lines after the match, nearest first. Present only when `contextLines > 0` and some exist. */
  after?: string[];
}

export interface FileMatches {
  matches: LineMatch[];
  /**
   * Lines whose matches ALL fell inside a `%` comment. Counted whether or not `excludeComments`
   * is set — the count is the answer to "how many of these hits are live?", which is the
   * question that made this option worth having (9 live hits against ~20 in comments), and a
   * caller gets it without a second call.
   */
  commentMatches: number;
  /**
   * Lines longer than {@link MAX_LINE_SCAN_CHARS}, whose tail was therefore never searched.
   * Counted over the lines actually scanned only.
   */
  linesTruncatedForScan: number;
  /** Lines scanned, from the top. Less than `totalLines` exactly when `complete` is false. */
  linesScanned: number;
  /** Lines in the file, counted as `splitLines` counts. */
  totalLines: number;
  /**
   * Every line was scanned. False when the deadline cut the scan short — the matches above are
   * then those of the first `linesScanned` lines only, and "no match further down" is unknown,
   * not "no".
   */
  complete: boolean;
}

export interface MatchOptions {
  /** Lines of context on either side of a hit. 0 (the default) reports the matching line alone. */
  contextLines?: number;
  /**
   * Skip a match that begins inside a `%` comment. Only ever consulted when `commentAware` is
   * true — `%` is not a comment character in a `.md` or `.txt`.
   */
  excludeComments?: boolean;
  /** Whether this file's syntax has `%` line comments at all (`supportsLineComments`). */
  commentAware?: boolean;
  /** Test seam for {@link MAX_LINE_SCAN_CHARS}. */
  maxLineScanChars?: number;
  /**
   * The search's deadline, read before EVERY line: once it returns true the scan stops and the
   * result says how far it got (`linesScanned`, `complete: false`). Every line rather than every
   * N: a read of the clock costs nanoseconds against an `exec` that costs at least as much, and
   * checking every N lines would multiply the overshoot by N for a quadratic pattern on long
   * lines — the case the per-line cap exists to bound.
   */
  expired?: () => boolean;
}

/** One file's text, split into lines and cut to what the regex engine is ever handed. */
export interface ScanLines {
  /** The file's lines, whole — context lines are taken from these. */
  lines: string[];
  /** `lines`, each cut to the per-line scan cap: exactly what is passed to `exec`. */
  scans: string[];
}

/**
 * Split `text` into lines and cut each to the scan cap. Split out from {@link matchFileLines} so a
 * caller that runs the `exec`s elsewhere (a worker thread — `searchWorker.ts`) hands that engine
 * exactly the strings the inline path would, and assembles the answer with the same code.
 */
export function prepareScanLines(text: string, maxLineScanChars?: number): ScanLines {
  const scanCap = maxLineScanChars ?? MAX_LINE_SCAN_CHARS;
  const lines = splitLines(text);
  const scans = lines.map((full) => (full.length > scanCap ? full.slice(0, scanCap) : full));
  return { lines, scans };
}

/**
 * The index of the first match on each line, or -1 — in line order, stopping early (and saying
 * so) when `expired` reports the deadline passed. The only place on the inline path where the
 * regex engine runs.
 *
 * `matcher` must carry the `g` flag; its `lastIndex` is reset before every line.
 */
export function firstHits(
  scans: readonly string[],
  matcher: RegExp,
  expired?: () => boolean,
): { hits: number[]; complete: boolean } {
  const hits: number[] = [];
  for (const scan of scans) {
    if (expired?.()) return { hits, complete: false };
    matcher.lastIndex = 0;
    const hit = matcher.exec(scan);
    hits.push(hit === null ? -1 : hit.index);
  }
  return { hits, complete: true };
}

/**
 * Find the matching lines of one file.
 *
 * **One `exec` per line, deliberately.** The scan does not enumerate every occurrence on a line:
 * it needs the FIRST one only, and that is enough to answer the comment question too. Matches
 * come back in increasing position, so if the first one starts at or after the comment's `%`,
 * every other one on that line does as well — the line is comment-only. If the first starts
 * before it, the line has a live hit whatever follows. Enumerating the rest would buy nothing
 * (the result is one entry per matching line, as `grep -n` is) and would multiply the regex work
 * this tool's denial-of-service bound is stated in terms of.
 *
 * A match that STARTS in live text and runs on past a `%` counts as live: it begins in code, and
 * it is the occurrence a caller has to judge.
 *
 * The inline composition of {@link prepareScanLines}, {@link firstHits} and
 * {@link assembleFileMatches}: `search_files` runs a LITERAL search this way, with the deadline
 * in `opts.expired`, and a regex search through the same three with `firstHits` replaced by a
 * worker (`searchWorker.ts`), because an `exec` on this thread cannot be interrupted.
 *
 * `matcher` must carry the `g` flag ({@link buildSearchMatcher} always sets it); its `lastIndex`
 * is reset before every line, so the same compiled matcher is reused across files without
 * carrying state between them.
 */
export function matchFileLines(
  text: string,
  matcher: RegExp,
  opts: MatchOptions = {},
): FileMatches {
  const prepared = prepareScanLines(text, opts.maxLineScanChars);
  const { hits } = firstHits(prepared.scans, matcher, opts.expired);
  return assembleFileMatches(prepared, hits, opts);
}

/**
 * Turn first-match indices into the reported matches: comment handling, the reported window and
 * the context lines. `hits[i]` belongs to line `i`; `hits` may be SHORTER than the file (a scan
 * the deadline cut short), and then only its prefix is assembled and the result says so.
 */
export function assembleFileMatches(
  prepared: ScanLines,
  hits: readonly number[],
  opts: Omit<MatchOptions, 'expired'> = {},
): FileMatches {
  const contextLines = opts.contextLines ?? 0;
  const { lines, scans } = prepared;
  const matches: LineMatch[] = [];
  let commentMatches = 0;
  let linesTruncatedForScan = 0;
  const linesScanned = Math.min(hits.length, lines.length);

  for (let i = 0; i < linesScanned; i++) {
    const full = lines[i] ?? '';
    const scan = scans[i] ?? '';
    const truncated = scan.length < full.length;
    if (truncated) linesTruncatedForScan++;

    const index = hits[i] ?? -1;
    if (index < 0) continue;

    const commentStart = opts.commentAware ? commentStartIndex(scan) : -1;
    const inComment = commentStart !== -1 && index >= commentStart;
    if (inComment) {
      commentMatches++;
      if (opts.excludeComments) continue;
    }

    const entry: LineMatch = {
      line: i + 1,
      text: windowAround(scan, index, truncated),
    };
    if (contextLines > 0) {
      const before = lines.slice(Math.max(0, i - contextLines), i).map(clip);
      const after = lines.slice(i + 1, i + 1 + contextLines).map(clip);
      if (before.length > 0) entry.before = before;
      if (after.length > 0) entry.after = after;
    }
    matches.push(entry);
  }

  return {
    matches,
    commentMatches,
    linesTruncatedForScan,
    linesScanned,
    totalLines: lines.length,
    complete: linesScanned === lines.length,
  };
}

/** A context line, cut from the front and marked when it does not fit. */
function clip(line: string): string {
  return line.length <= MAX_MATCH_TEXT_CHARS ? line : `${line.slice(0, MAX_MATCH_TEXT_CHARS)}…`;
}

/**
 * The reported text for a matching line: the line itself when it fits, else a window around the
 * match. Windowing rather than head-truncating matters — a hit 5000 characters into a generated
 * line would otherwise be reported with 200 characters that do not contain it, which reads as a
 * wrong result rather than an elided one.
 */
function windowAround(scan: string, index: number, scanTruncated: boolean): string {
  if (scan.length <= MAX_MATCH_TEXT_CHARS) return scanTruncated ? `${scan}…` : scan;
  const start = Math.max(
    0,
    Math.min(index - WINDOW_LEAD_CHARS, scan.length - MAX_MATCH_TEXT_CHARS),
  );
  const end = Math.min(scan.length, start + MAX_MATCH_TEXT_CHARS);
  const head = start > 0 ? '…' : '';
  const tail = end < scan.length || scanTruncated ? '…' : '';
  return `${head}${scan.slice(start, end)}${tail}`;
}

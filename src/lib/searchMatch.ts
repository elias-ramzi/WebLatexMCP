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
 * This is the "base" half of the denial-of-service bound whose "exponent" half lives in
 * `searchPattern.ts`: an accepted pattern carries at most one ambiguous unbounded quantifier, so
 * its worst case is quadratic in the length of the text it is run against. 2000 characters keeps
 * that worst case around ten milliseconds (measured: `a*b` against 2000 `a`s is 9ms, against
 * 4000 it is 40ms), which is what makes the between-lines deadline in `searchFiles.ts` a real
 * bound rather than one that can be overshot by an arbitrary amount inside a single `exec`.
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
  /** Lines longer than {@link MAX_LINE_SCAN_CHARS}, whose tail was therefore never searched. */
  linesTruncatedForScan: number;
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
 * `matcher` must carry the `g` flag ({@link buildSearchMatcher} always sets it); its `lastIndex`
 * is reset before every line, so the same compiled matcher is reused across files without
 * carrying state between them.
 */
export function matchFileLines(
  text: string,
  matcher: RegExp,
  opts: MatchOptions = {},
): FileMatches {
  const contextLines = opts.contextLines ?? 0;
  const scanCap = opts.maxLineScanChars ?? MAX_LINE_SCAN_CHARS;
  const lines = splitLines(text);
  const matches: LineMatch[] = [];
  let commentMatches = 0;
  let linesTruncatedForScan = 0;

  for (const [i, full] of lines.entries()) {
    const truncated = full.length > scanCap;
    if (truncated) linesTruncatedForScan++;
    const scan = truncated ? full.slice(0, scanCap) : full;

    matcher.lastIndex = 0;
    const hit = matcher.exec(scan);
    if (hit === null) continue;

    const commentStart = opts.commentAware ? commentStartIndex(scan) : -1;
    const inComment = commentStart !== -1 && hit.index >= commentStart;
    if (inComment) {
      commentMatches++;
      if (opts.excludeComments) continue;
    }

    const entry: LineMatch = {
      line: i + 1,
      text: windowAround(scan, hit.index, truncated),
    };
    if (contextLines > 0) {
      const before = lines.slice(Math.max(0, i - contextLines), i).map(clip);
      const after = lines.slice(i + 1, i + 1 + contextLines).map(clip);
      if (before.length > 0) entry.before = before;
      if (after.length > 0) entry.after = after;
    }
    matches.push(entry);
  }

  return { matches, commentMatches, linesTruncatedForScan };
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

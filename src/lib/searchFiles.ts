/**
 * The `search_files` search itself: which files to open, which to refuse to open and say so,
 * how long to keep going, and what fits in the answer.
 *
 * All of it lives here rather than in `src/tools/searchFiles.ts` so it is unit-testable against a
 * temp directory and a real `FileService`, with no MCP client in sight — the tool layer does
 * schema validation and response formatting and nothing else.
 *
 * Three guarantees this module is responsible for, each of which is easy to lose:
 *
 *  - **It records no revision baseline, ever.** A baseline is the claim that *the caller could
 *    now base a write on this file*, and this tool hands back lines a PATTERN selected out of
 *    files the caller never named, from a walk of the whole project. It is the same case
 *    CLAUDE.md spells out for `check_citations` and for `compile`'s error snippets: the bytes
 *    reaching the caller is not the test. Recording one here would tell the out-of-band-edit
 *    guard the server has seen the current bytes of every file in the project, and the next
 *    `write_file` would clobber a hand edit with no `ExternalChangeError`.
 *  - **"Not searched" is never reported as "no match".** A figure, an oversized file, one whose
 *    bytes are not text and one that could not be read are each recorded in `skipped` with the
 *    reason, and counted by reason even when the list itself is cut. A NUL byte making a naive
 *    grep return nothing is exactly the failure this exists to make visible.
 *  - **It is bounded in three independent directions**: the pattern cannot backtrack without
 *    bound (`searchPattern.ts`), one line's scan is capped (`searchMatch.ts`), and the whole
 *    search runs under a wall-clock deadline. For a literal search that deadline is read between
 *    LINES on this thread (`firstHits`); a regex search runs its `exec`s on a worker thread that
 *    is terminated at the deadline (`searchWorker.ts`), because one `exec` of a pattern the
 *    analyzer misjudged cannot be interrupted from the thread running it, and this thread is the
 *    whole server's. Either way a file cut off part-way is reported as such
 *    (`filesPartiallySearched`, and named in `note`), never as a file with no further matches.
 *    The payload is then bounded at rendered size, in both channels, by `searchBudget.ts`.
 *
 * On symlinks: the file list comes from `FileService.list`, whose walk follows a link only where
 * the project's owner said so (`followSymlinks` on a local project), and each file is then read
 * back through `FileService.read`, which applies the same policy. That pairing is deliberate and
 * matches every other walk-and-read tool here (`detectRootFile`, `list_references`,
 * `check_citations`): reading with `strictLinks: true` would make this one tool LIST a linked
 * shared `refs.bib` and then refuse to open it — "list skipping what read follows", which
 * CLAUDE.md calls out as making one project both follow and not follow its own links.
 * `strictLinks` is for a path the SERVER picked up from somewhere outside the project's own
 * contents (a compile log's `file:line:`, a git path list), not for the project's own files
 * inside a caller-chosen `subdir`.
 */

import type { FileEntry, FileFilter } from '../services/fileService.js';
import { MAX_READ_BYTES } from '../services/fileService.js';
import { supportsLineComments } from './rewriteMode.js';
import { buildSearchMatcher } from './searchPattern.js';
import { assembleFileMatches, firstHits, prepareScanLines } from './searchMatch.js';
import { planSearchPayload } from './searchBudget.js';
import { RegexScanWorker } from './searchWorker.js';

/**
 * Wall-clock budget for one search, in milliseconds.
 *
 * For a literal search it is checked between lines, so the real bound is this plus one line's
 * scan. For a regex search it is a timer that terminates the worker running the scan, so the
 * real bound is this plus the time to tear the thread down — whatever the pattern. Five seconds
 * is long enough that no realistic project times out and short enough that a runaway one still
 * answers within a tool call's patience — and, unlike a file-count cap, it bounds the thing that
 * actually varies: total bytes times pattern cost.
 */
export const SEARCH_TIME_BUDGET_MS = 5000;

/**
 * How many matching lines are ever held in memory, before the payload budget cuts the list down
 * to what is returned. Well above `SEARCH_MAX_MATCHES`, so the planner's own count cap is the
 * bound a caller sees; this one exists only so a pattern matching every line of a huge project
 * cannot grow an unbounded array on the way there.
 */
export const MAX_COLLECTED_MATCHES = 5000;

/** Why a file the walk found was not searched. Each is a different claim — keep them apart. */
export type SkipReason = 'asset' | 'too-large' | 'binary' | 'unreadable';

export interface SearchMatch {
  /** Project-relative, POSIX-separated (as `FileService.list` produces). */
  path: string;
  line: number;
  text: string;
  before?: string[];
  after?: string[];
}

export interface SkippedFile {
  path: string;
  reason: SkipReason;
}

export interface SearchOutcome {
  matches: SearchMatch[];
  /**
   * Every matching line found in the files that were searched — the true count, which is what
   * `matches.length` is a bounded prefix of. The difference is what the caps and the budget cut
   * (plus, past {@link MAX_COLLECTED_MATCHES}, what was counted but never collected).
   */
  totalMatches: number;
  /** Files with at least one reported match. */
  matchedFiles: number;
  /** Files actually opened and scanned. */
  filesSearched: number;
  omittedByCap: number;
  omittedBySize: number;
  skipped: SkippedFile[];
  /** Every file not searched, whether or not it fits in `skipped`. */
  skippedCount: number;
  skippedByReason: Record<SkipReason, number>;
  /** Matching lines whose matches all sat inside a `%` comment. See `matchFileLines`. */
  commentMatches: number;
  /** Lines too long to scan whole; their tails were not searched. */
  linesTruncatedForScan: number;
  /** The time budget ran out: the file(s) counted below were cut off or never reached. */
  timedOut: boolean;
  filesNotReached: number;
  /**
   * Files the deadline cut off PART-WAY: opened and scanned from the top, and stopped before the
   * end — possibly with no line finished at all, when one line's regex match is what ran out the
   * clock (the worker scanning it is terminated mid-`exec`). Counted in `filesSearched` too
   * (their matches so far are reported), and named with the lines reached in `note`. At most
   * one, since files are searched one at a time.
   */
  filesPartiallySearched: number;
  note?: string;
}

export interface SearchRequest {
  pattern: string;
  regex?: boolean;
  caseInsensitive?: boolean;
  filter?: FileFilter;
  subdir?: string;
  contextLines?: number;
  excludeComments?: boolean;
  /** Test seams. Defaults are the module constants; nothing in the tool layer sets them. */
  budgetMs?: number;
  now?: () => number;
  maxLineScanChars?: number;
  contentBudget?: number;
  maxMatches?: number;
}

/** The slice of `FileService` a search needs — narrow, so a test can hand in a stub. */
export interface SearchReader {
  list(projectDir: string, opts?: { filter?: FileFilter; subdir?: string }): Promise<FileEntry[]>;
  read(
    projectDir: string,
    opts: { path: string; recordBaseline?: boolean; strictLinks?: boolean },
  ): Promise<{ content: string; truncated: boolean; note?: string }>;
}

/**
 * Search a project's files for `pattern`.
 *
 * Files are visited in the order `FileService.list` returns them (path-sorted), and matches are
 * reported in that order — so the result reads as a walk through the project rather than as a
 * ranking, and the payload budget's tail cut keeps the part nearest the top.
 */
export async function searchProject(
  files: SearchReader,
  projectDir: string,
  request: SearchRequest,
): Promise<SearchOutcome> {
  // Throws (UnsafePatternError) before a single file is opened: a pattern the server will not
  // run is a refusal, not a search that returns nothing.
  const matcher = buildSearchMatcher(request.pattern, {
    regex: request.regex,
    caseInsensitive: request.caseInsensitive,
  });

  const now = request.now ?? Date.now;
  const budgetMs = request.budgetMs ?? SEARCH_TIME_BUDGET_MS;
  const startedAt = now();
  const expired = (): boolean => now() - startedAt > budgetMs;

  const entries = await files.list(projectDir, {
    filter: request.filter ?? 'all',
    subdir: request.subdir,
  });

  const collected: SearchMatch[] = [];
  const skipped: SkippedFile[] = [];
  const skippedByReason: Record<SkipReason, number> = {
    asset: 0,
    'too-large': 0,
    binary: 0,
    unreadable: 0,
  };
  let totalMatches = 0;
  let matchedFiles = 0;
  let filesSearched = 0;
  let commentMatches = 0;
  let linesTruncatedForScan = 0;
  let timedOut = false;
  let filesNotReached = 0;
  let filesPartiallySearched = 0;
  let partial: { path: string; linesScanned: number; totalLines: number } | undefined;
  let filesWithoutCommentSyntax = 0;

  const skip = (entry: FileEntry, reason: SkipReason): void => {
    skippedByReason[reason]++;
    skipped.push({ path: entry.path, reason });
  };

  // One worker per call, started on the first file that needs it. A literal pattern never does:
  // it has no quantifiers, so its scan is linear and the between-lines deadline bounds it.
  const worker = request.regex ? new RegexScanWorker(matcher) : undefined;
  try {
    for (const [i, entry] of entries.entries()) {
      // Checked before each file as well as between lines: a project of many small files must
      // be as interruptible as one file of many lines.
      if (expired()) {
        timedOut = true;
        filesNotReached = entries.length - i;
        break;
      }
      // Decided from the listing, before anything is opened: `FileService.read` classifies the
      // same two cases (an asset extension, or over the text read cap) by returning empty
      // content with a note, but deciding here keeps the two reasons distinct in the report
      // instead of collapsing them into one note the caller has to parse.
      if (entry.type === 'asset') {
        skip(entry, 'asset');
        continue;
      }
      if (entry.sizeBytes > MAX_READ_BYTES) {
        skip(entry, 'too-large');
        continue;
      }

      let content: string;
      try {
        // No recordBaseline (the default is false, and that is the point — see this module's
        // header) and no strictLinks (the walk that produced this path already applied the
        // project's link policy).
        const read = await files.read(projectDir, { path: entry.path });
        if (read.truncated && read.content === '') {
          // Defensive: `read` refused it as binary or oversized on a rule of its own. Reported
          // as not searched rather than as nothing found.
          skip(entry, 'too-large');
          continue;
        }
        content = read.content;
      } catch {
        // Deleted between the walk and the read, unreadable, a dangling link — the errno text
        // is not reported: what a caller can act on is that this path was not searched.
        skip(entry, 'unreadable');
        continue;
      }

      // A NUL byte means these bytes are not text: a naive line scan over them reports nothing,
      // which reads as "no matches" rather than "not searched", and any `text` reported from
      // them would be mojibake in the client's JSON. An extension-based rule alone would miss it
      // — this is a `.tex` holding a compiled blob, or a `.txt` that is really a database.
      if (content.includes('\u0000')) {
        skip(entry, 'binary');
        continue;
      }

      const prepared = prepareScanLines(content, request.maxLineScanChars);
      const scanned = worker
        ? await worker.scan(prepared.scans, budgetMs - (now() - startedAt))
        : firstHits(prepared.scans, matcher, expired);
      const commentAware = supportsLineComments(entry.path);
      const found = assembleFileMatches(prepared, scanned.hits, {
        contextLines: request.contextLines,
        excludeComments: request.excludeComments,
        commentAware,
      });

      filesSearched++;
      if (request.excludeComments && !commentAware) filesWithoutCommentSyntax++;
      commentMatches += found.commentMatches;
      linesTruncatedForScan += found.linesTruncatedForScan;
      if (found.matches.length > 0) matchedFiles++;
      totalMatches += found.matches.length;
      for (const m of found.matches) {
        if (collected.length >= MAX_COLLECTED_MATCHES) break;
        collected.push({ path: entry.path, ...m });
      }

      if (!found.complete) {
        timedOut = true;
        filesPartiallySearched = 1;
        partial = {
          path: entry.path,
          linesScanned: found.linesScanned,
          totalLines: found.totalLines,
        };
        filesNotReached = entries.length - (i + 1);
        break;
      }
    }
  } finally {
    worker?.close();
  }

  const plan = planSearchPayload(collected, skipped, {
    contentBudget: request.contentBudget,
    maxMatches: request.maxMatches,
    contextLines: request.contextLines,
  });

  const notes: string[] = [];
  if (plan.note) notes.push(plan.note);
  if (timedOut) {
    const cutOff = partial
      ? ` ${partial.path} was cut off after ${partial.linesScanned} of its ` +
        `${partial.totalLines} line(s) (a match further down it was not looked for), and`
      : '';
    notes.push(
      `The ${budgetMs}ms search budget ran out:${cutOff} ${filesNotReached} file(s) were ` +
        'never reached — this is a partial answer. Narrow it with subdir or filter, or use a ' +
        'cheaper pattern.',
    );
  }
  if (filesWithoutCommentSyntax > 0) {
    notes.push(
      `excludeComments applies only where % starts a comment (.tex/.sty/.cls/.bbl/.ltx/.latex): ` +
        `${filesWithoutCommentSyntax} searched file(s) have no % comment syntax, so every hit ` +
        'in them was reported, % or not. filter: "tex" searches .tex files only.',
    );
  }
  if (linesTruncatedForScan > 0) {
    notes.push(
      `${linesTruncatedForScan} line(s) were longer than the per-line scan cap and were ` +
        'searched only up to it; a match further along such a line was not found.',
    );
  }

  return {
    matches: plan.matches,
    totalMatches,
    matchedFiles,
    filesSearched,
    omittedByCap: plan.omittedByCap,
    omittedBySize: plan.omittedBySize,
    skipped: plan.skipped,
    skippedCount: skipped.length,
    skippedByReason,
    commentMatches,
    linesTruncatedForScan,
    timedOut,
    filesNotReached,
    filesPartiallySearched,
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  };
}

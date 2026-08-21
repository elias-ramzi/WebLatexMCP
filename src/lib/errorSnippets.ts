import type { StructuredError } from '../types.js';
import type { ParsedDiagnostic } from '../services/logParser.js';
import { isReadableSourcePath, readSourceLines, sliceSnippet } from './sourceSnippet.js';
import type { SnippetReader, SourceSnippet } from './sourceSnippet.js';

/**
 * How many distinct source locations get a snippet. A document that fails with 50 errors should not
 * return 50 excerpts; the number of locations left without one is reported, not silently dropped.
 */
export const MAX_SNIPPET_LOCATIONS = 10;

/**
 * Ceiling on the files opened while filling that quota. Locations that turn out to be unshowable
 * do not consume a snippet slot (a real log names plenty: a `.sty` in the TeX tree, a file deleted
 * since the build), so without a separate bound a pathological log could send the server through
 * hundreds of files — inside the per-project lock, where the time is paid by peer sessions.
 */
export const MAX_SNIPPET_FILE_READS = 30;

/** Shortest echo fragment that can contradict anything; below it, TeX told us too little. */
const MIN_ECHO_CHARS = 4;

/**
 * How much of an elided echo is compared against the file: its **tail**.
 *
 * pdfTeX elides a long context line at a byte offset, so it can cut a UTF-8 character in half —
 * `précision` in a French paragraph arrives as `...\uFFFDcision`, since the log is read as utf8 and
 * the orphan byte has no character. The right-hand end is never truncated (it stops at the error
 * position), so comparing a tail is what makes this survive an accented document; comparing the
 * whole fragment vetoed one location in eight on real French prose, and told the caller its source
 * was "over the cap, unreadable, or not confirmed" when the file was perfectly fine.
 */
const ECHO_TAIL_CHARS = 24;

/** A diagnostic plus the source it points at, when there is one we can vouch for. */
export type ErrorWithSnippet = StructuredError & Partial<SourceSnippet>;

/** Where a diagnostic points, when it points somewhere. */
interface ErrorLocation {
  file: string;
  line: number;
}

/** The location a diagnostic names, or undefined — half a location is not one. */
function locationOf(err: StructuredError): ErrorLocation | undefined {
  if (!err.file || err.line === undefined) return undefined;
  return { file: err.file, line: err.line };
}

/** Stable key for a location, for the Maps that group diagnostics by where they point. */
function locationKey(loc: ErrorLocation): string {
  return `${loc.file} ${loc.line}`;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Does TeX's echo of the source line contradict what the file actually says there?
 *
 * TeX prints the offending line under an error as `l.<n> …`, cut at the error position and, for a
 * long line, left-elided with a literal `...`. That echo is evidence *against* a location, never
 * for one: it is checked to catch a stale or mis-resolved file, and anything it cannot settle
 * counts as no contradiction rather than as agreement.
 */
function echoContradicts(rawEcho: string | undefined, source: string): boolean {
  if (!rawEcho) return false; // TeX printed no context line: nothing to check
  const elided = rawEcho.startsWith('...');
  const stripped = rawEcho.replace(/^\.\.\./, '');
  // A context line landing exactly on TeX's 79-column wrap is glued to its padded continuation by
  // unwrapLines, so also try the part before that padding rather than vetoing a good location.
  for (const fragment of [stripped, stripped.split(/\s{2,}/)[0] ?? '']) {
    const echo = normalizeWhitespace(fragment);
    if (echo.length < MIN_ECHO_CHARS) return false;
    if (!elided) {
      if (source.startsWith(echo)) return false; // TeX prints an un-elided line from column 1
      continue;
    }
    const tail = tailOf(echo);
    if (tail.length < MIN_ECHO_CHARS) return false; // the cut left too little to judge
    if (source.includes(tail)) return false;
  }
  return true;
}

/**
 * The part of an elided echo that can be trusted to be intact: everything after the last
 * replacement character (the half-character the elision cut), capped to {@link ECHO_TAIL_CHARS}
 * from the right-hand end, which is the end TeX never truncates.
 */
function tailOf(echo: string): string {
  const intact = echo.slice(echo.lastIndexOf('\uFFFD') + 1).trimStart();
  return intact.length > ECHO_TAIL_CHARS ? intact.slice(-ECHO_TAIL_CHARS) : intact;
}

export interface SnippetOutcome {
  errors: ErrorWithSnippet[];
  /**
   * Distinct attributed **locations** left without source context — over the cap, unreadable, of a
   * kind not opened, contradicted by the log, past the end of their file, or never named outright
   * by the log. Zero means every located error has its source.
   */
  omittedLocations: number;
}

/**
 * Attach the surrounding source to each attributed error. A LaTeX message on its own is often
 * uninterpretable — `Undefined control sequence` names no macro, `Missing $ inserted` points at the
 * line where TeX noticed rather than where the author erred — so without this the caller spends a
 * `read_file` round-trip per error.
 *
 * Showing the wrong five lines under a `>` marker is worse than showing none, so a location earns
 * its snippet only by clearing all of:
 *
 * - **The log named it outright.** `file` and `line` must come off one diagnostic line
 *   (`-file-line-error`). A location pieced together from the balanced-paren file stack and a
 *   nearby `l.<n>` is not shown at all: TeX's own elision of a long line can drop an opening `(`
 *   and pop that stack, and the wrong file it lands on is one that boilerplate source (`\item`,
 *   `\end{itemize}`) will happily corroborate. Those locations are counted, not guessed at.
 * - **The file is one we open** — see `isReadableSourcePath`.
 * - **The line exists, and TeX's echo does not contradict it.** A contradiction sticks: a
 *   co-located diagnostic carrying no echo cannot clear it, because the evidence was about the
 *   location, not about one message.
 *
 * A location that fails is not charged against the cap — ten TeX-tree `.sty` paths ahead of the
 * real error used to starve it of its snippet.
 */
export async function attachErrorSnippets(
  files: SnippetReader,
  projectDir: string,
  errors: ParsedDiagnostic[],
  max: number = MAX_SNIPPET_LOCATIONS,
): Promise<SnippetOutcome> {
  // Group by location, keeping first-seen order. A Map, not a scan of an array: a failed compile
  // can carry thousands of diagnostics, and `includes` over the distinct ones is quadratic.
  const order: ErrorLocation[] = [];
  const grouped = new Map<string, ParsedDiagnostic[]>();
  for (const err of errors) {
    const loc = locationOf(err);
    if (!loc) continue;
    const key = locationKey(loc);
    const group = grouped.get(key);
    if (group) group.push(err);
    else {
      grouped.set(key, [err]);
      order.push(loc);
    }
  }

  const shown = new Map<string, SourceSnippet>();
  const fileLines = new Map<string, string[] | undefined>();
  let filesRead = 0;
  for (const loc of order) {
    if (shown.size >= Math.max(0, max)) break;
    const key = locationKey(loc);
    const group = grouped.get(key) ?? [];
    if (!group.some((e) => e.locatedPair)) continue;
    if (!isReadableSourcePath(loc.file)) continue;
    if (!fileLines.has(loc.file)) {
      if (filesRead >= MAX_SNIPPET_FILE_READS) continue;
      filesRead++;
      fileLines.set(loc.file, await readSourceLines(files, projectDir, loc.file));
    }
    const lines = fileLines.get(loc.file);
    if (!lines) continue;
    const slice = sliceSnippet(lines, loc.line);
    if (!slice) continue;
    // Normalized once per location, not once per diagnostic: a generated one-line document puts
    // every error on line 1, and re-normalizing a 2MB line per error cost seconds under the lock.
    const source = normalizeWhitespace(lines[loc.line - 1] ?? '');
    if (group.some((e) => echoContradicts(e.echo, source))) continue;
    shown.set(key, slice);
  }

  const attached = new Set<string>();
  const enriched = errors.map((err) => {
    // Parser provenance is consumed here and does not reach the caller.
    const { echo: _echo, locatedPair: _locatedPair, ...clean } = err;
    const loc = locationOf(err);
    if (!loc) return clean;
    const key = locationKey(loc);
    const slice = shown.get(key);
    // Once per location: the co-located errors after the first carry no copy of the text.
    if (!slice || attached.has(key)) return clean;
    attached.add(key);
    return { ...clean, ...slice };
  });

  return { errors: enriched, omittedLocations: order.length - shown.size };
}

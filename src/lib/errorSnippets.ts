import path from 'node:path';
import type { StructuredError } from '../types.js';
import { splitLines } from './lines.js';
import { sliceSnippet } from './sourceSnippet.js';
import type { SnippetReader, SourceSnippet } from './sourceSnippet.js';

/**
 * How many distinct source locations get a snippet. A document that fails with 50 errors should not
 * return 50 excerpts; the number of locations left without one is reported, not silently dropped.
 */
export const MAX_SNIPPET_LOCATIONS = 10;

/**
 * Extensions a compile log may send the server to read.
 *
 * The log is **document-controlled**: `\typeout{creds.txt:1: Undefined control sequence.}` in a
 * `.tex` prints a line indistinguishable from a real `-file-line-error` diagnostic, and without this
 * the server would read that file and echo it into the result. Restricting to the kinds of file a
 * LaTeX error can genuinely be attributed to costs nothing real and takes the interesting targets
 * off the table. It matters most for a `mode: 'local'` project registered over a working directory,
 * where the neighbours are the user's own files.
 */
const SOURCE_EXT = new Set(['.tex', '.ltx', '.sty', '.cls', '.def', '.clo', '.bib', '.bbl']);

/** A diagnostic plus the source it points at, when there is one we can vouch for. */
export type ErrorWithSnippet = StructuredError & Partial<SourceSnippet>;

/** Where a diagnostic points, when it points somewhere. */
interface ErrorLocation {
  file: string;
  line: number;
}

/** The location a diagnostic names, or undefined — half a location is not one. */
function locationOf(err: StructuredError): ErrorLocation | undefined {
  if (!err.file || !err.line) return undefined;
  return { file: err.file, line: err.line };
}

/** Stable key for a location, for the Set/Map that group diagnostics by where they point. */
function locationKey(loc: ErrorLocation): string {
  return `${loc.file} ${loc.line}`;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Confirm a location against the file on disk before showing it.
 *
 * TeX echoes the offending source line under an error (`l.<n> …`), cut at the error position — and
 * elides the left of a long one with a literal `...`, so what it prints is a *fragment* of the real
 * line, not always a prefix of it. When the parser had to infer *which file* a diagnostic belongs
 * to — the balanced-paren stack, not a `file:line:` prefix — that fragment is the only evidence the
 * file and the line describe the same place, so it is required. Where the pair came off one
 * diagnostic line it is trusted, and the echo is used only to *veto*: if TeX's text and the file's
 * text disagree, something is stale or mis-resolved, and five lines under a `>` marker would be a
 * confident lie.
 */
function echoAgrees(err: StructuredError, sourceLine: string): boolean {
  const echo = normalizeWhitespace((err.echo ?? '').replace(/^\.\.\./, ''));
  if (echo.length < 4) return err.locatedPair === true; // too little to tell anything from
  return normalizeWhitespace(sourceLine).includes(echo);
}

export interface SnippetOutcome {
  errors: ErrorWithSnippet[];
  /**
   * Distinct attributed locations left without source context — over the cap, unreadable, of a kind
   * not read, unconfirmed, or pointing past the end of their file. Zero means every attributed
   * error carries its source, which is the only reason to report it at all.
   */
  omittedLocations: number;
}

/**
 * Attach the surrounding source to each attributed error. A LaTeX message on its own is often
 * uninterpretable — `Undefined control sequence` names no macro, `Missing $ inserted` points at the
 * line where TeX noticed rather than where the author erred — so without this the caller spends a
 * `read_file` round-trip per error.
 *
 * The rules, in order of what they protect:
 *
 * - **Never guessed.** A diagnostic with no `file`/`line`, one whose location the parser cannot
 *   vouch for (see {@link echoAgrees}), or one naming a line its file does not have gets none.
 * - **Never a file the document merely named** — see {@link SOURCE_EXT}.
 * - **Once per location.** Co-located errors share one read *and* one copy of the text: the snippet
 *   is attached to the first error at each location, exactly as the result text prints it once.
 * - **Capped** at `max` distinct locations, reading each file once rather than once per line.
 */
export async function attachErrorSnippets(
  files: SnippetReader,
  projectDir: string,
  errors: StructuredError[],
  max: number = MAX_SNIPPET_LOCATIONS,
): Promise<SnippetOutcome> {
  // Distinct locations in first-seen order. The Set is membership only — scanning the kept array
  // instead is quadratic, and a failed compile can carry thousands of diagnostics.
  const seen = new Set<string>();
  const selected: ErrorLocation[] = [];
  let omittedLocations = 0;
  for (const err of errors) {
    const loc = locationOf(err);
    if (!loc) continue;
    const key = locationKey(loc);
    if (seen.has(key)) continue;
    seen.add(key);
    if (selected.length < Math.max(0, max)) selected.push(loc);
    else omittedLocations++;
  }

  // Group by file so a document with ten errors is read once, not ten times — this runs inside the
  // per-project lock, where every millisecond is one a peer session waits.
  const byFile = new Map<string, ErrorLocation[]>();
  for (const loc of selected) {
    const group = byFile.get(loc.file);
    if (group) group.push(loc);
    else byFile.set(loc.file, [loc]);
  }

  const snippets = new Map<string, SourceSnippet>();
  const lineText = new Map<string, string>();
  await Promise.all(
    [...byFile.entries()].map(async ([file, locs]) => {
      const lines = await readSourceLines(files, projectDir, file);
      for (const loc of locs) {
        const slice = lines ? sliceSnippet(lines, loc.line) : undefined;
        if (!slice || !lines) {
          omittedLocations++;
          continue;
        }
        snippets.set(locationKey(loc), slice);
        lineText.set(locationKey(loc), lines[loc.line - 1] ?? '');
      }
    }),
  );

  // Verification is a property of the location, not of one diagnostic: several errors can sit on
  // one line and only some of them carry an echo. Decide once, then attach once.
  const showable = new Set<string>();
  for (const err of errors) {
    const loc = locationOf(err);
    if (!loc) continue;
    const key = locationKey(loc);
    if (!snippets.has(key) || showable.has(key)) continue;
    if (echoAgrees(err, lineText.get(key) ?? '')) showable.add(key);
  }
  omittedLocations += [...snippets.keys()].filter((key) => !showable.has(key)).length;

  const attached = new Set<string>();
  const enriched = errors.map((err) => {
    // Parser provenance is consumed here and does not reach the caller.
    const { echo: _echo, locatedPair: _locatedPair, ...clean } = err;
    const loc = locationOf(err);
    if (!loc) return clean;
    const key = locationKey(loc);
    const slice = snippets.get(key);
    if (!slice || !showable.has(key) || attached.has(key)) return clean;
    attached.add(key);
    return { ...clean, ...slice };
  });

  return { errors: enriched, omittedLocations };
}

/**
 * Read one source file into lines, or undefined when it is not ours to read, is not there, or has
 * nothing to show. A file that has moved, sits outside the project, or is over the read cap is
 * skipped silently — missing context is not a failure worth reporting, only worth counting.
 */
async function readSourceLines(
  files: SnippetReader,
  projectDir: string,
  file: string,
): Promise<string[] | undefined> {
  if (!SOURCE_EXT.has(path.posix.extname(file.toLowerCase()))) return undefined;
  try {
    const { content, note } = await files.read(projectDir, { path: file, recordBaseline: false });
    if (note) return undefined; // binary or over the read cap
    return splitLines(content);
  } catch {
    return undefined; // moved, deleted, outside the project, or behind a symlink out of it
  }
}

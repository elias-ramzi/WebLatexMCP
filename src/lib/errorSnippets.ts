import type { StructuredError } from '../types.js';

/** Source lines of context on either side of the reported line — 2 + the line itself + 2 = 5. */
export const SNIPPET_CONTEXT_LINES = 2;

/**
 * How many distinct source locations get a snippet. A document that fails with 50 errors should not
 * return 50 excerpts; the number of locations left out is reported rather than silently dropped.
 */
export const MAX_SNIPPET_LOCATIONS = 10;

/**
 * The slice of `FileService` this needs — narrow so tests can hand in a stub. `readExcerpt`, not
 * `read`, because showing context is the server's own initiative: it must not update the
 * out-of-band-edit baseline of a file the user may be editing by hand.
 */
export interface SnippetReader {
  readExcerpt(
    projectDir: string,
    opts: { path: string; startLine: number; endLine: number },
  ): Promise<{ content: string }>;
}

/** A diagnostic plus the source it points at, when the file and line were both known and readable. */
export type ErrorWithSnippet = StructuredError & {
  snippet?: string;
  /** 1-based source line of the snippet's first line, so the caller can number it. */
  snippetStartLine?: number;
};

/** Key a diagnostic by where it points, so several errors on one line share a single read. */
function locationKey(err: StructuredError): string | undefined {
  if (!err.file || !err.line) return undefined;
  return `${err.file} ${err.line}`;
}

/**
 * Attach the surrounding source to each attributed error. A LaTeX message on its own is often
 * uninterpretable — `Undefined control sequence` names no macro, `Missing $ inserted` points at the
 * line where TeX noticed rather than where the author erred — so without this the caller spends a
 * `read_file` round-trip per error.
 *
 * Only errors carrying both a `file` and a `line` get a snippet: a diagnostic the log parser could
 * not attribute gets none rather than a guessed one. Distinct locations are read once and capped at
 * `max`; errors sharing a location share that one snippet. A file that has moved, sits outside the
 * project (a `.sty` from the TeX installation), or is unreadable is skipped silently — missing
 * context is not itself a failure worth reporting.
 */
export async function attachErrorSnippets(
  files: SnippetReader,
  projectDir: string,
  errors: StructuredError[],
  max: number = MAX_SNIPPET_LOCATIONS,
): Promise<{ errors: ErrorWithSnippet[]; omittedLocations: number }> {
  const keys: string[] = [];
  for (const err of errors) {
    const key = locationKey(err);
    if (key && !keys.includes(key)) keys.push(key);
  }
  const selected = keys.slice(0, Math.max(0, max));
  const snippets = new Map<string, { snippet: string; snippetStartLine: number }>();
  await Promise.all(
    selected.map(async (key) => {
      const sep = key.lastIndexOf(' ');
      const file = key.slice(0, sep);
      const line = Number(key.slice(sep + 1));
      const startLine = Math.max(1, line - SNIPPET_CONTEXT_LINES);
      try {
        const res = await files.readExcerpt(projectDir, {
          path: file,
          startLine,
          endLine: line + SNIPPET_CONTEXT_LINES,
        });
        // An empty read means the line is past the end of the file — the log points at a location
        // this file no longer has, so there is nothing to show.
        if (res.content !== '')
          snippets.set(key, { snippet: res.content, snippetStartLine: startLine });
      } catch {
        // File moved, deleted, or outside the project — no context is better than wrong context.
      }
    }),
  );
  const enriched = errors.map((err) => {
    const key = locationKey(err);
    const hit = key ? snippets.get(key) : undefined;
    return hit ? { ...err, ...hit } : { ...err };
  });
  return { errors: enriched, omittedLocations: keys.length - selected.length };
}

/**
 * Render a snippet as numbered source lines with the reported line marked, so the context survives
 * for a client that strips `structuredContent` and only shows the result text.
 */
export function formatSnippet(err: ErrorWithSnippet, indent = '    '): string {
  const { snippet, snippetStartLine } = err;
  if (snippet === undefined || snippetStartLine === undefined) return '';
  const lines = snippet.split('\n');
  const width = String(snippetStartLine + lines.length - 1).length;
  return lines
    .map((text, i) => {
      const no = snippetStartLine + i;
      const marker = no === err.line ? '>' : ' ';
      return `${indent}${marker} ${String(no).padStart(width)} | ${text}`;
    })
    .join('\n');
}

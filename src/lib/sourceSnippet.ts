import { splitLines } from './lines.js';

/** Source lines of context on either side of the reported line — 2 + the line itself + 2 = 5. */
export const SNIPPET_CONTEXT_LINES = 2;

/**
 * Longest snippet line kept, before an ellipsis. A `.tex` line has no length limit: a document with
 * its whole body on one line (a converted or generated file) would otherwise put megabytes into the
 * result text *and* again into `structuredContent`. Two hundred characters is more than enough to
 * recognise where you are, and caps a whole snippet at ~1KB.
 */
export const MAX_SNIPPET_LINE_CHARS = 200;

export interface SourceSnippet {
  /** The source lines, newline-joined, each truncated to {@link MAX_SNIPPET_LINE_CHARS}. */
  snippet: string;
  /** 1-based source line of the snippet's first line, so the caller can number it. */
  snippetStartLine: number;
}

/** The slice of `FileService` this needs — narrow so tests can hand in a stub. */
export interface SnippetReader {
  read(
    projectDir: string,
    opts: { path: string; recordBaseline?: boolean },
  ): Promise<{ content: string; note?: string }>;
}

function clip(line: string): string {
  return line.length > MAX_SNIPPET_LINE_CHARS ? `${line.slice(0, MAX_SNIPPET_LINE_CHARS)}…` : line;
}

/**
 * Cut the context around `line` out of a file's already-split lines. Returns undefined when the
 * file has no such line — a log or a synctex record can point past the end of a file that has since
 * been shortened, and five lines that stop short of the reported one are worse than none: they
 * carry line numbers the reader trusts and no marker to show the reported line is not among them.
 */
export function sliceSnippet(lines: string[], line: number): SourceSnippet | undefined {
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return undefined;
  const startLine = Math.max(1, line - SNIPPET_CONTEXT_LINES);
  const end = Math.min(lines.length, line + SNIPPET_CONTEXT_LINES);
  return {
    snippet: lines
      .slice(startLine - 1, end)
      .map(clip)
      .join('\n'),
    snippetStartLine: startLine,
  };
}

/**
 * Read one file and cut the context around `line` out of it. Never records a revision baseline:
 * showing context is the server's own initiative, not the caller reading a file (see
 * `FileService.read`).
 */
export async function readSnippet(
  files: SnippetReader,
  projectDir: string,
  file: string,
  line: number,
): Promise<SourceSnippet | undefined> {
  const { content, note } = await files.read(projectDir, { path: file, recordBaseline: false });
  if (note) return undefined; // binary or over the read cap — nothing to show
  return sliceSnippet(splitLines(content), line);
}

/**
 * Render a snippet as numbered source lines with `markLine` marked, so the context survives for a
 * client that strips `structuredContent` and only shows the result text.
 */
export function formatSnippet(
  s: { snippet?: string; snippetStartLine?: number },
  markLine?: number,
  indent = '    ',
): string {
  const { snippet, snippetStartLine } = s;
  if (snippet === undefined || snippetStartLine === undefined) return '';
  const lines = snippet.split('\n');
  const width = String(snippetStartLine + lines.length - 1).length;
  return lines
    .map((text, i) => {
      const no = snippetStartLine + i;
      const marker = no === markLine ? '>' : ' ';
      return `${indent}${marker} ${String(no).padStart(width)} | ${text}`;
    })
    .join('\n');
}

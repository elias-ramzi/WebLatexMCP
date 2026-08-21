import path from 'node:path';
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

/**
 * Files the server will open to show context.
 *
 * A compile log is **document-controlled**: `\typeout{creds.txt:1: Undefined control sequence.}`
 * prints a line indistinguishable from a real `-file-line-error` diagnostic, and without this the
 * server would read that file and echo it back. Restricting to the kinds of file a LaTeX
 * diagnostic can genuinely belong to costs nothing real and takes the interesting targets off the
 * table. It matters most for a `mode: 'local'` project registered over a working directory, where
 * the neighbours are the user's own files.
 */
const SOURCE_EXT = new Set([
  '.tex',
  '.ltx',
  '.sty',
  '.cls',
  '.def',
  '.clo',
  '.bib',
  '.bbl',
  '.bst',
  '.tikz',
  '.pgf',
]);

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

/**
 * Whether a path is one to open for context at all — decided without touching the disk, so a log
 * full of paths that could never be shown does not cost a read each.
 */
export function isReadableSourcePath(file: string): boolean {
  if (path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) return false;
  if (file.split(/[\\/]/).includes('..')) return false;
  return SOURCE_EXT.has(path.posix.extname(file.toLowerCase()));
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
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) return undefined; // empty file
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
 * Read one source file into lines, or undefined when it is not ours to open, is not there, or has
 * nothing to show. Never records a revision baseline: showing context is the server's own
 * initiative, not the caller reading a file (see `FileService.read`). A file that has moved, sits
 * outside the project, or is over the read cap is skipped silently — missing context is not a
 * failure worth reporting, only worth counting.
 */
export async function readSourceLines(
  files: SnippetReader,
  projectDir: string,
  file: string,
): Promise<string[] | undefined> {
  if (!isReadableSourcePath(file)) return undefined;
  try {
    const { content, note } = await files.read(projectDir, { path: file, recordBaseline: false });
    if (note) return undefined; // binary, or over the read cap
    return splitLines(content);
  } catch {
    return undefined; // moved, deleted, outside the project, or behind a symlink out of it
  }
}

/** Read one file and cut the context around `line` out of it. */
export async function readSnippet(
  files: SnippetReader,
  projectDir: string,
  file: string,
  line: number,
): Promise<SourceSnippet | undefined> {
  const lines = await readSourceLines(files, projectDir, file);
  return lines && sliceSnippet(lines, line);
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

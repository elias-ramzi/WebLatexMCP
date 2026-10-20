import path from 'node:path';
import MarkdownIt from 'markdown-it';
import { toPosix } from './paths.js';

/**
 * Pure helpers for commenting on a markdown document in the viewer: which files it shows, and
 * which source line a comment on selected text points at. No I/O — the caller reads the file and
 * splits it with `splitLines` (`src/lib/lines.ts`), so lines are counted as everywhere else.
 */

/** Extensions the viewer renders as a document (compared lowercased). */
export const VIEWABLE_DOC_EXT: ReadonlySet<string> = new Set(['.md', '.markdown']);

/** True iff `relPath` names a markdown document; a dotfile named exactly `.md` is not one. */
export function isViewableDocument(relPath: string): boolean {
  return VIEWABLE_DOC_EXT.has(path.posix.extname(toPosix(relPath)).toLowerCase());
}

/**
 * The one spelling a document's comments are keyed by: POSIX separators, `./` and `a/../`
 * resolved, so `viewer`, `list_comments` and `resolve_comments` agree on `./notes.md` and
 * `notes.md`. A path that climbs out keeps its leading `..` — the sandbox refuses it, not this.
 */
export function normalizeDocPath(relPath: string): string {
  return relPath === '' ? '' : path.posix.normalize(toPosix(relPath));
}

/**
 * The comment-store surface filter a tool's `document`/`pdfOnly` pair names: a document's
 * normalised path when one is given (it wins), `null` (the PDF only) for `pdfOnly`, otherwise
 * `undefined` — every surface.
 */
export function commentSurface(
  document: string | undefined,
  pdfOnly: boolean | undefined,
): string | null | undefined {
  if (document !== undefined) return normalizeDocPath(document);
  return pdfOnly ? null : undefined;
}

/**
 * Whether a comment is a document comment located on its own document — the one kind whose
 * `file` the viewer chose by reading that document, not a path a synctex record named.
 */
export function isOwnDocComment(c: { file?: string; document?: string }): boolean {
  return c.document !== undefined && c.file === c.document;
}

/** How much of the quote is looked for first, and how much on the retry. */
const NEEDLE_CHARS = 40;
const SHORT_NEEDLE_CHARS = 12;

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The emphasis/code/strike characters, dropped from both the source line and the quote. */
const MARKUP_CHARS = /[*_`~]/g;

/**
 * Backslash escapes and entities decoded exactly as the renderer decodes them — markdown-it's own
 * `unescapeAll`, so every named and numeric entity (`&copy;`, `&#8212;`, `&nbsp;`) matches, and in
 * ONE pass, so `\&amp;` stays the literal `&amp;` it renders as.
 */
const decodeSource: (line: string) => string = new MarkdownIt().utils.unescapeAll;

/** Text as it is compared: the markup characters dropped, whitespace collapsed. */
const comparable = (text: string): string => collapse(text.replace(MARKUP_CHARS, ''));

/**
 * A source line as the rendered text reads it: link syntax reduced to its text, autolinks to
 * their URL, backslash escapes and entities decoded, and then — as from the quote — the
 * emphasis/code/strike characters (`*`, `_`, `` ` ``, `~`) dropped. Stripping both sides is what
 * lets a quote taken from a code span (`my_var`, source `` `my_var` ``) match; the cost is that a
 * quote differing from a line only in those characters matches it too.
 */
function renderedText(line: string): string {
  return comparable(
    decodeSource(
      line
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<([a-z][a-z0-9+.-]*:[^<>\s]*)>/gi, '$1'),
    ),
  );
}

const lineNumber = (n: unknown, fallback: number): number =>
  typeof n === 'number' && Number.isInteger(n) ? n : fallback;

/**
 * The 1-based source line a comment points at. `blockStart`/`blockEnd` come from the client (the
 * clicked element's `data-src`), so they are validated and clamped into the file; `quote` is the
 * selected text. The first line of the block whose rendered text contains the quote's first 40
 * characters wins; a quote that wraps onto the next line is retried with its first 12; otherwise
 * the block's first line. Never throws, never leaves `[1, max(1, lines.length)]`.
 */
export function resolveDocLine(
  lines: readonly string[],
  blockStart: unknown,
  blockEnd: unknown,
  quote: unknown,
): number {
  if (lines.length === 0) return 1;
  const clamp = (n: number): number => Math.min(Math.max(n, 1), lines.length);
  const rawStart = lineNumber(blockStart, 1);
  let rawEnd = lineNumber(blockEnd, rawStart);
  if (rawEnd < rawStart) rawEnd = rawStart;
  const start = clamp(rawStart);
  const end = clamp(rawEnd);
  if (typeof quote !== 'string') return start;
  const normalised = comparable(quote);
  if (!normalised) return start;
  const needles = [
    normalised.slice(0, NEEDLE_CHARS),
    normalised.slice(0, SHORT_NEEDLE_CHARS).trim(),
  ];
  for (const needle of needles) {
    if (!needle) continue;
    for (let n = start; n <= end; n++) {
      if (renderedText(lines[n - 1] ?? '').includes(needle)) return n;
    }
  }
  return start;
}

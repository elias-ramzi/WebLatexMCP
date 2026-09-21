/**
 * Split text into the lines a human (and TeX) would count.
 *
 * Two things a bare `split('\n')` gets wrong for source we then number:
 *
 * - **Line endings.** Clones force `core.autocrlf=false`, so CRLF stored in the repository stays
 *   CRLF on every platform, and a local project is never cloned at all — a `\r` is therefore
 *   ordinary content here, not a Windows-only curiosity. Splitting on `\n` alone leaves a trailing
 *   `\r` on every line (it surfaces in snippets and in anything numbered from them), and a CR-only
 *   file collapses to a single line, so line 3 of a 200-line document reads as "the whole document".
 * - **The phantom last line.** A file ending in a newline splits to a trailing `''` that is not a
 *   line: TeX would never report an error on it, so treating it as real puts a `>` marker on a line
 *   the file does not have and inflates the line count by one.
 */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * The exact text of lines `startLine..endLine` (1-based, inclusive), as a **substring of `text`**.
 *
 * A ranged read has to hand back bytes the caller can hand straight back: `read_file` a range,
 * paste it into `edit_file`'s `oldString`, and the match has to be found. Splitting into lines and
 * rejoining with `\n` breaks that for every CRLF file — the `\r` on each line is dropped, the
 * string no longer occurs in the file, and `edit_file` fails with "oldString not found". So this
 * slices between offsets instead: every terminator *inside* the range survives verbatim, and the
 * one after the last line is left off (the range is those lines, not the newline that follows).
 *
 * A range covering the whole file returns it untouched, trailing newline and all — `read_file`'s
 * `ref` path feeds `push` resolutions, which are written back to the repository verbatim.
 */
export function sliceLineRange(text: string, startLine?: number, endLine?: number): string {
  if (startLine === undefined && endLine === undefined) return text;
  const total = splitLines(text).length;
  const start = Math.max(1, startLine ?? 1);
  const end = Math.min(total, endLine ?? total);
  if (start <= 1 && end >= total) return text;
  if (start > end) return '';

  const terminator = /\r\n|\n|\r/g;
  let line = 1;
  let from = 0;
  let to = text.length;
  let match: RegExpExecArray | null;
  while ((match = terminator.exec(text)) !== null) {
    if (line === start - 1) from = match.index + match[0].length;
    if (line === end) {
      to = match.index; // up to, not including, the terminator that ends the last line
      break;
    }
    line++;
  }
  return text.slice(from, to);
}

/**
 * The `[start, end)` offsets of lines `startLine..endLine` (1-based, `endLine` inclusive), or
 * `null` when the range is not entirely inside `text`.
 *
 * This is the write-side counterpart of `sliceLineRange` (`src/lib/lines.ts`), which `read_file`
 * uses, and `text.slice(start, end)` equals `sliceLineRange(text, startLine, endLine)` for every
 * in-range pair but one — a differential unit test pins that, since the two scans are separate
 * code and drifting apart silently would make a caller's `read_file` range and their `edit_file`
 * range mean different things.
 *
 * The one deliberate divergence: `sliceLineRange` returns the **whole file including its trailing
 * newline** when the range covers every line, while this returns the span that stops before that
 * final terminator, exactly as it does for every other range. A read may hand back the trailing
 * newline harmlessly; an *edit* that consumed it would strip the file's final newline as a side
 * effect of a whole-file range edit — a change the caller never asked for, in a file format where
 * the missing newline is a real defect. Consistency inside `edit_file` wins over matching a read
 * quirk, and the divergence is one line of one shape, named here rather than discovered later.
 *
 * Out of range (`startLine < 1`, `endLine < startLine`, or `endLine` past the last line) returns
 * `null` rather than clamping the way `sliceLineRange` does: clamping a read shows the caller
 * fewer lines than they asked for, which they can see; clamping a *write* silently rewrites a
 * different region than the one named, which they cannot.
 */
/** Half-open `[start, end)` character span of the text it was computed from. */
export interface Span {
  start: number;
  end: number;
}

export function lineSpan(text: string, startLine: number, endLine: number): Span | null {
  const total = splitLines(text).length;
  if (startLine < 1 || endLine < startLine || endLine > total) return null;
  const terminator = /\r\n|\n|\r/g;
  let line = 1;
  let start = startLine === 1 ? 0 : -1;
  let end = text.length;
  let match: RegExpExecArray | null;
  while ((match = terminator.exec(text)) !== null) {
    // `line` is the number of the line this terminator ends.
    if (line === startLine - 1) start = match.index + match[0].length;
    if (line === endLine) {
      end = match.index; // up to, not including, the terminator that ends the last line
      break;
    }
    line++;
  }
  // Unreachable for an in-range pair (the bounds check above already rejected an `endLine` past
  // the last line, and line 1 always starts at 0), but a negative `start` would splice from the
  // end of the string, so fail rather than trust the scan.
  if (start < 0) return null;
  return { start, end };
}

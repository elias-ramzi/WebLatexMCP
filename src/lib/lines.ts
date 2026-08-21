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

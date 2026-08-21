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

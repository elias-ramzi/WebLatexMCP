/**
 * What to hand `ShadowStore.record` for a file's bytes: TEXT when the bytes are text, the
 * `Buffer` otherwise. Shared by `revert` and `unshelve`, the two tools that feed the shadow
 * store bytes they read themselves rather than strings a text tool wrote.
 *
 * **Why text at all.** `record` flags an entry `binary` when EITHER side arrives as a Buffer,
 * stickily and for the life of the entry, and a binary entry is never three-way merged: `refresh`
 * marks it `conflicted` outright as soon as HEAD moves to different bytes. Handing it a `.tex`
 * file's Buffer unconditionally would wedge that file — one peer commit touching a different
 * paragraph and this session's change is excluded from `scope: "session"` for good. The "no
 * such thing as a merged PNG" rationale for `binary` does not apply to a LaTeX file.
 *
 * **Why text only when the decode is LOSSLESS.** A NUL byte alone is not the test: a latin-1
 * `.tex` (`\usepackage[latin1]{inputenc}`) has no NUL, yet decoding it as UTF-8 turns every é
 * (0xe9) into U+FFFD, the shadow re-encodes that as `ef bf bd`, and the next session commit
 * stages those bytes where the file had `e9` — silent corruption of content both tools promise
 * to carry byte-exact. So the bytes are text only when they contain no NUL AND survive a UTF-8
 * round trip unchanged; anything else stays a Buffer and is stored (and committed) byte for byte,
 * at the price of that one file not three-way merging. Correct bytes beat a merge.
 */
export function asShadowContent(bytes: Buffer | null): string | Buffer | null {
  if (bytes === null) return null;
  if (bytes.includes(0)) return bytes;
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : bytes;
}

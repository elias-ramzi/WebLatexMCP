/**
 * Where a LaTeX line comment starts, by TeX's own escaping rule — the single home of the `%`
 * decision `search_files`' `excludeComments` is built on.
 *
 * Kept here rather than inline in the search matcher for the same reason
 * `LINE_COMMENT_EXTENSIONS` lives in `rewriteMode.ts` rather than in `edit_file`: a second copy
 * of this rule is how two features eventually disagree about what a comment is. The *extension*
 * half of the question already has a home — `supportsLineComments` in `src/lib/rewriteMode.ts`,
 * which `search_files` reuses — so this module answers only the within-a-line half.
 *
 * The rule, stated exactly, because the boundaries are the whole point:
 *
 *  - A `%` starts a comment when it is preceded by an EVEN number of consecutive backslashes
 *    (zero included). `% note` and `\\%` (a literal backslash, then a comment) are comments.
 *  - A `%` preceded by an ODD number of consecutive backslashes is `\%`, a literal percent sign —
 *    `50\% faster` is entirely live text, and nothing after it is a comment. Getting this
 *    backwards would silently drop every match after a percentage in a results table, which is
 *    exactly the text this option exists to search.
 *  - Everything from the comment's `%` to the end of the line is comment, the `%` included.
 *
 * The same accepted limitation as `supportsLineComments` applies, for the same reason: this is a
 * per-line lexical rule with no awareness of `verbatim`/`lstlisting`/`minted`/`\verb`, where `%`
 * is literal text rather than a comment. Detecting those needs real LaTeX parsing. The cost here
 * is bounded and visible: inside such an environment `excludeComments: true` can hide a live hit
 * — which is why the option is opt-in, off by default, and why the count of what it suppressed is
 * reported (`commentMatches`) rather than the suppression being silent.
 */

/**
 * Index of the `%` that starts a line comment in `line`, or `-1` when the line has none.
 *
 * `line` is one source line with no terminator (as {@link splitLines} produces); a `\r` left on
 * the end would simply be ordinary content to this scan.
 */
export function commentStartIndex(line: string): number {
  let backslashes = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    // Even (zero included) means the `%` was never escaped: a comment starts here.
    if (ch === '%' && backslashes % 2 === 0) return i;
    backslashes = 0;
  }
  return -1;
}

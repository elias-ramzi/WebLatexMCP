import { z } from 'zod';

/**
 * One `edit_file` edit: a string replacement or a line range. Exported so `compile`'s `overlay`
 * takes exactly the same edits, described the same way, rather than a copy that could drift.
 */
export const editItemSchema = z.union([
  z
    .object({
      oldString: z
        .string()
        .describe('Exact text to replace (include enough context to be unique).'),
      newString: z.string().describe('Replacement text.'),
      replaceAll: z.boolean().optional().describe('Replace every occurrence (default false).'),
      excludeComments: z
        .boolean()
        .optional()
        .describe(
          'Skip matches that sit in a LaTeX comment (default false, so existing callers ' +
            'are unaffected). A comment runs from an unescaped % to the end of that line: ' +
            '\\% is a literal percent and is NOT a comment, while \\\\% IS one (the \\\\ ' +
            'consumes both backslashes). Both a whole commented-out line and the commented ' +
            'tail of a live line are excluded, and a match that straddles the boundary ' +
            'counts as commented — it is skipped, never half-replaced. With replaceAll, ' +
            'only the live occurrences are rewritten; without it, uniqueness is judged over ' +
            'the live occurrences alone, so a string with one live and 182 commented ' +
            'occurrences is a unique match. Either way the result reports, per edit, how ' +
            'many were replaced and how many were skipped (commentMatches), and a request ' +
            'whose every match is commented is refused rather than silently doing nothing. ' +
            'Only for a file whose comment character is % (.tex/.sty/.cls/.bbl/.latex/.ltx); ' +
            'anywhere else the call is refused rather than pretending to filter.',
        ),
    })
    .strict(),
  z
    .object({
      startLine: z
        .number()
        .int()
        .positive()
        .describe('1-based first line to replace, inclusive — the numbering read_file uses.'),
      endLine: z.number().int().positive().describe('1-based last line to replace, inclusive.'),
      newString: z
        .string()
        .describe(
          'Text those lines become. Empty deletes them outright, line terminator included, ' +
            'so no blank line is left behind (in edit_file only, a rewrite-preservation mode ' +
            "leaves them %-commented in place instead; compile's overlay never preserves). In a " +
            'file mixing bare-CR and LF endings, a deletion ' +
            'that would leave a bare \\r right before a blank LF line turns that \\r (and ' +
            'any bare \\r run just before it) into \\n, so the blank line is not swallowed ' +
            'into one CRLF.',
        ),
    })
    .strict(),
]);

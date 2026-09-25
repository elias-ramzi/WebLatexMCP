import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { bibEditBlockedMessage, isBibFile } from '../lib/bib.js';
import { changeDiff, changedPath } from '../lib/changeDiff.js';
import {
  createPreserveTransform,
  matchIsCommented,
  resolveRewriteMode,
  supportsLineComments,
  DEFAULT_REWRITE_MODE,
  REWRITE_MODES,
} from '../lib/rewriteMode.js';
import type { RewriteMode } from '../lib/rewriteMode.js';

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
            'so no blank line is left behind (or, under a rewrite-preservation mode, leaves ' +
            'them %-commented in place). In a file mixing bare-CR and LF endings, a deletion ' +
            'that would leave a bare \\r right before a blank LF line turns that \\r (and ' +
            'any bare \\r run just before it) into \\n, so the blank line is not swallowed ' +
            'into one CRLF.',
        ),
    })
    .strict(),
]);

const inputSchema = {
  project: z.string().optional(),
  path: z.string().describe('Path relative to the project root.'),
  overrideExternalChanges: z
    .boolean()
    .optional()
    .describe(
      'Apply even if the file changed on disk since it was last read through this server ' +
        '(e.g. edited directly by the user). Prefer re-reading first to see those changes.',
    ),
  confirmBibEdit: z
    .boolean()
    .optional()
    .describe(
      'Required to edit a .bib file directly. Add references via add_citation instead; ' +
        'only set this after the user approves a manual bibliography change.',
    ),
  preserveOriginal: z
    .boolean()
    .optional()
    .describe(
      'Force the original text to be preserved (true) or not (false) for this call, ' +
        "overriding the project's rewrite-preservation mode either way. Omit to use that mode. " +
        'This overrides the MODE, not eligibility: on a .bib file or a file with no %-line-comment ' +
        'syntax, the result still reports rewriteMode: "off" and nothing is preserved (and the ' +
        'result text says so); on an eligible file a mid-line match or a replaceAll edit still ' +
        'reports the resolved mode with preservedEdits: 0. ' +
        'An edit with replaceAll set never CREATES a preservation itself (there is no single ' +
        'match position to comment above) — it applies unchanged regardless of this setting. ' +
        'Note: preserving leaves oldString in the file as a %-commented block above the ' +
        'replacement (every line prefixed with "% ", so only a single line of it still occurs ' +
        'verbatim). A later edit_file call whose oldString still occurs in that comment will ' +
        'match it: if the text also still occurs live, the call is refused as non-unique (add ' +
        'more surrounding context); if the comment is the only match, the edit is applied to ' +
        'the dead comment and reports success; with replaceAll: true the comment is rewritten ' +
        'along with the live text. Within a single call it is stricter: a later edit in this ' +
        'same edits array that matches inside (or across the edge of) a block an earlier edit preserved ' +
        'is refused outright, since its live target was already replaced and applying it would ' +
        'rewrite dead commented-out text; the whole call fails and the file is left untouched.',
    ),
  edits: z
    .array(editItemSchema)
    .min(1)
    .describe(
      'Edits applied in order and atomically. Each is EITHER a string replacement ' +
        '{oldString, newString} OR a line range {startLine, endLine, newString} — never both in ' +
        'one object. A line range replaces those lines whatever they say, for a change defined ' +
        'by where it is rather than what it says (1-based, endLine inclusive, exactly like ' +
        "read_file; the line terminator after endLine is not replaced, so the file's last " +
        'newline survives a whole-file range — unless newString is empty, which deletes the ' +
        'lines together with that terminator). Line numbers always refer to the file as it ' +
        'was BEFORE this call — the content read_file returned — never to the state an earlier ' +
        'edit in this same array left behind; if two edits in one call would touch the same ' +
        'text (a range counts the line terminator after endLine as its own), the whole call is ' +
        'refused rather than applied to shifted lines. A STRING edit, unlike a range, matches ' +
        'the text as the earlier edits in the array left it, so it fails as not found when an ' +
        'earlier edit already removed what it names — including the newline before an ' +
        'unterminated last line, which deleting that line takes. A file that is not valid UTF-8 is ' +
        'refused: the edit rewrites the whole file as UTF-8.',
    ),
};

const outputSchema = {
  path: z.string(),
  appliedEdits: z.number(),
  diff: z
    .string()
    .describe(
      'Confirmation diff against HEAD. Budgeted (#153): a large patch comes back cut at hunk ' +
        'boundaries with a "... N of M hunk(s) omitted" marker — call diff for the whole one. ' +
        'Empty for a local project (there is no baseline of ours to diff against) or when ' +
        'nothing changed; never empty merely because it was cut.',
    ),
  diffTruncated: z
    .boolean()
    .describe('True iff the confirmation diff above was cut to fit its budget.'),
  rewriteMode: z
    .enum(REWRITE_MODES as unknown as [RewriteMode, ...RewriteMode[]])
    .describe('The mode that actually applied for this call.'),
  preservedEdits: z.number(),
  commentMatches: z
    .array(
      z.object({
        edit: z.number().describe('1-based index into `edits`.'),
        replaced: z.number(),
        skippedInComments: z.number(),
      }),
    )
    .optional()
    .describe(
      'One entry per edit that set excludeComments, so a skipped match is never silent. Absent ' +
        'when no edit did.',
    ),
};

export function registerEditFile(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'edit_file',
    {
      title: 'Edit a project file',
      description:
        'Apply surgical edits to a file: string replacements {oldString, newString} and/or line ' +
        'ranges {startLine, endLine, newString}, in one array. Each oldString must match ' +
        'uniquely unless replaceAll is set; a line range replaces those lines whatever they say ' +
        '(1-based and inclusive, the numbering read_file uses), so a block only identified by ' +
        'where it is need not be shipped twice. Edits apply atomically — if any fails, the file ' +
        'is left untouched. Preferred over write_file for existing files.',
      inputSchema,
      outputSchema,
    },
    async ({
      project,
      path: relPath,
      edits,
      overrideExternalChanges,
      confirmBibEdit,
      preserveOriginal,
    }) => {
      try {
        const isBib = isBibFile(relPath);
        if (isBib && !confirmBibEdit) {
          throw new Error(bibEditBlockedMessage(relPath));
        }
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        return await ctx.projectManager.runExclusive(id, async () => {
          // Inside the lock, same reasoning as write_file: closes the peer window at no extra cost
          // since every mutator already takes this lock.
          const target = await ctx.files.linkTarget(dir, relPath);
          const targetIsBib = target !== null && isBibFile(target);
          if (targetIsBib && !confirmBibEdit) {
            throw new Error(bibEditBlockedMessage(relPath, target));
          }
          // The only place the effective rewrite mode is derived (the `parseCompilerChoice`
          // lesson) — every other reader of "what mode applies" must call through here.
          const resolved = resolveRewriteMode({
            perCall: preserveOriginal,
            stored: await ctx.rewriteModes.get(id),
            envDefault: ctx.config.rewriteMode ?? DEFAULT_REWRITE_MODE,
          });
          // .bib never preserves (a narrowing on top of the confirmBibEdit gate above, not a
          // replacement for it), and preservation is meaningless outside %-comment documents.
          // Both are judged on the link-resolved name too: the bytes land in the target, so a
          // `notes.tex -> refs.bib` link would otherwise put `%` lines into a bibliography, and
          // a `.tex` link onto a `.md` would comment with a syntax the target does not have.
          // `!isBib` is defensive: '.bib' is absent from LINE_COMMENT_EXTENSIONS, so the
          // extension check below already excludes it — kept so the exemption does not depend
          // on that list.
          const anyBib = isBib || targetIsBib;
          const commentSyntax =
            supportsLineComments(relPath) && (target === null || supportsLineComments(target));
          const eligible = !anyBib && commentSyntax;
          const effectiveMode: RewriteMode = eligible ? resolved.mode : 'off';

          // `excludeComments` is an assertion about which matches must be left alone, so a file
          // with no % comment syntax is refused here rather than filtered against a comment
          // character it does not have — which would silently rewrite every match the caller
          // asked to protect. Judged on the link-resolved name too (as the .bib gate is): the
          // bytes land in the target, so the target's syntax is the one that decides. Same
          // shape as the .bib guard, and deliberately in the tool layer for the same reason.
          const commentFiltered = edits.findIndex(
            (e) => 'excludeComments' in e && e.excludeComments,
          );
          if (commentFiltered !== -1 && !commentSyntax) {
            const named = target !== null && !supportsLineComments(target) ? target : relPath;
            throw new Error(
              `Edit ${commentFiltered + 1} sets excludeComments, but ${named} has no %-line-comment syntax, so there are no comments to exclude. Drop excludeComments, or target a .tex-family file.`,
            );
          }

          const preserve = createPreserveTransform(effectiveMode);
          const res = await ctx.files.applyEdits(dir, relPath, edits, {
            overrideExternalChanges,
            preserve,
            excludeMatch: matchIsCommented,
          });
          const preservedEdits = preserve.preservedEdits();
          // A write through an in-project link changed the target, so that is the path to diff.
          const diff = await changeDiff(
            ctx.projectManager,
            ctx.git,
            id,
            dir,
            changedPath(target, relPath),
          );
          let headline = `applied ${res.appliedEdits} edit(s) to ${res.path}`;
          if (preservedEdits > 0) {
            headline += ` (preserved the original text of ${preservedEdits} edit(s) as comments)`;
          }
          // An explicit preserveOriginal: true/false is an assertion about the MODE, not
          // eligibility (see the compiler-substitution precedent in CLAUDE.md: a substitution
          // the caller did not choose must be named, never applied silently). When the call
          // asserted a non-off mode but the file is ineligible, effectiveMode is silently 'off'
          // in the structured fields — name it in the text instead of adding a new field.
          if (resolved.source === 'call' && resolved.mode !== 'off' && !eligible) {
            const named = target !== null && !supportsLineComments(target) ? target : res.path;
            const reason = anyBib
              ? `${targetIsBib && !isBib ? target : res.path} is a .bib file`
              : `${named} has no %-line-comment syntax, so nothing can be preserved there`;
            headline += ` — preserveOriginal was ignored: ${reason}`;
          }
          // Skipped matches are reported in the text channel too, not only in structuredContent:
          // an MCP client that shows only the text would otherwise see "applied 1 edit(s)" for a
          // rename that deliberately left 182 occurrences alone.
          for (const m of res.commentMatches ?? []) {
            headline +=
              `\nedit ${m.edit}: replaced ${m.replaced} occurrence(s), ` +
              `skipped ${m.skippedInComments} inside comments`;
          }
          // Both channels render from the same budgeted plan, never from the full patch.
          return {
            content: [
              {
                type: 'text',
                text: diff.diff ? `${headline}\n\n${diff.diff}` : headline,
              },
            ],
            structuredContent: {
              ...res,
              diff: diff.diff,
              diffTruncated: diff.truncated,
              rewriteMode: effectiveMode,
              preservedEdits,
            },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { editItemSchema } from '../lib/editItemSchema.js';
import {
  assertCompileRequested,
  compileAfterWriteInput,
  compileSummarySchema,
  summarizeCompile,
} from '../lib/compileSummary.js';
import { runCompile } from './compile.js';
import { planEditDiff, planEditDiffs } from '../lib/editDiff.js';
import {
  assertBibConfirmedByName,
  assertDistinctFiles,
  editHeadline,
  normalizeEditArgs,
  planFileEdit,
  EDIT_FILES_MAX,
} from '../lib/editFilePlan.js';
import type { PlannedFileEdit } from '../lib/editFilePlan.js';
import { quoteId } from '../lib/projectId.js';
import { REWRITE_MODES } from '../lib/rewriteMode.js';
import type { RewriteMode } from '../lib/rewriteMode.js';
import type { AnyEditOp } from '../services/fileService.js';

const rewriteModeSchema = z.enum(REWRITE_MODES as unknown as [RewriteMode, ...RewriteMode[]]);

const inputSchema = {
  project: z.string().optional(),
  path: z
    .string()
    .optional()
    .describe('Path relative to the project root. Omit when editing several files with `files`.'),
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
        'more surrounding context, or set excludeComments: true on the edit); if the comment is ' +
        'the only match, the edit is applied to ' +
        'the dead comment and reports success; with replaceAll: true the comment is rewritten ' +
        'along with the live text. Within a single call it is stricter: a later edit in this ' +
        'same edits array that matches inside (or across the edge of) a block an earlier edit preserved ' +
        'is refused outright, since its live target was already replaced and applying it would ' +
        'rewrite dead commented-out text; the whole call fails and the file is left untouched.',
    ),
  ...compileAfterWriteInput,
  edits: z
    .array(editItemSchema)
    .min(1)
    .optional()
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
        'refused: the edit rewrites the whole file as UTF-8. A single edit may instead be given ' +
        'inline at top level beside path (oldString/newString, or startLine/endLine/newString).',
    ),
  oldString: z
    .string()
    .optional()
    .describe(
      'Inline shorthand for edits: [{oldString, newString, ...}] — one string edit given at top ' +
        'level beside path. Not combinable with edits or files.',
    ),
  newString: z
    .string()
    .optional()
    .describe('Inline shorthand: the replacement text of the one inline edit.'),
  replaceAll: z.boolean().optional().describe("Inline shorthand: as an edit's replaceAll."),
  excludeComments: z
    .boolean()
    .optional()
    .describe("Inline shorthand: as an edit's excludeComments."),
  startLine: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Inline shorthand for edits: [{startLine, endLine, newString}] — one line-range edit at ' +
        'top level beside path. Not combinable with oldString, edits or files.',
    ),
  endLine: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Inline shorthand: the last line (inclusive) of the one inline range edit.'),
  files: z
    .array(
      z
        .object({
          path: z.string().describe('Path relative to the project root.'),
          edits: z
            .array(editItemSchema)
            .min(1)
            .describe("This file's edits, exactly as the top-level edits."),
        })
        .strict(),
    )
    .min(1)
    .max(EDIT_FILES_MAX)
    .optional()
    .describe(
      `Edit several files in one call (at most ${EDIT_FILES_MAX}), ALL OR NOTHING: every file is ` +
        'planned under every guard a single-file call applies (the .bib gate, the external-change ' +
        'check, rewrite preservation, excludeComments, UTF-8) before anything is written, and if ' +
        'any file fails nothing is written — the error names the file and the edit. The flags of ' +
        'this call (confirmBibEdit, overrideExternalChanges, preserveOriginal, compile) apply to ' +
        'every file. Given instead of top-level path/edits, never beside them; a file appears ' +
        'once (put all its edits in one entry).',
    ),
};

const commentMatchSchema = z.object({
  edit: z.number().describe('1-based index into `edits`.'),
  replaced: z.number(),
  skippedInComments: z.number(),
});

const fileResultSchema = z.object({
  path: z.string(),
  appliedEdits: z.number(),
  diff: z
    .string()
    .describe(
      "This file's confirmation diff, as the single-file diff but cut from one budget shared by " +
        'every file of the call. Empty only when nothing changed.',
    ),
  diffCondensed: z.boolean(),
  diffTruncated: z.boolean(),
  rewriteMode: rewriteModeSchema,
  preservedEdits: z.number(),
  commentMatches: z.array(commentMatchSchema).optional(),
});

const outputSchema = {
  path: z.string().optional().describe('The edited file. Absent for a `files` call (see files).'),
  appliedEdits: z.number().describe('Edits applied — across every file for a `files` call.'),
  diff: z
    .string()
    .optional()
    .describe(
      'Confirmation diff of what THIS call changed (the file as the call found it → as it ' +
        'left it, 2 lines of context), not the file against HEAD — so earlier uncommitted edits ' +
        'are not repeated, and a local project gets one too. A line longer than 240 characters ' +
        'is cut around its change, the rest shown as …[N chars]… (see diffCondensed). Budgeted ' +
        '(#153): a large patch comes back cut at hunk boundaries with a "... N of M hunk(s) ' +
        'omitted" marker — call diff for the whole one. Empty only when nothing changed; never ' +
        'empty merely because it was cut. Absent for a `files` call (each file carries its own).',
    ),
  diffCondensed: z
    .boolean()
    .optional()
    .describe(
      'True when a long line in diff was cut around its change, so diff is a confirmation to ' +
        'read, not a patch to apply. Absent for a `files` call.',
    ),
  diffTruncated: z
    .boolean()
    .optional()
    .describe(
      'True iff the confirmation diff above was cut to fit its budget. Absent for a `files` call.',
    ),
  rewriteMode: rewriteModeSchema
    .optional()
    .describe(
      'The mode that actually applied for this call. Absent for a `files` call (per file there).',
    ),
  preservedEdits: z.number().describe('Edits preserved as comments — across every file.'),
  compile: compileSummarySchema.optional(),
  commentMatches: z
    .array(commentMatchSchema)
    .optional()
    .describe(
      'One entry per edit that set excludeComments, so a skipped match is never silent. Absent ' +
        'when no edit did, and for a `files` call (per file there).',
    ),
  files: z
    .array(fileResultSchema)
    .optional()
    .describe('A `files` call only: one entry per file, in the order given.'),
};

/** Parse one inline edit with the same schema an `edits` element goes through. */
function parseInlineEdit(raw: Record<string, unknown>): AnyEditOp {
  const parsed = editItemSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `The inline edit (${Object.keys(raw).join(', ')}) is neither a string edit ` +
        '{oldString, newString, replaceAll?, excludeComments?} nor a line range ' +
        '{startLine, endLine, newString}; give exactly one of the two shapes.',
    );
  }
  return parsed.data;
}

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
        'is left untouched. Preferred over write_file for existing files. When the file keeps ' +
        'commented-out old versions of its prose (% lines), set excludeComments: true on an ' +
        'edit so it matches only the live text. A single edit may be given inline beside path ' +
        'instead of in edits, and several files can be edited in one all-or-nothing call with ' +
        'files.',
      inputSchema,
      outputSchema,
    },
    async (args) => {
      const { project, overrideExternalChanges, confirmBibEdit, preserveOriginal } = args;
      const { compile, resolveComments } = args;
      const flags = { confirmBibEdit, overrideExternalChanges, preserveOriginal };
      try {
        assertCompileRequested(compile, resolveComments);
        const { multi, files } = normalizeEditArgs(args, parseInlineEdit);
        for (const f of files) assertBibConfirmedByName(f.path, flags);
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        const written = await ctx.projectManager.runExclusive(id, async () => {
          if (!multi) {
            const [only] = files;
            if (!only) throw new Error('No file to edit.');
            const planned = await planFileEdit(ctx, id, dir, only.path, only.edits, flags);
            const res = await ctx.files.writeEditPlan(planned.plan);
            const diff = planEditDiff(
              planned.plan.original,
              planned.plan.content,
              planned.diffPath,
            );
            const headline = editHeadline(planned, res);
            // Both channels render from the same budgeted plan, never from the full patch.
            const structured: Record<string, unknown> = {
              ...res,
              diff: diff.diff,
              diffTruncated: diff.truncated,
              diffCondensed: diff.condensed,
              rewriteMode: planned.effectiveMode,
              preservedEdits: planned.preservedEdits,
            };
            return {
              content: [
                {
                  type: 'text' as const,
                  text: diff.diff ? `${headline}\n\n${diff.diff}` : headline,
                },
              ],
              structuredContent: structured,
            };
          }
          await assertDistinctFiles(
            dir,
            files.map((f) => f.path),
          );
          // Plan EVERY file before writing any: a refusal anywhere leaves every file untouched.
          const planned: PlannedFileEdit[] = [];
          for (const [k, f] of files.entries()) {
            try {
              planned.push(await planFileEdit(ctx, id, dir, f.path, f.edits, flags));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              throw new Error(
                `files[${k + 1}] ${quoteId(f.path)}: ${msg} Nothing was written to any file.`,
                { cause: err },
              );
            }
          }
          const results = await ctx.files.writeEditPlans(planned.map((p) => p.plan));
          // One budget across every file's confirmation diff (see `planEditDiffs`).
          const diffs = planEditDiffs(
            planned.map((p) => ({
              before: p.plan.original,
              after: p.plan.content,
              relPath: p.diffPath,
            })),
          );
          const perFile = results.map((res, k) => {
            const p = planned[k] as PlannedFileEdit;
            const d = diffs[k] ?? { diff: '', truncated: false, condensed: false };
            return {
              ...res,
              diff: d.diff,
              diffCondensed: d.condensed,
              diffTruncated: d.truncated,
              rewriteMode: p.effectiveMode,
              preservedEdits: p.preservedEdits,
            };
          });
          const appliedEdits = perFile.reduce((n, f) => n + f.appliedEdits, 0);
          const preservedEdits = perFile.reduce((n, f) => n + f.preservedEdits, 0);
          // The text channel is rendered from the already-cut per-file diffs, never the full ones.
          const sections = perFile.map((f, k) => {
            const headline = editHeadline(planned[k] as PlannedFileEdit, f);
            return f.diff ? `${headline}\n\n${f.diff}` : headline;
          });
          const structured: Record<string, unknown> = {
            appliedEdits,
            preservedEdits,
            files: perFile,
          };
          return {
            content: [
              {
                type: 'text' as const,
                text: [
                  `applied ${appliedEdits} edit(s) across ${perFile.length} file(s)`,
                  ...sections,
                ].join('\n\n'),
              },
            ],
            structuredContent: structured,
          };
        });
        if (!compile) return written;
        // After the edit's lock is released (it is not re-entrant): the same build a separate
        // compile call would make, the project's stored defaults included.
        const built = summarizeCompile(await runCompile(ctx, { project: id, resolveComments }));
        return {
          content: [
            { type: 'text' as const, text: `${written.content[0]?.text ?? ''}\n\n${built.text}` },
          ],
          structuredContent: { ...written.structuredContent, compile: built.summary },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

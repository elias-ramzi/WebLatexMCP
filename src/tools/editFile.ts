import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { bibEditBlockedMessage, isBibFile } from '../lib/bib.js';
import { changeDiff, changedPath } from '../lib/changeDiff.js';
import {
  createPreserveTransform,
  resolveRewriteMode,
  supportsLineComments,
  DEFAULT_REWRITE_MODE,
  REWRITE_MODES,
} from '../lib/rewriteMode.js';
import type { RewriteMode } from '../lib/rewriteMode.js';

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
    .array(
      z.object({
        oldString: z
          .string()
          .describe('Exact text to replace (include enough context to be unique).'),
        newString: z.string().describe('Replacement text.'),
        replaceAll: z.boolean().optional().describe('Replace every occurrence (default false).'),
      }),
    )
    .min(1)
    .describe('Surgical string replacements, applied in order and atomically.'),
};

const outputSchema = {
  path: z.string(),
  appliedEdits: z.number(),
  diff: z.string(),
  rewriteMode: z
    .enum(REWRITE_MODES as unknown as [RewriteMode, ...RewriteMode[]])
    .describe('The mode that actually applied for this call.'),
  preservedEdits: z.number(),
};

export function registerEditFile(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'edit_file',
    {
      title: 'Edit a project file',
      description:
        'Apply surgical string-replacement edits to a file. Each oldString must match ' +
        'uniquely unless replaceAll is set. Edits apply atomically — if any fails, the file ' +
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
          const eligible =
            !anyBib &&
            supportsLineComments(relPath) &&
            (target === null || supportsLineComments(target));
          const effectiveMode: RewriteMode = eligible ? resolved.mode : 'off';

          const preserve = createPreserveTransform(effectiveMode);
          const res = await ctx.files.applyEdits(dir, relPath, edits, {
            overrideExternalChanges,
            preserve,
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
          return {
            content: [
              {
                type: 'text',
                text: diff ? `${headline}\n\n${diff}` : headline,
              },
            ],
            structuredContent: { ...res, diff, rewriteMode: effectiveMode, preservedEdits },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { bibEditBlockedMessage, isBibFile } from '../lib/bib.js';
import { changeDiff } from '../lib/changeDiff.js';
import {
  applyRewriteMode,
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
        'Note: preserving duplicates oldString into the file (as a commented-out block above the ' +
        'replacement), so a later edit_file call whose oldString still occurs verbatim in that ' +
        'preserved block will now match it too — it may be refused as non-unique, or with ' +
        'replaceAll silently rewrite the preserved comment as well.',
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
          // The only place the effective rewrite mode is derived (the `parseCompilerChoice`
          // lesson) — every other reader of "what mode applies" must call through here.
          const resolved = resolveRewriteMode({
            perCall: preserveOriginal,
            stored: await ctx.rewriteModes.get(id),
            envDefault: ctx.config.rewriteMode ?? DEFAULT_REWRITE_MODE,
          });
          // .bib never preserves (a narrowing on top of the confirmBibEdit gate above, not a
          // replacement for it), and preservation is meaningless outside %-comment documents.
          const eligible = !isBib && supportsLineComments(relPath);
          const effectiveMode: RewriteMode = eligible ? resolved.mode : 'off';

          const { edits: rewrittenEdits, preservedEdits } = applyRewriteMode(edits, effectiveMode);
          const res = await ctx.files.applyEdits(dir, relPath, rewrittenEdits, {
            overrideExternalChanges,
          });
          const diff = await changeDiff(ctx.projectManager, ctx.git, id, dir, relPath);
          let headline = `applied ${res.appliedEdits} edit(s) to ${res.path}`;
          if (preservedEdits > 0) {
            headline += ` (preserved the original text of ${preservedEdits} edit(s) as comments)`;
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

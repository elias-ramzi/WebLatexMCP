import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { bibEditBlockedMessage, isBibFile } from '../lib/bib.js';
import { changeDiff, changedPath } from '../lib/changeDiff.js';

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
    async ({ project, path: relPath, edits, overrideExternalChanges, confirmBibEdit }) => {
      try {
        if (isBibFile(relPath) && !confirmBibEdit) {
          throw new Error(bibEditBlockedMessage(relPath));
        }
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        return await ctx.projectManager.runExclusive(id, async () => {
          // Inside the lock, same reasoning as write_file: closes the peer window at no extra cost
          // since every mutator already takes this lock.
          const target = await ctx.files.linkTarget(dir, relPath);
          if (target !== null && isBibFile(target) && !confirmBibEdit) {
            throw new Error(bibEditBlockedMessage(relPath, target));
          }
          const res = await ctx.files.applyEdits(dir, relPath, edits, { overrideExternalChanges });
          // A write through an in-project link changed the target, so that is the path to diff.
          const diff = await changeDiff(
            ctx.projectManager,
            ctx.git,
            id,
            dir,
            changedPath(target, relPath),
          );
          const headline = `applied ${res.appliedEdits} edit(s) to ${res.path}`;
          return {
            content: [
              {
                type: 'text',
                text: diff ? `${headline}\n\n${diff}` : headline,
              },
            ],
            structuredContent: { ...res, diff },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

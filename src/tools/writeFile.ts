import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { bibEditBlockedMessage, isBibFile } from '../lib/bib.js';
import { changeDiff, changedPath } from '../lib/changeDiff.js';

const inputSchema = {
  project: z.string().optional(),
  path: z.string().describe('Path relative to the project root.'),
  content: z.string().describe('Full file content to write.'),
  createDirs: z.boolean().optional().describe('Create missing parent directories (default false).'),
  overrideExternalChanges: z
    .boolean()
    .optional()
    .describe(
      'Overwrite even if the file changed on disk since it was last read through this server ' +
        '(e.g. edited directly by the user). Prefer re-reading first; only set this to ' +
        'deliberately discard those on-disk changes.',
    ),
  confirmBibEdit: z
    .boolean()
    .optional()
    .describe(
      'Required to write a .bib file directly. Add references via add_citation instead; ' +
        'only set this after the user approves a manual bibliography change.',
    ),
};

const outputSchema = {
  path: z.string(),
  bytesWritten: z.number(),
  created: z.boolean(),
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
};

export function registerWriteFile(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'write_file',
    {
      title: 'Write a project file',
      description:
        'Create a new file or fully overwrite an existing one. Prefer edit_file for ' +
        'surgical changes to existing files.',
      inputSchema,
      outputSchema,
    },
    async ({
      project,
      path: relPath,
      content,
      createDirs,
      overrideExternalChanges,
      confirmBibEdit,
    }) => {
      try {
        if (isBibFile(relPath) && !confirmBibEdit) {
          throw new Error(bibEditBlockedMessage(relPath));
        }
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        return await ctx.projectManager.runExclusive(id, async () => {
          // Inside the lock: a peer session's own mutations take this same per-project lock, so
          // checking here (rather than before runExclusive) closes the window where a peer could
          // land a symlink onto refs.bib between the check and the write.
          const target = await ctx.files.linkTarget(dir, relPath);
          if (target !== null && isBibFile(target) && !confirmBibEdit) {
            throw new Error(bibEditBlockedMessage(relPath, target));
          }
          const res = await ctx.files.write(dir, {
            path: relPath,
            content,
            createDirs,
            overrideExternalChanges,
          });
          // A write through an in-project link changed the target, so that is the path to diff.
          const diff = await changeDiff(
            ctx.projectManager,
            ctx.git,
            id,
            dir,
            changedPath(target, relPath),
          );
          const headline = `${res.created ? 'created' : 'wrote'} ${res.path} (${res.bytesWritten} bytes)`;
          // Both channels render from the same budgeted plan, never from the full patch.
          return {
            content: [{ type: 'text', text: diff.diff ? `${headline}\n\n${diff.diff}` : headline }],
            structuredContent: { ...res, diff: diff.diff, diffTruncated: diff.truncated },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

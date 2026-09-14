import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { foldCase } from '../lib/caseFold.js';

const inputSchema = {
  project: z.string().optional(),
  paths: z
    .array(z.string())
    .optional()
    .describe('Limit the discard to these paths. Defaults to all changes.'),
  confirm: z
    .literal(true)
    .describe('Must be true — discarding permanently loses uncommitted changes.'),
};

const outputSchema = {
  discarded: z.boolean(),
};

export function registerDiscard(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'discard',
    {
      title: 'Discard uncommitted changes',
      description:
        'Revert the working tree to the last commit (and remove untracked files), optionally ' +
        'limited to paths. Destructive — requires confirm=true.',
      inputSchema,
      outputSchema,
    },
    async ({ project, paths }) => {
      try {
        ctx.projectManager.requireGitProject(project, 'discard changes in');
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        return await ctx.projectManager.runExclusive(id, async () => {
          const res = await ctx.git.discard(dir, paths);
          // The working tree was rewritten to HEAD; drop baselines so the reverted content
          // isn't later mistaken for an out-of-band user edit.
          ctx.files.resetBaselines(dir);
          // Discard is not session-scoped. A whole-tree discard (`paths` unset) throws away every
          // session's uncommitted work, so every session's *entire* record has to go too, or a
          // later edit gets misattributed (`clearAll`). A path-limited discard rewrites only the
          // named paths on disk, so it must settle only the records that describe those paths in
          // EVERY session — not this session's alone, and not the whole store either, or an
          // unrelated in-flight edit (a peer's `chapter.tex`, say) would stop being tracked even
          // though nothing happened to it, letting a later `scope: "paths"` commit sweep up that
          // peer's lines as if nobody owned them (`settleAll`). Folded the same way `commit`
          // folds names, and for the same reason: on an ignorecase clone a session's entry can be
          // keyed under a different spelling than the path the caller named.
          const fold = (await ctx.git.isCaseInsensitive(dir)) ? foldCase : undefined;
          if (paths?.length) {
            await ctx.shadows.settleAll(id, paths, fold);
          } else {
            await ctx.shadows.clearAll(id);
          }
          return {
            content: [{ type: 'text', text: 'discarded uncommitted changes' }],
            structuredContent: { ...res },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

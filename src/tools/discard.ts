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
  discarded: z
    .boolean()
    .describe(
      'Whether the call reached what it was given: false when every requested path matched ' +
        'nothing at all. NOT a claim that bytes were destroyed — a tracked path already ' +
        'identical to HEAD is reached and reported discarded.',
    ),
  missed: z
    .array(z.string())
    .describe(
      'Requested paths git matched nothing for — neither tracked nor present as an untracked ' +
        'file — in the spelling you asked for. These files are NOT gone: the discard could not ' +
        'reach them. Always present; empty when every path was reached, and always empty for a ' +
        'whole-tree discard, which names no path.',
    ),
};

export function registerDiscard(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'discard',
    {
      title: 'Discard uncommitted changes',
      description:
        'Revert the working tree to the last commit (and remove untracked files), optionally ' +
        'limited to paths. Destructive — requires confirm=true. Paths are matched literally, ' +
        'never as globs; any the repository does not know come back in `missed` rather than ' +
        'being reported as discarded.',
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
          // Deliberately every requested path, `res.missed` included, not just the reached ones:
          // a path git can match nothing for is exactly the wedged shadow entry `discard` is
          // documented (in `ignoredPaths`' refusal message) as the way out of — a record git
          // itself refuses to stage, e.g. one filed beyond a symlink. Narrowing the settle to
          // what git reached would close that escape hatch.
          const fold = (await ctx.git.isCaseInsensitive(dir)) ? foldCase : undefined;
          if (paths?.length) {
            await ctx.shadows.settleAll(id, paths, fold);
          } else {
            await ctx.shadows.clearAll(id);
          }
          // `missed` is omitted by the service when empty, so the ordinary `{ discarded: true }`
          // shape stays untouched for its other callers; normalise it here, because the wire
          // contract is better off with one shape a client never has to branch on.
          const missed = res.missed ?? [];
          // The lead has to match `discarded`: a call that reached nothing must not open with
          // the word "discarded", which is the whole complaint #127 was filed about.
          const text = missed.length
            ? `${res.discarded ? 'discarded uncommitted changes, EXCEPT' : 'discarded NOTHING'}: ` +
              `git matched nothing for ${missed.map((p) => `"${p}"`).join(', ')} — ` +
              `${missed.length === 1 ? 'that file is' : 'those files are'} still exactly as ` +
              'they were. Check the spelling (a path is matched literally, never as a glob) ' +
              'with `status` or `list_files`.'
            : 'discarded uncommitted changes';
          return {
            content: [{ type: 'text', text }],
            structuredContent: { ...res, missed },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

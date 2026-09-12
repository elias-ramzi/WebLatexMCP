import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { toPosix, resolveInside } from '../lib/paths.js';
import { uncoveredPaths, peerOwnership } from '../lib/commitPaths.js';
import { collectPeerShadows } from '../lib/peerAttribution.js';
import type { ShadowChange } from '../services/shadowStore.js';

const inputSchema = {
  project: z.string().optional(),
  message: z.string().min(1).describe('Commit message.'),
  paths: z
    .array(z.string())
    .optional()
    .describe(
      'Limit the commit to these paths. Defaults to every change in scope; required for scope "paths".',
    ),
  scope: z
    .enum(['session', 'all', 'paths'])
    .optional()
    .describe(
      'Which changes to commit. "session" (the default when this session has tracked changes) ' +
        "commits only what this session edited, leaving other sessions' in-flight work " +
        'uncommitted in the working tree. "all" commits every change in the clone, including ' +
        'other sessions\' and any made outside this server. "paths" commits exactly the files ' +
        'named in `paths` and nothing else — it refuses an empty list, and refuses a path a live ' +
        "session owns. Use it for work made outside this server (a script, the client's own " +
        'file tools) when a peer has in-flight work in the clone.',
    ),
  allowEmpty: z.boolean().optional().describe('Allow a commit with no changes.'),
};

const outputSchema = {
  committed: z.boolean(),
  sha: z.string(),
  filesChanged: z.number(),
  files: z.array(z.object({ path: z.string(), added: z.number(), removed: z.number() })),
  scope: z.enum(['session', 'all', 'paths']).describe('The scope actually applied.'),
  session: z.string().describe('Id of the session the commit was attributed to.'),
  leftUncommitted: z
    .array(z.string())
    .describe(
      'Files changed in the working tree but not committed, because they belong to another ' +
        'session or were edited outside this server. Meaningful for scope "session" and ' +
        '"paths"; always empty for scope "all".',
    ),
  conflicted: z
    .array(z.string())
    .describe(
      'Files this session still holds as excluded after the commit — whether or not `paths` ' +
        'named them — because this session and a commit changed the same lines, or because ' +
        "this session's own record of its change failed (see `unrecorded` for which). " +
        'Re-read them, redo the edit on the current content, then commit again — or take them ' +
        'deliberately with scope "all".',
    ),
  unrecorded: z
    .array(z.string())
    .describe(
      "Subset of `conflicted`: files excluded because this session's own record of its change " +
        'failed, not because of a collision. Take them with scope "all" or discard them.',
    ),
};

export function registerCommit(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'commit',
    {
      title: 'Commit changes',
      description:
        'Stage and commit changes locally. Does NOT push — use the push tool, after reviewing ' +
        "with status/diff, to send commits to Overleaf. By default commits only this session's " +
        'own edits, so parallel sessions working on different parts of the paper do not commit ' +
        'each other\'s half-finished work; pass scope "all" to commit everything in the clone, ' +
        'or scope "paths" to commit exactly a named set of files (refusing any a live peer owns).',
      inputSchema,
      outputSchema,
    },
    async ({ project, message, paths, scope, allowEmpty }) => {
      try {
        ctx.projectManager.requireGitProject(project, 'commit to');
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        return await ctx.projectManager.runExclusive(id, async () => {
          await ctx.sessions.touch(id);
          // HEAD may have moved since this session last wrote (a peer committed, or a pull
          // landed), so carry its shadow forward before deciding what to commit.
          await ctx.shadows.refresh(id, dir);
          const effective = scope ?? ((await ctx.shadows.hasChanges(id)) ? 'session' : 'all');

          const res =
            effective === 'session'
              ? await commitSession(ctx, id, dir, { message, paths, allowEmpty })
              : effective === 'paths'
                ? await commitPaths(ctx, id, dir, { message, paths, allowEmpty })
                : await commitEverything(ctx, dir, { message, paths, allowEmpty });

          // "all"/"paths" commit the working tree as it stands, taken deliberately — so whatever
          // this session's shadow said about a path just committed (including a sticky
          // conflicted/unrecorded flag) is settled by that act, not by a merge. "session" needs
          // nothing extra: the refresh below settles what landed the normal way.
          if (effective === 'all' || effective === 'paths') {
            const taken = settlePaths(paths);
            if (taken === 'everything') {
              // "all" with no paths: the whole tree was taken. Unreachable for "paths" (commitPaths
              // refuses an empty or "."-shaped list before anything is committed) — and even then
              // never widened to `clear`: a "paths" commit must not settle what it did not name,
              // and the commit has already landed, so throwing here would report an error for a
              // commit that happened.
              if (effective === 'all') await ctx.shadows.clear(id);
            } else {
              await ctx.shadows.settle(id, taken);
            }
          }

          // The commit moved HEAD (or the store was settled directly above): carry forward
          // whatever this session still tracks, then report what is left, not what was true
          // before the commit — under scope "all"/"paths" a path just taken must never be
          // reported as excluded.
          await ctx.shadows.refresh(id, dir);
          const remaining = await ctx.shadows.changes(id);
          const conflicted = remaining.filter((c) => c.conflicted).map((c) => c.path);
          const unrecorded = remaining.filter((c) => c.unrecorded).map((c) => c.path);
          const unrecordedSet = new Set(unrecorded);
          const collided = conflicted.filter((p) => !unrecordedSet.has(p));
          const added = res.files.reduce((sum, f) => sum + f.added, 0);
          const removed = res.files.reduce((sum, f) => sum + f.removed, 0);
          const headline =
            `committed ${res.sha.slice(0, 8)} — ${res.filesChanged} file(s), +${added} -${removed}, ` +
            `not yet pushed${
              effective === 'session'
                ? ` (session "${ctx.shadows.sessionId}")`
                : effective === 'paths'
                  ? ' (named paths)'
                  : ' (whole clone)'
            }`;
          const text = [
            headline,
            ...res.files.map((f) => `  ${f.path} +${f.added} -${f.removed}`),
            res.leftUncommitted.length
              ? `left uncommitted (not this session's): ${res.leftUncommitted.join(', ')}`
              : '',
            unrecorded.length
              ? `⚠ excluded — this session's change to ${unrecorded.join(', ')} could not be ` +
                'recorded (see the server log), so its shadow does not hold it. Commit with scope ' +
                '"all" to take the working tree as it stands, or discard those files.'
              : '',
            collided.length
              ? `⚠ excluded — this session and someone else changed the same lines of ` +
                `${collided.join(', ')}. Commit with scope "all" to take the working tree as ` +
                "it stands, or discard those files to drop this session's version."
              : '',
          ]
            .filter(Boolean)
            .join('\n');

          return {
            content: [{ type: 'text', text }],
            structuredContent: {
              committed: res.committed,
              sha: res.sha,
              filesChanged: res.filesChanged,
              files: res.files,
              scope: effective,
              session: ctx.shadows.sessionId,
              leftUncommitted: res.leftUncommitted,
              conflicted,
              unrecorded,
            },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

/**
 * What a `scope: "all"` commit took, in the spelling `ShadowStore.settle` matches on. `git add`
 * accepts `"."`, `""` and a leading `"./"` as "the whole tree" / "this directory", but
 * `coversPath` deliberately covers nothing for `"."`/`""`, so those spellings must map to
 * `clear` — otherwise an entry the caller just committed as it stands would linger and keep the
 * default scope refusing (the wedge `settle` exists to end). Exported for the unit test.
 */
export function settlePaths(paths: string[] | undefined): string[] | 'everything' {
  if (!paths || paths.length === 0) return 'everything';
  const normalized = paths.map((p) => toPosix(p).replace(/^(\.\/)+/, ''));
  if (normalized.some((p) => p === '' || p === '.')) return 'everything';
  return normalized;
}

interface CommitOutcome {
  committed: boolean;
  sha: string;
  filesChanged: number;
  files: Array<{ path: string; added: number; removed: number }>;
  leftUncommitted: string[];
  /**
   * Files this call itself excluded from the commit (populated only by `commitSession`, always
   * `[]` for `commitPaths`/`commitEverything`, which never consult the shadow store to decide
   * what to commit). Not what the tool reports: the handler re-derives `conflicted`/`unrecorded`
   * from `ctx.shadows` *after* the commit (and, for "all"/"paths", after settling what it just
   * took), since a path this call excluded may no longer be tracked at all by then.
   */
  conflicted: string[];
}

/** Commit only the changes this session made, from its shadow — peers' edits stay on disk. */
async function commitSession(
  ctx: AppContext,
  id: string,
  dir: string,
  opts: { message: string; paths?: string[]; allowEmpty?: boolean },
): Promise<CommitOutcome> {
  const all = await ctx.shadows.changes(id);
  const wanted = opts.paths?.length ? new Set(opts.paths.map(toPosix)) : null;
  const selected = wanted ? all.filter((c) => wanted.has(c.path)) : all;

  const missing = wanted ? [...wanted].filter((p) => !all.some((c) => c.path === p)) : [];
  if (missing.length > 0) {
    throw new Error(
      `Not changed by this session: ${missing.join(', ')}. ` +
        'Another session may own those changes — check status, or use scope "all".',
    );
  }

  const conflicted = selected.filter((c) => c.conflicted).map((c) => c.path);
  const unrecorded = selected.filter((c) => c.unrecorded).map((c) => c.path);
  const unrecordedSet = new Set(unrecorded);
  const collided = conflicted.filter((p) => !unrecordedSet.has(p));
  const committable = selected.filter((c) => !c.conflicted);
  if (committable.length === 0 && !opts.allowEmpty) {
    throw new Error(
      conflicted.length === 0
        ? 'Nothing to commit (this session has made no changes). Use scope "all" to commit ' +
            'changes made by other sessions or outside this server.'
        : unrecorded.length > 0 && collided.length > 0
          ? `Nothing to commit: every change is excluded — ${unrecorded.join(', ')} could not be ` +
            'recorded (see the server log for why), and this session and someone else changed ' +
            `the same lines of ${collided.join(', ')}. Commit with scope "all" to take the ` +
            "working tree as it stands, or discard those files to give up this session's version."
          : unrecorded.length > 0
            ? `Nothing to commit: every change could not be recorded (${unrecorded.join(', ')}) — ` +
              'see the server log for why. Commit with scope "all" to take the working tree as it ' +
              "stands, or discard those files to give up this session's version."
            : `Nothing to commit: every change is conflicted (${collided.join(', ')}) — this ` +
              'session and someone else changed the same lines, so which edit is whose cannot be ' +
              'decided here. Commit with scope "all" to take the working tree as it stands, or ' +
              "discard those files to give up this session's version.",
    );
  }

  const res = await ctx.git.commitContents(dir, {
    message: opts.message,
    files: committable.map((c: ShadowChange) => ({ path: c.path, content: c.content })),
    allowEmpty: opts.allowEmpty,
  });

  // Whatever is still dirty once our own content is committed is, by definition, not ours —
  // another session's in-flight work, or an edit made outside this server. Surface it, so the
  // commit never looks like it quietly missed something. A file can appear here even though we
  // just committed part of it: that is precisely the two-sessions-one-file case.
  const status = await ctx.git.status(dir);
  const leftUncommitted = [...new Set([...status.unstaged, ...status.untracked].map(toPosix))]
    .sort()
    .filter(Boolean);

  return { ...res, leftUncommitted, conflicted };
}

/** Commit every change in the clone — the pre-session behaviour, now opt-in. */
async function commitEverything(
  ctx: AppContext,
  dir: string,
  opts: { message: string; paths?: string[]; allowEmpty?: boolean },
): Promise<CommitOutcome> {
  const res = await ctx.git.commit(dir, opts);
  return { ...res, leftUncommitted: [], conflicted: [] };
}

/**
 * Commit exactly the named paths, and nothing else — for work made outside this server (a script,
 * the client's own file tools) when a peer has in-flight edits in the clone. Unlike "session" and
 * "all", this scope never reads the shadow store to decide what to commit; it stages named paths
 * from the working tree directly, via `git add` (from an index reset to HEAD first, so nothing a
 * hand `git add` or an interrupted `commitContents` call left staged rides along — see
 * `GitService.commit`'s `fromHead` option). What it does borrow from shadows is the ownership
 * check below: a live peer's shadow index says which files are *its* in-flight edits, and this
 * scope refuses to sweep those up, failing closed when a peer's index cannot be read.
 *
 * The coverage/ownership policy itself is pure and lives in `src/lib/commitPaths.ts` so it is
 * unit-testable without a git clone; this function stays thin plumbing around it.
 */
async function commitPaths(
  ctx: AppContext,
  id: string,
  dir: string,
  opts: { message: string; paths?: string[]; allowEmpty?: boolean },
): Promise<CommitOutcome> {
  if (!opts.paths || opts.paths.length === 0) {
    throw new Error(
      'scope "paths" needs a non-empty paths list — name exactly the files to commit. Use scope ' +
        '"all" to commit everything in the clone.',
    );
  }

  const normalized = [...new Set(opts.paths.map(toPosix))];
  for (const p of normalized) {
    if (p.startsWith('-')) throw new Error(`Invalid path: "${p}"`);
    // No symlink-escape check here (unlike FileService reads/writes): this scope never reads or
    // writes file content through FileService, only stages a pathspec with `git add`. Git stages a
    // symlink as a link entry (mode 120000) and refuses a pathspec that names a path beyond a
    // symlink ("is beyond a symbolic link"), so no bytes outside the clone are reachable this way —
    // exactly as scope "all" (plain `git add`) behaves today.
    resolveInside(dir, p); // throws before git ever sees a path that escapes the clone
  }

  const status = await ctx.git.status(dir);
  // `status.staged` rescues one case `unstaged`/`untracked` cannot: a path that is dirty only in
  // the index — worktree == index != HEAD, i.e. `git add`ed and not touched since — is still
  // committable, because `fromHead: true` resets the index to HEAD and then re-`add`s from the
  // working tree, which is exactly that path's content. A path staged and then reverted in the
  // working tree (worktree == HEAD again) is *not* committable: the same reset-then-add finds
  // nothing changed to stage, and git reports "Nothing to commit" when it was the only path
  // requested; alongside a genuinely dirty path the commit succeeds without it, and it is absent
  // from `leftUncommitted` too (neither unstaged nor untracked once reset). `status.staged`
  // including it here does not change either outcome, it only avoids refusing it earlier with a
  // misleading "not changed in the working tree".
  const dirty = [
    ...new Set([...status.unstaged, ...status.untracked, ...status.staged].map(toPosix)),
  ];
  const uncovered = uncoveredPaths(normalized, dirty);
  if (uncovered.length > 0) {
    throw new Error(
      `Nothing to commit at: ${uncovered.join(', ')} — not changed in the working tree. Paths ` +
        'are matched literally: no globs, exact case, and no ".." segments.',
    );
  }

  // Fail closed: a live peer's shadow says which of the dirty files are its in-flight edits.
  // An unreadable index is treated as owning everything requested, never as owning nothing.
  const peers = await ctx.sessions.livePeers(id);
  const entriesBySession = await collectPeerShadows(ctx.shadows, id, peers);
  const { owned, unreadable } = peerOwnership(normalized, peers, entriesBySession);
  if (unreadable.length > 0) {
    throw new Error(
      `Cannot tell what live session "${unreadable[0]}" owns (its change index is ` +
        'unreadable), so scope "paths" refuses. Wait for it, or take the working tree ' +
        'deliberately with scope "all".',
    );
  }
  if (owned.length > 0) {
    const named = owned.map((o) => `${o.path} ("${o.sessionId}")`).join(', ');
    throw new Error(
      `Owned by a live session: ${named}. Committing named paths would take that session's ` +
        'in-flight lines. Wait for it to commit, or take ownership deliberately with scope "all".',
    );
  }

  const res = await ctx.git.commit(dir, {
    message: opts.message,
    paths: normalized,
    allowEmpty: opts.allowEmpty,
    fromHead: true,
  });

  const statusAfter = await ctx.git.status(dir);
  const leftUncommitted = [
    ...new Set([...statusAfter.unstaged, ...statusAfter.untracked].map(toPosix)),
  ]
    .sort()
    .filter(Boolean);

  return { ...res, leftUncommitted, conflicted: [] };
}

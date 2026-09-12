import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { toPosix, resolveInside } from '../lib/paths.js';
import { uncoveredPaths, peerOwnership, coversPath } from '../lib/commitPaths.js';
import { collectPeerShadows } from '../lib/peerAttribution.js';
import { NothingToCommitError } from '../services/gitService.js';
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
  ignored: z
    .array(z.string())
    .describe(
      'Files git ignores (.gitignore / .git/info/exclude) that this call skipped — they are ' +
        'never committed by any scope and stay in the working tree. Empty for scope "all" ' +
        'without `paths` (git add -A skips them itself).',
    ),
  settled: z
    .array(z.string())
    .describe(
      'Files this session stopped tracking because this call took their paths deliberately ' +
        '(scope "all" or "paths"): after a commit that landed, or — when `committed` is false — ' +
        'because the working tree already matched HEAD for them, so there was nothing to commit ' +
        'and the stale record was dropped. Always empty for scope "session".',
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

          let res: CommitOutcome;
          // Files this call settled by taking their paths deliberately (scope "all"/"paths"),
          // either because a commit landed (populated below, after it does) or — the case issue
          // #66 item 2 exists for — because the working tree for those paths already equalled what
          // would have been staged, so GitService itself found nothing to commit. Always empty for
          // scope "session".
          let settled: string[] = [];
          if (effective === 'session') {
            res = await commitSession(ctx, id, dir, { message, paths, allowEmpty });
          } else {
            try {
              res =
                effective === 'paths'
                  ? await commitPaths(ctx, id, dir, { message, paths, allowEmpty })
                  : await commitEverything(ctx, dir, { message, paths, allowEmpty });
            } catch (err) {
              // `GitService.commit`/`commitContents` throw `NothingToCommitError` (a type, not a
              // message to match on) when there was nothing to stage for the paths in scope,
              // including when the working tree already equals HEAD — e.g. a `push` with
              // `message` already committed the content, or a hand revert. A caller reaching for
              // scope "all"/"paths" still means what those scopes mean: take the paths in scope
              // deliberately. With nothing to commit, "take" means dropping this session's stale
              // shadow record of them rather than leaving an `unrecorded`/`conflicted` entry
              // permanently wedged (issue #66 item 2) — never reachable any other way once the
              // content is already at HEAD. Anything else rethrows unchanged.
              if (!(err instanceof NothingToCommitError)) {
                throw err;
              }
              const taken = settlePaths(paths);
              if (taken === 'everything') {
                // Only reachable for scope "all" (commitPaths always requires a non-empty list).
                // Settle only if this session actually tracks something — an empty-tree "all" with
                // no shadow entries at all is a plain "nothing to commit", not a wedge to clear.
                if (!(await ctx.shadows.hasChanges(id))) throw err;
                const before = await ctx.shadows.changes(id);
                await ctx.shadows.clear(id);
                settled = before.map((c) => c.path);
              } else {
                const dropped = await ctx.shadows.settle(id, taken);
                // Named paths this session never tracked and that were not dirty either: a genuine
                // "nothing to commit", not a wedge — rethrow rather than claim a settlement.
                if (dropped.length === 0) throw err;
                settled = dropped;
              }
              const status = await ctx.git.status(dir);
              const leftUncommitted =
                effective === 'paths'
                  ? [...new Set([...status.unstaged, ...status.untracked].map(toPosix))]
                      .sort()
                      .filter(Boolean)
                  : [];
              res = {
                committed: false,
                sha: await ctx.git.headSha(dir),
                filesChanged: 0,
                files: [],
                leftUncommitted,
                conflicted: [],
                // Carried on the error by the tool's own throw sites (`withoutIgnored`): the paths
                // git ignores are why nothing was staged, and the result must say so structurally.
                ignored: err.ignored,
              };
            }
          }

          // "all"/"paths" commit the working tree as it stands, taken deliberately — so whatever
          // this session's shadow said about a path just committed (including a sticky
          // conflicted/unrecorded flag) is settled by that act, not by a merge. "session" needs
          // nothing extra: the refresh below settles what landed the normal way. Skipped when
          // `res.committed` is false: the catch above already settled directly (or deliberately
          // left nothing settled and rethrew) — running this again would be harmless (nothing left
          // to settle) but wasteful.
          if (res.committed && (effective === 'all' || effective === 'paths')) {
            const taken = settlePaths(paths);
            if (taken === 'everything') {
              // "all" with no paths: the whole tree was taken. Unreachable for "paths" (commitPaths
              // refuses an empty or "."-shaped list before anything is committed) — and even then
              // never widened to `clear`: a "paths" commit must not settle what it did not name,
              // and the commit has already landed, so throwing here would report an error for a
              // commit that happened.
              if (effective === 'all') {
                const before = await ctx.shadows.changes(id);
                await ctx.shadows.clear(id);
                settled = before.map((c) => c.path);
              }
            } else {
              settled = await ctx.shadows.settle(id, taken);
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
          // `headSha` reports a clone with no commits as the sentinel "unborn" — say so rather than
          // presenting the sentinel as if it were a commit id.
          const headAt = res.sha === 'unborn' ? 'no commits yet' : `HEAD ${res.sha.slice(0, 8)}`;
          const headline = res.committed
            ? `committed ${res.sha.slice(0, 8)} — ${res.filesChanged} file(s), +${added} -${removed}, ` +
              `not yet pushed${
                effective === 'session'
                  ? ` (session "${ctx.shadows.sessionId}")`
                  : effective === 'paths'
                    ? ' (named paths)'
                    : ' (whole clone)'
              }`
            : res.ignored.length
              ? `nothing to commit — every requested path is ignored by git (never committed by ` +
                `any scope): ${res.ignored.join(', ')}; settled this session's stale record of: ` +
                `${settled.join(', ')} (${headAt})`
              : 'nothing to commit — the working tree already matches HEAD for the requested paths; ' +
                `settled this session's stale record of: ${settled.join(', ')} ` +
                `(not yet pushed: ${headAt})`;
          const text = [
            headline,
            ...res.files.map((f) => `  ${f.path} +${f.added} -${f.removed}`),
            res.leftUncommitted.length
              ? `left uncommitted (not this session's): ${res.leftUncommitted.join(', ')}`
              : '',
            unrecorded.length
              ? `⚠ excluded — this session's change to ${unrecorded.join(', ')} could not be ` +
                'recorded (see the server log), so its shadow does not hold it. Commit with scope ' +
                `"all" to take the working tree as it stands,${discardHint(unrecorded)}`
              : '',
            collided.length
              ? `⚠ excluded — this session and someone else changed the same lines of ` +
                `${collided.join(', ')}. Commit with scope "all" to take the working tree as ` +
                `it stands,${discardHint(collided)}`
              : '',
            res.ignored.length
              ? `skipped — ignored by git (never committed by any scope): ${res.ignored.join(', ')}`
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
              ignored: res.ignored,
              settled,
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

/**
 * The precise remedy named by every `conflicted`/`unrecorded` refusal: the exact `discard` call
 * that gives up this session's version of the named paths, plus the reminder that a file already
 * matching HEAD does not even need that — scope "all"/"paths" alone settles the stale record (the
 * issue #66 item 2 fix, in the handler above). Named paths rather than "those files" so the
 * caller can act on the message without cross-referencing `conflicted`/`unrecorded` themselves.
 */
function discardHint(paths: string[]): string {
  return (
    ` or discard them (discard { paths: ${JSON.stringify(paths)}, confirm: true }) to give up ` +
    "this session's version. If the working tree already matches HEAD for a file, scope " +
    '"all" or scope "paths" naming it settles the record without a commit.'
  );
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
  /**
   * Files git ignores (`.gitignore`/`.git/info/exclude`) that this commit skipped.
   * `commitSession` finds these among its shadow entries directly. `commitPaths`/
   * `commitEverything` (only when `paths` was given) stage via `git add`, which refuses outright
   * to add an ignored pathspec rather than silently skipping it — `withoutIgnored` filters those
   * out before `git add` ever sees them, so they land here instead of surfacing as a raw git
   * error. `commitEverything` with no `paths` (`git add -A`) always reports `[]`: `git add -A`
   * already skips ignored paths itself.
   */
  ignored: string[];
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
  const committableAll = selected.filter((c) => !c.conflicted);

  // `commitContents` stages via `hash-object` + `update-index --add`, which — unlike `git add`
  // — consults no ignore rules at all. A file this session wrote that git ignores (e.g. a
  // skill's local-only note kept out of git via `.git/info/exclude`) must never ride along in
  // the default scope, so it is filtered out here, the same way `git add` would already have
  // skipped it under scope "all"/"paths".
  const ignored =
    committableAll.length > 0
      ? await ctx.git.ignoredPaths(
          dir,
          committableAll.map((c) => c.path),
          // `commitContents` resets the index to HEAD before staging, so "tracked" means HEAD.
          { tracked: 'head' },
        )
      : [];
  if (ignored.length > 0) {
    // Settle immediately, before any refusal below: an ignored path is never committed by any
    // scope, so it must stop wedging the default scope the same way a deliberate "all"/"paths"
    // take settles what it commits.
    await ctx.shadows.settle(id, ignored);
  }
  const ignoredSet = new Set(ignored);
  const committable = committableAll.filter((c) => !ignoredSet.has(c.path));

  if (committable.length === 0 && !opts.allowEmpty) {
    const ignoredSentence =
      `Nothing to commit: every change this session made is to a file git ignores ` +
      `(${ignored.join(', ')}) — ignored files are never committed by any scope. Use scope ` +
      '"all" to commit changes made by other sessions or outside this server.';

    if (ignored.length > 0 && conflicted.length === 0) {
      throw new Error(ignoredSentence);
    }

    const baseMessage =
      conflicted.length === 0
        ? 'Nothing to commit (this session has made no changes). Use scope "all" to commit ' +
          'changes made by other sessions or outside this server.'
        : unrecorded.length > 0 && collided.length > 0
          ? `Nothing to commit: every change is excluded — ${unrecorded.join(', ')} could not be ` +
            'recorded (see the server log for why), and this session and someone else changed ' +
            `the same lines of ${collided.join(', ')}. Commit with scope "all" to take the ` +
            `working tree as it stands,${discardHint([...unrecorded, ...collided])}`
          : unrecorded.length > 0
            ? `Nothing to commit: every change could not be recorded (${unrecorded.join(', ')}) — ` +
              `see the server log for why. Commit with scope "all" to take the working tree as it ` +
              `stands,${discardHint(unrecorded)}`
            : `Nothing to commit: every change is conflicted (${collided.join(', ')}) — this ` +
              'session and someone else changed the same lines, so which edit is whose cannot be ' +
              `decided here. Commit with scope "all" to take the working tree as it stands,${discardHint(collided)}`;

    throw new Error(ignored.length > 0 ? `${ignoredSentence} ${baseMessage}` : baseMessage);
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

  return { ...res, leftUncommitted, conflicted, ignored };
}

/**
 * Removes any of `paths` that git ignores, since `git add` — used by `commitEverything` and
 * `commitPaths` alike — refuses an ignored pathspec outright ("The following paths are
 * ignored… Use -f") rather than silently skipping it the way `git add -A` (no paths) does.
 * Returns the paths still safe to hand to `git add`, plus which of the requested ones were
 * dropped (`ignoredPaths` itself returns POSIX-normalised paths, so membership is checked on the
 * normalised form).
 */
async function withoutIgnored(
  ctx: AppContext,
  dir: string,
  paths: string[],
  tracked: 'head' | 'index',
): Promise<{ paths: string[]; ignored: string[] }> {
  if (paths.length === 0) return { paths, ignored: [] };
  const ignored = await ctx.git.ignoredPaths(dir, paths, { tracked });
  if (ignored.length === 0) return { paths, ignored };
  const ignoredSet = new Set(ignored);
  return { paths: paths.filter((p) => !ignoredSet.has(toPosix(p))), ignored };
}

/** Commit every change in the clone — the pre-session behaviour, now opt-in. */
async function commitEverything(
  ctx: AppContext,
  dir: string,
  opts: { message: string; paths?: string[]; allowEmpty?: boolean },
): Promise<CommitOutcome> {
  let paths = opts.paths;
  let ignored: string[] = [];
  if (paths && paths.length > 0) {
    // `git add` here runs over the live index (no `fromHead` — scope "all" commits the clone as it
    // stands, staged state included), so judge "tracked" the way that `git add` will.
    const filtered = await withoutIgnored(ctx, dir, paths, 'index');
    ignored = filtered.ignored;
    if (filtered.paths.length === 0) {
      throw new NothingToCommitError(
        `Nothing to commit: ${ignored.join(', ')} ignored by git (.gitignore / ` +
          '.git/info/exclude) — an ignored file is never committed by any scope.',
        ignored,
      );
    }
    paths = filtered.paths;
  }
  // Without `paths` this is a plain `git add -A`, which already honours .gitignore/
  // .git/info/exclude on its own — nothing is ever taken here that `ignoredPaths` would flag.
  const res = await ctx.git.commit(dir, { ...opts, paths });
  return { ...res, leftUncommitted: [], conflicted: [], ignored };
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
  let uncovered = uncoveredPaths(normalized, dirty);
  if (uncovered.length > 0) {
    // A path with nothing dirty in the working tree can still be this session's own tracked
    // change — e.g. an `unrecorded`/`conflicted` entry whose content already equals HEAD (a hand
    // commit or revert settled it before this call ever ran `git status`). That is not "nothing to
    // commit at this path": it is a stale shadow record this deliberate scope should be able to
    // settle (issue #66 item 2), so `git.commit` below gets the chance to say "nothing staged"
    // itself — which the handler turns into a settlement — rather than refusing here first with a
    // misleading "not changed in the working tree" for a path this session plainly did track.
    const tracked = (await ctx.shadows.changes(id)).map((c) => c.path);
    uncovered = uncovered.filter((p) => !tracked.some((t) => coversPath(p, t)));
  }
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

  // `git add` refuses outright (exit 1, "The following paths are ignored… Use -f") if any named
  // pathspec is ignored — unlike `git add -A`, which silently skips ignored paths. Drop them here
  // so an ignored-but-tracked-by-this-session path (the `coversPath` filter above lets a stale
  // shadow entry for one past the uncovered-paths refusal) never reaches `git add` as a raw error.
  // After the ownership check on purpose: a path a live peer owns is refused as owned, whatever
  // git thinks of it — the more informative answer, and one that settles nothing of ours.
  const { paths: stageable, ignored } = await withoutIgnored(ctx, dir, normalized, 'head');
  if (stageable.length === 0) {
    throw new NothingToCommitError(
      `Nothing to commit: ${ignored.join(', ')} ignored by git (.gitignore / .git/info/exclude) ` +
        '— an ignored file is never committed by any scope.',
      ignored,
    );
  }

  const res = await ctx.git.commit(dir, {
    message: opts.message,
    paths: stageable,
    allowEmpty: opts.allowEmpty,
    fromHead: true,
  });

  const statusAfter = await ctx.git.status(dir);
  const leftUncommitted = [
    ...new Set([...statusAfter.unstaged, ...statusAfter.untracked].map(toPosix)),
  ]
    .sort()
    .filter(Boolean);

  return { ...res, leftUncommitted, conflicted: [], ignored };
}

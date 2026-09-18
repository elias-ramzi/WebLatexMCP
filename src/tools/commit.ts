import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { toPosix, resolveInside } from '../lib/paths.js';
import { uncoveredPaths, peerOwnership, coversPath } from '../lib/commitPaths.js';
import { collectPeerShadows } from '../lib/peerAttribution.js';
import { foldCase } from '../lib/caseFold.js';
import { settleTakenPaths, settleNothingToCommit } from '../lib/commitSettle.js';
import { NothingToCommitError } from '../services/gitService.js';
import type { ShadowChange } from '../services/shadowStore.js';

// The settle policy now lives in `src/lib/commitSettle.ts`; re-exported here for its callers.
export { settlePaths } from '../lib/commitSettle.js';

const inputSchema = {
  project: z.string().optional(),
  message: z.string().min(1).describe('Commit message.'),
  paths: z
    .array(z.string())
    .optional()
    .describe(
      'Limit the commit to these paths. Defaults to every change in scope; required for scope ' +
        '"paths". Matched literally for every scope — no globs, exact spelling (case-folded only ' +
        'on a core.ignorecase clone).',
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
  sha: z
    .string()
    .describe(
      'Commit sha the clone is now at, as a full hex string — or the literal sentinel ' +
        '"unborn" for a clone with no commits yet (the text renders that as "no commits yet", ' +
        'never the sentinel itself).',
    ),
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
          // Computed once for this handler and reused by both `ctx.shadows.settle` call sites and,
          // threaded in, `commitEverything`'s own by-name comparisons: on an ignorecase clone a
          // taken path can be keyed differently in this session's shadow than the spelling
          // `commit` was given (or than HEAD's own spelling, which staging folds onto) — see
          // `nameFold`. Deliberately NOT "once per call": `commitSession` and `commitPaths` each
          // still resolve their own (issue #93 named `commitEverything` only, and widening a
          // no-behaviour-change fix is how it stops being one). Say what is true here — the whole
          // point of #93 was a comment that claimed more than the code did.
          const fold = await nameFold(ctx, dir);

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
                  : await commitEverything(ctx, id, dir, { message, paths, allowEmpty, fold });
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
              const rescued = await settleNothingToCommit(ctx.shadows, id, {
                scope: effective,
                paths,
                fold,
              });
              // Named paths this session never tracked and that were not dirty either (or an "all"
              // with no shadow entries at all): a genuine "nothing to commit", not a wedge —
              // rethrow rather than claim a settlement.
              if (rescued === null) throw err;
              settled = rescued;
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
            // `requireTracked: false`: this call site has never guarded on `hasChanges` — the
            // commit has already landed and the tree was taken deliberately, so an "all" take
            // clears unconditionally, `shadow.json` unlinked and all. See `settleTakenPaths`.
            settled = await settleTakenPaths(
              ctx.shadows,
              id,
              { scope: effective, paths, fold },
              { requireTracked: false },
            );
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
          // Three shapes for the "nothing landed" headline, judged by whether the settled paths
          // are entirely accounted for by `ignored` (issue #66 review, finding 2): all requested
          // paths ignored (the original text), none of them (the original "already matches HEAD"
          // text), or a mix — some skipped as ignored, the rest settled because the working tree
          // already matched HEAD for them. Conflating the two reasons under one sentence would
          // misreport why the ignored path(s) specifically were skipped.
          // `settled` carries shadow spellings and `ignored` the caller's; compare through the
          // same fold as everything else on an ignorecase clone.
          const nameKey = fold ?? ((p: string) => p);
          const ignoredSet = new Set(res.ignored.map(nameKey));
          const settledAllIgnored =
            settled.length > 0 && settled.every((p) => ignoredSet.has(nameKey(p)));
          const headline = res.committed
            ? `committed ${res.sha.slice(0, 8)} — ${res.filesChanged} file(s), +${added} -${removed}, ` +
              `not yet pushed${
                effective === 'session'
                  ? ` (session "${ctx.shadows.sessionId}")`
                  : effective === 'paths'
                    ? ' (named paths)'
                    : ' (whole clone)'
              }`
            : res.ignored.length === 0
              ? 'nothing to commit — the working tree already matches HEAD for the requested paths; ' +
                `settled this session's stale record of: ${settled.join(', ')} ` +
                `(not yet pushed: ${headAt})`
              : settledAllIgnored
                ? `nothing to commit — every requested path is ignored by git (never committed by ` +
                  `any scope): ${res.ignored.join(', ')}; settled this session's stale record of: ` +
                  `${settled.join(', ')} (${headAt})`
                : `nothing to commit — ${res.ignored.join(', ')} skipped as ignored by git (never ` +
                  `committed by any scope); nothing to commit for the rest of the requested paths ` +
                  `— the working tree already matches HEAD there; settled this session's stale ` +
                  `record of: ${settled.join(', ')} (${headAt})`;
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
 * The precise remedy named by every `conflicted`/`unrecorded` refusal: the exact `discard` call
 * that gives up this session's version of the named paths, plus the reminder that a file already
 * matching HEAD does not even need that — scope "all"/"paths" alone settles the stale record (the
 * issue #66 item 2 fix, in the handler above). Named paths rather than "those files" so the
 * caller can act on the message without cross-referencing `conflicted`/`unrecorded` themselves.
 */
function discardHint(paths: string[]): string {
  return (
    ` or discard them (discard { paths: ${JSON.stringify(paths)}, confirm: true }) to give up ` +
    "this session's version, which also throws away any other session's uncommitted work at " +
    'those paths. If the working tree already matches HEAD for a file, scope "all" or scope ' +
    '"paths" naming it settles the record without a commit.'
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
  // The same fold `commit`'s other scopes apply: on a `core.ignorecase` clone a caller naming
  // HEAD's `Notes.txt` means this session's entry keyed `notes.txt`; byte-exact elsewhere.
  const fold = (await nameFold(ctx, dir)) ?? ((p: string) => p);
  // Keyed by the folded name, valued by the caller's own spelling, so a refusal names what the
  // caller typed and never a folded form that may name no file.
  const wanted = opts.paths?.length
    ? new Map(opts.paths.map((p) => [fold(toPosix(p)), toPosix(p)] as const))
    : null;
  const selected = wanted ? all.filter((c) => wanted.has(fold(c.path))) : all;

  const missing = wanted
    ? [...wanted].filter(([key]) => !all.some((c) => fold(c.path) === key)).map(([, p]) => p)
    : [];
  if (missing.length > 0) {
    throw new Error(
      `Not changed by this session: ${missing.join(', ')}. ` +
        'Another session may own those changes — check status, or use scope "all".',
    );
  }

  // `commitContents` stages via `hash-object` + `update-index --add`, which — unlike `git add`
  // — consults no ignore rules at all. A file this session wrote that git ignores (e.g. a
  // skill's local-only note kept out of git via `.git/info/exclude`) must never ride along in
  // the default scope, so it is filtered out here, the same way `git add` would already have
  // skipped it under scope "all"/"paths". Checked over every `selected` entry, `conflicted` or
  // `unrecorded` ones included (issue #66 review, finding 1): an ignored file is never committed
  // by any scope, so a `conflicted`/`unrecorded` flag on one is meaningless — it can never be
  // resolved by taking it with scope "all" either, since scope "all" is `git add`, which skips an
  // ignored path just the same. Settling it here, before it is ever classified as `conflicted`/
  // `unrecorded` below, is what actually resolves it rather than leaving it recoverable only by
  // `discard`.
  const ignored =
    selected.length > 0
      ? await ctx.git.ignoredPaths(
          dir,
          selected.map((c) => c.path),
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
  // Everything below is judged only over the non-ignored remainder: an ignored-and-conflicted
  // entry was just settled above, so it must not reappear in `conflicted`/`unrecorded`/`collided`
  // (which the caller reads from this function's return, and the handler reads again afterward
  // from `ctx.shadows.changes` — already empty for it, since `settle` dropped the record).
  const notIgnored = selected.filter((c) => !ignoredSet.has(c.path));
  const conflicted = notIgnored.filter((c) => c.conflicted).map((c) => c.path);
  const unrecorded = notIgnored.filter((c) => c.unrecorded).map((c) => c.path);
  const unrecordedSet = new Set(unrecorded);
  const collided = conflicted.filter((p) => !unrecordedSet.has(p));
  const committable = notIgnored.filter((c) => !c.conflicted);

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
 *
 * Also normalises every returned path the way `settlePaths` does (`toPosix`, strip a leading
 * `./`), so both call sites hand `git add` — and `--literal-pathspecs`, which reads a path
 * literally, backslashes included — the same normal form regardless of how the caller spelled it.
 * `commitEverything` used to hand `git add` the caller's raw strings verbatim; on Windows a native
 * `sub\notes.tex` reached git unconverted, where `--literal-pathspecs` treats the backslash as
 * itself rather than a separator. `commitPaths` already normalised before calling here, so this is
 * a no-op there (idempotent on an already-POSIX, dot-stripped path).
 */
async function withoutIgnored(
  ctx: AppContext,
  dir: string,
  paths: string[],
  tracked: 'head' | 'index',
): Promise<{ paths: string[]; ignored: string[] }> {
  const normalized = paths.map((p) => toPosix(p).replace(/^(\.\/)+/, ''));
  if (normalized.length === 0) return { paths: normalized, ignored: [] };
  const ignored = await ctx.git.ignoredPaths(dir, normalized, { tracked });
  if (ignored.length === 0) return { paths: normalized, ignored };
  const ignoredSet = new Set(ignored);
  return { paths: normalized.filter((p) => !ignoredSet.has(p)), ignored };
}

/**
 * Names this session's shadow entries that a stageable requested DIRECTORY path silently swallows
 * — an entry strictly *under* one of `stageable` (never a path equal to one of them: those are
 * already judged by `withoutIgnored` above) that git itself would skip when staging that
 * directory. `git --literal-pathspecs add -- notes` does not fail the way it does for an ignored
 * path named directly ("The following paths are ignored… Use -f") — it silently omits the nested
 * ignored file, the same way `git add -A` always has. `commit`'s handler already settles this
 * session's record for every entry under a taken path once the commit lands (`ShadowStore.settle`,
 * by `coversPath`) regardless of whether git actually staged it — so the file was never committed
 * and, before this, never named under `ignored` either (issue #66 review, finding 2). This adds
 * only the *report*: it changes nothing about what `git add` stages or what `settle` drops.
 */
/**
 * The name comparison the tool layer must use for this clone: git's own ASCII case fold when the
 * repository is case-insensitive (`core.ignorecase`, git's default on macOS/Windows clones), where
 * a peer's shadow key `notes.txt` and git's `Notes.txt` name one file — else `undefined`, i.e.
 * byte-exact, which is also what every `--literal-pathspecs` call downstream does. Deciding this
 * here, once per call, keeps `src/lib/commitPaths.ts` pure and keeps the fold gated on the one
 * source of truth (`GitService.isCaseInsensitive`).
 */
async function nameFold(
  ctx: AppContext,
  dir: string,
): Promise<((p: string) => string) | undefined> {
  return (await ctx.git.isCaseInsensitive(dir)) ? foldCase : undefined;
}

/**
 * Appends `nested` (shadow spellings) to `ignored` (caller spellings) without listing one file
 * twice under two spellings on an ignorecase clone — the same fold as every other comparison.
 */
function mergeIgnored(ignored: string[], nested: string[], fold?: (p: string) => string): void {
  const key = fold ?? ((p: string) => p);
  const seen = new Set(ignored.map(key));
  for (const p of nested) {
    if (!seen.has(key(p))) {
      ignored.push(p);
      seen.add(key(p));
    }
  }
}

async function ignoredUnderRequestedDirs(
  ctx: AppContext,
  dir: string,
  id: string,
  stageable: string[],
  tracked: 'head' | 'index',
  fold?: (p: string) => string,
): Promise<string[]> {
  const tracked_ = (await ctx.shadows.changes(id)).map((c) => c.path);
  const candidates = tracked_.filter((p) =>
    stageable.some((req) => req !== p && coversPath(req, p, fold)),
  );
  if (candidates.length === 0) return [];
  return ctx.git.ignoredPaths(dir, candidates, { tracked });
}

/**
 * Commit every change in the clone — the pre-session behaviour, now opt-in.
 *
 * `opts.fold` is the handler's already-resolved name fold (see `nameFold`), passed in rather than
 * re-derived here: the answer cannot change within one call, and deriving it per branch is what
 * lets a second, differently-derived answer appear (issue #93). Only the `paths` branch uses it;
 * `git add -A` compares no names of its own.
 */
async function commitEverything(
  ctx: AppContext,
  id: string,
  dir: string,
  opts: {
    message: string;
    paths?: string[];
    allowEmpty?: boolean;
    fold?: (p: string) => string;
  },
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
    // Finding 2: a requested directory can itself be stageable while silently swallowing a
    // nested ignored entry this session tracks — name it too.
    const nested = await ignoredUnderRequestedDirs(ctx, dir, id, paths, 'index', opts.fold);
    mergeIgnored(ignored, nested, opts.fold);
  }
  // Without `paths` this is a plain `git add -A`, which already honours .gitignore/
  // .git/info/exclude on its own — nothing is ever taken here that `ignoredPaths` would flag.
  let res;
  try {
    // Spelled out rather than spread: `opts` now also carries the handler's `fold`, which is the
    // tool layer's own concern and never a `GitService.commit` option.
    res = await ctx.git.commit(dir, {
      message: opts.message,
      paths,
      allowEmpty: opts.allowEmpty,
    });
  } catch (err) {
    // `GitService.commit` itself throws a bare `NothingToCommitError()` (no `ignored`) when
    // staging the filtered set adds nothing — e.g. every non-ignored requested path already
    // matches HEAD. Carry the ignore list computed above onto it, or the handler reports
    // `ignored: []` and its headline claims nothing was ignored when something plainly was
    // (issue #66 review, finding 2).
    if (err instanceof NothingToCommitError && ignored.length > 0) {
      throw new NothingToCommitError(err.message, ignored);
    }
    throw err;
  }
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

  const normalized = [...new Set(opts.paths.map((p) => toPosix(p).replace(/^(\.\/)+/, '')))];
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
  // `rescued`: requested paths that cover nothing dirty in the working tree, but that this
  // deliberate scope still lets through the refusal below because this session's own shadow still
  // tracks them (a stale `unrecorded`/`conflicted` entry a hand commit or revert already settled at
  // HEAD — issue #66 item 2). Kept separate from `normalized` from here on: a rescued path stages
  // nothing by definition (there is no dirty content on disk or in the index to add), so handing it
  // to `git add` below would either no-op (harmless) or, when nothing at all is left on disk for
  // it (a deleted file), fatal raw ("did not match any files") — issue #66 review, finding 1. It
  // stays in `normalized` for the peer-ownership check just below (still "requested"), and the
  // handler settles every originally-requested path regardless (`settlePaths(paths)` over the
  // tool's own input, not this function's `stageable`).
  // Every by-name comparison below folds case exactly when git does (`core.ignorecase`), and
  // stays byte-exact otherwise — see `nameFold`.
  const fold = await nameFold(ctx, dir);
  const uncoveredInitial = uncoveredPaths(normalized, dirty, fold);
  let rescued: string[] = [];
  if (uncoveredInitial.length > 0) {
    const tracked = (await ctx.shadows.changes(id)).map((c) => c.path);
    const stillUncovered = uncoveredInitial.filter(
      (p) => !tracked.some((t) => coversPath(p, t, fold)),
    );
    if (stillUncovered.length > 0) {
      throw new Error(
        `Nothing to commit at: ${stillUncovered.join(', ')} — not changed in the working tree. ` +
          'Paths are matched literally: no globs, exact case, and no ".." segments.',
      );
    }
    rescued = uncoveredInitial;
  }

  // Fail closed: a live peer's shadow says which of the dirty files are its in-flight edits.
  // An unreadable index is treated as owning everything requested, never as owning nothing.
  const peers = await ctx.sessions.livePeers(id);
  const entriesBySession = await collectPeerShadows(ctx.shadows, id, peers);
  const { owned, unreadable } = peerOwnership(normalized, peers, entriesBySession, fold);
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
  // git thinks of it — the more informative answer, and one that settles nothing of ours. Checked
  // over the full `normalized` list (rescued paths included) so a genuinely ignored-and-tracked
  // path is reported as ignored, not silently dropped for covering nothing dirty.
  const { paths: notIgnored, ignored } = await withoutIgnored(ctx, dir, normalized, 'head');
  // Only a path that actually covers something dirty may reach `git add` — a rescued path (see
  // above) is excluded here even when it is not ignored, since it stages nothing either way.
  const rescuedSet = new Set(rescued);
  const stageable = notIgnored.filter((p) => !rescuedSet.has(p));
  // Finding 2: a requested directory can itself be stageable (not ignored) while silently
  // swallowing a nested ignored entry this session tracks underneath it — `git add -- notes`
  // omits `notes/ig.md` without complaint, unlike naming it directly. Name it under `ignored` too
  // — `settle` below already drops its record regardless, so it was otherwise committed nowhere
  // and reported nowhere.
  // Over `notIgnored`, not `stageable`: a directory whose only session change beneath it is an
  // ignored file covers nothing dirty (git status never lists an ignored file), so it is a rescued
  // path — and the report must still name that file as ignored, not let the handler call it
  // "already matches HEAD". The helper only reports; nothing about staging depends on its input.
  const nested = await ignoredUnderRequestedDirs(ctx, dir, id, notIgnored, 'head', fold);
  mergeIgnored(ignored, nested, fold);
  if (stageable.length === 0) {
    throw new NothingToCommitError(
      ignored.length > 0
        ? `Nothing to commit: ${ignored.join(', ')} ignored by git (.gitignore / ` +
            '.git/info/exclude) — an ignored file is never committed by any scope.'
        : 'Nothing to commit: the requested paths matched nothing to stage.',
      ignored,
    );
  }

  let res;
  try {
    res = await ctx.git.commit(dir, {
      message: opts.message,
      paths: stageable,
      allowEmpty: opts.allowEmpty,
      fromHead: true,
    });
  } catch (err) {
    // Same carry-forward as `commitEverything`: `GitService.commit` can still throw a bare
    // `NothingToCommitError()` (e.g. a peer's commit landed the same content between our `status`
    // above and this `add`), and the ignore list computed above must not be lost when it does.
    if (err instanceof NothingToCommitError && ignored.length > 0) {
      throw new NothingToCommitError(err.message, ignored);
    }
    throw err;
  }

  const statusAfter = await ctx.git.status(dir);
  const leftUncommitted = [
    ...new Set([...statusAfter.unstaged, ...statusAfter.untracked].map(toPosix)),
  ]
    .sort()
    .filter(Boolean);

  return { ...res, leftUncommitted, conflicted: [], ignored };
}

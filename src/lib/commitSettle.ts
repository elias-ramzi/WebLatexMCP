import { toPosix } from './paths.js';

/**
 * The slice of `ShadowStore` the settle policy touches — declared structurally so the policy can
 * be unit-tested against a temp-dir store (or a stub) without an MCP round trip. `commit`'s
 * handler passes `ctx.shadows` itself; nothing here needs the rest of the store's surface.
 */
export interface SettleStore {
  hasChanges(projectId: string): Promise<boolean>;
  changes(projectId: string): Promise<Array<{ path: string }>>;
  clear(projectId: string): Promise<void>;
  settle(projectId: string, paths: string[], fold?: (p: string) => string): Promise<string[]>;
}

/** What a deliberate scope "all"/"paths" commit took, and how names compare on this clone. */
export interface SettleRequest {
  /** The scope actually applied. Only "all" and "paths" ever settle anything. */
  scope: 'all' | 'paths';
  /** The tool's own `paths` argument, exactly as the caller gave it (unnormalised). */
  paths: string[] | undefined;
  /**
   * git's own ASCII case fold (`foldCase`, `src/lib/caseFold.ts`), passed by the caller ONLY when
   * `GitService.isCaseInsensitive` says so — never decided here, so these functions stay pure with
   * respect to the clone. Undefined means byte-exact, which is what every `--literal-pathspecs`
   * call downstream does too.
   */
  fold?: (p: string) => string;
}

/**
 * What a `scope: "all"` commit took, in the spelling `ShadowStore.settle` matches on. `git add`
 * accepts `"."`, `""` and a leading `"./"` as "the whole tree" / "this directory", but
 * `coversPath` deliberately covers nothing for `"."`/`""`, so those spellings must map to
 * `clear` — otherwise an entry the caller just committed as it stands would linger and keep the
 * default scope refusing (the wedge `settle` exists to end).
 */
export function settlePaths(paths: string[] | undefined): string[] | 'everything' {
  if (!paths || paths.length === 0) return 'everything';
  const normalized = paths.map((p) => toPosix(p).replace(/^(\.\/)+/, ''));
  if (normalized.some((p) => p === '' || p === '.')) return 'everything';
  return normalized;
}

/**
 * Settle this session's shadow for what a deliberate scope "all"/"paths" commit just took.
 *
 * "all"/"paths" commit the working tree as it stands, taken deliberately — so whatever this
 * session's shadow said about a path just committed (including a sticky `conflicted`/`unrecorded`
 * flag) is settled by that act, not by a merge. Nothing here clears a flag: `ShadowStore.settle`
 * and `clear` drop the whole entry, which is the remedy every conflicted/unrecorded message
 * names. Scope "session" never calls this — a refresh settles what landed the normal way.
 *
 * **Settling by requested-path coverage, not by what git staged, is DELIBERATE** (issue #66,
 * finding 5). A `scope: "paths"` commit naming a directory drops every shadow entry under it —
 * including one git skipped because it is ignored, or because its content already equals HEAD.
 * That is exactly what un-wedges an already-reconciled entry, and it is why `settle` is given the
 * *requested* paths and never the committed file list. Do not "improve" it.
 *
 * `opts.requireTracked` selects between the two callers' long-standing behaviour, which differs in
 * exactly one case: an `"all"` take of the whole tree by a session that tracks nothing. It is a
 * parameter, not a rule decided here, because each behaviour is the right one for its own caller
 * and neither was invented by this module — the extraction preserves both rather than unifying
 * them and calling the difference unobservable.
 *
 * - `false` — the post-commit take. `clear` runs unconditionally, as that call site always has:
 *   the commit has already landed and the whole tree was taken deliberately, so there is nothing
 *   left to guard against. The guard is deliberately NOT borrowed here. `clear` unlinks
 *   `shadow.json`, and "absent" versus "readable and empty" is a distinction `peerEntries` is
 *   being taught to keep (issue #78, finding 3); skipping the unlink would quietly change what a
 *   peer reports the moment it does.
 * - `true` — the `NothingToCommitError` rescue, which has always guarded. Nothing was committed,
 *   so an `"all"` against a session with no shadow entries at all is a plain "nothing to commit",
 *   not a wedge to clear: return `[]` without calling `clear`, which `settleNothingToCommit` turns
 *   into the `null` its caller rethrows on.
 *
 * Returns the paths whose records were dropped (shadow spellings), or `[]` when this request
 * covered nothing this session tracks.
 */
export async function settleTakenPaths(
  shadows: SettleStore,
  projectId: string,
  req: SettleRequest,
  opts: { requireTracked: boolean },
): Promise<string[]> {
  const taken = settlePaths(req.paths);
  if (taken === 'everything') {
    // "all" with no paths: the whole tree was taken. Unreachable for "paths" (`commitPaths`
    // refuses an empty or "."-shaped list before anything is committed) — and even then never
    // widened to `clear`: a "paths" take must never settle what it did not name.
    if (req.scope !== 'all') return [];
    // See `opts.requireTracked` above: the rescue settles only if this session actually tracks
    // something, while the post-commit take clears unconditionally, exactly as each always has.
    if (opts.requireTracked && !(await shadows.hasChanges(projectId))) return [];
    const before = await shadows.changes(projectId);
    await shadows.clear(projectId);
    return before.map((c) => c.path);
  }
  // `req.fold` is threaded through, never dropped: on a `core.ignorecase` clone this session's
  // entry can be keyed under a different spelling than the one `commit` was asked to take, and
  // without the fold that entry never matches — it stays wedged forever even though the commit
  // meant to resolve it landed.
  return await shadows.settle(projectId, taken, req.fold);
}

/**
 * The same take, for the `NothingToCommitError` rescue (issue #66 item 2): `GitService` found
 * nothing to stage for the paths in scope — e.g. the working tree already equals HEAD because a
 * `push` with `message` already committed the content, or a hand revert did. A caller reaching
 * for scope "all"/"paths" still means what those scopes mean, so "take" here means dropping this
 * session's stale record rather than leaving an `unrecorded`/`conflicted` entry permanently
 * wedged — never reachable any other way once the content is already at HEAD.
 *
 * Identical to `settleTakenPaths` but for the empty case: `null` — never `[]` — means this
 * request covered nothing this session tracks, a genuine "nothing to commit" rather than a wedge,
 * and the caller must rethrow the original error instead of claiming a settlement. Delegates, so
 * the two can never drift over what a take settles; `requireTracked: true` is this rescue's own
 * long-standing guard, described on `settleTakenPaths`.
 */
export async function settleNothingToCommit(
  shadows: SettleStore,
  projectId: string,
  req: SettleRequest,
): Promise<string[] | null> {
  const dropped = await settleTakenPaths(shadows, projectId, req, { requireTracked: true });
  return dropped.length === 0 ? null : dropped;
}

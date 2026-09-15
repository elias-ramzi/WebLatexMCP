import type { GitService, StatusResult } from '../services/gitService.js';
import { LocalChangesOverwriteError, UntrackedOverwriteError } from '../services/gitService.js';
import type { ShadowStore } from '../services/shadowStore.js';
import type { SessionRegistry } from '../services/sessionRegistry.js';
import { toPosix } from './paths.js';
import { foldCase } from './caseFold.js';
import {
  attributePeers,
  collectPeerShadows,
  composeClosing,
  renderPeerRefusal,
  type ClosingVocabulary,
} from './peerAttribution.js';

/**
 * Dependencies `guardPeerWork`/`enrichPullRefusal` need — narrowed with `Pick` so a test can stub
 * just the methods used, without constructing a real `GitService`/`SessionRegistry`/`ShadowStore`.
 */
export interface PeerRefusalDeps {
  sessions: Pick<SessionRegistry, 'livePeers'>;
  shadows: ShadowStore;
  git: Pick<GitService, 'status' | 'isCaseInsensitive'>;
}

/**
 * Dedupes `items` by `fold(item)`, keeping the first-seen original spelling for display. Plain
 * `Set` dedupe on the raw strings is only correct when every occurrence of one file is spelled
 * identically; on a `core.ignorecase` clone git can instead report the same file under two
 * different spellings across two different lists (a staged `A.tex`, an unstaged `a.tex`), and
 * deduping before folding would let both survive into what should be one disputed entry. Shared by
 * `guardPeerWork` below and `status`'s own dirty-set build (`src/tools/status.ts`), which must
 * dedupe the same way.
 */
export function dedupeFolded(items: string[], fold: (p: string) => string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = fold(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Refuse to push while a live sibling session has uncommitted work in the shared clone.
 *
 * A push has to rebase, and a rebase needs a clean tree — so pushing here would mean either
 * sweeping that session's half-finished paragraph into our commit or rewriting the tree
 * underneath it. Neither is ours to do, so we stop and name who to wait for.
 *
 * The refusal attributes each disputed file to whichever live peer's shadow lists it (see
 * `attributePeers` in `src/lib/peerAttribution.ts`) and dates each peer's last write. A file no
 * live peer owns — edited outside this server, or left behind by a session that has since exited
 * — is named as unowned rather than pinned on anyone, but it still blocks the push as long as any
 * live peer exists: this guard is not owner-aware about *whether* to refuse, only about how it
 * explains the refusal.
 */
export async function guardPeerWork(deps: PeerRefusalDeps, id: string, dir: string): Promise<void> {
  const peers = await deps.sessions.livePeers(id);
  if (peers.length === 0) return;

  const status: StatusResult = await deps.git.status(dir);
  // On a `core.ignorecase` clone git reports a dirty file in the index's spelling while a shadow
  // key carries the spelling the session wrote it under; fold both the way git does there, and
  // compare byte-for-byte everywhere else (the same rule `commit` scope "paths" applies). Computed
  // before the dedupe below, not after: on such a clone the three git lists can name the very same
  // file under two different spellings (e.g. `A.tex` staged, `a.tex` unstaged), and deduping on the
  // raw string would let both survive as if they were two files.
  const fold = (await deps.git.isCaseInsensitive(dir)) ? foldCase : (p: string) => p;
  // `status.staged` joins the set for the same reason `status`'s own `otherChanges` does (see
  // `src/tools/status.ts`): a path dirty only in the index — a hand `git add`, or an interrupted
  // `commitContents` — is still uncommitted work a rebase would have to sweep up or overwrite, and
  // this disputed set is documented (`renderPeerRefusal`) as built exactly the way `otherChanges`
  // is. Deduped on the folded key, keeping the first-seen spelling for display — a path can be
  // both staged and unstaged, or (on an ignorecase clone) reported under two spellings.
  const dirty = dedupeFolded(
    [...status.unstaged, ...status.untracked, ...status.staged].map(toPosix),
    fold,
  );
  if (dirty.length === 0) return;

  const mine = new Set((await deps.shadows.changes(id)).map((c) => fold(c.path)));
  const theirs = dirty.filter((p) => !mine.has(fold(p)));
  if (theirs.length === 0) return;

  const attribution = attributePeers(
    theirs,
    peers,
    await collectPeerShadows(deps.shadows, id, peers),
    fold,
  );
  throw new Error(renderPeerRefusal(theirs, attribution, Date.now()));
}

/**
 * `project_sync`'s framing for the composed closing: pull vocabulary (there is no rebase here —
 * `syncPull` is a plain `merge --ff-only`).
 *
 * Only the framing is local. Which commit route applies to which group is composed by
 * `composeClosing` from the attribution, exactly as `push`'s closing is: this used to be a static
 * paragraph offering `scope: "paths"` first, which bounces off `commit`'s peer guard for any path a
 * live session owns — the same dead advice that guard exists to give, one message over. The typed
 * `LocalChangesOverwriteError` above still prescribes `scope: "paths"` for the collision as a
 * whole, which is right for the common case of the caller's own edits; this paragraph is what
 * corrects it for the subset a peer turns out to own.
 *
 * `retry` does NOT say "sync again": once the owner (or the caller, via `commit scope: "all"`/
 * `"paths"`) commits, `syncPull` reports `action: 'diverged'` for any commit ahead of the remote
 * (`GitService.syncPull` returns diverged whenever `ahead > 0`) — a fast-forward pull can never
 * land a local commit. The route that actually goes forward from there is `push`, whose rebase
 * replays the commit onto the remote and surfaces a real conflict if the lines collided, so that is
 * what the closing tells the caller to do next.
 */
export const PULL_VOCABULARY: ClosingVocabulary = {
  opening:
    'The pull would overwrite this in-flight work. A recent last write means the owner is ' +
    'mid-edit: wait for it to commit.',
  retry:
    'Then push — once the work is committed, a sync would only report the histories as ' +
    'diverged; push rebases onto the remote and surfaces any real conflict.',
};

/**
 * A pull refused with `LocalChangesOverwriteError` (a tracked file's local modification) or a
 * pull-worded `UntrackedOverwriteError` (an untracked file the incoming fast-forward would
 * overwrite) names which file(s) block it, but not whose edits they are. Attribute each named path
 * to whichever live peer session's shadow claims it — same shape as push's `guardPeerWork`
 * (above) — so the caller can tell "wait for a mid-edit peer" from "these are my own uncommitted
 * changes". An untracked file can be a live peer's too: `write_file` of a brand-new path puts it in
 * that peer's shadow just as an edit to a tracked one would.
 *
 * A push-worded `UntrackedOverwriteError` (`operation === 'push'`, the default) is deliberately
 * NOT decorated here — this is pull vocabulary (`PULL_VOCABULARY`), and a push refusal reaching
 * this function would be decorated with the wrong framing ("the pull would overwrite…" on a push).
 * It falls through to the plain-passthrough branch below, same as any other error type.
 *
 * Paths this session itself owns (per its own shadow) are subtracted first, exactly as
 * `guardPeerWork` subtracts `mine` before attributing `theirs` — otherwise this session's own
 * edits would be reported as "not this session's", which is false. When nothing foreign remains
 * (or no live peer exists at all) there is nothing to attribute, so the plain typed message passes
 * through unchanged.
 *
 * `dir` is needed for exactly the reason it is in `guardPeerWork`: `typed.paths` arrives spelled
 * the way git's own stderr names it (the index's spelling), while a shadow key carries the
 * spelling the writing session used — on a `core.ignorecase` clone the two can differ, and
 * comparing byte-exact would miss the owner and report the path as unowned. Fold both sides the
 * same way `guardPeerWork` does, and pass the same `fold` into `attributePeers` so its `owns`
 * membership test agrees.
 *
 * The decoration itself can fail (an unreadable session dir, a transient fs error reading a peer's
 * shadow index) — that must never cost the caller the typed error it needs to act on, so any
 * failure past the `instanceof` check falls back to the original error unchanged rather than
 * replacing it.
 */
export async function enrichPullRefusal(
  deps: PeerRefusalDeps,
  id: string,
  dir: string,
  err: unknown,
): Promise<Error> {
  const fallback = err instanceof Error ? err : new Error(String(err));
  const decoratable =
    err instanceof LocalChangesOverwriteError ||
    (err instanceof UntrackedOverwriteError && err.operation === 'pull');
  if (!decoratable) return fallback;
  // TS narrows `err` to the union above only within this scope, hence a local typed alias.
  const typed = err as LocalChangesOverwriteError | UntrackedOverwriteError;
  if (typed.paths.length === 0) return fallback;
  try {
    const peers = await deps.sessions.livePeers(id);
    if (peers.length === 0) return fallback;

    const fold = (await deps.git.isCaseInsensitive(dir)) ? foldCase : (p: string) => p;
    const mine = new Set((await deps.shadows.changes(id)).map((c) => fold(c.path)));
    const theirs = typed.paths.filter((p) => !mine.has(fold(p)));
    if (theirs.length === 0) return fallback;

    const attribution = attributePeers(
      theirs,
      peers,
      await collectPeerShadows(deps.shadows, id, peers),
      fold,
    );
    const now = Date.now();
    const closing = composeClosing(attribution, PULL_VOCABULARY);
    return new Error(`${typed.message}\n\n${renderPeerRefusal(theirs, attribution, now, closing)}`);
  } catch {
    return fallback;
  }
}

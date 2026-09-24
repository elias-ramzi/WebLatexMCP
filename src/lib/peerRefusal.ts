import type { GitService, StatusResult } from '../services/gitService.js';
import { LocalChangesOverwriteError, UntrackedOverwriteError } from '../services/gitService.js';
import type { ShadowStore } from '../services/shadowStore.js';
import type { SessionRegistry } from '../services/sessionRegistry.js';
import { toPosix } from './paths.js';
import { foldCase } from './caseFold.js';
import type { PeerShadowEntry } from '../services/shadowStore.js';
import type { PeerSession } from '../services/sessionRegistry.js';
import {
  attributePeers,
  collectPeerShadows,
  composeClosing,
  renderPeerRefusal,
  PUSH_VOCABULARY,
  REFUSAL_PATH_CAP,
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
 * Splits `paths` (dirty paths, or the paths a pull names) into the ones a refusal must dispute.
 *
 * A path is disputed when this session's own shadow does NOT list it (someone else's work, or
 * nobody's) — or when it does, but a live peer's shadow lists it too, or a live peer's index is
 * unreadable (`null` means unreadable, never "owns nothing", so it may list anything). The second
 * half is the one that used to be missing: subtracting this session's paths first made a file both
 * sessions edited "ours", and a `push` carrying a `message` commits via `git add -A`, which swept
 * the peer's uncommitted lines in that file into our commit and pushed them. `commit scope:
 * "paths"` has always refused any path a live peer lists, even one the caller owns too
 * (`peerOwnership`, `src/lib/commitPaths.ts`); this is the same line, held for `push` and for the
 * pull refusal's attribution.
 *
 * `shared` is the subset of `disputed` this session's shadow also lists — reported separately so
 * the refusal can say those files carry this session's edits as well, and name the route that
 * takes only those (`commit`, default scope "session"). `sharedUnconfirmed` is true when at least
 * one of them is disputed only because a peer's index could not be read, so the wording does not
 * claim a peer edited a file nobody has shown it did.
 */
function disputedPaths(
  paths: string[],
  mine: Set<string>,
  peers: PeerSession[],
  entries: Map<string, PeerShadowEntry[] | null>,
  fold: (p: string) => string,
): { disputed: string[]; shared: string[]; sharedUnconfirmed: boolean } {
  let anyUnreadable = false;
  const peerListed = new Set<string>();
  for (const p of peers) {
    const list = entries.get(p.sessionId) ?? null;
    if (list === null) {
      anyUnreadable = true;
      continue;
    }
    for (const e of list) peerListed.add(fold(e.path));
  }
  const disputed: string[] = [];
  const shared: string[] = [];
  let sharedUnconfirmed = false;
  for (const p of paths) {
    const key = fold(p);
    if (!mine.has(key)) {
      disputed.push(p);
    } else if (peerListed.has(key)) {
      disputed.push(p);
      shared.push(p);
    } else if (anyUnreadable) {
      disputed.push(p);
      shared.push(p);
      sharedUnconfirmed = true;
    }
  }
  return { disputed, shared, sharedUnconfirmed };
}

/**
 * The sentence a refusal adds when some disputed files also carry this session's own edits: they
 * are not this session's alone, so the route that takes only this session's lines is `commit`'s
 * default scope, never a `message` on `push` (which commits the whole tree, the peer's lines
 * included). The push itself still waits on the other lines in those files — the rest of the
 * closing says whose they are and how to wait for them.
 */
function sharedAdvice(shared: string[], unconfirmed: boolean, forPush: boolean): string {
  const only = shared.length === 1;
  const shown =
    shared.length <= REFUSAL_PATH_CAP
      ? shared.join(', ')
      : `${shared.slice(0, REFUSAL_PATH_CAP).join(', ')}, … ${shared.length - REFUSAL_PATH_CAP} more`;
  const head =
    `${shown} also ${only ? 'carries' : 'carry'} this session's own edits, but a live session ` +
    `has edited ${only ? 'it' : 'them'} too` +
    (unconfirmed ? " (or may have: a live session's change index cannot be read)" : '') +
    ', so ' +
    `${only ? 'it is' : 'they are'} not this session's alone. Commit this session's own lines ` +
    'with `commit` (default scope "session") — it stages only this session\'s changes, never a ' +
    "peer's —";
  return forPush
    ? `${head} then, once the owner has committed, push without a \`message\`: a push carrying ` +
        "a `message` commits the whole working tree (`git add -A`), the peer's lines included."
    : `${head} and leave the rest of ${only ? 'that file' : 'those files'} to ${only ? 'its' : 'their'} owner.`;
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
  const entries = await collectPeerShadows(deps.shadows, id, peers);
  const { disputed, shared, sharedUnconfirmed } = disputedPaths(dirty, mine, peers, entries, fold);
  if (disputed.length === 0) return;

  const attribution = attributePeers(disputed, peers, entries, fold);
  const closing =
    shared.length === 0
      ? undefined
      : `${sharedAdvice(shared, sharedUnconfirmed, true)} ${composeClosing(attribution, PUSH_VOCABULARY)}`;
  throw new Error(renderPeerRefusal(disputed, attribution, Date.now(), closing));
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
 * Paths only this session owns (per its own shadow, and listed by no live peer) are left out, by
 * the same `disputedPaths` rule `guardPeerWork` applies — otherwise this session's own edits would
 * be reported as "not this session's", which is false. A path this session owns that a live peer
 * lists too (or while a live peer's index is unreadable) stays in, and the closing says it carries
 * this session's edits as well: the typed message's `scope: "paths"` advice bounces off `commit`'s
 * peer guard for exactly such a path. When nothing disputed remains (or no live peer exists at
 * all) there is nothing to attribute, so the plain typed message passes through unchanged.
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
    const entries = await collectPeerShadows(deps.shadows, id, peers);
    const { disputed, shared, sharedUnconfirmed } = disputedPaths(
      typed.paths,
      mine,
      peers,
      entries,
      fold,
    );
    if (disputed.length === 0) return fallback;

    const attribution = attributePeers(disputed, peers, entries, fold);
    const now = Date.now();
    const base = composeClosing(attribution, PULL_VOCABULARY);
    const closing =
      shared.length === 0 ? base : `${sharedAdvice(shared, sharedUnconfirmed, false)} ${base}`;
    return new Error(
      `${typed.message}\n\n${renderPeerRefusal(disputed, attribution, now, closing)}`,
    );
  } catch {
    return fallback;
  }
}

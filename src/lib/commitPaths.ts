import type { PeerShadowEntry } from '../services/shadowStore.js';

/** Identity fold — the default, for a case-sensitive repository: comparisons stay byte-exact. */
const identity = (p: string): string => p;

/**
 * True when `requested` names `candidate` exactly, or names a directory containing it.
 *
 * Matching is on exact posix path segments: `"figs"` covers `"figs/a.txt"` but never
 * `"figsx/a.txt"` (a naive prefix match would wrongly cover the latter). A trailing slash on
 * `requested` is normalised away first, so `"figs/"` covers `"figs/a.txt"` too. `requested` of
 * `"."` or `""` covers nothing — those are not real path requests, and only `resolveInside`'s own
 * empty-relative-path allowance would otherwise make them look like "the whole project".
 *
 * `fold` is git's own ASCII-only case fold (`foldCase`, `src/lib/caseFold.ts`), passed by the
 * caller only when the repository is case-insensitive (`GitService.isCaseInsensitive`) — never
 * decided here. The default is the identity function, so a case-sensitive repository (or a caller
 * that hasn't checked) stays byte-exact: on a case-insensitive clone, `Notes.txt` and `notes.txt`
 * are one file to git, and a comparison that didn't fold would let a `scope: "paths"` commit stage
 * a live peer's lines under the differently-cased spelling — the session-isolation invariant this
 * module exists to protect.
 */
export function coversPath(
  requested: string,
  candidate: string,
  fold: (p: string) => string = identity,
): boolean {
  const r = fold(requested.replace(/\/+$/, ''));
  if (r === '' || r === '.') return false;
  const c = fold(candidate);
  return c === r || c.startsWith(`${r}/`);
}

/** Requested paths that cover no entry of `dirty` — nothing in the working tree to commit there. */
export function uncoveredPaths(
  requested: string[],
  dirty: string[],
  fold?: (p: string) => string,
): string[] {
  return requested.filter((p) => !dirty.some((d) => coversPath(p, d, fold)));
}

export interface OwnedPath {
  path: string;
  sessionId: string;
}

/**
 * Which of the requested paths (or entries under them) a live peer's shadow already claims.
 *
 * Fails closed: a peer whose entries are `null` (its shadow index could not be read) is reported
 * in `unreadable`, never treated as "owns nothing" — callers must refuse the commit rather than
 * silently proceed, exactly as `ShadowStore.peerEntries`'s own contract requires. Iterating the
 * live `peers` list (rather than `entriesBySession`'s own keys) is what makes that fail-closed:
 * a peer that is live but missing from the map — `entries.get(id) ?? null`, mirroring
 * `attributePeers` in `peerAttribution.ts` — is treated exactly like an explicit `null`, so a
 * caller that forgot to `set` an entry for every peer cannot silently fail open.
 *
 * `fold`, as in `coversPath`, is git's own ASCII case fold — pass it only when the caller has
 * established the repository is case-insensitive; the default is byte-exact. `owned[].path` is
 * always the peer's own shadow spelling, never `requested`'s, so a caller reporting "this path is
 * already owned" names the file the way the owning session wrote it.
 */
export function peerOwnership(
  requested: string[],
  peers: Array<{ sessionId: string }>,
  entriesBySession: Map<string, PeerShadowEntry[] | null>,
  fold?: (p: string) => string,
): { owned: OwnedPath[]; unreadable: string[] } {
  const owned: OwnedPath[] = [];
  const unreadable: string[] = [];
  for (const { sessionId } of peers) {
    const entries = entriesBySession.get(sessionId) ?? null;
    if (entries === null) {
      unreadable.push(sessionId);
      continue;
    }
    for (const entry of entries) {
      if (requested.some((p) => coversPath(p, entry.path, fold))) {
        owned.push({ path: entry.path, sessionId });
      }
    }
  }
  return { owned, unreadable };
}

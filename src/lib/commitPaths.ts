import type { PeerShadowEntry } from '../services/shadowStore.js';

/**
 * True when `requested` names `candidate` exactly, or names a directory containing it.
 *
 * Matching is on exact posix path segments: `"figs"` covers `"figs/a.txt"` but never
 * `"figsx/a.txt"` (a naive prefix match would wrongly cover the latter). A trailing slash on
 * `requested` is normalised away first, so `"figs/"` covers `"figs/a.txt"` too. `requested` of
 * `"."` or `""` covers nothing — those are not real path requests, and only `resolveInside`'s own
 * empty-relative-path allowance would otherwise make them look like "the whole project".
 */
export function coversPath(requested: string, candidate: string): boolean {
  const r = requested.replace(/\/+$/, '');
  if (r === '' || r === '.') return false;
  return candidate === r || candidate.startsWith(`${r}/`);
}

/** Requested paths that cover no entry of `dirty` — nothing in the working tree to commit there. */
export function uncoveredPaths(requested: string[], dirty: string[]): string[] {
  return requested.filter((p) => !dirty.some((d) => coversPath(p, d)));
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
 */
export function peerOwnership(
  requested: string[],
  peers: Array<{ sessionId: string }>,
  entriesBySession: Map<string, PeerShadowEntry[] | null>,
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
      if (requested.some((p) => coversPath(p, entry.path))) {
        owned.push({ path: entry.path, sessionId });
      }
    }
  }
  return { owned, unreadable };
}

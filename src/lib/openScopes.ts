import path from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * Which session scopes are open in this process (docs/design/shared-server.md §5.3).
 *
 * In one process every session has the same pid, so a session whose client went away would read
 * live by pid until the process exits. A scope's own records therefore carry this process's
 * `processNonce` (`src/lib/fileLock.ts`), and for such a record `SessionRegistry.peers` asks this
 * table instead: live exactly while the scope is open here.
 *
 * Process-wide, not per `createSharedServices`: "open in this process" is a fact about the
 * process, and two sets of shared services in one process (the test suites build one per
 * simulated process) must see each other's open scopes as live, as two real processes do by pid.
 *
 * Keyed by the workspace (`keys`) and the session id, case-folded. Counted, so two scopes holding one id
 * (refused by the daemon once it assigns ids, §5.2) keep it open until both close.
 */
const open = new Map<string, number>();

/**
 * The keys a workspace is known by: its resolved spelling, and its real path when it resolves.
 * One workspace reached by two spellings (a symlinked temp dir) must still match, or an open scope
 * would read dead to a reader using the other spelling — the fail-open direction. Both forms are
 * registered and both are looked up, so a scope opened before its workspace existed (no real
 * path yet) still matches a reader that resolves one later.
 */
function keys(workspaceRoot: string, sessionId: string): string[] {
  const forms = new Set([path.resolve(workspaceRoot)]);
  try {
    forms.add(realpathSync.native(workspaceRoot));
  } catch {
    // Not created yet: the resolved spelling is all there is.
  }
  // The id folded too: on a case-insensitive disk `Alice` and `alice` are one session directory,
  // so an open `Alice` must make an `alice` record read live — erring toward live, never dead.
  const id = sessionId.toLowerCase();
  return [...forms].map((root) => `${root}\0${id}`);
}

/** Mark a scope open; returns the function that marks it closed again (once). */
export function openScope(workspaceRoot: string, sessionId: string): () => void {
  const held = keys(workspaceRoot, sessionId);
  for (const k of held) open.set(k, (open.get(k) ?? 0) + 1);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    for (const k of held) {
      const n = (open.get(k) ?? 1) - 1;
      if (n <= 0) open.delete(k);
      else open.set(k, n);
    }
  };
}

/** Whether a scope with this id is open in this process on this workspace. */
export function isScopeOpen(workspaceRoot: string, sessionId: string): boolean {
  return keys(workspaceRoot, sessionId).some((k) => open.has(k));
}

import path from 'node:path';
import { childPathInside } from './projectId.js';

/**
 * Layout of the per-session state that lets several agent sessions share one clone:
 *
 * ```
 * <workspaceRoot>/
 *   .sessions/
 *     <projectId>/
 *       project.lock              cross-process lock for mutating operations
 *       rewrite-mode.json         sticky rewrite-preservation mode, shared by every session
 *       <sessionId>/
 *         session.json            heartbeat + metadata, so peers can see each other
 *         shadow.json             which files this session has touched
 *         shadow/<relPath>        HEAD + only this session's edits
 *         base/<relPath>          the HEAD content that shadow is based on
 * ```
 *
 * It lives beside the clones rather than inside them, so nothing here can ever be committed or
 * confused for project content.
 */

/** Name of the state directory under the workspace root. */
export const SESSIONS_DIRNAME = '.sessions';

/**
 * State directory for a project, shared by every session working on it.
 *
 * Refuses a `projectId` that is not a single entry directly under `.sessions/` (`..`, `a/b`):
 * `path.join` would resolve it rather than refuse it, and every caller creates what this returns
 * (`runExclusive` makes the lock's directory before anything else runs). Project ids are validated
 * where they enter the server (`src/lib/projectId.ts`); this is the defence in depth.
 */
export function sessionStateDir(workspaceRoot: string, projectId: string): string {
  return childPathInside(path.join(workspaceRoot, SESSIONS_DIRNAME), projectId, 'project id');
}

/** The cross-process lock guarding mutating operations on a project's clone. */
export function projectLockPath(workspaceRoot: string, projectId: string): string {
  return path.join(sessionStateDir(workspaceRoot, projectId), 'project.lock');
}

/**
 * State directory for one session's view of one project. The session id is held to the same
 * single-entry rule as the project id — a peer's id read off disk reaches this too.
 */
export function sessionDir(workspaceRoot: string, projectId: string, sessionId: string): string {
  return childPathInside(sessionStateDir(workspaceRoot, projectId), sessionId, 'session id');
}

/**
 * The sticky rewrite-preservation mode for a project — per project, shared by every session
 * (not under `<sessionId>/`), since it is "how we work on this paper" rather than session state.
 * Lives beside the clones, never inside them, so it can never be committed or mistaken for
 * project content.
 */
export function rewriteModePath(workspaceRoot: string, projectId: string): string {
  return path.join(sessionStateDir(workspaceRoot, projectId), 'rewrite-mode.json');
}

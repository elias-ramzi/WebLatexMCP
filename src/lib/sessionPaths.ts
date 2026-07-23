import path from 'node:path';

/**
 * Layout of the per-session state that lets several agent sessions share one clone:
 *
 * ```
 * <workspaceRoot>/
 *   .sessions/
 *     <projectId>/
 *       project.lock              cross-process lock for mutating operations
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

/** State directory for a project, shared by every session working on it. */
export function sessionStateDir(workspaceRoot: string, projectId: string): string {
  return path.join(workspaceRoot, SESSIONS_DIRNAME, projectId);
}

/** The cross-process lock guarding mutating operations on a project's clone. */
export function projectLockPath(workspaceRoot: string, projectId: string): string {
  return path.join(sessionStateDir(workspaceRoot, projectId), 'project.lock');
}

/** State directory for one session's view of one project. */
export function sessionDir(workspaceRoot: string, projectId: string, sessionId: string): string {
  return path.join(sessionStateDir(workspaceRoot, projectId), sessionId);
}

import type { ProjectManager } from '../services/projectManager.js';
import path from 'node:path';
import type { GitService } from '../services/gitService.js';
import { toPosix } from './paths.js';

/**
 * The confirmation diff a write/edit tool shows after changing a file.
 *
 * For a git project this is a diff against the clone's HEAD. A local project has no baseline of
 * ours: the only repository around is the user's own, which this server deliberately does not read
 * or write — running `git diff` there would report against *their* history, and inside a plain
 * directory it fails outright. So local projects get no diff, and the caller reports the change
 * without one.
 */
export async function changeDiff(
  projectManager: Pick<ProjectManager, 'isLocal'>,
  git: Pick<GitService, 'diff'>,
  id: string,
  dir: string,
  relPath: string,
): Promise<string> {
  if (projectManager.isLocal(id)) return '';
  const { diff } = await git.diff(dir, { path: relPath });
  return diff;
}

/**
 * The project-relative path a write through `relPath` actually changed, given what
 * `FileService.linkTarget` said about it: the link's in-project target when there is one, else
 * `relPath` itself. A target outside the project (absolute — reachable only under a local
 * project's `followSymlinks`) is never the answer: no tool output, diff, or shadow record may
 * carry an absolute path, so the change is attributed to the name the caller gave. One rule,
 * shared by the write/edit tools (which diff it) and `FileService` (which records it).
 */
export function changedPath(target: string | null, relPath: string): string {
  return target !== null && !path.isAbsolute(target) ? target : toPosix(relPath);
}

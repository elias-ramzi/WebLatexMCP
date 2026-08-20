import type { ProjectManager } from '../services/projectManager.js';
import type { GitService } from '../services/gitService.js';

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

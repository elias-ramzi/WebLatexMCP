import type { ProjectManager } from '../services/projectManager.js';
import path from 'node:path';
import type { GitService } from '../services/gitService.js';
import { toPosix } from './paths.js';
import { planChangeDiff } from './diffBudget.js';
import type { ChangeDiffPlan } from './diffBudget.js';

/**
 * The confirmation diff a write/edit tool shows after changing a file.
 *
 * For a git project this is a diff against the clone's HEAD. A local project has no baseline of
 * ours: the only repository around is the user's own, which this server deliberately does not read
 * or write — running `git diff` there would report against *their* history, and inside a plain
 * directory it fails outright. So local projects get no diff, and the caller reports the change
 * without one.
 *
 * The patch is then budgeted (`src/lib/diffBudget.ts`, issue #153) before it is handed back, and
 * budgeted much harder than `diff`'s own: nobody asked for this patch. It is a courtesy echo of a
 * change the caller just made, shipped twice (result text and `structuredContent.diff`), so a
 * `write_file` over a large file used to return that whole file back as one `+` hunk on a call
 * whose actual answer is "written". What survives is whole hunks only, plus every file header and
 * a marker saying what went; `diff` is the escape hatch for the rest.
 *
 * Returning the plan rather than a bare string is deliberate: a cut patch is still a non-empty
 * patch, so `diff: ''` keeps meaning exactly what it always did — there is no diff at all — and
 * `truncated` is the separate, explicit signal that bytes are missing. A caller cannot confuse the
 * two, which is the same distinction the conflict payload keeps between a `null` side that was
 * elided and one that was simply absent.
 */
export async function changeDiff(
  projectManager: Pick<ProjectManager, 'isLocal'>,
  git: Pick<GitService, 'diff'>,
  id: string,
  dir: string,
  relPath: string,
): Promise<ChangeDiffPlan> {
  if (projectManager.isLocal(id)) return { diff: '', truncated: false };
  const { diff } = await git.diff(dir, { path: relPath });
  return planChangeDiff(diff);
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

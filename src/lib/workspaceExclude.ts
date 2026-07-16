import path from 'node:path';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { toPosix } from './paths.js';

/** Marker line so we only ever manage a single, idempotent block in the exclude file. */
const EXCLUDE_HEADER = '# added by web-latex-mcp (workspace-local clones)';

/** Walk up from `start` to find the nearest directory containing a `.git` entry. */
async function findGitRoot(start: string): Promise<string | undefined> {
  let dir = path.resolve(start);
  for (;;) {
    try {
      await access(path.join(dir, '.git'));
      return dir;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * When clones live inside the agent's own workspace, keep them out of the host repo's git by
 * adding the workspace dir to that repo's local `.git/info/exclude` (not the tracked
 * `.gitignore`, so nothing is committed on the user's behalf).
 *
 * Best-effort and idempotent: does nothing if the workspace isn't inside a git repo, and never
 * throws — a failure here must not stop the server from starting. Returns the exclude pattern
 * that was ensured, or `undefined` if nothing was written.
 */
export async function excludeWorkspaceFromHostGit(
  workspaceRoot: string,
): Promise<string | undefined> {
  try {
    const repoRoot = await findGitRoot(path.dirname(workspaceRoot));
    if (!repoRoot) return undefined;

    // Anchor the pattern to the repo root so it matches only this workspace dir.
    const rel = toPosix(path.relative(repoRoot, workspaceRoot));
    if (!rel || rel.startsWith('..')) return undefined;
    const pattern = `/${rel}/`;

    const excludePath = path.join(repoRoot, '.git', 'info', 'exclude');
    let existing = '';
    try {
      existing = await readFile(excludePath, 'utf8');
    } catch {
      // no exclude file yet — we'll create it
    }
    if (existing.split(/\r?\n/).includes(pattern)) return pattern;

    await mkdir(path.dirname(excludePath), { recursive: true });
    const prefix = existing && !existing.endsWith('\n') ? `${existing}\n` : existing;
    await writeFile(excludePath, `${prefix}${EXCLUDE_HEADER}\n${pattern}\n`, 'utf8');
    return pattern;
  } catch {
    return undefined;
  }
}

import path from 'node:path';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { renameWithRetry } from '../lib/fileLock.js';

/**
 * The web UI's files, in `<workspace>/.ui/` (`projectIdProblem` refuses a leading `.`, so no
 * project can be named `.ui`):
 *
 * - `ui.json` (`0600`): the running UI's pid, port and token, so a second `web-latex-mcp ui`
 *   opens the same page instead of starting another server;
 * - `papers.json`: the sidebar's groups, labels and order (`paperMeta.ts`);
 * - `chats/`: each paper's conversation (`chatStore.ts`).
 */

export interface UiInfo {
  pid: number;
  port: number;
  /** The page's token; the file is `0600` because of it. */
  token: string;
  startedAt: string;
}

export function uiDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.ui');
}

export function uiInfoPath(workspaceRoot: string): string {
  return path.join(uiDir(workspaceRoot), 'ui.json');
}

/**
 * Create `<workspace>/.ui` (and `sub` under it) as real directories, `0700`. A link or a file
 * there is refused: the token and the conversations would be written wherever it points.
 */
export async function ensureUiDir(workspaceRoot: string, sub?: string): Promise<string> {
  await mkdir(workspaceRoot, { recursive: true });
  let dir = uiDir(workspaceRoot);
  for (const level of sub ? [dir, path.join(dir, sub)] : [dir]) {
    try {
      await mkdir(level, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const st = await lstat(level);
    if (!st.isDirectory()) {
      throw new Error(
        `Refusing to use ${level}: it is not a directory (a link or a file is there). Move it ` +
          'away, then retry.',
      );
    }
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) await chmod(level, 0o700);
    dir = level;
  }
  return dir;
}

let seq = 0;

/** Write `target` atomically (temp file + rename), with `mode` from its first byte. */
export async function writeFileAtomic(target: string, content: string, mode = 0o600): Promise<void> {
  const tmp = `${target}.${process.pid}.${seq++}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, content, { mode, flag: 'wx' });
  try {
    await renameWithRetry(tmp, target, rename);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export async function writeUiInfo(workspaceRoot: string, info: UiInfo): Promise<void> {
  await ensureUiDir(workspaceRoot);
  await writeFileAtomic(uiInfoPath(workspaceRoot), `${JSON.stringify(info, null, 2)}\n`);
}

/** The current `ui.json`, or `undefined` when absent, unreadable, or naming a dead process. */
export async function readUiInfo(workspaceRoot: string): Promise<UiInfo | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(uiInfoPath(workspaceRoot), 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const r = parsed as Record<string, unknown>;
  if (typeof r.pid !== 'number' || typeof r.port !== 'number' || typeof r.token !== 'string') {
    return undefined;
  }
  try {
    process.kill(r.pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return undefined;
  }
  return {
    pid: r.pid,
    port: r.port,
    token: r.token,
    startedAt: typeof r.startedAt === 'string' ? r.startedAt : '',
  };
}

/** Remove `ui.json` only while it is still this process's. */
export async function removeUiInfo(workspaceRoot: string, pid = process.pid): Promise<void> {
  const current = await readUiInfo(workspaceRoot);
  if (current && current.pid !== pid) return;
  await rm(uiInfoPath(workspaceRoot), { force: true });
}

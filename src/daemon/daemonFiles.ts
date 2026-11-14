import path from 'node:path';
import { chmod, lstat, mkdir, readFile, rm, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { renameWithRetry } from '../lib/fileLock.js';

/**
 * The daemon's discovery and lock files, inside the workspace it serves
 * (docs/design/shared-server.md §4.1). `projectIdProblem` refuses a leading `.`, so no project
 * can be named `.daemon`.
 */

export interface DaemonInfo {
  pid: number;
  processNonce: string;
  port: number;
  /** The bearer token; the file is `0600` because of it. */
  token: string;
  version: string;
  /** The entry script the daemon runs from. */
  buildPath: string;
  /** Version, entry and its mtime (`currentBuildId`): what a proxy compares (§9.2). */
  buildId: string;
  startedAt: string;
}

export function daemonDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.daemon');
}

export function daemonInfoPath(workspaceRoot: string): string {
  return path.join(daemonDir(workspaceRoot), 'daemon.json');
}

export function daemonLockPath(workspaceRoot: string): string {
  return path.join(daemonDir(workspaceRoot), 'daemon.lock');
}

/**
 * Create `<workspace>/.daemon` as a real directory with mode `0700`, tightening an existing one.
 * A link or non-directory there is refused: the token would be written wherever it points. On
 * win32 the mode is not enforced the same way; only the "real directory" check is meaningful.
 */
export async function ensureDaemonDir(workspaceRoot: string): Promise<string> {
  const dir = daemonDir(workspaceRoot);
  await mkdir(workspaceRoot, { recursive: true });
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const st = await lstat(dir);
  if (!st.isDirectory()) {
    throw new Error(
      `Refusing to use ${dir}: it is not a directory (a link or a file is there). Move it away, ` +
        'then retry.',
    );
  }
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) await chmod(dir, 0o700);
  return dir;
}

let seq = 0;

/** Write `daemon.json` atomically, `0600` from its first byte. */
export async function writeDaemonInfo(workspaceRoot: string, info: DaemonInfo): Promise<void> {
  await ensureDaemonDir(workspaceRoot);
  const target = daemonInfoPath(workspaceRoot);
  // Random too: a crashed daemon's leftover with the same pid (a pid-1 restart) must not collide.
  const tmp = `${target}.${process.pid}.${seq++}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    await renameWithRetry(tmp, target, rename);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** The current `daemon.json`, or `undefined` when absent or unreadable as one. */
export async function readDaemonInfo(workspaceRoot: string): Promise<DaemonInfo | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(daemonInfoPath(workspaceRoot), 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const r = parsed as Record<string, unknown>;
  if (
    typeof r.pid !== 'number' ||
    typeof r.port !== 'number' ||
    typeof r.token !== 'string' ||
    typeof r.processNonce !== 'string'
  ) {
    return undefined;
  }
  return {
    pid: r.pid,
    processNonce: r.processNonce,
    port: r.port,
    token: r.token,
    version: typeof r.version === 'string' ? r.version : 'unknown',
    buildPath: typeof r.buildPath === 'string' ? r.buildPath : '',
    buildId: typeof r.buildId === 'string' ? r.buildId : '',
    startedAt: typeof r.startedAt === 'string' ? r.startedAt : '',
  };
}

/** Remove `daemon.json` only if it is still this daemon's (another may have replaced it). */
export async function removeDaemonInfo(workspaceRoot: string, processNonce: string): Promise<void> {
  const current = await readDaemonInfo(workspaceRoot);
  if (current?.processNonce !== processNonce) return;
  await rm(daemonInfoPath(workspaceRoot), { force: true });
}

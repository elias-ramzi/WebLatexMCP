import path from 'node:path';
import { open, mkdir, readFile, rm, stat, utimes } from 'node:fs/promises';

/**
 * An advisory cross-process lock built on exclusive file creation (`O_EXCL`), which is atomic on
 * every platform we support.
 *
 * The in-process mutex in `ProjectManager` only serialises calls within one server; several agent
 * sessions run several servers over the same clone, and git has no tolerance for two processes
 * rewriting an index at once. This closes that gap.
 *
 * A holder that crashes cannot release its lock, so the file carries the owner's pid and is
 * touched periodically while held: a lock is reclaimed once its owner's process is gone, or once
 * it has gone `staleMs` without a heartbeat (the fallback for a pid we cannot see, e.g. one owned
 * by another user).
 */

export interface FileLockOptions {
  /** Abandon and throw after this long waiting for the holder to release. */
  timeoutMs?: number;
  /** Treat a lock with no heartbeat for this long as abandoned. */
  staleMs?: number;
  /** Recorded in the lock file so a blocked caller can say who holds it. */
  owner?: string;
}

interface LockFileContents {
  pid: number;
  owner?: string;
  acquiredAt: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_MS = 60_000;
const HEARTBEAT_MS = 5_000;
const POLL_MS = 50;

/** Thrown when the lock could not be taken before `timeoutMs` elapsed. */
export class LockTimeoutError extends Error {
  constructor(lockPath: string, holder: LockFileContents | null) {
    const who = holder?.owner ? `session "${holder.owner}"` : `pid ${holder?.pid ?? '?'}`;
    super(
      `Timed out waiting for the lock on ${path.basename(path.dirname(lockPath))} — held by ${who} ` +
        `since ${holder?.acquiredAt ?? 'an unknown time'}. Another session is mid-operation; retry shortly.`,
    );
    this.name = 'LockTimeoutError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether `pid` is a live process. Meaningful only on this machine — see the module comment. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readHolder(lockPath: string): Promise<LockFileContents | null> {
  try {
    return JSON.parse(await readFile(lockPath, 'utf8')) as LockFileContents;
  } catch {
    return null; // missing, or a partial write from a holder that died mid-creation
  }
}

/** Try to take the lock once. Returns false if someone else currently holds it. */
async function tryAcquire(lockPath: string, owner: string | undefined): Promise<boolean> {
  try {
    const handle = await open(lockPath, 'wx');
    const contents: LockFileContents = {
      pid: process.pid,
      owner,
      acquiredAt: new Date().toISOString(),
    };
    try {
      await handle.writeFile(JSON.stringify(contents), 'utf8');
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Remove the lock if its holder is demonstrably gone. Returns true if it was cleared, so the
 * caller can retry immediately.
 */
async function reclaimIfStale(lockPath: string, staleMs: number): Promise<boolean> {
  const holder = await readHolder(lockPath);
  // A holder whose process is gone can never release its lock. Otherwise — including when the
  // file is unparseable, which may just be a holder part-way through writing it — only reclaim
  // once it has stopped being touched.
  const abandoned = holder && !pidAlive(holder.pid) ? true : await olderThan(lockPath, staleMs);
  if (!abandoned) return false;
  await rm(lockPath, { force: true });
  return true;
}

async function olderThan(lockPath: string, ms: number): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > ms;
  } catch {
    return false; // already gone
  }
}

/**
 * Run `fn` while holding an exclusive lock at `lockPath`, releasing it however `fn` ends.
 * Concurrent callers in this process are expected to be serialised by a mutex first; this is the
 * guard against *other* processes.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  await mkdir(path.dirname(lockPath), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await tryAcquire(lockPath, opts.owner)) break;
    if (await reclaimIfStale(lockPath, staleMs)) continue;
    if (Date.now() >= deadline) throw new LockTimeoutError(lockPath, await readHolder(lockPath));
    await sleep(POLL_MS);
  }

  // Keep the lock looking alive for as long as we hold it, so a slow clone or push is never
  // mistaken for an abandoned lock. Unref'd so it can't hold the process open.
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(lockPath, now, now).catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await rm(lockPath, { force: true });
  }
}

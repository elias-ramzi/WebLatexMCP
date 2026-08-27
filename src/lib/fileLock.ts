import path from 'node:path';
import { existsSync } from 'node:fs';
import { open, mkdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

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
    const name = path.basename(path.dirname(lockPath));
    const message = holder
      ? `Timed out waiting for the lock on ${name} — held by ${
          holder.owner ? `session "${holder.owner}"` : `pid ${holder.pid}`
        } since ${holder.acquiredAt}. Another session is mid-operation; retry shortly.`
      : `Timed out waiting for the lock on ${name} — no holder was recorded. The lock file may be ` +
        `unwritable (permissions, a read-only volume, an antivirus hold) or was removed after this ` +
        `wait began.`;
    super(message);
    this.name = 'LockTimeoutError';
  }
}

/**
 * Removing the lock file is the release. Windows can transiently refuse it (EPERM/EBUSY) while a
 * handle is still closing, so ask `rm` to retry rather than letting a release fail and strand the
 * lock. Elsewhere the retries never fire.
 */
const RM_OPTS = { force: true, maxRetries: 5, retryDelay: 20 } as const;

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

/**
 * Whether an open() failure with `code` should be treated as ordinary contention (another holder
 * has the lock) rather than a real failure to surface. Exported so the decision is unit-testable
 * on every platform, since the win32-only EPERM/EACCES case cannot actually execute on Linux/macOS
 * CI runners.
 *
 * On Windows a delete-pending file — the previous holder called `rm` but its handle is not yet
 * fully closed — is reported as EPERM/EACCES rather than EEXIST. That is contention, not a real
 * failure, so treat it as "held" and let the caller poll. But that is only true while the lock
 * file is still visible on disk: if it is not there, there is nothing pending deletion, and
 * EPERM/EACCES means a genuine permission problem (read-only volume, restrictive ACL, an
 * antivirus hold) that will never resolve itself — surface it immediately rather than burning the
 * full timeout on a wait that can never succeed.
 *
 * `lockFileExists` is a thunk rather than a plain boolean so the (synchronous, disk-touching)
 * `existsSync` check is paid only on the win32 EPERM/EACCES path — never on the far more common
 * EEXIST contention path, which every platform hits on every poll of every lock wait.
 */
export function isLockContentionError(
  code: string | undefined,
  platform: string,
  lockFileExists: () => boolean,
): boolean {
  if (code === 'EEXIST') return true;
  if (platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
    return lockFileExists();
  }
  return false;
}

/** The outcome of one raw attempt to create the lock file. */
type OpenAttempt = 'acquired' | 'contended' | NodeJS.ErrnoException;

/** The part of a FileHandle the lock file needs — narrow so a test can supply a fake. */
type LockHandle = Pick<FileHandle, 'writeFile' | 'close'>;
/** Exclusive-create open of the lock file. Injectable so the win32 retry is testable off win32. */
type LockOpener = (lockPath: string) => Promise<LockHandle>;

/** Test seam for `tryAcquire`. Defaults are the real filesystem and the real platform. */
export interface LockAttemptDeps {
  opener: LockOpener;
  platform: string;
}

/** Attempt to create the lock file once, with no retry. */
async function attemptOpen(
  lockPath: string,
  owner: string | undefined,
  deps: LockAttemptDeps,
): Promise<OpenAttempt> {
  try {
    const handle = await deps.opener(lockPath);
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
    return 'acquired';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (isLockContentionError(code, deps.platform, () => existsSync(lockPath))) {
      return 'contended';
    }
    return err as NodeJS.ErrnoException;
  }
}

/**
 * Try to take the lock once. Returns false if someone else currently holds it.
 *
 * Exported as an internal test seam only — `deps` lets a test drive the win32 delete-pending
 * retry (below) without a Windows machine. `withFileLock` is the sole production caller, and it
 * always uses the default `deps`, which read the real filesystem and the real platform live on
 * each call.
 */
export async function tryAcquire(
  lockPath: string,
  owner: string | undefined,
  deps: LockAttemptDeps = { opener: (p) => open(p, 'wx'), platform: process.platform },
): Promise<boolean> {
  const first = await attemptOpen(lockPath, owner, deps);
  if (first === 'acquired') return true;
  if (first === 'contended') return false;

  // A win32 EPERM/EACCES with no lock file on disk is judged a genuine failure by
  // isLockContentionError — but that judgement can be a TOCTOU false negative: the previous
  // holder's delete may complete in the gap between our failed open() and the existsSync check
  // inside it, so "no lock file" at that instant doesn't mean the open() itself wasn't racing a
  // delete-pending handle. Re-attempt once before treating it as real: if the retry succeeds or
  // finds contention, this was the race; only a second permission failure is surfaced.
  if (deps.platform === 'win32' && (first.code === 'EPERM' || first.code === 'EACCES')) {
    const retry = await attemptOpen(lockPath, owner, deps);
    if (retry === 'acquired') return true;
    if (retry === 'contended') return false;
    throw retry;
  }
  throw first;
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
  await rm(lockPath, RM_OPTS);
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
    await rm(lockPath, RM_OPTS);
  }
}

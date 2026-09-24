import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, link, mkdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { threadId } from 'node:worker_threads';
import { currentBootStamp, isSameBoot, writtenSinceProcessStart } from './bootIdentity.js';
import { toPosix } from './paths.js';

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
 * it has gone `staleMs` without a heartbeat — the fallback for a record whose pid proves nothing,
 * because it is unreadable or may name a different boot's process. A pid that answers on the
 * boot that recorded it is not reclaimed on one look at its age: a laptop that slept past
 * `staleMs` wakes with every lock's mtime old before its holder's heartbeat has had a chance to
 * fire, and stealing that lock puts two processes into git at once. It is reclaimed only once the
 * SAME record (token and mtime unchanged) has been seen stale twice, `STALE_CONFIRM_MS` apart —
 * long enough for a woken holder's overdue heartbeat to move the mtime — which is what a SIGKILLed
 * holder whose pid another process reused on this boot looks like, and which must not wedge the
 * lock for as long as that unrelated process lives. A record this very thread wrote is judged
 * without guessing at all: it is live exactly while a call in this thread still holds its token.
 * "This very thread" is decided by a random per-process `nonce` as well as pid and threadId, because
 * pid + threadId repeats across pid namespaces: two containers sharing a workspace volume both run
 * node as pid 1 on thread 0, and without the nonce each read the other's live record as its own
 * abandoned one. A record with our pid and another nonce — that twin, or this process's own crashed
 * predecessor restarted as the same pid — is judged by its heartbeat alone, over the shorter
 * `OWN_PID_STALE_MS`, since asking whether our own pid is alive proves nothing about its writer.
 * Beyond that one case the lock does NOT span hosts or pid namespaces: `pidAlive`
 * probes this machine's (this namespace's) process table, so a holder elsewhere with a different pid
 * reads as dead and its lock is taken at once, and one whose pid happens to name a live local process
 * is judged by that process. Keep every server sharing a workspace in one pid namespace on one host.
 *
 * **Removing a lock file is the dangerous step**, not creating one. POSIX has no conditional
 * unlink, so "I judged this holder stale, now delete the file" deletes whatever is at the path by
 * then — a faster waiter's freshly taken lock included, which is how two holders once got in (a
 * crashed holder and three waiters overlapped in about half of all trials), and how a releasing
 * holder whose lock had been reclaimed deleted its successor's. So every record carries
 * a unique `token`, and a record is removed — by its holder's release or by a reclaim — only by
 * whoever first creates its **removal marker** (`<lock>.rm-<identity>.<gen>`, exclusive create),
 * then re-reads the lock and finds that same record still there. Since nobody removes a record
 * without its marker, a record seen under the marker stays put until its marker holder removes
 * it. The removal itself is a rename to a unique aside name, re-read and verified before the
 * aside is deleted, so a record that changed underneath (a token-less legacy or half-written one,
 * the only kind whose identity is its bytes) is put back rather than lost. A marker left by a
 * crashed remover is judged exactly like a lock record, and superseded by the next generation —
 * with no cap on generations, since a dead marker is never deleted (only its creator may) and a
 * token-less record's identity, its bytes, is shared by every record of that shape: the empty
 * file of a create that stalled is the same identity every time.
 */

export interface FileLockOptions {
  /** Abandon and throw after this long waiting for the holder to release. */
  timeoutMs?: number;
  /** Treat a lock with no heartbeat for this long as abandoned. */
  staleMs?: number;
  /** Recorded in the lock file so a blocked caller can say who holds it. */
  owner?: string;
  /**
   * Test seam: the monotonic clock `STALE_CONFIRM_MS` is measured on. Defaults to
   * `performance.now()`; production callers never pass it.
   */
  clock?: () => number;
}

interface LockFileContents {
  pid: number;
  owner?: string;
  acquiredAt: string;
  /** Unique per acquisition — the record's identity. Absent from records older builds wrote. */
  token?: string;
  /** The boot that recorded `pid` (`currentBootStamp`), when it could be read. */
  bootedAt?: string;
  /** The worker thread (`worker_threads.threadId`) of `pid` that wrote it; 0 is the main thread. */
  threadId?: number;
  /** The writing process's `processNonce`. Absent from records older builds wrote. */
  nonce?: string;
}

/**
 * How long a caller waited for the lock, and (when it had to wait) who it was waiting on. Passed
 * to `withFileLock`'s `fn` so a caller can report a suspiciously fast result as "actually waited
 * on a peer" rather than silently looking instant. `waitedOn` is the `owner` recorded in the lock
 * file that was waited on — or, when a holder wrote no owner, its pid as a string — and is absent
 * whenever there was no wait at all.
 */
export interface LockAcquisition {
  waitedMs: number;
  waitedOn?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_MS = 60_000;
const HEARTBEAT_MS = 5_000;
/**
 * How long a stale record whose live pid is vouched for must stay byte- and mtime-identical
 * before it is reclaimed. Two heartbeat intervals: a holder that is alive and merely slept fires
 * its overdue heartbeat on wake, within `HEARTBEAT_MS`, so its mtime moves before a second look
 * this far apart. A fixed age ceiling could not make that promise — the age a sleep leaves behind
 * is the length of the sleep, whatever the ceiling — so the rule compares observations instead.
 * What it gives up is a live holder whose heartbeat cannot land at all (a SIGSTOPped process, a
 * `utimes` an antivirus refuses): that is reclaimed after `staleMs` plus this, as every holder
 * was before boot-vouching existed.
 */
const STALE_CONFIRM_MS = 2 * HEARTBEAT_MS;
/**
 * The heartbeat age past which a record carrying OUR pid under another process's nonce is judged
 * by its heartbeat alone (still confirmed across two sightings `STALE_CONFIRM_MS` apart). Such a
 * record is a crashed predecessor of this process that restarted under the same pid (a container's
 * pid 1), or a live twin in another pid namespace; `pidAlive` cannot tell them apart — it answers
 * for us — so the general rule would hold a dead predecessor's lock for `staleMs` plus the
 * confirmation and the restarted server's first calls would time out. Three heartbeat intervals is
 * two missed heartbeats plus scheduling slack, and the confirmation adds two more intervals, so a
 * live twin must fail to touch its record for 25 s straight before it is reclaimed — about 25 s
 * after a crash for the predecessor, inside the 30 s default wait. What it gives up: a live twin
 * whose event loop is blocked (or whose `utimes` is refused) for that long is reclaimed, the same
 * residual as a SIGSTOPped holder, only sooner. A removal marker carries no heartbeat, so a live
 * same-pid twin's marker is exposed the same way — held for milliseconds, it is reclaimed only
 * across a stall of that length.
 */
const OWN_PID_STALE_MS = 3 * HEARTBEAT_MS;
const POLL_MS = 50;
/** How often a release waits out a remover that holds our record's marker before giving up. */
const RELEASE_ATTEMPTS = 100;
const TOKEN_RE = /^[0-9a-f]{32}$/;

/**
 * Thrown when the lock could not be taken before `timeoutMs` elapsed. It names the lock file and
 * the manual way out: the server reclaims a crashed holder's lock by itself, but a caller wedged by
 * one it cannot judge needs to know which file to delete, and when doing so is safe.
 */
export class LockTimeoutError extends Error {
  constructor(lockPath: string, holder: LockFileContents | null) {
    const name = path.basename(path.dirname(lockPath));
    const remedy =
      ` If no other web-latex-mcp session is running, the lock was left behind by a crash: ` +
      `delete ${toPosix(lockPath)} and retry.`;
    const message = holder
      ? `Timed out waiting for the lock on ${name} — held by ${
          holder.owner ? `session "${holder.owner}"` : `pid ${holder.pid}`
        } since ${holder.acquiredAt}. Another session is mid-operation; retry shortly.${remedy}`
      : `Timed out waiting for the lock on ${name} — no holder was recorded. The lock file may be ` +
        `unwritable (permissions, a read-only volume, an antivirus hold) or was removed after this ` +
        `wait began.${remedy}`;
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

const newToken = (): string => randomBytes(16).toString('hex');

/**
 * Random per module instance — so per process, and per worker thread, which loads its own copy.
 * Written into every lock record and removal marker, and required (with pid and threadId) before a
 * record is judged this thread's own: pid + threadId alone collide across pid namespaces. Exported
 * only so a test can write a record this thread would recognise as its own.
 */
export const processNonce: string = newToken();

/**
 * Tokens a call in this thread currently holds or is acquiring with — lock records and removal
 * markers alike. A record carrying this thread's pid, threadId and nonce is live exactly while its
 * token is here: nothing else in this process can be the writer, so no pid or age has to be guessed at.
 * A token is added BEFORE the file that carries it is created, or a peer call in this thread could
 * read the fresh record and judge it abandoned.
 */
const heldTokens = new Set<string>();

/** How a call judges records: its staleness threshold, its clock, and what it has already seen. */
interface Judge {
  staleMs: number;
  clock: () => number;
  /** Per file: the record last seen stale there, and when (on `clock`). */
  sightings: Map<string, { identity: string; mtimeMs: number; at: number }>;
}

const newJudge = (staleMs: number, clock: () => number = () => performance.now()): Judge => ({
  staleMs,
  clock,
  sightings: new Map(),
});

/** `currentBootStamp()`, or undefined where `os.uptime()` throws. */
function readBootStamp(): string | undefined {
  try {
    return currentBootStamp();
  } catch {
    return undefined;
  }
}

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

async function readRaw(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** A lock (or marker) record, or null when the bytes are not one — e.g. a partial write. */
function parseRecord(raw: string | null): LockFileContents | null {
  if (raw === null) return null;
  try {
    const rec = JSON.parse(raw) as LockFileContents | null;
    return rec && typeof rec === 'object' && Number.isInteger(rec.pid) ? rec : null;
  } catch {
    return null;
  }
}

async function readHolder(lockPath: string): Promise<LockFileContents | null> {
  return parseRecord(await readRaw(lockPath)); // missing, or a partial write
}

/**
 * What a record is, for deciding whether the record at the path is still the one judged: its
 * token, or — for a token-less record (an older build's, or a half-written one) — its bytes.
 */
function identityOf(raw: string): string {
  const rec = parseRecord(raw);
  if (rec && typeof rec.token === 'string' && TOKEN_RE.test(rec.token)) return rec.token;
  return `h${createHash('sha256').update(raw).digest('hex').slice(0, 32)}`;
}

/**
 * Whether a live `pid` in this record can be trusted to be the process that wrote it: the record
 * was written since this process started (so on this boot — a reboot would have killed us), or
 * its boot stamp names this boot. `bootIdentity.ts` carries the reasoning and the residuals.
 */
function pidVouched(rec: LockFileContents): boolean {
  if (typeof rec.acquiredAt === 'string' && writtenSinceProcessStart(rec.acquiredAt)) return true;
  const current = readBootStamp();
  return current !== undefined && isSameBoot(rec.bootedAt, current);
}

/**
 * Whether `rec` was written by this very thread, so `heldTokens` decides it outright. The nonce is
 * what makes this an identification rather than a guess: a record without one (an older build's) or
 * with another's (a twin pid + threadId in another pid namespace) is judged like any other holder.
 */
function writtenByThisThread(rec: LockFileContents): rec is LockFileContents & { token: string } {
  return (
    rec.nonce === processNonce &&
    rec.pid === process.pid &&
    rec.threadId === threadId &&
    typeof rec.token === 'string' &&
    TOKEN_RE.test(rec.token)
  );
}

/** Whether the record `raw`, read from `file`, belongs to a holder that is demonstrably gone. */
async function isAbandoned(file: string, raw: string, judge: Judge): Promise<boolean> {
  const rec = parseRecord(raw);
  if (rec) {
    // Ours: live while a call here holds it. One nobody here holds — left at the path by a
    // remover that restored it after we had given its token up — would otherwise read as a live,
    // vouched pid that never releases, and wedge the lock for as long as this process runs.
    if (writtenByThisThread(rec)) return !heldTokens.has(rec.token);
    // Our pid, another writer: a predecessor that crashed and restarted as this pid, or a twin in
    // another pid namespace. Asking whether the pid is alive asks about us, so only the heartbeat
    // can answer — see `OWN_PID_STALE_MS`. This only ever adds a way out: a record the pid cannot
    // be vouched for (another boot's) keeps the one-look `staleMs` rule it has below, or a same-pid
    // record left before a host reboot would wait out the confirmation it never needed.
    if (rec.pid === process.pid) {
      if (!pidVouched(rec) && (await olderThan(file, judge.staleMs))) return true;
      return staleAcrossSightings(file, raw, judge, Math.min(judge.staleMs, OWN_PID_STALE_MS));
    }
    // A holder whose process is gone can never release its lock.
    if (!pidAlive(rec.pid)) return true;
    // Alive on the boot that recorded it: not on one look at its age, however long it slept.
    if (pidVouched(rec)) return staleAcrossSightings(file, raw, judge, judge.staleMs);
  }
  // Unparseable (may be a holder part-way through writing it), or a live pid that may be another
  // boot's reuse: only once it has stopped being touched.
  return olderThan(file, judge.staleMs);
}

/**
 * Whether `file` holds the record `raw`, stale (no heartbeat for over `staleMs`), and has held that
 * same record — same identity, same mtime — since it was first seen stale at least
 * `STALE_CONFIRM_MS` ago. The first sighting never answers yes, so a record whose holder heartbeats
 * between the two looks is never taken.
 */
async function staleAcrossSightings(
  file: string,
  raw: string,
  judge: Judge,
  staleMs: number,
): Promise<boolean> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    judge.sightings.delete(file);
    return false; // already gone
  }
  if (Date.now() - mtimeMs <= staleMs) {
    judge.sightings.delete(file);
    return false;
  }
  const identity = identityOf(raw);
  const now = judge.clock();
  const seen = judge.sightings.get(file);
  if (!seen || seen.identity !== identity || seen.mtimeMs !== mtimeMs) {
    judge.sightings.set(file, { identity, mtimeMs, at: now });
    return false;
  }
  return now - seen.at >= STALE_CONFIRM_MS;
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
  token: string,
): Promise<OpenAttempt> {
  try {
    const handle = await deps.opener(lockPath);
    const contents: LockFileContents = {
      pid: process.pid,
      owner,
      acquiredAt: new Date().toISOString(),
      token,
      bootedAt: readBootStamp(),
      threadId,
      nonce: processNonce,
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
  token: string = newToken(),
): Promise<boolean> {
  const first = await attemptOpen(lockPath, owner, deps, token);
  if (first === 'acquired') return true;
  if (first === 'contended') return false;

  // A win32 EPERM/EACCES with no lock file on disk is judged a genuine failure by
  // isLockContentionError — but that judgement can be a TOCTOU false negative: the previous
  // holder's delete may complete in the gap between our failed open() and the existsSync check
  // inside it, so "no lock file" at that instant doesn't mean the open() itself wasn't racing a
  // delete-pending handle. Re-attempt once before treating it as real: if the retry succeeds or
  // finds contention, this was the race; only a second permission failure is surfaced.
  if (deps.platform === 'win32' && (first.code === 'EPERM' || first.code === 'EACCES')) {
    const retry = await attemptOpen(lockPath, owner, deps, token);
    if (retry === 'acquired') return true;
    if (retry === 'contended') return false;
    throw retry;
  }
  throw first;
}

/** The exclusive right to remove one record from the lock path; `done` gives it up. */
interface RemovalRight {
  done: () => Promise<void>;
}

/** Create `file` exclusively with `contents`: created, already present, or a real failure. */
async function createExclusive(
  file: string,
  contents: string,
): Promise<'created' | 'exists' | NodeJS.ErrnoException> {
  try {
    const handle = await open(file, 'wx');
    try {
      await handle.writeFile(contents, 'utf8');
    } finally {
      await handle.close();
    }
    return 'created';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (isLockContentionError(code, process.platform, () => existsSync(file))) return 'exists';
    return err as NodeJS.ErrnoException;
  }
}

/**
 * Take the exclusive right to remove the record `identity` from `lockPath`, or null when someone
 * else holds it (a live remover is at work, or one just finished); a marker that cannot be created
 * at all throws. A marker whose own creator is demonstrably gone — judged exactly as a lock record
 * is — is stepped past to the next generation, which only one caller can create; the dead one
 * cannot act, so it is never a second remover. Generations are not capped: every one stepped past
 * is a dead marker that exists on disk, so the walk ends, and a cap would strand for good a record
 * whose identity (the bytes of an empty record, say) had outlived that many crashed removers.
 */
async function takeRemovalRight(
  lockPath: string,
  identity: string,
  judge: Judge,
): Promise<RemovalRight | null> {
  const token = newToken();
  const record: LockFileContents = {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    token,
    bootedAt: readBootStamp(),
    threadId,
    nonce: processNonce,
  };
  heldTokens.add(token);
  try {
    for (let gen = 0; ; gen++) {
      const marker = `${lockPath}.rm-${identity}.${gen}`;
      const made = await createExclusive(marker, JSON.stringify(record));
      if (made === 'created') {
        return {
          // Only our own generation, never a dead one below it: a peer that judged that dead
          // marker may be about to create the generation after it, and a deleted lower generation
          // would let a third caller create it afresh and hold the right alongside that peer. A
          // dead creator's marker is therefore left in place — litter only after a crash.
          done: async () => {
            await rm(marker, RM_OPTS).catch(() => {});
            heldTokens.delete(token);
          },
        };
      }
      if (made !== 'exists') throw made;
      const raw = await readRaw(marker);
      // Gone already (its remover finished) or being judged unreadable-and-fresh: not ours to
      // take this round — the caller re-reads and retries.
      if (raw === null || !(await isAbandoned(marker, raw, judge))) {
        heldTokens.delete(token);
        return null;
      }
    }
  } catch (err) {
    heldTokens.delete(token);
    throw err;
  }
}

/**
 * Rename a file, retrying the transient refusals Windows gives while a handle is closing — or while
 * a concurrent rename onto the same target still holds it (`MoveFileExW` with `REPLACE_EXISTING`
 * answers EPERM/EACCES/EBUSY there). Elsewhere those codes are real, and the few short retries cost
 * only a delay before the same error surfaces. `renameFn` is a test seam.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  renameFn: (from: string, to: string) => Promise<void> = rename,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await renameFn(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!transient || attempt >= RM_OPTS.maxRetries) throw err;
      await sleep(RM_OPTS.retryDelay);
    }
  }
}

/**
 * Remove the record `identity` from `lockPath`, holding its removal right. The record is renamed
 * aside to a name nobody else uses, then verified there; if it turns out not to be the one judged
 * (only possible for a token-less record rewritten in place), it is put back without overwriting
 * anything. Returns whether the judged record was removed.
 */
async function removeRecord(lockPath: string, identity: string): Promise<boolean> {
  const aside = `${lockPath}.gone-${process.pid}-${newToken()}`;
  try {
    await renameWithRetry(lockPath, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  const moved = await readRaw(aside);
  if (moved !== null && identityOf(moved) === identity) {
    await rm(aside, RM_OPTS);
    return true;
  }
  // Not what was judged: restore it by exclusive create, never by a rename that could overwrite
  // a lock taken in the meantime.
  try {
    await link(aside, lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST' && moved !== null) {
      await createExclusive(lockPath, moved);
    }
  }
  await rm(aside, RM_OPTS).catch(() => {});
  return false;
}

/** Whether the record at `lockPath` is `token`'s — true unless it is shown to be gone or other. */
async function stillOurs(lockPath: string, token: string): Promise<boolean> {
  try {
    return identityOf(await readFile(lockPath, 'utf8')) === token;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * Remove the lock if its holder is demonstrably gone. Returns true if the caller should retry
 * `tryAcquire` immediately (the stale record is gone, whoever removed it).
 */
async function reclaimIfStale(lockPath: string, judge: Judge): Promise<boolean> {
  const raw = await readRaw(lockPath);
  if (raw === null || !(await isAbandoned(lockPath, raw, judge))) return false;
  const identity = identityOf(raw);
  const right = await takeRemovalRight(lockPath, identity, judge).catch(() => null);
  if (!right) return false;
  try {
    // Judged again under the right: nobody else can remove this record now, so what is seen
    // here stays at the path until we remove it.
    const again = await readRaw(lockPath);
    if (again === null || identityOf(again) !== identity) return true; // already removed
    if (!(await isAbandoned(lockPath, again, judge))) return false;
    return await removeRecord(lockPath, identity);
  } catch {
    return false;
  } finally {
    await right.done();
  }
}

/**
 * Release the lock — but only a record that is still ours. One that was reclaimed from under us
 * (judged abandoned) now belongs to its remover or to a successor, and deleting it would let a
 * third holder in.
 */
async function release(lockPath: string, token: string, judge: Judge): Promise<void> {
  for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt++) {
    const right = await takeRemovalRight(lockPath, token, judge);
    if (right) {
      try {
        if (await stillOurs(lockPath, token)) await removeRecord(lockPath, token);
        return;
      } finally {
        await right.done();
      }
    }
    // A remover judged our record abandoned and holds its marker. It either removes the record or,
    // re-judging it under the marker, backs off and leaves it — and a record of ours left behind
    // while this process lives would never be reclaimed. So wait it out and look again.
    if (!(await stillOurs(lockPath, token))) return;
    await sleep(POLL_MS);
  }
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
 * Run `fn` while holding an exclusive lock at `lockPath`, releasing it however `fn` ends. `fn`
 * receives how long this call waited to acquire the lock, and who it waited on — purely
 * informational, reported by callers such as `compile`; it changes nothing about *when* the lock
 * is acquired (same poll interval, same stale reclaim, same timeout).
 *
 * Concurrent callers in this process are expected to be serialised by a mutex first; this is the
 * guard against *other* processes.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: (lock: LockAcquisition) => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const judge = newJudge(opts.staleMs ?? DEFAULT_STALE_MS, opts.clock);
  await mkdir(path.dirname(lockPath), { recursive: true });

  const t0 = Date.now();
  // Recorded only once we are actually about to sleep on a live holder — never on the
  // uncontended path (no extra disk read on the fast path) and never for a holder that turned
  // out to be reclaimable (dead pid or stale heartbeat): that one was never waited on, it was
  // cleared on the spot and the next `tryAcquire` may well succeed immediately. Once set, later
  // polls don't re-read the holder; it is re-read only on a poll where it is still undefined.
  let waitedOn: string | undefined;

  const deadline = t0 + timeoutMs;
  let token = newToken();
  heldTokens.add(token);
  try {
    for (;;) {
      if (await tryAcquire(lockPath, opts.owner, undefined, token)) {
        // Our record is complete only once written: a remover that judged the empty file of a
        // create stalled past `staleMs` could have taken it in between. Held means it is still
        // ours. Only a positive answer that it is not counts: a read that merely fails (a Windows
        // scanner's hold) must not strand our own record, which nobody would ever reclaim.
        if (await stillOurs(lockPath, token)) break;
        // Given up: if a remover's restore puts this record back, `heldTokens` no longer vouches
        // for it, so it is reclaimable rather than a live pid nobody will ever release.
        heldTokens.delete(token);
        token = newToken();
        heldTokens.add(token);
        continue;
      }
      if (await reclaimIfStale(lockPath, judge)) continue;
      if (waitedOn === undefined) {
        const holder = await readHolder(lockPath);
        if (holder) waitedOn = holder.owner ?? String(holder.pid);
      }
      if (Date.now() >= deadline) throw new LockTimeoutError(lockPath, await readHolder(lockPath));
      await sleep(POLL_MS);
    }
    const lock: LockAcquisition = {
      waitedMs: Date.now() - t0,
      ...(waitedOn ? { waitedOn } : {}),
    };

    // Keep the lock looking alive for as long as we hold it, so a slow clone or push is never
    // mistaken for an abandoned lock. Unref'd so it can't hold the process open.
    const heartbeat = setInterval(() => {
      const now = new Date();
      void utimes(lockPath, now, now).catch(() => {});
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      return await fn(lock);
    } finally {
      clearInterval(heartbeat);
      await release(lockPath, token, judge);
    }
  } finally {
    // Released, or never taken. A record of ours still at the path now (a release that gave up
    // on a stuck remover) is reclaimable by this thread's next caller rather than wedged.
    heldTokens.delete(token);
  }
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { existsSync, utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { threadId } from 'node:worker_threads';
import { mkdtemp, mkdir, readdir, rm, writeFile, readFile, utimes } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
  withFileLock,
  LockTimeoutError,
  isLockContentionError,
  tryAcquire,
  processNonce,
} from '../../src/lib/fileLock.js';
import type { LockAttemptDeps, LockAcquisition } from '../../src/lib/fileLock.js';
import { currentBootStamp } from '../../src/lib/bootIdentity.js';

describe('withFileLock', () => {
  let dir: string;
  let lock: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wlm-lock-'));
    lock = path.join(dir, 'nested', 'project.lock');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the lock while held and removes it afterwards', async () => {
    const held = await withFileLock(
      lock,
      async () => {
        const contents = JSON.parse(await readFile(lock, 'utf8')) as {
          pid: number;
          owner?: string;
        };
        expect(contents.pid).toBe(process.pid);
        expect(contents.owner).toBe('writer');
        return 'done';
      },
      { owner: 'writer' },
    );
    expect(held).toBe('done');
    await expect(readFile(lock, 'utf8')).rejects.toThrow();
  });

  it('releases the lock when the body throws', async () => {
    await expect(withFileLock(lock, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    await expect(readFile(lock, 'utf8')).rejects.toThrow();
    // Still takeable afterwards.
    await expect(withFileLock(lock, () => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('serialises overlapping holders rather than letting both run', async () => {
    const order: string[] = [];
    const body = (name: string) => async () => {
      order.push(`${name}:enter`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`${name}:exit`);
    };
    await Promise.all([withFileLock(lock, body('a')), withFileLock(lock, body('b'))]);

    // Whoever went first must have finished before the other started.
    expect(order).toHaveLength(4);
    const first = order[0] as string;
    expect(order[1]).toBe(first.replace(':enter', ':exit'));
  });

  it('times out, naming the session that holds the lock', async () => {
    await withFileLock(
      lock,
      async () => {
        await expect(
          withFileLock(lock, () => Promise.resolve('never'), { timeoutMs: 120 }),
        ).rejects.toThrow(LockTimeoutError);
        await expect(
          withFileLock(lock, () => Promise.resolve('never'), { timeoutMs: 120 }),
        ).rejects.toThrow(/session "method-section"/);
      },
      { owner: 'method-section' },
    );
  });

  it('reclaims a lock whose owning process is gone', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(lock), { recursive: true });
    // pid 2^22 is above every platform's default pid_max, so it cannot be a live process.
    await writeFile(
      lock,
      JSON.stringify({ pid: 4_194_304, owner: 'crashed', acquiredAt: new Date().toISOString() }),
    );
    await expect(
      withFileLock(lock, () => Promise.resolve('taken'), { timeoutMs: 500 }),
    ).resolves.toBe('taken');
  });

  it('does not report a reclaimed dead holder as something we waited on', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(lock), { recursive: true });
    // A pid far above any platform's pid_max cannot be a live process — it is reclaimed on the
    // very first loop iteration, before ever checking who to report as `waitedOn`. Reporting
    // "ghost" here would be a lie: we never actually waited on it, we cleared it and moved on.
    await writeFile(
      lock,
      JSON.stringify({ pid: 999_999_999, owner: 'ghost', acquiredAt: new Date().toISOString() }),
    );
    const captured = await withFileLock(lock, (l) => Promise.resolve(l), { timeoutMs: 500 });
    expect(captured.waitedOn).toBeUndefined();
  });

  it('reclaims an unparseable lock once it has gone stale', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, '{ partial');
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await expect(
      withFileLock(lock, () => Promise.resolve('taken'), { timeoutMs: 500, staleMs: 1_000 }),
    ).resolves.toBe('taken');
  });

  it('waits for a fresh unparseable lock instead of stealing it', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, '{ partial'); // just written — a holder may be mid-creation
    await expect(
      withFileLock(lock, () => Promise.resolve('stolen'), { timeoutMs: 120, staleMs: 60_000 }),
    ).rejects.toThrow(LockTimeoutError);
  });

  it('does not claim another session holds the lock when no holder was recorded', () => {
    const err = new LockTimeoutError(lock, null);
    expect(err.message).not.toMatch(/held by/);
    expect(err.message).not.toMatch(/pid \?/);
    expect(err.message).toMatch(/no holder was recorded/);
  });

  const remedy = (): string =>
    ` If no other web-latex-mcp session is running, the lock was left behind by a crash: ` +
    `delete ${lock} and retry.`;

  it('keeps the existing message wording for a real holder, plus the manual remedy', () => {
    const err = new LockTimeoutError(lock, {
      pid: 4242,
      owner: 'method-section',
      acquiredAt: '2024-01-01T00:00:00.000Z',
    });
    expect(err.message).toBe(
      `Timed out waiting for the lock on nested — held by session "method-section" ` +
        `since 2024-01-01T00:00:00.000Z. Another session is mid-operation; retry shortly.` +
        remedy(),
    );
  });

  it('keeps the existing message wording for a real holder with no owner, plus the remedy', () => {
    const err = new LockTimeoutError(lock, {
      pid: 4242,
      acquiredAt: '2024-01-01T00:00:00.000Z',
    });
    expect(err.message).toBe(
      `Timed out waiting for the lock on nested — held by pid 4242 ` +
        `since 2024-01-01T00:00:00.000Z. Another session is mid-operation; retry shortly.` +
        remedy(),
    );
  });

  it('reports no wait and no holder when the lock is free (uncontended fast path)', async () => {
    const captured = await withFileLock(lock, (l) => Promise.resolve(l), { owner: 'writer' });
    // The claim under test is "did not wait for a holder", not a timing budget — a loaded CI
    // runner can pay far more than a couple of milliseconds for the real filesystem write, and
    // that is not a regression. `waitedOn` is what actually proves no wait happened.
    expect(captured.waitedMs).toBeGreaterThanOrEqual(0);
    expect(captured.waitedMs).toBeLessThan(1000);
    expect(captured.waitedOn).toBeUndefined();
  });

  it('reports how long a contended caller waited and who it waited on', async () => {
    const captured: LockAcquisition[] = [];
    const first = withFileLock(
      lock,
      async (l) => {
        captured[0] = l;
        await new Promise((r) => setTimeout(r, 150));
        return 'first';
      },
      { owner: 'writer' },
    );
    // Give the first call a moment to actually acquire before the second one starts polling.
    await new Promise((r) => setTimeout(r, 20));
    const second = withFileLock(
      lock,
      async (l) => {
        captured[1] = l;
        return 'second';
      },
      { owner: 'reader' },
    );
    await Promise.all([first, second]);

    expect(captured[0]?.waitedMs).toBeGreaterThanOrEqual(0);
    expect(captured[0]?.waitedMs).toBeLessThan(1000);
    expect(captured[0]?.waitedOn).toBeUndefined();
    expect(captured[1]?.waitedMs).toBeGreaterThanOrEqual(100);
    expect(captured[1]?.waitedOn).toBe('writer');
  });
});

describe('isLockContentionError', () => {
  it('treats EEXIST as contention on every platform', () => {
    expect(isLockContentionError('EEXIST', 'linux', () => false)).toBe(true);
    expect(isLockContentionError('EEXIST', 'win32', () => false)).toBe(true);
    expect(isLockContentionError('EEXIST', 'darwin', () => true)).toBe(true);
  });

  it('treats win32 EPERM/EACCES as contention only when the lock file is present', () => {
    expect(isLockContentionError('EPERM', 'win32', () => true)).toBe(true);
    expect(isLockContentionError('EACCES', 'win32', () => true)).toBe(true);
  });

  it('does not treat win32 EPERM/EACCES as contention when the lock file is absent', () => {
    // No lock file means there is nothing pending deletion: a genuine permission problem
    // (read-only volume, restrictive ACL, antivirus hold) that will never resolve on its own.
    expect(isLockContentionError('EPERM', 'win32', () => false)).toBe(false);
    expect(isLockContentionError('EACCES', 'win32', () => false)).toBe(false);
  });

  it('never treats EPERM/EACCES as contention off win32, file present or not', () => {
    expect(isLockContentionError('EPERM', 'linux', () => true)).toBe(false);
    expect(isLockContentionError('EACCES', 'darwin', () => true)).toBe(false);
    expect(isLockContentionError('EPERM', 'linux', () => false)).toBe(false);
  });

  it('treats any other error code as a real failure', () => {
    expect(isLockContentionError('ENOSPC', 'win32', () => true)).toBe(false);
    expect(isLockContentionError(undefined, 'win32', () => true)).toBe(false);
  });

  it('does not consult lockFileExists on the EEXIST path (defect B regression)', () => {
    // EEXIST is contention unconditionally on every platform, so the (synchronous,
    // disk-touching) existence check must never even be invoked for it — otherwise every
    // ordinary poll of every lock wait, on every platform, pays a stat() it doesn't need.
    let called = false;
    const lockFileExists = () => {
      called = true;
      return false;
    };
    expect(isLockContentionError('EEXIST', 'win32', lockFileExists)).toBe(true);
    expect(isLockContentionError('EEXIST', 'linux', lockFileExists)).toBe(true);
    expect(called).toBe(false);
  });

  it('does not consult lockFileExists for a non-win32, non-EEXIST code', () => {
    let called = false;
    const lockFileExists = () => {
      called = true;
      return true;
    };
    expect(isLockContentionError('EPERM', 'linux', lockFileExists)).toBe(false);
    expect(called).toBe(false);
  });

  it('does consult lockFileExists on the win32 EPERM/EACCES path', () => {
    let called = false;
    const lockFileExists = () => {
      called = true;
      return true;
    };
    expect(isLockContentionError('EPERM', 'win32', lockFileExists)).toBe(true);
    expect(called).toBe(true);
  });
});

describe('tryAcquire (win32 delete-pending retry)', () => {
  let dir: string;
  let lock: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wlm-tryacquire-'));
    lock = path.join(dir, 'project.lock');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  type FakeHandle = Pick<FileHandle, 'writeFile' | 'close'>;
  /** A scripted attempt: `'ok'` to acquire, otherwise the errno code the open() rejects with. */
  type Outcome = 'ok' | 'EPERM' | 'EACCES' | 'EEXIST' | 'ENOSPC';

  /** Builds a fake opener from a scripted list of outcomes; tracks how many times it was called. */
  function fakeOpener(outcomes: Outcome[]): {
    opener: (lockPath: string) => Promise<FakeHandle>;
    calls: () => number;
    written: () => string[];
  } {
    let callCount = 0;
    const writes: string[] = [];
    const opener = async (_lockPath: string): Promise<FakeHandle> => {
      const outcome = outcomes[callCount];
      callCount += 1;
      if (outcome === undefined) {
        throw new Error(`fakeOpener called more times (${callCount}) than scripted`);
      }
      if (outcome === 'ok') {
        const handle: FakeHandle = {
          writeFile: async (data) => {
            writes.push(typeof data === 'string' ? data : data.toString());
          },
          close: async () => {},
        };
        return handle;
      }
      const err = new Error(`scripted failure: ${outcome}`) as NodeJS.ErrnoException;
      err.code = outcome;
      throw err;
    };
    return { opener, calls: () => callCount, written: () => writes };
  }

  function deps(outcomes: Outcome[], platform: string): LockAttemptDeps & { calls: () => number } {
    const fake = fakeOpener(outcomes);
    return { opener: fake.opener, platform, calls: fake.calls };
  }

  it('default deps still work on a fresh path, and a second call sees contention', async () => {
    const acquired = await tryAcquire(lock, 'owner-a');
    expect(acquired).toBe(true);
    const contents = JSON.parse(await readFile(lock, 'utf8')) as { pid: number; owner?: string };
    expect(contents.pid).toBe(process.pid);
    expect(contents.owner).toBe('owner-a');

    const second = await tryAcquire(lock, 'owner-b');
    expect(second).toBe(false);
  });

  it('win32 EPERM, lock file absent, retry acquires', async () => {
    expect(existsSync(lock)).toBe(false);
    const d = deps(['EPERM', 'ok'], 'win32');
    await expect(tryAcquire(lock, 'owner', d)).resolves.toBe(true);
    expect(d.calls()).toBe(2);
  });

  it('win32 EACCES, lock file absent, retry finds contention', async () => {
    expect(existsSync(lock)).toBe(false);
    const d = deps(['EACCES', 'EEXIST'], 'win32');
    await expect(tryAcquire(lock, 'owner', d)).resolves.toBe(false);
    expect(d.calls()).toBe(2);
  });

  it('win32 EPERM, lock file absent, retry fails EPERM again — throws the retry error', async () => {
    expect(existsSync(lock)).toBe(false);
    let callIndex = 0;
    const messages = ['first failure', 'second failure'];
    const opener = async (): Promise<FakeHandle> => {
      const message = messages[callIndex];
      callIndex += 1;
      const err = new Error(message) as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    };
    const d: LockAttemptDeps = { opener, platform: 'win32' };
    await expect(tryAcquire(lock, 'owner', d)).rejects.toThrow('second failure');
    expect(callIndex).toBe(2);
  });

  it('win32 EPERM with the lock file present — treated as contention, no retry', async () => {
    await writeFile(lock, 'existing-holder');
    const d = deps(['EPERM'], 'win32');
    await expect(tryAcquire(lock, 'owner', d)).resolves.toBe(false);
    expect(d.calls()).toBe(1);
  });

  it('not win32 — EPERM/EACCES are surfaced immediately, no retry', async () => {
    const linuxDeps = deps(['EPERM'], 'linux');
    await expect(tryAcquire(lock, 'owner', linuxDeps)).rejects.toThrow();
    expect(linuxDeps.calls()).toBe(1);

    const darwinDeps = deps(['EACCES'], 'darwin');
    await expect(tryAcquire(lock, 'owner', darwinDeps)).rejects.toThrow();
    expect(darwinDeps.calls()).toBe(1);
  });

  it('win32, non-permission code — surfaced immediately, no retry', async () => {
    const d = deps(['ENOSPC'], 'win32');
    await expect(tryAcquire(lock, 'owner', d)).rejects.toThrow();
    expect(d.calls()).toBe(1);
  });

  it('the written contents go through the injected opener', async () => {
    const fake = fakeOpener(['ok']);
    const d: LockAttemptDeps = { opener: fake.opener, platform: 'linux' };
    await expect(tryAcquire(lock, 'owner-c', d)).resolves.toBe(true);
    const written = fake.written();
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] as string)).toMatchObject({
      pid: process.pid,
      owner: 'owner-c',
    });
  });
});

describe('withFileLock never admits two holders', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wlm-lockrace-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A pid far above every platform's pid_max: `kill(pid, 0)` can only answer ESRCH. */
  const DEAD_PID = 2_147_483_600;

  it('lets exactly one of several waiters reclaim a crashed holder (overlap count, not timing)', async () => {
    // Before the fix `reclaimIfStale` read the holder, judged it dead, then `rm`ed whatever was at
    // the path NOW — so a waiter that judged the crashed holder stale could delete the lock a
    // faster waiter had just reclaimed and taken, and take it too (about two trials in three, on
    // the pre-fix code, with this shape). Trials run four at a time, each in its own directory;
    // what is counted is overlap inside `fn`, never elapsed time, so a loaded runner can change
    // how often the race is *attempted* but never make a correct lock fail.
    const TRIALS = 60;
    const BATCH = 4;
    const WAITERS = 3;
    let overlappingTrials = 0;
    const leftovers: string[] = [];
    const trial = async (n: number): Promise<void> => {
      const lock = path.join(dir, `t${n}`, 'project.lock');
      await mkdir(path.dirname(lock), { recursive: true });
      await writeFile(
        lock,
        JSON.stringify({ pid: DEAD_PID, owner: 'crashed', acquiredAt: new Date().toISOString() }),
      );
      let inside = 0;
      let maxInside = 0;
      await Promise.all(
        Array.from({ length: WAITERS }, async (_w, i) => {
          // A different stagger per waiter and per trial, so the interleavings vary.
          await new Promise((r) => setTimeout(r, (n * 7 + i * 3) % 5));
          await withFileLock(
            lock,
            async () => {
              inside++;
              maxInside = Math.max(maxInside, inside);
              await new Promise((r) => setTimeout(r, 10));
              inside--;
            },
            { timeoutMs: 20_000 },
          );
        }),
      );
      if (maxInside > 1) overlappingTrials++;
      // Removal markers and renamed-aside records are gone once everyone has released.
      leftovers.push(...(await readdir(path.dirname(lock))));
    };
    for (let start = 0; start < TRIALS; start += BATCH) {
      await Promise.all(Array.from({ length: BATCH }, (_, k) => trial(start + k)));
    }
    expect(overlappingTrials).toBe(0);
    expect(leftovers).toEqual([]);
  });

  it('does not delete, on release, a lock file that is no longer its own', async () => {
    const lock = path.join(dir, 'project.lock');
    const successor = JSON.stringify({
      pid: process.pid,
      owner: 'successor',
      acquiredAt: new Date().toISOString(),
      token: 'b'.repeat(32),
    });
    await withFileLock(lock, async () => {
      // Our lock was reclaimed out from under us and a successor now holds the path.
      await rm(lock, { force: true });
      await writeFile(lock, successor);
    });
    expect(await readFile(lock, 'utf8')).toBe(successor);
  });

  it('does not reclaim on one look at heartbeat age while its pid is visibly alive on this boot', async () => {
    // A laptop that slept past `staleMs` wakes with every lock's mtime old; the holder's 5s
    // heartbeat has not fired yet. Its pid answers and its boot stamp is this boot's, so it is
    // alive, and stealing its lock puts two sessions into git at once. (It is reclaimed only once
    // seen stale and unchanged twice, STALE_CONFIRM_MS apart — far beyond this 300ms wait. The
    // record carries no threadId, so the this-thread shortcut does not decide it.)
    const lock = path.join(dir, 'project.lock');
    await mkdir(dir, { recursive: true });
    await writeFile(
      lock,
      JSON.stringify({
        pid: process.pid,
        owner: 'asleep',
        // Before this process started, so only the boot stamp can vouch for the pid.
        acquiredAt: new Date(Date.now() - 3_600_000).toISOString(),
        bootedAt: currentBootStamp(),
        token: 'c'.repeat(32),
      }),
    );
    const old = new Date(Date.now() - 600_000);
    await utimes(lock, old, old);
    await expect(
      withFileLock(lock, () => Promise.resolve('stolen'), { timeoutMs: 300, staleMs: 1_000 }),
    ).rejects.toThrow(/session "asleep"/);
  });

  it('does not reclaim a crashed holder while a live remover holds its removal marker', async () => {
    // The exclusion itself: only the creator of `<lock>.rm-<token>.<gen>` may remove that record,
    // so a waiter that judged the same crashed holder stale backs off instead of racing it.
    const lock = path.join(dir, 'project.lock');
    const token = 'e'.repeat(32);
    await writeFile(
      lock,
      JSON.stringify({ pid: DEAD_PID, acquiredAt: new Date().toISOString(), token }),
    );
    await writeFile(
      `${lock}.rm-${token}.0`,
      JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        bootedAt: currentBootStamp(),
        token: 'f'.repeat(32),
      }),
    );
    await expect(
      withFileLock(lock, () => Promise.resolve('raced'), { timeoutMs: 300 }),
    ).rejects.toThrow(LockTimeoutError);
  });

  it('steps past a removal marker whose creator crashed', async () => {
    // Liveness of the mechanism above, not a regression test (it passes before the fix, which
    // ignored markers): a remover that died holding a marker must not strand the lock for good.
    // Its dead marker stays: deleting it could hand the removal right to two callers at once.
    const lock = path.join(dir, 'project.lock');
    const token = 'a'.repeat(32);
    await writeFile(
      lock,
      JSON.stringify({ pid: DEAD_PID, acquiredAt: new Date().toISOString(), token }),
    );
    await writeFile(
      `${lock}.rm-${token}.0`,
      JSON.stringify({
        pid: DEAD_PID,
        acquiredAt: new Date().toISOString(),
        token: 'f'.repeat(32),
      }),
    );
    await expect(
      withFileLock(lock, () => Promise.resolve('taken'), { timeoutMs: 2_000 }),
    ).resolves.toBe('taken');
    expect(await readdir(dir)).toEqual([`project.lock.rm-${token}.0`]);
  });

  it('still reclaims by heartbeat age a live pid whose record names another boot', async () => {
    // Boundary of the rule above, not a regression test for it (it passes before the fix too):
    // after a reboot a crashed holder's pid can be reused by an unrelated process, and refusing
    // the mtime fallback for it would strand the lock forever.
    const lock = path.join(dir, 'project.lock');
    await mkdir(dir, { recursive: true });
    await writeFile(
      lock,
      JSON.stringify({
        pid: process.pid,
        owner: 'previous-boot',
        acquiredAt: '2001-01-01T00:00:00.000Z',
        bootedAt: '2000-12-31T00:00:00.000Z',
        token: 'd'.repeat(32),
      }),
    );
    const old = new Date(Date.now() - 600_000);
    await utimes(lock, old, old);
    await expect(
      withFileLock(lock, () => Promise.resolve('taken'), { timeoutMs: 2_000, staleMs: 1_000 }),
    ).resolves.toBe('taken');
  });
});

describe('withFileLock never wedges on a holder that can no longer release', () => {
  let dir: string;
  let lock: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wlm-lockwedge-'));
    lock = path.join(dir, 'project.lock');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A clock that jumps `stepMs` on every read, so the confirmation interval passes in a few polls. */
  const steppingClock = (stepMs: number, onRead?: () => void): (() => number) => {
    let t = 0;
    return () => {
      onRead?.();
      t += stepMs;
      return t;
    };
  };

  it('reclaims a vouched live pid whose record stayed stale and unchanged across two observations', async () => {
    // A SIGKILLed holder whose pid was reused on the same boot (Windows reuses pids quickly): the
    // pid answers and the record vouches for it, so round 1's "never by age" kept the lock for as
    // long as the unrelated process lived, and every mutating tool timed out. Our parent process
    // stands in for that unrelated live process: alive, on this boot, and not us.
    await writeFile(
      lock,
      JSON.stringify({
        pid: process.ppid,
        owner: 'killed',
        acquiredAt: new Date().toISOString(),
        bootedAt: currentBootStamp(),
        token: '1'.repeat(32),
      }),
    );
    const old = new Date(Date.now() - 600_000);
    await utimes(lock, old, old);
    await expect(
      withFileLock(lock, () => Promise.resolve('taken'), {
        timeoutMs: 3_000,
        staleMs: 1_000,
        clock: steppingClock(3_000),
      }),
    ).resolves.toBe('taken');
  });

  it('does not reclaim a vouched live holder whose heartbeat moves between observations', async () => {
    // Boundary, not a regression test (it passes before the fix, which never reclaimed a vouched
    // pid at all): the laptop-sleep case the rule exists for. The holder's mtime is old on wake,
    // but its overdue heartbeat fires before a second observation, so the record is not the one
    // first judged and the confirmation starts over.
    await writeFile(
      lock,
      JSON.stringify({
        pid: process.ppid,
        owner: 'woken',
        acquiredAt: new Date().toISOString(),
        bootedAt: currentBootStamp(),
        token: '2'.repeat(32),
      }),
    );
    let beats = 0;
    const heartbeat = (): void => {
      // A fresh-but-still-stale mtime per read: stale by age, yet never the same twice.
      const t = new Date(Date.now() - 600_000 + ++beats * 1_000);
      utimesSync(lock, t, t);
    };
    await expect(
      withFileLock(lock, () => Promise.resolve('stolen'), {
        timeoutMs: 400,
        staleMs: 1_000,
        clock: steppingClock(3_000, heartbeat),
      }),
    ).rejects.toThrow(LockTimeoutError);
  });

  it('names the lock file and the manual remedy when it times out', () => {
    const withHolder = new LockTimeoutError(lock, {
      pid: 4242,
      owner: 'method-section',
      acquiredAt: '2024-01-01T00:00:00.000Z',
    });
    expect(withHolder.message).toContain(lock);
    expect(withHolder.message).toMatch(/no other web-latex-mcp session is running/);
    expect(withHolder.message).toMatch(/delete/);
    expect(new LockTimeoutError(lock, null).message).toContain(lock);
  });

  it("reclaims this process's own record once no call in it holds that token (restore window)", async () => {
    // A reclaimer renames our record aside while our acquire's `stillOurs` read runs; we abandon the
    // token and retry, and the reclaimer's link then restores that OLD record — live pid (ours),
    // vouched, fresh, and a token nobody holds. Before the fix nobody could ever reclaim it.
    await writeFile(
      lock,
      JSON.stringify({
        pid: process.pid,
        owner: 'abandoned-by-us',
        acquiredAt: new Date().toISOString(),
        bootedAt: currentBootStamp(),
        token: '3'.repeat(32),
        threadId,
        // Every record this build writes carries its process nonce; without it the record is not
        // recognisably ours (see "across pid namespaces" below).
        nonce: processNonce,
      }),
    );
    await expect(
      withFileLock(lock, () => Promise.resolve('taken'), { timeoutMs: 1_000 }),
    ).resolves.toBe('taken');
  });

  it('reclaims a token-less record even after eight removers of that shape crashed', async () => {
    // An empty (or any token-less) record's marker identity is the hash of its bytes, shared by
    // every such reclaim ever; dead markers are never deleted, so after MAX_MARKER_GENERATIONS
    // crashed removers an empty record could never be reclaimed again.
    const identity = `h${createHash('sha256').update('').digest('hex').slice(0, 32)}`;
    const dead = JSON.stringify({
      pid: 2_147_483_600,
      acquiredAt: new Date().toISOString(),
      token: 'f'.repeat(32),
    });
    const markers = Array.from({ length: 8 }, (_, g) => `project.lock.rm-${identity}.${g}`);
    for (const m of markers) await writeFile(path.join(dir, m), dead);
    await writeFile(lock, '');
    const old = new Date(Date.now() - 600_000);
    await utimes(lock, old, old);
    await expect(
      withFileLock(lock, () => Promise.resolve('taken'), { timeoutMs: 1_000, staleMs: 1_000 }),
    ).resolves.toBe('taken');
    // Only a marker's creator deletes it: the dead ones stay, ours is gone.
    expect((await readdir(dir)).sort()).toEqual([...markers].sort());
  });
});

describe('withFileLock across pid namespaces', () => {
  let dir: string;
  let lock: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wlm-lockns-'));
    lock = path.join(dir, 'project.lock');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * A live holder in another container sharing the workspace volume: both run node as pid 1 on
   * thread 0, so the record carries OUR pid and threadId, a token this process never issued, and a
   * heartbeat that is fresh. pid + threadId alone read it as this thread's own abandoned record and
   * took it on the first poll — two processes in git at once.
   */
  const foreignTwin = (extra: Record<string, unknown>): string =>
    JSON.stringify({
      pid: process.pid,
      owner: 'container-B',
      acquiredAt: new Date().toISOString(),
      bootedAt: currentBootStamp(),
      token: '4'.repeat(32),
      threadId,
      ...extra,
    });

  it('does not take a fresh record carrying our pid and threadId but another process nonce', async () => {
    await writeFile(lock, foreignTwin({ nonce: '5'.repeat(32) }));
    await expect(
      withFileLock(lock, () => Promise.resolve('stolen'), { timeoutMs: 300 }),
    ).rejects.toThrow(/session "container-B"/);
  });

  it('does not take a fresh record carrying our pid and threadId but no nonce (older build)', async () => {
    await writeFile(lock, foreignTwin({}));
    await expect(
      withFileLock(lock, () => Promise.resolve('stolen'), { timeoutMs: 300 }),
    ).rejects.toThrow(/session "container-B"/);
  });

  /** A clock that jumps `stepMs` on every read, so the confirmation interval passes in a few polls. */
  const steppingClock = (stepMs: number, onRead?: () => void): (() => number) => {
    let t = 0;
    return () => {
      onRead?.();
      t += stepMs;
      return t;
    };
  };

  it("reclaims its crashed predecessor's record (same pid, another nonce) by heartbeat age, well inside the default staleMs", async () => {
    // A container's pid 1 crashes and restarts: the new server finds the old one's record carrying
    // its own pid and threadId under another nonce. pidAlive(our own pid) is trivially true and the
    // boot stamp vouches for it, so it was judged like a live holder — reclaimed only after the
    // default 60 s staleMs plus the double sighting, and the first calls timed out after 30 s.
    // The record here is 20 s without a heartbeat: dead by any heartbeat measure, but 40 s short of
    // the default staleMs, which this test deliberately leaves in force.
    await writeFile(
      lock,
      foreignTwin({
        owner: 'old-self',
        acquiredAt: new Date(Date.now() - 120_000).toISOString(),
        nonce: '8'.repeat(32),
      }),
    );
    const old = new Date(Date.now() - 20_000);
    await utimes(lock, old, old);
    await expect(
      withFileLock(lock, () => Promise.resolve('taken'), {
        timeoutMs: 2_000,
        clock: steppingClock(3_000),
      }),
    ).resolves.toBe('taken');
  });

  it('does not reclaim a same-pid twin whose heartbeat is fresh, however far the clock steps', async () => {
    // Boundary, not a regression test (it passes before the fix): a live server in another
    // container heartbeats every few seconds, so its record never ages into the window.
    await writeFile(lock, foreignTwin({ nonce: '5'.repeat(32) }));
    const heartbeat = (): void => {
      const now = new Date();
      utimesSync(lock, now, now);
    };
    await expect(
      withFileLock(lock, () => Promise.resolve('stolen'), {
        timeoutMs: 400,
        clock: steppingClock(3_000, heartbeat),
      }),
    ).rejects.toThrow(/session "container-B"/);
  });

  it('does not reclaim a same-pid twin whose overdue heartbeat lands between the two sightings', async () => {
    // Boundary, not a regression test (it passes before the fix): the laptop-sleep case for a twin.
    // Its mtime is past the window on wake, but its heartbeat moves it before a second look, so
    // the confirmation starts over every time and the lock is never taken.
    await writeFile(lock, foreignTwin({ nonce: '5'.repeat(32) }));
    let beats = 0;
    const heartbeat = (): void => {
      const t = new Date(Date.now() - 20_000 + ++beats * 50);
      utimesSync(lock, t, t);
    };
    heartbeat();
    await expect(
      withFileLock(lock, () => Promise.resolve('stolen'), {
        timeoutMs: 400,
        clock: steppingClock(3_000, heartbeat),
      }),
    ).rejects.toThrow(/session "container-B"/);
  });

  it('prints the lock path with POSIX separators in its timeout message', () => {
    // path.sep is '/' on the Linux and macOS runners, so stub it: otherwise a message that never
    // converted would pass on two of the three CI legs.
    const native = ['C:', 'ws', '.sessions', 'p', 'project.lock'].join('\\');
    const original = Object.getOwnPropertyDescriptor(path, 'sep');
    if (process.platform !== 'win32') {
      Object.defineProperty(path, 'sep', { value: '\\', configurable: true, writable: true });
    }
    try {
      for (const err of [
        new LockTimeoutError(native, { pid: 7, owner: 'x', acquiredAt: 'then' }),
        new LockTimeoutError(native, null),
      ]) {
        expect(err.message).toContain('C:/ws/.sessions/p/project.lock');
        expect(err.message).not.toContain('\\');
      }
    } finally {
      if (process.platform !== 'win32' && original) Object.defineProperty(path, 'sep', original);
    }
  });
});

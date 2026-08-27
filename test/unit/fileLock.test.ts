import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile, utimes } from 'node:fs/promises';
import { withFileLock, LockTimeoutError, isLockContentionError } from '../../src/lib/fileLock.js';

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

  it('keeps the existing message wording for a real holder unchanged', () => {
    const err = new LockTimeoutError(lock, {
      pid: 4242,
      owner: 'method-section',
      acquiredAt: '2024-01-01T00:00:00.000Z',
    });
    expect(err.message).toBe(
      `Timed out waiting for the lock on nested — held by session "method-section" ` +
        `since 2024-01-01T00:00:00.000Z. Another session is mid-operation; retry shortly.`,
    );
  });

  it('keeps the existing message wording for a real holder with no owner', () => {
    const err = new LockTimeoutError(lock, {
      pid: 4242,
      acquiredAt: '2024-01-01T00:00:00.000Z',
    });
    expect(err.message).toBe(
      `Timed out waiting for the lock on nested — held by pid 4242 ` +
        `since 2024-01-01T00:00:00.000Z. Another session is mid-operation; retry shortly.`,
    );
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

describe('win32 delete-pending retry decision (defect A)', () => {
  // The real retry lives inside tryAcquire, which is not exported (it talks to the filesystem
  // directly), and the win32 branch cannot execute on this Linux machine anyway. What's
  // unit-testable everywhere is the *decision* tryAcquire makes: given a first-attempt outcome,
  // does it retry once before rethrowing, and does a retry that succeeds (or finds contention)
  // suppress the original error? This mirrors that decision in isolation.
  function decide(
    platform: string,
    firstCode: string | undefined,
    firstLockFileExists: boolean,
    retryOutcome: 'acquired' | 'contended' | 'permission-failure',
  ): 'acquired' | 'contended' | 'rethrow-first' | 'rethrow-retry' {
    if (isLockContentionError(firstCode, platform, () => firstLockFileExists)) return 'contended';
    const isPermissionCode = firstCode === 'EPERM' || firstCode === 'EACCES';
    if (platform !== 'win32' || !isPermissionCode) return 'rethrow-first';
    // Retry once.
    if (retryOutcome === 'acquired') return 'acquired';
    if (retryOutcome === 'contended') return 'contended';
    return 'rethrow-retry';
  }

  it('retries once when the lock file was absent at the first EPERM/EACCES, and succeeds if the delete-pending race has resolved', () => {
    expect(decide('win32', 'EPERM', false, 'acquired')).toBe('acquired');
    expect(decide('win32', 'EACCES', false, 'contended')).toBe('contended');
  });

  it('still rethrows when the retry also fails with a permission code and the file is still absent', () => {
    expect(decide('win32', 'EPERM', false, 'permission-failure')).toBe('rethrow-retry');
  });

  it('never retries off win32', () => {
    expect(decide('linux', 'EPERM', false, 'acquired')).toBe('rethrow-first');
    expect(decide('darwin', 'EACCES', false, 'acquired')).toBe('rethrow-first');
  });

  it('never retries a non-permission code', () => {
    expect(decide('win32', 'ENOSPC', false, 'acquired')).toBe('rethrow-first');
  });
});

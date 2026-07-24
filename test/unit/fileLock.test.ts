import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile, utimes } from 'node:fs/promises';
import { withFileLock, LockTimeoutError } from '../../src/lib/fileLock.js';

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
});

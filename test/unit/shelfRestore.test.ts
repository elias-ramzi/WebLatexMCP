import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fsRestoreOps as real, writeWithRollback } from '../../src/lib/shelfRestore.js';
import type { RestoreOps, RestoreWrite } from '../../src/lib/shelfRestore.js';

/**
 * `writeWithRollback` is unshelve's write step: put every shelved side into the tree, and if any
 * write fails, put every touched path back as it was. The rollback is where a second failure
 * used to hide the first — one throwing restore aborted the loop, skipped every later path's
 * rollback, and replaced the original error with its own.
 */
describe('writeWithRollback', () => {
  async function tmp(): Promise<string> {
    return mkdtemp(path.join(os.tmpdir(), 'wlm-shelf-restore-'));
  }

  it('writes and deletes as told when nothing fails', async () => {
    const dir = await tmp();
    try {
      await writeFile(path.join(dir, 'gone.tex'), 'old\n');
      await writeWithRollback(dir, [
        { rel: 'sub/new.tex', bytes: Buffer.from('new\n'), before: null },
        { rel: 'gone.tex', bytes: null, before: Buffer.from('old\n') },
      ]);
      expect(await readFile(path.join(dir, 'sub/new.tex'), 'utf8')).toBe('new\n');
      await expect(stat(path.join(dir, 'gone.tex'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rolls back every written path, including the one that threw', async () => {
    const dir = await tmp();
    try {
      await writeFile(path.join(dir, 'a.tex'), 'a before\n');
      await writeFile(path.join(dir, 'b.tex'), 'b before\n');
      const ops: RestoreOps = {
        write: async (abs, bytes) => {
          if (abs.endsWith('b.tex') && bytes.toString() === 'b shelved\n') {
            await writeFile(abs, 'b trunc'); // a partial write, then the failure
            throw new Error('ENOSPC: no space left');
          }
          await real.write(abs, bytes);
        },
        remove: real.remove,
      };
      const writes: RestoreWrite[] = [
        { rel: 'a.tex', bytes: Buffer.from('a shelved\n'), before: Buffer.from('a before\n') },
        { rel: 'b.tex', bytes: Buffer.from('b shelved\n'), before: Buffer.from('b before\n') },
      ];
      await expect(writeWithRollback(dir, writes, ops)).rejects.toThrow(/ENOSPC/);
      expect(await readFile(path.join(dir, 'a.tex'), 'utf8')).toBe('a before\n');
      expect(await readFile(path.join(dir, 'b.tex'), 'utf8')).toBe('b before\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the ORIGINAL error primary and rolls back the rest when one rollback fails', async () => {
    const dir = await tmp();
    try {
      for (const n of ['a', 'b', 'c']) await writeFile(path.join(dir, `${n}.tex`), `${n} before\n`);
      const ops: RestoreOps = {
        write: async (abs, bytes) => {
          const text = bytes.toString();
          // The FORWARD write of c fails (the original error)...
          if (abs.endsWith('c.tex') && text === 'c shelved\n')
            throw new Error('original: EIO on c');
          // ...and the ROLLBACK of a fails with a different one.
          if (abs.endsWith('a.tex') && text === 'a before\n')
            throw new Error('rollback: EACCES on a');
          await real.write(abs, bytes);
        },
        remove: real.remove,
      };
      const writes: RestoreWrite[] = ['a', 'b', 'c'].map((n) => ({
        rel: `${n}.tex`,
        bytes: Buffer.from(`${n} shelved\n`),
        before: Buffer.from(`${n} before\n`),
      }));

      let caught: unknown;
      try {
        await writeWithRollback(dir, writes, ops);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      // The original failure leads; the rollback failure is reported, not substituted.
      expect(message.startsWith('original: EIO on c')).toBe(true);
      expect(message).toContain('a.tex');
      expect(message).toContain('rollback: EACCES on a');
      expect((caught as Error).cause).toBeInstanceOf(Error);
      expect(((caught as Error).cause as Error).message).toBe('original: EIO on c');
      // a's rollback failing did NOT stop b's.
      expect(await readFile(path.join(dir, 'b.tex'), 'utf8')).toBe('b before\n');
      expect(await readFile(path.join(dir, 'c.tex'), 'utf8')).toBe('c before\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

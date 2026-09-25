import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';

/**
 * `readShipoutMarks` on a platform with no `O_NOFOLLOW` — Windows, where `fs.constants.O_NOFOLLOW`
 * is `undefined` and `open` follows a symbolic link at the path. Simulated here by removing the
 * constant for this file only, so the POSIX runners exercise the check that has to hold there:
 * the link is refused before anything is opened.
 *
 * `node:fs/promises` is wrapped too, inert unless a test turns a switch on: `failClose` makes every
 * file handle's `close` reject (after really closing it), and `lstatSaysFile` makes `lstat` report
 * a regular file — a FIFO swapped in between the `lstat` and the `open`.
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const constants = { ...actual.constants, O_NOFOLLOW: undefined };
  return { ...actual, constants, default: { ...actual, constants } };
});

const faults = vi.hoisted(() => ({ failClose: false, lstatSaysFile: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args);
    if (faults.failClose) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        throw Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' });
      };
    }
    return handle;
  };
  const lstat = (async (p: Parameters<typeof actual.lstat>[0]) => {
    const st = await actual.lstat(p);
    return faults.lstatSaysFile ? Object.assign(st, { isFile: () => true }) : st;
  }) as typeof actual.lstat;
  const mocked = { ...actual, open, lstat };
  return { ...mocked, default: mocked };
});

const { readPgfpagesEvidence, readShipoutMarks } = await import('../../src/lib/auxFloats.js');
const { constants } = await import('node:fs');

describe('readShipoutMarks without O_NOFOLLOW (as on Windows)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('runs with the constant removed', () => {
    expect(constants.O_NOFOLLOW).toBeUndefined();
  });

  it('never follows a symbolic link at the log', async (t) => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'shipouts-nofollow-'));
    const target = path.join(dir, 'elsewhere.txt');
    await writeFile(target, '[1] [2]\n');
    try {
      await symlink(target, path.join(dir, 'main.log'));
    } catch {
      t.skip(); // symlink creation needs privileges on some Windows setups
      return;
    }
    expect(await readShipoutMarks(path.join(dir, 'main.aux'))).toBeUndefined();
  });

  it('still reads a regular log', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'shipouts-nofollow-'));
    await writeFile(path.join(dir, 'main.log'), '[1] [2]\n');
    expect(await readShipoutMarks(path.join(dir, 'main.aux'))).toEqual([1, 2]);
  });
});

describe('a failing close is no marks, never an error', () => {
  let dir: string | undefined;
  afterEach(async () => {
    faults.failClose = false;
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('readShipoutMarks keeps the marks it read when the close rejects', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'shipouts-close-'));
    await writeFile(path.join(dir, 'main.log'), '[1] [2]\n');
    faults.failClose = true;
    expect(await readShipoutMarks(path.join(dir, 'main.aux'))).toEqual([1, 2]);
  });

  it('readPgfpagesEvidence keeps the record it read when the close rejects', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'shipouts-close-'));
    await writeFile(path.join(dir, 'main.log'), 'Package: pgfpages 2021/05/15\n');
    await writeFile(path.join(dir, 'main.fls'), 'PWD /build\n');
    faults.failClose = true;
    expect(await readPgfpagesEvidence(path.join(dir, 'main.aux'))).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')(
  'a FIFO swapped in after the lstat is refused, not waited on',
  () => {
    let dir: string | undefined;
    afterEach(async () => {
      faults.lstatSaysFile = false;
      if (!dir) return;
      try {
        // Release a reader stuck in `open` (the regression this guards), so the run can exit.
        const h = await open(path.join(dir, 'main.log'), constants.O_WRONLY | constants.O_NONBLOCK);
        await h.close();
      } catch {
        // No reader waiting: nothing to release.
      }
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    });

    it('readShipoutMarks: no marks', { timeout: 3000 }, async (t) => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'shipouts-fifo-'));
      try {
        execFileSync('mkfifo', [path.join(dir, 'main.log')], { stdio: 'ignore' });
      } catch {
        t.skip(); // no mkfifo on this machine
        return;
      }
      faults.lstatSaysFile = true;
      expect(await readShipoutMarks(path.join(dir, 'main.aux'))).toBeUndefined();
    });
  },
);

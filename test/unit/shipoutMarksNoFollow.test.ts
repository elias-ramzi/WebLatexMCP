import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';

/**
 * `readShipoutMarks` on a platform with no `O_NOFOLLOW` — Windows, where `fs.constants.O_NOFOLLOW`
 * is `undefined` and `open` follows a symbolic link at the path. Simulated here by removing the
 * constant for this file only, so the POSIX runners exercise the check that has to hold there:
 * the link is refused before anything is opened.
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const constants = { ...actual.constants, O_NOFOLLOW: undefined };
  return { ...actual, constants, default: { ...actual, constants } };
});

const { readShipoutMarks } = await import('../../src/lib/auxFloats.js');
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

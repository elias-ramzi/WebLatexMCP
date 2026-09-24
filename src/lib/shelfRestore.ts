import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolveInside } from './paths.js';

/** One path `unshelve` writes: the bytes to put there (`null` = delete it), and what was there. */
export interface RestoreWrite {
  /** Project-relative path, re-resolved inside the project at the point of use. */
  rel: string;
  /** The bytes to write, or `null` to remove the path (the shelf recorded a deletion). */
  bytes: Buffer | null;
  /** What was on disk before, captured by the caller; `null` = the path was absent. */
  before: Buffer | null;
}

/** The two filesystem effects, injectable so the rollback can be tested against failures. */
export interface RestoreOps {
  write(abs: string, bytes: Buffer): Promise<void>;
  remove(abs: string): Promise<void>;
}

export const fsRestoreOps: RestoreOps = {
  write: async (abs, bytes) => {
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
  },
  remove: async (abs) => {
    await rm(abs, { force: true });
  },
};

/**
 * Write every entry into `dir`, and if any write fails, put every touched path back exactly as
 * it was — the same unwind rule `resolvePush` follows, so a failed restore never leaves the tree
 * half-applied.
 *
 * A path is counted as touched BEFORE its write, not after: `writeFile` can fail part-way (ENOSPC,
 * EIO) and leave a truncated file, and the path most likely to be damaged is exactly the one that
 * threw.
 *
 * **The rollback is guarded per path, and the ORIGINAL error stays primary.** One restore that
 * throws must neither abort the rest of the rollback (every later path would stay half-applied)
 * nor replace the error that started it (the caller would be told about EACCES on a rollback and
 * never learn the write failed with ENOSPC). When every restore succeeds the original error is
 * rethrown untouched; when some fail, a new error leads with the original message, names each
 * path left as it is and why, and carries the original as `cause`.
 */
export async function writeWithRollback(
  dir: string,
  writes: RestoreWrite[],
  ops: RestoreOps = fsRestoreOps,
): Promise<void> {
  const touched: RestoreWrite[] = [];
  try {
    for (const w of writes) {
      touched.push(w);
      const abs = resolveInside(dir, w.rel);
      if (w.bytes === null) await ops.remove(abs);
      else await ops.write(abs, w.bytes);
    }
  } catch (err) {
    const unrestored: string[] = [];
    for (const w of touched) {
      try {
        const abs = resolveInside(dir, w.rel);
        if (w.before === null) await ops.remove(abs);
        else await ops.write(abs, w.before);
      } catch (rollbackErr) {
        unrestored.push(
          `${w.rel} (${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)})`,
        );
      }
    }
    if (unrestored.length === 0) throw err;
    const original = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${original.replace(/\.?$/, '.')} Putting the tree back also failed for: ${unrestored.join('; ')} — those ` +
        'path(s) may hold part of the shelved content. Every other touched path was restored.',
      { cause: err },
    );
  }
}

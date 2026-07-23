import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execCapture } from './exec.js';

export interface Merge3Result {
  /** The merged text — with `<<<<<<<` markers when `conflicted` is true. */
  merged: string;
  conflicted: boolean;
}

/** Names written into conflict markers. All three or none — `-L` is positional. */
export interface Merge3Labels {
  ours: string;
  base: string;
  theirs: string;
}

/**
 * Three-way merge of `ours` and `theirs` over their common `base`, using `git merge-file`.
 *
 * Operates purely on strings via a temp directory — it touches no repository, index or working
 * tree — so it can move a session's shadow of its own uncommitted work forward onto a new HEAD
 * without disturbing anything anyone else is doing.
 *
 * Uses the same merge engine (and therefore the same conflict-marker format) as a rebase, so a
 * conflict here can be parsed and rendered by the existing conflict machinery.
 */
export async function merge3(
  ours: string,
  base: string,
  theirs: string,
  labels?: Merge3Labels,
): Promise<Merge3Result> {
  // Nothing to reconcile when one side never moved — skip the subprocess entirely.
  if (base === theirs) return { merged: ours, conflicted: false };
  if (base === ours) return { merged: theirs, conflicted: false };
  if (ours === theirs) return { merged: ours, conflicted: false };

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wlm-merge-'));
  try {
    const files = { ours: 'ours', base: 'base', theirs: 'theirs' };
    await Promise.all([
      writeFile(path.join(tmp, files.ours), ours, 'utf8'),
      writeFile(path.join(tmp, files.base), base, 'utf8'),
      writeFile(path.join(tmp, files.theirs), theirs, 'utf8'),
    ]);
    const args = ['merge-file', '-p'];
    if (labels) args.push('-L', labels.ours, '-L', labels.base, '-L', labels.theirs);
    args.push(files.ours, files.base, files.theirs);

    const res = await execCapture('git', args, { cwd: tmp });
    // `git merge-file` exits 0 on a clean merge and with the number of conflicts otherwise;
    // negative (or a signal, surfacing as a null code) means it failed to run at all.
    if (res.code === null || res.code < 0) {
      throw new Error(`git merge-file failed: ${res.stderr.trim() || 'no output'}`);
    }
    return { merged: res.stdout, conflicted: res.code > 0 };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import type { TestProject } from 'vitest/node';

/*
 * A vitest global setup (vitest.config.ts `globalSetup`): one directory per test run under the OS
 * temp dir, which `test/integration/helpers/bareRepo.ts` roots its fixture templates in, removed
 * by the teardown below. The templates used to sit in their own `ovl-tpl-*` directory per worker,
 * removed only by that worker's `exit` handler — which a worker vitest terminates never runs, so a
 * day of full-suite runs left thousands of them (about 4.8 GB of /tmp on one machine, #247).
 *
 * The teardown runs in the main process, whatever happened to the workers. A run killed before it
 * reaches the teardown leaves its one directory; the next run removes any such directory older
 * than a day (never a younger one, which may belong to a run still going). The age is the
 * directory's mtime, which only a new template directory refreshes, so a `vitest --watch` session
 * idle for more than a day can have its live directory swept by another run — restart the watcher
 * if so.
 */

declare module 'vitest' {
  export interface ProvidedContext {
    templateRunDir: string;
  }
}

const PREFIX = 'ovl-tpl-run-';
const STALE_MS = 24 * 60 * 60 * 1000;

// Windows keeps transient locks on freshly-used .git files (the OS/AV releases them a beat
// later), so a plain recursive rm can throw EBUSY/ENOTEMPTY — the same retries as bareRepo.ts.
const rmDir = (dir: string): Promise<void> =>
  rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

async function sweepStale(): Promise<void> {
  const tmp = os.tmpdir();
  let names: string[];
  try {
    names = await readdir(tmp);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = path.join(tmp, name);
    try {
      const st = await stat(dir);
      if (st.isDirectory() && now - st.mtimeMs > STALE_MS) {
        await rmDir(dir);
      }
    } catch {
      // Best effort: another run may be removing it too.
    }
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  await sweepStale();
  const dir = await mkdtemp(path.join(os.tmpdir(), PREFIX));
  project.provide('templateRunDir', dir);
  return async () => {
    try {
      await rmDir(dir);
    } catch (err) {
      // Never fail a finished run over cleanup: a later run's stale sweep collects the directory.
      process.stderr.write(
        `templateRunDir: could not remove ${dir} (${(err as Error).message}); a later run will sweep it\n`,
      );
    }
  };
}

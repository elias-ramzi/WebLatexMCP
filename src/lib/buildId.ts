import { statSync } from 'node:fs';
import { getServerVersion } from './version.js';

/**
 * Which build a process runs: its version plus the entry script and that file's modification
 * time (docs/design/shared-server.md §9.2). The version alone cannot tell two builds of one
 * version apart — a launcher that rebuilds `main` in place keeps `0.9.0` and the path — so a
 * proxy compares this whole id with the daemon's, and a rebuilt entry reads as another build.
 */
export function currentBuildId(entry: string | undefined = process.argv[1]): string {
  let stamp = 'unknown';
  if (entry) {
    try {
      stamp = String(Math.trunc(statSync(entry).mtimeMs));
    } catch {
      // An entry that cannot be read: the path alone, which still tells builds in two places apart.
    }
  }
  return `${getServerVersion()}|${entry ?? ''}|${stamp}`;
}

/** The version part of a build id (`currentBuildId`). */
export function versionOfBuild(buildId: string): string {
  return buildId.split('|')[0] ?? 'unknown';
}

/**
 * Compare two dotted versions numerically: negative when `a` is older, positive when newer, `0`
 * when equal or when either does not parse (then neither is known to be older).
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] | undefined => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

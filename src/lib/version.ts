import { readFileSync } from 'node:fs';

/**
 * The server's version, read once from the package's own `package.json`.
 *
 * Resolved relative to this module (`import.meta.url`), not `process.cwd()` — cwd is the
 * agent's launch dir, not the package. Both `src/lib/` (tsx dev) and `dist/lib/` (built)
 * sit two levels under the package root, so `../../package.json` resolves in every install
 * path (dev, built, npx, global). npm always ships `package.json` in the tarball, so it is
 * present even for the npx/global case.
 */
let cached: string | undefined;

export function getServerVersion(): string {
  if (cached !== undefined) return cached;
  try {
    const url = new URL('../../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: unknown };
    cached = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached;
}

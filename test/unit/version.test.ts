import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getServerVersion } from '../../src/lib/version.js';

describe('getServerVersion', () => {
  it("matches the package's own version", () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(getServerVersion()).toBe(pkg.version);
  });

  it('returns a stable, cached value', () => {
    expect(getServerVersion()).toBe(getServerVersion());
  });
});

/**
 * The version is the contract the server advertises, and it is written down in four places: the
 * npm package, the Claude Code plugin and its marketplace entry, and the Desktop Extension
 * manifest. They are bumped by hand at release time (see docs/versioning.md), so the only thing
 * stopping them drifting is a check — `manifest.json` had already fallen a release behind, which
 * meant `npm run bundle` produced an extension labelled with the previous version.
 */
describe('version manifests', () => {
  const read = (rel: string): Record<string, unknown> =>
    JSON.parse(readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')) as Record<
      string,
      unknown
    >;
  const expected = (read('package.json') as { version: string }).version;

  it.each([['.claude-plugin/plugin.json'], ['manifest.json']])(
    '%s matches package.json',
    (file) => {
      expect(read(file).version).toBe(expected);
    },
  );

  it('the marketplace entry matches package.json', () => {
    const marketplace = read('.claude-plugin/marketplace.json') as {
      plugins: Array<{ name: string; version: string }>;
    };
    const entry = marketplace.plugins.find((p) => p.name === 'web-latex-mcp');
    expect(entry?.version).toBe(expected);
  });

  it('the lockfile matches package.json', () => {
    const lock = read('package-lock.json') as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(lock.version).toBe(expected);
    expect(lock.packages['']?.version).toBe(expected);
  });
});

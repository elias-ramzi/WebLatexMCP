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

import { describe, it, expect } from 'vitest';
import { settlePaths } from '../../src/tools/commit.js';

/**
 * `commit scope: "all"` settles this session's shadow for what it committed. Git accepts `"."`,
 * `""` and a leading `"./"` as "everything here", while `coversPath` deliberately covers nothing
 * for `"."`/`""` — so those spellings must become `clear`, not a `settle` that drops nothing.
 */
describe('settlePaths', () => {
  it('maps no paths, ".", "" and "./" to everything', () => {
    expect(settlePaths(undefined)).toBe('everything');
    expect(settlePaths([])).toBe('everything');
    expect(settlePaths(['.'])).toBe('everything');
    expect(settlePaths([''])).toBe('everything');
    expect(settlePaths(['./'])).toBe('everything');
    expect(settlePaths(['figures', '.'])).toBe('everything');
  });

  it('strips a leading "./" and keeps everything else literal', () => {
    expect(settlePaths(['./figures', 'sections/intro.tex'])).toEqual([
      'figures',
      'sections/intro.tex',
    ]);
    expect(settlePaths(['figures/'])).toEqual(['figures/']);
  });
});

import { describe, it, expect } from 'vitest';
import { UntrackedOverwriteError } from '../../src/services/gitService.js';

/**
 * The message used to prescribe `commit` with `scope: "all"` unconditionally, which sweeps a
 * peer session's in-flight work into the commit along with the one colliding file. When the
 * colliding path(s) are known, the fix is to commit exactly those paths.
 */
describe('UntrackedOverwriteError message', () => {
  it('prescribes scope "paths" with the named colliding file, not "all"', () => {
    const err = new UntrackedOverwriteError(['figs/new.tex']);

    expect(err.message).toContain('scope: "paths"');
    expect(err.message).toContain('"figs/new.tex"');
    // The opening sentence tests elsewhere match against — must stay unchanged.
    expect(err.message).toContain(
      'The rebase a push needs was aborted. Nothing was pushed; the clone is back to its ' +
        'pre-push state.',
    );
  });

  it('prescribes scope "paths" for multiple colliding files, rendered as a literal JSON array', () => {
    const err = new UntrackedOverwriteError(['figs/new.tex', 'notes/scratch.txt']);

    expect(err.message).toContain('scope: "paths"');
    expect(err.message).toContain('["figs/new.tex","notes/scratch.txt"]');
  });

  it('prefers scope "paths" over "all" even when git did not name the colliding path', () => {
    const err = new UntrackedOverwriteError([]);

    expect(err.paths).toEqual([]);
    expect(err.message).toContain('scope: "paths"');
    expect(err.message).toMatch(/check `status`/);
  });
});

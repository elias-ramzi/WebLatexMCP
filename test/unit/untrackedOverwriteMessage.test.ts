import { describe, it, expect } from 'vitest';
import {
  UntrackedOverwriteError,
  untrackedOverwriteFromError,
} from '../../src/services/gitService.js';

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

  it('defaults to push wording when no operation is given, byte-identical to before', () => {
    const err = new UntrackedOverwriteError(['figs/new.tex']);
    expect(err.operation).toBe('push');
    // Pinned exact string from the pre-existing push-worded message — must never change.
    expect(err.message).toContain(
      'The rebase a push needs was aborted. Nothing was pushed; the clone is back to its ' +
        'pre-push state.',
    );
  });

  describe('pull wording', () => {
    it('opens with "nothing changed", names the path, and prescribes commit + scope paths + push', () => {
      const err = new UntrackedOverwriteError(['new.tex'], 'pull');

      expect(err.operation).toBe('pull');
      expect(err.message).toContain('The pull was refused; nothing changed');
      expect(err.message).toContain('new.tex');
      expect(err.message).toContain('commit');
      expect(err.message).toContain('scope: "paths"');
      expect(err.message).toContain('paths: ["new.tex"]');
      expect(err.message).toContain('push');
      // Push wording must not leak into the pull message.
      expect(err.message).not.toContain('Nothing was pushed');
      expect(err.message).not.toContain('rebase a push needs');
    });

    it('mentions discard as an exit that removes the untracked file', () => {
      const err = new UntrackedOverwriteError(['new.tex'], 'pull');
      expect(err.message).toContain('discard');
    });

    it('handles the zero-path fallback without push wording', () => {
      const err = new UntrackedOverwriteError([], 'pull');
      expect(err.message).toContain('The pull was refused; nothing changed');
      expect(err.message).toMatch(/`status`/);
      expect(err.message).not.toContain('Nothing was pushed');
      expect(err.message).not.toContain('rebase a push needs');
    });
  });

  describe('untrackedOverwriteFromError operation plumbing', () => {
    const stderr =
      'error: The following untracked working tree files would be overwritten by merge:\n' +
      '\tnew.tex\n' +
      'Please move or remove them before you merge.\n' +
      'Aborting\n';

    it('returns pull wording when asked for "pull"', () => {
      const err = untrackedOverwriteFromError(new Error(stderr), 'pull');
      expect(err).toBeInstanceOf(UntrackedOverwriteError);
      expect(err?.operation).toBe('pull');
      expect(err?.paths).toEqual(['new.tex']);
      expect(err?.message).toContain('The pull was refused; nothing changed');
    });

    it('returns push wording when no operation argument is given', () => {
      const err = untrackedOverwriteFromError(new Error(stderr));
      expect(err).toBeInstanceOf(UntrackedOverwriteError);
      expect(err?.operation).toBe('push');
      expect(err?.message).toContain('Nothing was pushed');
    });
  });

  describe('path list cap', () => {
    it('caps the prose list and the JSON paths argument at the shared cap for a push message', () => {
      const twentyFive = Array.from({ length: 25 }, (_, i) => `file${i}.tex`);
      const err = new UntrackedOverwriteError(twentyFive);
      expect(err.message).toMatch(/… 5 more/);
      const jsonMatch = err.message.match(/paths: (\[[^\]]*\])/);
      expect(jsonMatch).not.toBeNull();
      const parsed = JSON.parse(jsonMatch![1] ?? '') as string[];
      expect(parsed).toHaveLength(20);
      expect(err.message).toMatch(/the first 20 of 25/);
    });

    it('caps a pull message the same way', () => {
      const twentyFive = Array.from({ length: 25 }, (_, i) => `file${i}.tex`);
      const err = new UntrackedOverwriteError(twentyFive, 'pull');
      expect(err.message).toMatch(/… 5 more/);
      const jsonMatch = err.message.match(/paths: (\[[^\]]*\])/);
      expect(jsonMatch).not.toBeNull();
      const parsed = JSON.parse(jsonMatch![1] ?? '') as string[];
      expect(parsed).toHaveLength(20);
      expect(err.message).toMatch(/the first 20 of 25/);
    });

    it('does not add a cap sentence at exactly 20 paths', () => {
      const twenty = Array.from({ length: 20 }, (_, i) => `file${i}.tex`);
      const err = new UntrackedOverwriteError(twenty, 'pull');
      expect(err.message).not.toMatch(/the first \d+ of/);
      expect(err.message).not.toMatch(/more$/m);
    });
  });
});

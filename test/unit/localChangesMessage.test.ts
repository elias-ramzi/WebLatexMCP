import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  LocalChangesOverwriteError,
  UntrackedOverwriteError,
  localChangesOverwriteFromError,
  pullRefusalFromError,
} from '../../src/services/gitService.js';
import { REFUSAL_PATH_CAP } from '../../src/lib/peerAttribution.js';

/**
 * `project_sync`'s pull runs `merge --ff-only`, which refuses (rather than autostashing) when the
 * fast-forward would overwrite a *tracked* file with uncommitted local modifications. Git's raw
 * stderr for that refusal prescribes `stash`, a command this server doesn't expose. These tests
 * pin: the regex recognising that refusal (both of git's two wordings, and NOT the sibling
 * untracked-file wording it must never cross-fire with), the path parsing out of a realistic
 * multi-path stderr block, and the server-worded message built from it.
 */
describe('LocalChangesOverwriteError / localChangesOverwriteFromError', () => {
  it('matches git\'s real "merge" wording (what `merge --ff-only` produces)', () => {
    const stderr =
      'error: Your local changes to the following files would be overwritten by merge:\n' +
      '\ttables/results.tex\n' +
      'Please commit your changes or stash them before you merge.\n' +
      'Aborting\n';
    const err = localChangesOverwriteFromError(new Error(stderr));
    expect(err).toBeInstanceOf(LocalChangesOverwriteError);
    expect(err?.paths).toEqual(['tables/results.tex']);
  });

  it('matches git\'s "checkout" wording too', () => {
    const stderr =
      'error: Your local changes to the following files would be overwritten by checkout:\n' +
      '\tmain.tex\n' +
      'Please commit your changes or stash them before you switch branches.\n';
    const err = localChangesOverwriteFromError(new Error(stderr));
    expect(err).toBeInstanceOf(LocalChangesOverwriteError);
    expect(err?.paths).toEqual(['main.tex']);
  });

  it('does NOT match the sibling untracked-overwrite wording — the two must never cross-fire', () => {
    const stderr =
      'error: The following untracked working tree files would be overwritten by merge:\n' +
      '\tfigs/new.tex\n' +
      'Please move or remove them before you merge.\n' +
      'Aborting\n';
    expect(localChangesOverwriteFromError(new Error(stderr))).toBeNull();
  });

  it('returns null for an unrelated error', () => {
    expect(localChangesOverwriteFromError(new Error('fatal: not a git repository'))).toBeNull();
  });

  it('parses a realistic multi-path stderr block, tab-indented, toPosix-normalised', () => {
    // Built with the platform's native separator so this exercises `toPosix` on every OS: a
    // no-op on POSIX (already "/"), an actual backslash->slash conversion on Windows.
    const nested = ['sections', 'intro.tex'].join(path.sep);
    const stderr =
      'error: Your local changes to the following files would be overwritten by merge:\n' +
      '\ttables/results.tex\n' +
      `\t${nested}\n` +
      '\tnotes/scratch.md\n' +
      'Please commit your changes or stash them before you merge.\n' +
      'Aborting\n';
    const err = localChangesOverwriteFromError(new Error(stderr));
    expect(err?.paths).toEqual(['tables/results.tex', 'sections/intro.tex', 'notes/scratch.md']);
  });

  // Regression: real git (2.46 against a bare repo) emits a SEPARATE "would be overwritten by
  // merge" block per group of files when the tree has both index-only staged changes and
  // worktree modifications the incoming commit touches — not one block listing everything.
  // Collecting only the paths after the FIRST such block silently drops every path named in the
  // second, so the `paths` argument the message prescribes (`commit scope: "paths"`) names a
  // subset and the next sync refuses again on the rest.
  it('collects paths from EVERY "would be overwritten" block, not just the first', () => {
    const stderr =
      'error: Your local changes to the following files would be overwritten by merge:\n' +
      '\ta.tex\n' +
      'Please commit your changes or stash them before you merge.\n' +
      'error: Your local changes to the following files would be overwritten by merge:\n' +
      '\tb.tex\n' +
      '\tc.tex\n' +
      'Please commit your changes or stash them before you merge.\n' +
      'Aborting\n';
    const err = localChangesOverwriteFromError(new Error(stderr));
    expect(err).toBeInstanceOf(LocalChangesOverwriteError);
    expect(err?.paths).toEqual(['a.tex', 'b.tex', 'c.tex']);
  });

  it('deduplicates a path repeated across two "would be overwritten" blocks', () => {
    const stderr =
      'error: Your local changes to the following files would be overwritten by merge:\n' +
      '\ta.tex\n' +
      'Please commit your changes or stash them before you merge.\n' +
      'error: Your local changes to the following files would be overwritten by merge:\n' +
      '\ta.tex\n' +
      '\tb.tex\n' +
      'Please commit your changes or stash them before you merge.\n' +
      'Aborting\n';
    const err = localChangesOverwriteFromError(new Error(stderr));
    expect(err?.paths).toEqual(['a.tex', 'b.tex']);
  });

  it('names the paths, mentions commit and discard, and does not prescribe stash', () => {
    const err = new LocalChangesOverwriteError(['tables/results.tex']);
    expect(err.message).toContain('tables/results.tex');
    expect(err.message).toContain('commit');
    expect(err.message).toContain('discard');
    // Stash is mentioned only to say it is unavailable, never as something to do.
    expect(err.message).toMatch(/stash.*not available/i);
    expect(err.message).not.toMatch(/\bstash (it|them|your changes|now)\b/i);
    expect(err.message).not.toMatch(/please stash/i);
  });

  it('says nothing changed', () => {
    const err = new LocalChangesOverwriteError(['tables/results.tex']);
    expect(err.message).toMatch(/nothing changed/i);
  });

  it('falls back sensibly when git refused but named no paths', () => {
    const err = new LocalChangesOverwriteError([]);
    expect(err.paths).toEqual([]);
    expect(err.message).toMatch(/`status`/);
    expect(err.message).toContain('commit');
    expect(err.message).toContain('discard');
    expect(err.message).not.toMatch(/please stash/i);
  });

  // Replaces a vacuous predecessor that only asserted `REFUSAL_PATH_CAP === 20` — nothing about
  // gitService. This couples the constant to the actual message/JSON output, so the cap can't
  // silently drift from what the class renders.
  it('caps at the shared REFUSAL_PATH_CAP constant — the message and JSON paths track it, not a private literal', () => {
    const many = Array.from({ length: REFUSAL_PATH_CAP + 1 }, (_, i) => `file${i}.tex`);
    const err = new LocalChangesOverwriteError(many);
    expect(err.message).toMatch(/… 1 more/);
    const jsonMatch = err.message.match(/paths: (\[[^\]]*\])/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![1] ?? '') as string[];
    expect(parsed).toHaveLength(REFUSAL_PATH_CAP);
    expect(err.message).toMatch(
      new RegExp(`the first ${REFUSAL_PATH_CAP} of ${REFUSAL_PATH_CAP + 1}`),
    );
  });

  it('caps the named paths at 20, appending a "more" count for the 21st', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `file${i}.tex`);
    const err20 = new LocalChangesOverwriteError(twenty);
    for (const f of twenty) expect(err20.message).toContain(f);
    expect(err20.message).not.toMatch(/more/i);

    const twentyOne = [...twenty, 'file20.tex'];
    const err21 = new LocalChangesOverwriteError(twentyOne);
    for (const f of twenty) expect(err21.message).toContain(f);
    expect(err21.message).not.toContain('file20.tex');
    expect(err21.message).toMatch(/… 1 more/);
  });

  // Past the cap the prescribed `paths` argument names only the first 20, so following the message
  // exactly clears 20 and the next sync refuses again on the rest. The message has to say that
  // rather than promise "the next sync succeeds" — the same class of defect as prescribing `stash`:
  // advice the caller can follow to the letter and still be stuck.
  it('does not promise a clean sync when it names fewer paths than collided', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `file${i}.tex`);
    const err20 = new LocalChangesOverwriteError(twenty);
    expect(err20.message).not.toMatch(/the first 20 of/);

    const err25 = new LocalChangesOverwriteError([
      ...twenty,
      ...Array.from({ length: 5 }, (_, i) => `extra${i}.tex`),
    ]);
    expect(err25.message).toMatch(/the first 20 of 25/);
    expect(err25.message).toMatch(/refuse it again/);
    expect(err25.message).toMatch(/`status` lists them all/);
  });

  // Regression: this message used to tell the caller `commit` "takes this session's edits by
  // default, or `scope: "all"` for the whole working tree" — which sweeps a live peer's in-flight
  // edits into the caller's commit. commit's actual default (no `scope` at all) is "session" when
  // this session has tracked changes, so "takes this session's edits by default" was also simply
  // wrong. The named colliding paths must drive a scoped `commit`/`discard`, with `scope: "all"` /
  // a bare `discard` demoted to a secondary, explicitly-riskier alternative.
  it('prescribes commit scope "paths" with the named colliding file, not scope "all" as the primary route', () => {
    const err = new LocalChangesOverwriteError(['tables/results.tex']);

    expect(err.message).toContain('scope: "paths"');
    expect(err.message).toContain('paths: ["tables/results.tex"]');

    // "paths" must be the route offered first — "all" (when mentioned at all) trails it, framed
    // as sweeping in a peer's in-flight edits.
    const pathsIdx = err.message.indexOf('scope: "paths"');
    const allIdx = err.message.indexOf('scope: "all"');
    expect(pathsIdx).toBeGreaterThanOrEqual(0);
    expect(allIdx).toBeGreaterThan(pathsIdx);
    expect(err.message).not.toMatch(/takes this session's edits by default/);
  });

  it('scopes the discard advice to the named path too, not a bare (whole-tree) discard', () => {
    const err = new LocalChangesOverwriteError(['tables/results.tex']);

    // `discard` must be offered with `paths` naming the colliding file — a bare `discard` (no
    // `paths`) reverts the WHOLE working tree, including any peer's in-flight edits.
    expect(err.message).toMatch(/`discard`,?\s*`paths: \["tables\/results\.tex"\]`/);
  });

  it('handles multiple colliding paths with a literal JSON array for both commit and discard', () => {
    const err = new LocalChangesOverwriteError(['tables/results.tex', 'sections/intro.tex']);

    const pathsJson = '["tables/results.tex","sections/intro.tex"]';
    expect(err.message).toContain(`scope: "paths"`);
    // Both the commit and discard advice reuse the same JSON array of colliding paths.
    expect(err.message.split(pathsJson).length - 1).toBeGreaterThanOrEqual(2);
  });

  // Boundary: with no paths named (git didn't say which files), there is nothing to put in a
  // `paths: [...]` argument — the fallback must not fabricate one.
  it('the zero-path fallback does not claim to name paths it does not have', () => {
    const err = new LocalChangesOverwriteError([]);

    // `paths: [...]` (the literal placeholder, matching the sibling UntrackedOverwriteError's own
    // zero-path wording) is fine — a fabricated JSON array of file names (`paths: ["…`) is not,
    // since git named none.
    expect(err.message).not.toMatch(/paths: \["/);
    // It still points at the scoped routes in the abstract, once the caller has found the paths.
    expect(err.message).toContain('scope: "paths"');
  });

  // Defect A: the commit route used to say "so the next sync succeeds" — false, since committing
  // moves the clone ahead by one and the next `project_sync` reports `diverged`, not success. The
  // route that actually goes forward after committing is `push` (its rebase surfaces a proper
  // conflict if the same lines collided) — the same shape the pull-worded `UntrackedOverwriteError`
  // sibling already uses correctly.
  it('prescribes push (not a plain sync) after committing, with the same diverged-histories caveat as the untracked-file sibling', () => {
    const err = new LocalChangesOverwriteError(['tables/results.tex']);
    expect(err.message).toContain('then `push`');
    expect(err.message).toContain('would only report the histories as diverged');
  });

  it('attaches "so the next sync succeeds" to the discard route only, never the commit route', () => {
    const err = new LocalChangesOverwriteError(['tables/results.tex']);
    expect(err.message).not.toContain('so the next sync succeeds');
    const discardIdx = err.message.indexOf('`discard`');
    const succeedsIdx = err.message.indexOf('after which the sync succeeds');
    expect(discardIdx).toBeGreaterThanOrEqual(0);
    expect(succeedsIdx).toBeGreaterThan(discardIdx);
  });

  it('keeps the same shape for the zero-path fallback: push after commit, succeeds after discard', () => {
    const err = new LocalChangesOverwriteError([]);
    expect(err.message).toContain('then `push`');
    expect(err.message).toContain('would only report the histories as diverged');
    expect(err.message).not.toContain('so the next sync succeeds');
    const discardIdx = err.message.indexOf('`discard`');
    const succeedsIdx = err.message.indexOf('after which the sync succeeds');
    expect(discardIdx).toBeGreaterThanOrEqual(0);
    expect(succeedsIdx).toBeGreaterThan(discardIdx);
  });

  // Defect B: git's `unpack_trees` accumulates rejects per error type and prints every non-empty
  // block, so one `merge --ff-only` can refuse over BOTH a tracked-modification collision and an
  // untracked-file collision at once. `syncPull`'s old `??` chain reported only the untracked
  // group (checked first) and promised "after which the sync succeeds" — false, since the tracked
  // group would refuse the very next sync. `pullRefusalFromError` factors that decision out of
  // `syncPull`'s catch so it's unit-testable without a live git process.
  describe('pullRefusalFromError — both refusal blocks in one merge', () => {
    const bothBlocksStderr =
      'error: Your local changes to the following files would be overwritten by merge:\n' +
      '\ta.tex\n' +
      'Please commit your changes or stash them before you merge.\n' +
      'error: The following untracked working tree files would be overwritten by merge:\n' +
      '\tnew.tex\n' +
      '\tb.tex\n' +
      'Please move or remove them before you merge.\n' +
      'Aborting\n';

    it('collapses both blocks into one LocalChangesOverwriteError carrying the union, tracked first', () => {
      const result = pullRefusalFromError(new Error(bothBlocksStderr));
      expect(result).toBeInstanceOf(LocalChangesOverwriteError);
      const err = result as LocalChangesOverwriteError;
      expect(err.paths).toEqual(['a.tex', 'new.tex', 'b.tex']);
      expect(err.untrackedPaths).toEqual(['new.tex', 'b.tex']);
      expect(err.message).toContain('a.tex');
      expect(err.message).toContain('new.tex');
      expect(err.message).toContain('b.tex');
      const jsonMatch = err.message.match(/paths: (\[[^\]]*\])/);
      expect(jsonMatch).not.toBeNull();
      expect(JSON.parse(jsonMatch![1] ?? '')).toEqual(['a.tex', 'new.tex', 'b.tex']);
    });

    it('leaves a tracked-only refusal with no untracked paths and no "exist untracked" sentence', () => {
      const stderr =
        'error: Your local changes to the following files would be overwritten by merge:\n' +
        '\ta.tex\n' +
        'Please commit your changes or stash them before you merge.\n' +
        'Aborting\n';
      const result = pullRefusalFromError(new Error(stderr));
      expect(result).toBeInstanceOf(LocalChangesOverwriteError);
      const err = result as LocalChangesOverwriteError;
      expect(err.untrackedPaths).toEqual([]);
      expect(err.message).not.toMatch(/exist.*untracked rather than modified/);
    });

    it('returns a pull-worded UntrackedOverwriteError for an untracked-only refusal', () => {
      const stderr =
        'error: The following untracked working tree files would be overwritten by merge:\n' +
        '\tnew.tex\n' +
        'Please move or remove them before you merge.\n' +
        'Aborting\n';
      const result = pullRefusalFromError(new Error(stderr));
      expect(result).toBeInstanceOf(UntrackedOverwriteError);
      expect((result as UntrackedOverwriteError).operation).toBe('pull');
    });

    it('rethrows an unrelated error untouched', () => {
      const original = new Error('fatal: not a git repository');
      expect(pullRefusalFromError(original)).toBe(original);
    });
  });
});

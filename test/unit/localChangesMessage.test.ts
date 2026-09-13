import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  LocalChangesOverwriteError,
  localChangesOverwriteFromError,
} from '../../src/services/gitService.js';

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
});

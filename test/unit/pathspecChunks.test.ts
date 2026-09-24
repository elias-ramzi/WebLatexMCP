import { describe, it, expect } from 'vitest';
import { chunkPathspecs, MAX_PATHSPEC_ARGV_CHARS } from '../../src/services/gitService.js';

/**
 * `chunkPathspecs` splits a pathspec list into command lines git can actually be spawned with
 * (#94). Two things are under test here and they are different claims: that the SIZING is a
 * bound on argv length rather than on a path count, and that the SPLIT loses nothing — every
 * path exactly once, in order, so a caller unioning the chunks' output gets what one call
 * would have produced.
 *
 * The real constant is asserted by value on purpose: the integration test lowers nothing, but
 * anyone who later makes the budget injectable for a cheaper test must not be able to lower it
 * in production without this failing.
 */

/** What one chunk costs a command line under the helper's own accounting (path + space+quotes). */
function argvCost(chunk: string[]): number {
  return chunk.reduce((n, p) => n + p.length + 3, 0);
}

/** Windows' `CreateProcessW` command-line cap, the limit the constant is derived from. */
const WINDOWS_COMMAND_LINE_LIMIT = 32767;

describe('chunkPathspecs', () => {
  it('pins the production budget and the headroom it claims', () => {
    expect(MAX_PATHSPEC_ARGV_CHARS).toBe(8000);
    // The doc comment's derivation, as an assertion: even if Windows quoting doubled every
    // argument, a full chunk plus a few hundred characters of fixed command line still fits.
    expect(MAX_PATHSPEC_ARGV_CHARS * 2 + 1000).toBeLessThan(WINDOWS_COMMAND_LINE_LIMIT);
  });

  it('returns no chunks at all for no paths (never an empty pathspec list)', () => {
    // An empty chunk handed to `git status -- ` would scope nothing and report the whole tree;
    // callers loop over the chunks, so "no chunks" means "no call", which is what they want.
    expect(chunkPathspecs([])).toEqual([]);
  });

  it('is a single call for a list that fits — the small case is unchanged', () => {
    const paths = ['main.tex', 'sections/intro.tex', 'refs.bib'];
    expect(chunkPathspecs(paths)).toEqual([paths]);
  });

  it('keeps every chunk inside the budget and every path exactly once, in order', () => {
    const paths = Array.from({ length: 900 }, (_, i) => `sections/${'d'.repeat(60)}/f-${i}.tex`);
    const chunks = chunkPathspecs(paths);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks)
      expect(argvCost(chunk)).toBeLessThanOrEqual(MAX_PATHSPEC_ARGV_CHARS);
    // The partition property the union-of-results reasoning rests on.
    expect(chunks.flat()).toEqual(paths);
  });

  it('chunks by accumulated length, not by a fixed count', () => {
    // Same number of paths in each half, wildly different lengths: a count-based chunker would
    // produce equal-sized chunks, which is precisely not a bound on the command line.
    const short = Array.from({ length: 200 }, (_, i) => `s${i}.tex`);
    const long = Array.from({ length: 200 }, (_, i) => `${'l'.repeat(300)}-${i}.tex`);
    const chunks = chunkPathspecs([...short, ...long]);

    const sizes = chunks.map((c) => c.length);
    expect(Math.max(...sizes)).toBeGreaterThan(Math.min(...sizes) * 4);
    for (const chunk of chunks)
      expect(argvCost(chunk)).toBeLessThanOrEqual(MAX_PATHSPEC_ARGV_CHARS);
    expect(chunks.flat()).toHaveLength(400);
  });

  it('gives a path longer than the whole budget its own chunk rather than dropping it', () => {
    const monster = `${'x'.repeat(MAX_PATHSPEC_ARGV_CHARS + 500)}.tex`;
    const chunks = chunkPathspecs(['a.tex', monster, 'b.tex']);

    // Dropping it would silently narrow the pathspec — a path absent from a `status` scope
    // reads as "not dirty", which is the guard failing open.
    expect(chunks.flat()).toEqual(['a.tex', monster, 'b.tex']);
    expect(chunks).toContainEqual([monster]);
  });

  it('splits a realistically large reverted commit under the real budget', () => {
    // 300 paths of ~130 characters — the shape the integration test builds, and the shape that
    // exceeds Windows' command line as one list.
    const paths = Array.from(
      { length: 300 },
      (_, i) => `sections/${'d'.repeat(40)}/${'s'.repeat(35)}/figure-${i}-${'x'.repeat(30)}.tex`,
    );
    expect(argvCost(paths)).toBeGreaterThan(WINDOWS_COMMAND_LINE_LIMIT);

    const chunks = chunkPathspecs(paths);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const chunk of chunks)
      expect(argvCost(chunk)).toBeLessThanOrEqual(MAX_PATHSPEC_ARGV_CHARS);
  });

  it('honours an explicit budget (the parameter tests use to avoid 32 KB fixtures)', () => {
    const paths = ['aaa.tex', 'bbb.tex', 'ccc.tex', 'ddd.tex'];
    // cost per path = 7 + 3 = 10, so a budget of 20 takes two per chunk.
    expect(chunkPathspecs(paths, 20)).toEqual([
      ['aaa.tex', 'bbb.tex'],
      ['ccc.tex', 'ddd.tex'],
    ]);
  });
});

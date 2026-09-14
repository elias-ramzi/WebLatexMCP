import { describe, it, expect } from 'vitest';
import { foldCase, canonicalNames } from '../../src/lib/caseFold.js';

// U+212A KELVIN SIGN — lowercases to ASCII "k" under a full-Unicode `toLowerCase()`, which would
// over-match a pair git itself treats as different names on a case-insensitive repository.
// `foldCase`'s ASCII-only `[A-Z]` range must never fold it.
const KELVIN_SIGN = 'K';

describe('foldCase', () => {
  it('lowercases ASCII A-Z only', () => {
    expect(foldCase('Notes.TXT')).toBe('notes.txt');
  });

  it('leaves already-lowercase text unchanged', () => {
    expect(foldCase('notes.txt')).toBe('notes.txt');
  });

  it('never folds U+212A KELVIN SIGN onto ASCII "k"', () => {
    expect(foldCase(`a${KELVIN_SIGN}.tex`)).not.toBe(foldCase('ak.tex'));
  });
});

describe('canonicalNames', () => {
  describe('resolve — full-name matching', () => {
    it('returns the exact name unchanged when the listing holds it verbatim', () => {
      const c = canonicalNames(['Notes.txt']);
      expect(c.resolve('Notes.txt')).toBe('Notes.txt');
    });

    it('folds a differently-cased full name onto the listing spelling', () => {
      const c = canonicalNames(['Notes.txt']);
      expect(c.resolve('notes.txt')).toBe('Notes.txt');
    });

    it('exact full name wins over a folded one when the listing holds both spellings', () => {
      const c = canonicalNames(['notes.txt', 'Notes.txt']);
      expect(c.resolve('Notes.txt')).toBe('Notes.txt');
      expect(c.resolve('notes.txt')).toBe('notes.txt');
    });

    it('an untracked name resolves unchanged', () => {
      const c = canonicalNames(['other.tex']);
      expect(c.resolve('nothing.tex')).toBe('nothing.tex');
    });

    it('never folds U+212A KELVIN SIGN onto its ASCII "k" look-alike', () => {
      const c = canonicalNames([`a${KELVIN_SIGN}.tex`]);
      expect(c.resolve('ak.tex')).toBe('ak.tex');
    });
  });

  describe('resolve — directory-prefix matching (a new file under a case-differing tracked dir)', () => {
    it('resolves a new file under a folded top-level directory prefix', () => {
      const c = canonicalNames(['Sub/a.tex']);
      expect(c.resolve('sub/new.tex')).toBe('Sub/new.tex');
    });

    it('the deepest tracked prefix wins over a shallower one', () => {
      const c = canonicalNames(['Sub/Deep/a.tex']);
      expect(c.resolve('sub/deep/new.tex')).toBe('Sub/Deep/new.tex');
    });

    it('a shallower prefix is used when there is no deeper tracked one', () => {
      const c = canonicalNames(['Sub/a.tex']);
      expect(c.resolve('sub/deep/new.tex')).toBe('Sub/deep/new.tex');
    });

    it('no tracked prefix at all leaves the path unchanged', () => {
      const c = canonicalNames(['other/a.tex']);
      expect(c.resolve('sub/new.tex')).toBe('sub/new.tex');
    });

    it('a file listed with no slash does not act as a directory prefix for a same-named dir', () => {
      // "Sub" here is a plain tracked FILE at the repo root, not a directory — it must not make
      // "sub/x" resolve as though "Sub" were a directory prefix.
      const c = canonicalNames(['Sub']);
      expect(c.resolve('sub/x.tex')).toBe('sub/x.tex');
    });

    it('"Sub" still acts as a directory prefix when it IS a prefix of some other listed name', () => {
      const c = canonicalNames(['Sub', 'Sub/a.tex']);
      expect(c.resolve('sub/new.tex')).toBe('Sub/new.tex');
    });

    it('an exact-cased prefix wins over a folded alias of a different listed directory', () => {
      // Both "Sub" and "sub" are tracked directories (a case-sensitive contributor added both) —
      // naming "sub/new.tex" exactly must land under "sub", never fold onto "Sub".
      const c = canonicalNames(['Sub/a.tex', 'sub/b.tex']);
      expect(c.resolve('sub/new.tex')).toBe('sub/new.tex');
      expect(c.resolve('Sub/new.tex')).toBe('Sub/new.tex');
    });

    it('never folds a U+212A KELVIN SIGN directory name onto its ASCII "k" look-alike', () => {
      const c = canonicalNames([`a${KELVIN_SIGN}/x.tex`]);
      expect(c.resolve('ak/new.tex')).toBe('ak/new.tex');
    });
  });

  // Issue #66 finding 2: a request that IS a tracked directory in another case, with no tail of
  // its own (`resolve('sub')` while the tree tracks `Sub/a.tex`), fell through the directory-prefix
  // loop unchanged — that loop only peels a *shorter* prefix off and reattaches a tail, so a
  // whole-path directory match never got a chance to fire. Checked before the prefix loop, exact
  // first.
  describe('resolve — whole-directory matching (a request naming a tracked directory itself)', () => {
    it('folds a differently-cased directory request onto the tracked directory spelling', () => {
      const c = canonicalNames(['Sub/a.tex']);
      expect(c.resolve('sub')).toBe('Sub');
    });

    it('folds a differently-cased two-segment directory request onto the deepest tracked spelling, not a half-folded mix', () => {
      // Pre-fix this half-folded through the prefix loop's single-segment step to "Sub/deep" —
      // the first segment folded ("sub" -> "Sub"), the second left as the caller spelled it.
      const c = canonicalNames(['Sub/Deep/x.tex']);
      expect(c.resolve('sub/deep')).toBe('Sub/Deep');
    });

    it('an exact-cased directory request wins over a folded alias of a different tracked directory', () => {
      const c = canonicalNames(['Sub/a.tex', 'sub/b.tex']);
      expect(c.resolve('Sub')).toBe('Sub');
      expect(c.resolve('sub')).toBe('sub');
    });

    it('a directory request with no tracked match at all resolves unchanged', () => {
      const c = canonicalNames(['other/a.tex']);
      expect(c.resolve('nope')).toBe('nope');
    });
  });

  describe('has', () => {
    it('is true for an exact or folded full name', () => {
      const c = canonicalNames(['Notes.txt']);
      expect(c.has('Notes.txt')).toBe(true);
      expect(c.has('notes.txt')).toBe(true);
    });

    it('is false for a name only reachable through directory-prefix resolution', () => {
      // A prefix match resolves a *new* path, but that path itself is not "tracked".
      const c = canonicalNames(['Sub/a.tex']);
      expect(c.has('sub/new.tex')).toBe(false);
    });

    it('is false for a completely untracked name', () => {
      const c = canonicalNames(['other.tex']);
      expect(c.has('nothing.tex')).toBe(false);
    });
  });
});

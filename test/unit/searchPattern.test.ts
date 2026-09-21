import { describe, it, expect } from 'vitest';
import {
  buildSearchMatcher,
  escapeLiteral,
  MAX_PATTERN_CHARS,
  UnsafePatternError,
} from '../../src/lib/searchPattern.js';

/**
 * The denial-of-service guard on `search_files`' pattern.
 *
 * Each refusal below is pinned against a pattern that really does explode, and each acceptance
 * against one that really is cheap — both verified by measurement against a 2000-character line
 * of `a`s on this codebase's Node (the figures are in `searchPattern.ts`'s header). The point of
 * the accepted half is that the guard has to stay usable: a rule that refuses `\w+\s+\w+` (4ms)
 * along with `a+a+b` (2.8s) would be abandoned the first time someone needed to search for two
 * words in a row.
 *
 * Nothing here runs a pathological pattern — that is the whole idea. The test that proves the
 * refusal actually PROTECTS anything is in `searchFiles.test.ts`, where a search over a file
 * built to trigger the blowup returns a refusal in milliseconds; remove the
 * `assertLinearishRegex` call and that test hangs until vitest kills it.
 */
describe('buildSearchMatcher: literal patterns', () => {
  it('escapes every metacharacter, so a LaTeX pattern matches itself', () => {
    const re = buildSearchMatcher('\\Cref{tab:sota}');
    expect(re.test('see \\Cref{tab:sota} above')).toBe(true);
    // The unescaped pattern would have been a broken regex; as a literal it is exact.
    expect(re.test('see \\Cref{tab:other} above')).toBe(false);
  });

  it('never treats a literal pattern as a regex, however regex-shaped it is', () => {
    const re = buildSearchMatcher('a.c');
    expect(re.test('abc')).toBe(false);
    expect(re.test('a.c')).toBe(true);
  });

  it('accepts a literal pattern that would be refused as a regex', () => {
    // An escaped literal carries no quantifiers at all, so no rule can fire on it.
    expect(() => buildSearchMatcher('(a+)+$')).not.toThrow();
    expect(buildSearchMatcher('(a+)+$').test('x(a+)+$y')).toBe(true);
  });

  it('escapeLiteral leaves a plain word alone', () => {
    expect(escapeLiteral('mAP')).toBe('mAP');
    expect(escapeLiteral('a+b')).toBe('a\\+b');
  });

  it('refuses an empty pattern rather than matching every line', () => {
    expect(() => buildSearchMatcher('')).toThrow(UnsafePatternError);
  });

  it('refuses a pattern past the length cap', () => {
    expect(() => buildSearchMatcher('a'.repeat(MAX_PATTERN_CHARS + 1))).toThrow(
      /over the 500-character limit/,
    );
    expect(() => buildSearchMatcher('a'.repeat(MAX_PATTERN_CHARS))).not.toThrow();
  });
});

describe('buildSearchMatcher: regex flags and syntax', () => {
  it('always sets the g flag, and sets i only when asked', () => {
    expect(buildSearchMatcher('x').flags).toBe('g');
    expect(buildSearchMatcher('x', { caseInsensitive: true }).flags).toBe('gi');
    expect(buildSearchMatcher('mAP', { caseInsensitive: true }).test('map')).toBe(true);
  });

  it('turns a syntax error into a refusal that names the way out', () => {
    expect(() => buildSearchMatcher('\\Cref{tab:a}', { regex: true })).not.toThrow();
    try {
      buildSearchMatcher('(unclosed', { regex: true });
      expect.unreachable('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafePatternError);
      expect((err as Error).message).toContain('regex: false');
    }
  });
});

/** Each of these measured in seconds to tens of minutes against ONE 2000-character line. */
describe('buildSearchMatcher: patterns that are refused, with what they cost', () => {
  const refused: Array<[string, string]> = [
    ['(a+)+$', 'exponential: a group repeated without bound'],
    ['(a|a)*b', 'exponential: an ambiguous alternation repeated without bound'],
    ['(?:a|ab)+c', 'exponential: overlapping alternatives repeated without bound'],
    ['(?=(a+)+)x', 'exponential, hidden inside a lookahead'],
    ['a+a+b', '2.8s: two overlapping repeats that vary together'],
    ['a*a*b', '2.4s: the same, with empty allowed'],
    ['a*b?a*c', '3.0s: separated only by an optional atom the scan sees past'],
    ['.*a.*b', '7.8s: two ambiguous repeats'],
    ['.*a.*a.*b', '37 MINUTES on one line: three'],
    [
      '[^x]*a[^x]*a[^x]*b',
      '12 minutes, and not a `.` in it — the rule is about which characters a repeat shares ' +
        'with what follows it, not about which metacharacter was used',
    ],
    ['.*foo.*bar', 'the same shape with longer literals'],
    ['(?:.*a){3}', 'a repeat count multiplies the ambiguity it contains'],
  ];
  for (const [pattern, why] of refused) {
    it(`refuses ${pattern} (${why})`, () => {
      expect(() => buildSearchMatcher(pattern, { regex: true })).toThrow(UnsafePatternError);
    });
  }

  it('refuses counted repeats that multiply out past the cap', () => {
    expect(() => buildSearchMatcher('(?:a{100}){101}', { regex: true })).toThrow(
      /counted repeats multiply out/,
    );
    // Exactly at the cap is allowed: the refusal is a ceiling, not a nudge.
    expect(() => buildSearchMatcher('(?:a{100}){100}', { regex: true })).not.toThrow();
  });

  it('refuses a group construct it has not been taught, rather than guessing', () => {
    // Modifier groups are the live example; the point is the fail-closed direction for
    // anything the scanner cannot account for.
    expect(() => buildSearchMatcher('(?i:foo)', { regex: true })).toThrow(/cannot verify/);
  });

  it('names the construct and the escape route in the refusal', () => {
    try {
      buildSearchMatcher('(a+)+$', { regex: true });
      expect.unreachable('should have refused');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('repeats a group without bound');
      expect(msg).toContain('regex: false');
    }
  });
});

/** Each of these measured in MILLISECONDS against the same 2000-character line. */
describe('buildSearchMatcher: patterns that must keep working', () => {
  const accepted = [
    '\\\\Cref\\{[^}]*\\}', // the pattern the tool exists for
    '[^}]*\\}[^}]*\\}z', // two repeats, each fenced off by what follows it
    '\\w+\\s+\\w+', // 4ms — chaining is not the hazard
    '\\s*\\S*b',
    '^\\s*\\\\item',
    '\\bmAP\\b',
    '.*', // a trailing repeat never backtracks
    'foo.*',
    '.+foo', // one ambiguous repeat: 7ms, and allowed
    '(fig|tab):', // an unquantified group is fine
    '(?<name>foo)bar',
    'x(?!y)',
    '\\\\newcommand\\{\\\\[a-z]+\\}\\[[0-9]*\\]',
    'a{2,}b',
    '\\p{L}+x',
  ];
  for (const pattern of accepted) {
    it(`accepts ${pattern}`, () => {
      expect(() => buildSearchMatcher(pattern, { regex: true })).not.toThrow();
    });
  }

  it('judges overlap by characters, not by shape — non-ASCII included', () => {
    // One ambiguous repeat is allowed...
    expect(() => buildSearchMatcher('[\\u1000-\\u2000]*\\u1500', { regex: true })).not.toThrow();
    // ...two are not, and the alphabet the overlap test uses has to carry characters this
    // pattern names but no ASCII sample would contain. Without the pattern's own characters
    // (and its range endpoints) in that alphabet, these two would be declared disjoint and
    // waved through — an under-refusal, the one direction the test must not allow.
    expect(() =>
      buildSearchMatcher('[\\u1000-\\u2000]*\\u1500x[\\u1000-\\u2000]*\\u1500', { regex: true }),
    ).toThrow(UnsafePatternError);
  });

  it('is case-aware in the overlap test', () => {
    // `[a-z]*A` is unambiguous while case matters, and ambiguous once it does not — so a
    // second such repeat is accepted in the first case and refused in the second.
    expect(() => buildSearchMatcher('[a-z]*Ax[a-z]*A', { regex: true })).not.toThrow();
    expect(() =>
      buildSearchMatcher('[a-z]*Ax[a-z]*A', { regex: true, caseInsensitive: true }),
    ).toThrow(UnsafePatternError);
  });
});

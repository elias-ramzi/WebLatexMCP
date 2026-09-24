import { describe, it, expect } from 'vitest';
import {
  ANALYZED_LINE_CHARS,
  assertLinearishRegex,
  buildSearchMatcher,
  escapeLiteral,
  MAX_AMBIGUITY_PRODUCT,
  MAX_CHAIN_WORK,
  MAX_PATTERN_CHARS,
  UnsafePatternError,
} from '../../src/lib/searchPattern.js';
import { MAX_LINE_SCAN_CHARS } from '../../src/lib/searchMatch.js';

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
 * Nothing here runs a pathological pattern — that is the whole idea. The one test that runs
 * patterns at all ("runs every accepted pattern fast…") times only those the analyzer ACCEPTS,
 * so it is fast exactly while the analyzer is right, and slow (never hung: its corpus holds only
 * polynomially slow shapes) the moment it misjudges one. The test that proves the refusal
 * actually PROTECTS anything is in `searchFiles.test.ts`, where a search over a file built to
 * trigger the blowup returns a refusal in milliseconds; remove the `assertLinearishRegex` call
 * and that test hangs until vitest kills it.
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

/**
 * Each of these measured against ONE line: seconds to tens of minutes on 2000 characters for
 * the polynomial ones, seconds on a few dozen for the exponential ones. Two kinds are here for
 * what they stand for rather than for what they cost on one line: `.{0,100}.{0,100}b` (47-116ms,
 * but ten thousand splits per position — the options cap that also keeps the exponential shapes
 * out) and the cubic `\label{`/`\cite{` rows (0.2-0.6s — up to twice what the costliest
 * accepted shapes take at 2000 characters, and degree three in the line length at every
 * starting position).
 */
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
    ['(?:.*a){3}', 'a counted repeat of a body with a variable repeat inside'],
    // A COUNTED repeat of an ambiguous body is as exponential as an unbounded one, up to its
    // count: `(?:a|aa){0,40}b` took 29s on forty `a`s — Fibonacci-many ways to split them.
    ['(?:a|aa){0,100}b', 'exponential: a counted repeat of overlapping alternatives'],
    ['(?:\\w|\\w\\w){0,100}\\}', 'exponential: the same over a class'],
    ['(?:.|..){0,100}\\}', 'exponential: the same over `.`'],
    ['(\\d|\\d\\d){1,99}!', 'exponential: a capturing group, a nonzero minimum'],
    ['(?=(?:a|aa){0,60}b)', 'exponential, hidden inside a lookahead'],
    // A group summary has to say what its match can END in: the repeat inside trades input
    // with the one after the group exactly as `a*a*b` does.
    ['(?:a*)a*b', '2.5s: an overlapping pair split by a group boundary'],
    // A large count is an unbounded repeat for every purpose but syntax.
    ['a*a{0,2000}b', '10s: an unbounded repeat overlapping a large counted one'],
    ['\\w*\\w{0,2000}x', '8.5s: the same over a class'],
    ['.{0,100}.{0,100}b', '47-116ms: two overlapping counted repeats, 10^4 splits per position'],
    [
      '.*a{0,16}a{0,16}a{0,16}b',
      '57s: small counted repeats multiply the one ambiguous unbounded repeat allowed',
    ],
    // A repeat that runs once per choice of an EARLIER overlapping repeat multiplies it, even
    // though nothing after it overlaps: the chain is `.*` -> `a` -> `\w+`, all matching `a`.
    ['.*a\\w+\\s', '4.3s: a repeat further down an overlapping chain'],
    [
      '.*\\\\cite\\{[^}]*\\}',
      '0.25-0.6s on a line of `\\cite{`s: cubic — `[^}]*` runs on from every `\\cite{` `.*` can stop ' +
        'at, since no letter of `\\cite{` stops it',
    ],
    ['.*\\\\label\\{[^}]*\\}', '~0.3s: the same over `\\label{`, one every seven characters'],
    // Anchoring buys ONE starting position, not a cubic chain: still 2000 x 2000 splits at it.
    ['^.*a.*a.*b', '1.3s on one line, tried at one position only'],
    // Unrolling a repeat does not make it safe: every overlapping alternation and every
    // optional atom is a choice point, and a sequence of them multiplies.
    ['(?:a|a)'.repeat(24) + 'b', '5s on THIRTY characters: unrolled ambiguous alternations'],
    ['a?'.repeat(30) + 'a'.repeat(30), 'exponential: the textbook a?^n a^n'],
    // A long FIXED run after an open repeat is re-matched once per place the repeat can stop:
    // no choice point of its own, and still thousands of steps per option.
    ['[\\s\\S]*a{999}b', '8.2s: a fixed-width run re-matched at each stop of the repeat'],
    ['.*a{1500}b', '3.6s: the same after `.`'],
    ['a*(?:aa){700}b', '4.9s: the run is a counted rigid group'],
    ['\\w*\\w{999}!', '5.0s: the same over a class'],
    ['a*a{999}b', '3.5s: the same with the repeat and the run on one letter'],
    ['.*(?:a{999})?b', 'an optional run is still tried in full at every stop'],
    ['[\\s\\S]*(a{30})' + '\\1'.repeat(100) + 'b', 'backreferences re-match their capture'],
    // Without the `u` flag (never set here) these are NOT braced escapes: `\u{999}` is `u`
    // repeated 999 times and `\c{999}` is a backslash then `c{999}`. Read as one atom, the count
    // was invisible.
    ['[\\s\\S]*\\u{999}b', '3.9s: a count hidden in what reads as a `\\u{...}` escape'],
    ['[\\s\\S]*\\p{0,1999}p', 'a whole repeat hidden in what reads as `\\p{...}`'],
    ['[\\s\\S]*\\c{999}x', 'a count hidden behind a `\\c` that is no control escape'],
    // `\s` covers Unicode spaces, so it overlaps a non-ASCII class — an alphabet of ASCII and a
    // couple of letters called them disjoint and waved an n^4 pattern through.
    ['\\s*[^\\x00-\\x7f]\\s*[^\\x00-\\x7f]\\s*x', '16.8s on 480 characters: Unicode spaces'],
    // V8 matches a lookbehind body RIGHT TO LEFT, so its last item is tried first: a trailing
    // `.*` there is a LEADING repeat that multiplies everything before it, not a suffix that
    // cannot fail. Read left to right, each of these looked like one repeat and a free tail.
    ['(?<=b.*a.*)', '2s: `.*a.*b` in the order V8 runs it, at every starting position'],
    ['(?<=b.*a.*.*)', 'over a minute: three repeats, run right to left'],
    ['(?<=a{999}.*.*)', 'over a minute: a 999-character run after two repeats'],
    ['(?<=a{999}.*)', '~3s: a 999-character run re-matched at each place `.*` stops'],
    ['c(?<=b.*[ac].*)', '1s: the same behind a literal'],
    ['(?<=%.*TODO.*)', '425ms: a comment search written as a lookbehind'],
    // Without the `u` flag `\01` is ONE character (U+0001), so `\01*` repeats it: read as
    // `\0` then `1*`, each repeat looked fenced off by a NUL.
    ['\\01*\\01*\\01*b', 'over a minute: three overlapping repeats spelled as octal escapes'],
    // `[\c1]` is U+0011 inside a class: never sampled, it looked disjoint from `[\x00-\x1f]`.
    ['[\\c1]+[\\x00-\\x1f]+[\\c1]+[\\x00-\\x1f]+b', 'over 10s: a control escape inside a class'],
    // A fence (`\w` cannot be a `{`) keeps the runs of `\{?` from different stops of `a+`
    // apart — but `\{?` stops somewhere at EVERY one of them, if only after nothing, so what
    // follows it is still re-entered once per stop of `a+`. Crediting the fence as though it
    // cut that to one accepted a 3.8s pattern.
    ['a+\\w\\{?[\\s\\S]{0,999}x', '3.8s: a fence credited to a repeat of at most one letter'],
    ['a+\\w\\{?[\\s\\S]{0,150}x', '~1s: the same with a shorter run'],
    // A piece that can match nothing, and none of what the repeats before it gave back, settles
    // nothing — but the engine still ENTERS it at every split of those repeats. Charged once,
    // twenty-three of them after `x{0,75}x*` were accepted and took 8-10s.
    ['x{0,75}x*a*b*c*d*\\}', '1.8s: four empty-matching repeats entered at every split'],
    ['[A-Za-z]{0,40}[a-z]*\\d*\\s*-?\\\\ref', '0.5s: the same, spelled as a search'],
    // A greedy repeat inside a QUANTIFIED group that captures (or can match nothing) saves and
    // restores the group's registers at every character it gives back.
    ['x{0,78}(\\wx*)?\\}', '0.73s: a greedy repeat inside an optional capture group'],
    // An optional piece whose first letter what follows can ALSO match is still a choice of two
    // at every place: only a disjoint pair (`(\[…\])?\{`) is decided by the next character.
    ['.{0,62}(?:ab)?.{0,62}c', '7938 splits per position: an optional that overlaps what follows'],
    // Converging paths: `x*` is entered once per stop of `x{0,30}`, every one of those runs ends
    // at the same place, and `a+a{11}` — which overlaps neither repeat, and so closes both — then
    // runs in full once per such run. Counted as entered once, these were accepted.
    ['x{0,30}x*a+a{11}b', '1.1-2.7s: `a+a{11}` runs in full once per stop of `x{0,30}`'],
    ['x?x?x?x?x*a+a{15}b', '0.8-1.2s: the same through four optional letters, 2^4 runs'],
    ['\\s{0,40}\\s*\\w+\\w{9}!', '1.2-3.0s: the same, spelled with classes'],
    ['[^{]{0,40}[^{]*\\{a+a{9}b', '1.2-1.8s: converging onto written-out text'],
    ['x{0,30}x*\\{y{0,30}y*\\{a+a{4}b', '4.4-6.4s: two converging stages, 31 x 31 runs'],
    ['x{0,20}x*\\{y{0,20}y*\\{a+a{8}b', '3.9-4.3s: the same with smaller counts and a longer run'],
    // The same stages inside groups: the floor a group's body sets reaches past its `)`.
    ['(x{0,30}x*\\{)(y{0,30}y*\\{)a+a{4}b', '2.7-3.0s: two converging stages, each in a group'],
    ['(?:x{0,30}x*\\{)(?:y{0,30}y*\\{)a+a{4}b', '2.7s: the same through non-capturing groups'],
    ['(x{0,40}x*\\{)a+a{9}b', '1.4-1.5s: one stage in a group'],
    ['(?:x{0,40}x*\\{)?a+a{9}b', '1.1-1.3s: one stage in an optional group'],
    // A bounded repeat OUTSIDE a group re-entering it, and the repeat that makes up the difference
    // inside it, closed there: the runs converge inside the group.
    ['x{0,40}(?:x*\\{)a+a{9}b', '1.1-1.3s: the stage split across a group boundary'],
    ['x{0,40}(x*\\{)a+a{9}b', '1.1-1.2s: the same through a capturing group'],
    ['x{0,40}(?:(?:x*)\\{)a+a{9}b', '1.1s: the repeat handed out of a nested group'],
    ['(?:x{0,40}(?:x*\\{))a+a{9}b', '1.1s: the whole stage inside a group, split by another'],
  ];
  for (const [pattern, why] of refused) {
    it(`refuses ${pattern} (${why})`, () => {
      expect(() => buildSearchMatcher(pattern, { regex: true })).toThrow(UnsafePatternError);
    });
  }

  it('does not let a group boundary hide converging paths', () => {
    // Every way of putting brackets around the stages of a converging shape is the same pattern
    // to the engine, and has to be refused like the flat spelling is.
    const stages: Array<[string, string, string, string]> = [
      ['x{0,40}', 'x*', '\\{', 'a+a{9}b'],
      ['\\s{0,40}', '\\s*', '\\w+', '\\w{9}!'],
      ['[^{]{0,40}', '[^{]*', '\\{', 'a+a{9}b'],
    ];
    const spellings = ([b, u, c, t]: [string, string, string, string]): string[] => [
      b + u + c + t,
      `(${b}${u}${c})${t}`,
      `(?:${b}${u}${c})${t}`,
      `(?:${b}${u}${c})?${t}`,
      `${b}(?:${u}${c})${t}`,
      `${b}(${u}${c})${t}`,
      `${b}(?:(?:${u})${c})${t}`,
      `(?:${b}(?:${u}${c}))${t}`,
      `(?:(?:${b}${u})${c})${t}`,
    ];
    const accepted = stages.flatMap(spellings).filter((p) => {
      try {
        buildSearchMatcher(p, { regex: true });
        return true;
      } catch {
        return false;
      }
    });
    expect(accepted).toEqual([]);
  });

  it('judges overlap through every case fold, not only the characters the pattern names', () => {
    // Under `i`, `[\u0250-\u0260]` also matches U+0181 (the fold of U+0253 inside it), which
    // `[\u0170-\u0188]` matches outright: the two overlap although neither names the other's
    // characters. Over 10 seconds on a line of U+0253.
    const lo = '[\\u0250-\\u0260]+';
    const hi = '[\\u0170-\\u0188]+';
    const pattern = lo + hi + lo + hi + 'x';
    expect(() => buildSearchMatcher(pattern, { regex: true })).not.toThrow();
    expect(() => buildSearchMatcher(pattern, { regex: true, caseInsensitive: true })).toThrow(
      UnsafePatternError,
    );
    // The same through literal characters rather than escapes.
    const c = String.fromCharCode;
    const litLo = `[${c(0x250)}-${c(0x260)}]+`;
    const litHi = `[${c(0x170)}-${c(0x188)}]+`;
    expect(() =>
      buildSearchMatcher(litLo + litHi + litLo + litHi + 'x', {
        regex: true,
        caseInsensitive: true,
      }),
    ).toThrow(UnsafePatternError);
  });

  it('reads a digit escape the way the engine does: backreference, octal or digit', () => {
    // Refused as `a*a*b` is — one repeat re-run at every stop of another — not as a repeated
    // backreference.
    const rerun = /matched again at each of the 2000 places/;
    // `\1` with a group is a backreference, which a repeat may not repeat...
    expect(() => buildSearchMatcher('(a)\\1*b', { regex: true })).toThrow(/more than one way/);
    // ...and with no group it is U+0001, ONE character, which a repeat may: `\1*` is `\x01*`,
    // and it overlaps a second `\x01*` exactly as `a*a*b` does.
    expect(() => buildSearchMatcher('\\1*b', { regex: true })).not.toThrow();
    expect(() => buildSearchMatcher('\\1*\\x01*b', { regex: true })).toThrow(rerun);
    // `\47` is U+0027 (`'`) — two digits, as the engine reads them — so `\47*` repeats the quote.
    expect(() => buildSearchMatcher('\\47*b', { regex: true })).not.toThrow();
    expect(() => buildSearchMatcher("\\47*'*b", { regex: true })).toThrow(rerun);
    // `\8` is the digit 8.
    expect(() => buildSearchMatcher('\\8*b', { regex: true })).not.toThrow();
    expect(() => buildSearchMatcher('\\8*8*b', { regex: true })).toThrow(rerun);
  });

  it('refuses a chain whose choice points multiply past the ambiguity budget, and names them', () => {
    // 63 x 63 fits under 2 x 2000; 64 x 64 does not. The refusal is a ceiling, not a nudge.
    expect(MAX_AMBIGUITY_PRODUCT).toBe(4000);
    expect(() => buildSearchMatcher('.{0,62}.{0,62}b', { regex: true })).not.toThrow();
    try {
      buildSearchMatcher('.{0,63}.{0,63}b', { regex: true });
      expect.unreachable('should have refused');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('4096 ways');
      expect(msg).toContain('`.{0,63}`');
      expect(msg).toContain('regex: false');
    }
  });

  it('assumes the line length the search actually caps a scan at', () => {
    // The range the model gives an unbounded repeat IS the line cap: raise the cap without the
    // model and every accepted pattern's worst case grows with the square of the difference.
    expect(ANALYZED_LINE_CHARS).toBe(MAX_LINE_SCAN_CHARS);
  });

  it('refuses a counted repeat of an ambiguous body, and says a count is no cure', () => {
    try {
      buildSearchMatcher('(?:a|aa){0,40}b', { regex: true });
      expect.unreachable('should have refused');
    } catch (err) {
      expect((err as Error).message).toContain('A bounded count does not make that safe');
    }
    // A rigid body — one fixed-width way to match — may still be counted.
    expect(() => buildSearchMatcher('(?:ab){0,40}c', { regex: true })).not.toThrow();
  });

  it('refuses counted repeats that multiply out past the cap', () => {
    expect(() => buildSearchMatcher('(?:a{100}){101}', { regex: true })).toThrow(
      /counted repeats multiply out/,
    );
    // Exactly at the cap is allowed: the refusal is a ceiling, not a nudge.
    expect(() => buildSearchMatcher('(?:a{100}){100}', { regex: true })).not.toThrow();
  });

  it('refuses a group construct it has not been taught, rather than guessing', () => {
    // The SCANNER is asserted directly, not through `buildSearchMatcher`, because the example
    // is exactly as new as the runtime. Modifier groups reached V8 after Node 22, which CI
    // runs, so there `new RegExp('(?i:foo)')` throws before the scan is ever reached and the
    // refusal arrives from the syntax branch instead — which pinned nothing about the
    // fail-closed direction and made this a test that passed only on a new enough Node.
    // `assertLinearishRegex` does no compiling, so this bites on every engine.
    expect(() => assertLinearishRegex('(?i:foo)')).toThrow(/cannot verify/);
    expect(() => assertLinearishRegex('(?i:foo)')).toThrow(UnsafePatternError);
  });

  it('refuses an unparseable pattern whichever branch catches it first', () => {
    // The end-to-end guarantee behind the test above, stated so it holds on every engine: a
    // construct the scanner has not been taught never runs, whether it is the scanner or the
    // engine's own parser that stops it. Which one does depends on the V8 version and is not
    // what is being promised.
    expect(() => buildSearchMatcher('(?i:foo)', { regex: true })).toThrow(UnsafePatternError);
  });

  it('tells apart two pieces written the same way, and quotes every construct it refuses', () => {
    const message = (pattern: string): string => {
      try {
        buildSearchMatcher(pattern, { regex: true });
      } catch (err) {
        return (err as Error).message;
      }
      return expect.unreachable(`${pattern} should have been refused`);
    };
    // Rule 3: "`a*` is matched again at each place `a*` can stop" names nothing a caller can find.
    expect(message('(?:a*)a*b')).toContain(
      '`a*` (at character 7) is matched again at each of the 2000 places `a*` (at character 4)',
    );
    // Rule 2: the same for the list of choice points.
    expect(message('.*a.*a.*b')).toContain('`.*` (at character 1), `.*` (at character 4)');
    // Distinct pieces are quoted plainly.
    expect(message('[\\s\\S]*a{999}b')).toContain('`a{999}` is matched again');
    // The product cap names the count that tipped it.
    expect(message('(?:a{100}){101}')).toContain('`(?:a{100}){101}`');
    // A construct the scanner was never taught is quoted too.
    expect(() => assertLinearishRegex('(?i:foo)')).toThrow('(`(?i:`)');
  });

  it('does not claim a leading `.*` is harmless under excludeComments', () => {
    // A hit counts as commented by where it STARTS: `.*\\cite` on `text % \cite{old}` starts at
    // the line's beginning, so the same line reads as a live hit — dropping the `.*` changes
    // the answer, and the refusal that advises dropping it has to say so.
    const msg = ((): string => {
      try {
        buildSearchMatcher('.*a.*a.*b', { regex: true });
      } catch (err) {
        return (err as Error).message;
      }
      return '';
    })();
    expect(msg).toContain('drop a leading/trailing `.*`');
    expect(msg).toContain('excludeComments');
    expect(msg).not.toContain('never changes which lines match');
  });

  it('gives advice that fits the refusal, and whose rewrites are themselves accepted', () => {
    const message = (pattern: string): string => {
      try {
        buildSearchMatcher(pattern, { regex: true });
      } catch (err) {
        return (err as Error).message;
      }
      return expect.unreachable(`${pattern} should have been refused`);
    };
    const accepts = (pattern: string): boolean => {
      try {
        buildSearchMatcher(pattern, { regex: true });
        return true;
      } catch {
        return false;
      }
    };
    // Inside a lookaround a `.*` is part of what is asserted: bound it, never drop it.
    const look = message('(?=.*a.*b)');
    expect(look).toContain('bound a repeat inside the lookaround (`.{0,80}` rather than `.*`)');
    expect(look).not.toContain('drop a leading');
    // A piece that can match nothing, entered at every split: the rewrite that works comes
    // first, and it IS accepted; the partial ones follow, and say they are partial.
    const arrival = message('x{0,75}x*a*b*c*d*\\}');
    expect(arrival).toContain('can match nothing, so it settles none of the repeats before it');
    const split = arrival.indexOf('Split the line fewer ways before it');
    const required = arrival.indexOf('Making such a piece required');
    const merged = arrival.indexOf('merging several into one class');
    expect(split).toBeGreaterThan(-1);
    expect(required).toBeGreaterThan(split);
    expect(merged).toBeGreaterThan(required);
    expect(accepts('x*a*b*c*d*\\}')).toBe(true);
    // Converging paths: the refusal says why a repeat that overlaps nothing after it counts,
    // and the rewrite it names is accepted.
    const converging = message('x{0,30}x*a+a{11}b');
    expect(converging).toContain('`x*` runs to the same place from each of the 31 places');
    expect(converging).toContain('`x*` alone matches the same text with one run');
    expect(accepts('x*a+a{11}b')).toBe(true);
    // Rule 4 names the fix, and its own example is one it refuses.
    const product = message('(?:a{100}){101}');
    expect(product).toContain('Lower one of the counts');
    expect(product).toContain('`(?:a{200}){100}` is twenty thousand');
    expect(accepts('(?:a{200}){100}')).toBe(false);
    // The worker bounds a search's time; a refusal must not claim the pattern could hang anything.
    expect(product).not.toContain('hang the server');
    expect(message('(a+)+$')).not.toContain('hang the server');
  });

  it('names the construct and the escape route in the refusal', () => {
    try {
      buildSearchMatcher('(a+)+$', { regex: true });
      expect.unreachable('should have refused');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('repeats a group without bound');
      // The construct itself, as written — not a generic `(...)*` the caller has to map back.
      expect(msg).toContain('`(a+)+`');
      expect(msg).toContain('regex: false');
    }
    try {
      buildSearchMatcher('\\\\ref\\{(fig|tab){2}', { regex: true });
      expect.unreachable('should have refused');
    } catch (err) {
      expect((err as Error).message).toContain('`(fig|tab){2}`');
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
    // Capture groups report what they END in, so a fenced repeat inside one stays fenced.
    '\\\\cite\\{([^}]*)\\}',
    '(\\w+)\\s',
    '\\\\label\\{(fig|tab|sec):[^}]*\\}', // disjoint branches are no choice at all
    '(?:\\\\ref|\\\\cref)\\{[^}]*\\}', // overlapping ones are a choice of 2
    '\\\\(sub)?section\\*?\\{',
    '\\\\todo(\\[[^\\]]*\\])?\\{',
    '[0-9]+(\\.[0-9]+)?',
    '\\d{1,3}\\.\\d{1,3}',
    '(?:ab){2,5}c', // a counted repeat of a rigid body
    '.{0,40}foo',
    // The factor of two the ambiguity budget allows beside one unbounded repeat.
    '.*a?b',
    '.*(fig|figure):',
    '.{0,62}.{0,62}b', // 63 x 63 = 3969: the costliest counted shape that fits
    '(\\w+)\\s+\\1', // a doubled word: the backreference starts with `\w`, which `\s+` cannot match
    '(?<w>\\w+)\\s+\\k<w>',
    '.*\\\\section\\{intro\\}', // a 15-character run after one unbounded repeat
    '.*a{19}b', // the longest counted run of one letter the step cap allows
    // Ordinary LaTeX searches. Each is at most quadratic on one line, and measured in
    // milliseconds: a written-out literal is checked as one unit, not re-run a letter at a time.
    '.*\\\\includegraphics\\[width',
    '.*\\\\section\\{introduction\\}',
    '^.*TODO.*$', // anchored: tried at one starting position, not 2000
    // Every costly start is a `\begin{` and every re-entry of `[^}]*` a `\label{`.
    '\\\\begin\\{(figure|table)\\}.*\\\\label\\{[^}]*\\}',
    // `[a-z_]+` cannot match the `:` before it, so its runs never overlap: quadratic, not cubic.
    '.*\\\\label\\{fig:[a-z_]+\\}',
    '.*\\\\newcommand\\{\\\\[a-zA-Z]+\\}',
    '.*TODO.*', // a trailing repeat that cannot fail is reached once: that arrival is the match
    '\\\\section\\{.*\\\\label\\{[^}]*\\}',
    // `b` cannot match an `a`, so it fails at once after each of the 6000 splits: 6ms.
    '.*a{0,2}b',
    // Lookbehinds, judged in the order V8 runs them (right to left).
    '(?<!\\\\)%',
    '(?<=\\\\cite\\{)[^}]*',
    '(?<=b.*)', // reversed, `.*` is the last thing tried: it cannot fail
    // A `\b` consumes nothing, so it does not break the written-out run after a repeat: `smith`
    // still occurs at most once per five characters.
    '\\\\cite\\{[^}]*\\bsmith\\b[^}]*\\}',
    // `\s*` can take neither the `}` before it nor the `\` after it, so each place `.*` stops
    // leads to one `\cite{` and no two to the same one: `[^}]*` is re-entered once per `\cite{`.
    '\\\\label\\{.*\\}\\s*\\\\cite\\{[^}]*\\}',
    '\\\\section\\{.*\\}\\s*\\\\label\\{[^}]*\\}',
    // `[a-z:_]+` cannot cross the `{` of another `\label{`, and `\s*` cannot cross a `}`: each
    // place `.*` stops leads to its own `}`, so the `\s*` runs never overlap (5ms at worst).
    '.*\\\\label\\{[a-z:_]+\\}\\s*$',
    // `(\[…\])?` must start with `[` and what follows it with `{`: the next character decides,
    // so it is no choice, and does not double the `\cite{`s `.*` is tried at (18ms at worst).
    '\\\\cite(\\[[^\\]]*\\])?\\{[^}]*\\}.*\\\\cite\\{[^}]*\\}',
    // A counted repeat, then an unbounded one that can take what it takes. `.*` stays OPEN past
    // the text after it, so the runs from each stop of the count never converge: no floor
    // (15ms at worst, most well under 1ms).
    '[A-Z]{2,5}.*\\\\cite',
    '\\$\\d{1,3}.*\\$',
    '\\d{1,4}.*\\\\cite',
    '\\d{2,4}.*\\\\\\\\',
    // A bounded repeat before a group that closes it inside: the factor `\s?` hands on through
    // the converging runs is counted once, as the written-out spelling counts it, not again for
    // `\s?` staying open past the `)` (12-16ms; refused for counting 2 x 2 x 2000).
    '\\s?\\s*\\\\cite.*\\\\cite',
    '\\s?(\\s*\\\\cite)(.*\\\\cite)',
    '(\\s?)(\\s*\\\\cite)(.*\\\\cite)',
    '\\s?(\\s*\\\\cite)(?:.*\\\\cite)',
  ];
  for (const pattern of accepted) {
    it(`accepts ${pattern}`, () => {
      expect(() => buildSearchMatcher(pattern, { regex: true })).not.toThrow();
    });
  }

  it('judges a bracketed spelling as it judges the written-out one, count for count', () => {
    // A group around the repeat that makes up the difference closes the bounded repeat before it
    // in there, as the written-out spelling does. Left open past the `)`, that repeat multiplied
    // everything after it by the factor already counted into the floor, and brackets cost the
    // shape its acceptance: `\s{0,k}(?:\s*y\{)` was accepted to k = 7 where written out it is
    // accepted to k = 38 (0.2s there, either way).
    const accepts = (pattern: string): boolean => {
      try {
        buildSearchMatcher(pattern, { regex: true });
        return true;
      } catch {
        return false;
      }
    };
    const shapes: Array<[(k: number) => string, Array<(k: number) => string>]> = [
      [
        (k) => `\\s{0,${k}}\\s*y\\{[^}]*\\}!`,
        [
          (k) => `\\s{0,${k}}(?:\\s*y\\{)[^}]*\\}!`,
          (k) => `\\s{0,${k}}(\\s*y\\{)[^}]*\\}!`,
          (k) => `(\\s{0,${k}})(\\s*y\\{)([^}]*\\}!)`,
        ],
      ],
      [
        (k) => `\\s{0,${k}}\\s*\\\\cite.*\\\\cite`,
        [
          (k) => `\\s{0,${k}}(\\s*\\\\cite)(.*\\\\cite)`,
          (k) => `(\\s{0,${k}})(\\s*\\\\cite)(?:.*\\\\cite)`,
        ],
      ],
    ];
    const differ: string[] = [];
    for (const [flat, groupings] of shapes) {
      for (let k = 1; k <= 60; k++) {
        const want = accepts(flat(k));
        for (const grouped of groupings) {
          if (accepts(grouped(k)) !== want) differ.push(`${grouped(k)} (written out: ${want})`);
        }
      }
    }
    expect(differ).toEqual([]);
  });

  it('refuses a bracketed spelling whose written-out spelling it refuses', () => {
    // Where a group closes a bounded repeat, the runs of that repeat converge in there with those
    // of every bounded repeat that re-entered it and is closed by then — as they do written out.
    // Closing it without settling them lost `x{1,32}` below; before the group closed it at all,
    // these were accepted where their written-out spellings are not.
    const pairs: Array<[string, string]> = [
      ['x{1,32}[x ]?(?:\\s*y\\{.*\\\\cite)(?=b)', 'x{1,32}[x ]?\\s*y\\{.*\\\\cite(?=b)'],
      ['\\s?x{0,40}?[xy]?(?:y*\\{)\\s*\\w+(\\})', '\\s?x{0,40}?[xy]?y*\\{\\s*\\w+\\}'],
      ['(?:x?|y?)\\s{0,57}[x ]?(?:x+:)\\s*\\w+', '(?:x?|y?)\\s{0,57}[x ]?x+:\\s*\\w+'],
      [
        '\\s{0,16}[x ]?(x*?\\\\cite[xy]?)y*:\\s*\\w+!',
        '\\s{0,16}[x ]?x*?\\\\cite[xy]?y*:\\s*\\w+!',
      ],
      ['x{0,40}[xy]?(?:xy*\\{)a+a{9}b', 'x{0,40}[xy]?xy*\\{a+a{9}b'],
    ];
    for (const [grouped, flat] of pairs) {
      expect(() => buildSearchMatcher(flat, { regex: true })).toThrow(UnsafePatternError);
      expect(() => buildSearchMatcher(grouped, { regex: true })).toThrow(UnsafePatternError);
    }
    // The other side: a repeat that re-entered it, but closes only further into the group, is
    // still open where it closes — its runs end apart, and written out this is accepted.
    expect(() =>
      buildSearchMatcher('[xy]?[xy]{0,2}[x ]?(?:x*y\\{)x{0,28}?y*:a+', { regex: true }),
    ).not.toThrow();
  });

  /**
   * The header's measured worst case, checked by running: every pattern the analyzer ACCEPTS,
   * out of the accept table above, a corpus of shapes that are polynomially slow when
   * misjudged, and — for each family of shapes that gets slower with a count — the LARGEST
   * count the analyzer accepts (or, for a family that gets CHEAPER as its written-out run
   * grows, the SMALLEST run), runs fast against every adversarial 2000-character line built
   * from its own characters. The families are what pin the rule-3 cap and its step weights:
   * raise the cap, or credit written-out text or a period more generously, and the accepted
   * member of the matching family grows with it until this fails. The exponential shapes are
   * pinned in the refused table instead, never run.
   *
   * Timing, because nothing else can see inside `RegExp.exec` — there is no step counter to
   * read. What keeps it from flaking is the gap it measures across, not a tight threshold:
   * the costliest accepted families measure 1 to 1.7 times `\w*\w{19}!` (0.13-0.3s where that
   * takes ~135ms; the slowest accepted patterns known, 2 to 3 times it, 0.3-0.45s, are not in
   * this corpus), a misjudged one takes SECONDS (the counted families cost 3-8s at a count the
   * analyzer once accepted; the lookbehind shapes accepted for one round, 2s to over a minute;
   * `x{0,75}x*` followed by four empty-matching repeats, 1.3-1.8s; the converging families,
   * 1.2-1.3s at the largest counts the analyzer accepted before it counted them, and 6.4s for
   * two stages), and the threshold sits in between at 1s. Load only ever slows a run down, so
   * a line counts as slow only when it is slow on every one of three attempts: a busy CI
   * runner has to stall the same scan three times running to fail it.
   */
  it('runs every accepted pattern fast on adversarial 2000-character lines', () => {
    // A run of distinct letters: `x` then `a`s, which overlaps itself nowhere — period `k`.
    const run = (k: number): string => 'x' + 'a'.repeat(k - 1);
    // Converging paths: a bounded repeat, an unbounded one that makes up the difference, then a
    // run that overlaps neither. Their costly lines are a run of the repeated letter then a run
    // of the next one, which every split of the bounded repeat hands on to in full. The two-stage
    // family took 6.4s at the count the analyzer accepted before it counted these.
    const twoStages = [10, 30, 60, 200].map((n) =>
      ('x'.repeat(n) + '{' + 'y'.repeat(n) + '{' + 'a'.repeat(2000)).slice(0, 2000),
    );
    const converging: Array<[(k: number) => string, string[]]> = [
      [(k) => `x{0,${k}}x*a+a{9}b`, xThenA('x', 'a')],
      [(k) => `x{0,1}x*a+a{${k}}b`, xThenA('x', 'a')],
      [(k) => `\\s{0,${k}}\\s*\\w+\\w{9}!`, xThenA(' ', 'a')],
      [(k) => `x{0,${k}}x*\\{a+b`, xThenA('x', '{' + 'a'.repeat(1999))],
      [(k) => `x{0,${k}}x*\\{y{0,${k}}y*\\{a+a{4}b`, twoStages],
      // The same stages inside groups, whose floor has to reach past the `)` (2.7-2.9s at the
      // count the analyzer accepted when it stopped at the group's end).
      [(k) => `(x{0,${k}}x*\\{)(y{0,${k}}y*\\{)a+a{4}b`, twoStages],
      [(k) => `(?:x{0,${k}}x*\\{)(?:y{0,${k}}y*\\{)a+a{4}b`, twoStages],
      [(k) => `(?:x{0,${k}}x*\\{)?a+a{9}b`, xThenA('x', '{' + 'a'.repeat(1999))],
      [(k) => `x{0,${k}}(?:x*\\{)a+a{9}b`, xThenA('x', '{' + 'a'.repeat(1999))],
      // A group that closes the bounded repeat before it, accepted to the written-out count.
      [
        (k) => `\\s{0,${k}}(?:\\s*y\\{)[^}]*\\}!`,
        [
          ' '.repeat(2000),
          'x'.repeat(60) + ' '.repeat(1940),
          ' '.repeat(40) + 'y{' + 'a'.repeat(1958),
        ],
      ],
    ];
    const corpus: Array<string | [string, string[]]> = [
      ...accepted,
      // Written-out text after the lines the tables above name, so that what `.*` can stop at
      // is a `\label{` or a `\begin{figure}` everywhere, not only where the skeleton puts one.
      [
        '\\\\begin\\{(figure|table)\\}.*\\\\label\\{[^}]*\\}',
        ['\\begin{figure}'.repeat(47) + '\\label{'.repeat(190), '\\begin{figure}\\label{'],
      ],
      ['\\\\section\\{.*\\\\label\\{[^}]*\\}', ['\\section{'.repeat(40) + '\\label{'.repeat(200)]],
      ['.*\\\\label\\{fig:[a-z_]+\\}', ['\\label{fig:' + 'a'.repeat(40)]],
      // A line ending in a character `.` stops at, so `$` fails after every `\s*` run.
      [
        '.*\\\\label\\{[a-z:_]+\\}\\s*$',
        [
          ('\\label{a} '.repeat(199) + ' ').slice(0, 1999) + LS,
          ('\\label{a}'.repeat(110) + ' '.repeat(1000)).slice(0, 1999) + LS,
        ],
      ],
      // Lines that never match: every `\cite{` before the one `}` is a costly start, and every
      // `\cite{` after it is a place `.*` stops and `[^}]*` runs to the end.
      [
        '\\\\cite(\\[[^\\]]*\\])?\\{[^}]*\\}.*\\\\cite\\{[^}]*\\}',
        [
          '\\cite{'.repeat(133) + '}' + '\\cite{'.repeat(200),
          '\\cite[]{'.repeat(100) + '}' + '\\cite{'.repeat(200),
          '\\cite['.repeat(100) + ']{}' + '\\cite{'.repeat(250),
        ],
      ],
      '(?:a*)a*b',
      '.*a\\w+\\s',
      '.*\\\\cite\\{[^}]*\\}',
      '[^x]*a[^x]*b',
      '.{0,100}.{0,100}b',
      '\\w*\\w{0,300}x',
      // Each family's LARGEST accepted count: these pin the step weights and the rule-3 cap.
      ...[
        (k: number) => `.*a{${k}}b`,
        (k: number) => `[\\s\\S]*a{${k}}b`,
        (k: number) => `.*a?a{${k}}b`,
        (k: number) => `\\w*\\w{${k}}!`,
        (k: number) => `a*(?:aa){${k}}b`,
        (k: number) => `.*(?:a{${k}}|b)c`,
        (k: number) => `.*(a{${k}})\\1b`,
        (k: number) => `.{0,${k}}.{0,${k}}b`,
        (k: number) => `.*a{0,${k}}b`,
        (k: number) => `.*[ab]{0,${k}}c`,
        // Written-out text is charged a quarter step a letter: these grow with that weight.
        (k: number) => '.*' + '\\w'.repeat(6) + '\\s' + '\\w'.repeat(k),
        (k: number) => '.*a?' + '\\w'.repeat(6) + '\\s' + '\\w'.repeat(k),
        (k: number) => '.{0,62}.{0,62}' + '\\w'.repeat(6) + '\\s' + '\\w'.repeat(k),
        (k: number) => '.{0,62}.{0,62}' + '(?:a)'.repeat(k) + 'b',
        (k: number) => '.*' + '(a)'.repeat(k) + 'b',
        // Lookbehinds run right to left: `(?<=ba?a{k}.*)` is `.*a{k}a?b` run backwards.
        (k: number) => `(?<=ba?a{${k}}.*)`,
        // Empty-matching pieces entered at every split of the repeats before them, and a greedy
        // repeat inside an optional capture group: these pin the per-arrival and in-loop weights.
        (k: number) => `x{0,${k}}x*a*b*c*d*\\}`,
        (k: number) => `x{0,${k}}(x*)(a*)(b*)\\}`,
        (k: number) => `x{0,${k}}(\\wx*)?\\}`,
      ].map((family) => largestAccepted(family, 240)),
      // Converging paths: see `converging` above.
      ...converging.map(([family, lines]): [string, string[]] => [
        largestAccepted(family, 240),
        lines,
      ]),
      // A lookbehind whose run must FAIL at every place its `.*` stops, which a line of `a`s
      // never makes it do: `k - 1` `a`s then a `b`, over and over (~100ms at the largest `k`).
      ((): [string, string[]] => {
        const pattern = largestAccepted((k) => `(?<=a{${k}}.*)`, 240);
        const k = Number(/\{(\d+)\}/.exec(pattern)?.[1] ?? 1);
        return [pattern, ['a'.repeat(Math.max(0, k - 1)) + 'b']];
      })(),
      // Each family's SMALLEST accepted run: these pin the period and lead-text credits, which
      // accept MORE as the run grows. Their costly line is the run itself, repeated.
      ...[
        (k: number) => run(k) + '.*a[^}]*\\}',
        (k: number) => run(k) + '.*' + run(k) + '[^}]*\\}',
      ].map((family): [string, string[]] => {
        const k = smallestAccepted(family, 200);
        return [family(k), [run(k), run(k) + 'a'.repeat(4 * k), run(k).repeat(2) + 'y']];
      }),
      // The same for a run behind a `\b`, and for one behind a bridging `\s*`: their costly
      // lines put the run after every place the repeat before it can stop.
      ...[
        (k: number) => '\\\\cite\\{[^}]*\\b' + run(k) + '\\b[^}]*\\}',
        (k: number) => '\\\\label\\{.*\\}\\s*' + run(k) + '[^}]*\\}',
      ].map((family): [string, string[]] => {
        const k = smallestAccepted(family, 200);
        return [
          family(k),
          [
            '\\cite{' + (run(k) + ' ').repeat(400),
            '\\cite{' + run(k).repeat(400),
            '\\label{' + ('} ' + run(k)).repeat(400),
            '\\label{' + ('}' + run(k)).repeat(400),
            '\\label{' + '}'.repeat(1000) + ' '.repeat(1000),
          ],
        ];
      }),
    ];
    const slow: string[] = [];
    for (const entry of corpus) {
      const [pattern, extra] = typeof entry === 'string' ? [entry, []] : entry;
      let re: RegExp;
      try {
        re = buildSearchMatcher(pattern, { regex: true });
      } catch {
        continue; // refused: never run, which is the point
      }
      for (const line of adversarialLines(pattern, extra)) {
        const ms = timeScan(re, line, SLOW_LINE_MS);
        if (ms > SLOW_LINE_MS) {
          slow.push(`${pattern} on ${JSON.stringify(line.slice(0, 12))}…: ${ms.toFixed(0)}ms`);
          break;
        }
      }
    }
    expect(slow).toEqual([]);
  }, 120_000);

  it('credits written-out text, anchors and trailing repeats only where they limit the work', () => {
    const accepts = (pattern: string): boolean => {
      try {
        buildSearchMatcher(pattern, { regex: true });
        return true;
      } catch {
        return false;
      }
    };
    // The fence: `:` is a letter `[a-z_]` cannot match, so the runs it starts never overlap
    // (4ms). `[^}]` matches `:` too, so nothing fences it — cubic over eleven, 163ms.
    expect(accepts('.*\\\\label\\{fig:[a-z_]+\\}')).toBe(true);
    expect(accepts('.*\\\\label\\{fig:[^}]+\\}')).toBe(false);
    // The anchor: `^` leaves one starting position (1ms). Without it, every position of a line
    // of `TODO`s ending in a character `.` stops at runs the whole chain — 383ms.
    expect(accepts('^.*TODO.*$')).toBe(true);
    expect(accepts('.*TODO.*$')).toBe(false);
    // The trailing repeat: with nothing after it that can fail, the first arrival is the match.
    expect(accepts('.*TODO.*')).toBe(true);
    // The lead text: a costly start is a `\section{`, at most one per nine characters. The same
    // chain tried at every position is the refused `.*\label{[^}]*}` row.
    expect(accepts('\\\\section\\{.*\\\\label\\{[^}]*\\}')).toBe(true);
    expect(accepts('.*\\\\label\\{[^}]*\\}')).toBe(false);
    // The credit is the text's PERIOD, not its length: forty `a`s occur at every position of a
    // run of `a`s (771ms on `a`s then `b`s), where `x` and 39 `a`s occur once per forty (20ms).
    expect(accepts('x' + 'a'.repeat(39) + '.*b[^}]*\\}')).toBe(true);
    expect(accepts('a'.repeat(40) + '.*b[^}]*\\}')).toBe(false);
    // Written-out letters are cheap, not free: a 197-letter run re-checked at each of the 3969
    // splits of `.{0,62}.{0,62}` took 386ms when its middle letter mismatched.
    expect(accepts('.{0,62}.{0,62}' + '\\w'.repeat(6) + '\\s' + '\\w'.repeat(190))).toBe(false);
  });

  it('refuses a long run re-matched after a repeat, and names both', () => {
    try {
      buildSearchMatcher('[\\s\\S]*a{999}b', { regex: true });
      expect.unreachable('should have refused');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('`a{999}`');
      expect(msg).toContain('`[\\s\\S]*`');
      expect(msg).toContain(`at most ${MAX_CHAIN_WORK}`);
      expect(msg).toContain('regex: false');
    }
    // A run behind something the repeat cannot match is not re-matched: the repeat is fenced.
    expect(() => buildSearchMatcher('[^a]*a{999}b', { regex: true })).not.toThrow();
  });

  it('judges overlap by characters, not by shape — non-ASCII included', () => {
    // One ambiguous repeat is allowed...
    expect(() => buildSearchMatcher('[\\u1000-\\u2000]*\\u1500', { regex: true })).not.toThrow();
    // ...two are not, and the alphabet the overlap test uses has to carry characters this
    // pattern names but no ASCII sample would contain. Without the pattern's own characters
    // (and its range endpoints) in that alphabet, these two would be declared disjoint and
    // waved through — an under-refusal, the one direction the test must not allow.
    expect(() =>
      buildSearchMatcher('[\\u1000-\\u2000]*\\u1500[\\u1000-\\u2000]*\\u1500', { regex: true }),
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

/**
 * Lines of 2000 characters built to make a pattern backtrack: each character the pattern names
 * repeated, and the pattern's literal skeleton (escapes resolved, syntax dropped) repeated —
 * which is what `\\cite\{[^}]*\}` needs to see a `\cite{` at every position.
 */
function adversarialLines(pattern: string, extra: string[] = []): string[] {
  const chars = new Set([...pattern, 'a', ' ', 'x', '\\']);
  chars.delete('\n');
  const lines = [...chars].map((c) => c.repeat(2000));
  const skeleton = pattern
    .replace(/\\([^a-zA-Z0-9])/g, '$1')
    .replace(/\\[a-zA-Z]/g, 'a')
    .replace(/[*+?^$()[\]|{}]|\{\d+(,\d*)?\}/g, '');
  for (const unit of skeleton === '' ? extra : [skeleton, ...extra]) {
    lines.push(unit.repeat(Math.ceil(2000 / unit.length)).slice(0, 2000));
  }
  return lines;
}

/**
 * 2000-character lines of `first` repeated then `then` repeated, at several splits: what a
 * converging-paths pattern needs to see every split of its bounded repeat hand on in full.
 */
function xThenA(first: string, then: string): string[] {
  return [30, 60, 240, 1000, 1500].map((n) => (first.repeat(n) + then.repeat(2000)).slice(0, 2000));
}

/** U+2028, which `.` does not match: a line ending in it makes every `.*$` and `\s*$` fail. */
const LS = String.fromCharCode(0x2028);

/** A line slower than this on every attempt is a misjudged pattern. See the test above. */
const SLOW_LINE_MS = 1000;

/**
 * Scan the line as `search_files` does — ONE `exec` from the start, which finds the first match
 * or fails at every position — and return the fastest of up to three attempts, stopping at the
 * first one under `threshold`.
 */
function timeScan(re: RegExp, line: string, threshold: number): number {
  let best = Infinity;
  for (let attempt = 0; attempt < 3 && best > threshold; attempt++) {
    const started = performance.now();
    re.lastIndex = 0;
    re.exec(line);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/**
 * The pattern with the largest count `k` in [0, 2000] the analyzer accepts, found by bisection
 * (each family only gets costlier as `k` grows, so acceptance is monotone in it). With no
 * accepted count it returns the `k = 0` form, which the corpus loop then skips as refused.
 */
function largestAccepted(family: (k: number) => string, max = 2000): string {
  const accepts = acceptor(family);
  let lo = 0;
  let hi = max;
  if (accepts(hi)) return family(hi);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (accepts(mid)) lo = mid;
    else hi = mid;
  }
  return family(lo);
}

/**
 * The SMALLEST `k` in [1, max] the analyzer accepts, for a family that only gets cheaper as `k`
 * grows (a longer run occurs less often). Fails the test outright when even `max` is refused,
 * rather than timing nothing: a family pinned here has to reach the corpus to pin anything.
 */
function smallestAccepted(family: (k: number) => string, max: number): number {
  const accepts = acceptor(family);
  expect(accepts(max), `${family(max)} should be accepted`).toBe(true);
  let lo = 1;
  let hi = max;
  if (accepts(lo)) return lo;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (accepts(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

function acceptor(family: (k: number) => string): (k: number) => boolean {
  return (k) => {
    try {
      buildSearchMatcher(family(k), { regex: true });
      return true;
    } catch {
      return false;
    }
  };
}

import { describe, it, expect } from 'vitest';
import { matchFileLines, MAX_MATCH_TEXT_CHARS } from '../../src/lib/searchMatch.js';
import { buildSearchMatcher } from '../../src/lib/searchPattern.js';

const literal = (p: string): RegExp => buildSearchMatcher(p);
const rx = (p: string): RegExp => buildSearchMatcher(p, { regex: true });

describe('matchFileLines: what matches', () => {
  it('reports one entry per matching LINE, with 1-based numbers', () => {
    const text = 'alpha\nbeta\nalpha again\n';
    const found = matchFileLines(text, literal('alpha'));
    expect(found.matches).toEqual([
      { line: 1, text: 'alpha' },
      { line: 3, text: 'alpha again' },
    ]);
  });

  it('reports a line with several occurrences once', () => {
    const found = matchFileLines('x x x\n', literal('x'));
    expect(found.matches).toHaveLength(1);
  });

  it('counts lines as splitLines does, so CRLF does not shift numbering', () => {
    const found = matchFileLines('a\r\nb\r\nhit\r\n', literal('hit'));
    expect(found.matches[0]?.line).toBe(3);
  });

  it('resets the shared matcher between lines and between calls', () => {
    // A `g`-flagged RegExp carries lastIndex; one left set would silently skip the start of the
    // next line (and of the next file, since the search reuses one compiled matcher).
    const matcher = literal('a');
    expect(matchFileLines('a\na\na\n', matcher).matches).toHaveLength(3);
    expect(matchFileLines('a\na\na\n', matcher).matches).toHaveLength(3);
  });

  it('handles a pattern that can match the empty string without looping', () => {
    const found = matchFileLines('ab\ncd\n', rx('x*'));
    expect(found.matches).toHaveLength(2);
  });
});

describe('matchFileLines: context lines', () => {
  const text = ['one', 'two', 'three', 'HIT', 'five', 'six', 'seven'].join('\n');

  it('attaches the requested lines on each side, nearest-in order', () => {
    const found = matchFileLines(text, literal('HIT'), { contextLines: 2 });
    expect(found.matches[0]?.before).toEqual(['two', 'three']);
    expect(found.matches[0]?.after).toEqual(['five', 'six']);
  });

  it('omits the fields entirely at contextLines: 0', () => {
    const found = matchFileLines(text, literal('HIT'));
    expect(found.matches[0]).toEqual({ line: 4, text: 'HIT' });
  });

  it('clips at the ends of the file rather than padding', () => {
    const found = matchFileLines('HIT\nnext\n', literal('HIT'), { contextLines: 3 });
    expect(found.matches[0]?.before).toBeUndefined();
    expect(found.matches[0]?.after).toEqual(['next']);
  });
});

describe('matchFileLines: LaTeX comments', () => {
  const text = [
    '\\Cref{tab:a} is live',
    '% \\Cref{tab:a} in a comment',
    'text \\Cref{tab:a} % and a trailing comment',
    'a percentage 50\\% then \\Cref{tab:a}',
    'live % \\Cref{tab:a}',
  ].join('\n');

  it('counts comment-only lines without excluding them by default', () => {
    const found = matchFileLines(text, literal('\\Cref{tab:a}'), { commentAware: true });
    expect(found.matches.map((m) => m.line)).toEqual([1, 2, 3, 4, 5]);
    // Lines 2 and 5 are the ones whose only hit sits after an unescaped `%`.
    expect(found.commentMatches).toBe(2);
  });

  it('excludes them on request, and still counts them', () => {
    const found = matchFileLines(text, literal('\\Cref{tab:a}'), {
      commentAware: true,
      excludeComments: true,
    });
    expect(found.matches.map((m) => m.line)).toEqual([1, 3, 4]);
    expect(found.commentMatches).toBe(2);
  });

  it('keeps a hit on a line whose `%` is escaped (`50\\%`)', () => {
    const found = matchFileLines('50\\% of \\Cref{tab:a}\n', literal('\\Cref{tab:a}'), {
      commentAware: true,
      excludeComments: true,
    });
    expect(found.matches).toHaveLength(1);
    expect(found.commentMatches).toBe(0);
  });

  it('keeps a match that STARTS in live text and runs past a `%`', () => {
    const found = matchFileLines('live% tail\n', rx('live% tail'), {
      commentAware: true,
      excludeComments: true,
    });
    expect(found.matches).toHaveLength(1);
  });

  it('is inert where `%` is not a comment character', () => {
    // commentAware is false for a .md/.txt: `%` there is ordinary text, and excluding on it
    // would silently drop live hits.
    const found = matchFileLines('% 50% of runs hit\n', literal('hit'), {
      commentAware: false,
      excludeComments: true,
    });
    expect(found.matches).toHaveLength(1);
    expect(found.commentMatches).toBe(0);
  });
});

describe('matchFileLines: long lines', () => {
  it('windows the reported text AROUND the match, marking the elision', () => {
    const line = `${'x'.repeat(500)}NEEDLE${'y'.repeat(500)}`;
    const found = matchFileLines(`${line}\n`, literal('NEEDLE'));
    const text = found.matches[0]?.text ?? '';
    // A head truncation would report 200 characters that do not contain the hit at all.
    expect(text).toContain('NEEDLE');
    expect(text.startsWith('…')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_MATCH_TEXT_CHARS + 2);
  });

  it('searches only up to the scan cap and COUNTS the line as truncated', () => {
    const line = `${'x'.repeat(100)}NEEDLE`;
    const found = matchFileLines(`${line}\n`, literal('NEEDLE'), { maxLineScanChars: 50 });
    // Not found — and the result says so rather than reporting a clean "no match".
    expect(found.matches).toHaveLength(0);
    expect(found.linesTruncatedForScan).toBe(1);
  });

  it('does not count a line at exactly the cap', () => {
    const found = matchFileLines(`${'x'.repeat(50)}\n`, literal('x'), { maxLineScanChars: 50 });
    expect(found.linesTruncatedForScan).toBe(0);
  });

  it('clips a context line rather than shipping a whole generated line', () => {
    const found = matchFileLines(`${'z'.repeat(1500)}\nHIT\n`, literal('HIT'), {
      contextLines: 1,
    });
    expect(found.matches[0]?.before?.[0]?.length).toBe(MAX_MATCH_TEXT_CHARS + 1); // + the `…`
  });
});

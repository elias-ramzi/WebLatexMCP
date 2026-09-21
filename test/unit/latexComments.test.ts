import { describe, it, expect } from 'vitest';
import { commentStartIndex } from '../../src/lib/latexComments.js';

/**
 * The `%` rule `search_files`' `excludeComments` stands on. Every case here is a boundary: the
 * escape rule is the whole reason this is a function and not an `indexOf('%')`, and getting it
 * backwards would drop every live hit after a percentage in a results table.
 */
describe('commentStartIndex', () => {
  it('finds a comment at the start of a line', () => {
    expect(commentStartIndex('% a note')).toBe(0);
    expect(commentStartIndex('   % indented note')).toBe(3);
  });

  it('finds a trailing comment after live text', () => {
    expect(commentStartIndex('\\Cref{tab:a} % retired')).toBe(13);
  });

  it('reports no comment when there is none', () => {
    expect(commentStartIndex('\\Cref{tab:a}')).toBe(-1);
    expect(commentStartIndex('')).toBe(-1);
  });

  it('treats \\% as a literal percent, not a comment', () => {
    // The line is entirely live: a match after the escaped percent must NOT be suppressed.
    expect(commentStartIndex('50\\% faster than \\Cref{tab:a}')).toBe(-1);
  });

  it('treats \\\\% as a comment — the backslash is escaped, the percent is not', () => {
    // `\\` is a line break in LaTeX; the `%` after it starts a comment, as TeX reads it.
    expect(commentStartIndex('text \\\\% a note')).toBe(7);
  });

  it('counts backslashes in a run, not just the one before the percent', () => {
    expect(commentStartIndex('a\\\\\\% literal')).toBe(-1); // three: odd, so escaped
    expect(commentStartIndex('a\\\\\\\\% comment')).toBe(5); // four: even, so a comment
  });

  it('takes the FIRST unescaped percent when a line has several', () => {
    expect(commentStartIndex('a \\% b % c % d')).toBe(7);
  });

  it('does not let a backslash run reset across other characters', () => {
    // The backslash belongs to `\alpha`, not to the `%` two characters later.
    expect(commentStartIndex('\\alpha x% note')).toBe(8);
  });
});

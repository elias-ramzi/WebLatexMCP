import { describe, it, expect } from 'vitest';
import { parseBibtex } from '../../src/lib/references.js';

/**
 * #222: `parseBibtex` started an entry at any `@` followed by a word and a brace, so the TeX control
 * sequence `\@ifundefined{theHchapter}{…}{…}` in a `.bib` came back as an entry of type
 * `ifundefined` keyed `theHchapter`. An `@` right after an ODD run of backslashes is part of a
 * control sequence and never an entry; after an even run (literal `\\`s) it still is.
 */

const ARTICLE = '@article{a1,\n  title = {A Title},\n  year = {2020}\n}\n';
const keys = (text: string) => parseBibtex(text).map((e) => [e.key, e.type]);

describe('parseBibtex skips an `@` that belongs to a TeX control sequence', () => {
  // Row 1 of the issue's table. Already correct before the fix (the @preamble body is skipped
  // whole); kept as the baseline the other two rows are measured against.
  it('an \\@ifundefined inside @preamble is not an entry', () => {
    const text =
      '@preamble{ "\\makeatletter\\@ifundefined{theHchapter}{}{}\\makeatother" }\n' + ARTICLE;
    expect(keys(text)).toEqual([['a1', 'article']]);
  });

  // Row 2: a `%` line is not a comment to BibTeX, but the backslash still marks a control sequence.
  it('an \\@ifundefined on a % comment line is not an entry', () => {
    const text = '% \\@ifundefined{theHchapter}{}{}\n' + ARTICLE;
    expect(keys(text)).toEqual([['a1', 'article']]);
  });

  // Row 3: bare \makeatletter … \makeatother lines between entries.
  it('bare \\makeatletter / \\@ifundefined / \\makeatother lines are not an entry', () => {
    const text =
      '\\makeatletter\n\\@ifundefined{theHchapter}{\\def\\theHchapter{x}}{}\n\\makeatother\n' +
      ARTICLE;
    expect(keys(text)).toEqual([['a1', 'article']]);
    // The real entry's line is still its own.
    expect(parseBibtex(text)[0]!.line).toBe(4);
  });

  it('an `@` after an even run of backslashes still starts an entry', () => {
    expect(keys('\\\\' + ARTICLE)).toEqual([['a1', 'article']]);
    // Three backslashes: a literal `\\`, then `\@…` — a control sequence again.
    expect(keys('\\\\\\@misc{x1, title={T}}\n' + ARTICLE)).toEqual([['a1', 'article']]);
  });
});

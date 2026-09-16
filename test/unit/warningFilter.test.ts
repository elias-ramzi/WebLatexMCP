import { describe, it, expect } from 'vitest';
import { warningMatches, isEmptyFilter } from '../../src/lib/warningFilter.js';

describe('warningMatches', () => {
  it('keeps everything when the filter is undefined', () => {
    expect(warningMatches({}, undefined)).toBe(true);
    expect(warningMatches({ file: 'a.tex', rule: 'LaTeX' }, undefined)).toBe(true);
  });

  it('keeps everything for an empty-object filter', () => {
    expect(warningMatches({ file: 'a.tex', rule: 'LaTeX' }, {})).toBe(true);
    expect(warningMatches({}, {})).toBe(true);
  });

  describe('file', () => {
    it('keeps only the exact path named', () => {
      const f = { file: ['sections/intro.tex'] };
      expect(warningMatches({ file: 'sections/intro.tex' }, f)).toBe(true);
      expect(warningMatches({ file: 'sections/other.tex' }, f)).toBe(false);
    });

    it('drops a fileless warning when file is given', () => {
      expect(warningMatches({ rule: 'LaTeX' }, { file: ['sections/intro.tex'] })).toBe(false);
    });

    it('is exact and literal — no prefix/suffix match', () => {
      const f = { file: ['sections/intro.tex'] };
      // Near miss: a longer path that merely starts with the same string.
      expect(warningMatches({ file: 'sections/intro.tex.bak' }, f)).toBe(false);
    });

    it('is case-sensitive', () => {
      expect(warningMatches({ file: 'Sections/intro.tex' }, { file: ['sections/intro.tex'] })).toBe(
        false,
      );
    });
  });

  describe('rule', () => {
    it('keeps only the rules named', () => {
      const f = { rule: ['Overfull \\hbox'] };
      expect(warningMatches({ rule: 'Overfull \\hbox' }, f)).toBe(true);
      expect(warningMatches({ rule: 'Underfull \\vbox' }, f)).toBe(false);
      expect(warningMatches({}, f)).toBe(false); // rule-less warning dropped by an include list
    });
  });

  describe('excludeRule', () => {
    it('drops a matching rule and keeps everything else', () => {
      const f = { excludeRule: ['Overfull \\hbox'] };
      expect(warningMatches({ rule: 'Overfull \\hbox' }, f)).toBe(false);
      expect(warningMatches({ rule: 'Underfull \\vbox' }, f)).toBe(true);
    });

    it('never excludes a rule-less warning', () => {
      expect(warningMatches({}, { excludeRule: ['Overfull \\hbox'] })).toBe(true);
      expect(warningMatches({ file: 'a.tex' }, { excludeRule: ['Overfull \\hbox'] })).toBe(true);
    });
  });

  it('requires every present clause to pass', () => {
    const f = { file: ['sections/intro.tex'], rule: ['Overfull \\hbox'], excludeRule: ['LaTeX'] };
    // Matches file and rule, not excluded.
    expect(warningMatches({ file: 'sections/intro.tex', rule: 'Overfull \\hbox' }, f)).toBe(true);
    // Right file, wrong rule.
    expect(warningMatches({ file: 'sections/intro.tex', rule: 'Underfull \\vbox' }, f)).toBe(false);
    // Right file and rule, but excluded.
    const excluded = { file: ['sections/intro.tex'], rule: ['LaTeX'], excludeRule: ['LaTeX'] };
    expect(warningMatches({ file: 'sections/intro.tex', rule: 'LaTeX' }, excluded)).toBe(false);
  });
});

describe('isEmptyFilter', () => {
  it('is true for undefined', () => {
    expect(isEmptyFilter(undefined)).toBe(true);
  });

  it('is true for an empty object', () => {
    expect(isEmptyFilter({})).toBe(true);
  });

  it('is true when every array present is empty', () => {
    expect(isEmptyFilter({ file: [] })).toBe(true);
    expect(isEmptyFilter({ file: [], rule: [], excludeRule: [] })).toBe(true);
  });

  it('is false once any array has an entry', () => {
    expect(isEmptyFilter({ file: ['a'] })).toBe(false);
    expect(isEmptyFilter({ rule: ['LaTeX'] })).toBe(false);
    expect(isEmptyFilter({ excludeRule: ['LaTeX'] })).toBe(false);
  });
});

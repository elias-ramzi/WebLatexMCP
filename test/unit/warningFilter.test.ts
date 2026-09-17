import { describe, it, expect } from 'vitest';
import { warningMatches, isEmptyFilter, makeWarningJudge } from '../../src/lib/warningFilter.js';

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

describe('makeWarningJudge', () => {
  const WITHHELD = 'sections/escapes.tex';
  const withheld = new Set([WITHHELD]);

  it('returns undefined when the filter constrains nothing', () => {
    // Not an always-true predicate: the caller branches on this ONE value for both channels, so
    // "no filter => byte-identical output and filterLog skips its paren-stack bookkeeping" cannot
    // be re-derived differently per channel. A non-empty withheld set does not change that.
    expect(makeWarningJudge(withheld, undefined)).toBeUndefined();
    expect(makeWarningJudge(withheld, {})).toBeUndefined();
    expect(makeWarningJudge(withheld, { file: [], rule: [], excludeRule: [] })).toBeUndefined();
  });

  it('returns a predicate for any non-empty filter', () => {
    expect(typeof makeWarningJudge(withheld, { file: ['a.tex'] })).toBe('function');
    expect(typeof makeWarningJudge(withheld, { rule: ['LaTeX'] })).toBe('function');
    expect(typeof makeWarningJudge(withheld, { excludeRule: ['LaTeX'] })).toBe('function');
  });

  it('judges a withheld path on the file the caller sees, not the log original', () => {
    // The composition under test: the candidate is stripped FIRST, so a `file` filter naming the
    // withheld path drops it (a fileless warning fails a `file` clause). Judged before stripping,
    // this would be true — and the tail channel would keep a warning `warnings[]` dropped.
    const judge = makeWarningJudge(withheld, { file: [WITHHELD, 'sections/intro.tex'] });
    expect(judge).toBeDefined();
    expect(judge!({ file: WITHHELD, rule: 'Overfull \\hbox' })).toBe(false);
    // A path that was not withheld still matches the same filter's other entry.
    expect(judge!({ file: 'sections/intro.tex', rule: 'Overfull \\hbox' })).toBe(true);
  });

  describe('both channels ask the same question', () => {
    // Structured side: `file` is already gone, withoutUnopenableLocation having run upstream.
    // Tail side: `file` comes off the log's own paren stack and still carries the real path.
    // One judge must answer identically for the two — i.e. it is idempotent on an already-
    // stripped candidate — or the channels disagree exactly on the withheld paths.
    //
    // Only the `file` case below is sensitive to the composition ORDER: stripping touches nothing
    // but `file`, so the `rule`/`excludeRule` cases agree whether the judge strips first or not.
    // They are kept as the other half of the claim — that stripping a file never disturbs the rule
    // clauses across channels — not as evidence the order is right. The order is pinned by the
    // `file` case and by `judges a withheld path on the file the caller sees` above.
    const structuredSide = { rule: 'Overfull \\hbox' };
    const tailSide = { file: WITHHELD, rule: 'Overfull \\hbox' };

    it('agrees under a file filter naming the withheld path', () => {
      const judge = makeWarningJudge(withheld, { file: [WITHHELD] });
      expect(judge).toBeDefined();
      expect(judge!(tailSide)).toBe(judge!(structuredSide));
      expect(judge!(tailSide)).toBe(false);
    });

    it('agrees under a rule filter — stripping leaves the rule clause alone', () => {
      const judge = makeWarningJudge(withheld, { rule: ['Overfull \\hbox'] });
      expect(judge).toBeDefined();
      expect(judge!(tailSide)).toBe(judge!(structuredSide));
      expect(judge!(tailSide)).toBe(true);
    });

    it('agrees under an excludeRule filter — stripping leaves the rule clause alone', () => {
      const judge = makeWarningJudge(withheld, { excludeRule: ['Overfull \\hbox'] });
      expect(judge).toBeDefined();
      expect(judge!(tailSide)).toBe(judge!(structuredSide));
      expect(judge!(tailSide)).toBe(false);
    });
  });

  it('leaves the rule clauses undisturbed for a withheld candidate', () => {
    // Stripping a file never turns a keep into a drop except through the `file` clause.
    const drops = makeWarningJudge(withheld, { excludeRule: ['Overfull \\hbox'] });
    expect(drops).toBeDefined();
    expect(drops!({ file: WITHHELD, rule: 'Overfull \\hbox' })).toBe(false);
    const keeps = makeWarningJudge(withheld, { excludeRule: ['Underfull \\vbox'] });
    expect(keeps).toBeDefined();
    expect(keeps!({ file: WITHHELD, rule: 'Overfull \\hbox' })).toBe(true);
  });

  it('holds just outside every clause', () => {
    const byFile = makeWarningJudge(withheld, { file: ['sections/intro.tex'] });
    expect(byFile).toBeDefined();
    expect(byFile!({ rule: 'LaTeX' })).toBe(false); // fileless warning, `file` clause given
    const byRule = makeWarningJudge(withheld, { rule: ['LaTeX'] });
    expect(byRule).toBeDefined();
    expect(byRule!({ file: 'a.tex' })).toBe(false); // rule-less warning, `rule` include-list given
    const byExclude = makeWarningJudge(withheld, { excludeRule: ['LaTeX'] });
    expect(byExclude).toBeDefined();
    expect(byExclude!({ file: 'a.tex' })).toBe(true); // rule-less warning is never excluded
  });

  it('behaves exactly like warningMatches when nothing was withheld', () => {
    const empty = new Set<string>();
    const filter = { file: ['sections/intro.tex'], excludeRule: ['LaTeX'] };
    const judge = makeWarningJudge(empty, filter);
    expect(judge).toBeDefined();
    for (const w of [
      { file: 'sections/intro.tex', rule: 'Overfull \\hbox' },
      { file: 'sections/intro.tex', rule: 'LaTeX' },
      { file: 'sections/other.tex', rule: 'Overfull \\hbox' },
      { rule: 'Overfull \\hbox' },
    ]) {
      expect(judge!(w)).toBe(warningMatches(w, filter));
    }
  });

  it('does not mutate the candidate it is handed', () => {
    const judge = makeWarningJudge(withheld, { rule: ['Overfull \\hbox'] });
    expect(judge).toBeDefined();
    const candidate = { file: WITHHELD, rule: 'Overfull \\hbox' };
    judge!(candidate);
    expect(candidate.file).toBe(WITHHELD);
    expect(candidate.rule).toBe('Overfull \\hbox');
  });

  it('matches exactly and literally — no prefix, glob or case folding', () => {
    const judge = makeWarningJudge(withheld, { file: ['sections/intro.tex'] });
    expect(judge).toBeDefined();
    expect(judge!({ file: 'sections/intro.tex.bak' })).toBe(false);
    expect(judge!({ file: 'Sections/intro.tex' })).toBe(false);
    expect(judge!({ file: 'sections/intro.tex' })).toBe(true);
  });
});

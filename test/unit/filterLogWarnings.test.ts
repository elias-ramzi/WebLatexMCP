import { describe, it, expect } from 'vitest';
import { filterLog, parseLog } from '../../src/services/logParser.js';

/**
 * `filterLog`'s `keepWarning` option — the half of `compile`'s `warningsFilter` that trims
 * `logTail`, in lockstep with `warnings[]`, so a box warning does not ship twice (once structured,
 * once as raw text). See `src/services/logParser.ts` and `src/lib/warningFilter.ts`.
 */

const LOG = [
  '(./main.tex',
  '(./sections/a.tex',
  'Overfull \\hbox (12.0pt too wide) in paragraph at lines 4--5',
  ')',
  '(./sections/b.tex',
  'Overfull \\hbox (5.0pt too wide) in paragraph at lines 2--3',
  ')',
  '! Undefined control sequence.',
  'l.9 \\badcommand',
  ')',
  'Output written on main.pdf (1 page, 1234 bytes).',
].join('\n');

describe('filterLog byte-identity when keepWarning is absent', () => {
  it('filterLog(log) and filterLog(log, {}) match today’s exact output', () => {
    const expected = [
      'Overfull \\hbox (12.0pt too wide) in paragraph at lines 4--5',
      'Overfull \\hbox (5.0pt too wide) in paragraph at lines 2--3',
      '! Undefined control sequence.',
      'l.9 \\badcommand',
      'Output written on main.pdf (1 page, 1234 bytes).',
    ].join('\n');
    expect(filterLog(LOG)).toBe(expected);
    expect(filterLog(LOG, {})).toBe(expected);
  });
});

describe('filterLog keepWarning', () => {
  it('drops a rejected warning rule, keeps the error and its context and the output summary', () => {
    const out = filterLog(LOG, { keepWarning: (w) => w.rule !== 'Overfull \\hbox' });
    expect(out).not.toMatch(/Overfull/);
    expect(out).toMatch(/^! Undefined control sequence\.$/m);
    expect(out).toMatch(/^l\.9 \\badcommand$/m);
    expect(out).toMatch(/^Output written on main\.pdf/m);
  });

  it('attributes a warning to the file open on the paren stack, exactly as parseLog does', () => {
    // Sanity: parseLog attributes the two box warnings to sections/a.tex and sections/b.tex.
    const { warnings } = parseLog(LOG);
    expect(warnings.map((w) => w.file)).toEqual(['sections/a.tex', 'sections/b.tex']);

    const onlyA = filterLog(LOG, { keepWarning: (w) => w.file === 'sections/a.tex' });
    const boxLines = onlyA.split('\n').filter((l) => l.startsWith('Overfull'));
    expect(boxLines).toEqual(['Overfull \\hbox (12.0pt too wide) in paragraph at lines 4--5']);
    // The error survives regardless — it is never subject to the warning filter.
    expect(onlyA).toMatch(/^! Undefined control sequence\.$/m);
  });

  it('honours baseDir, rebasing a filtered warning’s file the same way parseLog does', () => {
    const { warnings } = parseLog(LOG, { baseDir: 'paper' });
    expect(warnings.map((w) => w.file)).toEqual(['paper/sections/a.tex', 'paper/sections/b.tex']);

    const onlyA = filterLog(LOG, {
      baseDir: 'paper',
      keepWarning: (w) => w.file === 'paper/sections/a.tex',
    });
    const boxLines = onlyA.split('\n').filter((l) => l.startsWith('Overfull'));
    expect(boxLines).toEqual(['Overfull \\hbox (12.0pt too wide) in paragraph at lines 4--5']);
  });

  it('keeps a rule-less warning (a bare pdfTeX warning) under excludeRule, drops it under an include rule list', () => {
    const log = [
      'pdfTeX warning (ext4): destination with the same identifier (name{page.1}) has been used, duplicate ignored',
      'Overfull \\hbox (1.0pt too wide) in paragraph at lines 1--2',
    ].join('\n');

    const excluding = filterLog(log, { keepWarning: (w) => w.rule !== 'Overfull \\hbox' });
    expect(excluding).toMatch(/pdfTeX warning/);
    expect(excluding).not.toMatch(/Overfull/);

    const includingOnlyBox = filterLog(log, { keepWarning: (w) => w.rule === 'Overfull \\hbox' });
    expect(includingOnlyBox).not.toMatch(/pdfTeX warning/);
    expect(includingOnlyBox).toMatch(/Overfull/);
  });

  it('never filters a rerun-hint line, even though it also contains "Warning:"', () => {
    const log = 'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.';
    const out = filterLog(log, { keepWarning: () => false });
    expect(out).toContain('Rerun to get cross-references right.');
  });

  it('applies the cap after filtering, so filtering frees room instead of being crowded out', () => {
    const boxLines = Array.from(
      { length: 200 },
      (_, i) => `Overfull \\hbox (1.0pt too wide) in paragraph at lines ${i}--${i + 1}`,
    );
    const log = [
      ...boxLines,
      '! Undefined control sequence.',
      'l.5 \\bad',
      'Output written on main.pdf (1 page).',
    ].join('\n');

    const filtered = filterLog(log, {
      maxLines: 3,
      keepWarning: (w) => w.rule !== 'Overfull \\hbox',
    });
    // Had the cap been applied before the filter, the 200 box lines would still count toward it
    // and the omission note would fire even though nothing box-related survives.
    expect(filtered).not.toMatch(/omitted/);
    expect(filtered.split('\n')).toEqual([
      '! Undefined control sequence.',
      'l.5 \\bad',
      'Output written on main.pdf (1 page).',
    ]);
  });
});

describe('filterLog when a filter empties the kept set', () => {
  /**
   * The raw-tail fallback exists for a log with nothing diagnostic in it. If a *filter* is what
   * emptied the list, falling back hands the caller the unfiltered, un-de-noised tail — the very
   * warnings they excluded, plus the font/PDF-statistics noise `filterLog` exists to strip. The
   * feature exactly inverted, and silently. These two pin the branch apart.
   */
  const NOISY = [
    'This is pdfTeX, Version 3.14',
    'entering extended mode',
    '(./main.tex',
    'Overfull \\hbox (12.0pt too wide) in paragraph at lines 4--5',
    'Overfull \\hbox (7.0pt too wide) in paragraph at lines 9--10',
    ')',
    '{/usr/share/texmf/fonts/enc/pdftex.enc}</usr/share/texlive/cmr10.pfb>',
    'PDF statistics: 40 PDF objects out of 1000',
  ].join('\n');

  it('says so in one line instead of falling back to the raw tail it excluded', () => {
    const out = filterLog(NOISY, { keepWarning: () => false });
    expect(out).not.toMatch(/Overfull/);
    expect(out).not.toMatch(/\.pfb/);
    expect(out).not.toMatch(/PDF statistics/);
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toMatch(/warningsFilter/);
  });

  it('still falls back to the raw tail when the log had no diagnostic line to begin with', () => {
    const quiet = [
      'This is pdfTeX, Version 3.14',
      'entering extended mode',
      '(./main.tex',
      ')',
    ].join('\n');
    // No filter could have removed anything here — there was nothing matching KEEP_PATTERNS — so
    // the caller still gets the last raw lines rather than "your filter matched nothing".
    const out = filterLog(quiet, { keepWarning: () => false });
    expect(out).toMatch(/entering extended mode/);
    expect(out).not.toMatch(/warningsFilter/);
    expect(out).toBe(filterLog(quiet));
  });
});

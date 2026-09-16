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

describe('filterLog never filters a line parseLog calls an error', () => {
  /**
   * `parseLog` partitions error vs. warning by branch order: it tests `FILE_LINE_ERROR` first and
   * `continue`s, so a `-file-line-error` line is an ERROR whatever its message says. `filterLog`
   * partitions via `ALWAYS_KEEP_PATTERNS`, and a `-file-line-error` message carrying `Warning:`
   * (and no `Error:`) matched none of them while `isWarningLine` matched it — so the one line
   * `parseLog` reports as the error was the one line the filter dropped from the tail. The two
   * partitions must agree, or "never filters errors" is false.
   */
  const FLE_WARNING_LOG = './main.tex:12: Package foo Warning: something is badly wrong';

  it('keeps a -file-line-error line whose message says "Warning:" under a reject-everything filter', () => {
    // Why it must be kept: parseLog calls this line an error, not a warning.
    const parsed = parseLog(FLE_WARNING_LOG);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toMatchObject({
      severity: 'error',
      file: 'main.tex',
      line: 12,
      rule: 'Package foo Warning',
    });
    expect(parsed.warnings).toEqual([]);

    expect(filterLog(FLE_WARNING_LOG, { keepWarning: () => false })).toBe(FLE_WARNING_LOG);
  });

  it('keeps it under an include-filter naming some other rule, alongside the warnings that do match', () => {
    const log = [
      FLE_WARNING_LOG,
      'Overfull \\hbox (1.0pt too wide) in paragraph at lines 1--2',
      'LaTeX Font Warning: Font shape `OT1/cmr/bx/sc undefined',
    ].join('\n');
    const out = filterLog(log, { keepWarning: (w) => w.rule === 'Overfull \\hbox' });
    expect(out.split('\n')).toEqual([
      FLE_WARNING_LOG,
      'Overfull \\hbox (1.0pt too wide) in paragraph at lines 1--2',
    ]);
  });
});

describe('filterLog: a dotted or hyphenated package name is filterable like any other', () => {
  /**
   * `PACKAGE_WARNING`'s name class used to be `\w+`, which matches neither `.` nor `-`, so
   * `Package pdftex.def Warning: ...` produced no structured warning and no `rule` here — yet
   * `KEEP_PATTERNS`' literal `/Warning:/` still kept the raw line in the tail. That is exactly the
   * ships-twice asymmetry `warningsFilter` exists to remove, for one of the commonest warning
   * sources in a real log.
   */
  const LOG = [
    "Package pdftex.def Warning: Option `width' ignored for bitmap image on input line 7.",
    'Overfull \\hbox (1.0pt too wide) in paragraph at lines 1--2',
  ].join('\n');

  it('drops it from the tail under excludeRule naming it', () => {
    const out = filterLog(LOG, { keepWarning: (w) => w.rule !== 'pdftex.def' });
    expect(out).not.toMatch(/pdftex\.def/);
    expect(out).toMatch(/Overfull/);
  });

  it('keeps only it under an include-filter naming it', () => {
    const out = filterLog(LOG, { keepWarning: (w) => w.rule === 'pdftex.def' });
    expect(out).toMatch(/pdftex\.def/);
    expect(out).not.toMatch(/Overfull/);
  });

  it('agrees with parseLog about the rule', () => {
    expect(parseLog(LOG).warnings.map((w) => w.rule)).toEqual(['pdftex.def', 'Overfull \\hbox']);
  });
});

describe('filterLog never filters a rerun hint, including biblatex’s phrasing', () => {
  /**
   * biblatex asks for a rerun as `Please (re)run Biber on the file:` — the literal parentheses mean
   * the `Please rerun` pattern does not match it. On a biblatex paper that line is the only thing
   * telling the caller their bibliography is stale, and a filter narrowed to box warnings dropped
   * it.
   */
  it('keeps the "Please (re)run Biber" line under a reject-everything filter', () => {
    const log = [
      'Package biblatex Warning: Please (re)run Biber on the file:',
      '(biblatex)                and rerun LaTeX afterwards.',
      'Overfull \\hbox (1.0pt too wide) in paragraph at lines 1--2',
    ].join('\n');
    const out = filterLog(log, { keepWarning: () => false });
    expect(out).toContain('Please (re)run Biber on the file:');
    expect(out).not.toMatch(/Overfull/);
  });

  it('keeps it under an include-filter that names only box warnings', () => {
    const log = [
      'Package biblatex Warning: Please (re)run Biber on the file:',
      'Overfull \\hbox (1.0pt too wide) in paragraph at lines 1--2',
    ].join('\n');
    const out = filterLog(log, { keepWarning: (w) => w.rule === 'Overfull \\hbox' });
    expect(out.split('\n')).toEqual([
      'Package biblatex Warning: Please (re)run Biber on the file:',
      'Overfull \\hbox (1.0pt too wide) in paragraph at lines 1--2',
    ]);
  });
});

/**
 * The differential characterization the feature's claim rests on: **with no `keepWarning`,
 * `filterLog`'s output is byte-identical to what it always produced.** One hand-written 11-line log
 * cannot carry that claim — it never reaches the `maxLines` cap, the omission header, or the
 * raw-tail fallback — so this pins it over thousands of generated logs instead.
 *
 * Two equivalences are pinned, both of which need **no reference implementation**. Re-deriving
 * `KEEP_PATTERNS`/`unwrapLines`/`logTail` in the test would make this layer structurally unable to
 * catch a regression in them (CLAUDE.md's `String.prototype.replace` incident), so the test only
 * ever compares `filterLog` against itself under options that must not matter:
 *
 * 1. `{ maxLines }` === `{ maxLines, baseDir }` — `baseDir` is inert without `keepWarning`, since
 *    the only thing it rebases is a filtered warning's `file`.
 * 2. `{ maxLines }` === `{ maxLines, keepWarning: () => true }` — **a filter that accepts
 *    everything is a no-op.** This is the strong form: (1) only re-walks the bypass path, whereas
 *    (2) drives the whole `keepWarning` machinery — `scanParens`/`currentFile` bookkeeping,
 *    `ALWAYS_KEEP_PATTERNS`, `isWarningLine`, `warningRuleOf`, the `matchedBeforeFilter` counter —
 *    and demands that it reproduce the legacy output byte for byte. Any of that machinery
 *    perturbing a line, an order, the cap accounting or the fallback branch shows up here.
 *
 * What it deliberately does NOT reach: it is insensitive to how lines are *classified*, because a
 * predicate returning `true` keeps a line whichever side of the warning/always-keep partition it
 * lands on. The partition itself is pinned by the hand-written cases above.
 */
describe('filterLog differential: legacy output is byte-identical without a filter', () => {
  /** pdfTeX/latexmk hard-wrap column — a fragment of exactly this length exercises `unwrapLines`. */
  const WRAP_WIDTH = 79;

  /** Exactly 79 chars, so `unwrapLines` glues it to whatever follows. Length pinned below. */
  const WRAPPED_LINE = '(/usr/share/texlive/texmf-dist/tex/latex/pgf/frontendlayer/tikz/libraries'
    .padEnd(WRAP_WIDTH, 'x')
    .slice(0, WRAP_WIDTH);

  /** Lines that reach a `KEEP_PATTERNS` branch, plus the paren/context bookkeeping around them. */
  const DIAGNOSTIC_FRAGMENTS = [
    '(./main.tex',
    '(./sections/intro.tex',
    '(./sections/method.tex',
    ')',
    '))',
    'Overfull \\hbox (12.34pt too wide) in paragraph at lines 4--5',
    'Underfull \\vbox (badness 10000) has occurred while \\output is active',
    'Overfull \\hbox (1.0pt too wide) in paragraph at lines 1--2   ', // trailing whitespace
    '! Undefined control sequence.',
    "! LaTeX Error: File `fontawesome.sty' not found.",
    'l.12 \\badcommand',
    'l.7 ',
    "LaTeX Warning: Reference `fig:missing' on page 1 undefined on input line 42.",
    'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.',
    'LaTeX Warning: There were undefined references.\t ', // trailing whitespace
    "LaTeX Font Warning: Font shape `OT1/cmr/bx/sc' undefined on input line 9.",
    'pdfTeX warning (ext4): destination with the same identifier (name{page.1}) has been used',
    'Package hyperref Warning: Token not allowed in a PDF string.',
    'Class article Warning: Unused global option(s): [foo].',
    'Emergency stop.',
    'No pages of output.',
    'Runaway argument?',
    // The two lines Tasks 1 and 2 above added to ALWAYS_KEEP_PATTERNS.
    './main.tex:12: Package foo Warning: something is badly wrong',
    './sections/method.tex:88: Undefined control sequence.',
    'Package biblatex Warning: Please (re)run Biber on the file:',
    '(biblatex)                and rerun LaTeX afterwards.',
    'Output written on main.pdf (12 pages, 345678 bytes).',
    '',
    WRAPPED_LINE,
  ];

  /** Lines `filterLog` exists to strip — a log made only of these must hit the raw-tail fallback. */
  const NOISE_FRAGMENTS = [
    'This is pdfTeX, Version 3.141592653-2.6-1.40.24 (TeX Live 2022)',
    'entering extended mode',
    '{/usr/share/texmf-dist/fonts/enc/dvips/base/8r.enc}',
    '</usr/share/texlive/texmf-dist/fonts/type1/public/amsfonts/cm/cmr10.pfb>',
    'PDF statistics: 40 PDF objects out of 1000 (max. 8388607)',
    "LaTeX Font Info:    Font shape `OT1/cmr/bx/n' will be used on input line 3.",
    'Package: hyperref 2022-02-21 v7.00n Hypertext links for LaTeX',
    '  ',
    '',
  ];

  /**
   * A seeded LCG — no `Math.random`, no dependency. A flaky differential test is worse than none,
   * so every run generates the same logs. `Math.imul` keeps the multiply exact in 32 bits (the
   * plain `*` overflows 2^53 and silently rounds); the high bits are used for selection, since an
   * LCG's low bits cycle far too short.
   */
  function makeRandom(seed: number): (n: number) => number {
    let state = seed & 0x7fffffff;
    return (n: number) => {
      state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
      return (state >>> 8) % n;
    };
  }

  const MAX_LINES_CHOICES = [1, 2, 3, 5, 15, 80];
  const ITERATIONS = 3000;

  it('pins that the 79-column fragment really is wrap width (else unwrapLines goes untested)', () => {
    expect(WRAPPED_LINE).toHaveLength(WRAP_WIDTH);
  });

  it(`reproduces the legacy output for ${ITERATIONS} generated logs, with and without an accept-everything filter`, () => {
    const rand = makeRandom(20240917);
    const mismatches: string[] = [];
    let cappedLogs = 0;
    let fallbackLogs = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      // Every eighth log is pure noise, so the `kept.length === 0` raw-tail fallback is reached.
      const noiseOnly = rand(8) === 0;
      const pool = noiseOnly ? NOISE_FRAGMENTS : [...DIAGNOSTIC_FRAGMENTS, ...NOISE_FRAGMENTS];
      const lineCount = rand(40);
      const lines: string[] = [];
      for (let j = 0; j < lineCount; j++) lines.push(pool[rand(pool.length)] as string);
      const log = lines.join('\n');
      const maxLines = MAX_LINES_CHOICES[rand(MAX_LINES_CHOICES.length)] as number;

      const legacy = filterLog(log, { maxLines });
      const withBaseDir = filterLog(log, { maxLines, baseDir: 'paper' });
      const acceptEverything = filterLog(log, { maxLines, keepWarning: () => true });

      if (withBaseDir !== legacy) {
        mismatches.push(
          `baseDir changed the output at iteration ${i} (maxLines=${maxLines})\n` +
            `log: ${JSON.stringify(log)}\n` +
            `without baseDir: ${JSON.stringify(legacy)}\n` +
            `with baseDir:    ${JSON.stringify(withBaseDir)}`,
        );
      }
      if (acceptEverything !== legacy) {
        mismatches.push(
          `keepWarning: () => true was not a no-op at iteration ${i} (maxLines=${maxLines})\n` +
            `log: ${JSON.stringify(log)}\n` +
            `no filter:          ${JSON.stringify(legacy)}\n` +
            `accept-everything:  ${JSON.stringify(acceptEverything)}`,
        );
      }

      // Branch-coverage counters, asserted below so the generator cannot silently stop reaching
      // the two branches the single hand-written log never did. "PDF statistics" matches no
      // KEEP_PATTERN, so it can only appear in the output via the raw-tail fallback.
      if (legacy.includes('earlier diagnostic line(s) omitted')) cappedLogs++;
      if (legacy.includes('PDF statistics')) fallbackLogs++;
    }

    expect(mismatches.slice(0, 3).join('\n\n')).toBe('');
    expect(mismatches).toHaveLength(0);
    expect(cappedLogs).toBeGreaterThan(0);
    expect(fallbackLogs).toBeGreaterThan(0);
  });
});

describe('filterLog: no filter ever removes a non-warning line the de-noiser kept', () => {
  /**
   * The general form of the `-file-line-error` bug above, and the invariant `warningsFilter`'s
   * whole contract rests on: "never filters errors".
   *
   * `parseLog` and `filterLog` partition error-vs-warning by two independent mechanisms — branch
   * order there, `ALWAYS_KEEP_PATTERNS` versus `isWarningLine` here — and nothing makes them agree
   * by construction. They agreed by coincidence until a `-file-line-error` line carrying `Warning:`
   * fell down the wrong side. This pins the partition itself rather than that one line, so a future
   * `KEEP_PATTERNS` entry that is neither always-kept nor a warning is caught here.
   *
   * Note the conditional form. It is deliberately NOT "every error appears in the tail": a
   * `-file-line-error` line with no `Error:`/`Warning:` in its message matches no `KEEP_PATTERN` at
   * all, so the de-noiser drops it whether or not a filter is set (a real, pre-existing gap, out of
   * scope here — fixing it would break the byte-identity guarantee). What must hold is the weaker,
   * exactly-right claim: whatever the unfiltered tail kept, a filter must not take away.
   *
   * The corpus is `NEVER_FILTERABLE_LINES`, not "error lines": most are errors, but `Runaway
   * argument?` and `No pages of output.` are context/summary lines `parseLog` reports as neither
   * error nor warning. They belong here all the same — the guard is about what a warning filter may
   * take away, and the answer for a non-warning line is nothing — but naming them errors would be
   * wrong.
   */
  const NEVER_FILTERABLE_LINES = [
    '! Undefined control sequence.',
    "! LaTeX Error: File `nope.sty' not found.",
    '! Package foo Error: Warning: tricky — an error whose message says "Warning:".',
    '! Emergency stop.',
    '! TeX capacity exceeded, sorry [main memory size=5000000].',
    '! Missing $ inserted.',
    './main.tex:12: Package foo Warning: something is badly wrong',
    "./main.tex:7: LaTeX Error: File `nope.sty' not found.",
    'Runaway argument?',
    'No pages of output.',
  ];

  const BOX = 'Overfull \\hbox (1.0pt too wide) in paragraph at lines 1--2';

  it.each(NEVER_FILTERABLE_LINES)(
    'keeps %j under every filter that keeps it unfiltered',
    (errorLine) => {
      const log = ['(./main.tex', errorLine, BOX, ')'].join('\n');
      const unfiltered = filterLog(log);
      if (!unfiltered.includes(errorLine)) return; // de-noiser never kept it; nothing to preserve

      for (const keepWarning of [
        () => false,
        (w: { rule?: string }) => w.rule === 'Overfull \\hbox',
        (w: { rule?: string }) => w.rule === 'no-such-rule',
        (w: { file?: string }) => w.file === 'no-such-file.tex',
      ]) {
        expect(
          filterLog(log, { keepWarning }),
          `a warningsFilter removed ${JSON.stringify(errorLine)}, which the unfiltered tail kept ` +
            '— warningsFilter must never filter a non-warning line',
        ).toContain(errorLine);
      }
    },
  );

  it('counts how many of the corpus the de-noiser keeps, so the guard above cannot go vacuous', () => {
    // If a KEEP_PATTERNS change ever drops these lines from the tail entirely, every case above
    // would early-return and pass while testing nothing. Pin the count so that fails loudly.
    const kept = NEVER_FILTERABLE_LINES.filter((line) =>
      filterLog(['(./main.tex', line, BOX, ')'].join('\n')).includes(line),
    );
    expect(kept).toHaveLength(NEVER_FILTERABLE_LINES.length);
  });
});

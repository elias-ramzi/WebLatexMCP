import { createHash } from 'node:crypto';
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

describe('filterLog: a document-forged "(re)run" substring is not an always-keep pin', () => {
  /**
   * The log is document-controlled — a `.tex` can emit arbitrary text via `\PackageWarning` or
   * `\typeout` — so an always-keep pattern matched on a bare substring lets a document pin any line
   * past a caller's `warningsFilter` simply by including that substring. The rerun-hint pattern used
   * to be a bare, unanchored `/\(re\)run/`, so an `Overfull \hbox` line that merely happens to
   * contain the literal text "(re)run" survived every filter, indistinguishable from biblatex's real
   * `Please (re)run Biber on the file:` hint. Narrowed to `/Please \(re\)run/`, which still matches
   * biblatex's real phrasing (see the describe block above) but no longer matches an unrelated line
   * that merely contains the literal `(re)run`.
   */
  it('filters an Overfull hbox line that merely contains "(re)run", not a real rerun hint', () => {
    const log = 'Overfull \\hbox (re)run (12.0pt too wide) in paragraph at lines 4--5';
    const out = filterLog(log, { keepWarning: (w) => w.rule !== 'Overfull \\hbox' });
    expect(out).not.toContain(log);
  });
});

/**
 * Two separate claims, proven two separate ways. They used to share one describe title and one
 * doc comment claiming "byte-identical to before" — which only the second claim below actually
 * proves; the first is real but narrower, and conflating them let a real regression hide behind a
 * test that read as though it covered more than it did.
 *
 * 1. **Option-insensitivity** (the self-comparison loop): `baseDir` and an accept-everything
 *    `keepWarning` must be complete no-ops on `filterLog`'s output. This needs **no reference
 *    implementation** — re-deriving `KEEP_PATTERNS`/`unwrapLines`/`logTail` in the test would make
 *    this layer structurally unable to catch a regression in them (CLAUDE.md's
 *    `String.prototype.replace` incident) — so it only ever compares `filterLog` against *itself*
 *    under options that must not matter:
 *      a. `{ maxLines }` === `{ maxLines, baseDir }` — `baseDir` is inert without `keepWarning`,
 *         since the only thing it rebases is a filtered warning's `file`.
 *      b. `{ maxLines }` === `{ maxLines, keepWarning: () => true }` — **a filter that accepts
 *         everything is a no-op.** The strong form: (a) only re-walks the bypass path, whereas (b)
 *         drives the whole `keepWarning` machinery — `scanParens`/`currentFile` bookkeeping,
 *         `ALWAYS_KEEP_PATTERNS`, `isWarningLine`, `warningRuleOf`, the `matchedBeforeFilter`
 *         counter — and demands it reproduce the legacy output byte for byte.
 *    What this half deliberately does NOT reach: it is insensitive to how lines are *classified*
 *    (a predicate returning `true` keeps a line whichever side of the warning/always-keep
 *    partition it lands on — the partition itself is pinned by the hand-written cases above), and
 *    it is blind to anything that perturbs both sides of a comparison identically. Deleting a
 *    `KEEP_PATTERNS` entry, for instance, changes `legacy` and `acceptEverything` the same way, so
 *    the two stay equal to each other while both silently stop matching lines they used to — this
 *    is not a hypothetical, it is a mutant that was run and left every self-comparison here green.
 *
 * 2. **Byte-identity against regression** (the golden digest): this is what the first half
 *    structurally cannot prove, since there is nothing else in this file to compare `filterLog`
 *    against. The digest hashes `filterLog`'s output across thousands of generated logs, at every
 *    `maxLines` choice, and pins it to a committed constant — so a `KEEP_PATTERNS`/`unwrapLines`/
 *    cap-or-fallback regression invisible to (1) shows up here as a changed hash.
 *
 * Both halves share the same generated corpus (below); keep the two claims straight when reading
 * or editing it.
 */
describe('filterLog differential: option-insensitivity, plus a golden digest against regression', () => {
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
    // Leading whitespace, unlike the trailing-whitespace fragments above: `Warning:` is unanchored,
    // so this reaches KEEP_PATTERNS either way, but the *kept text* differs between a correct
    // trailing-only trim (leading spaces survive into the output) and a buggy full `trim()` (they
    // don't) — a divergence a trailing-whitespace-only corpus can never exercise.
    '  Package hyperref Warning: indented package warning line, kept regardless of the indent',
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
    // Indented, as a real continuation of a `LaTeX Font Info:` block reads on the wire. Matches no
    // KEEP_PATTERNS entry with or without the indent, so it stays noise either way — a control
    // fragment confirming indentation alone never smuggles a noise line past the filter.
    "  LaTeX Font Info:    Font shape `OT1/cmr/bx/sc' will be used on input line 11.",
    'Package: hyperref 2022-02-21 v7.00n Hypertext links for LaTeX',
    // A leading space breaks the *anchored* `^(Overfull|Underfull) \\[hv]box` pattern, so this is
    // correctly noise under a trailing-only trim. A buggy full `trim()` (applied only on the
    // `keepWarning` path) strips the leading space first and wrongly revives it as a kept box
    // warning — this is what actually made mutant 2 ("keepWarning ? raw.trim() : …") pass all 26
    // tests before this fragment existed: nothing in the corpus had leading whitespace in front of
    // an otherwise-anchored pattern, so the bug never had a line to misclassify.
    ' Overfull \\hbox (3.0pt too wide) in paragraph at lines 10--11',
    // Same idea with a leading tab in front of the anchored `^l\.\d+` context-line pattern.
    '\tl.12 \\badcommand',
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

  /**
   * Committed digest of `filterLog`'s output across every generated log below, at every
   * `maxLines` choice in {@link MAX_LINES_CHOICES} — the thing that actually pins byte-identity
   * against regression (see claim 2 in the doc comment above this describe block; claim 1, the
   * self-comparison, structurally cannot: it is blind to a change that perturbs both sides of the
   * comparison identically).
   *
   * If this test fails: `filterLog`'s unfiltered `logTail` output changed for every compile of
   * every session. Confirm the change is intentional, then update this constant to the digest the
   * failure message prints.
   */
  const GOLDEN_DIGEST = '8ee6dde04f4a1f938b986dac2542f42de0c710cc12c9ef3b7b50aed202b37474';

  it('pins that the 79-column fragment really is wrap width (else unwrapLines goes untested)', () => {
    expect(WRAPPED_LINE).toHaveLength(WRAP_WIDTH);
  });

  it(
    `is option-insensitive to baseDir/accept-everything over ${ITERATIONS} generated logs, and ` +
      `matches a committed digest at every maxLines choice`,
    () => {
      const rand = makeRandom(20240917);
      const mismatches: string[] = [];
      const hash = createHash('sha256');
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

        // The golden digest: every maxLines choice for this log, not just the one drawn above —
        // "across all iterations and maxLines values", so a cap/fallback regression that only
        // shows up at one particular maxLines cannot hide behind the others. A NUL separator
        // between entries (and after each) keeps concatenation unambiguous; log/tail content is
        // plain diagnostic text and never contains one. Written as the escape `\0`, never as a raw
        // NUL byte in this source: a literal one makes git and grep classify this whole file as
        // BINARY, which silently swallows every match and every diff hunk in it.
        for (const m of MAX_LINES_CHOICES) {
          hash.update(filterLog(log, { maxLines: m }));
          hash.update('\0');
        }
      }

      expect(mismatches.slice(0, 3).join('\n\n')).toBe('');
      expect(mismatches).toHaveLength(0);
      expect(cappedLogs).toBeGreaterThan(0);
      expect(fallbackLogs).toBeGreaterThan(0);

      const digest = hash.digest('hex');
      expect(
        digest,
        `filterLog's output changed across ${ITERATIONS} generated logs × maxLines ` +
          `${JSON.stringify(MAX_LINES_CHOICES)}. This digest changing means unfiltered logTail ` +
          'changed for every compile of every session. If you did not edit the corpus fragments in ' +
          'this file, that is a REGRESSION, not a corpus edit — do not simply update the ' +
          `constant. Once the change is confirmed intentional, set GOLDEN_DIGEST to ${digest}.`,
      ).toBe(GOLDEN_DIGEST);
    },
  );
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

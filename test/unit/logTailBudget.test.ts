import { describe, it, expect } from 'vitest';
import {
  filterLog,
  fitFilteredLog,
  parseLog,
  LOG_TAIL_LINE_CAP,
} from '../../src/services/logParser.js';
import { makeWarningJudge } from '../../src/lib/warningFilter.js';

/**
 * `logTail` is a document-controlled payload, and until this file it was bounded in LINES only.
 *
 * `filterLog` keeps 80 lines, but each is a LOGICAL line — `unwrapLines` rejoins TeX's 79-column
 * hard wrap — so a line has no length limit at all: a `\PackageWarning` with a 5000-character
 * message is one kept line of 5000 characters, and 80 of them made a ~400k-character `logTail`
 * that went straight into `structuredContent` (the #68 shape: a result a client rejects
 * undelivered).
 */

const NL = '\n';

describe('filterLog: every kept line is capped in characters', () => {
  it('bounds 80 very long warnings instead of shipping ~400k characters', () => {
    const long = 'x'.repeat(5000);
    const log = [
      '(./main.tex',
      ...Array.from({ length: 80 }, (_, i) => `Package foo Warning: ${long}${i}`),
      ')',
    ].join(NL);

    const out = filterLog(log);
    // Pre-fix: 401,909 characters.
    expect(out.length).toBeLessThan(80 * 600);
    for (const line of out.split(NL)) expect(line.length).toBeLessThanOrEqual(600);
    // Cut, never cut silently: the line says how much went and where the rest is.
    expect(out).toMatch(/more characters — see logPath\]/);
  });

  it('caps one warning TeX wrapped over hundreds of physical lines', () => {
    const msg = 'Package foo Warning: ' + 'y'.repeat(20000);
    const physical = Array.from({ length: Math.ceil(msg.length / 79) }, (_, k) =>
      msg.slice(k * 79, k * 79 + 79),
    );
    const out = filterLog(['(./main.tex', ...physical, ')'].join(NL));
    // Pre-fix: the rejoined 20,021-character line, whole.
    expect(out.length).toBeLessThan(600);
    expect(out.startsWith('Package foo Warning: yyy')).toBe(true);
  });

  it('caps a raw-tail fallback line too', () => {
    // Nothing diagnostic, so filterLog falls back to the raw tail — whose lines are PHYSICAL, but a
    // log written with a huge max_print_line (common advice for readable logs) has no wrap at all.
    const out = filterLog(['This is pdfTeX', 'z'.repeat(30000)].join(NL));
    expect(out.length).toBeLessThan(600);
    expect(out.startsWith('This is pdfTeX')).toBe(true);
  });

  it('leaves a line of exactly the cap byte-identical, and cuts one character more', () => {
    const at = 'Package foo Warning: '.padEnd(LOG_TAIL_LINE_CAP, 'a');
    expect(filterLog(at)).toBe(at);
    const over = at + 'b';
    expect(filterLog(over)).toBe(`${at} … [1 more characters — see logPath]`);
  });

  it('never cuts inside a surrogate pair', () => {
    // The cap lands between the halves of an emoji: back off one, never ship half of it.
    const line = 'Package foo Warning: '.padEnd(LOG_TAIL_LINE_CAP - 1, 'a') + '😀'.repeat(50);
    const out = filterLog(line);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(out.startsWith(line.slice(0, LOG_TAIL_LINE_CAP - 1) + ' …')).toBe(true);
  });
});

describe('fitFilteredLog: the whole tail fitted to a character budget', () => {
  const lines = Array.from(
    { length: 80 },
    (_, i) => `Overfull \\hbox (${i}.0pt too wide) in paragraph at lines ${i}--${i + 1}`,
  );
  const log = ['(./main.tex', ...lines, ')', 'Output written on main.pdf (1 page, 10 bytes).'].join(
    NL,
  );

  it('is filterLog exactly when the budget is unbounded', () => {
    expect(fitFilteredLog(log, { maxChars: Infinity })).toEqual({
      text: filterLog(log),
      trimmed: 0,
    });
    expect(fitFilteredLog(log, { maxChars: 1_000_000, maxLines: 5 })).toEqual({
      text: filterLog(log, { maxLines: 5 }),
      trimmed: 0,
    });
  });

  it('fits the JSON rendering, keeps the latest lines, and counts both bounds in one header', () => {
    const maxChars = 1000;
    const { text, trimmed } = fitFilteredLog(log, { maxChars, maxLines: 60 });
    expect(JSON.stringify(text).length).toBeLessThanOrEqual(maxChars);
    expect(trimmed).toBeGreaterThan(0);
    const out = text.split(NL);
    // The most recent line survives — the output summary is where a reader looks first.
    expect(out.at(-1)).toBe('Output written on main.pdf (1 page, 10 bytes).');
    // 81 kept lines, 60 shown by maxLines, `trimmed` more by maxChars: one header for all of it.
    expect(out[0]).toBe(
      `… (${81 - 60 + trimmed} earlier diagnostic line(s) omitted — see logPath for the full log)`,
    );
    expect(out).toHaveLength(60 - trimmed + 1);
    // Tight, not merely under: one more line would not have fit.
    const oneMore = fitFilteredLog(log, {
      maxChars: JSON.stringify(text).length - 1,
      maxLines: 60,
    });
    expect(oneMore.trimmed).toBeGreaterThan(trimmed);
  });

  it('keeps the last line even when nothing fits', () => {
    const { text } = fitFilteredLog(log, { maxChars: 0 });
    expect(text.split(NL).at(-1)).toBe('Output written on main.pdf (1 page, 10 bytes).');
    expect(text.split(NL)).toHaveLength(2);
  });

  it('fits the raw-tail fallback the same way', () => {
    const noise = Array.from({ length: 15 }, (_, i) =>
      `entering extended mode ${i}`.padEnd(70, '.'),
    );
    const { text, trimmed } = fitFilteredLog(noise.join(NL), { maxChars: 400 });
    expect(JSON.stringify(text).length).toBeLessThanOrEqual(400);
    expect(trimmed).toBeGreaterThan(0);
    expect(text.split(NL)[0]).toMatch(/^… \(\d+ earlier raw log line\(s\) omitted/);
    expect(text.endsWith(noise.at(-1)!)).toBe(true);
  });
});

describe('filterLog: a warning whose message merely says "Error:" is filterable like any other', () => {
  /**
   * `ALWAYS_KEEP_PATTERNS` used to carry an unanchored `/Error:/`, so a line `parseLog` structures
   * as a WARNING was pinned in the tail whenever its free-text message contained "Error:". The
   * filter then dropped it from `warnings[]` and kept it in `logTail` — the two partitions
   * disagreeing about one line, which is the asymmetry `warningsFilter` exists to remove.
   */
  it('drops it from logTail exactly when it drops it from warnings[]', () => {
    const line = 'Package foo Warning: Error: this is only a warning on input line 3.';
    const log = ['(./main.tex', line, ')', 'Output written on main.pdf (1 page, 10 bytes).'].join(
      NL,
    );
    const judge = makeWarningJudge(new Set(), { excludeRule: ['foo'] });
    expect(judge).toBeDefined();

    const parsed = parseLog(log);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.warnings.map((w) => w.rule)).toEqual(['foo']);
    expect(parsed.warnings.filter(judge!)).toHaveLength(0);

    const out = filterLog(log, { keepWarning: judge });
    expect(out).not.toContain(line);
    expect(out).toContain('Output written on main.pdf');
  });

  it('does the same for an error-SHAPED prefix carrying a warning parseLog structures', () => {
    // A document can print anything (`\typeout`). parseLog calls this a "LaTeX"-rule warning —
    // PACKAGE_WARNING is unanchored — so a pin on the leading `Package foo Error:` would put it
    // back on the wrong side of the partition.
    const line = 'Package foo Error: see LaTeX Warning: forged on input line 3.';
    const log = ['(./main.tex', line, ')'].join(NL);
    const judge = makeWarningJudge(new Set(), { excludeRule: ['LaTeX'] });

    const parsed = parseLog(log);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.warnings.map((w) => w.rule)).toEqual(['LaTeX']);
    expect(parsed.warnings.filter(judge!)).toHaveLength(0);
    expect(filterLog(log, { keepWarning: judge })).not.toContain(line);
  });

  it('still pins a bare error-shaped line parseLog does NOT call a warning', () => {
    // A preservation pin, not a regression test — it passed before this change too, when the
    // unanchored `/Error:/` pinned everything. It is here because BARE_ERROR_LINE is built with
    // `new RegExp` around a lookahead, and a construction that matched nothing at all would pass
    // both tests above while silently turning this line into a filterable warning.
    const line = 'Package foo Error: see LaTeX Font Warning: font shape undefined.';
    const log = ['(./main.tex', line, ')'].join(NL);
    const parsed = parseLog(log);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.warnings).toHaveLength(0);
    expect(filterLog(log, { keepWarning: () => false })).toBe(line);
  });
});

describe('fitFilteredLog: the kept last line is fitted on its RENDERED size', () => {
  /**
   * The last line is always kept, and `LOG_TAIL_LINE_CAP` bounds it in CHARACTERS — but a control
   * character renders as a six-character `\u00XX` escape in JSON, so a capped line could still cost
   * ~3.3k rendered. The tail then overshot its allowance and the warnings lane, fitted after it,
   * got nothing: the budget had been charged the line's length while `structuredContent` shipped
   * six times that.
   */
  const ctl = 'Package foo Warning: ' + '\u0001'.repeat(2000);
  const log = [
    '(./main.tex',
    'Overfull \\hbox (1.0pt too wide) in paragraph at lines 1--2',
    ctl,
    ')',
  ].join(NL);

  it('cuts a control-character-heavy last line until the JSON rendering fits', () => {
    const maxChars = 1000;
    const { text, trimmed } = fitFilteredLog(log, { maxChars });
    // Pre-fix: ~3.1k — the 500-character cap, at six rendered characters each.
    expect(JSON.stringify(text).length).toBeLessThanOrEqual(maxChars);
    expect(trimmed).toBe(1);
    const last = text.split(NL).at(-1)!;
    expect(last.startsWith('Package foo Warning: \u0001')).toBe(true);
    // Still a cut that says so, counted against the ORIGINAL line, not against the capped one.
    const m = /^(.*) … \[(\d+) more characters — see logPath\]$/su.exec(last);
    expect(m).not.toBeNull();
    expect(m![1]!.length + Number(m![2])).toBe(ctl.length);
    // Tight: the longest keep that fits, not merely one that does.
    const kept = m![1]!.length;
    const header = text.split(NL)[0]!;
    const longer = `${ctl.slice(0, kept + 1)} … [${ctl.length - kept - 1} more characters — see logPath]`;
    expect(JSON.stringify([header, longer].join(NL)).length).toBeGreaterThan(maxChars);
  });

  it('still keeps a readable head of the line when nothing fits', () => {
    const { text } = fitFilteredLog(log, { maxChars: 0 });
    const last = text.split(NL).at(-1)!;
    expect(last.startsWith('Package foo Warning: \u0001')).toBe(true);
    // Bounded well under the 500-character cap's ~3.1k rendered...
    expect(JSON.stringify(text).length).toBeLessThan(1000);
    // ...but not cut to nothing: which package, and the start of the message, survive.
    expect(last.indexOf(' … [')).toBeGreaterThanOrEqual(40);
  });

  it('never splits a surrogate pair when it cuts further', () => {
    const astral = 'Package foo Warning: ' + '😀'.repeat(400);
    for (const maxChars of [300, 301, 302, 303]) {
      const { text } = fitFilteredLog(astral, { maxChars });
      expect(JSON.stringify(text).length).toBeLessThanOrEqual(maxChars);
      expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
      expect(text).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
    }
  });

  it('leaves a last line that fits exactly as filterLog has it', () => {
    const { text } = fitFilteredLog(log, { maxChars: 1_000_000 });
    expect(text).toBe(filterLog(log));
  });
});

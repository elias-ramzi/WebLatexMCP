import { describe, it, expect } from 'vitest';
import {
  planDiagnosticsPayload,
  renderErrorLines,
  textPrintedErrors,
  ALLOCATION_ORDER,
  DIAGNOSTICS_CONTENT_BUDGET,
  DIAGNOSTICS_MAX_ERRORS,
  DIAGNOSTICS_MAX_WARNINGS,
  DIAGNOSTICS_NOTE_RESERVE,
  MAX_TEXT_ERRORS,
} from '../../src/lib/diagnosticsBudget.js';

/**
 * The `compile` diagnostics budget (issue #162).
 *
 * The planner is pure, so everything here is plain data. The one thing every assertion is measured
 * against is the JSON of the very objects the tool hands to `structuredContent` plus the text it
 * renders beside them — charging anything else is how a budget passes its own tests and still
 * ships a result a client rejects.
 */

interface Err {
  severity: 'error';
  file?: string;
  line?: number;
  message: string;
  rule?: string;
  snippet?: string;
  snippetStartLine?: number;
}

interface Warn {
  severity: 'warning';
  file?: string;
  line?: number;
  message: string;
  rule?: string;
}

function err(i: number, opts: { snippet?: boolean; message?: string } = {}): Err {
  const e: Err = {
    severity: 'error',
    file: `sections/chapter${i % 7}.tex`,
    line: 100 + i,
    message: opts.message ?? `Undefined control sequence \\macro${i}.`,
    rule: 'Undefined control sequence',
  };
  if (opts.snippet) {
    e.snippet = Array.from({ length: 5 }, (_, k) => `\\textbf{line ${i + k} of the source}`).join(
      '\n',
    );
    e.snippetStartLine = 98 + i;
  }
  return e;
}

function warn(i: number): Warn {
  return {
    severity: 'warning',
    file: `sections/chapter${i % 7}.tex`,
    line: 10 + i,
    message: `Overfull \\hbox (${i}.0pt too wide) in paragraph at lines ${i}--${i + 1}`,
    rule: 'Overfull \\hbox',
  };
}

/** Exactly what the tool ships, in both channels: the two JSON arrays plus the rendered text. */
function renderedChars(plan: {
  errors: unknown[];
  warnings: unknown[];
  errorLines: string;
  note?: string;
}): number {
  return (
    JSON.stringify(plan.errors).length +
    JSON.stringify(plan.warnings).length +
    plan.errorLines.length +
    // The note ships in structuredContent AND is rendered into the result text.
    (plan.note ? 2 * plan.note.length : 0)
  );
}

describe('diagnostics budget: nothing to cut', () => {
  it('passes a small result through untouched, with no note and no counters', () => {
    const errors = [err(1, { snippet: true }), err(2)];
    const warnings = [warn(1), warn(2), warn(3)];
    const plan = planDiagnosticsPayload(errors, warnings);

    expect(plan.errors).toEqual(errors);
    expect(plan.warnings).toEqual(warnings);
    expect(plan.errorsOmittedByCap).toBe(0);
    expect(plan.warningsOmittedByCap).toBe(0);
    expect(plan.note).toBeUndefined();
    // The very objects the tool will send, not copies of them: the charge is measured on these.
    expect(plan.errors[0]).toBe(errors[0]);
    expect(plan.warnings[2]).toBe(warnings[2]);
  });

  it('renders the text channel exactly as the tool used to, snippet included', () => {
    const errors = [err(1, { snippet: true }), err(2)];
    const plan = planDiagnosticsPayload(errors, []);
    expect(plan.errorLines).toBe(renderErrorLines(errors));
    expect(plan.errorLines).toContain('sections/chapter1.tex:101 Undefined control sequence');
    expect(plan.errorLines).toContain('> 101 | \\textbf{line 3 of the source}');
    expect(plan.errorsInText).toBe(2);
  });
});

describe('diagnostics budget: a warning-heavy successful build', () => {
  const warnings = Array.from({ length: 1500 }, (_, i) => warn(i));

  it('is unbounded without the planner — the defect #162 reports', () => {
    // Pre-fix this array went into structuredContent as it stands. Pinned so the fixture cannot
    // quietly shrink below the size that makes this test meaningful.
    expect(JSON.stringify(warnings).length).toBeGreaterThan(150_000);
  });

  it('bounds the result and counts what it cut', () => {
    const plan = planDiagnosticsPayload([], warnings);

    expect(renderedChars(plan)).toBeLessThanOrEqual(DIAGNOSTICS_CONTENT_BUDGET);
    // On an ordinary box-warning log it is the CHARACTER budget that bites, well before the
    // 200-warning count cap — which is the claim the module's header makes about the two bounds.
    expect(plan.warnings.length).toBeLessThan(DIAGNOSTICS_MAX_WARNINGS);
    expect(plan.warningsOmittedByCap).toBe(1500 - plan.warnings.length);
    // total = shown + omitted, always.
    expect(plan.warnings.length + plan.warningsOmittedByCap).toBe(warnings.length);
    expect(plan.note).toMatch(/warnings: showing \d+ of 1500/);
    expect(plan.note).toMatch(/NOT warningsFilter/);
    // Both bounds genuinely fire on this log — 1300 over the count cap, the rest over the
    // character budget — and the note counts them apart rather than reporting one total.
    expect(plan.note).toMatch(/1300 over the 200-warning cap/);
    expect(plan.note).toMatch(/over the 20000-character budget/);
    // Not so conservative that the budget is mostly unspent: the reserve is all that is left over.
    expect(renderedChars(plan)).toBeGreaterThan(DIAGNOSTICS_CONTENT_BUDGET / 2);
  });

  it('cuts a TAIL, keeping log order and never cherry-picking by size', () => {
    const plan = planDiagnosticsPayload([], warnings);
    expect(plan.warnings).toEqual(warnings.slice(0, plan.warnings.length));
  });

  it('names ONLY the bound that fired, when just the character budget did', () => {
    // 150 warnings: under the 200-count cap, so nothing here is over it — but fat enough that the
    // character budget cuts. Reporting a cap that did not fire sends the reader after a cause
    // that is not there.
    const fat = Array.from({ length: 150 }, (_, i) => ({
      ...warn(i),
      message: `Overfull \\hbox (${i}.0pt too wide) ` + 'x'.repeat(400),
    }));
    const plan = planDiagnosticsPayload([], fat);

    expect(renderedChars(plan)).toBeLessThanOrEqual(DIAGNOSTICS_CONTENT_BUDGET);
    expect(plan.warnings.length).toBeLessThan(150);
    expect(plan.warningsOmittedByCap).toBe(150 - plan.warnings.length);
    expect(plan.note).toMatch(/over the 20000-character budget/);
    expect(plan.note).not.toMatch(/warning cap/);
  });
});

describe('diagnostics budget: allocation order', () => {
  it('declares errors before warnings, so warnings are cut first', () => {
    expect([...ALLOCATION_ORDER]).toEqual(['errors', 'warnings']);
  });

  it('keeps every error and cuts the warnings, on a failing warning-heavy build', () => {
    const errors = Array.from({ length: 12 }, (_, i) => err(i, { snippet: i < 10 }));
    const warnings = Array.from({ length: 1500 }, (_, i) => warn(i));
    const plan = planDiagnosticsPayload(errors, warnings);

    expect(renderedChars(plan)).toBeLessThanOrEqual(DIAGNOSTICS_CONTENT_BUDGET);
    // The whole point of the order: the things that broke the build all survive.
    expect(plan.errors).toEqual(errors);
    expect(plan.errorsOmittedByCap).toBe(0);
    expect(plan.warningsOmittedByCap).toBeGreaterThan(0);
  });

  it('gives the warnings nothing at all once the errors were cut by size', () => {
    const errors = Array.from({ length: 40 }, (_, i) =>
      err(i, { message: 'Undefined control sequence ' + 'y'.repeat(2000) }),
    );
    const plan = planDiagnosticsPayload(errors, [warn(1)]);

    expect(plan.errorsOmittedByCap).toBeGreaterThan(0);
    expect(plan.warnings).toEqual([]);
    expect(plan.warningsOmittedByCap).toBe(1);
    expect(renderedChars(plan)).toBeLessThanOrEqual(DIAGNOSTICS_CONTENT_BUDGET);
  });
});

describe('diagnostics budget: errors', () => {
  it('caps the count, keeping a prefix', () => {
    const errors = Array.from({ length: 60 }, (_, i) => err(i));
    const plan = planDiagnosticsPayload(errors, []);
    expect(plan.errors).toEqual(errors.slice(0, DIAGNOSTICS_MAX_ERRORS));
    expect(plan.errorsOmittedByCap).toBe(60 - DIAGNOSTICS_MAX_ERRORS);
    expect(plan.note).toMatch(/errors: showing 20 of 60 \(40 over the 20-error cap\)/);
  });

  it('keeps an error past the count cap when it carries a snippet the server already read', () => {
    const errors = Array.from({ length: 60 }, (_, i) => err(i, { snippet: i === 55 }));
    const plan = planDiagnosticsPayload(errors, []);

    expect(plan.errors).toHaveLength(DIAGNOSTICS_MAX_ERRORS + 1);
    expect(plan.errors.at(-1)).toBe(errors[55]);
    expect(plan.errorsOmittedByCap).toBe(60 - plan.errors.length);
    // And it reaches the text channel, which is the client that cannot read structuredContent.
    expect(plan.errorLines).toContain('line 55 of the source');
  });

  it('returns one error even when it alone exceeds the whole budget', () => {
    const huge = err(1, { message: 'Undefined control sequence ' + 'z'.repeat(60_000) });
    const plan = planDiagnosticsPayload([huge, err(2), err(3)], [warn(1)]);

    expect(plan.errors).toEqual([huge]);
    expect(plan.errorsOmittedByCap).toBe(2);
    expect(plan.warnings).toEqual([]);
    expect(plan.note).toMatch(/errors: showing 1 of 3/);
  });

  it('charges an error its TEXT rendering as well as its JSON when the text will print it', () => {
    // Two runs over identical JSON: in the first every error is rendered into the text (they fall
    // inside the MAX_TEXT_ERRORS window), in the second only the first ten are. If the text
    // channel were not charged, both would keep the same number of errors.
    const withSnippets = Array.from({ length: 40 }, (_, i) => err(i, { snippet: true }));
    const bare = withSnippets.map((e) => ({
      ...e,
      snippet: undefined,
      snippetStartLine: undefined,
    }));
    const budget = 6000;

    const a = planDiagnosticsPayload(withSnippets, [], { budget, maxErrors: 40 });
    const b = planDiagnosticsPayload(bare, [], { budget, maxErrors: 40 });

    expect(JSON.stringify(withSnippets[0])).not.toBe(JSON.stringify(bare[0]));
    expect(a.errors.length).toBeLessThan(b.errors.length);
    expect(renderedChars(a)).toBeLessThanOrEqual(budget);
    expect(renderedChars(b)).toBeLessThanOrEqual(budget);
  });

  it('frees the text cost of an error the window will not print', () => {
    const errors = Array.from({ length: 30 }, (_, i) => err(i));
    const plan = planDiagnosticsPayload(errors, [], { maxErrors: 30 });
    // Beyond MAX_TEXT_ERRORS a bare error costs only its JSON, so the text stays a fixed window.
    expect(plan.errorsInText).toBe(MAX_TEXT_ERRORS);
    expect(textPrintedErrors(plan.errors)).toHaveLength(MAX_TEXT_ERRORS);
  });
});

describe('diagnostics budget: the note', () => {
  it('fits inside its reserve in both channels, at its longest', () => {
    // Every clause firing at once, with the widest counts this module can produce.
    const errors = Array.from({ length: 5000 }, (_, i) =>
      err(i, { message: 'Undefined control sequence ' + 'q'.repeat(400) }),
    );
    const warnings = Array.from({ length: 5000 }, (_, i) => warn(i));
    const plan = planDiagnosticsPayload(errors, warnings);

    expect(plan.note).toBeDefined();
    expect(2 * plan.note!.length).toBeLessThanOrEqual(DIAGNOSTICS_NOTE_RESERVE);
  });

  it('names the caller-facing distinction the counters exist for', () => {
    const plan = planDiagnosticsPayload(
      [],
      Array.from({ length: 400 }, (_, i) => warn(i)),
    );
    expect(plan.note).toContain('warningsOmitted');
    expect(plan.note).toContain('logPath');
  });
});

import { describe, it, expect } from 'vitest';
import { parseLog, logTail } from '../../src/services/logParser.js';

describe('parseLog', () => {
  it('parses file-line-error format errors', () => {
    const log = [
      'This is pdfTeX...',
      './main.tex:3: Undefined control sequence.',
      'l.3 This line uses an undefined macro: \\thismacrodoesnotexist',
      '?',
    ].join('\n');
    const { errors } = parseLog(log);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      severity: 'error',
      file: 'main.tex',
      line: 3,
      message: 'Undefined control sequence.',
      rule: 'Undefined control sequence',
    });
  });

  it('parses a bare TeX error and recovers the line from l.<n>', () => {
    const log = ['! Misplaced alignment tab character &.', 'l.42 a & b', ''].join('\n');
    const { errors } = parseLog(log);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ severity: 'error', line: 42 });
    expect(errors[0]?.message).toMatch(/Misplaced alignment/);
  });

  it('parses LaTeX and package warnings with input line numbers', () => {
    const log = [
      "LaTeX Warning: Reference `fig:x' on page 1 undefined on input line 7.",
      'Package natbib Warning: Citation `knuth` undefined on input line 12.',
    ].join('\n');
    const { warnings } = parseLog(log);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatchObject({ severity: 'warning', line: 7 });
    expect(warnings[1]).toMatchObject({ severity: 'warning', rule: 'natbib', line: 12 });
  });

  it('parses overfull boxes', () => {
    const { warnings } = parseLog('Overfull \\hbox (12.0pt too wide) in paragraph at lines 5--6');
    expect(warnings[0]).toMatchObject({ severity: 'warning', line: 5, rule: 'Overfull \\hbox' });
  });

  it('deduplicates repeated diagnostics', () => {
    const line = './main.tex:3: Undefined control sequence.';
    const { errors } = parseLog([line, line].join('\n'));
    expect(errors).toHaveLength(1);
  });

  it('logTail returns the last n lines', () => {
    const log = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    expect(logTail(log, 3)).toBe('line 97\nline 98\nline 99');
  });
});

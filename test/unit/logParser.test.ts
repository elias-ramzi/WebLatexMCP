import { describe, it, expect } from 'vitest';
import {
  parseLog,
  filterLog,
  logTail,
  unwrapLines,
  needsShellEscape,
  findMissingPackages,
} from '../../src/services/logParser.js';

/** One real per-figure TikZ externalization failure, as latexmk prints it (file-line-error). */
function tikzShellEscapeError(figure: number): string {
  return (
    `./main.tex:6: Package tikz Error: Sorry, the system call 'pdflatex -halt-on-error ` +
    `-interaction=batchmode -jobname "imgs/tikzmain-figure${figure}" "..."' did NOT result in a ` +
    `usable output file 'imgs/tikzmain-figure${figure}' (expected one of .pdf:.jpg:). Please ` +
    `verify that you have enabled system calls. For pdflatex, this is 'pdflatex -shell-escape'.`
  );
}

/** Re-wrap a logical line at TeX's 79-column width, the way pdfTeX hard-wraps the log. */
function hardWrap(line: string, width = 79): string {
  const out: string[] = [];
  for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width));
  return out.join('\n');
}

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

  it('collapses the N per-figure TikZ shell-escape errors into one diagnostic', () => {
    const log = [
      '(./main.tex',
      tikzShellEscapeError(0),
      tikzShellEscapeError(1),
      tikzShellEscapeError(2),
      ')',
    ].join('\n');
    const { errors } = parseLog(log);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ severity: 'error', rule: 'shell escape disabled' });
    expect(errors[0]?.message).toMatch(/3 figures/);
    expect(errors[0]?.message).toMatch(/restrictedShellEscape: true|shellEscape: true/);
  });

  it('leaves a single shell-escape error uncollapsed but keeps other errors intact', () => {
    const log = [
      '(./main.tex',
      tikzShellEscapeError(0),
      '! Undefined control sequence.',
      'l.9 \\badmacro',
      ')',
    ].join('\n');
    const { errors } = parseLog(log);
    expect(errors).toHaveLength(2);
    expect(errors.some((e) => /did NOT result in a usable output file/.test(e.message))).toBe(true);
    expect(errors.some((e) => /Undefined control sequence/.test(e.message))).toBe(true);
  });

  it('logTail returns the last n lines', () => {
    const log = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    expect(logTail(log, 3)).toBe('line 97\nline 98\nline 99');
  });
});

describe('unwrapLines', () => {
  it('rejoins lines hard-wrapped at 79 columns', () => {
    const long =
      '(/usr/share/texlive/texmf-dist/tex/generic/pgf/utilities/pgfutil-common-lists.tex)';
    expect(long.length).toBeGreaterThan(79);
    expect(unwrapLines(hardWrap(long))).toEqual([long]);
  });

  it('leaves short lines untouched', () => {
    expect(unwrapLines('alpha\nbeta\ngamma')).toEqual(['alpha', 'beta', 'gamma']);
  });
});

describe('filterLog (Task 1: de-noise)', () => {
  // A representative success tail: a real diagnostic, then the memory block, the font path dump
  // (hard-wrapped as TeX prints it), the wrapped "Output written on" line, and PDF statistics.
  const fontDump =
    '{/usr/share/texmf/fonts/enc/dvips/cm-super/cm-super-t1.enc}' +
    '</usr/share/texlive/texmf-dist/fonts/type1/public/amsfonts/cm/cmr10.pfb>' +
    '</home/x/texmf/fonts/type1/adobe/sourcesanspro/SourceSansPro-Bold.pfb>';
  const outputWritten =
    'Output written on /tmp/web-latex-mcp-build/pictura/main.pdf (28 pages, 8276395 bytes).';
  const successLog = [
    '(./main.tex',
    'LaTeX Font Info:    Checking defaults for OML/cmm/m/it on input line 159.',
    '(./sections/intro.tex',
    'Overfull \\hbox (12.0pt too wide) in paragraph at lines 5--6',
    ')) ',
    "Here is how much of TeX's memory you used:",
    ' 40478 strings out of 483183',
    ' 931496 string characters out of 5966292',
    ' 749110 words of font info for 266 fonts, out of 8000000 for 9000',
    hardWrap(fontDump),
    hardWrap(outputWritten),
    'PDF statistics:',
    ' 981 PDF objects out of 1000 (max. 8388607)',
  ].join('\n');

  it('strips the font .pfb/.enc path dump', () => {
    const tail = filterLog(successLog);
    expect(tail).not.toMatch(/\.pfb>/);
    expect(tail).not.toMatch(/\.enc}/);
  });

  it("strips the 'TeX's memory you used' block and PDF statistics", () => {
    const tail = filterLog(successLog);
    expect(tail).not.toMatch(/TeX's memory/);
    expect(tail).not.toMatch(/PDF statistics/);
    expect(tail).not.toMatch(/words of font info/);
    expect(tail).not.toMatch(/LaTeX Font Info/);
  });

  it('keeps the "Output written on ... (N pages, ...)" summary even when it was wrapped', () => {
    expect(filterLog(successLog)).toContain(outputWritten);
  });

  it('keeps warnings (overfull boxes) and drops font-info chatter', () => {
    const tail = filterLog(successLog);
    expect(tail).toMatch(/Overfull \\hbox \(12\.0pt too wide\) in paragraph at lines 5--6/);
  });

  it('passes a real "! ..." error and its l.<n> context through', () => {
    const errLog = [
      '(./main.tex',
      '! Undefined control sequence.',
      'l.42 \\badmacro',
      '',
      "Here is how much of TeX's memory you used:",
      ' 40478 strings out of 483183',
    ].join('\n');
    const tail = filterLog(errLog);
    expect(tail).toMatch(/^! Undefined control sequence\./m);
    expect(tail).toMatch(/^l\.42 \\badmacro/m);
    expect(tail).not.toMatch(/TeX's memory/);
  });

  it('rawLog escape hatch: logTail keeps the noise filterLog drops', () => {
    // compile(rawLog: true) returns logTail(log); the default returns filterLog(log).
    const raw = logTail(successLog, 400);
    expect(raw).toMatch(/words of font info/); // present in the raw tail...
    expect(filterLog(successLog)).not.toMatch(/words of font info/); // ...gone from the filtered one.
  });

  it('caps the output and notes the omission for a warning-heavy log', () => {
    const many = Array.from(
      { length: 200 },
      (_, i) => `Overfull \\hbox (1.0pt too wide) in paragraph at lines ${i}--${i + 1}`,
    ).join('\n');
    const tail = filterLog(many, { maxLines: 80 });
    expect(tail.split('\n')).toHaveLength(81); // 80 kept + the omission note
    expect(tail).toMatch(/120 earlier diagnostic line\(s\) omitted/);
  });

  it('falls back to a short raw tail when nothing matched', () => {
    const noise = Array.from({ length: 50 }, (_, i) => `boring line ${i}`).join('\n');
    expect(filterLog(noise)).toBe(logTail(noise, 15));
  });
});

describe('parseLog file attribution (Task 2)', () => {
  it('attributes a warning to the \\input-ed section it came from, not main.tex', () => {
    const log = [
      '(./main.tex',
      '(./sections/experiments.tex',
      'Overfull \\hbox (16.5pt too wide) in paragraph at lines 138--139',
      ')', // close experiments
      'Overfull \\hbox (2.0pt too wide) in paragraph at lines 200--201', // back in main
      ')',
    ].join('\n');
    const { warnings } = parseLog(log);
    expect(warnings[0]).toMatchObject({ file: 'sections/experiments.tex', line: 138 });
    expect(warnings[1]).toMatchObject({ file: 'main.tex', line: 200 });
  });

  it('tracks nested \\input files (figure inside a section)', () => {
    const log = [
      '(./main.tex',
      '(./sections/method.tex',
      '(./figs/diagram.tex',
      'Overfull \\hbox (5.0pt too wide) in paragraph at lines 3--4', // inside the figure
      ')', // close diagram
      'Underfull \\hbox (badness 2000) in paragraph at lines 9--10', // back in the section
      '))',
    ].join('\n');
    const { warnings } = parseLog(log);
    expect(warnings[0]?.file).toBe('figs/diagram.tex');
    expect(warnings[1]?.file).toBe('sections/method.tex');
  });

  it('attributes across a 79-column-wrapped file-open path', () => {
    const rel = `sections/${'x'.repeat(60)}/experiments.tex`;
    const open = `(./${rel}`;
    expect(open.length).toBeGreaterThan(79);
    const log = [
      '(./main.tex',
      hardWrap(open), // the file-open line is split across two physical lines
      'Overfull \\hbox (1.0pt too wide) in paragraph at lines 12--13',
      '))',
    ].join('\n');
    const { warnings } = parseLog(log);
    expect(warnings[0]?.file).toBe(rel);
  });

  it('attributes a TeX "! " error to the open source file', () => {
    const log = [
      '(./main.tex',
      '(./sections/intro.tex',
      '! Missing $ inserted.',
      'l.7 x_2',
      ')',
    ].join('\n');
    const { errors } = parseLog(log);
    expect(errors[0]).toMatchObject({ file: 'sections/intro.tex', line: 7 });
  });

  it('does not treat incidental (non-file) parens as a source file', () => {
    const log = [
      '(./main.tex',
      '(./sections/intro.tex',
      'Package foo Warning: something (not a file) happened on input line 5.',
      'Overfull \\hbox (3.0pt too wide) in paragraph at lines 8--9',
      '))',
    ].join('\n');
    const { warnings } = parseLog(log);
    expect(warnings.find((w) => w.rule === 'foo')?.file).toBe('sections/intro.tex');
    expect(warnings.find((w) => /Overfull/.test(w.message))?.file).toBe('sections/intro.tex');
  });

  it('omits file when it cannot be determined (no guessing)', () => {
    const { warnings } = parseLog('Overfull \\hbox (12.0pt too wide) in paragraph at lines 5--6');
    expect(warnings[0]?.file).toBeUndefined();
  });

  it('is robust to unbalanced parens (does not throw)', () => {
    expect(() => parseLog('(./main.tex\nstray ) close and more text\n)')).not.toThrow();
  });
});

describe('needsShellEscape', () => {
  it('detects the blocked-system-call signature', () => {
    expect(needsShellEscape(tikzShellEscapeError(0))).toBe(true);
  });

  it('detects it even when TeX wraps the advice across physical lines', () => {
    // TeX hard-wraps "…that you have enabled system calls" across two physical lines.
    const wrapped = [
      "'imgs/tikzmain-figure0'... did NOT result in a usable output file. Please verify that you have ",
      'enabled system calls. For pdflatex, this is ...',
    ].join('\n');
    expect(needsShellEscape(wrapped)).toBe(true);
  });

  it('is false for an ordinary error with no system-call failure', () => {
    expect(needsShellEscape('./main.tex:3: Undefined control sequence.')).toBe(false);
  });
});

describe('findMissingPackages', () => {
  it('extracts the package name from a file-line-error miss', () => {
    const log = [
      '(./resume.tex',
      "./resume.tex:8: LaTeX Error: File `fontawesome.sty' not found.",
      'Type X to quit or <RETURN> to proceed,',
      'l.8 \\usepackage{fontawesome}',
    ].join('\n');
    expect(findMissingPackages(log)).toEqual(['fontawesome']);
  });

  it('extracts it from the bare "! LaTeX Error" form, and from a missing class', () => {
    expect(findMissingPackages("! LaTeX Error: File `fontawesome.sty' not found.")).toEqual([
      'fontawesome',
    ]);
    expect(findMissingPackages("! LaTeX Error: File `IEEEtran.cls' not found.")).toEqual([
      'IEEEtran',
    ]);
  });

  it('extracts it from TeX\'s own "can\'t find file" phrasing', () => {
    expect(findMissingPackages("! I can't find file `mypkg.sty'.")).toEqual(['mypkg']);
  });

  it('reports each package once, in first-seen order, across latexmk passes', () => {
    const log = [
      "./main.tex:3: LaTeX Error: File `fontawesome.sty' not found.",
      "./main.tex:4: LaTeX Error: File `orcidlink.sty' not found.",
      "./main.tex:3: LaTeX Error: File `fontawesome.sty' not found.",
    ].join('\n');
    expect(findMissingPackages(log)).toEqual(['fontawesome', 'orcidlink']);
  });

  it('survives TeX hard-wrapping the message at 79 columns', () => {
    const wrapped = hardWrap(
      "./sections/very/deeply/nested/introduction.tex:12: LaTeX Error: File `fontawesome.sty' not found.",
    );
    expect(findMissingPackages(wrapped)).toEqual(['fontawesome']);
  });

  it('reduces a subdirectory request to the installable name', () => {
    expect(findMissingPackages("! LaTeX Error: File `sub/foo.sty' not found.")).toEqual(['foo']);
  });

  it('ignores missing files that are not packages — an image is a document problem', () => {
    const log = [
      "./main.tex:20: LaTeX Error: File `figures/plot.png' not found.",
      "./main.tex:21: LaTeX Error: File `main.bbl' not found.",
      "LaTeX Warning: File `refs.bib' not found.",
    ].join('\n');
    expect(findMissingPackages(log)).toEqual([]);
  });

  it('is empty for a clean log', () => {
    expect(findMissingPackages('Output written on main.pdf (3 pages, 12345 bytes).')).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import {
  shellEscapeOverriddenHint,
  shellEscapeRefusedHint,
  tikzShellEscapeHint,
} from '../../src/services/compiler.js';
import { engineShellEscapeBanner, parseLog } from '../../src/services/logParser.js';

/*
 * Document-writable log lines may only ADD a hint: they never choose which flag a hint names,
 * never narrow the stated risk, never suppress a hint, and never produce a false claim. The
 * engine's log HEADER (before the first `**` line, in a log opening `This is …`) is not
 * document-writable, and is the only evidence any of these decisions may rest on — which means
 * "the header was read and holds no banner" and "no header could be read" are different answers.
 */

/** pdfTeX's header under -no-shell-escape: no banner line at all. */
const OFF_HEADER =
  'This is pdfTeX, Version 3.14159265-2.6-1.40.20 (TeX Live 2019/Debian)\n' +
  'entering extended mode\n file:line:error style messages enabled.\n**main.tex\n(./main.tex\n';
/** The same header with FULL shell escape (a latexmkrc appended -shell-escape after %O). */
const FULL_HEADER = OFF_HEADER.replace(
  'entering extended mode\n',
  'entering extended mode\n \\write18 enabled.\n',
);

/**
 * What latexmk prints when the engine's `.log` is not where the server looks (a latexmkrc setting
 * `$jobname`), and `collectOutcome` falls back to the captured output: latexmk's own lines first,
 * the engine's terminal output after, and no `**` line anywhere. Lines 1–3 are verbatim from a TL2019
 * run with an rc of `$pdflatex = 'pdflatex %O -shell-escape %S'` and `$jobname = 'other'`.
 */
const STDOUT_WITH_BANNER =
  "Latexmk: applying rule 'pdflatex'...\n" +
  'This is pdfTeX, Version 3.14159265-2.6-1.40.20 (TeX Live 2019/Debian) (preloaded format=pdflatex)\n' +
  ' \\write18 enabled.\n' +
  'entering extended mode\n(./main.tex\nLaTeX2e <2020-02-02> patch level 2\n' +
  'Output written on out/other.pdf (1 page, 10700 bytes).\n' +
  'Latexmk: This is Latexmk, John Collins, 26 Dec. 2019, version: 4.67.\n';
const STDOUT_NO_BANNER = STDOUT_WITH_BANNER.replace(' \\write18 enabled.\n', '');

const REPSTOPDF_REFUSED =
  'runsystem(repstopdf --outfile=fig-eps-converted-to.pdf fig.eps)...disabled.\n';
const TIKZ_FAILURE = (n: number): string =>
  `./main.tex:${n + 4}: Package tikz Error: Sorry, the system call 'pdflatex -halt-on-error ` +
  `-interaction=batchmode -jobname "main-figure${n}" "..."' did NOT result in a usable output ` +
  `file 'main-figure${n}' (expected one of .pdf:.jpg:). Please verify that you have enabled ` +
  "system calls. For pdflatex, this is 'pdflatex -shell-escape'.\n\n";

const latexmk = { shellEscapeOn: false, overlay: false, backend: 'latexmk' as const };

describe('task 1: a header read without a banner is not the same answer as no header at all', () => {
  it("engineShellEscapeBanner says 'none' for a delimited header with no banner", () => {
    expect(engineShellEscapeBanner(OFF_HEADER)).toBe('none');
    // A banner-shaped line the document wrote into the body does not change that.
    expect(engineShellEscapeBanner(`${OFF_HEADER} \\write18 enabled.\n`)).toBe('none');
  });

  it("and undefined — unknown — for latexmk's captured output, banner or not", () => {
    expect(engineShellEscapeBanner(STDOUT_WITH_BANNER)).toBe(undefined);
    expect(engineShellEscapeBanner(STDOUT_NO_BANNER)).toBe(undefined);
  });

  it('with no readable header, a banner in the output adds a hedged note that asserts nothing', () => {
    const hint = shellEscapeOverriddenHint(STDOUT_WITH_BANNER, {
      shellEscapeOn: false,
      backend: 'latexmk',
    });
    expect(hint).toContain('shows a shell-escape banner, but no engine log confirms it');
    expect(hint).toContain('may have turned shell escape on');
    // Asserts no override and narrows no risk.
    expect(hint).not.toContain('overrode');
    expect(hint).not.toContain('allow-list');
  });

  it('with no readable header and no banner, nothing is added', () => {
    expect(
      shellEscapeOverriddenHint(STDOUT_NO_BANNER, { shellEscapeOn: false, backend: 'latexmk' }),
    ).toBe(undefined);
  });
});

describe('task 2: under a genuine FULL header, a TikZ failure is not blamed on shell escape', () => {
  const log = `${FULL_HEADER}${TIKZ_FAILURE(0)}${TIKZ_FAILURE(1)}`;

  it('the collapsed error says shell escape was on and gives no retry advice', () => {
    const errors = parseLog(log).errors;
    const collapsed = errors.find((e) =>
      /TikZ externalization failed for 2 figures/.test(e.message),
    );
    expect(collapsed?.message).toContain('shell escape was on for this run');
    expect(collapsed?.message).toContain("see each figure's own log");
    expect(collapsed?.message).not.toMatch(/Retry/);
    expect(collapsed?.message).not.toMatch(/disabled/);
  });

  it('the TikZ compile hint is silent, as the refusal hint already is', () => {
    expect(tikzShellEscapeHint(log, { shellEscapeOn: false, backend: 'latexmk' })).toBe(undefined);
    expect(shellEscapeRefusedHint(log, latexmk)).toBe(undefined);
  });
});

describe('task 3: a TikZ line neither suppresses nor retargets a non-engine refusal hint', () => {
  // OFF header, a genuine repstopdf refusal, and one TikZ failure the document may have
  // `\typeout`ed: the refused command is not an engine call, so its restrictedShellEscape advice
  // stands, whatever the pgf line says.
  const log = `${OFF_HEADER}${REPSTOPDF_REFUSED}${TIKZ_FAILURE(0)}`;

  it('a plain compile keeps the refusal hint and its restrictedShellEscape advice', () => {
    const hint = shellEscapeRefusedHint(log, latexmk) ?? '';
    expect(hint).toContain('The engine refused a shell command');
    expect(hint).toContain('Retry with restrictedShellEscape: true (or shellEscape: true)');
    // The TikZ hint still adds its own line.
    expect(tikzShellEscapeHint(log, { shellEscapeOn: false, backend: 'latexmk' })).toContain(
      'Retry compile with shellEscape: true',
    );
  });

  it('an overlay compile keeps its restrictedShellEscape advice', () => {
    const hint = shellEscapeRefusedHint(log, { ...latexmk, overlay: true }) ?? '';
    expect(hint).toContain('Retrying with restrictedShellEscape: true (or shellEscape: true)');
  });

  it('the same holds for LuaTeX’s pdftexcmds record under an OFF header', () => {
    const lua =
      'This is LuaHBTeX, Version 1.24.0 (TeX Live 2026)\n**main.tex\n(./main.tex\n' +
      'system(repstopdf --outfile=fig-eps-converted-to.pdf fig.eps) executed.\n' +
      TIKZ_FAILURE(0);
    expect(shellEscapeRefusedHint(lua, latexmk)).toContain(
      'Retry with restrictedShellEscape: true (or shellEscape: true)',
    );
  });

  it('refused engine calls only, with no TikZ line: shellEscape, since no allow-list holds an engine', () => {
    for (const cmd of [
      'pdflatex -jobname imgs/x main.tex',
      '/usr/bin/xelatex -jobname x main.tex',
      '"C:\\texlive\\bin\\windows\\lualatex.exe" -jobname x main.tex',
    ]) {
      const hint = shellEscapeRefusedHint(`${OFF_HEADER}runsystem(${cmd})...disabled.\n`, latexmk);
      expect(hint, cmd).toContain('Retry with shellEscape: true');
      expect(hint, cmd).not.toContain('restrictedShellEscape: true (or');
      expect(hint, cmd).toContain('ARBITRARY');
    }
  });

  it('an engine call beside a non-engine one: restrictedShellEscape kept, shellEscape named for the engine', () => {
    const mixed = `${OFF_HEADER}runsystem(pdflatex -jobname x main.tex)...disabled.\n${REPSTOPDF_REFUSED}`;
    const hint = shellEscapeRefusedHint(mixed, latexmk) ?? '';
    expect(hint).toContain('Retry with restrictedShellEscape: true (or shellEscape: true, which');
    expect(hint).toContain('the refused engine call among them needs');
    const overlay = shellEscapeRefusedHint(mixed, { ...latexmk, overlay: true }) ?? '';
    expect(overlay).toContain('Retrying with restrictedShellEscape: true (or shellEscape: true');
    expect(overlay).toContain('the refused engine call among them needs');
  });

  it('a command merely named like an engine is not one (texcount, latexmk, pdflatexmk)', () => {
    for (const cmd of ['texcount main.tex', 'latexmk -pdf x', 'pdflatexmk x']) {
      expect(
        shellEscapeRefusedHint(`${OFF_HEADER}runsystem(${cmd})...disabled.\n`, latexmk),
        cmd,
      ).toContain('Retry with restrictedShellEscape: true (or shellEscape: true)');
    }
  });
});

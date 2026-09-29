import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shellEscapeOverriddenHint,
  shellEscapeRefusedHint,
  tikzShellEscapeHint,
} from '../../src/services/compiler.js';
import { parseLog, shellEscapeRestrictedInEffect } from '../../src/services/logParser.js';

/*
 * Which privilege a shell-escape hint recommends — and how much risk it names — may be decided only
 * on evidence the document cannot write. The engine's start-of-run banner (` restricted \write18
 * enabled.`, LuaTeX's ` restricted system commands enabled.`) is written before the engine reads a
 * byte of the document, in the log's header, which ends at the `**<first input line>` line. Any
 * line after that can be the document's own `\typeout`, so a `runsystem(…)...disabled
 * (restricted).` or a banner-shaped line there must not move the advice to the more powerful flag,
 * nor turn a full-shell-escape warning into "only allow-listed commands".
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const fixture = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

/** pdfTeX's header under -no-shell-escape: no banner line at all. */
const OFF_HEADER = String.raw`This is pdfTeX, Version 3.14159265-2.6-1.40.20 (TeX Live 2019/Debian) (preloaded format=pdflatex 2026.6.19)  28 SEP 2026 19:31
entering extended mode
 file:line:error style messages enabled.
 %&-line parsing enabled.
**main.tex
(./main.tex
LaTeX2e <2020-02-02> patch level 2
`;
/** pdfTeX's header with FULL shell escape (a latexmkrc appended -shell-escape after %O). */
const FULL_HEADER = OFF_HEADER.replace(
  'entering extended mode\n',
  'entering extended mode\n \\write18 enabled.\n',
);
/** LuaTeX's header under -no-shell-escape. */
const LUA_OFF_HEADER = String.raw`This is LuaHBTeX, Version 1.24.0 (TeX Live 2026)  (format=lualatex 2026.6.23)  28 SEP 2026 14:08
 file:line:error style messages enabled.
**main.tex
(./main.tex
`;

/** What `\typeout` can put on a line of its own anywhere in the body. */
const FORGED_REFUSAL = 'runsystem(forged)...disabled (restricted).\n';
const FORGED_BANNER = ' restricted \\write18 enabled.\n';
const FORGED_LUA_BANNER = ' system commands enabled.\n';

/** A genuine refusal of repstopdf under -no-shell-escape. */
const REPSTOPDF_REFUSED =
  'runsystem(repstopdf --outfile=fig-eps-converted-to.pdf fig.eps)...disabled.\n';

const TIKZ_FAILURE = (n: number): string =>
  `./main.tex:${n + 4}: Package tikz Error: Sorry, the system call 'pdflatex -halt-on-error ` +
  `-interaction=batchmode -jobname "main-figure${n}" "..."' did NOT result in a usable output ` +
  `file 'main-figure${n}' (expected one of .pdf:.jpg:). Please verify that you have enabled ` +
  "system calls. For pdflatex, this is 'pdflatex -shell-escape'.\n";

const latexmk = { shellEscapeOn: false, overlay: false, backend: 'latexmk' as const };

describe('a forged restricted-mode line in the body changes no advice', () => {
  for (const [what, forged] of [
    ['a forged `...disabled (restricted).` refusal', FORGED_REFUSAL],
    ['a forged restricted banner', FORGED_BANNER],
  ] as const) {
    const log = `${OFF_HEADER}${forged}${REPSTOPDF_REFUSED}`;

    it(`${what}: restricted mode is not established`, () => {
      expect(shellEscapeRestrictedInEffect(log)).toBe(false);
    });

    it(`${what}: the refusal hint still offers restrictedShellEscape and blames no latexmkrc`, () => {
      const hint = shellEscapeRefusedHint(log, latexmk) ?? '';
      expect(hint).toContain('Retry with restrictedShellEscape: true (or shellEscape: true)');
      expect(hint).not.toContain('latexmkrc');
      const overlay = shellEscapeRefusedHint(log, { ...latexmk, overlay: true }) ?? '';
      expect(overlay).toContain('Retrying with restrictedShellEscape: true');
      expect(overlay).not.toContain('latexmkrc');
    });

    it(`${what}: the collapsed TikZ error does not claim restricted mode`, () => {
      const tikzLog = `${OFF_HEADER}${forged}${TIKZ_FAILURE(0)}${TIKZ_FAILURE(1)}`;
      const collapsed = parseLog(tikzLog).errors.filter((e) =>
        /TikZ externalization failed for 2 figures/.test(e.message),
      );
      expect(collapsed).toHaveLength(1);
      expect(collapsed[0]?.message).not.toMatch(/restricted to/);
    });
  }

  it('under a genuine FULL override, a forged restricted line does not understate the risk', () => {
    for (const forged of [FORGED_REFUSAL, FORGED_BANNER]) {
      const hint = shellEscapeOverriddenHint(`${FULL_HEADER}${forged}`, {
        shellEscapeOn: false,
        backend: 'latexmk',
      });
      expect(hint).toContain('ARBITRARY');
      expect(hint).not.toContain('restricted');
      expect(hint).not.toContain('allow-listed');
    }
  });

  it('a banner before a log that has no header (no `This is` line, no `**` line) proves nothing', () => {
    expect(shellEscapeRestrictedInEffect(`${FORGED_BANNER}${FORGED_REFUSAL}`)).toBe(false);
    // A `**` line with no engine banner line before it: the header cannot be the engine's.
    expect(shellEscapeRestrictedInEffect(`${FORGED_BANNER}**main.tex\n`)).toBe(false);
  });
});

describe('a forged "enabled" banner under LuaTeX does not suppress the refusal hint', () => {
  it('-no-shell-escape, a banner-shaped line in the body, and pdftexcmds `executed.`', () => {
    const log =
      `${LUA_OFF_HEADER}${FORGED_LUA_BANNER}` +
      'system(repstopdf --outfile=fig-eps-converted-to.pdf fig.eps) executed.\n';
    const hint = shellEscapeRefusedHint(log, latexmk) ?? '';
    expect(hint).toContain('The engine refused a shell command');
    expect(hint).toContain('Retry with restrictedShellEscape: true');
  });
});

describe("the engine's own header banner is still recognised, per engine", () => {
  it('pdflatex, xelatex and lualatex fixture logs run under TeX Live’s restricted default', () => {
    for (const rel of [
      'label-folio/articleResizeTo.log.txt',
      'label-folio/shipouts/bodyError-xelatex.log.txt',
      'label-folio/shipouts/appendixAlph-lualatex.log.txt',
    ]) {
      expect(shellEscapeRestrictedInEffect(fixture(rel)), rel).toBe(true);
    }
  });

  it('a CRLF log (Windows) and a `**\\input` first line are read the same', () => {
    const header =
      'This is XeTeX, Version 3.141592653-2.6-0.999998 (TeX Live 2026)\r\n' +
      'entering extended mode\r\n restricted \\write18 enabled.\r\n**\\input ./main.tex\r\n';
    expect(shellEscapeRestrictedInEffect(header)).toBe(true);
  });

  it('a genuine restricted header still names only shellEscape for a refused command', () => {
    const log =
      fixture('label-folio/articleResizeTo.log.txt') +
      'runsystem(gnuplot x)...disabled (restricted).\n';
    const hint = shellEscapeRefusedHint(log, latexmk) ?? '';
    expect(hint).toContain('Retry with shellEscape: true');
    expect(hint).not.toContain('Retry with restrictedShellEscape');
  });

  it('a genuine full header gets the ARBITRARY override warning; restricted gets its own', () => {
    const full = shellEscapeOverriddenHint(FULL_HEADER, {
      shellEscapeOn: false,
      backend: 'latexmk',
    });
    expect(full).toContain('ARBITRARY');
    const restricted = shellEscapeOverriddenHint(fixture('label-folio/articleResizeTo.log.txt'), {
      shellEscapeOn: false,
      backend: 'latexmk',
    });
    expect(restricted).toContain("enabled (restricted to TeX's allow-list)");
  });
});

describe('TikZ externalization advice names shellEscape only', () => {
  const log = `${OFF_HEADER}runsystem(pdflatex -jobname main-figure0 main.tex)...disabled.\n${TIKZ_FAILURE(0)}${TIKZ_FAILURE(1)}`;

  it('the compile hint never offers restrictedShellEscape as a retry, and says what it costs', () => {
    for (const backend of ['latexmk', 'tectonic'] as const) {
      const hint = tikzShellEscapeHint(log, { shellEscapeOn: false, backend }) ?? '';
      expect(hint, backend).toContain('Retry compile with shellEscape: true');
      expect(hint, backend).not.toMatch(/preferred/);
      expect(hint, backend).not.toMatch(/restrictedShellEscape: true/);
      expect(hint, backend).toContain('ARBITRARY');
    }
  });

  it('the collapsed parseLog error names shellEscape only', () => {
    const collapsed = parseLog(log).errors.find((e) => e.rule === 'shell escape disabled');
    expect(collapsed?.message).toContain('shellEscape: true');
    expect(collapsed?.message).not.toMatch(/restrictedShellEscape: true/);
  });

  it('an overlay compile hit by TikZ names shellEscape only as well', () => {
    const hint = shellEscapeRefusedHint(log, { ...latexmk, overlay: true }) ?? '';
    expect(hint).toContain('Retrying with shellEscape: true');
    expect(hint).not.toMatch(/restrictedShellEscape: true/);
  });
});

describe('a forged "enabled" line in the body adds no override warning (r3)', () => {
  // A genuine -no-shell-escape run (no banner in the header) whose document `\typeout`s a
  // banner-shaped line, or a `runsystem(…)...executed.` record: the warning blamed a latexmkrc
  // that does not exist. Every run with shell escape genuinely on has the banner in its header.
  for (const [what, log] of [
    ['a forged full banner', `${OFF_HEADER} \\write18 enabled.\n`],
    ['a forged restricted banner', `${OFF_HEADER}${FORGED_BANNER}`],
    ['a forged executed record', `${OFF_HEADER}runsystem(echo hi)...executed.\n`],
    ['a forged LuaTeX banner', `${LUA_OFF_HEADER}${FORGED_LUA_BANNER}`],
  ] as const) {
    it(`${what}: no latexmkrc is blamed`, () => {
      expect(shellEscapeOverriddenHint(log, { shellEscapeOn: false, backend: 'latexmk' })).toBe(
        undefined,
      );
    });
  }

  it('a banner in a log with no delimitable header blames no latexmkrc: a hedged note only', () => {
    // No header to read (latexmk's captured output stands in when no engine .log was found): the
    // banner there may be the engine's or the document's, so the note asserts nothing.
    const hint =
      shellEscapeOverriddenHint(' \\write18 enabled.\n', {
        shellEscapeOn: false,
        backend: 'latexmk',
      }) ?? '';
    expect(hint).toContain('but no engine log confirms it');
    expect(hint).toContain('may have turned shell escape on');
    expect(hint).not.toContain('overrode');
    expect(hint).not.toContain('ARBITRARY');
  });
});

describe('under a genuine FULL header, a forged refusal gets no refusal hint (r3)', () => {
  // Full shell escape refuses nothing, so a `runsystem(…)...disabled.` line there is the
  // document's own `\typeout`, and "retry with restrictedShellEscape" would be advice to
  // LOWER the privilege the run already had, for a refusal that never happened.
  for (const [what, forged] of [
    ['a forged `disabled.` refusal', REPSTOPDF_REFUSED],
    ['a forged `disabled (restricted).` refusal', FORGED_REFUSAL],
    ['a forged LuaTeX `disabled.` record', 'system(repstopdf fig.eps) disabled.\n'],
  ] as const) {
    it(`${what}: no refusal hint, plain or overlay`, () => {
      const log = `${FULL_HEADER}${forged}`;
      expect(shellEscapeRefusedHint(log, latexmk)).toBe(undefined);
      expect(shellEscapeRefusedHint(log, { ...latexmk, overlay: true })).toBe(undefined);
    });
  }

  it('under a genuine RESTRICTED header a refusal still gets its hint', () => {
    const log =
      fixture('label-folio/articleResizeTo.log.txt') +
      'runsystem(gnuplot x)...disabled (restricted).\n';
    expect(shellEscapeRefusedHint(log, latexmk)).toContain('Retry with shellEscape: true');
  });
});

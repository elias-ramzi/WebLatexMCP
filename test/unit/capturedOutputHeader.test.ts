import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  collectOutcome,
  shellEscapeOverriddenHint,
  shellEscapeRefusedHint,
  tikzShellEscapeHint,
} from '../../src/services/compiler.js';
import { engineShellEscapeBanner, parseLog } from '../../src/services/logParser.js';

/*
 * #232 items 1 and 2. When no engine `.log` is found, `collectOutcome` hands back latexmk's
 * captured output as the log. latexmk 4.88 opens that with a `Latexmk:` line, but latexmk 4.67
 * (TeX Live 2019) under an rc setting `$jobname` and `$silent = 1` opens it with the engine's own
 * `This is pdfTeX…` line — and the document's terminal output follows. A `\nonstopmode` document
 * then writes ` \write18 enabled.` (or the restricted form) and a `**x` line of its own before the
 * engine's, which read as a header. Captured output must never be read as one, whatever it opens
 * with; and with no header, nothing may claim shell escape was off.
 */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const ENGINE_FIRST_LINE =
  'This is pdfTeX, Version 3.14159265-2.6-1.40.20 (TeX Live 2019/Debian) (preloaded format=pdflatex)\n';

/**
 * TL2019 captured output with shell escape genuinely OFF, opening with the engine's line, and a
 * document that `\write16`s a full banner and a `**` line before the engine's own.
 */
const FORGED_FULL =
  ENGINE_FIRST_LINE + ' \\write18 enabled.\n' + '**x\n' + 'entering extended mode\n(./main.tex\n';

/** Shell escape genuinely FULL (the engine's banner), and a forged restricted banner after it. */
const FORGED_RESTRICTED_UNDER_FULL =
  ENGINE_FIRST_LINE +
  ' \\write18 enabled.\n' +
  ' restricted \\write18 enabled.\n' +
  '**x\n' +
  'entering extended mode\n(./main.tex\n';

const TIKZ_FAILURE = (n: number): string =>
  `./main.tex:${n + 4}: Package tikz Error: Sorry, the system call 'pdflatex -halt-on-error ` +
  `-interaction=batchmode -jobname "main-figure${n}" "..."' did NOT result in a usable output ` +
  `file 'main-figure${n}' (expected one of .pdf:.jpg:). Please verify that you have enabled ` +
  "system calls. For pdflatex, this is 'pdflatex -shell-escape'.\n\n";

const REPSTOPDF_REFUSED =
  'runsystem(repstopdf --outfile=fig-eps-converted-to.pdf fig.eps)...disabled.\n';

const captured = { capturedOutput: true } as const;
const latexmk = { shellEscapeOn: false, backend: 'latexmk' as const };

describe('captured output is never read as an engine header (#232 item 1)', () => {
  it('the forged header would read as one without the flag — the attack this closes', () => {
    expect(engineShellEscapeBanner(FORGED_FULL)).toBe('full');
    expect(engineShellEscapeBanner(FORGED_RESTRICTED_UNDER_FULL)).toBe('restricted');
  });

  it('with the flag, there is no header to read', () => {
    expect(engineShellEscapeBanner(FORGED_FULL, captured)).toBe(undefined);
    expect(engineShellEscapeBanner(FORGED_RESTRICTED_UNDER_FULL, captured)).toBe(undefined);
  });

  it('a forged full banner adds no override warning, and hides neither the TikZ hint nor its retry', () => {
    const log = FORGED_FULL + TIKZ_FAILURE(0) + TIKZ_FAILURE(1);
    const overridden = shellEscapeOverriddenHint(log, { ...latexmk, ...captured }) ?? '';
    // Only the hedged note a banner-shaped line may add: nothing asserted.
    expect(overridden).toContain('may have turned shell escape on');
    expect(overridden).not.toContain('overrode -no-shell-escape');
    expect(tikzShellEscapeHint(log, { ...latexmk, ...captured })).toContain(
      'Retry compile with shellEscape: true',
    );
    const collapsed = parseLog(log, captured).errors[0]?.message ?? '';
    expect(collapsed).toContain('2 figures');
    expect(collapsed).not.toContain('although shell escape was on');
    expect(collapsed).toContain('Retry compile with shellEscape: true');
  });

  it('a forged restricted banner under a genuine full one cannot understate the risk', () => {
    const overridden =
      shellEscapeOverriddenHint(FORGED_RESTRICTED_UNDER_FULL, { ...latexmk, ...captured }) ?? '';
    expect(overridden).not.toContain('allow-listed');
    expect(overridden).not.toContain("restricted to TeX's allow-list");
    // And a refusal record keeps the ordinary advice, not the "restricted already on" narrowing.
    const refused =
      shellEscapeRefusedHint(FORGED_RESTRICTED_UNDER_FULL + REPSTOPDF_REFUSED, {
        ...latexmk,
        overlay: false,
        ...captured,
      }) ?? '';
    expect(refused).toContain('restrictedShellEscape: true');
    expect(refused).not.toContain('already had');
  });
});

describe('with no header, the collapsed TikZ error does not claim shell escape was off (#232 item 2)', () => {
  it('hedges the cause for captured output carrying a genuine full banner', () => {
    // A latexmkrc that renames the job and turns shell escape on: the banner is genuine, but
    // captured output cannot vouch for it either way.
    const log =
      "Latexmk: applying rule 'pdflatex'...\n" +
      ENGINE_FIRST_LINE +
      ' \\write18 enabled.\n' +
      'entering extended mode\n(./main.tex\n' +
      TIKZ_FAILURE(0) +
      TIKZ_FAILURE(1);
    const collapsed = parseLog(log, captured).errors;
    expect(collapsed).toHaveLength(1);
    const message = collapsed[0]?.message ?? '';
    expect(message).toContain('usually because shell escape is disabled');
    expect(message).toContain('could not be confirmed');
    expect(message).not.toContain(' because shell escape is disabled.');
    expect(collapsed[0]?.rule).toBe('TikZ externalization failed');
  });

  it("still says it plainly when the engine's header was read and shows no banner", () => {
    const log =
      `${ENGINE_FIRST_LINE}entering extended mode\n**main.tex\n(./main.tex\n` +
      TIKZ_FAILURE(0) +
      TIKZ_FAILURE(1);
    const [collapsed] = parseLog(log).errors;
    expect(collapsed?.message).toContain(' because shell escape is disabled.');
    expect(collapsed?.rule).toBe('shell escape disabled');
  });
});

describe('collectOutcome says when the log is captured output', () => {
  async function buildDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'captured-out-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }
  const exec = { code: 1, stdout: FORGED_FULL, stderr: '', timedOut: false };

  it('flags the fallback to captured stdout/stderr', async () => {
    const outcome = await collectOutcome(await buildDir(), 'main.tex', exec, 0.1, '', null);
    expect(outcome.logPath).toBe(undefined);
    expect(outcome.capturedOutput).toBe(true);
    expect(outcome.log.startsWith('This is pdfTeX')).toBe(true);
  });

  it('leaves the flag off when the engine wrote its .log', async () => {
    const dir = await buildDir();
    await writeFile(path.join(dir, 'main.log'), FORGED_FULL);
    const outcome = await collectOutcome(dir, 'main.tex', exec, 0.1, '', null);
    expect(outcome.logPath).toBe(path.join(dir, 'main.log'));
    expect(outcome.capturedOutput).toBe(undefined);
  });
});

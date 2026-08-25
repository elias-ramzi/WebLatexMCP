import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DoctorService, isWritablePath } from '../../src/services/doctor.js';
import type { ExecResult } from '../../src/lib/exec.js';

/** Canned command output, keyed by `cmd` plus the first argument when it matters. */
type Canned = Record<string, string>;

function ok(stdout: string): ExecResult {
  return { code: 0, stdout, stderr: '', timedOut: false };
}

/**
 * A stand-in for `execCapture`: known commands answer from the table, unknown ones reject the way
 * spawning a binary that is not on PATH does — which is exactly how the service detects absence.
 */
function runner(canned: Canned): {
  run: (cmd: string, args: string[]) => Promise<ExecResult>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    run: (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      const key = canned[`${cmd} ${args[0] ?? ''}`] ?? canned[cmd];
      if (key === undefined) return Promise.reject(new Error('ENOENT'));
      return Promise.resolve(ok(key));
    },
  };
}

/** This machine's real answers for an end-of-life TeX Live 2019 on Debian — the case that hurts. */
function eolTeXLive(texmfHome: string, texmfLocal: string): Canned {
  return {
    'latexmk -v': 'Latexmk, John Collins, 26 Dec. 2019. Version 4.67',
    'pdflatex --version': 'pdfTeX 3.14159265-2.6-1.40.20 (TeX Live 2019/Debian)',
    'lualatex --version': 'This is LuaHBTeX, Version 1.10.0 (TeX Live 2019/Debian)',
    'tlmgr --version': 'tlmgr revision 53568 (2020-01-27 19:20:16 +0100)',
    'tlmgr option':
      '(running on Debian, switching to user mode!)\n' +
      'Default package repository (repository): ' +
      'https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2019/tlnet-final',
    'kpsewhich -var-value=TEXMFHOME': texmfHome,
    'kpsewhich -var-value=TEXMFLOCAL': texmfLocal,
    'git --version': 'git version 2.46.0',
  };
}

const NOW = (): Date => new Date('2026-08-20T00:00:00Z');

/**
 * Writability, decided by the test rather than by the machine running it. The real answer for a path
 * like `/usr/local/share/texmf` differs per OS — writable under Homebrew, absent on Windows — and
 * these tests are about what the *diagnosis* makes of the answer, not about what the answer is.
 * `isWritablePath` itself is covered separately, with fixtures that behave the same everywhere.
 */
function writability(notWritable: string[]): (target: string) => Promise<boolean> {
  return (target) => Promise.resolve(!notWritable.includes(target));
}

/** The usual shape: your own tree is yours to write, the system tree needs root. */
const SYSTEM_TEXMF = '/usr/local/share/texmf';
const rootOwnedSystemTexmf = writability([SYSTEM_TEXMF]);

function statusOf(
  checks: Array<{ name: string; status: string }>,
  name: string,
): string | undefined {
  return checks.find((c) => c.name === name)?.status;
}

describe('DoctorService', () => {
  let tmp: string;
  let home: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'ovl-doctor-'));
    // TEXMFHOME normally does not exist yet — nothing has been installed into it.
    home = path.join(tmp, 'texmf');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('diagnoses an end-of-life TeX Live pointed at a frozen archive', async () => {
    const { run } = runner(eolTeXLive(home, '/usr/local/share/texmf'));
    const doctor = new DoctorService({ run, now: NOW, canWrite: rootOwnedSystemTexmf });

    const result = await doctor.diagnose({ compiler: 'latexmk', workspaceRoot: tmp });

    // Nothing is missing — the toolchain compiles fine. It just cannot install anything.
    expect(result.ok).toBe(true);
    expect(statusOf(result.checks, 'distribution')).toBe('warn');
    expect(statusOf(result.checks, 'package-manager')).toBe('warn');
    expect(result.checks.find((c) => c.name === 'distribution')?.detail).toContain(
      'past end of life',
    );
    expect(result.hints.join('\n')).toContain('frozen archive');
    // The no-root route is the answer that actually unblocks someone here.
    expect(result.hints.join('\n')).toContain('--usermode');
  });

  it("reports only the engines that are installed, in compile's vocabulary", async () => {
    const { run } = runner(eolTeXLive(home, '/usr/local/share/texmf'));
    const doctor = new DoctorService({ run, now: NOW, canWrite: rootOwnedSystemTexmf });

    const result = await doctor.diagnose({ compiler: 'latexmk' });

    expect(result.engines).toEqual(['pdflatex', 'lualatex']); // no xelatex in the table
  });

  it('reads the repository past the preamble tlmgr prints before it', async () => {
    const { run } = runner(eolTeXLive(home, '/usr/local/share/texmf'));
    const doctor = new DoctorService({ run, now: NOW, canWrite: rootOwnedSystemTexmf });

    const result = await doctor.diagnose({ compiler: 'latexmk' });

    expect(result.checks.find((c) => c.name === 'package-manager')?.detail).toContain(
      'https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2019/tlnet-final',
    );
  });

  it('is clean on a current TeX Live with a live mirror', async () => {
    const canned = eolTeXLive(home, path.join(tmp, 'local'));
    canned['pdflatex --version'] = 'pdfTeX 3.141592653-2.6-1.40.26 (TeX Live 2026)';
    canned['lualatex --version'] = 'This is LuaHBTeX, Version 1.18.0 (TeX Live 2026)';
    canned['xelatex --version'] = 'XeTeX 3.141592653-2.6-0.999996 (TeX Live 2026)';
    canned['tlmgr option'] =
      'Default package repository (repository): https://mirror.ctan.org/systems/texlive/tlnet';
    const doctor = new DoctorService({
      run: runner(canned).run,
      now: NOW,
      canWrite: rootOwnedSystemTexmf,
      // Pinned rather than left to the real probe — whether @napi-rs/canvas is actually installed
      // depends on the machine running the test, and this case is about a toolchain with nothing
      // missing, not about this repo's install state.
      canRasterize: () => Promise.resolve(true),
    });

    const result = await doctor.diagnose({ compiler: 'latexmk', workspaceRoot: tmp });

    expect(result.ok).toBe(true);
    expect(result.checks.every((c) => c.status === 'ok')).toBe(true);
    expect(result.hints).toEqual([]);
    expect(result.engines).toEqual(['pdflatex', 'xelatex', 'lualatex']);
  });

  it('fails — with a remedy — when the configured compiler is not installed', async () => {
    const canned = eolTeXLive(home, '/usr/local/share/texmf');
    delete canned['latexmk -v'];
    const doctor = new DoctorService({
      run: runner(canned).run,
      now: NOW,
      canWrite: rootOwnedSystemTexmf,
    });

    const result = await doctor.diagnose({ compiler: 'latexmk' });

    expect(result.ok).toBe(false);
    expect(statusOf(result.checks, 'compiler')).toBe('fail');
    expect(result.hints.join('\n')).toContain('not on PATH');
  });

  /**
   * The RHEL case this pair of statuses exists for: tectonic on PATH, no latexmk. Whether that is a
   * `fail` or a `warn` is decided by *who chose* latexmk — a mere default is substituted by
   * `compile`, so nothing the server needs is actually missing.
   */
  function tectonicOnly(): Canned {
    const canned = eolTeXLive(home, SYSTEM_TEXMF);
    delete canned['latexmk -v'];
    canned['tectonic --version'] = 'Tectonic 0.15.0';
    return canned;
  }

  /**
   * The bug report's machine, exactly: RHEL 8 with `tectonic 0.16.9` and `git`, and nothing else —
   * no TeX Live, so no `latexmk`, no `pdflatex`/`xelatex`/`lualatex`, no `tlmgr`, no `kpsewhich`.
   *
   * `tectonicOnly` above is NOT this machine: it is a full TeX Live with `latexmk` deleted, which
   * essentially does not exist (latexmk ships with TeX Live, MacTeX and MiKTeX alike). That table
   * let `ok: true` pass because a TeX install was present, not because the fallback rescued
   * anything — so it could not catch `engines: fail` overriding the compiler `warn`.
   */
  function rhelTectonicOnly(): Canned {
    return {
      'tectonic --version': 'Tectonic 0.16.9',
      'git --version': 'git version 2.39.3',
    };
  }

  it('calls a tectonic-only machine healthy: the fallback compiles, so nothing needed is missing', async () => {
    const doctor = new DoctorService({
      run: runner(rhelTectonicOnly()).run,
      now: NOW,
      canWrite: () => Promise.resolve(true),
    });

    const result = await doctor.diagnose({
      compiler: 'latexmk',
      compilerExplicit: false,
      workspaceRoot: tmp,
    });

    // The point of the whole feature: this machine compiles fine, so `doctor` must not call it
    // broken. A `fail` on any check would sink `ok`, since ok = every(status !== 'fail').
    expect(result.ok).toBe(true);
    expect(statusOf(result.checks, 'compiler')).toBe('warn');
    // Tectonic bundles its own XeTeX, so "no LaTeX engine on PATH" is a category error, not a
    // finding — and it is what used to override the compiler `warn` and report ok: false.
    expect(statusOf(result.checks, 'engines')).toBe('ok');
    expect(result.checks.find((c) => c.name === 'engines')?.detail).toMatch(/tectonic bundles/i);
    // Same for the package manager: tectonic fetches its own packages.
    expect(statusOf(result.checks, 'package-manager')).toBe('ok');
    expect(result.checks.every((c) => c.status !== 'fail')).toBe(true);
  });

  it('still fails a tectonic-only machine when latexmk was the explicit choice', async () => {
    // Just outside the guard: same machine, but the user asserted latexmk, so nothing compiles —
    // and `engines` must not be softened into hiding that.
    const doctor = new DoctorService({
      run: runner(rhelTectonicOnly()).run,
      now: NOW,
      canWrite: () => Promise.resolve(true),
    });

    const result = await doctor.diagnose({
      compiler: 'latexmk',
      compilerExplicit: true,
      workspaceRoot: tmp,
    });

    expect(result.ok).toBe(false);
    expect(statusOf(result.checks, 'compiler')).toBe('fail');
    // No fallback is in play, so the engines check speaks about latexmk's needs, as before.
    expect(statusOf(result.checks, 'engines')).toBe('fail');
  });

  it('does not call a tectonic machine engine-less when tectonic is the configured backend', async () => {
    // The same category error, reachable without any fallback: someone who set
    // WEB_LATEX_MCP_COMPILER=tectonic on a machine with no system TeX was told their toolchain
    // was broken. That predates the fallback and is fixed by the same grading.
    const doctor = new DoctorService({
      run: runner(rhelTectonicOnly()).run,
      now: NOW,
      canWrite: () => Promise.resolve(true),
    });

    const result = await doctor.diagnose({
      compiler: 'tectonic',
      compilerExplicit: true,
      workspaceRoot: tmp,
    });

    expect(result.ok).toBe(true);
    expect(statusOf(result.checks, 'compiler')).toBe('ok');
    expect(statusOf(result.checks, 'engines')).toBe('ok');
  });

  it('claims nothing on behalf of a tectonic that is not installed either', async () => {
    // `effective` stays tectonic when an explicit tectonic is missing, but nothing about what
    // tectonic provides may be asserted on a machine that does not have it.
    const doctor = new DoctorService({
      run: runner({ 'git --version': 'git version 2.39.3' }).run,
      now: NOW,
      canWrite: () => Promise.resolve(true),
    });

    const result = await doctor.diagnose({ compiler: 'tectonic', compilerExplicit: true });

    expect(result.ok).toBe(false);
    expect(statusOf(result.checks, 'engines')).toBe('fail');
    const engines = result.checks.find((c) => c.name === 'engines')?.detail ?? '';
    expect(engines).not.toMatch(/bundles its own/i);
  });

  it('does not warn about a frozen tlmgr repository when tectonic is what compiles', async () => {
    // An EOL TeX Live with latexmk removed and tectonic installed: tectonic never consults tlmgr,
    // so a frozen-archive warning sends the user to fix something that was not going to be used.
    const canned = eolTeXLive(home, SYSTEM_TEXMF);
    delete canned['latexmk -v'];
    canned['tectonic --version'] = 'Tectonic 0.16.9';
    const doctor = new DoctorService({
      run: runner(canned).run,
      now: NOW,
      canWrite: rootOwnedSystemTexmf,
    });

    const result = await doctor.diagnose({ compiler: 'latexmk', compilerExplicit: false });

    expect(result.ok).toBe(true);
    expect(statusOf(result.checks, 'package-manager')).toBe('ok');
    expect(result.hints.join('\n')).not.toMatch(/frozen archive/i);
    // The tlmgr that IS there is still reported, just as not-used rather than as a problem.
    expect(result.checks.find((c) => c.name === 'package-manager')?.detail).toMatch(/not used/i);
  });

  it('warns, rather than failing, when a defaulted compiler is missing but the other is there', async () => {
    const doctor = new DoctorService({
      run: runner(tectonicOnly()).run,
      now: NOW,
      canWrite: rootOwnedSystemTexmf,
    });

    const result = await doctor.diagnose({ compiler: 'latexmk', compilerExplicit: false });

    // A fallback carries the compile, so nothing the server needs is missing.
    expect(statusOf(result.checks, 'compiler')).toBe('warn');
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.name === 'compiler')?.detail).toContain('tectonic');
    // One hint has to carry both halves: that the substitution happens, and what it costs.
    expect(result.hints.some((h) => /falling back/i.test(h) && /no source snippets/i.test(h))).toBe(
      true,
    );
    // Setting the variable makes a backend a *choice*, never a "default" — calling it a default
    // is what builds the wrong model, since "default" is precisely the state that falls back.
    const text = result.hints.join('\n');
    expect(text).not.toMatch(/make it the default/);
    // Unset, empty and whitespace-only all reach here, so "is unset" is false for two of them.
    expect(text).not.toMatch(/is unset/);
    expect(text).toMatch(/names no backend/);
  });

  it('fails instead when the missing compiler was named explicitly, since it is never substituted', async () => {
    const doctor = new DoctorService({
      run: runner(tectonicOnly()).run,
      now: NOW,
      canWrite: rootOwnedSystemTexmf,
    });

    const result = await doctor.diagnose({ compiler: 'latexmk', compilerExplicit: true });

    // Same machine as the test above — only the assertion differs, and it decides the grade.
    expect(statusOf(result.checks, 'compiler')).toBe('fail');
    expect(result.ok).toBe(false);
    expect(
      result.hints.some(
        (h) => h.includes('WEB_LATEX_MCP_COMPILER') && h.includes('compiler: "tectonic"'),
      ),
    ).toBe(true);
  });

  it('fails, claiming no substitute, when neither backend is installed', async () => {
    const canned = eolTeXLive(home, SYSTEM_TEXMF);
    delete canned['latexmk -v'];
    const doctor = new DoctorService({
      run: runner(canned).run,
      now: NOW,
      canWrite: rootOwnedSystemTexmf,
    });

    const result = await doctor.diagnose({ compiler: 'latexmk', compilerExplicit: false });

    expect(statusOf(result.checks, 'compiler')).toBe('fail');
    expect(result.ok).toBe(false);
    // Promising a fallback that is not installed is worse than saying nothing.
    expect(result.hints.some((h) => /falling back/i.test(h))).toBe(false);
    expect(result.hints.join('\n')).toContain('tectonic');
  });

  it('carries the tectonic caveats only when tectonic is the substitute', async () => {
    const canned = eolTeXLive(home, SYSTEM_TEXMF); // latexmk present, tectonic absent
    const doctor = new DoctorService({
      run: runner(canned).run,
      now: NOW,
      canWrite: rootOwnedSystemTexmf,
    });

    const result = await doctor.diagnose({ compiler: 'tectonic', compilerExplicit: false });

    expect(statusOf(result.checks, 'compiler')).toBe('warn');
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.name === 'compiler')?.detail).toContain('latexmk');
    // latexmk honours `engine`, cleans, and logs file:line — none of the caveats apply to it.
    expect(result.hints.some((h) => /XeTeX/i.test(h) || /no source snippets/i.test(h))).toBe(false);
  });

  it('does not probe the other backend when the configured one is there', async () => {
    const { run, calls } = runner(eolTeXLive(home, SYSTEM_TEXMF));
    const doctor = new DoctorService({ run, now: NOW, canWrite: rootOwnedSystemTexmf });

    const result = await doctor.diagnose({ compiler: 'latexmk', compilerExplicit: false });

    // The happy path pays for exactly the probes it paid for before.
    expect(calls.some((c) => c.startsWith('tectonic'))).toBe(false);
    expect(result.checks.find((c) => c.name === 'compiler')?.detail).toBe(
      'latexmk: Latexmk, John Collins, 26 Dec. 2019. Version 4.67',
    );
  });

  it('fails when git is missing, since every sync and push shells out to it', async () => {
    const canned = eolTeXLive(home, '/usr/local/share/texmf');
    delete canned['git --version'];
    const doctor = new DoctorService({
      run: runner(canned).run,
      now: NOW,
      canWrite: rootOwnedSystemTexmf,
    });

    const result = await doctor.diagnose({ compiler: 'latexmk' });

    expect(result.ok).toBe(false);
    expect(statusOf(result.checks, 'git')).toBe('fail');
  });

  it('fails when the workspace root cannot be written to', async () => {
    const { run } = runner(eolTeXLive(home, SYSTEM_TEXMF));
    const doctor = new DoctorService({
      run,
      now: NOW,
      canWrite: writability([SYSTEM_TEXMF, '/read-only']),
    });

    const result = await doctor.diagnose({ compiler: 'latexmk', workspaceRoot: '/read-only' });

    expect(result.ok).toBe(false);
    expect(statusOf(result.checks, 'workspace')).toBe('fail');
    expect(result.hints.join('\n')).toContain('WEB_LATEX_MCP_WORKSPACE');
  });

  it('warns when even your own texmf tree cannot be written to', async () => {
    const { run } = runner(eolTeXLive(home, SYSTEM_TEXMF));
    const doctor = new DoctorService({
      run,
      now: NOW,
      canWrite: writability([SYSTEM_TEXMF, home]),
    });

    const result = await doctor.diagnose({ compiler: 'latexmk' });

    expect(statusOf(result.checks, 'texmf-home')).toBe('warn');
    // With nowhere to install to, the --usermode advice would be a dead end.
    expect(result.hints.join('\n')).not.toContain('--usermode');
  });

  it('touches the network only when asked to', async () => {
    const { run } = runner(eolTeXLive(home, '/usr/local/share/texmf'));
    let fetched = 0;
    const fetchImpl = (): Promise<{ status: number }> => {
      fetched += 1;
      return Promise.resolve({ status: 200 });
    };

    const local = await new DoctorService({
      run,
      now: NOW,
      canWrite: rootOwnedSystemTexmf,
      fetch: fetchImpl,
    }).diagnose({
      compiler: 'latexmk',
    });
    expect(fetched).toBe(0);
    expect(local.checks.find((c) => c.name === 'package-manager')?.detail).not.toContain(
      'reachable',
    );

    const networked = await new DoctorService({
      run,
      now: NOW,
      canWrite: rootOwnedSystemTexmf,
      fetch: fetchImpl,
    }).diagnose({
      compiler: 'latexmk',
      checkRepository: true,
    });
    expect(fetched).toBe(1);
    expect(networked.checks.find((c) => c.name === 'package-manager')?.detail).toContain(
      'reachable (HTTP 200)',
    );
  });

  it('reports an unreachable repository instead of throwing', async () => {
    const canned = eolTeXLive(home, '/usr/local/share/texmf');
    canned['tlmgr option'] =
      'Default package repository (repository): https://mirror.ctan.org/systems/texlive/tlnet';
    const doctor = new DoctorService({
      run: runner(canned).run,
      now: NOW,
      canWrite: rootOwnedSystemTexmf,
      fetch: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
    });

    const result = await doctor.diagnose({ compiler: 'latexmk', checkRepository: true });

    expect(statusOf(result.checks, 'package-manager')).toBe('warn');
    expect(result.checks.find((c) => c.name === 'package-manager')?.detail).toContain(
      'unreachable',
    );
    expect(result.hints.join('\n')).toContain('tlmgr option repository');
  });

  it('recognizes MiKTeX, which installs missing packages on its own', async () => {
    const canned: Canned = {
      'latexmk -v': 'Latexmk, John Collins. Version 4.86',
      'pdflatex --version': 'MiKTeX-pdfTeX 4.15 (MiKTeX 25.4)',
      'mpm --version': 'MiKTeX Package Manager 4.6',
      'kpsewhich -var-value=TEXMFHOME': home,
      'git --version': 'git version 2.46.0',
    };
    const doctor = new DoctorService({
      run: runner(canned).run,
      now: NOW,
      canWrite: rootOwnedSystemTexmf,
    });

    const result = await doctor.diagnose({ compiler: 'latexmk' });

    expect(statusOf(result.checks, 'package-manager')).toBe('ok');
    expect(result.checks.find((c) => c.name === 'package-manager')?.detail).toContain('MiKTeX');
    expect(result.checks.find((c) => c.name === 'distribution')?.detail).toContain('MiKTeX 25.4');
  });

  describe('pdf-render', () => {
    it('reports ok when the native canvas backend is available', async () => {
      const { run } = runner(eolTeXLive(home, '/usr/local/share/texmf'));
      const doctor = new DoctorService({
        run,
        now: NOW,
        canWrite: rootOwnedSystemTexmf,
        canRasterize: () => Promise.resolve(true),
      });

      const result = await doctor.diagnose({ compiler: 'latexmk' });

      expect(statusOf(result.checks, 'pdf-render')).toBe('ok');
      expect(result.hints.join('\n')).not.toContain('@napi-rs/canvas');
    });

    it('warns — with a remedy — when no native canvas backend is installed', async () => {
      const { run } = runner(eolTeXLive(home, '/usr/local/share/texmf'));
      const doctor = new DoctorService({
        run,
        now: NOW,
        canWrite: rootOwnedSystemTexmf,
        canRasterize: () => Promise.resolve(false),
      });

      const result = await doctor.diagnose({ compiler: 'latexmk' });

      expect(statusOf(result.checks, 'pdf-render')).toBe('warn');
      expect(result.hints.join('\n')).toContain('npm i @napi-rs/canvas');
    });

    it('never fails the whole toolchain just because rasterization is missing', async () => {
      const canned = eolTeXLive(home, '/usr/local/share/texmf');
      canned['pdflatex --version'] = 'pdfTeX 3.141592653-2.6-1.40.26 (TeX Live 2026)';
      canned['lualatex --version'] = 'This is LuaHBTeX, Version 1.18.0 (TeX Live 2026)';
      canned['xelatex --version'] = 'XeTeX 3.141592653-2.6-0.999996 (TeX Live 2026)';
      canned['tlmgr option'] =
        'Default package repository (repository): https://mirror.ctan.org/systems/texlive/tlnet';
      const doctor = new DoctorService({
        run: runner(canned).run,
        now: NOW,
        canWrite: rootOwnedSystemTexmf,
        canRasterize: () => Promise.resolve(false),
      });

      const result = await doctor.diagnose({ compiler: 'latexmk', workspaceRoot: tmp });

      // The one thing this test exists to prove: a missing rasterizer must not flip `ok` to false.
      expect(result.ok).toBe(true);
      expect(statusOf(result.checks, 'pdf-render')).toBe('warn');
    });

    it('wires the real probe by default, without throwing', async () => {
      const { run } = runner(eolTeXLive(home, '/usr/local/share/texmf'));
      const doctor = new DoctorService({ run, now: NOW, canWrite: rootOwnedSystemTexmf });

      const result = await doctor.diagnose({ compiler: 'latexmk' });

      expect(['ok', 'warn']).toContain(statusOf(result.checks, 'pdf-render'));
    });
  });
});

/**
 * The real writability probe. Its inputs are chosen to behave identically on Linux, macOS and
 * Windows: a temp directory is always writable, and nothing can ever be created underneath a file.
 * (An earlier version of these fixtures used `/usr/local/share/texmf` and `/dev/null/nope`, which
 * are Linux-shaped assumptions — writable under Homebrew, meaningless on Windows.)
 */
describe('isWritablePath', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'ovl-writable-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('is true for a directory that exists', async () => {
    expect(await isWritablePath(tmp)).toBe(true);
  });

  it('is true for a directory that does not exist yet but could be created', async () => {
    // TEXMFHOME (~/texmf) usually does not exist until the first hand-install.
    expect(await isWritablePath(path.join(tmp, 'texmf', 'tex', 'latex'))).toBe(true);
  });

  it('is false for a file, since a tree cannot live there', async () => {
    const file = path.join(tmp, 'not-a-dir');
    await writeFile(file, 'x');
    expect(await isWritablePath(file)).toBe(false);
  });

  it('is false under a file — the nearest existing ancestor must be a directory', async () => {
    const file = path.join(tmp, 'not-a-dir');
    await writeFile(file, 'x');
    // Without the directory check this returns true whenever the file happens to be writable.
    expect(await isWritablePath(path.join(file, 'nope'))).toBe(false);
  });
});

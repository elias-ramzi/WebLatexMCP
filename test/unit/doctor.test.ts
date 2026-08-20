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

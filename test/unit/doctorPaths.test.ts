import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { DoctorService } from '../../src/services/doctor.js';
import type { ExecResult } from '../../src/lib/exec.js';

/**
 * "File paths are always POSIX (`/`-separated), on every OS" — the first line of docs/tools.md,
 * repeated in CLAUDE.md. `doctor` emitted its directories exactly as `kpsewhich` and the workspace
 * config spelled them, so on Windows the `texmf-home`, `system-texmf` and `workspace` details came
 * back backslashed while every other tool's paths did not.
 *
 * The conversion belongs in `DoctorService`, not in `src/tools/doctor.ts`: the tool is thin over
 * `ctx.doctor.diagnose()` and holds no path of its own, so converting there would mean string
 * surgery keyed on check names — logic in the tool layer, which this repo forbids. So the
 * displayed spelling is computed once, where each `detail` is composed, and reused in every
 * channel it appears in (the `workspace` value appears in a check detail AND in a hint).
 *
 * Non-vacuousness, the same way `test/integration/toolPathsPosix.test.ts` earns it: on Windows
 * `path.sep` is genuinely `'\\'` and nothing has to be arranged. On Linux and macOS `path.sep` is
 * `/`, `toPosix` is the identity, and every assertion below would pass against the unfixed code —
 * so the tests drive `diagnose()` inside `withWindowsSep`, which stubs `path.sep` to a backslash
 * over the narrowest possible window. `path.sep` is a writable, configurable data property of the
 * `node:path` module object, and patching it does not disturb `path.join`/`resolve`/`relative`
 * (their POSIX implementations use a literal `'/'` internally), so only the server's own
 * conversion changes behaviour.
 *
 * Nothing here touches the filesystem: `canWrite` is injected, so the probe paths can be genuine
 * Windows spellings on every platform and the strings converted are the real thing on all three
 * legs.
 */

/**
 * Load Node's async recursive-remove implementation BEFORE any test stubs `path.sep` — see the
 * same warm-up in `test/integration/toolPathsPosix.test.ts`. `internal/fs/rimraf` captures
 * `path.sep` once, at module load, and is loaded lazily on the first recursive `fs.rm`; loading it
 * while the stub is live would break recursive removal for every test sharing this worker.
 */
beforeAll(async () => {
  await rm(path.join(os.tmpdir(), 'web-latex-mcp-rimraf-warmup-does-not-exist'), {
    recursive: true,
    force: true,
  });
});

const WINDOWS = process.platform === 'win32';

/**
 * Run `fn` with `path.sep` stubbed to a backslash, restoring the real descriptor in a `finally` so
 * a failure inside can never leak the stub into another test. On Windows it is a pass-through:
 * `path.sep` is already `'\\'` there.
 */
async function withWindowsSep<T>(fn: () => Promise<T>): Promise<T> {
  if (WINDOWS) return await fn();
  const original = Object.getOwnPropertyDescriptor(path, 'sep');
  Object.defineProperty(path, 'sep', { value: '\\', configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(path, 'sep', original);
  }
}

/** What the server must return for a native path, once the separator is converted. */
function posixOf(native: string): string {
  return native.split('\\').join('/');
}

/* The three values `doctor` actually carries a path in, spelled the way Windows spells them. */
const NATIVE_TEXMF_HOME = 'C:\\Users\\me\\texmf';
const NATIVE_TEXMF_LOCAL = 'C:\\texlive\\2024\\texmf-local';
const NATIVE_WORKSPACE = 'C:\\Users\\me\\.web_latex_mcp';

/**
 * Two probe outputs that LOOK path-ish and are not: a version banner and a repository URL. They
 * carry backslashes on purpose, so an over-broad conversion — one that ran over every `detail`
 * rather than over the three real paths — changes them and the byte-identical assertions below
 * fail. Converting a URL or a `--version` banner would be a regression, not a fix.
 */
const LATEXMK_BANNER = 'Latexmk, John Collins, Version 4.86 [C:\\texlive\\2024\\bin\\latexmk]';
const GIT_BANNER = 'git version 2.46.0.windows.1 (C:\\Program Files\\Git\\cmd\\git.exe)';
const TLMGR_REPOSITORY = 'https://mirror.ctan.org/systems/texlive/tlnet';

function ok(stdout: string): ExecResult {
  return { code: 0, stdout, stderr: '', timedOut: false };
}

/** A stand-in for `execCapture`; unknown commands reject the way an absent binary does. */
function runner(
  canned: Record<string, string>,
): (cmd: string, args: string[]) => Promise<ExecResult> {
  return (cmd, args) => {
    const value = canned[`${cmd} ${args[0] ?? ''}`] ?? canned[cmd];
    if (value === undefined) return Promise.reject(new Error('ENOENT'));
    return Promise.resolve(ok(value));
  };
}

const WINDOWS_TOOLCHAIN: Record<string, string> = {
  'latexmk -v': LATEXMK_BANNER,
  'pdflatex --version': 'pdfTeX 3.141592653-2.6-1.40.26 (TeX Live 2026)',
  'tlmgr --version': 'tlmgr revision 70000 (2026-01-02 00:00:00 +0100)',
  'tlmgr option': `Default package repository (repository): ${TLMGR_REPOSITORY}`,
  'kpsewhich -var-value=TEXMFHOME': NATIVE_TEXMF_HOME,
  'kpsewhich -var-value=TEXMFLOCAL': NATIVE_TEXMF_LOCAL,
  'git --version': GIT_BANNER,
};

const NOW = (): Date => new Date('2026-08-20T00:00:00Z');

interface Probe {
  doctor: DoctorService;
  /** Every argument `canWrite` was handed, in call order. */
  canWriteCalls: string[];
}

/** A doctor whose writability probe records what it is asked about instead of hitting the disk. */
function probeDoctor(notWritable: string[] = []): Probe {
  const canWriteCalls: string[] = [];
  const doctor = new DoctorService({
    run: runner(WINDOWS_TOOLCHAIN),
    now: NOW,
    canWrite: (target) => {
      canWriteCalls.push(target);
      return Promise.resolve(!notWritable.includes(target));
    },
    canRasterize: () => Promise.resolve(true),
  });
  return { doctor, canWriteCalls };
}

function detailOf(checks: Array<{ name: string; detail: string }>, name: string): string {
  return checks.find((c) => c.name === name)?.detail ?? '';
}

describe('doctor: paths at the response boundary', () => {
  it('reports texmf-home, system-texmf and workspace with POSIX separators', async () => {
    const { doctor } = probeDoctor();

    const result = await withWindowsSep(() =>
      doctor.diagnose({ compiler: 'latexmk', workspaceRoot: NATIVE_WORKSPACE }),
    );

    expect(detailOf(result.checks, 'texmf-home')).toBe(`${posixOf(NATIVE_TEXMF_HOME)} (writable)`);
    expect(detailOf(result.checks, 'system-texmf')).toBe(
      `${posixOf(NATIVE_TEXMF_LOCAL)} (writable)`,
    );
    expect(detailOf(result.checks, 'workspace')).toBe(`${posixOf(NATIVE_WORKSPACE)} (writable)`);
    for (const name of ['texmf-home', 'system-texmf', 'workspace']) {
      expect(detailOf(result.checks, name)).not.toContain('\\');
    }
  });

  it('hands the writability probe the NATIVE spelling, never the converted one', async () => {
    // The load-bearing half of WHERE the conversion sits. `canWrite` is `isWritablePath` in
    // production: it `stat`s and `access`es the real filesystem, walking up to the nearest
    // existing ancestor. A conversion moved even one line too early hands it a spelling the host
    // does not use, and on Windows `C:/Users/me/texmf` would be probed instead of the path
    // `kpsewhich` named — silently, since the probe only ever answers true or false. Asserting the
    // reported string looks right cannot catch that; only recording the arguments can.
    const { doctor, canWriteCalls } = probeDoctor();

    await withWindowsSep(() =>
      doctor.diagnose({ compiler: 'latexmk', workspaceRoot: NATIVE_WORKSPACE }),
    );

    expect(canWriteCalls).toEqual([NATIVE_TEXMF_HOME, NATIVE_TEXMF_LOCAL, NATIVE_WORKSPACE]);
    for (const arg of canWriteCalls) {
      expect(arg).toContain('\\');
      expect(arg).not.toContain('/');
    }
  });

  it('renders the workspace hint from the same converted value as the check detail', async () => {
    // The text/structured-drift guard for doctor: the workspace root appears twice — once in the
    // `workspace` check and once in the hint that tells the user to move it — and a second,
    // independent conversion at either site is how the two channels start disagreeing.
    const { doctor } = probeDoctor([NATIVE_WORKSPACE]);

    const result = await withWindowsSep(() =>
      doctor.diagnose({ compiler: 'latexmk', workspaceRoot: NATIVE_WORKSPACE }),
    );

    const workspaceHint = result.hints.find((h) => h.includes('workspace root')) ?? '';
    expect(workspaceHint).toContain(`(${posixOf(NATIVE_WORKSPACE)})`);
    expect(workspaceHint).not.toContain(NATIVE_WORKSPACE);
    expect(detailOf(result.checks, 'workspace')).toBe(
      `${posixOf(NATIVE_WORKSPACE)} (not writable)`,
    );
  });

  it('leaves version banners and the repository URL byte-identical', async () => {
    // Everything else in a diagnosis that looks path-ish is not a path: `compiler` and `git` hold
    // `--version` banner output, and `package-manager`'s repository is a URL. They are returned
    // exactly as the probe produced them, backslashes included.
    const { doctor } = probeDoctor();

    const result = await withWindowsSep(() =>
      doctor.diagnose({ compiler: 'latexmk', workspaceRoot: NATIVE_WORKSPACE }),
    );

    expect(detailOf(result.checks, 'compiler')).toBe(`latexmk: ${LATEXMK_BANNER}`);
    expect(detailOf(result.checks, 'git')).toBe(GIT_BANNER);
    expect(detailOf(result.checks, 'package-manager')).toContain(`repository: ${TLMGR_REPOSITORY}`);
  });
});

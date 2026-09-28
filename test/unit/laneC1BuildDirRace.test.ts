import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import type { ExecResult } from '../../src/lib/exec.js';

/*
 * The per-project build dir is created only under a root that is still the verified one. The
 * compile used to verify the root (`ensureBuildRoot`) and then `mkdir(dir, { recursive: true })`:
 * a root removed in between (a /tmp cleaner) was recreated by that mkdir under the process umask
 * — 0755, or group-writable 0775 under umask 002 — and one replaced by a link in between was
 * followed, so the build went into someone else's directory.
 *
 * The window is forced by wrapping `mkdir`: the first mkdir of the project's build dir runs a
 * planted action first — exactly what another party could do between the check and the mkdir.
 */

const race = vi.hoisted(() => ({
  target: undefined as string | undefined,
  action: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const mkdirHooked = (async (...args: Parameters<typeof actual.mkdir>) => {
    if (race.target !== undefined && String(args[0]) === race.target && race.action) {
      const act = race.action;
      race.action = undefined;
      await act();
    }
    return actual.mkdir(...args);
  }) as typeof actual.mkdir;
  const mocked = { ...actual, mkdir: mkdirHooked };
  return { ...mocked, default: mocked };
});

// The vitest setup file (`buildRootSetup.ts`) imports the compiler before this file's mock is
// registered, so the cached module holds the real `mkdir`: load a fresh copy that sees the mock.
let compiler: typeof import('../../src/services/compiler.js');
beforeAll(async () => {
  vi.resetModules();
  compiler = await import('../../src/services/compiler.js');
});
const buildDir = (p: string): string => compiler.buildDir(p);
const buildRoot = (): string => compiler.buildRoot();

const isWin = process.platform === 'win32';
const cleanups: Array<() => Promise<unknown>> = [];
const savedTmp = process.env.TMPDIR;
afterEach(async () => {
  race.target = undefined;
  race.action = undefined;
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
  for (const c of cleanups.splice(0)) await c();
});

const ok: ExecResult = { code: 0, stdout: '', stderr: '', timedOut: false };

async function privateTmp(): Promise<{ tmp: string; project: string }> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wlm-c1-race-'));
  cleanups.push(() => rm(tmp, { recursive: true, force: true }));
  const project = path.join(tmp, 'project');
  await mkdir(project);
  await writeFile(path.join(project, 'main.tex'), '\\documentclass{article}\n');
  process.env.TMPDIR = tmp;
  return { tmp, project };
}

describe.skipIf(isWin)('the build dir is created only under the verified root', () => {
  for (const [name, make] of [
    ['latexmk', (run: () => Promise<ExecResult>) => new compiler.LatexmkCompiler(run)],
    ['tectonic', (run: () => Promise<ExecResult>) => new compiler.TectonicCompiler(run)],
  ] as const) {
    it(`${name}: a root removed after the check is recreated 0700, never under the umask`, async () => {
      const { project } = await privateTmp();
      race.target = buildDir(project);
      race.action = () => rm(buildRoot(), { recursive: true, force: true });
      await make(() => Promise.resolve(ok)).compile({ projectDir: project, rootFile: 'main.tex' });
      expect(race.action).toBeUndefined(); // the window was actually hit
      expect((await stat(buildRoot())).mode & 0o777).toBe(0o700);
      expect((await stat(buildDir(project))).isDirectory()).toBe(true);
    });

    it(`${name}: a root replaced by a link after the check is refused; nothing runs`, async () => {
      const { tmp, project } = await privateTmp();
      const theirs = path.join(tmp, 'theirs');
      await mkdir(theirs, { mode: 0o777 });
      race.target = buildDir(project);
      race.action = async () => {
        await rm(buildRoot(), { recursive: true, force: true });
        await symlink(theirs, buildRoot());
      };
      let ran = 0;
      const run = () => {
        ran += 1;
        return Promise.resolve(ok);
      };
      await expect(
        make(run).compile({ projectDir: project, rootFile: 'main.tex' }),
      ).rejects.toThrow(/symbolic link/);
      expect(race.action).toBeUndefined();
      expect(ran).toBe(0);
    });

    it(`${name}: a link where the project's build dir goes is refused; nothing runs`, async () => {
      const { tmp, project } = await privateTmp();
      const theirs = path.join(tmp, 'theirs');
      await mkdir(theirs, { mode: 0o777 });
      await mkdir(buildRoot(), { mode: 0o700 });
      await symlink(theirs, buildDir(project));
      let ran = 0;
      const run = () => {
        ran += 1;
        return Promise.resolve(ok);
      };
      await expect(
        make(run).compile({ projectDir: project, rootFile: 'main.tex' }),
      ).rejects.toThrow(/symbolic link/);
      expect(ran).toBe(0);
      expect(await readdir(theirs)).toEqual([]);
    });
  }

  it('a caller-given outDir: a root the recursive mkdir recreated is judged again', async () => {
    // An overlay's `<variant>/out` sits several levels under the root, so it keeps its recursive
    // mkdir — and a root that mkdir recreated in a group-writable form is refused, not built in.
    const { project } = await privateTmp();
    const outDir = path.join(buildDir(project), 'variants', 'v000000000000', 'out');
    race.target = outDir;
    race.action = async () => {
      await rm(buildRoot(), { recursive: true, force: true });
      await mkdir(buildRoot(), { mode: 0o777 });
      // mkdir's mode is masked by the umask; force the group/other write bits.
      await (await import('node:fs/promises')).chmod(buildRoot(), 0o777);
    };
    let ran = 0;
    const run = () => {
      ran += 1;
      return Promise.resolve(ok);
    };
    await expect(
      new compiler.LatexmkCompiler(run).compile({
        projectDir: project,
        rootFile: 'main.tex',
        outDir,
      }),
    ).rejects.toThrow(/WRITE access/);
    expect(race.action).toBeUndefined();
    expect(ran).toBe(0);
  });
});

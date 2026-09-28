import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { LatexmkCompiler, TectonicCompiler, buildRoot } from '../../src/services/compiler.js';
import type { ExecResult } from '../../src/lib/exec.js';

/*
 * #215 end to end at the backend boundary: a build root another party planted is refused before
 * the backend runs and before anything is created under it. Uses only the long-standing exports
 * (`buildRoot`, the compilers), so it runs — and fails for the right reason — against the code
 * before the fix, whose root was a fixed shared name that it `mkdir -p`ed straight through.
 *
 * `os.tmpdir()` reads TMPDIR on every call (POSIX), so pointing TMPDIR at a private temp dir moves
 * the build root there for this test only and never touches the machine's real one.
 */

const isWin = process.platform === 'win32';
const cleanups: Array<() => Promise<unknown>> = [];
const savedTmp = process.env.TMPDIR;
afterEach(async () => {
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
  for (const c of cleanups.splice(0)) await c();
});

const ok: ExecResult = { code: 0, stdout: '', stderr: '', timedOut: false };

async function privateTmp(): Promise<{ tmp: string; project: string }> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wlm-rootplant-'));
  cleanups.push(() => rm(tmp, { recursive: true, force: true }));
  const project = path.join(tmp, 'project');
  await mkdir(project);
  await writeFile(path.join(project, 'main.tex'), '\\documentclass{article}\n');
  process.env.TMPDIR = tmp;
  return { tmp, project };
}

describe.skipIf(isWin)('a compile refuses a planted build root (#215)', () => {
  for (const [name, make] of [
    ['latexmk', (run: () => Promise<ExecResult>) => new LatexmkCompiler(run)],
    ['tectonic', (run: () => Promise<ExecResult>) => new TectonicCompiler(run)],
  ] as const) {
    it(`${name}: a symbolic link at the root is refused; nothing runs, nothing is written`, async () => {
      const { tmp, project } = await privateTmp();
      expect(path.dirname(buildRoot())).toBe(tmp);
      // Somewhere "another user" controls; the link sits where the server's root would be.
      const theirs = path.join(tmp, 'theirs');
      await mkdir(theirs, { mode: 0o777 });
      await symlink(theirs, buildRoot());
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

  it('a root this user left group/world-readable is tightened to 0700 before the build', async () => {
    const { project } = await privateTmp();
    await mkdir(buildRoot());
    await chmod(buildRoot(), 0o755);
    await new LatexmkCompiler(() => Promise.resolve(ok)).compile({
      projectDir: project,
      rootFile: 'main.tex',
    });
    expect((await stat(buildRoot())).mode & 0o777).toBe(0o700);
  });

  it('a root this user left group/world-WRITABLE is refused, not tightened, and nothing runs', async () => {
    // Another user could have placed entries in it while it was open; a chmod would vouch for
    // none of them.
    const { project } = await privateTmp();
    await mkdir(buildRoot());
    await chmod(buildRoot(), 0o777);
    let ran = 0;
    await expect(
      new LatexmkCompiler(() => {
        ran += 1;
        return Promise.resolve(ok);
      }).compile({ projectDir: project, rootFile: 'main.tex' }),
    ).rejects.toThrow(/group or other WRITE access/);
    expect(ran).toBe(0);
    expect((await stat(buildRoot())).mode & 0o777).toBe(0o777);
    expect(await readdir(buildRoot())).toEqual([]);
  });

  it('a fresh root is created 0700', async () => {
    const { project } = await privateTmp();
    await new LatexmkCompiler(() => Promise.resolve(ok)).compile({
      projectDir: project,
      rootFile: 'main.tex',
    });
    expect((await stat(buildRoot())).mode & 0o777).toBe(0o700);
  });

  it('a TMPDIR that does not exist is refused in words, and is not created', async () => {
    // The root's mkdir is not recursive, so this surfaced as a raw `ENOENT: … mkdir` from every
    // compile; it now names the missing temp dir and says what to do.
    const { tmp, project } = await privateTmp();
    const missing = path.join(tmp, 'no-such-tmp');
    process.env.TMPDIR = missing;
    let ran = 0;
    const err = await new LatexmkCompiler(() => {
      ran += 1;
      return Promise.resolve(ok);
    })
      .compile({ projectDir: project, rootFile: 'main.tex' })
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain(`Refusing to use build root ${buildRoot()}`);
    expect((err as Error).message).toContain(`${missing}, does not exist`);
    expect((err as Error).message).toContain('Point TMPDIR (TEMP on Windows) at an existing');
    expect(ran).toBe(0);
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

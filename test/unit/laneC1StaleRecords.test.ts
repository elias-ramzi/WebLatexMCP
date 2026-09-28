import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import {
  LatexmkCompiler,
  TectonicCompiler,
  buildDir,
  buildRoot,
} from '../../src/services/compiler.js';
import type { ExecResult } from '../../src/lib/exec.js';

/*
 * Tectonic writes only `<job>.pdf` and `<job>.log` into `--outdir` (checked with tectonic 0.17:
 * no `.aux`, no `.fls` without `--keep-intermediates`), and leaves whatever else sits there. So a
 * tectonic compile into a build dir latexmk used before kept latexmk's `<job>.aux` beside the new
 * PDF: the label route resolved pages from a foreign `.aux`, and neither stale-PDF signal fired
 * (the `.aux` is older than the PDF, and tectonic's own closing record agrees with it). The other
 * direction too: latexmk's database then called the tectonic PDF up to date and kept it, beside
 * its own old `.aux`, until something removed that `.aux`.
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
const STALE = ['main.aux', 'main.fls', 'main.log', 'main.synctex.gz', 'main.fdb_latexmk'];

async function present(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** A project whose root is `paper/main.tex`, and its build dir as latexmk left it. */
async function stagedLatexmkBuild(): Promise<{ tmp: string; project: string; out: string }> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wlm-c1-stale-'));
  cleanups.push(() => rm(tmp, { recursive: true, force: true }));
  process.env.TMPDIR = tmp;
  const project = path.join(tmp, 'project');
  await mkdir(path.join(project, 'paper'), { recursive: true });
  await writeFile(path.join(project, 'paper', 'main.tex'), '\\documentclass{article}\n');
  await mkdir(buildRoot(), { mode: 0o700 });
  const out = buildDir(project);
  await mkdir(out, { mode: 0o700 });
  for (const name of STALE) await writeFile(path.join(out, name), `latexmk's ${name}\n`);
  await writeFile(path.join(out, 'main.pdf'), '%PDF latexmk\n');
  return { tmp, project, out };
}

describe.skipIf(isWin)(
  'a tectonic compile never leaves another run’s records beside its PDF',
  () => {
    it('removes the root job’s .aux/.fls/.log/.synctex.gz/.fdb_latexmk before tectonic runs', async () => {
      const { project, out } = await stagedLatexmkBuild();
      const seenAtRun: string[] = [];
      const run = async (): Promise<ExecResult> => {
        for (const name of STALE) if (await present(path.join(out, name))) seenAtRun.push(name);
        // What tectonic writes with --keep-logs: the PDF and the log, nothing else.
        await writeFile(path.join(out, 'main.pdf'), '%PDF tectonic\n');
        await writeFile(path.join(out, 'main.log'), 'tectonic log\n');
        return ok;
      };
      await new TectonicCompiler(run).compile({ projectDir: project, rootFile: 'paper/main.tex' });
      expect(seenAtRun).toEqual([]);
      for (const name of ['main.aux', 'main.fls', 'main.synctex.gz', 'main.fdb_latexmk']) {
        expect(await present(path.join(out, name)), name).toBe(false);
      }
      expect(await readFile(path.join(out, 'main.log'), 'utf8')).toBe('tectonic log\n');
    });

    it('a failed tectonic run leaves no latexmk .aux or .log to be read as its own', async () => {
      const { project, out } = await stagedLatexmkBuild();
      const outcome = await new TectonicCompiler(() =>
        Promise.resolve({ code: 1, stdout: 'boom', stderr: '', timedOut: false }),
      ).compile({ projectDir: project, rootFile: 'paper/main.tex' });
      expect(await present(path.join(out, 'main.aux'))).toBe(false);
      expect(outcome.logPath).toBeUndefined();
      expect(outcome.log).not.toContain("latexmk's");
    });

    it('removes a link at such a name without following it', async () => {
      const { tmp, project, out } = await stagedLatexmkBuild();
      const outside = path.join(tmp, 'outside.aux');
      await writeFile(outside, 'not the build’s\n');
      await rm(path.join(out, 'main.aux'));
      await symlink(outside, path.join(out, 'main.aux'));
      await new TectonicCompiler(() => Promise.resolve(ok)).compile({
        projectDir: project,
        rootFile: 'paper/main.tex',
      });
      expect(await present(path.join(out, 'main.aux'))).toBe(false);
      expect(await readFile(outside, 'utf8')).toBe('not the build’s\n');
    });

    it('a latexmk compile keeps its own records (it rewrites them itself)', async () => {
      const { project, out } = await stagedLatexmkBuild();
      await new LatexmkCompiler(() => Promise.resolve(ok)).compile({
        projectDir: project,
        rootFile: 'paper/main.tex',
      });
      for (const name of STALE) expect(await present(path.join(out, name)), name).toBe(true);
    });
  },
);

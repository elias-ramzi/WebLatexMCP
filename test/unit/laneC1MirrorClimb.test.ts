import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { mirrorSubdirsForRoot } from '../../src/services/compiler.js';

/*
 * `mirrorSubdirsForRoot` decides whether the root file's directory lies inside the project with
 * `climbsOut` (#227), the one shared test for "a `path.relative` result leaves its base". The bug
 * shape it rules out is `rel.startsWith('..')`, which also matches an in-project directory whose
 * name begins with two dots: `..foo/main.tex` would then be treated as outside, its subtree left
 * unmirrored, and `\include{chap/c1}` from it would fail with "I can't write on file".
 */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function tempDir(prefix: string): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

describe('mirrorSubdirsForRoot: a root under a `..`-prefixed directory name is inside', () => {
  it('mirrors `..foo/`’s subtree at the build dir’s root', async () => {
    const project = await tempDir('wlm-c1-climb-proj-');
    const build = await tempDir('wlm-c1-climb-build-');
    await mkdir(path.join(project, '..foo', 'chap'), { recursive: true });
    await mirrorSubdirsForRoot(project, build, '..foo/main.tex');
    // The project-root mirror gives `<build>/..foo/chap`; only the root-directory mirror gives
    // `<build>/chap`, which is what `-cd` into `..foo/` writes `chap/c1.aux` against.
    expect(await isDir(path.join(build, 'chap'))).toBe(true);
  });

  it('still skips a root that really climbs out', async () => {
    const parent = await tempDir('wlm-c1-climb-parent-');
    const project = path.join(parent, 'project');
    await mkdir(project);
    await mkdir(path.join(parent, 'outside', 'secret'), { recursive: true });
    const build = await tempDir('wlm-c1-climb-build-');
    await mirrorSubdirsForRoot(project, build, '../outside/main.tex');
    expect(await isDir(path.join(build, 'secret'))).toBe(false);
  });
});

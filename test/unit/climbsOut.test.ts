import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { climbsOut, resolveInside } from '../../src/lib/paths.js';
import { parseSyncTexEdit } from '../../src/services/synctex.js';
import { parseLog } from '../../src/services/logParser.js';
import { excludeWorkspaceFromHostGit } from '../../src/lib/workspaceExclude.js';
import { readAuxFloats } from '../../src/lib/auxFloats.js';
import { buildAuxPath, buildDir } from '../../src/services/compiler.js';

/**
 * #227: seven containment checks read `path.relative(...)` with `rel.startsWith('..')`, which also
 * matches a directory whose NAME begins with two dots — `..foo/main.tex` is inside, not above. Each
 * site below gets its own `..foo/` case (the regression) and, where the site is a guard, a real
 * climb (`../x`, `..`) that must still be refused. Paths are built with `path.join`/`path.sep`, so
 * the same assertions hold on Windows.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
}

describe('climbsOut', () => {
  it('is true only for `..` as a whole first segment', () => {
    expect(climbsOut('..')).toBe(true);
    expect(climbsOut(`..${path.sep}x`)).toBe(true);
    // A POSIX-joined result climbs too, on every host (Windows callers toPosix first).
    expect(climbsOut('../x')).toBe(true);
    expect(climbsOut('..foo')).toBe(false);
    expect(climbsOut(`..foo${path.sep}main.tex`)).toBe(false);
    expect(climbsOut('..foo/main.tex')).toBe(false);
    expect(climbsOut('...')).toBe(false);
    expect(climbsOut('')).toBe(false);
    expect(climbsOut('a/../..')).toBe(false); // not a path.relative shape; judged on the head only
  });
});

describe('resolveInside (src/lib/paths.ts)', () => {
  const root = path.resolve(os.tmpdir(), 'proj');

  it('accepts a path under a directory named `..foo`', () => {
    expect(resolveInside(root, '..foo/main.tex')).toBe(path.join(root, '..foo', 'main.tex'));
    expect(resolveInside(root, '..foo')).toBe(path.join(root, '..foo'));
  });

  it('still refuses a real climb', () => {
    expect(() => resolveInside(root, '../x.tex')).toThrow(/escapes the project root/);
    expect(() => resolveInside(root, '..')).toThrow(/escapes the project root/);
    expect(() => resolveInside(root, 'a/../../x.tex')).toThrow(/escapes the project root/);
    // The root itself stays allowed, as before.
    expect(resolveInside(root, '')).toBe(root);
  });
});

describe('parseSyncTexEdit (src/services/synctex.ts)', () => {
  const projectDir = path.resolve(os.tmpdir(), 'proj');
  const out = (input: string) =>
    `SyncTeX result begin\nInput:${input}\nLine:7\nSyncTeX result end\n`;

  it('keeps the project-relative path of a file under `..foo/`', () => {
    const input = path.join(projectDir, '..foo', 'main.tex');
    expect(parseSyncTexEdit(out(input), projectDir)).toEqual({ file: '..foo/main.tex', line: 7 });
  });

  it('still falls back to the basename for a file outside the project', () => {
    const outside = path.join(path.dirname(projectDir), 'x.tex');
    expect(parseSyncTexEdit(out(outside), projectDir)).toEqual({ file: 'x.tex', line: 7 });
    // `..` exactly: the project's parent itself.
    const parent = path.dirname(projectDir);
    expect(parseSyncTexEdit(out(parent), projectDir)).toEqual({
      file: path.basename(parent),
      line: 7,
    });
  });
});

describe('parseLog rebase (src/services/logParser.ts)', () => {
  const log = './main.tex:3: Undefined control sequence.';

  it('rebases onto a root directory named `..foo`', () => {
    expect(parseLog(log, { baseDir: '..foo' }).errors[0]?.file).toBe('..foo/main.tex');
    // Reached by normalization, too: paper/../..foo/main.tex.
    const up = '../..foo/main.tex:3: Undefined control sequence.';
    expect(parseLog(up, { baseDir: 'paper' }).errors[0]?.file).toBe('..foo/main.tex');
  });

  it('still leaves a path that climbs out of the project un-rebased', () => {
    const climb = '../../x.tex:3: Undefined control sequence.';
    expect(parseLog(climb, { baseDir: 'paper' }).errors[0]?.file).toBe('../../x.tex');
  });
});

describe('excludeWorkspaceFromHostGit (src/lib/workspaceExclude.ts)', () => {
  it('excludes a workspace dir named `..foo`', async () => {
    const repo = await tmp('wlm-climb-');
    await mkdir(path.join(repo, '.git', 'info'), { recursive: true });
    const pattern = await excludeWorkspaceFromHostGit(path.join(repo, '..foo'));
    expect(pattern).toBe('/..foo/');
    expect(await readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '/..foo/\n',
    );
  });

  it('still writes nothing for a workspace that resolves above the repo', async () => {
    const repo = await tmp('wlm-climb-');
    await mkdir(path.join(repo, '.git', 'info'), { recursive: true });
    // Unnormalized on purpose: its dirname resolves to `repo`, the path itself to repo's parent,
    // so the relative path is exactly `..`.
    const above = `${repo}${path.sep}a${path.sep}..${path.sep}..`;
    expect(await excludeWorkspaceFromHostGit(above)).toBeUndefined();
    await expect(readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).rejects.toThrow();
  });
});

describe('readAuxFloats \\@input under a `..foo/` build subdirectory (src/lib/auxFloats.ts)', () => {
  it('reads a chapter .aux that sits in `..foo/`', async () => {
    const dir = await tmp('auxclimb-');
    const build = buildDir(dir);
    cleanups.push(() => rm(build, { recursive: true, force: true }));
    await mkdir(path.join(build, '..foo'), { recursive: true });
    await writeFile(
      buildAuxPath(dir, 'main.tex'),
      '\\relax \n\\@input{..foo/one.aux}\n\\newlabel{fig:back}{{9}{9}}\n',
    );
    await writeFile(path.join(build, '..foo', 'one.aux'), '\\newlabel{fig:one}{{1.1}{2}}\n');

    const result = await readAuxFloats(dir, 'main.tex');
    expect(result.floats.map((f) => f.label)).toEqual(['fig:one', 'fig:back']);
    expect(result.unreadInputs).toBe(0);
    expect(result.note).toBeUndefined();
  });

  // The component walk refuses `..` before the realpath re-check in `readListedAux` ever runs, and
  // that re-check's climb arm is reachable only by swapping a listed directory for a link between
  // the listing and the read — a race with no deterministic trigger. So this pins the refusal the
  // whole path gives, and `climbsOut`'s own cases above pin the predicate the re-check now uses.
  it('still refuses an \\@input that climbs out of the build dir', async () => {
    const dir = await tmp('auxclimb-');
    const build = buildDir(dir);
    cleanups.push(() => rm(build, { recursive: true, force: true }));
    await mkdir(build, { recursive: true });
    await writeFile(buildAuxPath(dir, 'main.tex'), '\\relax \n\\@input{../out.aux}\n');

    const result = await readAuxFloats(dir, 'main.tex');
    expect(result.floats).toEqual([]);
    expect(result.unreadInputs).toBe(1);
  });
});

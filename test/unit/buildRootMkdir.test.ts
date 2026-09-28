import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import {
  buildDir,
  buildRoot,
  buildRootLevels,
  ensureBuildRoot,
  mirrorSubdirs,
  outDirFor,
} from '../../src/services/compiler.js';
import { PdfRenderer } from '../../src/services/pdfRender.js';
import type { PdfjsLoader } from '../../src/services/pdfRender.js';

/*
 * Nothing below the build root is made by a recursive mkdir. The subdirectory mirror and
 * `render_pages`' PNG dir each followed their caller's `ensureBuildRoot` with
 * `mkdir(dir, { recursive: true })`, so a root a /tmp cleaner removed in between came back under
 * the process umask (0755, or 0775 under umask 002), and a root replaced by a link was followed
 * into someone else's directory. Both now go through `mkdirUnderBuildRoot`.
 *
 * The root is simply absent (or a link) when the call starts — the state a cleaner leaves right
 * after the caller's check passed.
 */

const isWin = process.platform === 'win32';

/** `ensureBuildRoot`, counted. */
function countingEnsure(): { calls: () => number; ensureRoot: (root: string) => Promise<string> } {
  let n = 0;
  return { calls: () => n, ensureRoot: (root) => (n++, ensureBuildRoot(root)) };
}

/** A project with `width` directories at each of `depth` levels (width + width² + … in all). */
async function wideTree(project: string, width: number, depth: number): Promise<number> {
  let count = 0;
  const grow = async (dir: string, level: number): Promise<void> => {
    if (level === depth) return;
    for (let i = 0; i < width; i++) {
      const sub = path.join(dir, `d${i}`);
      await mkdir(sub);
      count++;
      await grow(sub, level + 1);
    }
  };
  await grow(project, 0);
  return count;
}
const cleanups: Array<() => Promise<unknown>> = [];
const savedTmp = process.env.TMPDIR;
afterEach(async () => {
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
  for (const c of cleanups.splice(0)) await c();
});

async function privateTmp(): Promise<{ tmp: string; project: string; theirs: string }> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wlm-mkdir-root-'));
  cleanups.push(() => rm(tmp, { recursive: true, force: true }));
  const project = path.join(tmp, 'project');
  await mkdir(path.join(project, 'figs', 'sub'), { recursive: true });
  await writeFile(path.join(project, 'main.tex'), '\\documentclass{article}\n');
  const theirs = path.join(tmp, 'theirs');
  await mkdir(theirs);
  process.env.TMPDIR = tmp;
  return { tmp, project, theirs };
}

/** A pdf.js stand-in with a zero-page document: `render` makes its dir and draws nothing. */
const emptyPdfjs: PdfjsLoader = () =>
  Promise.resolve({
    getDocument: () => ({
      promise: Promise.resolve({ numPages: 0 } as never),
      destroy: () => Promise.resolve(),
    }),
    OPS: {} as never,
  });

async function renderInto(tmp: string, outDir: string): Promise<void> {
  const pdfPath = path.join(tmp, 'doc.pdf');
  await writeFile(pdfPath, '%PDF-1.4\n');
  await new PdfRenderer(emptyPdfjs, () => true).render({ pdfPath, outDir });
}

describe.skipIf(isWin)('build dirs below the root are never made by a recursive mkdir', () => {
  it('mirrorSubdirs: a removed root is recreated 0700, never under the umask', async () => {
    const { project } = await privateTmp();
    await expect(stat(buildRoot())).rejects.toThrow();
    await mirrorSubdirs(project, buildDir(project));
    expect((await stat(buildRoot())).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(buildDir(project), 'figs', 'sub'))).isDirectory()).toBe(true);
  });

  it('mirrorSubdirs: a root replaced by a link is refused; nothing lands there', async () => {
    const { project, theirs } = await privateTmp();
    await symlink(theirs, buildRoot());
    await expect(mirrorSubdirs(project, buildDir(project))).rejects.toThrow(/symbolic link/);
    expect(await readdir(theirs)).toEqual([]);
  });

  it("render_pages' PNG dir: a removed root is recreated 0700, never under the umask", async () => {
    const { tmp, project } = await privateTmp();
    await expect(stat(buildRoot())).rejects.toThrow();
    const outDir = path.join(buildDir(project), 'render');
    await renderInto(tmp, outDir);
    expect((await stat(buildRoot())).mode & 0o777).toBe(0o700);
    expect((await stat(outDir)).isDirectory()).toBe(true);
  });

  it("render_pages' PNG dir: a root replaced by a link is refused; nothing lands there", async () => {
    const { tmp, project, theirs } = await privateTmp();
    await symlink(theirs, buildRoot());
    await expect(renderInto(tmp, path.join(buildDir(project), 'render'))).rejects.toThrow(
      /symbolic link/,
    );
    expect(await readdir(theirs)).toEqual([]);
  });

  it('a dir outside the build root is still made recursively, as asked', async () => {
    const { tmp, project } = await privateTmp();
    const outside = path.join(tmp, 'elsewhere', 'deep', 'out');
    await mirrorSubdirs(project, outside);
    expect((await stat(path.join(outside, 'figs', 'sub'))).isDirectory()).toBe(true);
    await renderInto(tmp, path.join(tmp, 'png', 'deep'));
    expect((await stat(path.join(tmp, 'png', 'deep'))).isDirectory()).toBe(true);
  });
});

describe.skipIf(isWin)('the subdirectory mirror judges the build root once per mirror', () => {
  it('ensureBuildRoot is called O(1) times per mirror, not once or twice per directory', async () => {
    const { tmp } = await privateTmp();
    const counts: number[] = [];
    for (const [width, depth] of [
      [1, 1],
      [6, 3],
    ] as const) {
      const project = await mkdtemp(path.join(tmp, 'tree-'));
      const dirs = await wideTree(project, width, depth);
      const counter = countingEnsure();
      await mirrorSubdirs(project, buildDir(project), { ensureRoot: counter.ensureRoot });
      counts.push(counter.calls());
      // Every directory was still mirrored, 0700, under a root that is still 0700.
      const deepest = path.join(buildDir(project), ...Array.from({ length: depth }, () => 'd0'));
      expect((await stat(deepest)).isDirectory()).toBe(true);
      expect((await stat(deepest)).mode & 0o777).toBe(0o700);
      expect(dirs).toBe(width === 1 ? 1 : 6 + 36 + 216);
    }
    expect((await stat(buildRoot())).mode & 0o777).toBe(0o700);
    // 258 directories cost what one does: the root is judged at the start and at the end.
    expect(counts[1]).toBe(counts[0]);
    expect(counts[1]).toBeLessThanOrEqual(4);
  });

  it('a root removed mid-mirror is recreated 0700 the verified way, not followed', async () => {
    const { project } = await privateTmp();
    let removed = false;
    await mirrorSubdirs(project, buildDir(project), {
      ensureRoot: async (root) => {
        const r = await ensureBuildRoot(root);
        // A /tmp cleaner right after the mirror's first check.
        if (!removed) {
          removed = true;
          await rm(root, { recursive: true, force: true });
        }
        return r;
      },
    });
    expect((await stat(buildRoot())).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(buildDir(project), 'figs', 'sub'))).isDirectory()).toBe(true);
  });
});

describe.skipIf(isWin)(
  'outDirFor: the compile build dir is made under a still-verified root',
  () => {
    it('a root removed after the check (twice) is recreated 0700, never under the umask', async () => {
      const { project } = await privateTmp();
      let calls = 0;
      const dir = await outDirFor(
        { projectDir: project, rootFile: 'main.tex' },
        {
          ensureRoot: async (root) => {
            const r = await ensureBuildRoot(root);
            // Removed right after outDirFor's own check and again after mkdirUnderBuildRoot's first,
            // so the first level's mkdir meets ENOENT and has to recreate the root itself.
            if (++calls <= 2) await rm(root, { recursive: true, force: true });
            return r;
          },
        },
      );
      expect(dir).toBe(buildDir(project));
      expect((await stat(buildRoot())).mode & 0o777).toBe(0o700);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    });
  },
);

describe('the level walk below the build root (pure)', () => {
  const winRoot = 'C:\\Users\\Me\\AppData\\Local\\Temp\\web-latex-mcp-build-me';

  it('on win32 it stops at a differently-cased spelling of the root, never walking to the drive', () => {
    const dir = 'c:\\users\\me\\appdata\\local\\temp\\WEB-LATEX-MCP-BUILD-ME\\proj-1\\variants';
    const where = buildRootLevels(winRoot, dir, path.win32);
    expect(where).toEqual({
      kind: 'below',
      abs: dir,
      levels: ['c:\\users\\me\\appdata\\local\\temp\\WEB-LATEX-MCP-BUILD-ME\\proj-1', dir],
    });
    expect(buildRootLevels(winRoot, winRoot.toUpperCase(), path.win32)).toEqual({ kind: 'root' });
  });

  it('on POSIX a differently-cased root is another directory: outside, made as asked', () => {
    const root = '/tmp/web-latex-mcp-build-1000';
    expect(buildRootLevels(root, '/TMP/web-latex-mcp-build-1000/x', path.posix)).toEqual({
      kind: 'outside',
      abs: '/TMP/web-latex-mcp-build-1000/x',
    });
    expect(buildRootLevels(root, `${root}/a/b`, path.posix)).toEqual({
      kind: 'below',
      abs: `${root}/a/b`,
      levels: [`${root}/a`, `${root}/a/b`],
    });
    // A POSIX name holding a backslash is one level, not two.
    expect(buildRootLevels(root, `${root}/out\\dir`, path.posix)).toEqual({
      kind: 'below',
      abs: `${root}/out\\dir`,
      levels: [`${root}/out\\dir`],
    });
  });
});

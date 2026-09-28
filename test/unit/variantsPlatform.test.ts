/**
 * Overlay variants: the platform edge cases of #214 (the case fold decided by the filesystem, a
 * junction that cannot point at a network path, the skip list judged by realpath), the eviction
 * tie-break of #216, and the project root's `.git` watch of #228.
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { link, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import {
  applyOverlay,
  buildLinkFarm,
  evictVariants,
  junctionFailureMessage,
  junctionRefusal,
  overlayFilesNeverRead,
  overlaySnippetReader,
  probeCaseInsensitive,
  readManifest,
  snapshotSource,
  sourceChangedHint,
  sourceChanges,
  stageVariant,
  variantPaths,
  writeManifest,
} from '../../src/lib/variants.js';
import { buildDir, buildRoot } from '../../src/services/compiler.js';
import { FileService } from '../../src/services/fileService.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(
    () => rm(dir, { recursive: true, force: true }),
    () => rm(buildDir(dir), { recursive: true, force: true }),
  );
  return dir;
}

async function put(root: string, rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), content);
}

const linuxOnly = it.skipIf(process.platform !== 'linux');
const linkDir = (target: string, at: string) => symlink(target, at, 'junction');
const sensitive = async (): Promise<boolean> => false;
const insensitive = async (): Promise<boolean> => true;
const edit = { oldString: 'x', newString: 'y' };
/** A reader that fails the test if the overlay reads anything at all. */
const noReads = {
  readTextExact: () => Promise.reject(new Error('read a file before refusing')),
  linkTarget: () => Promise.reject(new Error('resolved a link before refusing')),
};

describe('the case fold is the filesystem’s, not the platform’s (#214.1)', () => {
  linuxOnly('probes a directory by experiment, leaving nothing behind', async () => {
    const dir = path.join(await tempDir('ovl-probe-'), 'variants');
    // Linux's temp directory is case-sensitive; the probe creates the directory it asks about.
    expect(await probeCaseInsensitive(dir)).toBe(false);
    expect(await readdir(dir)).toEqual([]);
    // Cached per directory: asked again, it writes nothing new.
    expect(await probeCaseInsensitive(dir)).toBe(false);
  });

  linuxOnly(
    'overlays two files differing only in case on a case-sensitive filesystem, even as darwin',
    async () => {
      const src = await tempDir('ovl-case-');
      await put(src, 'Notes.tex', 'x upper\n');
      await put(src, 'notes.tex', 'x lower\n');
      // The platform alone used to decide: `darwin` folded, and refused two different files.
      const out = await applyOverlay(
        new FileService(),
        src,
        [
          { file: 'Notes.tex', edits: [edit] },
          { file: 'notes.tex', edits: [{ oldString: 'x', newString: 'z' }] },
        ],
        { platform: 'darwin' },
      );
      expect(out.get('Notes.tex')).toBe('y upper\n');
      expect(out.get('notes.tex')).toBe('z lower\n');
    },
  );

  it('refuses a case variant, before reading anything, where the farm folds case', async () => {
    const src = await tempDir('ovl-case-');
    await expect(
      applyOverlay(
        noReads,
        src,
        [
          { file: 'main.tex', edits: [edit] },
          { file: 'Main.tex', edits: [edit] },
        ],
        { platform: 'linux', caseProbe: insensitive },
      ),
    ).rejects.toThrow('Overlay entry 2 names "Main.tex", the same file as entry 1 ("main.tex")');
  });

  it('refuses a latexmk rc file under any case, whatever the filesystem says', async () => {
    const src = await tempDir('ovl-case-rc-');
    for (const file of ['LatexMkRc', 'paper/.LATEXMKRC']) {
      await expect(
        applyOverlay(noReads, src, [{ file, edits: [edit] }], {
          platform: 'linux',
          caseProbe: sensitive,
        }),
      ).rejects.toThrow(/is a latexmk configuration file/);
    }
  });

  it('calls an overlay unread when the build opened another case of it on a case-sensitive farm', async () => {
    const src = await tempDir('ovl-case-fls-');
    const paths = variantPaths(src, 'v0123456789ab');
    await mkdir(paths.out, { recursive: true });
    await mkdir(paths.src, { recursive: true });
    await writeFile(
      path.join(paths.out, 'main.fls'),
      `PWD ${paths.src}\nINPUT ./main.tex\nINPUT ./sections/b.tex\n`,
    );
    const files = ['Sections/B.tex'];
    // On a case-sensitive farm `sections/b.tex` is another file: the overlay was never read.
    expect(
      await overlayFilesNeverRead(paths, 'main.tex', files, {
        platform: 'darwin',
        caseProbe: sensitive,
      }),
    ).toEqual(['Sections/B.tex']);
    // On a case-insensitive one it IS the overlaid file.
    expect(
      await overlayFilesNeverRead(paths, 'main.tex', files, {
        platform: 'linux',
        caseProbe: insensitive,
      }),
    ).toEqual([]);
  });

  it('serves a case variant the overlay only where the farm folds case', async () => {
    const src = await tempDir('ovl-case-snip-');
    await put(src, 'sections/b.tex', 'on disk\n');
    // A second name for the same file: already that entry on a case-insensitive filesystem, a
    // hard link elsewhere.
    await link(path.join(src, 'sections/b.tex'), path.join(src, 'sections/B.tex')).catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err;
      },
    );
    const contents = new Map([['sections/b.tex', 'in memory\n']]);
    const folding = overlaySnippetReader(new FileService(), contents, {
      platform: 'linux',
      caseProbe: insensitive,
    });
    expect((await folding.read(src, { path: 'sections/B.tex' })).content).toBe('in memory\n');
    // A case-sensitive farm held `sections/B.tex` apart: TeX read the unedited file, so its
    // snippet is withheld rather than numbered against the overlay.
    const exact = overlaySnippetReader(new FileService(), contents, {
      platform: 'darwin',
      caseProbe: sensitive,
    });
    await expect(exact.read(src, { path: 'sections/B.tex' })).rejects.toThrow(
      /is the overlaid file "sections\/b\.tex" under another name/,
    );
  });
});

describe('the case probe on the CI temp volumes', () => {
  // The positive branch: macOS's and Windows' default temp volumes are case-insensitive, so the
  // probe must say so there, or every fold decision on those legs silently goes case-sensitive.
  it.skipIf(process.platform === 'linux')(
    'says a case-insensitive temp volume is case-insensitive',
    async () => {
      const dir = path.join(await tempDir('ovl-probe-ci-'), 'variants');
      expect(await probeCaseInsensitive(dir)).toBe(true);
      expect(await readdir(dir)).toEqual([]);
    },
  );
});

describe('the default case probe writes only in a verified build root (#215 rule)', () => {
  const posixOnly = it.skipIf(process.platform === 'win32');

  /** Run `fn` with the OS temp dir (and so the build root) moved under `tmp`. */
  async function withTmpdir<T>(tmp: string, fn: () => Promise<T>): Promise<T> {
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  }

  async function twoEntryProject(): Promise<string> {
    const src = await tempDir('ovl-root-src-');
    await put(src, 'main.tex', 'x\n');
    await put(src, 'other.tex', 'x\n');
    return src;
  }
  const twoEntries = [
    { file: 'main.tex', edits: [edit] },
    { file: 'other.tex', edits: [edit] },
  ];

  posixOnly('refuses a planted build root before creating or writing anything in it', async () => {
    const src = await twoEntryProject();
    const tmp = await tempDir('ovl-root-tmp-');
    const theirs = await tempDir('ovl-root-theirs-');
    const root = await withTmpdir(tmp, async () => buildRoot());
    // Another local user got there first: the build root is a link to a directory they own.
    await symlink(theirs, root);
    await expect(
      withTmpdir(tmp, () => applyOverlay(new FileService(), src, twoEntries)),
    ).rejects.toThrow(/Refusing to build in .*symbolic link/);
    // Nothing named after the project, and no probe file, ever landed in their directory.
    expect(await readdir(theirs)).toEqual([]);
  });

  posixOnly('creates a missing build root owner-only before probing in it', async () => {
    const src = await twoEntryProject();
    const tmp = await tempDir('ovl-root-fresh-');
    const root = await withTmpdir(tmp, async () => {
      const out = await applyOverlay(new FileService(), src, twoEntries);
      expect([...out.keys()].sort()).toEqual(['main.tex', 'other.tex']);
      return buildRoot();
    });
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
  });
});

describe('a win32 junction cannot point at a network path (#214.2)', () => {
  it('refuses a UNC or device target in words naming the entry, and allows a drive path', () => {
    for (const target of [
      '\\\\server\\share\\paper\\figs',
      '//server/share/paper/figs',
      '\\\\?\\UNC\\server\\share\\paper\\figs',
      '\\\\.\\C:\\paper\\figs',
    ]) {
      const why = junctionRefusal(target, 'figs');
      expect(why, target).toMatch(
        /^An overlay compile links the directory "figs" into its private build tree, and on Windows a directory is linked with a junction, which can only point at a local drive/,
      );
      expect(why, target).toContain('moving it onto a local drive if it is remote');
    }
    // Each is named as what it is: a device path (`\\.\C:\…`) is not a network path.
    expect(junctionRefusal('\\\\server\\share\\paper\\figs', 'figs')).toContain('a network path');
    expect(junctionRefusal('\\\\?\\UNC\\server\\share\\figs', 'figs')).toContain('a network path');
    const device = junctionRefusal('\\\\.\\C:\\paper\\figs', 'figs');
    expect(device).toContain('a device path');
    expect(device).not.toContain('network');
    for (const target of ['C:\\paper\\figs', 'c:/paper/figs', '\\\\?\\C:\\paper\\figs', '/tmp/p']) {
      expect(junctionRefusal(target, 'figs'), target).toBeUndefined();
    }
  });

  it('blames the drive for a failed junction only on the code that can mean it', () => {
    const einval = junctionFailureMessage('figs', 'EINVAL');
    expect(einval).toContain('"figs"');
    expect(einval).toContain('(a junction: EINVAL)');
    expect(einval).toContain('move the project onto a local drive');
    for (const code of ['EPERM', 'EACCES', 'ENOSPC', undefined]) {
      const why = junctionFailureMessage('figs', code);
      expect(why, String(code)).toContain(`(a junction: ${code ?? 'unknown error'})`);
      expect(why, String(code)).not.toMatch(/drive/);
    }
  });
});

describe('the farm’s skip list is judged by realpath (#214.3)', () => {
  it('leaves out a skip directory spelled through a link, and one the project is reached through a link for', async () => {
    const src = await tempDir('ovl-skipreal-');
    const aliases = await tempDir('ovl-skipreal-alias-');
    await put(src, 'main.tex', 'main');
    await put(src, 'ws/registry.json', '{}');
    await put(src, 'ws/clone/x.tex', 'x');
    const alias = path.join(aliases, 'proj');
    await linkDir(src, alias);

    // The workspace root named through a link to the project.
    const farm1 = path.join(await tempDir('ovl-skipreal-dst-'), 'src');
    await buildLinkFarm(src, farm1, { skip: [path.join(alias, 'ws')] });
    expect((await readdir(farm1)).sort()).toEqual(['main.tex']);

    // The project named through the link, the workspace by its real path.
    const farm2 = path.join(await tempDir('ovl-skipreal-dst-'), 'src');
    await buildLinkFarm(alias, farm2, { skip: [path.join(src, 'ws')] });
    expect((await readdir(farm2)).sort()).toEqual(['main.tex']);
  });
});

describe('eviction breaks a usedAt tie on seq (#216.1)', () => {
  it('stamps each staged variant with the next seq, and keeps the latest of one millisecond', async () => {
    const src = await tempDir('ovl-seq-');
    await put(src, 'main.tex', 'main');
    const now = new Date(Date.UTC(2026, 0, 1));
    // Handles compiled in an order that neither name order follows: listed ascending, the others
    // read v2 v3 v4 v5 v7 v8 v9 with seqs 1 3 5 0 6 2 4, so keeping the first three by listing
    // order (or the last three) keeps the wrong ones. Only seq picks v7, v4, v9.
    const handles = ['5', '2', '8', '3', '9', '4', '7', '6'].map((d) => `v00000000000${d}`);
    for (const handle of handles) {
      await stageVariant({
        projectDir: src,
        handle,
        rootFile: 'main.tex',
        engine: 'pdflatex',
        compiler: 'latexmk',
        contents: new Map(),
        skip: [],
        now,
      });
    }
    const seqs = await Promise.all(
      handles.map(async (h) => (await readManifest(variantPaths(src, h).manifest))?.seq),
    );
    expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const current = handles.at(-1)!;
    // Keep 4: the current one and the three compiled just before it, all in one millisecond.
    const removed = await evictVariants(src, 4, current);
    expect(removed.sort()).toEqual(handles.slice(0, 4).sort());
    expect((await readdir(path.join(buildDir(src), 'variants'))).sort()).toEqual(
      handles.slice(4).sort(),
    );
  });

  it('sorts a manifest without seq oldest among its equal-usedAt peers, and usedAt first', async () => {
    const src = await tempDir('ovl-seq-old-');
    const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
    const write = async (handle: string, usedAt: string, seq?: number) => {
      const p = variantPaths(src, handle);
      await mkdir(p.out, { recursive: true });
      await writeManifest(p.manifest, {
        rootFile: 'main.tex',
        createdAt: usedAt,
        usedAt,
        ...(seq === undefined ? {} : { seq }),
        files: [],
        compiler: 'latexmk',
        engine: 'pdflatex',
      });
    };
    const current = 'v0000000000cc';
    await write(current, at(0), 0);
    await write('v000000000001', at(5)); // no seq: older than its tie
    await write('v000000000002', at(5), 3);
    await write('v000000000003', at(5), 1);
    await write('v000000000004', at(9), 0); // latest usedAt wins over any seq
    await write('v000000000005', at(1), 9);
    const removed = await evictVariants(src, 4, current);
    // Newest first: 004 (usedAt 9), 002 (5, seq 3), 003 (5, seq 1), 001 (5, no seq), 005 (1).
    expect(removed.sort()).toEqual(['v000000000001', 'v000000000005']);
  });
});

describe("the project root's .git: hooks, config and info are watched (#228)", () => {
  it('reports a write into .git/hooks, .git/config and .git/info, and not git’s own churn', async () => {
    const src = await tempDir('ovl-git-');
    await put(src, 'main.tex', 'main\n');
    await put(src, '.git/HEAD', 'ref: refs/heads/master\n');
    await put(src, '.git/config', '[core]\n');
    await put(src, '.git/index', 'index');
    await put(src, '.git/hooks/pre-commit.sample', '#!/bin/sh\n');
    await put(src, '.git/info/exclude', '# exclude\n');
    await put(src, '.git/objects/ab/cdef', 'blob');
    await put(src, 'sub/.git/hooks/pre-commit.sample', '#!/bin/sh\n');
    const before = await snapshotSource(src, { skip: [] });

    // What git itself moves on every call: never reported.
    await writeFile(path.join(src, '.git/index'), 'index moved');
    await writeFile(path.join(src, '.git/HEAD'), 'ref: refs/heads/other\n');
    await put(src, '.git/objects/12/3456', 'new blob');
    await put(src, '.git/logs/HEAD', 'log');
    // A nested repository's `.git` stays out whole.
    await put(src, 'sub/.git/hooks/post-checkout', '#!/bin/sh\n');
    expect(sourceChanges(before!, (await snapshotSource(src, { skip: [] }))!)).toEqual([]);

    // What the next git command runs, or reads a command from: reported.
    await put(src, '.git/hooks/post-checkout', '#!/bin/sh\necho pwned\n');
    await writeFile(path.join(src, '.git/config'), '[core]\n\tfsmonitor = "echo pwned"\n');
    await writeFile(path.join(src, '.git/info/exclude'), '*\n');
    expect(sourceChanges(before!, (await snapshotSource(src, { skip: [] }))!)).toEqual([
      '.git/config',
      '.git/hooks/post-checkout',
      '.git/info/exclude',
    ]);
  });

  it('reports a write to a .git file (a worktree’s gitfile)', async () => {
    const src = await tempDir('ovl-gitfile-');
    await put(src, 'main.tex', 'main\n');
    await put(src, '.git', 'gitdir: /somewhere/.git/worktrees/x\n');
    const before = await snapshotSource(src, { skip: [] });
    expect(before!.entries.has('.git')).toBe(true);
    await writeFile(path.join(src, '.git'), 'gitdir: /elsewhere\n');
    expect(sourceChanges(before!, (await snapshotSource(src, { skip: [] }))!)).toEqual(['.git']);
  });

  it('reports hooks created in a .git the build made', async () => {
    const src = await tempDir('ovl-gitnew-');
    await put(src, 'main.tex', 'main\n');
    const before = await snapshotSource(src, { skip: [] });
    await put(src, '.git/hooks/post-checkout', '#!/bin/sh\n');
    expect(sourceChanges(before!, (await snapshotSource(src, { skip: [] }))!)).toEqual([
      '.git/hooks',
      '.git/hooks/post-checkout',
    ]);
  });

  it('tells the caller that status, diff and discard do not reach a .git path', () => {
    const hint = sourceChangedHint(['.git/hooks/post-checkout', 'main.tex']);
    expect(hint).toContain('".git/hooks/post-checkout"');
    expect(hint).toContain(
      "A path under .git is the repository's own — its hooks, config or info/ — which status, " +
        'diff and discard never show or restore',
    );
    expect(sourceChangedHint(['main.tex', 'sub/.git/x'])).not.toContain('A path under .git');
  });
});

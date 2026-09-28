/**
 * Overlay variants: the platform edge cases of #214 (the case fold decided by the filesystem, a
 * junction that cannot point at a network path, the skip list judged by realpath), the eviction
 * tie-break of #216, the project root's `.git` watch of #228, and a farm that never lets one
 * project entry replace another (two names a case-insensitive temp directory holds as one).
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {
  applyOverlay,
  buildLinkFarm,
  evictVariants,
  farmCollisionMessage,
  farmTwinMessage,
  junctionFailureMessage,
  junctionRefusal,
  overlayFilesNeverRead,
  overlaySnippetReader,
  placeOverlayFile,
  probeCaseInsensitive,
  readManifest,
  snapshotSource,
  sourceChangedHint,
  sourceChanges,
  stageVariant,
  variantPaths,
  writeManifest,
} from '../../src/lib/variants.js';
import type { CaseProbe } from '../../src/lib/variants.js';
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

describe('a farm never lets one project entry replace another', () => {
  const posixOnly = it.skipIf(process.platform === 'win32');
  const refused =
    /The overlay compile is refused rather than let one replace the other\. A compile without overlay reads its sources from the project itself/;
  /** The EEXIST backstop's words: an entry already there, blamed on an alias, never on case alone. */
  const backstop =
    /already held an entry under the name .* most likely an alias .*case or Unicode normalisation, or a Windows 8\.3 short name/;

  /** A probe that answers `answer` and records every directory it was asked about. */
  function countingProbe(answer: boolean): { probe: CaseProbe; dirs: string[] } {
    const dirs: string[] = [];
    return {
      dirs,
      probe: async (dir) => {
        dirs.push(dir);
        return answer;
      },
    };
  }

  /** Every regular file under `farm`, followed through its links, read as its source reads. */
  async function expectFarmMatchesSource(farm: string, src: string): Promise<number> {
    let seen = 0;
    const walk = async (rel: string): Promise<void> => {
      let names: string[];
      try {
        names = await readdir(path.join(farm, rel));
      } catch {
        return;
      }
      for (const name of names) {
        const r = rel === '' ? name : `${rel}/${name}`;
        const st = await lstat(path.join(farm, r));
        if (st.isDirectory()) await walk(r);
        else {
          expect(await readFile(path.join(farm, r), 'utf8'), r).toBe(
            await readFile(path.join(src, r), 'utf8'),
          );
          seen++;
        }
      }
    };
    await walk('');
    return seen;
  }

  linuxOnly(
    'refuses two files, or two directories, differing only in case where the farm folds case',
    async () => {
      const src = await tempDir('ovl-twins-');
      await put(src, 'main.tex', 'main\n');
      await put(src, 'sec/Notes.tex', 'upper\n');
      await put(src, 'sec/notes.tex', 'lower\n');
      const farm = path.join(await tempDir('ovl-twins-dst-'), 'src');
      await expect(buildLinkFarm(src, farm, { skip: [], caseProbe: insensitive })).rejects.toThrow(
        /cannot hold both "sec\/Notes\.tex" and "sec\/notes\.tex"/,
      );
      await expect(
        buildLinkFarm(src, `${farm}2`, { skip: [], caseProbe: insensitive }),
      ).rejects.toThrow(refused);
      // Refused before either twin was created: nothing in the farm was replaced.
      await expectFarmMatchesSource(farm, src);
      await expect(readdir(path.join(farm, 'sec'))).resolves.toEqual([]);

      const dirs = await tempDir('ovl-twins-dirs-');
      await put(dirs, 'Figs/a.pdf', 'a\n');
      await put(dirs, 'figs/b.pdf', 'b\n');
      await expect(
        buildLinkFarm(dirs, path.join(await tempDir('ovl-twins-dst-'), 'src'), {
          skip: [],
          caseProbe: insensitive,
        }),
      ).rejects.toThrow(/cannot hold both "Figs" and "figs"/);

      // NTFS and APFS fold Unicode case too, so a non-ASCII pair is refused up front as well —
      // not left to the EEXIST backstop, which could not name the pair before the first link.
      const accented = await tempDir('ovl-twins-accent-');
      await put(accented, 'Été.tex', 'upper\n');
      await put(accented, 'été.tex', 'lower\n');
      const accentFarm = path.join(await tempDir('ovl-twins-dst-'), 'src');
      await expect(
        buildLinkFarm(accented, accentFarm, { skip: [], caseProbe: insensitive }),
      ).rejects.toThrow(refused);
      await expect(readdir(accentFarm)).resolves.toEqual([]);
    },
  );

  linuxOnly(
    'refuses twins under a linked directory an overlay placement materialises',
    async () => {
      const src = await tempDir('ovl-twins-mat-');
      const shared = await tempDir('ovl-twins-shared-');
      await put(src, 'main.tex', 'main\n');
      await put(shared, 'x.tex', 'x\n');
      await put(shared, 'A.tex', 'upper\n');
      await put(shared, 'a.tex', 'lower\n');
      await symlink(shared, path.join(src, 'lib'));
      const farm = path.join(await tempDir('ovl-twins-mat-dst-'), 'src');
      await buildLinkFarm(src, farm, { skip: [], caseProbe: insensitive });
      await expect(
        placeOverlayFile(farm, src, 'lib/x.tex', 'edited\n', { caseProbe: insensitive }),
      ).rejects.toThrow(/cannot hold both "lib\/A\.tex" and "lib\/a\.tex"/);
      // Refused before the farm was touched: `lib` is still the link the farm made, not a
      // half-materialised directory (or no entry at all) left behind by the refusal.
      expect((await lstat(path.join(farm, 'lib'))).isSymbolicLink()).toBe(true);
      expect(await readFile(path.join(farm, 'lib', 'x.tex'), 'utf8')).toBe('x\n');
      expect((await readdir(shared)).sort()).toEqual(['A.tex', 'a.tex', 'x.tex']);
    },
  );

  it('probes the farm only when two names fold together, and at most once per check', async () => {
    // No folding pair, in the farm or in a directory an overlay materialises: no probe at all.
    const plain = await tempDir('ovl-probe-plain-');
    const plainShared = await tempDir('ovl-probe-plain-shared-');
    await put(plain, 'main.tex', 'main\n');
    await put(plain, 'sec/Intro.tex', 'intro\n');
    await put(plain, 'sec/outro.tex', 'outro\n');
    await put(plainShared, 'x.tex', 'x\n');
    await put(plainShared, 'y.tex', 'y\n');
    await linkDir(plainShared, path.join(plain, 'lib'));
    const quiet = countingProbe(true);
    const plainFarm = path.join(await tempDir('ovl-probe-dst-'), 'src');
    await buildLinkFarm(plain, plainFarm, { skip: [], caseProbe: quiet.probe });
    await placeOverlayFile(plainFarm, plain, 'lib/x.tex', 'edited\n', { caseProbe: quiet.probe });
    expect(quiet.dirs).toEqual([]);
    expect(await readFile(path.join(plainFarm, 'lib', 'x.tex'), 'utf8')).toBe('edited\n');
  });

  linuxOnly('asks the probe once for a farm with several folding pairs', async () => {
    // Two pairs in two directories of one farm, and two in two directories one overlay
    // placement materialises: each check asks once, in the directory the farm is built in.
    const src = await tempDir('ovl-probe-pairs-');
    const shared = await tempDir('ovl-probe-pairs-shared-');
    await put(src, 'a/Notes.tex', 'upper\n');
    await put(src, 'a/notes.tex', 'lower\n');
    await put(src, 'b/Figs/a.pdf', 'a\n');
    await put(src, 'b/figs/b.pdf', 'b\n');
    await put(shared, 'A.tex', 'upper\n');
    await put(shared, 'a.tex', 'lower\n');
    await put(shared, 'sub/B.tex', 'upper\n');
    await put(shared, 'sub/b.tex', 'lower\n');
    await put(shared, 'sub/x.tex', 'x\n');
    await symlink(shared, path.join(src, 'lib'));
    const farmParent = await tempDir('ovl-probe-pairs-dst-');
    const farm = path.join(farmParent, 'src');

    const keeps = countingProbe(false);
    await buildLinkFarm(src, farm, { skip: [], caseProbe: keeps.probe });
    expect(keeps.dirs).toEqual([farmParent]);
    const placing = countingProbe(false);
    await placeOverlayFile(farm, src, 'lib/sub/x.tex', 'edited\n', { caseProbe: placing.probe });
    expect(placing.dirs).toEqual([farmParent]);
    expect(await readFile(path.join(farm, 'lib', 'sub', 'b.tex'), 'utf8')).toBe('lower\n');

    const folds = countingProbe(true);
    await expect(
      buildLinkFarm(src, path.join(await tempDir('ovl-probe-pairs-dst-'), 'src'), {
        skip: [],
        caseProbe: folds.probe,
      }),
    ).rejects.toThrow(/cannot hold both/);
    expect(folds.dirs).toHaveLength(1);
  });

  linuxOnly(
    'leaves a dangling link out of the win32 pair check, as the win32 farm leaves it out',
    async () => {
      // win32 places no entry for a dangling link, so `notes.tex -> nowhere` beside `Notes.tex`
      // is one entry in the farm, not two, and nothing asks the probe; POSIX links it, so the
      // same pair is still refused there.
      const src = await tempDir('ovl-dangling-');
      await put(src, 'Notes.tex', 'upper\n');
      await symlink(path.join(src, 'nowhere.tex'), path.join(src, 'notes.tex'));
      const win = countingProbe(true);
      const winFarm = path.join(await tempDir('ovl-dangling-dst-'), 'src');
      await buildLinkFarm(src, winFarm, { skip: [], platform: 'win32', caseProbe: win.probe });
      expect(await readdir(winFarm)).toEqual(['Notes.tex']);
      expect(await readFile(path.join(winFarm, 'Notes.tex'), 'utf8')).toBe('upper\n');
      expect(win.dirs).toEqual([]);

      await expect(
        buildLinkFarm(src, path.join(await tempDir('ovl-dangling-dst-'), 'src'), {
          skip: [],
          platform: 'linux',
          caseProbe: insensitive,
        }),
      ).rejects.toThrow(/cannot hold both "Notes\.tex" and "notes\.tex"/);
    },
  );

  linuxOnly('mirrors both, each with its own content, where the farm keeps case', async () => {
    const src = await tempDir('ovl-twins-cs-');
    await put(src, 'sec/Notes.tex', 'upper\n');
    await put(src, 'sec/notes.tex', 'lower\n');
    await put(src, 'Figs/a.pdf', 'a\n');
    await put(src, 'figs/b.pdf', 'b\n');
    const farm = path.join(await tempDir('ovl-twins-cs-dst-'), 'src');
    await buildLinkFarm(src, farm, { skip: [], caseProbe: sensitive });
    expect(await readFile(path.join(farm, 'sec/Notes.tex'), 'utf8')).toBe('upper\n');
    expect(await readFile(path.join(farm, 'sec/notes.tex'), 'utf8')).toBe('lower\n');
    expect(await expectFarmMatchesSource(farm, src)).toBe(4);
  });

  it('on win32 never copies over, or hard-links onto, an entry the farm already holds', async () => {
    const src = await tempDir('ovl-excl-');
    await put(src, 'locked.tex', 'source locked\n');
    await put(src, 'open.tex', 'source open\n');
    await chmod(path.join(src, 'locked.tex'), 0o444);
    cleanups.push(() => chmod(path.join(src, 'locked.tex'), 0o644).catch(() => undefined));
    // Each farm already holds the entry — what a second name for it leaves on a case-insensitive
    // temp directory. A read-only file is copied; a writable one is hard-linked, then copied when
    // that fails: neither may replace what is there.
    for (const name of ['locked.tex', 'open.tex']) {
      const farm = path.join(await tempDir('ovl-excl-dst-'), 'src');
      await put(farm, name, 'already in the farm\n');
      await expect(
        buildLinkFarm(src, farm, { skip: [], platform: 'win32', caseProbe: sensitive }),
        name,
      ).rejects.toThrow(backstop);
      expect(await readFile(path.join(farm, name), 'utf8'), name).toBe('already in the farm\n');
    }
  });

  posixOnly('turns an EEXIST from symlink or mkdir into the worded refusal', async () => {
    const src = await tempDir('ovl-eexist-');
    await put(src, 'main.tex', 'main\n');
    await put(src, 'sub/x.tex', 'x\n');
    for (const [rel, plant] of [
      ['main.tex', (farm: string) => put(farm, 'main.tex', 'planted\n')],
      ['sub', (farm: string) => mkdir(path.join(farm, 'sub'), { recursive: true })],
    ] as const) {
      const farm = path.join(await tempDir('ovl-eexist-dst-'), 'src');
      await plant(farm);
      const err = await buildLinkFarm(src, farm, {
        skip: [],
        platform: 'linux',
        caseProbe: sensitive,
      }).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err?.message, rel).toMatch(refused);
      expect(err?.message, rel).toMatch(backstop);
      expect(err?.message, rel).toContain(`"${rel}"`);
      expect(err?.message, rel).not.toMatch(/^EEXIST/);
    }
  });

  linuxOnly(
    'names the entry already there when the directory holds it under another name',
    async () => {
      // A hard link stands in for a case-insensitive directory: two names, one entry.
      const src = await tempDir('ovl-eexist-twin-');
      await put(src, 'notes.tex', 'lower\n');
      const farm = path.join(await tempDir('ovl-eexist-twin-dst-'), 'src');
      await put(farm, 'notes.tex', 'planted\n');
      await link(path.join(farm, 'notes.tex'), path.join(farm, 'Notes.tex'));
      const err = await buildLinkFarm(src, farm, {
        skip: [],
        platform: 'linux',
        caseProbe: sensitive,
      }).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toMatch(backstop);
      expect(err?.message).toContain(
        'under the name "notes.tex" (it holds that entry as "Notes.tex")',
      );
      // An EEXIST is not evidence of a case pair: the up-front refusal's words are not borrowed.
      expect(err?.message).not.toMatch(/cannot hold both|differ only in case as one name/);
    },
  );

  it('words an unexplained EEXIST as an entry already there, not as a case pair', () => {
    const unnamed = farmCollisionMessage('sec/NOTESF~1.TEX');
    expect(unnamed).toMatch(backstop);
    expect(unnamed).toMatch(refused);
    expect(unnamed).toContain('under the name "sec/NOTESF~1.TEX" when');
    expect(unnamed).not.toMatch(
      /cannot hold both|differ only in case as one name|holds that entry/,
    );
    const twins = farmTwinMessage('sec/notes.tex', 'sec/Notes.tex');
    expect(twins).toContain(
      'cannot hold both "sec/Notes.tex" and "sec/notes.tex": it treats names that differ only in case as one name',
    );
    expect(twins).toMatch(refused);
    expect(twins).not.toMatch(backstop);
  });
});

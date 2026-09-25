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
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {
  applyOverlay,
  buildLinkFarm,
  evictVariants,
  isVariantHandle,
  overlayFilesNeverRead,
  overlaySnippetReader,
  parseFdbSources,
  parseFls,
  placeOverlayFile,
  readVariant,
  resolveVariantBuild,
  stageVariant,
  touchVariant,
  variantHandle,
  variantPaths,
  writeManifest,
  MAX_VARIANTS,
} from '../../src/lib/variants.js';
import type { VariantKey } from '../../src/lib/variants.js';
import { buildDir } from '../../src/services/compiler.js';
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

async function put(root: string, rel: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), content);
}

/** Every regular file under `dir` (links are followed only when `follow`), rel -> bytes. */
async function snapshot(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) out.set(path.relative(dir, abs), await readFile(abs));
    }
  };
  await walk(dir);
  return out;
}

async function expectSame(before: Map<string, Buffer>, after: Map<string, Buffer>): Promise<void> {
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [rel, bytes] of before) expect(after.get(rel)?.equals(bytes), rel).toBe(true);
}

// Creating a FILE symlink in the source project needs a privilege (or developer mode) on Windows,
// which CI runners do not grant, so only those tests are POSIX-only. A directory link is made as a
// junction (`linkDir`), which needs no privilege there and is an ordinary symlink elsewhere.
const isWin = process.platform === 'win32';
const posixOnly = it.skipIf(isWin);
const linkDir = (target: string, at: string) => symlink(target, at, 'junction');

const KEY: VariantKey = {
  rootFile: 'paper/main.tex',
  compiler: 'latexmk',
  overlay: [{ file: 'paper/a.tex', edits: [{ oldString: 'x', newString: 'y' }] }],
};

describe('variantHandle / isVariantHandle', () => {
  it('is deterministic, normalises paths, and changes with every input', () => {
    const h = variantHandle(KEY);
    expect(isVariantHandle(h)).toBe(true);
    expect(variantHandle({ ...KEY })).toBe(h);
    expect(
      variantHandle({
        ...KEY,
        rootFile: './paper/main.tex',
        engine: 'pdflatex',
        shellEscape: false,
        overlay: [{ file: './paper/./a.tex', edits: [{ oldString: 'x', newString: 'y' }] }],
      }),
    ).toBe(h);
    const variants: VariantKey[] = [
      { ...KEY, rootFile: 'paper/other.tex' },
      { ...KEY, engine: 'xelatex' },
      { ...KEY, compiler: 'tectonic' },
      { ...KEY, shellEscape: true },
      { ...KEY, restrictedShellEscape: true },
      { ...KEY, overlay: [{ file: 'paper/b.tex', edits: [{ oldString: 'x', newString: 'y' }] }] },
      { ...KEY, overlay: [{ file: 'paper/a.tex', edits: [{ oldString: 'x', newString: 'z' }] }] },
      {
        ...KEY,
        overlay: [
          { file: 'paper/b.tex', edits: [{ oldString: 'x', newString: 'y' }] },
          { file: 'paper/a.tex', edits: [{ oldString: 'x', newString: 'y' }] },
        ],
      },
      {
        ...KEY,
        overlay: [
          { file: 'paper/a.tex', edits: [{ oldString: 'x', newString: 'y' }] },
          { file: 'paper/b.tex', edits: [{ oldString: 'x', newString: 'y' }] },
        ],
      },
    ];
    const handles = variants.map(variantHandle);
    expect(new Set([h, ...handles]).size).toBe(handles.length + 1);
  });

  it('rejects anything but v + 12 lowercase hex', () => {
    for (const bad of [
      '../x',
      'v123',
      'V0123456789ab',
      'v0123456789AB',
      'v0123456789ab/',
      'v0123456789ab/..',
      'v0123456789abc',
      '',
    ]) {
      expect(isVariantHandle(bad), bad).toBe(false);
      expect(() => variantPaths('/p', bad), bad).toThrow(/Not a variant handle/);
    }
    expect(isVariantHandle('v0123456789ab')).toBe(true);
    const paths = variantPaths('/p', 'v0123456789ab');
    expect(paths.root).toBe(path.join(buildDir('/p'), 'variants', 'v0123456789ab'));
  });
});

describe('buildLinkFarm', () => {
  posixOnly('mirrors directories and links every file to its absolute source path', async () => {
    const src = await tempDir('ovl-farm-src-');
    const farm = path.join(await tempDir('ovl-farm-dst-'), 'src');
    await put(src, 'paper/main.tex', 'main');
    await put(src, 'paper/sections/a.tex', 'a');
    await put(src, 'shared/defs.tex', 'defs');
    await put(src, '.git/HEAD', 'ref');
    await put(src, 'ws/registry.json', '{}');
    await put(src, 'ws/clone/x.tex', 'x');

    const n = await buildLinkFarm(src, farm, { skip: [path.join(src, 'ws')] });

    expect((await lstat(path.join(farm, 'paper'))).isDirectory()).toBe(true);
    expect((await lstat(path.join(farm, 'paper/sections'))).isDirectory()).toBe(true);
    for (const rel of ['paper/main.tex', 'paper/sections/a.tex', 'shared/defs.tex']) {
      expect((await lstat(path.join(farm, rel))).isSymbolicLink(), rel).toBe(true);
      expect(await readlink(path.join(farm, rel)), rel).toBe(path.join(src, rel));
    }
    await expect(lstat(path.join(farm, '.git'))).rejects.toThrow();
    await expect(lstat(path.join(farm, 'ws'))).rejects.toThrow();
    // paper, paper/main.tex, paper/sections, paper/sections/a.tex, shared, shared/defs.tex
    expect(n).toBe(6);
  });

  it('links a symlinked source directory as ONE link and never walks it', async () => {
    const src = await tempDir('ovl-farm-src-');
    const outside = await tempDir('ovl-farm-out-');
    const farm = path.join(await tempDir('ovl-farm-dst-'), 'src');
    await put(outside, 'figs/deep/f.tex', 'fig');
    await put(src, 'main.tex', 'main');
    await linkDir(path.join(outside, 'figs'), path.join(src, 'figs'));

    const n = await buildLinkFarm(src, farm, { skip: [] });

    expect((await lstat(path.join(farm, 'figs'))).isSymbolicLink()).toBe(true);
    if (!isWin) expect(await readlink(path.join(farm, 'figs'))).toBe(path.join(src, 'figs'));
    expect(await readFile(path.join(farm, 'figs/deep/f.tex'), 'utf8')).toBe('fig');
    expect(n).toBe(2); // main.tex and figs: nothing under the link was walked
  });

  posixOnly('links a file symlink to the entry, not to its target', async () => {
    const src = await tempDir('ovl-farm-src-');
    const farm = path.join(await tempDir('ovl-farm-dst-'), 'src');
    await put(src, 'main.tex', 'main');
    // A relative link inside the project: the farm's link targets the entry, not its target.
    await symlink('main.tex', path.join(src, 'alias.tex'));

    await buildLinkFarm(src, farm, { skip: [] });

    expect(await readlink(path.join(farm, 'alias.tex'))).toBe(path.join(src, 'alias.tex'));
    expect(await readFile(path.join(farm, 'alias.tex'), 'utf8')).toBe('main');
  });

  it('refuses a tree with more entries than the cap', async () => {
    const src = await tempDir('ovl-farm-src-');
    const farm = path.join(await tempDir('ovl-farm-dst-'), 'src');
    for (const f of ['a', 'b', 'c', 'd']) await put(src, `${f}.tex`, f);
    await expect(buildLinkFarm(src, farm, { skip: [], maxEntries: 3 })).rejects.toThrow(
      /more than 3 files and directories; an overlay compile links every one/,
    );
    await expect(buildLinkFarm(src, `${farm}2`, { skip: [], maxEntries: 4 })).resolves.toBe(4);
  });

  it('on win32 hard-links regular files (right content, source untouched)', async () => {
    const src = await tempDir('ovl-farm-src-');
    const farm = path.join(await tempDir('ovl-farm-dst-'), 'src');
    await put(src, 'paper/main.tex', 'main');
    await put(src, 'shared/defs.tex', 'defs');
    const before = await snapshot(src);

    await buildLinkFarm(src, farm, { skip: [], platform: 'win32' });

    for (const rel of ['paper/main.tex', 'shared/defs.tex']) {
      const st = await lstat(path.join(farm, rel));
      expect(st.isSymbolicLink(), rel).toBe(false);
      expect(st.isFile(), rel).toBe(true);
      expect(await readFile(path.join(farm, rel)), rel).toEqual(before.get(path.normalize(rel)));
      // A hard link, not a copy: the same inode as the source.
      expect(st.ino, rel).toBe((await stat(path.join(src, rel))).ino);
    }
    await rm(farm, { recursive: true, force: true });
    await expectSame(before, await snapshot(src));
  });

  it('on win32 copies a read-only file rather than hard-linking it', async () => {
    // Hard links share attributes, and libuv's unlink clears FILE_ATTRIBUTE_READONLY before
    // deleting: removing the farm's link would have stripped read-only from the source file.
    const src = await tempDir('ovl-farm-src-');
    const farm = path.join(await tempDir('ovl-farm-dst-'), 'src');
    await put(src, 'locked.tex', 'locked');
    await put(src, 'open.tex', 'open');
    await chmod(path.join(src, 'locked.tex'), 0o444);
    cleanups.push(() => chmod(path.join(src, 'locked.tex'), 0o644).catch(() => undefined));

    await buildLinkFarm(src, farm, { skip: [], platform: 'win32' });

    const locked = await lstat(path.join(farm, 'locked.tex'));
    expect(locked.ino).not.toBe((await stat(path.join(src, 'locked.tex'))).ino);
    expect(await readFile(path.join(farm, 'locked.tex'), 'utf8')).toBe('locked');
    expect((await lstat(path.join(farm, 'open.tex'))).ino).toBe(
      (await stat(path.join(src, 'open.tex'))).ino,
    );
    await rm(farm, { recursive: true, force: true });
    expect((await stat(path.join(src, 'locked.tex'))).mode & 0o200).toBe(0);
  });

  it('on win32 refuses to copy more than the copy budget, naming why it copies', async () => {
    const src = await tempDir('ovl-farm-src-');
    const farm = path.join(await tempDir('ovl-farm-dst-'), 'src');
    await put(src, 'a.tex', 'x'.repeat(600));
    await put(src, 'b.tex', 'x'.repeat(600));
    for (const f of ['a.tex', 'b.tex']) await chmod(path.join(src, f), 0o444);
    cleanups.push(async () => {
      for (const f of ['a.tex', 'b.tex']) await chmod(path.join(src, f), 0o644).catch(() => 0);
    });
    await expect(
      buildLinkFarm(src, farm, { skip: [], platform: 'win32', maxCopyBytes: 1000 }),
    ).rejects.toThrow(
      /copy more than .* hard-linking fails — most often because the project is on a different drive/,
    );
    await expect(
      buildLinkFarm(src, `${farm}2`, { skip: [], platform: 'win32', maxCopyBytes: 1200 }),
    ).resolves.toBe(2);
  });

  posixOnly('on win32 copies a file symlink and junctions a directory symlink', async () => {
    const src = await tempDir('ovl-farm-src-');
    const farm = path.join(await tempDir('ovl-farm-dst-'), 'src');
    await put(src, 'main.tex', 'main');
    await put(src, 'real/f.tex', 'f');
    await symlink('main.tex', path.join(src, 'alias.tex'));
    await symlink(path.join(src, 'real'), path.join(src, 'linked'));

    await buildLinkFarm(src, farm, { skip: [], platform: 'win32' });

    const alias = await lstat(path.join(farm, 'alias.tex'));
    expect(alias.isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(farm, 'alias.tex'), 'utf8')).toBe('main');
    expect(alias.ino).not.toBe((await stat(path.join(src, 'main.tex'))).ino);
    expect((await lstat(path.join(farm, 'linked'))).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(farm, 'linked/f.tex'), 'utf8')).toBe('f');
  });
});

describe('placeOverlayFile', () => {
  it('replaces the file link with a real file and leaves the source alone', async () => {
    const src = await tempDir('ovl-place-src-');
    const farm = path.join(await tempDir('ovl-place-dst-'), 'src');
    await put(src, 'paper/b.tex', 'original');
    const before = await snapshot(src);
    await buildLinkFarm(src, farm, { skip: [] });

    await placeOverlayFile(farm, src, 'paper/b.tex', 'edited');

    const st = await lstat(path.join(farm, 'paper/b.tex'));
    expect(st.isFile() && !st.isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(farm, 'paper/b.tex'), 'utf8')).toBe('edited');
    await expectSame(before, await snapshot(src));
  });

  it('materialises a symlinked ancestor rather than writing through it', async () => {
    const src = await tempDir('ovl-place-src-');
    const shared = await tempDir('ovl-place-shared-');
    const farm = path.join(await tempDir('ovl-place-dst-'), 'src');
    await put(shared, 'sub/deep/c.tex', 'deep original');
    await put(shared, 'sub/other.tex', 'other');
    await put(shared, 'top.tex', 'top');
    await put(src, 'main.tex', 'main');
    await linkDir(shared, path.join(src, 'lib'));
    const beforeShared = await snapshot(shared);
    const beforeSrc = await snapshot(src);
    await buildLinkFarm(src, farm, { skip: [] });

    await placeOverlayFile(farm, src, 'lib/sub/deep/c.tex', 'deep edited');

    expect(await readFile(path.join(farm, 'lib/sub/deep/c.tex'), 'utf8')).toBe('deep edited');
    // Every ancestor on the path is now a real directory; its other children are links to the
    // project's path for them (through the project's own link).
    for (const rel of ['lib', 'lib/sub', 'lib/sub/deep']) {
      const st = await lstat(path.join(farm, rel));
      expect(st.isDirectory() && !st.isSymbolicLink(), rel).toBe(true);
    }
    if (!isWin) {
      expect(await readlink(path.join(farm, 'lib/top.tex'))).toBe(path.join(src, 'lib/top.tex'));
      expect(await readlink(path.join(farm, 'lib/sub/other.tex'))).toBe(
        path.join(src, 'lib/sub/other.tex'),
      );
    }
    expect(await readFile(path.join(farm, 'lib/top.tex'), 'utf8')).toBe('top');
    expect(await readFile(path.join(farm, 'lib/sub/other.tex'), 'utf8')).toBe('other');
    // The file behind the link is unchanged.
    await expectSame(beforeShared, await snapshot(shared));
    await expectSame(beforeSrc, await snapshot(src));
  });
});

describe('variant lifecycle', () => {
  it('rebuilding and removing a variant leaves every source file intact', async () => {
    const src = await tempDir('ovl-life-src-');
    const shared = await tempDir('ovl-life-shared-');
    await put(shared, 'defs.tex', 'defs');
    await put(src, 'paper/main.tex', 'main');
    await put(src, 'paper/sections/b.tex', 'b original');
    await linkDir(shared, path.join(src, 'shared'));
    const beforeSrc = await snapshot(src);
    const beforeShared = await snapshot(shared);
    const contents = new Map([
      ['paper/sections/b.tex', 'b edited'],
      ['shared/defs.tex', 'defs edited'],
    ]);
    const opts = {
      projectDir: src,
      handle: 'v0123456789ab',
      rootFile: 'paper/main.tex',
      engine: 'pdflatex' as const,
      compiler: 'latexmk' as const,
      contents,
      skip: [],
    };

    const paths = await stageVariant(opts);
    await stageVariant(opts); // rebuild: rm then create
    expect(await readFile(path.join(paths.src, 'paper/sections/b.tex'), 'utf8')).toBe('b edited');
    expect(await readFile(path.join(paths.src, 'shared/defs.tex'), 'utf8')).toBe('defs edited');
    expect(await readVariant(src, 'v0123456789ab')).toEqual({
      rootFile: 'paper/main.tex',
      paths,
    });
    await expectSame(beforeSrc, await snapshot(src));
    await expectSame(beforeShared, await snapshot(shared));

    await rm(paths.root, { recursive: true, force: true });
    await expectSame(beforeSrc, await snapshot(src));
    await expectSame(beforeShared, await snapshot(shared));
    expect(await readVariant(src, 'v0123456789ab')).toBeUndefined();
  });

  it('evicts all but the most recently compiled, always keeping the current one', async () => {
    const src = await tempDir('ovl-evict-');
    const handles = ['v000000000001', 'v000000000002', 'v000000000003', 'v000000000004'];
    const more = ['v000000000005', 'v000000000006'];
    const current = 'v0000000000cc';
    const stamp = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
    for (const [i, h] of [...handles, ...more].entries()) {
      const p = variantPaths(src, h);
      await mkdir(p.out, { recursive: true });
      await writeManifest(p.manifest, {
        rootFile: 'main.tex',
        createdAt: stamp(i),
        usedAt: stamp(10 + i),
        files: [],
        compiler: 'latexmk',
        engine: 'pdflatex',
      });
    }
    // The current variant is the OLDEST by usedAt, and still kept.
    const cur = variantPaths(src, current);
    await mkdir(cur.out, { recursive: true });
    await writeManifest(cur.manifest, {
      rootFile: 'main.tex',
      createdAt: stamp(0),
      usedAt: stamp(0),
      files: [],
      compiler: 'latexmk',
      engine: 'pdflatex',
    });
    // One without a readable manifest counts as oldest; a stray directory is not a variant.
    await mkdir(variantPaths(src, 'v0000000000bb').out, { recursive: true });
    await mkdir(path.join(buildDir(src), 'variants', 'not-a-handle'), { recursive: true });

    const removed = await evictVariants(src, MAX_VARIANTS, current);

    const left = (await readdir(path.join(buildDir(src), 'variants'))).sort();
    expect(left).toEqual(
      ['not-a-handle', current, 'v000000000004', 'v000000000005', 'v000000000006'].sort(),
    );
    expect(removed.sort()).toEqual(
      ['v000000000001', 'v000000000002', 'v000000000003', 'v0000000000bb'].sort(),
    );

    // Touching an old one makes it the most recent: the next eviction keeps it.
    await touchVariant(src, 'v000000000004', new Date(Date.UTC(2027, 0, 1)));
    await evictVariants(src, 2, current);
    expect((await readdir(path.join(buildDir(src), 'variants'))).sort()).toEqual(
      ['not-a-handle', current, 'v000000000004'].sort(),
    );
  });

  it('resolveVariantBuild refuses an invalid, unknown or mismatched variant', async () => {
    const src = await tempDir('ovl-resolve-');
    await expect(resolveVariantBuild(src, 'p', '../x', undefined)).rejects.toThrow(
      /Not a variant handle: "\.\.\/x"/,
    );
    await expect(resolveVariantBuild(src, 'p', 'v0123456789ab', undefined)).rejects.toThrow(
      /No variant "v0123456789ab" for project "p": it was evicted — only the 4 most recent/,
    );
    const p = variantPaths(src, 'v0123456789ab');
    await mkdir(p.out, { recursive: true });
    await writeManifest(p.manifest, {
      rootFile: 'paper/main.tex',
      createdAt: 'x',
      usedAt: 'x',
      files: [],
      compiler: 'latexmk',
      engine: 'pdflatex',
    });
    await expect(resolveVariantBuild(src, 'p', 'v0123456789ab', 'other.tex')).rejects.toThrow(
      /compiled from "paper\/main\.tex", not "other\.tex"/,
    );
    await expect(
      resolveVariantBuild(src, 'p', 'v0123456789ab', './paper/main.tex'),
    ).resolves.toMatchObject({ rootFile: 'paper/main.tex' });
  });
});

describe('applyOverlay', () => {
  it('applies the edits in memory and writes nothing', async () => {
    const src = await tempDir('ovl-apply-');
    await put(src, 'main.tex', 'Hello world\n% world\n');
    const before = await snapshot(src);
    const out = await applyOverlay(new FileService(), src, [
      {
        file: './main.tex',
        edits: [{ oldString: 'world', newString: 'there', excludeComments: true }],
      },
    ]);
    expect([...out.entries()]).toEqual([['main.tex', 'Hello there\n% world\n']]);
    await expectSame(before, await snapshot(src));
  });

  it('refuses a duplicate, a missing file, too many edits, non-UTF-8 and an unfit excludeComments', async () => {
    const src = await tempDir('ovl-apply-');
    await put(src, 'main.tex', 'x\n');
    await put(src, 'notes.md', 'x\n');
    await put(src, 'latin1.tex', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const files = new FileService();
    const edit = { oldString: 'x', newString: 'y' };
    await expect(
      applyOverlay(files, src, [
        { file: 'main.tex', edits: [edit] },
        { file: './main.tex', edits: [edit] },
      ]),
    ).rejects.toThrow('name each file once and list all its edits in that entry');
    await expect(applyOverlay(files, src, [{ file: 'nope.tex', edits: [edit] }])).rejects.toThrow(
      /Overlay entry 1 \("nope\.tex"\): no such file/,
    );
    await expect(
      applyOverlay(files, src, [{ file: 'main.tex', edits: Array(101).fill(edit) }]),
    ).rejects.toThrow(/101 edits; at most 100/);
    await expect(applyOverlay(files, src, [{ file: 'latin1.tex', edits: [edit] }])).rejects.toThrow(
      /"latin1\.tex"\): the file is not valid UTF-8/,
    );
    await expect(
      applyOverlay(files, src, [{ file: 'notes.md', edits: [{ ...edit, excludeComments: true }] }]),
    ).rejects.toThrow(/no %-line-comment syntax/);
    await expect(
      applyOverlay(files, src, [{ file: 'main.tex', edits: [{ oldString: 'q', newString: 'r' }] }]),
    ).rejects.toThrow(/Overlay entry 1 \("main\.tex"\): Edit 1: oldString not found in main\.tex/);
    await expect(applyOverlay(files, src, [{ file: '../x.tex', edits: [edit] }])).rejects.toThrow(
      /escapes the project root/,
    );
  });
});

describe('overlaySnippetReader', () => {
  it('serves an overlaid path from memory and delegates everything else', async () => {
    const src = await tempDir('ovl-snip-');
    await put(src, 'main.tex', 'on disk\n');
    await put(src, 'other.tex', 'other on disk\n');
    const reader = overlaySnippetReader(new FileService(), new Map([['main.tex', 'in memory\n']]));
    expect((await reader.read(src, { path: './main.tex', strictLinks: true })).content).toBe(
      'in memory\n',
    );
    expect((await reader.read(src, { path: 'other.tex', strictLinks: true })).content).toBe(
      'other on disk\n',
    );
  });
});

describe('overlay: one file named twice', () => {
  it('refuses a case variant under the platform fold, before reading anything', async () => {
    const src = await tempDir('ovl-dup-');
    await put(src, 'main.tex', 'x\n');
    const edit = { oldString: 'x', newString: 'y' };
    await expect(
      applyOverlay(
        new FileService(),
        src,
        [
          { file: 'main.tex', edits: [edit] },
          { file: 'Main.tex', edits: [{ oldString: 'x', newString: 'z' }] },
        ],
        { platform: 'darwin' },
      ),
    ).rejects.toThrow(
      'Overlay entry 2 names "Main.tex", the same file as entry 1 ("main.tex"): name each file once',
    );
  });

  it('refuses two names for one file on disk, whatever the platform fold says', async () => {
    const src = await tempDir('ovl-dup-');
    await put(src, 'main.tex', 'x\n');
    await link(path.join(src, 'main.tex'), path.join(src, 'alias.tex'));
    await expect(
      applyOverlay(
        new FileService(),
        src,
        [
          { file: 'main.tex', edits: [{ oldString: 'x', newString: 'y' }] },
          { file: 'alias.tex', edits: [{ oldString: 'x', newString: 'z' }] },
        ],
        { platform: 'linux' },
      ),
    ).rejects.toThrow('the same file as entry 1 ("main.tex"): name each file once');
  });
});

describe('overlaySnippetReader: another spelling of an overlaid file', () => {
  it('serves the overlay for a case variant of the same entry, and withholds any other alias', async () => {
    const src = await tempDir('ovl-snipalias-');
    await put(src, 'sections/b.tex', 'on disk\n');
    // A second name for the same file: on a case-insensitive filesystem `sections/B.tex` already
    // IS that entry; elsewhere a hard link gives it the same identity.
    await link(path.join(src, 'sections/b.tex'), path.join(src, 'sections/B.tex')).catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err;
      },
    );
    await link(path.join(src, 'sections/b.tex'), path.join(src, 'hard.tex'));
    const reader = overlaySnippetReader(
      new FileService(),
      new Map([['sections/b.tex', 'in memory\n']]),
      { platform: 'darwin' },
    );
    expect((await reader.read(src, { path: 'sections/B.tex' })).content).toBe('in memory\n');
    await expect(reader.read(src, { path: 'hard.tex' })).rejects.toThrow(
      /is the overlaid file "sections\/b\.tex" under another name/,
    );
  });
});

describe('overlayFilesNeverRead', () => {
  it('parses PWD and INPUT lines, CRLF included', () => {
    expect(
      parseFls(
        'PWD /w/src/paper\r\nINPUT /tex/article.cls\r\nINPUT ./b.tex\r\nOUTPUT main.log\r\n',
      ),
    ).toEqual({ pwd: '/w/src/paper', inputs: ['/tex/article.cls', './b.tex'] });
    expect(parseFls('INPUT a.tex\n')).toEqual({ pwd: undefined, inputs: ['a.tex'] });
  });

  it('names the overlaid files no INPUT line resolves to, and claims nothing without a .fls', async () => {
    const src = await tempDir('ovl-fls-');
    const paths = variantPaths(src, 'v0123456789ab');
    await mkdir(paths.out, { recursive: true });
    await mkdir(path.join(paths.src, 'paper'), { recursive: true });
    const files = ['paper/sections/b.tex', 'shared/defs.tex', 'paper/notes.tex'];
    expect(await overlayFilesNeverRead(paths, 'paper/main.tex', files)).toBeUndefined();

    await writeFile(
      path.join(paths.out, 'main.fls'),
      [
        `PWD ${path.join(paths.src, 'paper')}`,
        'INPUT /usr/share/texmf/article.cls',
        'INPUT ./sections/b.tex',
        'INPUT ../shared/defs.tex',
        'INPUT notes-alias.tex',
        '',
      ].join('\n'),
    );
    expect(await overlayFilesNeverRead(paths, 'paper/main.tex', files)).toEqual([
      'paper/notes.tex',
    ]);
    // A .bib is read by biber/bibtex, never by the engine: .fdb_latexmk is where it shows up.
    const withBib = [...files, 'paper/refs.bib'];
    expect(await overlayFilesNeverRead(paths, 'paper/main.tex', withBib)).toEqual([
      'paper/notes.tex',
      'paper/refs.bib',
    ]);
    await writeFile(
      path.join(paths.out, 'main.fdb_latexmk'),
      '# Fdb version 4\n["biber main"] 1 "main.bcf" "main.bbl" "main" 1 0\n' +
        '  "./refs.bib" 1 71 c03e012c95b02e83136ecda800da647a ""\n' +
        '  "main.bcf" 1 10 abc "pdflatex"\n',
    );
    expect(await overlayFilesNeverRead(paths, 'paper/main.tex', withBib)).toEqual([
      'paper/notes.tex',
    ]);
    expect(parseFdbSources('["x"] 1 "a" "b" "c" 1 0\n  "./refs.bib" 1 71 f ""\n')).toEqual([
      './refs.bib',
    ]);
    // Over the size cap the check is skipped rather than run on part of the file.
    expect(
      await overlayFilesNeverRead(paths, 'paper/main.tex', files, { maxBytes: 10 }),
    ).toBeUndefined();
  });
});

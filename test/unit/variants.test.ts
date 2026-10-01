import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  chmod,
  utimes,
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
  refuseLinkedRootDir,
  resolveVariantBuild,
  snapshotSource,
  sourceChangedHint,
  sourceChanges,
  stageVariant,
  variantHandle,
  variantPaths,
  watchSource,
  writeManifest,
  MAX_VARIANTS,
  SOURCE_CHANGES_NAMES_BUDGET,
  SOURCE_CHECK_PATH_MAX,
  SourceSnapshotError,
  VariantEvictionError,
  evictionFailureHint,
} from '../../src/lib/variants.js';
import type { VariantKey } from '../../src/lib/variants.js';
import { buildDir } from '../../src/services/compiler.js';
import { FileService } from '../../src/services/fileService.js';
import { quoteId } from '../../src/lib/projectId.js';

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

describe('stageVariant: one budget for the whole stage', () => {
  it('counts the entries a placement under a linked directory creates against the farm cap', async () => {
    const src = await tempDir('ovl-budget-src-');
    const shared = await tempDir('ovl-budget-shared-');
    for (const f of ['a', 'b', 'c', 'd', 'e']) await put(shared, `${f}.tex`, f);
    await put(src, 'main.tex', 'main');
    await linkDir(shared, path.join(src, 'lib'));
    const opts = {
      projectDir: src,
      rootFile: 'main.tex',
      engine: 'pdflatex' as const,
      compiler: 'latexmk' as const,
      // Materialising lib/ links its five children: the farm itself is only main.tex and lib.
      contents: new Map([['lib/a.tex', 'edited']]),
      skip: [],
    };
    // The farm alone (2 entries) fits a cap of 4; the placement's 5 links do not.
    await expect(
      stageVariant({ ...opts, handle: 'v0000000000a1', maxFarmEntries: 4 }),
    ).rejects.toThrow(/more than 4 files and directories; an overlay compile links every one/);
    // 2 + 5 = 7 fits exactly.
    const paths = await stageVariant({ ...opts, handle: 'v0000000000a2', maxFarmEntries: 7 });
    expect(await readFile(path.join(paths.src, 'lib/a.tex'), 'utf8')).toBe('edited');
  });
});

describe('evictionFailureHint', () => {
  it('counts several failures and escapes what their reasons quote', () => {
    const newline = String.fromCharCode(10);
    const rlo = String.fromCodePoint(0x202e);
    const bs = String.fromCharCode(92);
    const hint = evictionFailureHint(
      new VariantEvictionError([
        { handle: 'v000000000001', reason: `EBUSY: /tmp/a${newline}forged line` },
        { handle: 'v000000000002', reason: `EPERM: /tmp/${rlo}fdp.exe` },
      ]),
    );
    expect(hint).toContain('2 older variants of this project could not be removed');
    expect(hint).toContain(`/tmp/a${bs}u{A}forged line`);
    expect(hint).toContain(`/tmp/${bs}u{202E}fdp.exe`);
    expect(hint).not.toContain(newline);
    expect(hint).not.toContain(rlo);
    expect(hint).toContain('this compile is unaffected');
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

    // Compiling an old one again (staging it stamps usedAt) makes it the most recent: the next
    // eviction keeps it.
    await stageVariant({
      projectDir: src,
      handle: 'v000000000004',
      rootFile: 'main.tex',
      engine: 'pdflatex',
      compiler: 'latexmk',
      contents: new Map(),
      skip: [buildDir(src)],
      now: new Date(Date.UTC(2027, 0, 1)),
    });
    await evictVariants(src, 2, current);
    expect((await readdir(path.join(buildDir(src), 'variants'))).sort()).toEqual(
      ['not-a-handle', current, 'v000000000004'].sort(),
    );
  });

  it.skipIf(isWin || (typeof process.getuid === 'function' && process.getuid() === 0))(
    'tries every old variant, and reports every one it could not remove',
    async () => {
      const src = await tempDir('ovl-evict-fail-');
      const current = 'v0000000000cc';
      // Removal order is newest first: 4, 3, 2, 1. The first and the third cannot be removed.
      const old = ['v000000000001', 'v000000000002', 'v000000000003', 'v000000000004'];
      const stamp = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
      for (const [i, h] of [...old, current].entries()) {
        const p = variantPaths(src, h);
        await mkdir(p.out, { recursive: true });
        await writeManifest(p.manifest, {
          rootFile: 'main.tex',
          createdAt: stamp(i),
          usedAt: stamp(i),
          files: [],
          compiler: 'latexmk',
          engine: 'pdflatex',
        });
      }
      const locked = ['v000000000004', 'v000000000002'];
      for (const h of locked) {
        const out = variantPaths(src, h).out;
        await writeFile(path.join(out, 'main.pdf'), 'held');
        await chmod(out, 0o555);
        cleanups.unshift(() => chmod(out, 0o755).catch(() => undefined));
      }

      const err = await evictVariants(src, 1, current).then(
        () => undefined,
        (e: unknown) => e,
      );

      // Every handle was tried: the removable ones are gone although an earlier one failed.
      expect((await readdir(path.join(buildDir(src), 'variants'))).sort()).toEqual(
        [current, ...locked].sort(),
      );
      // And every failure is reported, together, in removal order.
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).toMatch(/^v000000000004: EACCES.*; v000000000002: EACCES/s);
      expect(message).not.toContain('v000000000003');
    },
  );

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

describe('refuseLinkedRootDir', () => {
  it('refuses a root under a linked directory at any depth, naming the link and the real path', async () => {
    const src = await tempDir('ovl-rootlink-');
    await put(src, 'a/drafts/p1/main.tex', 'x\n');
    await put(src, 'top.tex', 'x\n');
    await linkDir(path.join(src, 'a', 'drafts', 'p1'), path.join(src, 'a', 'paper'));
    await expect(refuseLinkedRootDir(src, './a/paper/main.tex')).rejects.toThrow(
      /reached through "a\/paper", which is a symbolic link.*rootFile: "a\/drafts\/p1\/main\.tex"/s,
    );
    // Nothing is staged when stageVariant refuses.
    await expect(
      stageVariant({
        projectDir: src,
        handle: variantHandle(KEY),
        rootFile: 'a/paper/main.tex',
        engine: 'pdflatex',
        compiler: 'latexmk',
        contents: new Map(),
        skip: [],
      }),
    ).rejects.toThrow(/symbolic link/);
    await expect(stat(path.join(buildDir(src), 'variants'))).rejects.toThrow();
    // The real path, a root at the project root and a missing directory are not refused.
    await refuseLinkedRootDir(src, 'a/drafts/p1/main.tex');
    await refuseLinkedRootDir(src, 'top.tex');
    await refuseLinkedRootDir(src, 'nope/main.tex');
  });

  it('says a link out of the project cannot be an overlay root', async () => {
    const src = await tempDir('ovl-rootlink-');
    const outside = await tempDir('ovl-rootlink-out-');
    await put(outside, 'main.tex', 'x\n');
    await linkDir(outside, path.join(src, 'paper'));
    await expect(refuseLinkedRootDir(src, 'paper/main.tex')).rejects.toThrow(
      /not a directory inside the project/,
    );
  });
});

describe('refuseLinkedRootDir: a root spelled so the engine resolves it differently', () => {
  it('refuses a `..` segment, which the OS resolves through a link and normalisation does not', async () => {
    // paper -> drafts/p1, and no top-level p1: `paper/../p1/main.tex` normalises to a path that
    // does not exist, while latexmk's -cd resolves it physically, through the farm's ONE link to
    // the source directory — the engine would run inside the SOURCE.
    const src = await tempDir('ovl-rootdots-');
    await put(src, 'drafts/p1/main.tex', 'x\n');
    await put(src, 'top.tex', 'x\n');
    await linkDir(path.join(src, 'drafts', 'p1'), path.join(src, 'paper'));
    await expect(refuseLinkedRootDir(src, 'paper/../p1/main.tex')).rejects.toThrow(
      /"paper\/\.\.\/p1\/main\.tex".*"\.\."/s,
    );
    // Any `..`, link or not: the spelling is judged, never what it happens to resolve to.
    await expect(refuseLinkedRootDir(src, 'drafts/../top.tex')).rejects.toThrow(/"\.\."/);
    await expect(refuseLinkedRootDir(src, '../elsewhere/main.tex')).rejects.toThrow(/"\.\."/);
    // Backslashes are separators too.
    await expect(refuseLinkedRootDir(src, 'paper\\..\\p1\\main.tex')).rejects.toThrow(/"\.\."/);
  });

  it('refuses an absolute root, naming the project-relative spelling when it is inside', async () => {
    const src = await tempDir('ovl-rootabs-');
    await put(src, 'drafts/p1/main.tex', 'x\n');
    await expect(
      refuseLinkedRootDir(src, path.join(src, 'drafts', 'p1', 'main.tex')),
    ).rejects.toThrow(/absolute.*rootFile: "drafts\/p1\/main\.tex"/s);
    const outside = await tempDir('ovl-rootabs-out-');
    await expect(refuseLinkedRootDir(src, path.join(outside, 'main.tex'))).rejects.toThrow(
      /absolute/,
    );
  });

  it('reads a directory named like "..foo" as inside the project, not above it', async () => {
    const src = await tempDir('ovl-rootdotdir-');
    await put(src, '..foo/main.tex', 'x\n');
    await put(src, '..foo/p1/main.tex', 'x\n');
    // An absolute root inside such a directory: the relative spelling is suggested.
    await expect(refuseLinkedRootDir(src, path.join(src, '..foo', 'main.tex'))).rejects.toThrow(
      /absolute.*rootFile: "\.\.foo\/main\.tex"/s,
    );
    // A link into one: its real path is inside, so it is offered.
    await linkDir(path.join(src, '..foo', 'p1'), path.join(src, 'paper'));
    await expect(refuseLinkedRootDir(src, 'paper/main.tex')).rejects.toThrow(
      /symbolic link.*rootFile: "\.\.foo\/p1\/main\.tex"/s,
    );
    // And the root spelled through it is not a ".." segment.
    await refuseLinkedRootDir(src, '..foo/main.tex');
  });

  it('refuses every Windows spelling on every platform, before touching the disk', async () => {
    // The project directory does not exist: each refusal is decided on the spelling alone, so it
    // is the same wherever the server runs — a drive prefix included, which only Windows reads.
    const nowhere = path.join(os.tmpdir(), 'ovl-no-such-project', 'p');
    const spellings: Array<[string, RegExp]> = [
      ['C:main.tex', /is spelled with a drive prefix/],
      ['c:sub\\main.tex', /is spelled with a drive prefix/],
      ['C:\\p\\main.tex', /is an absolute path/],
      ['C:/p/main.tex', /is an absolute path/],
      ['\\\\server\\share\\main.tex', /is an absolute path/],
      ['\\main.tex', /is an absolute path/],
      ['sub\\..\\main.tex', /"\.\."/],
    ];
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      for (const [spelling, message] of spellings) {
        await expect(
          refuseLinkedRootDir(nowhere, spelling, { platform }),
          `${platform}: ${spelling}`,
        ).rejects.toThrow(message);
      }
    }
  });

  const DOTDOT_MESSAGE =
    'The root file "sub/../main.tex" is spelled with a ".." segment, and an overlay compile ' +
    'refuses one: the engine resolves ".." physically — through a symbolic link, into the ' +
    "link's target — while the variant is staged from the name as written, so the two can name " +
    'different directories, one of them the source itself. Name the root by its path from the ' +
    'project root, without "..".';
  const DRIVE_MESSAGE =
    'The root file "C:main.tex" is spelled with a drive prefix, which Windows reads as an ' +
    'absolute or drive-relative path (so it is refused on every platform), and an overlay ' +
    'compile builds in a private mirror of the project, which such a root would bypass: the ' +
    'engine would run outside the mirror — in the source directory itself when the root is in ' +
    'the project. Name it relative to the project root.';
  const REGISTERED_SENTENCE =
    ' It is the rootFile the project was registered with (register_project or ' +
    'WEB_LATEX_MCP_PROJECTS), used because this call named none — pass rootFile, or register ' +
    'the project again with a relative rootFile (for a project configured in ' +
    'WEB_LATEX_MCP_PROJECTS, change it there).';

  async function refusal(promise: Promise<void>): Promise<string> {
    try {
      await promise;
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error('expected a refusal');
  }

  it('keeps its messages byte-for-byte when the root was not registered', async () => {
    const nowhere = path.join(os.tmpdir(), 'ovl-no-such-project', 'p');
    expect(await refusal(refuseLinkedRootDir(nowhere, 'sub/../main.tex'))).toBe(DOTDOT_MESSAGE);
    expect(await refusal(refuseLinkedRootDir(nowhere, 'C:main.tex'))).toBe(DRIVE_MESSAGE);
    expect(await refusal(refuseLinkedRootDir(nowhere, 'C:main.tex', { registered: false }))).toBe(
      DRIVE_MESSAGE,
    );
  });

  it('says a refused root is the registered one, when the call named none', async () => {
    const nowhere = path.join(os.tmpdir(), 'ovl-no-such-project', 'p');
    expect(
      await refusal(refuseLinkedRootDir(nowhere, 'sub/../main.tex', { registered: true })),
    ).toBe(DOTDOT_MESSAGE + REGISTERED_SENTENCE);
    expect(await refusal(refuseLinkedRootDir(nowhere, 'C:main.tex', { registered: true }))).toBe(
      DRIVE_MESSAGE + REGISTERED_SENTENCE,
    );
    const abs = await refusal(
      refuseLinkedRootDir(nowhere, path.join(nowhere, 'main.tex'), { registered: true }),
    );
    expect(abs).toMatch(
      /is an absolute path.*rootFile: "main\.tex"\. It is the rootFile the project was registered with/s,
    );
  });

  it('says a root under a linked directory is the registered one, when the call named none', async () => {
    const src = await tempDir('ovl-rootlink-reg-');
    await put(src, 'drafts/p1/main.tex', 'x\n');
    await linkDir(path.join(src, 'drafts', 'p1'), path.join(src, 'paper'));
    const plain = await refusal(refuseLinkedRootDir(src, 'paper/main.tex'));
    expect(plain).not.toMatch(/registered/);
    const registered = await refusal(
      refuseLinkedRootDir(src, 'paper/main.tex', { registered: true }),
    );
    expect(registered.startsWith(plain)).toBe(true);
    expect(registered.slice(plain.length)).toMatch(
      /^ It is the rootFile the project was registered with \(register_project or WEB_LATEX_MCP_PROJECTS\), used because this call named none — pass rootFile, or register the project again with rootFile: "drafts\/p1\/main\.tex"/,
    );
  });
});

describe('snapshotSource / sourceChanges', () => {
  it('names what a build added, removed or rewrote, and nothing it did not touch', async () => {
    const src = await tempDir('ovl-snap-');
    await put(src, 'main.tex', 'main\n');
    await put(src, 'sections/a.tex', 'Section A.\n');
    await put(src, 'sections/gone.tex', 'gone\n');
    await put(src, 'same.tex', 'same size\n');
    const before = await snapshotSource(src, { skip: [] });
    expect(before).toBeDefined();
    await writeFile(path.join(src, 'sections/a.tex'), 'PWNED\n');
    await rm(path.join(src, 'sections/gone.tex'));
    await put(src, 'sections/new.tex', 'new\n');
    // Same length, and the mtime put back: only the change time still says it was written.
    const st = await stat(path.join(src, 'same.tex'));
    await writeFile(path.join(src, 'same.tex'), 'SAME SIZE\n');
    await utimes(path.join(src, 'same.tex'), st.atime, st.mtime);
    const after = await snapshotSource(src, { skip: [] });
    expect(sourceChanges(before!, after!)).toEqual([
      'same.tex',
      'sections/a.tex',
      'sections/gone.tex',
      'sections/new.tex',
    ]);
    // Nothing changed: nothing named.
    expect(sourceChanges(after!, (await snapshotSource(src, { skip: [] }))!)).toEqual([]);
  });

  it('skips .git and the skipped directories, and walks a linked directory under its link', async () => {
    const src = await tempDir('ovl-snap-skip-');
    const outside = await tempDir('ovl-snap-out-');
    await put(src, 'main.tex', 'main\n');
    await put(src, '.git/HEAD', 'ref\n');
    await put(src, 'ws/state.json', '{}\n');
    await put(outside, 'shared.tex', 'shared\n');
    await linkDir(outside, path.join(src, 'linked'));
    const skip = [path.join(src, 'ws')];
    const before = await snapshotSource(src, { skip });
    expect([...before!.entries.keys()].sort()).toEqual(['linked', 'linked/shared.tex', 'main.tex']);
    await writeFile(path.join(src, '.git/HEAD'), 'moved\n');
    await writeFile(path.join(src, 'ws/state.json'), '{"x":1}\n');
    expect(sourceChanges(before!, (await snapshotSource(src, { skip }))!)).toEqual([]);
    // The farm links `linked` to the same directory, so the build can write there too.
    await writeFile(path.join(outside, 'shared.tex'), 'changed\n');
    expect(sourceChanges(before!, (await snapshotSource(src, { skip }))!)).toEqual([
      'linked/shared.tex',
    ]);
  });

  posixOnly('names a file link whose target outside the project was rewritten', async () => {
    const src = await tempDir('ovl-snap-flink-');
    const outside = await tempDir('ovl-snap-flink-out-');
    await put(src, 'main.tex', 'main\n');
    await put(outside, 'notes.tex', 'notes\n');
    await symlink(path.join(outside, 'notes.tex'), path.join(src, 'notes.tex'));
    const before = await snapshotSource(src, { skip: [] });
    // Same length, mtime put back: the link itself is untouched; only the target's ctime moved.
    const st = await stat(path.join(outside, 'notes.tex'));
    await writeFile(path.join(outside, 'notes.tex'), 'NOTES\n');
    await utimes(path.join(outside, 'notes.tex'), st.atime, st.mtime);
    const mid = await snapshotSource(src, { skip: [] });
    expect(sourceChanges(before!, mid!)).toEqual(['notes.tex']);
    // A different length.
    await writeFile(path.join(outside, 'notes.tex'), 'rewritten at length\n');
    expect(sourceChanges(mid!, (await snapshotSource(src, { skip: [] }))!)).toEqual(['notes.tex']);
  });

  it('names a file created or rewritten under a linked directory, by the link path', async () => {
    const src = await tempDir('ovl-snap-dlink-');
    const outside = await tempDir('ovl-snap-dlink-out-');
    await put(src, 'main.tex', 'main\n');
    await put(outside, 'a.pdf', 'pdf\n');
    await put(outside, 'deep/b.pdf', 'pdf\n');
    await linkDir(outside, path.join(src, 'figs'));
    const before = await snapshotSource(src, { skip: [] });
    await writeFile(path.join(outside, 'a.pdf'), 'rewritten\n');
    await put(outside, 'new.tex', 'new\n');
    await put(outside, 'deep/c.tex', 'c\n');
    expect(sourceChanges(before!, (await snapshotSource(src, { skip: [] }))!)).toEqual([
      'figs/a.pdf',
      'figs/deep/c.tex',
      'figs/new.tex',
    ]);
  });

  posixOnly('names a dangling link whose target the build created', async () => {
    const src = await tempDir('ovl-snap-dangle-');
    const outside = await tempDir('ovl-snap-dangle-out-');
    await put(src, 'main.tex', 'main\n');
    await symlink(path.join(outside, 'ghost.tex'), path.join(src, 'ghost.tex'));
    const before = await snapshotSource(src, { skip: [] });
    expect(before!.entries.has('ghost.tex')).toBe(true);
    await put(outside, 'ghost.tex', 'written through the link\n');
    expect(sourceChanges(before!, (await snapshotSource(src, { skip: [] }))!)).toEqual([
      'ghost.tex',
    ]);
  });

  posixOnly(
    'cannot vouch for a link it cannot stat (a loop), rather than calling it unchanged',
    async () => {
      const src = await tempDir('ovl-snap-eloop-');
      await put(src, 'main.tex', 'main\n');
      await symlink(path.join(src, 'loop.tex'), path.join(src, 'loop.tex'));
      const check = await watchSource(src, { skip: [] });
      const result = await check();
      expect(result.changed).toBeUndefined();
      const reason = result.changed === undefined ? result.reason : '';
      // Which path, and why: a committed loop fails every check, so the reason must be findable.
      expect(reason).toContain('"loop.tex"');
      expect(reason).toContain('ELOOP');
    },
  );

  it('names a path it could not examine in full while it is short, and by its last name when not', () => {
    expect(new SourceSnapshotError('sections/loop.tex', 'ELOOP').message).toBe(
      '"sections/loop.tex" could not be examined (ELOOP)',
    );
    // A build-created path: 20 levels of 250 control characters, each shown as an escape.
    const ctl = String.fromCharCode(1).repeat(250);
    const deep = Array.from({ length: 20 }, () => ctl).join('/') + `/tail${ctl}`;
    const message = new SourceSnapshotError(deep, 'ENAMETOOLONG').message;
    expect(message).toContain('21 levels deep');
    expect(message).toContain('"tail');
    expect(message).toContain('…');
    expect(message).toContain('(ENAMETOOLONG)');
    const prose = 'a path 21 levels deep, ending in , could not be examined (ENAMETOOLONG)';
    expect(message.length).toBeLessThanOrEqual(SOURCE_CHECK_PATH_MAX + prose.length);
    // One long, plain name is cut the same way.
    const wide = new SourceSnapshotError('x'.repeat(250), 'EACCES').message;
    expect(wide).toContain('1 level deep');
    expect(wide.length).toBeLessThanOrEqual(
      SOURCE_CHECK_PATH_MAX +
        'a path 1 level deep, ending in , could not be examined (EACCES)'.length,
    );
  });

  posixOnly(
    "says a skip directory it cannot resolve is the server's, not the project root",
    async () => {
      const src = await tempDir('ovl-snap-skipbad-');
      await put(src, 'main.tex', 'main\n');
      const check = await watchSource(src, { skip: [path.join(src, 'main.tex', 'ws')] });
      const result = await check();
      expect(result.changed === undefined ? result.reason : '').toBe(
        "the server's workspace or build directory could not be resolved (ENOTDIR)",
      );
    },
  );

  it('says why it cannot vouch for a tree past the entry cap', async () => {
    const src = await tempDir('ovl-snap-capwhy-');
    await put(src, 'a.tex', 'a\n');
    await put(src, 'b.tex', 'b\n');
    const check = await watchSource(src, { skip: [], maxEntries: 1 });
    const result = await check();
    expect(result.changed === undefined ? result.reason : '').toContain(
      'more than 1 files and directories',
    );
    // A tree it can check reports its changes, and no reason.
    const ok = await (await watchSource(src, { skip: [] }))();
    expect(ok).toEqual({ changed: [] });
  });

  it('does not walk a skipped directory inside a linked directory', async () => {
    // `x -> outside`, and `outside/build` is skipped: `x/build` is a REAL directory of the
    // link's target, so only its realpath says it is the skipped one.
    const src = await tempDir('ovl-snap-skipin-');
    const outside = await tempDir('ovl-snap-skipin-out-');
    await put(src, 'main.tex', 'main\n');
    await put(outside, 'keep.tex', 'keep\n');
    await put(outside, 'build/out.log', 'log\n');
    await linkDir(outside, path.join(src, 'x'));
    const skip = [path.join(outside, 'build')];
    const before = await snapshotSource(src, { skip });
    expect([...before!.entries.keys()].sort()).toEqual(['main.tex', 'x', 'x/keep.tex']);
    await put(outside, 'build/out.log', 'rewritten\n');
    expect(sourceChanges(before!, (await snapshotSource(src, { skip }))!)).toEqual([]);
  });

  it('does not walk a link into a directory UNDER a skipped tree, and still walks a project inside one', async () => {
    const src = await tempDir('ovl-snap-skipunder-');
    const buildRoot = await tempDir('ovl-snap-skipunder-build-');
    await put(src, 'main.tex', 'main\n');
    await put(buildRoot, 'proj/out/main.log', 'log\n');
    await linkDir(path.join(buildRoot, 'proj'), path.join(src, 'b'));
    const opts = { skip: [], skipTree: [buildRoot] };
    const before = await snapshotSource(src, opts);
    expect([...before!.entries.keys()].sort()).toEqual(['b', 'main.tex']);
    await put(buildRoot, 'proj/out/main.log', 'the variant build wrote this\n');
    expect(sourceChanges(before!, (await snapshotSource(src, opts))!)).toEqual([]);
    // A skipped directory or tree that CONTAINS the project (the workspace holds every clone)
    // leaves the project itself walked.
    const ws = await tempDir('ovl-snap-skipunder-ws-');
    await put(ws, 'clone/main.tex', 'main\n');
    await put(ws, 'clone/sections/a.tex', 'a\n');
    for (const o of [{ skip: [ws] }, { skip: [], skipTree: [ws] }]) {
      const inWs = await snapshotSource(path.join(ws, 'clone'), o);
      expect([...inWs!.entries.keys()].sort()).toEqual(['main.tex', 'sections', 'sections/a.tex']);
    }
  });

  it('skips a directory by equality only, so a link into a sibling clone is still walked', async () => {
    // The workspace-local layout: a local project registered at the launch directory contains
    // the workspace, and the workspace holds other clones a project link can reach into.
    const src = await tempDir('ovl-snap-wslocal-');
    const ws = path.join(src, '.web_latex_mcp');
    await put(src, 'main.tex', 'main\n');
    await put(ws, 'shared/figs/a.pdf', 'pdf\n');
    await put(ws, '.sessions/p/session.json', '{}\n');
    await linkDir(path.join(ws, 'shared', 'figs'), path.join(src, 'figs'));
    const skip = [ws];
    const before = await snapshotSource(src, { skip });
    // The workspace itself is left out — its session files change on every call.
    expect([...before!.entries.keys()].sort()).toEqual(['figs', 'figs/a.pdf', 'main.tex']);
    await put(ws, 'shared/figs/new.pdf', 'written by the build\n');
    await writeFile(path.join(ws, 'shared/figs/a.pdf'), 'rewritten at length\n');
    await put(ws, '.sessions/p/session.json', '{"heartbeat":1}\n');
    expect(sourceChanges(before!, (await snapshotSource(src, { skip }))!)).toEqual([
      'figs/a.pdf',
      'figs/new.pdf',
    ]);
  });

  it('walks each linked directory once, so a link cycle ends', async () => {
    const src = await tempDir('ovl-snap-cycle-');
    const outside = await tempDir('ovl-snap-cycle-out-');
    await put(src, 'main.tex', 'main\n');
    await put(src, 'sub/a.tex', 'a\n');
    await put(outside, 'x.tex', 'x\n');
    await linkDir(src, path.join(src, 'sub', 'loop')); // the project, from inside it
    await linkDir(outside, path.join(outside, 'back')); // a directory that holds itself
    await linkDir(outside, path.join(src, 'ext'));
    await linkDir(outside, path.join(src, 'ext2')); // a second name for one directory
    const before = await snapshotSource(src, { skip: [] });
    expect(before).toBeDefined();
    const keys = [...before!.entries.keys()].sort();
    expect(keys).toEqual([
      'ext',
      'ext/back',
      'ext/x.tex',
      'ext2',
      'main.tex',
      'sub',
      'sub/a.tex',
      'sub/loop',
    ]);
    expect(sourceChanges(before!, (await snapshotSource(src, { skip: [] }))!)).toEqual([]);
  });

  it('does not walk a skipped directory reached through a link', async () => {
    const src = await tempDir('ovl-snap-skiplink-');
    const outside = await tempDir('ovl-snap-skiplink-out-');
    const shared = await tempDir('ovl-snap-skiplink-shared-');
    await put(src, 'main.tex', 'main\n');
    await put(src, 'ws/state.json', '{}\n');
    await put(outside, 'build/out.log', 'log\n');
    await put(shared, 'defs.tex', 'defs\n');
    await linkDir(path.join(src, 'ws'), path.join(src, 'ws-alias'));
    await linkDir(path.join(outside, 'build'), path.join(src, 'build'));
    await linkDir(shared, path.join(src, 'shared'));
    // A skip directory that does not exist is tolerated.
    const skip = [path.join(src, 'ws'), path.join(outside, 'build'), path.join(outside, 'no-such')];
    const before = await snapshotSource(src, { skip });
    expect([...before!.entries.keys()].sort()).toEqual([
      'build',
      'main.tex',
      'shared',
      'shared/defs.tex',
      'ws-alias',
    ]);
    await writeFile(path.join(src, 'ws/state.json'), '{"x":1}\n');
    await put(outside, 'build/out.log', 'rewritten\n');
    expect(sourceChanges(before!, (await snapshotSource(src, { skip }))!)).toEqual([]);
  });

  it('cannot vouch for a tree past the entry cap', async () => {
    const src = await tempDir('ovl-snap-cap-');
    await put(src, 'a.tex', 'a\n');
    await put(src, 'b.tex', 'b\n');
    expect(await snapshotSource(src, { skip: [], maxEntries: 1 })).toBeUndefined();
  });

  it('caps the hint at 20 names and counts the rest', () => {
    const paths = Array.from({ length: 23 }, (_, i) => `f${i}.tex`);
    const hint = sourceChangedHint(paths);
    expect(hint).toContain('23 project file(s)');
    expect(hint).toContain('"f19.tex"');
    expect(hint).not.toContain('"f20.tex"');
    expect(hint).toContain('and 3 more');
  });

  it('says a path under a link was written at the link target, which status and discard do not reach', () => {
    const hint = sourceChangedHint(['figs/a.pdf']);
    expect(hint).toContain('Review them (status, diff)');
    expect(hint).toContain(
      "a path under a symbolic link, or a link whose target changed, was written at the link's " +
        'target — check it there; a target outside the project is beyond what status, diff and ' +
        'discard reach.',
    );
  });

  it('stops naming once the names would pass their character budget, counting the rest', () => {
    // ~450 characters each, charged twice (text + JSON): two fit the budget, a third does not.
    const long = (c: string) => `${c.repeat(440)}/figure.tex`;
    const paths = ['a', 'b', 'c', 'd', 'e'].map(long);
    const hint = sourceChangedHint(paths);
    expect(hint).toContain('5 project file(s)');
    expect(hint).toContain(quoteId(paths[0]!));
    expect(hint).toContain(quoteId(paths[1]!));
    expect(hint).not.toContain('c'.repeat(440));
    expect(hint).toContain(`${quoteId(paths[1]!)}, and 3 more.`);
  });

  it('says the names are too long when not even the first fits, and names none of it', () => {
    const huge = `${'x'.repeat(2990)}/main.tex`;
    const hint = sourceChangedHint([huge, 'b.tex']);
    expect(hint).toContain(
      'This overlay compile changed 2 project file(s) while it ran (their names are too long ' +
        'to list here). An overlay compile writes nothing',
    );
    expect(hint).not.toContain('xxxx');
    expect(hint).not.toContain('b.tex');
  });

  // The caller receives the hint twice — the text channel and structuredContent's JSON — so the
  // names are charged at their SUM, never at the larger channel alone.
  const jsonLength = (s: string) => JSON.stringify(s).length - 2;
  const both = (s: string) => s.length + jsonLength(s);

  it('bounds the whole hint by the budget plus its fixed prose, across text and JSON', () => {
    // The prose around the names, rendered with none: what the budget does not cover.
    const fixed = both(sourceChangedHint([]));
    const quote = String.fromCharCode(34);
    const bs = String.fromCharCode(92);
    for (const len of [50, 199, 900, 1999, 2500]) {
      for (const fill of ['p', quote, bs]) {
        const paths = Array.from(
          { length: 40 },
          (_, i) => `${String(i).padStart(2, '0')}${fill.repeat(len)}`,
        );
        const hint = sourceChangedHint(paths);
        // The count clause and the total's extra digit, in both channels, are all the prose adds.
        expect(both(hint), `names of ${len} ${fill}`).toBeLessThanOrEqual(
          fixed + SOURCE_CHANGES_NAMES_BUDGET + 2 * (', and 40 more'.length + 1),
        );
      }
    }
  });

  it('pins the budget from both sides: names rendering to exactly it fit, one more character does not', () => {
    // A name full of quotes: 2 characters each in the text, 4 in JSON — 6 in all — so the
    // boundary below holds only when the budget is charged across both channels.
    const first = `a${String.fromCharCode(34).repeat(100)}`;
    // The rendered list quoteId(first) + ', ' + quoteId(fits), text + JSON, is the budget exactly;
    // every letter of `fits` costs one character in each channel.
    const fixedPart = both(quoteId(first)) + both(', ') + both(quoteId(''));
    const room = SOURCE_CHANGES_NAMES_BUDGET - fixedPart;
    expect(room % 2).toBe(0);
    const fits = `b${'y'.repeat(room / 2 - 1)}`;
    expect(both(`${quoteId(first)}, ${quoteId(fits)}`)).toBe(SOURCE_CHANGES_NAMES_BUDGET);
    // Charged in the JSON form alone, it would have room to spare.
    expect(jsonLength(`${quoteId(first)}, ${quoteId(fits)}`)).toBeLessThan(
      SOURCE_CHANGES_NAMES_BUDGET - 500,
    );
    const exact = sourceChangedHint([first, fits]);
    expect(exact).toContain(`${quoteId(first)}, ${quoteId(fits)}.`);
    expect(exact).not.toContain('more');
    const over = sourceChangedHint([first, `${fits}y`]);
    expect(over).toContain(`${quoteId(first)}, and 1 more.`);
    expect(over).not.toContain('yyyy');
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

describe('overlay: a latexmk rc file', () => {
  // latexmk reads `latexmkrc`/`.latexmkrc` from the directory it runs in — the farm — and runs it
  // as Perl, with no shell-escape flag involved: an overlaid one could write the source through
  // the farm's links. The project's own rc file still runs, as in a normal compile.
  const edit = { oldString: 'x', newString: 'y' };
  /** A reader that fails the test if the overlay reads anything at all. */
  const noReads = {
    readTextExact: () => Promise.reject(new Error('read a file before refusing')),
    linkTarget: () => Promise.reject(new Error('resolved a link before refusing')),
  };

  it('refuses latexmkrc and .latexmkrc wherever they sit, before reading anything', async () => {
    const src = await tempDir('ovl-rc-');
    await put(src, 'main.tex', 'x\n');
    await put(src, 'latexmkrc', 'x\n');
    await put(src, 'paper/.latexmkrc', 'x\n');
    const before = await snapshot(src);
    for (const file of ['latexmkrc', './latexmkrc', 'paper/.latexmkrc']) {
      await expect(
        applyOverlay(
          noReads,
          src,
          [
            { file: 'main.tex', edits: [edit] },
            { file, edits: [edit] },
          ],
          { platform: 'linux' },
        ),
      ).rejects.toThrow(/Overlay entry 2 \(".*latexmkrc"\) is a latexmk configuration file/);
    }
    await expectSame(before, await snapshot(src));
  });

  it('folds case on every platform: the guard does not stake its answer on a case probe', async () => {
    const src = await tempDir('ovl-rc-');
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      await expect(
        applyOverlay(noReads, src, [{ file: 'LatexMkRc', edits: [edit] }], { platform }),
      ).rejects.toThrow(/is a latexmk configuration file/);
    }
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
  it('refuses a case variant where the farm folds case, before reading anything', async () => {
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
        { caseProbe: async () => true },
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
      { caseProbe: async () => true },
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

  it('claims nothing when the .fdb_latexmk is over the cap, rather than calling a .bib unread', async () => {
    const src = await tempDir('ovl-fdb-');
    const paths = variantPaths(src, 'v0123456789ab');
    await mkdir(paths.out, { recursive: true });
    const fls = `PWD ${paths.src}\nINPUT ./main.tex\n`;
    await writeFile(path.join(paths.out, 'main.fls'), fls);
    // The bibliography rule's record, padded past a cap the .fls itself stays under.
    const fdb =
      '# Fdb version 4\n["biber main"] 1 "main.bcf" "main.bbl" "main" 1 0\n' +
      '  "refs.bib" 1 71 c03e012c95b02e83136ecda800da647a ""\n' +
      `${'  "pad.sty" 1 1 0 ""\n'.repeat(50)}`;
    await writeFile(path.join(paths.out, 'main.fdb_latexmk'), fdb);
    const maxBytes = Buffer.byteLength(fls) + 10;
    expect(Buffer.byteLength(fdb)).toBeGreaterThan(maxBytes);
    expect(
      await overlayFilesNeverRead(paths, 'main.tex', ['refs.bib'], { maxBytes }),
    ).toBeUndefined();
    // Within the cap it is read, and the .bib counts as read.
    expect(await overlayFilesNeverRead(paths, 'main.tex', ['refs.bib'])).toEqual([]);
    // And a MISSING .fdb_latexmk leaves the .fls alone as the record.
    await rm(path.join(paths.out, 'main.fdb_latexmk'));
    expect(await overlayFilesNeverRead(paths, 'main.tex', ['refs.bib'])).toEqual(['refs.bib']);
  });
});

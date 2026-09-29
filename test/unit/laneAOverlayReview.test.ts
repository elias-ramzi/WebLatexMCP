/**
 * Overlay variants, the PR #229 review follow-ups: a latexmk rc file spelled the way Windows opens
 * it, the rest of the project root's `.git` a build must not write unseen (`commondir`,
 * `config.worktree`, a submodule's config and hooks), retention ordered by `seq` rather than a
 * wall clock, a build root that vanishes between
 * its check and the first directory made under it, the `..foo` directory at every `climbsOut` site
 * of the farm, and one case-probe directory for every fold decision of a variant.
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import {
  applyOverlay,
  evictVariants,
  probeCaseInsensitive,
  readManifest,
  refuseLinkedRootDir,
  snapshotSource,
  sourceChangedHint,
  sourceChanges,
  stageVariant,
  variantPaths,
  writeManifest,
} from '../../src/lib/variants.js';
import type { CaseProbe } from '../../src/lib/variants.js';
import { buildDir, buildRoot, ensureBuildRoot } from '../../src/services/compiler.js';

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

const posixOnly = it.skipIf(process.platform === 'win32');
const linkDir = (target: string, at: string) => symlink(target, at, 'junction');
const edit = { oldString: 'x', newString: 'y' };
/** A reader that fails the test if the overlay reads anything at all. */
const noReads = {
  readTextExact: () => Promise.reject(new Error('read a file before refusing')),
  linkTarget: () => Promise.reject(new Error('resolved a link before refusing')),
};

describe('an overlaid latexmk rc file is judged by the name Windows opens (A-B1)', () => {
  it('refuses a trailing dot or space and an alternate data stream, on every platform', async () => {
    const src = await tempDir('laneA-rc-');
    for (const file of [
      'latexmkrc.',
      'latexmkrc ',
      'latexmkrc::$DATA',
      '.latexmkrc.',
      'paper/.latexmkrc. .',
      'paper/LatexMkRc:stream',
    ]) {
      for (const platform of ['linux', 'darwin', 'win32'] as const) {
        await expect(
          applyOverlay(noReads, src, [{ file, edits: [edit] }], { platform }),
          `${platform}: ${JSON.stringify(file)}`,
        ).rejects.toThrow(/is a latexmk configuration file/);
      }
    }
  });

  it('still accepts a name that only contains the rc name', async () => {
    const src = await tempDir('laneA-rc-ok-');
    await put(src, 'latexmkrc.tex', 'x\n');
    await put(src, 'latexmkrc/main.tex', 'x\n');
    const out = await applyOverlay(
      {
        readTextExact: async (dir, rel) =>
          (await import('node:fs/promises')).readFile(path.join(dir, rel), 'utf8'),
        linkTarget: async () => null,
      },
      src,
      [
        { file: 'latexmkrc.tex', edits: [edit] },
        { file: 'latexmkrc/main.tex', edits: [edit] },
      ],
      { platform: 'linux', caseProbe: async () => false },
    );
    expect([...out.keys()]).toEqual(['latexmkrc.tex', 'latexmkrc/main.tex']);
  });
});

describe("the project root's .git: commondir, config.worktree and submodules (A-B2, A-D2)", () => {
  it('reports a write to .git/commondir or .git/config.worktree', async () => {
    const src = await tempDir('laneA-git-');
    await put(src, 'main.tex', 'main\n');
    await put(src, '.git/HEAD', 'ref: refs/heads/master\n');
    await put(src, '.git/config', '[core]\n');
    const before = await snapshotSource(src, { skip: [] });
    // git never writes commondir in a main repository: one pointing elsewhere makes git read
    // that directory's config (and its core.fsmonitor) on the next command.
    await put(src, '.git/commondir', '../evil\n');
    await put(src, '.git/config.worktree', '[core]\n\tfsmonitor = "echo pwned"\n');
    expect(sourceChanges(before!, (await snapshotSource(src, { skip: [] }))!)).toEqual([
      '.git/commondir',
      '.git/config.worktree',
    ]);
  });

  it("reports a write to a submodule's config or hooks, nested and slash-named ones included, and not its churn", async () => {
    const src = await tempDir('laneA-gitmod-');
    await put(src, 'main.tex', 'main\n');
    await put(src, '.git/HEAD', 'ref: refs/heads/master\n');
    // A submodule's git directory, one named `libs/foo` (so under an intermediate directory),
    // and one nested in the first.
    for (const m of [
      '.git/modules/sub',
      '.git/modules/libs/foo',
      '.git/modules/sub/modules/inner',
    ]) {
      await put(src, `${m}/HEAD`, 'ref: refs/heads/master\n');
      await put(src, `${m}/config`, '[core]\n');
      await put(src, `${m}/index`, 'index');
      await put(src, `${m}/hooks/pre-commit.sample`, '#!/bin/sh\n');
      await put(src, `${m}/objects/ab/cdef`, 'blob');
      await put(src, `${m}/refs/heads/master`, 'abc\n');
    }
    const before = await snapshotSource(src, { skip: [] });

    // What git moves in a submodule's git directory on every call: never reported.
    for (const m of [
      '.git/modules/sub',
      '.git/modules/libs/foo',
      '.git/modules/sub/modules/inner',
    ]) {
      await writeFile(path.join(src, m, 'index'), 'index moved');
      await writeFile(path.join(src, m, 'HEAD'), 'ref: refs/heads/other\n');
      await put(src, `${m}/objects/12/3456`, 'new blob');
      await put(src, `${m}/refs/heads/config`, 'def\n');
      await put(src, `${m}/logs/HEAD`, 'log');
    }
    expect(sourceChanges(before!, (await snapshotSource(src, { skip: [] }))!)).toEqual([]);

    // What `git status` in the superproject reads or runs for each submodule: reported.
    await writeFile(path.join(src, '.git/modules/sub/config'), '[core]\n\tfsmonitor = x\n');
    await put(src, '.git/modules/libs/foo/hooks/post-checkout', '#!/bin/sh\n');
    await put(src, '.git/modules/sub/modules/inner/commondir', '../evil\n');
    expect(sourceChanges(before!, (await snapshotSource(src, { skip: [] }))!)).toEqual([
      '.git/modules/libs/foo/hooks/post-checkout',
      '.git/modules/sub/config',
      '.git/modules/sub/modules/inner/commondir',
    ]);
  });

  it("a submodule named HEAD (or libs/HEAD) does not hide every other submodule's config and hooks", async () => {
    const src = await tempDir('laneA-gitmod-head-');
    await put(src, 'main.tex', 'main\n');
    await put(src, '.git/HEAD', 'ref: refs/heads/master\n');
    // `HEAD` puts a directory named HEAD in `.git/modules` itself; `libs/HEAD` puts one in the
    // step `libs`, beside its sibling `libs/foo`.
    const mods = [
      '.git/modules/HEAD',
      '.git/modules/sub',
      '.git/modules/libs/HEAD',
      '.git/modules/libs/foo',
    ];
    for (const m of mods) {
      await put(src, `${m}/HEAD`, 'ref: refs/heads/master\n');
      await put(src, `${m}/config`, '[core]\n');
      await put(src, `${m}/hooks/pre-commit.sample`, '#!/bin/sh\n');
      await put(src, `${m}/objects/ab/cdef`, 'blob');
      await put(src, `${m}/refs/heads/master`, 'abc\n');
    }
    const before = await snapshotSource(src, { skip: [] });
    for (const m of mods) await writeFile(path.join(src, m, 'config'), '[core]\n\tfsmonitor = x\n');
    await put(src, '.git/modules/sub/hooks/post-checkout', '#!/bin/sh\n');
    await put(src, '.git/modules/libs/foo/hooks/post-checkout', '#!/bin/sh\n');
    // Churn in a submodule's git directory is still not reported.
    await put(src, '.git/modules/sub/objects/12/3456', 'new blob');
    expect(sourceChanges(before!, (await snapshotSource(src, { skip: [] }))!)).toEqual([
      '.git/modules/HEAD/config',
      '.git/modules/libs/HEAD/config',
      '.git/modules/libs/foo/config',
      '.git/modules/libs/foo/hooks/post-checkout',
      '.git/modules/sub/config',
      '.git/modules/sub/hooks/post-checkout',
    ]);
  });

  it('.git/modules itself is never read as a git directory, even with a HEAD file, objects and refs', async () => {
    const src = await tempDir('laneA-gitmod-root-');
    await put(src, 'main.tex', 'main\n');
    await put(src, '.git/HEAD', 'ref: refs/heads/master\n');
    // Planted to look like a git directory at the container's own level.
    await put(src, '.git/modules/HEAD', 'ref: refs/heads/master\n');
    await put(src, '.git/modules/objects/ab/cdef', 'blob');
    await put(src, '.git/modules/refs/heads/master', 'abc\n');
    for (const f of ['HEAD', 'config', 'objects/ab/cdef', 'refs/heads/master']) {
      await put(src, `.git/modules/sub/${f}`, 'x\n');
    }
    const before = await snapshotSource(src, { skip: [] });
    await writeFile(path.join(src, '.git/modules/sub/config'), '[core]\n\tfsmonitor = x\n');
    expect(sourceChanges(before!, (await snapshotSource(src, { skip: [] }))!)).toEqual([
      '.git/modules/sub/config',
    ]);
  });

  it('names commondir and submodules in the hint sentence for a .git path', () => {
    const hint = sourceChangedHint(['.git/modules/sub/config']);
    expect(hint).toContain('commondir');
    expect(hint).toContain("a submodule's config or hooks");
  });
});

describe('retention orders by seq, not by a wall clock (A-N9)', () => {
  const stage = (src: string, handle: string, now: Date) =>
    stageVariant({
      projectDir: src,
      handle,
      rootFile: 'main.tex',
      engine: 'pdflatex',
      compiler: 'latexmk',
      contents: new Map(),
      skip: [],
      now,
    });

  it('keeps the variants compiled last when the clock stepped back between compiles', async () => {
    const src = await tempDir('laneA-clock-');
    await put(src, 'main.tex', 'main\n');
    // Compiled in this order, each with a clock an hour behind the one before.
    const handles = ['v000000000001', 'v000000000002', 'v000000000003', 'v000000000004'];
    for (const [i, h] of handles.entries()) {
      await stage(src, h, new Date(Date.UTC(2026, 0, 1, 10 - i)));
    }
    const removed = await evictVariants(src, 2, 'v000000000004');
    // The newest by compile order is v003; by usedAt it would have been v001.
    expect(removed.sort()).toEqual(['v000000000001', 'v000000000002']);
  });

  it('renumbers rather than stamp a seq past the largest safe integer', async () => {
    const src = await tempDir('laneA-seqmax-');
    await put(src, 'main.tex', 'main\n');
    const now = new Date(Date.UTC(2026, 0, 1));
    await stage(src, 'v000000000001', now);
    const big = variantPaths(src, 'v000000000002');
    await mkdir(big.out, { recursive: true });
    await writeManifest(big.manifest, {
      rootFile: 'main.tex',
      createdAt: now.toISOString(),
      usedAt: now.toISOString(),
      seq: Number.MAX_SAFE_INTEGER,
      files: [],
      compiler: 'latexmk',
      engine: 'pdflatex',
    });
    await stage(src, 'v000000000003', now);
    const seqOf = async (h: string) => (await readManifest(variantPaths(src, h).manifest))?.seq;
    const s1 = await seqOf('v000000000001');
    const s2 = await seqOf('v000000000002');
    const s3 = await seqOf('v000000000003');
    for (const s of [s1, s2, s3]) expect(Number.isSafeInteger(s), String(s)).toBe(true);
    // Compile order survives the renumbering: 001, then 002, then the new one.
    expect(s1! < s2! && s2! < s3!).toBe(true);
    const removed = await evictVariants(src, 2, 'v000000000003');
    expect(removed).toEqual(['v000000000001']);
  });
});

describe('a build root that vanishes after its check is never recreated loose (A-D1)', () => {
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

  posixOnly('creates the root owner-only when a cleaner removed it before the probe', async () => {
    const tmp = await tempDir('laneA-vanish-');
    await withTmpdir(tmp, async () => {
      // As if ensureBuildRoot had passed and a /tmp cleaner then removed the idle root.
      const dir = path.join(buildDir(path.join(tmp, 'proj')), 'variants');
      await expect(stat(buildRoot())).rejects.toThrow();
      expect(typeof (await probeCaseInsensitive(dir))).toBe('boolean');
      expect((await lstat(buildRoot())).mode & 0o777).toBe(0o700);
    });
  });

  posixOnly('refuses to probe in a root replaced by a link after its check', async () => {
    const tmp = await tempDir('laneA-swap-');
    const theirs = await tempDir('laneA-swap-theirs-');
    await withTmpdir(tmp, async () => {
      await symlink(theirs, buildRoot());
      const dir = path.join(buildDir(path.join(tmp, 'proj')), 'variants');
      await expect(probeCaseInsensitive(dir)).rejects.toThrow(/^Refusing to .*symbolic link/s);
      // No probe file was ever written into their directory.
      const files: string[] = [];
      const walk = async (d: string): Promise<void> => {
        for (const e of await readdir(d, { withFileTypes: true })) {
          if (e.isDirectory()) await walk(path.join(d, e.name));
          else files.push(e.name);
        }
      };
      await walk(theirs);
      expect(files).toEqual([]);
    });
  });
  posixOnly(
    'refuses a level under the root that is a link, before probing through it',
    async () => {
      const tmp = await tempDir('laneA-level-');
      const theirs = await tempDir('laneA-level-theirs-');
      await withTmpdir(tmp, async () => {
        await ensureBuildRoot();
        const proj = buildDir(path.join(tmp, 'proj'));
        await mkdir(proj);
        await symlink(theirs, path.join(proj, 'variants'));
        await expect(probeCaseInsensitive(path.join(proj, 'variants'))).rejects.toThrow(
          /^Refusing to use build directory .*symbolic link/s,
        );
        expect(await readdir(theirs)).toEqual([]);
      });
    },
  );
});

describe('a directory named like "..foo" at each climbsOut site of the farm (A-D6)', () => {
  it('isWithin: a link into "..foo" under a skipped tree is not walked; a sibling is', async () => {
    const src = await tempDir('laneA-dotdir-');
    const tree = await tempDir('laneA-dotdir-tree-');
    await put(src, 'main.tex', 'main\n');
    await put(tree, '..foo/out/main.log', 'log\n');
    await put(tree, 'sibling.tex', 'x\n');
    await linkDir(path.join(tree, '..foo'), path.join(src, 'b'));
    const opts = { skip: [], skipTree: [path.join(tree, 'sub')] };
    // `tree/..foo` is not under `tree/sub`: a real `../` climb, so the link is walked.
    const walked = await snapshotSource(src, opts);
    expect([...walked!.entries.keys()].sort()).toEqual([
      'b',
      'b/out',
      'b/out/main.log',
      'main.tex',
    ]);
    // `tree/..foo` IS under `tree`: a directory named "..foo", not a climb, so it is skipped.
    const skipped = await snapshotSource(src, { skip: [], skipTree: [tree] });
    expect([...skipped!.entries.keys()].sort()).toEqual(['b', 'main.tex']);
  });

  it('refuseLinkedRootDir: suggests a "..foo" spelling, and never a real climb', async () => {
    const src = await tempDir('laneA-dotdir-root-');
    const outside = await tempDir('laneA-dotdir-out-');
    await put(src, '..foo/p1/main.tex', 'x\n');
    await put(outside, 'main.tex', 'x\n');
    // The absolute root inside "..foo": the relative spelling is suggested.
    await expect(
      refuseLinkedRootDir(src, path.join(src, '..foo', 'p1', 'main.tex')),
    ).rejects.toThrow(/absolute.*rootFile: "\.\.foo\/p1\/main\.tex"/s);
    // An absolute root outside: no spelling suggested (it would start with "../").
    const abs = refuseLinkedRootDir(src, path.join(outside, 'main.tex'));
    await expect(abs).rejects.toThrow(/Name it relative to the project root\.$/);
    // A link into "..foo": its real path is offered; a link out of the project: none is.
    await linkDir(path.join(src, '..foo', 'p1'), path.join(src, 'paper'));
    await expect(refuseLinkedRootDir(src, 'paper/main.tex')).rejects.toThrow(
      /rootFile: "\.\.foo\/p1\/main\.tex"/,
    );
    await linkDir(outside, path.join(src, 'ext'));
    await expect(refuseLinkedRootDir(src, 'ext/main.tex')).rejects.toThrow(
      /not a directory inside the project/,
    );
  });
});

describe('every fold decision of a variant probes one directory (A-N12)', () => {
  it("stageVariant asks the probe about the project's variants directory, as applyOverlay does", async (ctx) => {
    const src = await tempDir('laneA-probedir-');
    await put(src, 'main.tex', 'main\n');
    await put(src, 'sec/Notes.tex', 'upper\n');
    await put(src, 'sec/notes.tex', 'lower\n');
    // A case-insensitive temp volume (the macOS and Windows defaults) keeps one file, not a
    // pair, and without a pair the farm never asks the probe anything.
    if ((await readdir(path.join(src, 'sec'))).length < 2) ctx.skip();
    const dirs: string[] = [];
    const probe: CaseProbe = async (dir) => {
      dirs.push(dir);
      return false;
    };
    await stageVariant({
      projectDir: src,
      handle: 'v000000000001',
      rootFile: 'main.tex',
      engine: 'pdflatex',
      compiler: 'latexmk',
      contents: new Map([['sec/notes.tex', 'edited\n']]),
      skip: [],
      caseProbe: probe,
    });
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) expect(d).toBe(path.join(buildDir(src), 'variants'));
  });
});

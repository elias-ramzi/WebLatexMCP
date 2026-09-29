/**
 * A submodule's git directory under `.git/modules` is recognised the way git's `is_git_directory`
 * recognises one, so its `config` and `hooks/` are watched during an overlay build. The walk used to
 * accept only a regular-file `HEAD` beside real `objects/` and `refs/` directories, so three layouts
 * git accepts went unwatched: a `HEAD` that is a symbolic link (`core.preferSymlinkRefs`), a git
 * directory that shares its objects and refs through `commondir`, and one whose `objects/` or
 * `refs/` is a link to a directory. `.git/modules` itself is still never a git directory.
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { snapshotSource, sourceChanges } from '../../src/lib/variants.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function put(root: string, rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), content);
}

/** File symlinks need a privilege on Windows; a directory link is made as a junction there. */
const posixOnly = it.skipIf(process.platform === 'win32');

/** A project whose `.git/modules/sub` is a submodule git directory laid out by `layout`. */
async function project(layout: (src: string, m: string) => Promise<void>): Promise<string> {
  const src = await tempDir('r4-gitdir-');
  await put(src, 'main.tex', 'main\n');
  await put(src, '.git/HEAD', 'ref: refs/heads/master\n');
  // A complete sibling submodule git directory that the others can point into.
  const other = '.git/modules/other';
  await put(src, `${other}/HEAD`, 'ref: refs/heads/master\n');
  await put(src, `${other}/objects/ab/cdef`, 'blob');
  await put(src, `${other}/refs/heads/master`, 'abc\n');
  await put(src, `${other}/config`, '[core]\n');
  await put(src, '.git/modules/sub/config', '[core]\n');
  await put(src, '.git/modules/sub/hooks/pre-commit.sample', '#!/bin/sh\n');
  await layout(src, '.git/modules/sub');
  return src;
}

/** Write what `git status` in the superproject would read or run for `sub`, and diff. */
async function changedAfterWrite(src: string): Promise<string[]> {
  const before = await snapshotSource(src, { skip: [] });
  await writeFile(path.join(src, '.git/modules/sub/config'), '[core]\n\tfsmonitor = x\n');
  await put(src, '.git/modules/sub/hooks/post-checkout', '#!/bin/sh\n');
  return sourceChanges(before!, (await snapshotSource(src, { skip: [] }))!);
}

const WATCHED = ['.git/modules/sub/config', '.git/modules/sub/hooks/post-checkout'];

describe("a submodule git directory is judged as git's is_git_directory judges one", () => {
  posixOnly('HEAD as a symbolic link (core.preferSymlinkRefs)', async () => {
    const src = await project(async (root, m) => {
      await put(root, `${m}/objects/ab/cdef`, 'blob');
      await put(root, `${m}/refs/heads/master`, 'abc\n');
      await symlink('refs/heads/master', path.join(root, m, 'HEAD'));
    });
    expect(await changedAfterWrite(src)).toEqual(WATCHED);
  });

  it('HEAD plus a commondir file, with no objects/ or refs/ of its own', async () => {
    const src = await project(async (root, m) => {
      await put(root, `${m}/HEAD`, 'ref: refs/heads/master\n');
      await put(root, `${m}/commondir`, '../other\n');
    });
    expect(await changedAfterWrite(src)).toEqual(WATCHED);
  });

  it('objects/ and refs/ as links to directories', async () => {
    const src = await project(async (root, m) => {
      await put(root, `${m}/HEAD`, 'ref: refs/heads/master\n');
      await symlink(
        path.join(root, '.git/modules/other/objects'),
        path.join(root, m, 'objects'),
        'junction',
      );
      await symlink(
        path.join(root, '.git/modules/other/refs'),
        path.join(root, m, 'refs'),
        'junction',
      );
    });
    expect(await changedAfterWrite(src)).toEqual(WATCHED);
  });

  it('.git/modules itself is still never a git directory, commondir or not', async () => {
    const src = await project(async (root, m) => {
      await put(root, `${m}/HEAD`, 'ref: refs/heads/master\n');
      await put(root, `${m}/objects/ab/cdef`, 'blob');
      await put(root, `${m}/refs/heads/master`, 'abc\n');
    });
    // Planted to look like a commondir git directory at the container's own level.
    await put(src, '.git/modules/HEAD', 'ref: refs/heads/master\n');
    await put(src, '.git/modules/commondir', 'other\n');
    expect(await changedAfterWrite(src)).toEqual(WATCHED);
  });

  it('a step directory holding only a commondir DIRECTORY is not a git directory', async () => {
    // `commondir` must be a file: a submodule named `libs/commondir` puts a directory there.
    const src = await tempDir('r4-gitdir-step-');
    await put(src, 'main.tex', 'main\n');
    await put(src, '.git/HEAD', 'ref: refs/heads/master\n');
    for (const m of ['.git/modules/libs/commondir', '.git/modules/libs/foo']) {
      await put(src, `${m}/HEAD`, 'ref: refs/heads/master\n');
      await put(src, `${m}/objects/ab/cdef`, 'blob');
      await put(src, `${m}/refs/heads/master`, 'abc\n');
      await put(src, `${m}/config`, '[core]\n');
    }
    await put(src, '.git/modules/libs/HEAD/x', 'x');
    const before = await snapshotSource(src, { skip: [] });
    await writeFile(path.join(src, '.git/modules/libs/foo/config'), '[core]\n\tfsmonitor = x\n');
    expect(sourceChanges(before!, (await snapshotSource(src, { skip: [] }))!)).toEqual([
      '.git/modules/libs/foo/config',
    ]);
  });
});

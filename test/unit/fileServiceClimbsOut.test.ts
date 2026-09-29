import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { FileService } from '../../src/services/fileService.js';
import { toPosix } from '../../src/lib/paths.js';

/**
 * #227 at the two `FileService` sites: `assertNoSymlinkEscape` (the sandbox guard every read,
 * write and delete goes through) and `resolveLinkTarget` (what `linkTarget` and the mutation
 * recorder are told). Both read `path.relative(realRoot, target)` with `startsWith('..')`, so an
 * in-project link landing in a directory named `..foo` was refused as an escape, and — once let
 * through — reported under its absolute path as though it had left the project.
 *
 * The link sits OUTSIDE `..foo` on purpose (`notes.tex -> ..foo/real.tex`): its own name passes
 * `resolveInside`'s string check whatever that does, so each test reaches the site it is about.
 * Symlinks need privileges on Windows, as in `fileServiceLinks.test.ts`.
 */
describe.skipIf(process.platform === 'win32')('FileService with a `..foo/` directory', () => {
  let parent: string;
  let dir: string;
  let files: FileService;
  let recorded: string[];

  beforeEach(async () => {
    parent = await mkdtemp(path.join(os.tmpdir(), 'ovl-climb-'));
    dir = path.join(parent, 'proj');
    await mkdir(path.join(dir, '..foo'), { recursive: true });
    await writeFile(path.join(dir, '..foo', 'real.tex'), 'A\n', 'utf8');
    await symlink(path.join('..foo', 'real.tex'), path.join(dir, 'notes.tex'));
    await writeFile(path.join(parent, 'outside.tex'), 'SECRET\n', 'utf8');
    files = new FileService();
    recorded = [];
    files.setMutationRecorder({
      record: async (_projectDir, relPath) => {
        recorded.push(relPath);
      },
    });
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  describe('assertNoSymlinkEscape', () => {
    it('lets an in-project link into `..foo/` through', async () => {
      const { content } = await files.read(dir, { path: 'notes.tex' });
      expect(content).toContain('A');
      expect(await files.leavesProjectThroughLink(dir, 'notes.tex')).toBe(false);
    });

    it('still refuses a link that climbs out (`../x` and `..`)', async () => {
      await symlink(path.join('..', 'outside.tex'), path.join(dir, 'out.tex'));
      await expect(files.read(dir, { path: 'out.tex' })).rejects.toThrow(
        /escapes the project root through a symlink/,
      );
      await expect(files.write(dir, { path: 'out.tex', content: 'pwned\n' })).rejects.toThrow(
        /escapes the project root through a symlink/,
      );
      expect(await readFile(path.join(parent, 'outside.tex'), 'utf8')).toBe('SECRET\n');

      await symlink('..', path.join(dir, 'up'));
      expect(await files.leavesProjectThroughLink(dir, 'up')).toBe(true);
      await expect(files.read(dir, { path: 'up/outside.tex' })).rejects.toThrow(
        /escapes the project root through a symlink/,
      );
    });
  });

  describe('resolveLinkTarget', () => {
    it('names an in-project `..foo/` target project-relatively', async () => {
      expect(await files.linkTarget(dir, 'notes.tex')).toBe('..foo/real.tex');
      await files.write(dir, { path: 'notes.tex', content: 'B\n' });
      expect(recorded).toEqual(['..foo/real.tex']);
      expect(await readFile(path.join(dir, '..foo', 'real.tex'), 'utf8')).toBe('B\n');
    });

    it('still names a target outside the project absolutely (followSymlinks)', async () => {
      files.setLinkPolicy(() => true);
      await symlink(path.join('..', 'outside.tex'), path.join(dir, 'out.tex'));
      await symlink('..', path.join(dir, 'up'));
      const realParent = await realpath(parent);
      expect(await files.linkTarget(dir, 'out.tex')).toBe(
        toPosix(path.join(realParent, 'outside.tex')),
      );
      expect(await files.linkTarget(dir, 'up')).toBe(toPosix(realParent));
    });
  });
});

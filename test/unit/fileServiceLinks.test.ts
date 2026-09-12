import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises';
import { FileService, ExternalChangeError } from '../../src/services/fileService.js';

/**
 * A write through an in-project symlink must be attributed to the link's TARGET, never the
 * link's own name — otherwise the shadow store three-way-merges the link's *target string*
 * (its blob content, e.g. "main.tex") against the caller's text, flags a bogus conflict, and
 * the real edit to the target file is recorded under nobody at all. See CLAUDE.md's "Parallel
 * sessions share a clone; commits don't" bullet and issue #66 item 4.
 */
describe.skipIf(process.platform === 'win32')('FileService attributes writes through links', () => {
  let dir: string;
  let files: FileService;
  let calls: Array<{
    relPath: string;
    before: string | Buffer | null;
    after: string | Buffer | null;
  }>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-links-'));
    files = new FileService();
    calls = [];
    files.setMutationRecorder({
      record: async (_projectDir, relPath, before, after) => {
        calls.push({ relPath, before, after });
      },
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('write through a tracked link records under the target, not the link', async () => {
    await writeFile(path.join(dir, 'main.tex'), 'A\n', 'utf8');
    await symlink('main.tex', path.join(dir, 'link.tex'));

    await files.write(dir, { path: 'link.tex', content: 'B\n' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.relPath).toBe('main.tex');
    expect(calls[0]!.before).toBe('A\n');
    expect(calls[0]!.after).toBe('B\n');
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('B\n');
  });

  it('applyEdits through a tracked link records under the target', async () => {
    await writeFile(path.join(dir, 'main.tex'), 'A\n', 'utf8');
    await symlink('main.tex', path.join(dir, 'link.tex'));

    await files.applyEdits(dir, 'link.tex', [{ oldString: 'A', newString: 'C' }]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.relPath).toBe('main.tex');
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('C\n');
  });

  it('writeBytes through a tracked link records under the target', async () => {
    await mkdir(path.join(dir, 'figures'), { recursive: true });
    const original = Buffer.from([1, 2, 3]);
    await writeFile(path.join(dir, 'figures', 'real.png'), original);
    await symlink(path.join('figures', 'real.png'), path.join(dir, 'link.png'));

    const bytes = Buffer.from([4, 5, 6]);
    await files.writeBytes(dir, { path: 'link.png', bytes });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.relPath).toBe('figures/real.png');
    expect(Buffer.compare(calls[0]!.after as Buffer, bytes)).toBe(0);
  });

  it('write through a DANGLING link creates and records under the target, leaving the link a symlink', async () => {
    await symlink('missing.tex', path.join(dir, 'link.tex'));

    await files.write(dir, { path: 'link.tex', content: 'N\n' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.relPath).toBe('missing.tex');
    expect(calls[0]!.before).toBeNull();
    expect(calls[0]!.after).toBe('N\n');
    expect(await readFile(path.join(dir, 'missing.tex'), 'utf8')).toBe('N\n');
    const linkStat = await lstat(path.join(dir, 'link.tex'));
    expect(linkStat.isSymbolicLink()).toBe(true);
  });

  it('delete removes only the link itself and is recorded under the link name (comment: rm(abs) unlinks the link, not the target)', async () => {
    await writeFile(path.join(dir, 'main.tex'), 'A\n', 'utf8');
    await symlink('main.tex', path.join(dir, 'link.tex'));

    await files.delete(dir, 'link.tex');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.relPath).toBe('link.tex');
    expect(calls[0]!.after).toBeNull();
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('A\n');
  });

  it('a plain file with no link involved is recorded under its own name', async () => {
    await writeFile(path.join(dir, 'plain.tex'), 'X\n', 'utf8');
    await files.write(dir, { path: 'plain.tex', content: 'Y\n' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.relPath).toBe('plain.tex');
  });

  it('a link to a target OUTSIDE the project (under followSymlinks) is recorded under the link name, never an absolute path', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'ovl-outside-'));
    try {
      await writeFile(path.join(outside, 'real.tex'), 'A\n', 'utf8');
      await symlink(path.join(outside, 'real.tex'), path.join(dir, 'out.tex'));

      files.setLinkPolicy(() => true);
      await files.write(dir, { path: 'out.tex', content: 'B\n' });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.relPath).toBe('out.tex');
      expect(path.isAbsolute(calls[0]!.relPath)).toBe(false);
      expect(await readFile(path.join(outside, 'real.tex'), 'utf8')).toBe('B\n');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('guard preservation (passes without the fix): the baseline stays keyed on the given path, so a direct write to the target still detects the earlier out-of-band edit', async () => {
    await writeFile(path.join(dir, 'main.tex'), 'A\n', 'utf8');
    await symlink('main.tex', path.join(dir, 'link.tex'));

    await files.write(dir, { path: 'link.tex', content: 'B\n' });

    // Nothing changed on disk since — a direct write to main.tex should succeed untouched.
    await files.write(dir, { path: 'main.tex', content: 'C\n' });
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('C\n');

    // Now a hand edit lands on the real file between writes.
    await files.write(dir, { path: 'main.tex', content: 'D\n' });
    await writeFile(path.join(dir, 'main.tex'), 'hand edited\n', 'utf8');
    await expect(files.write(dir, { path: 'main.tex', content: 'E\n' })).rejects.toThrow(
      ExternalChangeError,
    );
  });
});

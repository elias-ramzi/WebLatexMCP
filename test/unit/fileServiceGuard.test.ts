import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { FileService } from '../../src/services/fileService.js';

/** Simulate a user editing the clone directly, outside the server's tools. */
async function editOnDisk(dir: string, rel: string, content: string): Promise<void> {
  await writeFile(path.join(dir, rel), content, 'utf8');
}

describe('FileService out-of-band edit guard', () => {
  let dir: string;
  let files: FileService;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-guard-'));
    await mkdir(path.join(dir, '.git'), { recursive: true });
    await writeFile(path.join(dir, 'main.tex'), 'original\n', 'utf8');
    files = new FileService();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses to overwrite a file changed on disk since it was read', async () => {
    await files.read(dir, { path: 'main.tex' });
    await editOnDisk(dir, 'main.tex', 'edited by the user\n');

    await expect(
      files.write(dir, { path: 'main.tex', content: 'agent version\n' }),
    ).rejects.toThrow(/changed on disk/);
    // The user's edit is preserved, not clobbered.
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('edited by the user\n');
  });

  it('overwrites anyway with overrideExternalChanges', async () => {
    await files.read(dir, { path: 'main.tex' });
    await editOnDisk(dir, 'main.tex', 'edited by the user\n');

    const res = await files.write(dir, {
      path: 'main.tex',
      content: 'agent version\n',
      overrideExternalChanges: true,
    });
    expect(res.created).toBe(false);
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('agent version\n');
  });

  it('allows writing a file it never read (no baseline)', async () => {
    // No prior read of new.tex — a deliberate create, not a stale overwrite.
    const res = await files.write(dir, { path: 'new.tex', content: 'fresh\n' });
    expect(res.created).toBe(true);
  });

  it('re-reading refreshes the baseline so the next write succeeds', async () => {
    await files.read(dir, { path: 'main.tex' });
    await editOnDisk(dir, 'main.tex', 'edited by the user\n');
    await files.read(dir, { path: 'main.tex' }); // acknowledge the change

    await expect(
      files.write(dir, { path: 'main.tex', content: 'agent version\n' }),
    ).resolves.toMatchObject({ path: 'main.tex' });
  });

  it('refuses edit_file on an out-of-band change', async () => {
    await files.read(dir, { path: 'main.tex' });
    await editOnDisk(dir, 'main.tex', 'user rewrote everything\n');

    await expect(
      files.applyEdits(dir, 'main.tex', [{ oldString: 'original', newString: 'x' }]),
    ).rejects.toThrow(/changed on disk/);
  });

  it('refuses delete on an out-of-band change', async () => {
    await files.read(dir, { path: 'main.tex' });
    await editOnDisk(dir, 'main.tex', 'user is still working here\n');

    await expect(files.delete(dir, 'main.tex')).rejects.toThrow(/changed on disk/);
  });

  it('resetBaselines clears the guard (used after pull/discard)', async () => {
    await files.read(dir, { path: 'main.tex' });
    await editOnDisk(dir, 'main.tex', 'rewritten by git\n');
    files.resetBaselines(dir);

    // No baseline after reset → treated as a fresh file, write proceeds.
    await expect(
      files.write(dir, { path: 'main.tex', content: 'agent version\n' }),
    ).resolves.toMatchObject({ path: 'main.tex' });
  });

  describe('externalModifications', () => {
    it('flags files the user changed but not files the tools wrote', async () => {
      // tool-written file: baseline matches disk
      await files.write(dir, { path: 'tool.tex', content: 'by tool\n' });
      // user-edited file: read, then changed on disk
      await files.read(dir, { path: 'main.tex' });
      await editOnDisk(dir, 'main.tex', 'by user\n');
      // brand-new file the user dropped in: never seen by the tools
      await editOnDisk(dir, 'user-new.tex', 'user new\n');

      const external = await files.externalModifications(dir, [
        'tool.tex',
        'main.tex',
        'user-new.tex',
      ]);
      expect(external.sort()).toEqual(['main.tex', 'user-new.tex']);
    });

    it('skips paths that no longer exist', async () => {
      const external = await files.externalModifications(dir, ['gone.tex']);
      expect(external).toEqual([]);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
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
    await files.read(dir, { path: 'main.tex', recordBaseline: true });
    await editOnDisk(dir, 'main.tex', 'edited by the user\n');

    await expect(
      files.write(dir, { path: 'main.tex', content: 'agent version\n' }),
    ).rejects.toThrow(/changed on disk/);
    // The user's edit is preserved, not clobbered.
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('edited by the user\n');
  });

  it('overwrites anyway with overrideExternalChanges', async () => {
    await files.read(dir, { path: 'main.tex', recordBaseline: true });
    await editOnDisk(dir, 'main.tex', 'edited by the user\n');

    const res = await files.write(dir, {
      path: 'main.tex',
      content: 'agent version\n',
      overrideExternalChanges: true,
    });
    expect(res.created).toBe(false);
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('agent version\n');
  });

  it('a read the server makes for itself does not refresh the baseline', async () => {
    await files.read(dir, { path: 'main.tex', recordBaseline: true });
    await editOnDisk(dir, 'main.tex', 'edited by the user\n');
    // Detecting the root file, or showing the source around a compile error, is the server's own
    // initiative — not the caller acknowledging the change. So neither claims the bytes.
    const seen = await files.read(dir, { path: 'main.tex' });
    expect(seen.content).toContain('edited by the user');
    await files.readText(dir, 'main.tex');

    await expect(
      files.write(dir, { path: 'main.tex', content: 'agent version\n' }),
    ).rejects.toThrow(/changed on disk/);
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('edited by the user\n');
  });

  it('keeps one identity for a project reached through a symlink', async () => {
    // macOS hands out /var/folders/… for a real /private/var/folders/…, and Windows a short 8.3
    // path — so resolving reads through realpath while writes resolve the given string filed the
    // baseline under a key the write never looks up, and the guard silently stopped firing.
    const real = await mkdtemp(path.join(os.tmpdir(), 'ovl-real-'));
    const parent = await mkdtemp(path.join(os.tmpdir(), 'ovl-link-'));
    const link = path.join(parent, 'project');
    try {
      await writeFile(path.join(real, 'main.tex'), 'original\n', 'utf8');
      await symlink(real, link, 'dir');

      await files.read(link, { path: 'main.tex', recordBaseline: true });
      await writeFile(path.join(real, 'main.tex'), 'edited by the user\n', 'utf8');

      await expect(
        files.write(link, { path: 'main.tex', content: 'agent version\n' }),
      ).rejects.toThrow(/changed on disk/);
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(real, { recursive: true, force: true });
    }
  });

  it('refuses every way through a symlink that leaves the project — writes included', async () => {
    // Git stores a symlink as mode 120000, so a collaborator can commit one; write is the half
    // that turns that into someone else's file being overwritten.
    const outside = await mkdtemp(path.join(os.tmpdir(), 'ovl-outside-'));
    try {
      const secret = path.join(outside, 'secret.txt');
      await writeFile(secret, 'PRIVATE KEY\n', 'utf8');
      await symlink(secret, path.join(dir, 'notes.tex'));

      await expect(files.read(dir, { path: 'notes.tex' })).rejects.toThrow(/symlink/);
      await expect(files.readText(dir, 'notes.tex')).rejects.toThrow(/symlink/);
      await expect(files.write(dir, { path: 'notes.tex', content: 'PWNED\n' })).rejects.toThrow(
        /symlink/,
      );
      await expect(
        files.applyEdits(dir, 'notes.tex', [{ oldString: 'PRIVATE', newString: 'PWNED' }]),
      ).rejects.toThrow(/symlink/);
      await expect(files.delete(dir, 'notes.tex')).rejects.toThrow(/symlink/);

      expect(await readFile(secret, 'utf8')).toBe('PRIVATE KEY\n');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  describe('a project whose owner places its own links (mode: local)', () => {
    it('follows a symlink the user put there', async () => {
      // One shared refs.bib symlinked into each paper is an ordinary LaTeX layout, and a local
      // project is a directory the user registered in place. The guard is for links the user did
      // NOT choose: one committed into a shared clone, or one a compile log named.
      const shared = await mkdtemp(path.join(os.tmpdir(), 'ovl-shared-'));
      try {
        await writeFile(path.join(shared, 'refs.bib'), '@misc{a, title={A}}\n', 'utf8');
        await symlink(path.join(shared, 'refs.bib'), path.join(dir, 'refs.bib'));
        await symlink(shared, path.join(dir, 'shared'), 'dir');
        await writeFile(path.join(shared, 'macros.tex'), 'macros\n', 'utf8');

        const local = new FileService();
        local.setLinkPolicy(() => true);

        expect(await local.readText(dir, 'refs.bib')).toContain('@misc{a');
        expect((await local.read(dir, { path: 'shared/macros.tex' })).content).toBe('macros\n');
        await local.write(dir, { path: 'refs.bib', content: '@misc{a, title={B}}\n' });
        expect(await readFile(path.join(shared, 'refs.bib'), 'utf8')).toBe('@misc{a, title={B}}\n');
      } finally {
        await rm(shared, { recursive: true, force: true });
      }
    });

    it('still refuses a path the server picked up rather than the caller naming it', async () => {
      // A compile log is document-controlled, so `strictLinks` overrides the policy: this is the
      // path compile's snippets and list_comments' snippets take.
      const outside = await mkdtemp(path.join(os.tmpdir(), 'ovl-outside2-'));
      try {
        await writeFile(path.join(outside, 'secret.txt'), 'PRIVATE KEY\n', 'utf8');
        await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'notes.tex'));

        const local = new FileService();
        local.setLinkPolicy(() => true);

        expect((await local.read(dir, { path: 'notes.tex' })).content).toContain('PRIVATE');
        await expect(local.read(dir, { path: 'notes.tex', strictLinks: true })).rejects.toThrow(
          /symlink/,
        );
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('refuses a write through a symlink whose target does not exist yet', async () => {
    // realpath cannot see where a dangling link points, but writeFile follows it and creates the
    // file at the other end.
    const outside = await mkdtemp(path.join(os.tmpdir(), 'ovl-dangling-'));
    try {
      const target = path.join(outside, 'not-yet.txt');
      await symlink(target, path.join(dir, 'new.tex'));
      await expect(files.write(dir, { path: 'new.tex', content: 'PWNED\n' })).rejects.toThrow(
        /symlink/,
      );
      await expect(stat(target)).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('still writes a file that does not exist yet, and one inside a new subdirectory', async () => {
    expect((await files.write(dir, { path: 'fresh.tex', content: 'hi\n' })).created).toBe(true);
    expect(
      (await files.write(dir, { path: 'sub/deep/new.tex', content: 'hi\n', createDirs: true }))
        .created,
    ).toBe(true);
  });

  it('allows writing a file it never read (no baseline)', async () => {
    // No prior read of new.tex — a deliberate create, not a stale overwrite.
    const res = await files.write(dir, { path: 'new.tex', content: 'fresh\n' });
    expect(res.created).toBe(true);
  });

  it('re-reading refreshes the baseline so the next write succeeds', async () => {
    await files.read(dir, { path: 'main.tex', recordBaseline: true });
    await editOnDisk(dir, 'main.tex', 'edited by the user\n');
    await files.read(dir, { path: 'main.tex', recordBaseline: true }); // acknowledge the change

    await expect(
      files.write(dir, { path: 'main.tex', content: 'agent version\n' }),
    ).resolves.toMatchObject({ path: 'main.tex' });
  });

  it('refuses edit_file on an out-of-band change', async () => {
    await files.read(dir, { path: 'main.tex', recordBaseline: true });
    await editOnDisk(dir, 'main.tex', 'user rewrote everything\n');

    await expect(
      files.applyEdits(dir, 'main.tex', [{ oldString: 'original', newString: 'x' }]),
    ).rejects.toThrow(/changed on disk/);
  });

  it('refuses delete on an out-of-band change', async () => {
    await files.read(dir, { path: 'main.tex', recordBaseline: true });
    await editOnDisk(dir, 'main.tex', 'user is still working here\n');

    await expect(files.delete(dir, 'main.tex')).rejects.toThrow(/changed on disk/);
  });

  it('resetBaselines clears the guard (used after pull/discard)', async () => {
    await files.read(dir, { path: 'main.tex', recordBaseline: true });
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
      await files.read(dir, { path: 'main.tex', recordBaseline: true });
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

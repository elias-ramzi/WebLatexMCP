import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { MigrationRefusedError, migrateWorkspace } from '../../src/services/workspaceMigration.js';
import { cp } from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { SessionRegistry } from '../../src/services/sessionRegistry.js';
import { registryPath } from '../../src/services/projectRegistry.js';
import { projectLockPath } from '../../src/lib/sessionPaths.js';

// Creating a symlink on Windows needs a privilege CI runners do not grant; the link cases run
// everywhere else, as in the rest of the suite.
const WINDOWS = process.platform === 'win32';

/** Whether the temp dir's disk folds letter case, probed once, synchronously, for `skipIf`. */
const CASE_INSENSITIVE = ((): boolean => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wlm-case-'));
  try {
    mkdirSync(path.join(dir, 'probe'));
    return existsSync(path.join(dir, 'PROBE'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** A recursive listing (relative POSIX paths), to prove a refusal changed nothing. */
async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(path.join(root, rel));
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = await lstat(path.join(root, r));
      // Content too: a refusal that rewrote registry.json must not pass as "changed nothing".
      out.push(st.isFile() ? `${r} ${await readFile(path.join(root, r), 'utf8')}` : r);
      if (st.isDirectory()) await walk(r);
    }
  };
  await walk('');
  return out;
}

/** An older version's workspace-local folder with two clones, a PDF and session state. */
async function legacyWorkspace(): Promise<string> {
  const from = path.join(await tempDir('wlm-mig-launch-'), '.web_latex_mcp');
  await writeJson(registryPath(from), {
    thesis: { gitUrl: 'https://git.example/thesis', default: true },
    cv: { gitUrl: 'https://git.example/cv', rootFile: 'cv.tex' },
    // An entry this version cannot use is still the user's and moves verbatim.
    broken: { nonsense: true },
  });
  for (const id of ['thesis', 'cv']) {
    await mkdir(path.join(from, id, '.git'), { recursive: true });
    await writeFile(path.join(from, id, 'main.tex'), `\\documentclass{article} % ${id}\n`);
  }
  if (!WINDOWS) await symlink('main.tex', path.join(from, 'thesis', 'link.tex'));
  await writeFile(path.join(from, 'thesis.pdf'), '%PDF-1.4\n');
  await writeJson(path.join(from, '.sessions', 'thesis', 'rewrite-mode.json'), { mode: 'prose' });
  return from;
}

describe('migrateWorkspace', () => {
  it('moves the clones, PDFs and session state, merges the registry and retires the old one', async () => {
    const from = await legacyWorkspace();
    const to = path.join(await tempDir('wlm-mig-home-'), 'projects');

    const report = await migrateWorkspace({ from, to });

    expect(report.moved).toEqual(['cv', 'thesis', 'thesis.pdf', '.sessions/thesis']);
    expect(report.registered.sort()).toEqual(['broken', 'cv', 'thesis']);
    expect(await readJson(registryPath(to))).toEqual({
      thesis: { gitUrl: 'https://git.example/thesis', default: true },
      cv: { gitUrl: 'https://git.example/cv', rootFile: 'cv.tex' },
      broken: { nonsense: true },
    });
    expect(await readFile(path.join(to, 'cv', 'main.tex'), 'utf8')).toContain('% cv');
    if (!WINDOWS) expect(await readlink(path.join(to, 'thesis', 'link.tex'))).toBe('main.tex');
    expect(await exists(path.join(to, 'thesis.pdf'))).toBe(true);
    expect(await readJson(path.join(to, '.sessions', 'thesis', 'rewrite-mode.json'))).toEqual({
      mode: 'prose',
    });
    // The old folder keeps only the retired list and a note saying where everything went.
    expect(await exists(registryPath(from))).toBe(false);
    expect(await exists(path.join(from, 'registry.json.migrated'))).toBe(true);
    expect(await readFile(path.join(from, 'MIGRATED.md'), 'utf8')).toContain(
      to.split(path.sep).join('/'),
    );
    expect(await exists(path.join(from, 'thesis'))).toBe(false);

    // Running it again finds nothing to do and changes nothing.
    const before = [await snapshot(from), await snapshot(to)];
    const again = await migrateWorkspace({ from, to });
    expect(again.moved).toEqual([]);
    expect(again.registered).toEqual([]);
    expect([await snapshot(from), await snapshot(to)]).toEqual(before);
  });

  it('keeps the new workspace default and drops the old one', async () => {
    const from = await legacyWorkspace();
    const to = await tempDir('wlm-mig-to-');
    await writeJson(registryPath(to), {
      paper: { gitUrl: 'https://git.example/p', default: true },
    });

    const report = await migrateWorkspace({ from, to });

    expect(report.defaultDropped).toBe('thesis');
    const merged = await readJson(registryPath(to));
    expect(merged.paper).toEqual({ gitUrl: 'https://git.example/p', default: true });
    expect(merged.thesis).toEqual({ gitUrl: 'https://git.example/thesis' });
  });

  it('copies, verifies and removes the source across filesystems (EXDEV)', async () => {
    const from = await legacyWorkspace();
    const to = await tempDir('wlm-mig-to-');
    const exdev = async (): Promise<void> => {
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    };

    const report = await migrateWorkspace({ from, to, rename: exdev });

    expect(report.moved).toContain('thesis');
    if (!WINDOWS) expect(await readlink(path.join(to, 'thesis', 'link.tex'))).toBe('main.tex');
    expect(await readFile(path.join(to, 'thesis', 'main.tex'), 'utf8')).toContain('% thesis');
    expect(await exists(path.join(from, 'thesis'))).toBe(false);
  });

  it('completes a run that stopped part way', async () => {
    const from = await legacyWorkspace();
    const to = await tempDir('wlm-mig-to-');
    let calls = 0;
    const failSecond = async (src: string, dst: string): Promise<void> => {
      calls++;
      if (calls === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      const { rename } = await import('node:fs/promises');
      await rename(src, dst);
    };

    await expect(migrateWorkspace({ from, to, rename: failSecond })).rejects.toThrow(
      /Stopped after moving 1 of 4 entries.*Run the command again/s,
    );
    // The old registry is untouched until the end, so nothing is lost and the re-run finishes.
    expect(await exists(registryPath(from))).toBe(true);

    const report = await migrateWorkspace({ from, to });
    expect(report.moved).toEqual(['thesis', 'thesis.pdf', '.sessions/thesis']);
    expect(Object.keys(await readJson(registryPath(to))).sort()).toEqual([
      'broken',
      'cv',
      'thesis',
    ]);
  });

  it('counts an identical entry already in the new registry as migrated', async () => {
    const from = await legacyWorkspace();
    const to = await tempDir('wlm-mig-to-');
    await writeJson(registryPath(to), {
      cv: { gitUrl: 'https://git.example/cv', rootFile: 'cv.tex' },
    });

    const report = await migrateWorkspace({ from, to });
    expect(report.alreadyRegistered).toEqual(['cv']);
    expect(report.registered.sort()).toEqual(['broken', 'thesis']);
  });

  it('leaves OS litter behind and moves an arXiv export with its project', async () => {
    const from = await legacyWorkspace();
    const to = await tempDir('wlm-mig-to-');
    await writeFile(path.join(from, '.DS_Store'), 'x');
    await writeFile(path.join(from, 'thesis_arXiv.zip'), 'zip');

    const report = await migrateWorkspace({ from, to });

    expect(report.moved).toContain('thesis_arXiv.zip');
    expect(await exists(path.join(to, '.DS_Store'))).toBe(false);
    expect(await exists(path.join(from, '.DS_Store'))).toBe(true);
  });

  it('finishes a run interrupted after the merge that dropped the old default', async () => {
    const from = await legacyWorkspace();
    const to = await tempDir('wlm-mig-to-');
    await writeJson(registryPath(to), {
      paper: { gitUrl: 'https://git.example/p', default: true },
    });
    // What the interrupted run left: everything moved and merged (thesis without its default),
    // but the old registry not yet retired.
    const first = await migrateWorkspace({ from, to });
    expect(first.defaultDropped).toBe('thesis');
    await writeFile(registryPath(from), await readFile(path.join(from, 'registry.json.migrated')));
    await rm(path.join(from, 'registry.json.migrated'));

    const again = await migrateWorkspace({ from, to });

    expect(again.alreadyRegistered.sort()).toEqual(['broken', 'cv', 'thesis']);
    expect(await exists(registryPath(from))).toBe(false);
  });

  it('keeps the source and leaves no partial copy when the cross-filesystem copy fails', async () => {
    const from = await legacyWorkspace();
    const to = await tempDir('wlm-mig-to-');
    const exdev = async (): Promise<void> => {
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    };
    const failingCopy = async (src: string, dst: string): Promise<void> => {
      await cp(src, dst, { recursive: true, verbatimSymlinks: true });
      throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    };

    await expect(migrateWorkspace({ from, to, rename: exdev, copy: failingCopy })).rejects.toThrow(
      /copying .* failed .*the source left in place/s,
    );

    expect(await exists(path.join(from, 'cv', 'main.tex'))).toBe(true);
    expect((await readdir(to)).filter((n) => n !== '.sessions')).toEqual([]);
    // Nothing half-made stands in the way: the next run completes.
    const report = await migrateWorkspace({ from, to, rename: exdev });
    expect(report.moved).toEqual(['cv', 'thesis', 'thesis.pdf', '.sessions/thesis']);
  });

  it('refuses a copy whose content differs, though names and sizes match', async () => {
    const from = await legacyWorkspace();
    const to = await tempDir('wlm-mig-to-');
    const exdev = async (): Promise<void> => {
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    };
    const corruptCopy = async (src: string, dst: string): Promise<void> => {
      await cp(src, dst, { recursive: true, verbatimSymlinks: true });
      const file = path.join(dst, 'main.tex');
      const text = await readFile(file, 'utf8');
      await writeFile(file, text.replace('article', 'ARTICLE'));
    };

    await expect(migrateWorkspace({ from, to, rename: exdev, copy: corruptCopy })).rejects.toThrow(
      /did not match the source/,
    );
    expect(await readFile(path.join(from, 'cv', 'main.tex'), 'utf8')).toContain('article');
    expect((await readdir(to)).filter((n) => n !== '.sessions')).toEqual([]);
  });

  it('clears what a killed run left: a partial copy and a source set aside', async () => {
    const from = await legacyWorkspace();
    const to = await tempDir('wlm-mig-to-');
    // A copy of `cv` the killed run was still making, and an earlier `thesis.pdf` whose copy had
    // landed but whose set-aside source was not yet deleted.
    await mkdir(path.join(to, '.migrating-0badc0de-cv'), { recursive: true });
    await writeFile(path.join(to, 'thesis.pdf'), '%PDF-1.4\n');
    await rm(path.join(from, 'thesis.pdf'));
    await writeFile(path.join(from, '.migrated-0badc0de-thesis.pdf'), '%PDF-1.4\n');
    // An aside whose copy is NOT there is never deleted.
    await writeFile(path.join(from, '.migrated-0badc0de-orphan.pdf'), 'keep');

    await migrateWorkspace({ from, to });

    expect(await exists(path.join(to, '.migrating-0badc0de-cv'))).toBe(false);
    expect(await exists(path.join(from, '.migrated-0badc0de-thesis.pdf'))).toBe(false);
    expect(await exists(path.join(from, '.migrated-0badc0de-orphan.pdf'))).toBe(true);
  });

  describe('refuses, changing nothing', () => {
    async function expectRefusal(from: string, to: string, message: RegExp): Promise<void> {
      const before = [await snapshot(from), await snapshot(to)];
      const err = await migrateWorkspace({ from, to }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MigrationRefusedError);
      expect((err as Error).message).toMatch(/^Nothing was moved:/);
      expect((err as Error).message).toMatch(message);
      expect([await snapshot(from), await snapshot(to)]).toEqual(before);
    }

    it('when an id is registered in both, differently', async () => {
      const from = await legacyWorkspace();
      const to = await tempDir('wlm-mig-to-');
      await writeJson(registryPath(to), { cv: { gitUrl: 'https://git.example/other' } });
      await expectRefusal(from, to, /"cv" is registered in both workspaces, differently/);
    });

    it('when an id differs from one in the new workspace only in case', async () => {
      const from = await legacyWorkspace();
      const to = await tempDir('wlm-mig-to-');
      await writeJson(registryPath(to), { CV: { gitUrl: 'https://git.example/cv' } });
      await expectRefusal(from, to, /"cv" differs from "CV" .* only in letter case/);
    });

    it.skipIf(WINDOWS)(
      'when the new workspace is the old one through a linked parent',
      async () => {
        const from = await legacyWorkspace();
        const alias = path.join(await tempDir('wlm-mig-alias-'), 'link');
        await symlink(path.dirname(from), alias);
        await expectRefusal(from, path.join(alias, '.web_latex_mcp'), /the same folder/);
      },
    );

    // Only meaningful where the disk folds case (macOS, Windows); elsewhere it is another folder.
    it.skipIf(!CASE_INSENSITIVE)(
      'when the new workspace is the old one in another letter case',
      async () => {
        const from = await legacyWorkspace();
        await expectRefusal(
          from,
          path.join(path.dirname(from), '.WEB_LATEX_MCP'),
          /the same folder/,
        );
      },
    );

    it('when an interrupted run was moving into another folder', async () => {
      const from = await legacyWorkspace();
      const first = await tempDir('wlm-mig-first-');
      const second = await tempDir('wlm-mig-second-');
      let calls = 0;
      const failSecond = async (src: string, dst: string): Promise<void> => {
        if (++calls === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        const { rename } = await import('node:fs/promises');
        await rename(src, dst);
      };
      await expect(migrateWorkspace({ from, to: first, rename: failSecond })).rejects.toThrow(
        /Run the command again, with --to "/,
      );

      await expectRefusal(
        from,
        second,
        /stopped while moving into .*run the command again with --to/,
      );
    });

    it('when an unregistered directory in the new workspace has the id of a project to import', async () => {
      const from = await legacyWorkspace();
      await writeJson(registryPath(from), { fresh: { gitUrl: 'https://git.example/fresh' } });
      const to = await tempDir('wlm-mig-to-');
      await mkdir(path.join(to, 'fresh', '.git'), { recursive: true });
      await expectRefusal(from, to, /"fresh" cannot take that name/);
    });

    it('when the new workspace already has a directory of that name', async () => {
      const from = await legacyWorkspace();
      const to = await tempDir('wlm-mig-to-');
      await mkdir(path.join(to, 'thesis'));
      await expectRefusal(from, to, /thesis" already exists in the new workspace/);
    });

    it('when two local projects would claim one directory', async () => {
      const from = await legacyWorkspace();
      const to = await tempDir('wlm-mig-to-');
      const draft = await tempDir('wlm-mig-draft-');
      await writeJson(registryPath(from), {
        notes: { mode: 'local', path: draft },
      });
      await writeJson(registryPath(to), { mine: { mode: 'local', path: draft } });
      await expectRefusal(from, to, /"notes" uses .* which "mine" in the new workspace/);
    });

    it('while a session on either workspace is live', async () => {
      const from = await legacyWorkspace();
      const to = await tempDir('wlm-mig-to-');
      await new SessionRegistry(from, 'agent-a').touch('cv');
      await expectRefusal(from, to, /"cv" has live sessions \("agent-a"\)/);
    });

    it('while a project lock is held', async () => {
      const from = await legacyWorkspace();
      const to = await tempDir('wlm-mig-to-');
      await writeJson(projectLockPath(to, 'paper'), { pid: process.pid });
      await expectRefusal(from, to, /"paper" is locked by .*project\.lock/);
    });

    it('when the folder holds something that is not a clone or a PDF', async () => {
      const from = await legacyWorkspace();
      const to = await tempDir('wlm-mig-to-');
      await writeFile(path.join(from, 'notes.txt'), 'mine');
      await expectRefusal(
        from,
        to,
        /notes\.txt" is neither a clone, a compiled PDF nor an arXiv export/,
      );
    });

    it('when the registry cannot be read', async () => {
      const from = await legacyWorkspace();
      const to = await tempDir('wlm-mig-to-');
      await writeFile(registryPath(to), '{ not json');
      await expectRefusal(from, to, /registry\.json" cannot be read/);
    });

    it('when the folder is not a workspace at all', async () => {
      const documents = await tempDir('wlm-mig-docs-');
      await writeFile(path.join(documents, 'letter.tex'), 'x');
      const to = await tempDir('wlm-mig-to-');
      await expectRefusal(documents, to, /is not a web-latex-mcp workspace/);
    });

    it('when one folder holds the other', async () => {
      const from = await legacyWorkspace();
      await expectRefusal(from, path.join(from, 'nested'), /one holds the other/);
      await expectRefusal(from, from, /the same folder/);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { gitUrlOf } from '../../src/lib/projectMode.js';
import {
  ProjectRegistry,
  readProjectRegistry,
  readProjectRegistryDefault,
  registryPath,
} from '../../src/services/projectRegistry.js';

describe('ProjectRegistry', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'ovl-reg-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('reads [] when no registry file exists', () => {
    expect(readProjectRegistry(workspaceRoot)).toEqual([]);
  });

  it('persists a project and reads it back', async () => {
    const reg = new ProjectRegistry(workspaceRoot);
    await reg.upsert({
      id: 'thesis',
      gitUrl: 'https://git.overleaf.com/abc',
      rootFile: 'main.tex',
    });

    expect(reg.read()).toEqual([
      { id: 'thesis', gitUrl: 'https://git.overleaf.com/abc', rootFile: 'main.tex' },
    ]);
    // The file keys by id and omits undefined fields.
    const raw = JSON.parse(await readFile(registryPath(workspaceRoot), 'utf8'));
    expect(raw).toEqual({
      thesis: { gitUrl: 'https://git.overleaf.com/abc', rootFile: 'main.tex' },
    });
  });

  it('updates an existing entry and keeps the others', async () => {
    const reg = new ProjectRegistry(workspaceRoot);
    await reg.upsert({ id: 'thesis', gitUrl: 'https://git.overleaf.com/abc' });
    await reg.upsert({ id: 'paper', gitUrl: 'https://github.com/me/paper' });
    await reg.upsert({ id: 'thesis', gitUrl: 'https://git.overleaf.com/NEW' });

    const byId = Object.fromEntries(reg.read().map((p) => [p.id, gitUrlOf(p)]));
    expect(byId).toEqual({
      thesis: 'https://git.overleaf.com/NEW',
      paper: 'https://github.com/me/paper',
    });
  });

  it('tolerates an invalid registry file (returns [] rather than throwing)', async () => {
    await writeFile(registryPath(workspaceRoot), '{ not json', 'utf8');
    expect(readProjectRegistry(workspaceRoot)).toEqual([]);
  });

  it('round-trips a local project, keeping the path and dropping git-only fields', async () => {
    const reg = new ProjectRegistry(workspaceRoot);
    await reg.upsert({ id: 'cv', mode: 'local', path: '/home/me/docs/cv', rootFile: 'cv.tex' });

    expect(reg.read()).toEqual([
      { id: 'cv', mode: 'local', path: '/home/me/docs/cv', rootFile: 'cv.tex' },
    ]);
    const raw = JSON.parse(await readFile(registryPath(workspaceRoot), 'utf8'));
    expect(raw).toEqual({ cv: { mode: 'local', path: '/home/me/docs/cv', rootFile: 'cv.tex' } });
  });

  it('persists followSymlinks, so the opt-in survives a restart', async () => {
    const reg = new ProjectRegistry(workspaceRoot);
    await reg.upsert({ id: 'cv', mode: 'local', path: '/home/me/docs/cv', followSymlinks: true });

    expect(reg.read()).toEqual([
      {
        id: 'cv',
        mode: 'local',
        path: '/home/me/docs/cv',
        rootFile: undefined,
        followSymlinks: true,
      },
    ]);
    const raw = JSON.parse(await readFile(registryPath(workspaceRoot), 'utf8'));
    expect(raw.cv.followSymlinks).toBe(true);
  });

  it('reads a registry holding both kinds of project', async () => {
    await writeFile(
      registryPath(workspaceRoot),
      JSON.stringify({
        thesis: { gitUrl: 'https://git.overleaf.com/abc' },
        cv: { mode: 'local', path: '/home/me/docs/cv' },
      }),
    );

    const projects = readProjectRegistry(workspaceRoot);
    expect(projects).toHaveLength(2);
    expect(gitUrlOf(projects[0]!)).toBe('https://git.overleaf.com/abc');
    expect(projects[1]).toEqual({ id: 'cv', mode: 'local', path: '/home/me/docs/cv' });
  });

  it('ignores a local entry with no path, rather than half-registering it', async () => {
    await writeFile(
      registryPath(workspaceRoot),
      JSON.stringify({ cv: { mode: 'local' }, thesis: { gitUrl: 'https://git.example/x' } }),
    );
    // Only the bad entry is skipped: validation is per entry, so one hand-edit mistake no longer
    // hides every other registration (see test/unit/projectRegistrationSafety.test.ts).
    expect(readProjectRegistry(workspaceRoot)).toEqual([
      { id: 'thesis', gitUrl: 'https://git.example/x' },
    ]);
  });

  describe('default project', () => {
    it('readProjectRegistryDefault is undefined when no registry file exists', () => {
      expect(readProjectRegistryDefault(workspaceRoot)).toBeUndefined();
    });

    it('upsert with makeDefault persists the flag and readDefault reports it', async () => {
      const reg = new ProjectRegistry(workspaceRoot);
      await reg.upsert(
        { id: 'thesis', gitUrl: 'https://git.overleaf.com/abc' },
        { makeDefault: true },
      );

      expect(reg.readDefault()).toBe('thesis');
      expect(readProjectRegistryDefault(workspaceRoot)).toBe('thesis');
      const raw = JSON.parse(await readFile(registryPath(workspaceRoot), 'utf8'));
      expect(raw.thesis.default).toBe(true);
    });

    it('read() entries never carry a default key', async () => {
      const reg = new ProjectRegistry(workspaceRoot);
      await reg.upsert(
        { id: 'thesis', gitUrl: 'https://git.overleaf.com/abc' },
        { makeDefault: true },
      );

      expect(reg.read()).toEqual([{ id: 'thesis', gitUrl: 'https://git.overleaf.com/abc' }]);
    });

    it('a second makeDefault displaces the first — only one entry stays default: true', async () => {
      const reg = new ProjectRegistry(workspaceRoot);
      await reg.upsert(
        { id: 'thesis', gitUrl: 'https://git.overleaf.com/abc' },
        { makeDefault: true },
      );
      await reg.upsert(
        { id: 'paper', gitUrl: 'https://git.overleaf.com/def' },
        { makeDefault: true },
      );

      expect(reg.readDefault()).toBe('paper');
      const raw = JSON.parse(await readFile(registryPath(workspaceRoot), 'utf8'));
      expect(raw.thesis.default).toBeUndefined();
      expect(raw.paper.default).toBe(true);
    });

    it('re-upserting the default project without opts keeps the flag', async () => {
      const reg = new ProjectRegistry(workspaceRoot);
      await reg.upsert(
        { id: 'thesis', gitUrl: 'https://git.overleaf.com/abc' },
        { makeDefault: true },
      );
      // A plain re-register (e.g. updating rootFile) must not silently drop the default.
      await reg.upsert({ id: 'thesis', gitUrl: 'https://git.overleaf.com/NEW' });

      expect(reg.readDefault()).toBe('thesis');
      const raw = JSON.parse(await readFile(registryPath(workspaceRoot), 'utf8'));
      expect(raw.thesis.gitUrl).toBe('https://git.overleaf.com/NEW');
      expect(raw.thesis.default).toBe(true);
    });
  });
});

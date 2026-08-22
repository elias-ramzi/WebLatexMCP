import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { gitUrlOf } from '../../src/lib/projectMode.js';
import {
  ProjectRegistry,
  readProjectRegistry,
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
    // The whole file is rejected as invalid — the same fail-safe as any other malformed registry.
    expect(readProjectRegistry(workspaceRoot)).toEqual([]);
  });
});

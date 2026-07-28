import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
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

    const byId = Object.fromEntries(reg.read().map((p) => [p.id, p.gitUrl]));
    expect(byId).toEqual({
      thesis: 'https://git.overleaf.com/NEW',
      paper: 'https://github.com/me/paper',
    });
  });

  it('tolerates an invalid registry file (returns [] rather than throwing)', async () => {
    await writeFile(registryPath(workspaceRoot), '{ not json', 'utf8');
    expect(readProjectRegistry(workspaceRoot)).toEqual([]);
  });
});

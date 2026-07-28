import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { ProjectManager } from '../../src/services/projectManager.js';
import type { ProjectConfig, ServerConfig } from '../../src/types.js';

describe('ProjectManager', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'ovl-pm-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  function makeConfig(): ServerConfig {
    return {
      workspaceRoot,
      sessionId: 'test',
      projects: [
        { id: 'thesis', gitUrl: 'https://git.overleaf.com/abc' },
        { id: 'paper', gitUrl: 'https://git.overleaf.com/def' },
      ],
      defaultProject: 'thesis',
    };
  }

  it('resolves the default project when id is omitted', () => {
    const pm = new ProjectManager(makeConfig());
    expect(pm.getProjectConfig().id).toBe('thesis');
  });

  it('resolves an explicit project id', () => {
    const pm = new ProjectManager(makeConfig());
    expect(pm.getProjectConfig('paper').id).toBe('paper');
  });

  it('throws for an unknown project', () => {
    const pm = new ProjectManager(makeConfig());
    expect(() => pm.getProjectConfig('ghost')).toThrow(/Unknown project/);
  });

  it('throws when no id and no default are available', () => {
    const pm = new ProjectManager({ workspaceRoot, sessionId: 'test', projects: [] });
    expect(() => pm.getProjectConfig()).toThrow(/No project specified/);
  });

  it('reports clone status based on the presence of a .git directory', async () => {
    const pm = new ProjectManager(makeConfig());
    await mkdir(path.join(workspaceRoot, 'thesis', '.git'), { recursive: true });

    const list = await pm.listProjects();
    expect(list.find((p) => p.project === 'thesis')?.cloned).toBe(true);
    expect(list.find((p) => p.project === 'paper')?.cloned).toBe(false);
  });

  it('registers a project dynamically', () => {
    const pm = new ProjectManager({ workspaceRoot, sessionId: 'test', projects: [] });
    expect(() => pm.getProjectConfig('new')).toThrow(/Unknown project/);
    pm.registerProject('new', 'https://git.overleaf.com/zzz');
    expect(pm.getProjectConfig('new').gitUrl).toBe('https://git.overleaf.com/zzz');
  });

  it('persists a registration through the registry store', async () => {
    const store = {
      entries: [] as ProjectConfig[],
      read() {
        return this.entries;
      },
      async upsert(cfg: ProjectConfig) {
        this.entries = [...this.entries.filter((e) => e.id !== cfg.id), cfg];
      },
    };
    const pm = new ProjectManager({ workspaceRoot, sessionId: 'test', projects: [] }, store);
    await pm.registerAndPersist('new', 'https://git.overleaf.com/zzz', { rootFile: 'main.tex' });
    expect(store.entries).toEqual([
      { id: 'new', gitUrl: 'https://git.overleaf.com/zzz', rootFile: 'main.tex' },
    ]);
  });

  it('picks up a peer registration from the registry on an unknown-id miss', () => {
    const store = {
      entries: [] as ProjectConfig[],
      read() {
        return this.entries;
      },
      async upsert() {},
    };
    const pm = new ProjectManager({ workspaceRoot, sessionId: 'test', projects: [] }, store);
    expect(() => pm.getProjectConfig('peer')).toThrow(/Unknown project/);
    // A peer session persists it after startup...
    store.entries = [{ id: 'peer', gitUrl: 'https://git.overleaf.com/peer' }];
    // ...and this session resolves it without a restart.
    expect(pm.getProjectConfig('peer').gitUrl).toBe('https://git.overleaf.com/peer');
  });
});

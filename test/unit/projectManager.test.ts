import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { ProjectManager } from '../../src/services/projectManager.js';
import { gitUrlOf } from '../../src/lib/projectMode.js';
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
    pm.registerProject({ id: 'new', gitUrl: 'https://git.overleaf.com/zzz' });
    expect(gitUrlOf(pm.getProjectConfig('new'))).toBe('https://git.overleaf.com/zzz');
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
    await pm.registerAndPersist({
      id: 'new',
      gitUrl: 'https://git.overleaf.com/zzz',
      rootFile: 'main.tex',
    });
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
    expect(gitUrlOf(pm.getProjectConfig('peer'))).toBe('https://git.overleaf.com/peer');
  });

  describe('local projects', () => {
    let localDir: string;

    beforeEach(async () => {
      localDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-local-'));
    });

    afterEach(async () => {
      await rm(localDir, { recursive: true, force: true });
    });

    function localConfig(dir = localDir): ServerConfig {
      return {
        workspaceRoot,
        sessionId: 'test',
        projects: [{ id: 'cv', mode: 'local', path: dir }],
      };
    }

    it('resolves to the directory itself, never a clone under the workspace', () => {
      const pm = new ProjectManager(localConfig());
      expect(pm.projectPath('cv')).toBe(path.resolve(localDir));
      expect(pm.projectPath('cv').startsWith(workspaceRoot)).toBe(false);
      expect(pm.isLocal('cv')).toBe(true);
    });

    it('is ready as soon as the directory exists — no .git required', async () => {
      const pm = new ProjectManager(localConfig());
      await expect(pm.requireProjectDir('cv')).resolves.toEqual({
        id: 'cv',
        dir: path.resolve(localDir),
      });
      expect(await pm.hasClone('cv')).toBe(true);
    });

    it('says the directory is missing rather than telling you to sync', async () => {
      const pm = new ProjectManager(localConfig(path.join(localDir, 'gone')));
      await expect(pm.requireProjectDir('cv')).rejects.toThrow(/directory does not exist/);
      await expect(pm.requireProjectDir('cv')).rejects.not.toThrow(/project_sync/);
    });

    it('refuses git operations, naming the action and the path', () => {
      const pm = new ProjectManager(localConfig());
      expect(() => pm.requireGitProject('cv', 'push to')).toThrow(/no remote to push to/);
      expect(() => pm.requireGitProject('cv', 'push to')).toThrow(localDir);
    });

    it('still resolves git projects through the same guard', () => {
      const pm = new ProjectManager({
        ...localConfig(),
        projects: [...localConfig().projects, { id: 'thesis', gitUrl: 'https://git.example/x' }],
      });
      expect(pm.requireGitProject('thesis', 'push to').gitUrl).toBe('https://git.example/x');
      expect(pm.isLocal('thesis')).toBe(false);
    });

    it('reports the mode, and omits a remote it does not have', async () => {
      const pm = new ProjectManager({
        ...localConfig(),
        projects: [...localConfig().projects, { id: 'thesis', gitUrl: 'https://git.example/x' }],
      });
      const listed = await pm.listProjects();
      expect(listed.find((p) => p.project === 'cv')).toEqual({
        project: 'cv',
        path: path.resolve(localDir),
        mode: 'local',
        gitUrl: undefined,
        cloned: true,
      });
      expect(listed.find((p) => p.project === 'thesis')).toMatchObject({
        mode: 'git',
        gitUrl: 'https://git.example/x',
        cloned: false, // not cloned — no .git under the workspace
      });
    });

    it('attributes a directory back to its local project', () => {
      const pm = new ProjectManager(localConfig());
      expect(pm.idForDir(localDir)).toBe('cv');
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { ProjectManager } from '../../src/services/projectManager.js';
import type { ProjectRegistryStore } from '../../src/services/projectManager.js';
import { gitUrlOf } from '../../src/lib/projectMode.js';
import type { ProjectConfig, ServerConfig } from '../../src/types.js';

/**
 * A fake `ProjectRegistryStore` that mimics the real one's default-tracking: `upsert` with
 * `makeDefault: true` sets `defaultId` (and only one project may hold it), and records the opts
 * it was last called with so a test can check what `registerAndPersist` passed through.
 */
function makeFakeRegistry(): ProjectRegistryStore & {
  entries: ProjectConfig[];
  defaultId?: string;
  lastUpsertOpts?: { makeDefault?: boolean };
} {
  return {
    entries: [],
    defaultId: undefined,
    lastUpsertOpts: undefined,
    read() {
      return this.entries;
    },
    readDefault() {
      return this.defaultId;
    },
    async upsert(cfg: ProjectConfig, opts?: { makeDefault?: boolean }) {
      this.entries = [...this.entries.filter((e) => e.id !== cfg.id), cfg];
      this.lastUpsertOpts = opts;
      if (opts?.makeDefault) this.defaultId = cfg.id;
    },
  };
}

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

  it('throws when no id and no default are available, and points at register_project', () => {
    const pm = new ProjectManager({ workspaceRoot, sessionId: 'test', projects: [] });
    expect(() => pm.getProjectConfig()).toThrow(/No project specified/);
    expect(() => pm.getProjectConfig()).toThrow(/register_project/);
  });

  it('names the known projects and mentions register_project when no default is configured', () => {
    const pm = new ProjectManager(makeConfig() /* has defaultProject */);
    // Same projects, but no configured default this time.
    const noDefault = new ProjectManager({
      workspaceRoot,
      sessionId: 'test',
      projects: [
        { id: 'thesis', gitUrl: 'https://git.overleaf.com/abc' },
        { id: 'paper', gitUrl: 'https://git.overleaf.com/def' },
      ],
    });
    expect(pm.getProjectConfig().id).toBe('thesis'); // sanity: the fixture itself still resolves
    expect(() => noDefault.getProjectConfig()).toThrow(/Known projects: thesis, paper/);
    expect(() => noDefault.getProjectConfig()).toThrow(/WEB_LATEX_MCP_DEFAULT_PROJECT/);
    expect(() => noDefault.getProjectConfig()).toThrow(/register_project/);
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
    const store = makeFakeRegistry();
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
    const store = makeFakeRegistry();
    const pm = new ProjectManager({ workspaceRoot, sessionId: 'test', projects: [] }, store);
    expect(() => pm.getProjectConfig('peer')).toThrow(/Unknown project/);
    // A peer session persists it after startup...
    store.entries = [{ id: 'peer', gitUrl: 'https://git.overleaf.com/peer' }];
    // ...and this session resolves it without a restart.
    expect(gitUrlOf(pm.getProjectConfig('peer'))).toBe('https://git.overleaf.com/peer');
  });

  it('registerAndPersist with makeDefault sets the in-process default and tells the registry', async () => {
    const store = makeFakeRegistry();
    const pm = new ProjectManager({ workspaceRoot, sessionId: 'test', projects: [] }, store);
    await pm.registerAndPersist(
      { id: 'new', gitUrl: 'https://git.overleaf.com/zzz' },
      { makeDefault: true },
    );
    expect(pm.getProjectConfig().id).toBe('new');
    expect(store.lastUpsertOpts).toEqual({ makeDefault: true });
    expect(pm.defaultProjectId()).toBe('new');
  });

  it('does not let makeDefault override an explicit WEB_LATEX_MCP_DEFAULT_PROJECT', async () => {
    const store = makeFakeRegistry();
    const pm = new ProjectManager(
      {
        workspaceRoot,
        sessionId: 'test',
        projects: [{ id: 'thesis', gitUrl: 'https://git.overleaf.com/abc' }],
        defaultProject: 'thesis',
        defaultProjectExplicit: true,
      },
      store,
    );
    await pm.registerAndPersist(
      { id: 'new', gitUrl: 'https://git.overleaf.com/zzz' },
      { makeDefault: true },
    );
    // The registry still records the request — only the in-process default is protected.
    expect(store.lastUpsertOpts).toEqual({ makeDefault: true });
    expect(pm.getProjectConfig().id).toBe('thesis');
  });

  it('runExclusive forwards a LockAcquisition to fn, waitedMs ~0 and no waitedOn when uncontended', async () => {
    const pm = new ProjectManager(makeConfig());
    const lock = await pm.runExclusive('thesis', async (l) => l);
    // The claim under test is "did not wait for a holder", not a timing budget — a loaded CI
    // runner can pay far more than a couple of milliseconds for the real filesystem write, and
    // that is not a regression. `waitedOn` is what actually proves no wait happened.
    expect(lock.waitedMs).toBeGreaterThanOrEqual(0);
    expect(lock.waitedMs).toBeLessThan(1000);
    expect(lock.waitedOn).toBeUndefined();
  });

  it('falls back to the registry’s persisted default when the config has none', () => {
    const store = makeFakeRegistry();
    store.entries = [{ id: 'paper', gitUrl: 'https://git.overleaf.com/def' }];
    store.defaultId = 'paper';
    const pm = new ProjectManager({ workspaceRoot, sessionId: 'test', projects: [] }, store);
    expect(pm.getProjectConfig().id).toBe('paper');
    expect(pm.defaultProjectId()).toBe('paper');
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

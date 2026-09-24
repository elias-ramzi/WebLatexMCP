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
    expect(() => noDefault.getProjectConfig()).toThrow(/Known projects: "thesis", "paper"/);
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

  it('runExclusive reports the in-process mutex wait, and names this session as the holder', async () => {
    // Two overlapping calls in ONE process contend on the in-process mutex, not the file lock —
    // withFileLock alone never sees this wait, so before the fix the second call's LockAcquisition
    // (produced inside withFileLock, whose own clock starts only once the mutex admits it) read
    // waitedMs: 0 despite genuinely waiting out the whole first call.
    const pm = new ProjectManager(makeConfig());
    const first = pm.runExclusive('thesis', async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return 'first';
    });
    // Give the first call a moment's head start so the second one is guaranteed to contend on the
    // mutex rather than possibly racing it for the lock.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = pm.runExclusive('thesis', async (l) => l);

    const [firstResult, secondLock] = await Promise.all([first, second]);
    expect(firstResult).toBe('first');
    expect(secondLock.waitedMs).toBeGreaterThanOrEqual(100);
    expect(secondLock.waitedOn).toBe('test'); // this process's own sessionId (see makeConfig)
  });

  describe('setDefaultProject', () => {
    it('loads a project this process has never seen, so projectPath answers for it afterwards', async () => {
      // A peer registered a LOCAL project; this process holds nothing for that id. The registry
      // read must fill the in-process gap (as reloadFromRegistry does for a missing id), or the
      // tool reporting on the result computes the clone path for a project that is local.
      const store = makeFakeRegistry();
      const localDir = path.join(workspaceRoot, 'elsewhere');
      store.entries = [{ id: 'draft', mode: 'local', path: localDir }];
      const pm = new ProjectManager({ workspaceRoot, sessionId: 'test', projects: [] }, store);

      const cfg = await pm.setDefaultProject('draft');

      expect(cfg).toEqual({ id: 'draft', mode: 'local', path: localDir });
      expect(pm.projectPath('draft')).toBe(localDir);
      expect(pm.defaultProjectId()).toBe('draft');
    });

    it('persists makeDefault with the FULL existing config, and sets the in-process default', async () => {
      const store = makeFakeRegistry();
      const pm = new ProjectManager(
        {
          workspaceRoot,
          sessionId: 'test',
          projects: [
            {
              id: 'paper',
              gitUrl: 'https://git.overleaf.com/def',
              rootFile: 'paper/main.tex',
              branch: 'main',
              tokenEnv: 'MY_TOKEN',
            },
          ],
        },
        store,
      );

      const cfg = await pm.setDefaultProject('paper');

      expect(cfg).toEqual({
        id: 'paper',
        gitUrl: 'https://git.overleaf.com/def',
        rootFile: 'paper/main.tex',
        branch: 'main',
        tokenEnv: 'MY_TOKEN',
      });
      expect(store.lastUpsertOpts).toEqual({ makeDefault: true });
      // The config actually handed to the registry store still carries every field — this is the
      // regression the fix targets: a naive re-registration rebuilt from tool args alone would
      // have persisted only {id, gitUrl, default: true} and silently dropped the rest.
      expect(store.entries).toEqual([
        {
          id: 'paper',
          gitUrl: 'https://git.overleaf.com/def',
          rootFile: 'paper/main.tex',
          branch: 'main',
          tokenEnv: 'MY_TOKEN',
        },
      ]);
      expect(pm.defaultProjectId()).toBe('paper');
    });

    it('persists makeDefault but does not change the in-process default when explicit', async () => {
      const store = makeFakeRegistry();
      const pm = new ProjectManager(
        {
          workspaceRoot,
          sessionId: 'test',
          projects: [
            { id: 'thesis', gitUrl: 'https://git.overleaf.com/abc' },
            { id: 'paper', gitUrl: 'https://git.overleaf.com/def' },
          ],
          defaultProject: 'thesis',
          defaultProjectExplicit: true,
        },
        store,
      );

      await pm.setDefaultProject('paper');

      expect(store.lastUpsertOpts).toEqual({ makeDefault: true });
      expect(store.entries).toEqual([{ id: 'paper', gitUrl: 'https://git.overleaf.com/def' }]);
      // The registry write happened, but WEB_LATEX_MCP_DEFAULT_PROJECT still wins in this process.
      expect(pm.getProjectConfig().id).toBe('thesis');
    });

    it('throws on an unknown project, naming the known ids', async () => {
      const pm = new ProjectManager(makeConfig());
      await expect(pm.setDefaultProject('ghost')).rejects.toThrow(/Unknown project/);
      await expect(pm.setDefaultProject('ghost')).rejects.toThrow(/"thesis", "paper"/);
    });

    it('persists the registry’s current entry, not a stale in-process snapshot', async () => {
      // Session A holds an in-process `paper` from before session B re-registered it with a new
      // rootFile/branch. A naive setDefaultProject that persists getProjectConfig(id) (the
      // in-process snapshot) would write A's stale entry over B's and lose the update — the exact
      // wipe this fix closes. reloadFromRegistry only fills in MISSING ids, so this can't be
      // relied on to refresh an id already held.
      const store = makeFakeRegistry();
      store.entries = [
        {
          id: 'paper',
          gitUrl: 'https://git.overleaf.com/def',
          rootFile: 'new.tex',
          branch: 'main',
        },
      ];
      const pm = new ProjectManager(
        {
          workspaceRoot,
          sessionId: 'test',
          projects: [{ id: 'paper', gitUrl: 'https://git.overleaf.com/def', rootFile: 'old.tex' }],
        },
        store,
      );

      const cfg = await pm.setDefaultProject('paper');

      expect(cfg).toEqual({
        id: 'paper',
        gitUrl: 'https://git.overleaf.com/def',
        rootFile: 'new.tex',
        branch: 'main',
      });
      // The config actually handed to the registry's upsert (captured via entries) must be the
      // fresh registry entry, not the stale in-process one.
      expect(store.entries).toEqual([
        {
          id: 'paper',
          gitUrl: 'https://git.overleaf.com/def',
          rootFile: 'new.tex',
          branch: 'main',
        },
      ]);
    });

    it('falls back to the in-process config when the registry has no entry for the id', async () => {
      // An env-configured project with no runtime registration: the registry has nothing to name
      // it, so the in-process config (the only source of truth here) is what gets persisted.
      const store = makeFakeRegistry();
      const pm = new ProjectManager(
        {
          workspaceRoot,
          sessionId: 'test',
          projects: [
            { id: 'thesis', gitUrl: 'https://git.overleaf.com/abc', rootFile: 'thesis.tex' },
          ],
        },
        store,
      );

      const cfg = await pm.setDefaultProject('thesis');

      expect(cfg).toEqual({
        id: 'thesis',
        gitUrl: 'https://git.overleaf.com/abc',
        rootFile: 'thesis.tex',
      });
      expect(store.entries).toEqual([
        { id: 'thesis', gitUrl: 'https://git.overleaf.com/abc', rootFile: 'thesis.tex' },
      ]);
    });
  });

  describe('previousRegistration', () => {
    it('falls back to the in-process config when the id has no registry entry', () => {
      // The case PR #64 missed: a project configured through WEB_LATEX_MCP_PROJECTS (or
      // registered in-session via project_sync { gitUrl }) is held only in `this.projects` and
      // was never written to the registry — `registryEntry`-style "registry only" lookup finds
      // nothing here, which is exactly the silent-loss gap this method exists to close.
      const store = makeFakeRegistry();
      const pm = new ProjectManager(
        {
          workspaceRoot,
          sessionId: 'test',
          projects: [
            {
              id: 'thesis',
              gitUrl: 'https://git.overleaf.com/abc',
              rootFile: 'thesis.tex',
              branch: 'main',
            },
          ],
        },
        store,
      );

      expect(pm.previousRegistration('thesis')).toEqual({
        id: 'thesis',
        gitUrl: 'https://git.overleaf.com/abc',
        rootFile: 'thesis.tex',
        branch: 'main',
      });
    });

    it('prefers the registry’s own entry over a stale in-process config', () => {
      // Same reasoning as setDefaultProject's "not a stale in-process snapshot" case: a peer
      // session may have re-registered the id since this process last loaded it.
      const store = makeFakeRegistry();
      store.entries = [
        { id: 'paper', gitUrl: 'https://git.overleaf.com/def', rootFile: 'new.tex' },
      ];
      const pm = new ProjectManager(
        {
          workspaceRoot,
          sessionId: 'test',
          projects: [{ id: 'paper', gitUrl: 'https://git.overleaf.com/def', rootFile: 'old.tex' }],
        },
        store,
      );

      expect(pm.previousRegistration('paper')).toEqual({
        id: 'paper',
        gitUrl: 'https://git.overleaf.com/def',
        rootFile: 'new.tex',
      });
    });

    it('returns undefined when neither the registry nor the in-process config knows the id', () => {
      const pm = new ProjectManager(makeConfig(), makeFakeRegistry());
      expect(pm.previousRegistration('ghost')).toBeUndefined();
    });
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

  describe('defaultProjectId precedence between the registry and the in-process value', () => {
    // Regression for the gap documented in docs/CONCURRENCY.md: a peer session's
    // `register_project { default: true }` must reach every env-unset session consistently,
    // not only one that started with NO default. Before the fix, `defaultProjectId()` was
    // `this.defaultProject ?? this.registry?.readDefault()` — so a process that started with
    // `defaultProject: 'a'` (taken from the registry's default AT STARTUP, not asserted via
    // WEB_LATEX_MCP_DEFAULT_PROJECT) never saw a later peer update, because the truthy
    // in-process snapshot shadowed the `??` fallback to `readDefault()` forever.
    it('a live, non-explicit registry default wins over the in-process value taken at startup', () => {
      const store = makeFakeRegistry();
      store.defaultId = 'b';
      const pm = new ProjectManager(
        {
          workspaceRoot,
          sessionId: 'test',
          projects: [
            { id: 'a', gitUrl: 'https://git.overleaf.com/a' },
            { id: 'b', gitUrl: 'https://git.overleaf.com/b' },
          ],
          defaultProject: 'a',
          defaultProjectExplicit: false,
        },
        store,
      );
      expect(pm.defaultProjectId()).toBe('b');
    });

    it('an explicit WEB_LATEX_MCP_DEFAULT_PROJECT always wins over the registry default', () => {
      const store = makeFakeRegistry();
      store.defaultId = 'b';
      const pm = new ProjectManager(
        {
          workspaceRoot,
          sessionId: 'test',
          projects: [
            { id: 'a', gitUrl: 'https://git.overleaf.com/a' },
            { id: 'b', gitUrl: 'https://git.overleaf.com/b' },
          ],
          defaultProject: 'a',
          defaultProjectExplicit: true,
        },
        store,
      );
      expect(pm.defaultProjectId()).toBe('a');
    });

    it('falls back to the in-process value when no registry is wired', () => {
      const pm = new ProjectManager({
        workspaceRoot,
        sessionId: 'test',
        projects: [{ id: 'a', gitUrl: 'https://git.overleaf.com/a' }],
        defaultProject: 'a',
      });
      expect(pm.defaultProjectId()).toBe('a');
    });

    it('falls back to the in-process value when the registry is wired but names no default', () => {
      const store = makeFakeRegistry();
      store.defaultId = undefined;
      const pm = new ProjectManager(
        {
          workspaceRoot,
          sessionId: 'test',
          projects: [{ id: 'a', gitUrl: 'https://git.overleaf.com/a' }],
          defaultProject: 'a',
        },
        store,
      );
      expect(pm.defaultProjectId()).toBe('a');
    });

    it('picks up a registerAndPersist({ makeDefault: true }) default through the registry', async () => {
      const store = makeFakeRegistry();
      const pm = new ProjectManager({ workspaceRoot, sessionId: 'test', projects: [] }, store);
      await pm.registerAndPersist(
        { id: 'fresh', gitUrl: 'https://git.overleaf.com/fresh' },
        { makeDefault: true },
      );
      expect(pm.defaultProjectId()).toBe('fresh');
    });
  });
});

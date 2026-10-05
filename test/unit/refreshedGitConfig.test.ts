import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { ProjectManager } from '../../src/services/projectManager.js';
import type { ProjectRegistryStore } from '../../src/services/projectManager.js';
import type { ProjectConfig } from '../../src/types.js';

/**
 * `ProjectManager.refreshedGitConfig`: a remote operation adopts the registry's CURRENT git entry
 * for an id — what a freshly started process would hold — so a peer process holding a stale
 * snapshot no longer re-points the shared clone's `origin` back to the old remote. Env-configured
 * ids and ids this process re-pointed session-only keep what they hold, and every failure to read
 * a usable entry falls back to the snapshot.
 */

function fakeRegistry(entries: ProjectConfig[] = []): ProjectRegistryStore & {
  entries: ProjectConfig[];
} {
  return {
    entries,
    read() {
      return this.entries;
    },
    readDefault() {
      return undefined;
    },
    async upsert(cfg: ProjectConfig) {
      this.entries = [...this.entries.filter((e) => e.id !== cfg.id), cfg];
    },
  };
}

const OLD: ProjectConfig = {
  id: 'paper',
  gitUrl: 'https://git.example/old.git',
  branch: 'master',
  rootFile: 'old.tex',
  tokenEnv: 'OLD_TOKEN',
  username: 'old-user',
};
const NEW: ProjectConfig = {
  id: 'paper',
  gitUrl: 'https://git.example/new.git',
  branch: 'main',
  rootFile: 'new.tex',
  tokenEnv: 'NEW_TOKEN',
  username: 'new-user',
};

describe('ProjectManager.refreshedGitConfig', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'wlm-refreshed-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  function manager(
    store: ProjectRegistryStore | undefined,
    projects: ProjectConfig[] = [OLD],
    envProjectIds?: string[],
  ): ProjectManager {
    return new ProjectManager(
      {
        workspaceRoot,
        sessionId: 'test',
        projects,
        ...(envProjectIds ? { envProjectIds } : {}),
      },
      store,
    );
  }

  it("adopts a peer's re-registration wholesale, and holds it from then on", async () => {
    const store = fakeRegistry([OLD]);
    const pm = manager(store);
    // A peer process re-registers `paper` at a new remote, with every other field changed too.
    await store.upsert(NEW);

    expect(pm.refreshedGitConfig('paper')).toEqual(NEW);
    // Adopted into the snapshot: what `requireGitProject` and the rest of the call then read.
    expect(pm.getProjectConfig('paper')).toEqual(NEW);
    expect(pm.requireGitProject('paper', 'push to').gitUrl).toBe(NEW.gitUrl);
  });

  it('resolves the default project when no id is given', async () => {
    const store = fakeRegistry([OLD]);
    const pm = new ProjectManager(
      { workspaceRoot, sessionId: 'test', projects: [OLD], defaultProject: 'paper' },
      store,
    );
    await store.upsert(NEW);
    expect(pm.refreshedGitConfig(undefined)).toEqual(NEW);
  });

  it('never adopts for an env-configured id: env always wins', async () => {
    const store = fakeRegistry([OLD]);
    const pm = manager(store, [OLD], ['paper']);
    await store.upsert(NEW);

    expect(pm.refreshedGitConfig('paper')).toEqual(OLD);
    expect(pm.getProjectConfig('paper')).toEqual(OLD);
  });

  it('never adopts over a session-only registration, until registerAndPersist un-pins it', async () => {
    const store = fakeRegistry([OLD]);
    const pm = manager(store);
    const mine: ProjectConfig = { id: 'paper', gitUrl: 'https://git.example/mine.git' };
    // `project_sync { gitUrl }`: in memory only.
    pm.registerProject(mine);
    await store.upsert(NEW);
    expect(pm.refreshedGitConfig('paper')).toEqual(mine);

    // A persisting registration makes the registry equal what we hold, so the pin goes; a later
    // peer re-registration is then adopted.
    await pm.registerAndPersist(mine);
    await store.upsert(NEW);
    expect(pm.refreshedGitConfig('paper')).toEqual(NEW);
  });

  it('a session-only registration that restates the registry entry does not pin', async () => {
    // `project_sync { gitUrl }` naming the URL the registry already holds (its other fields kept,
    // as `planSyncRegistration` keeps them): nothing to protect, so a peer's later
    // re-registration is still adopted — or this session would flip `origin` back to it.
    const store = fakeRegistry([OLD]);
    const pm = manager(store);
    pm.registerProject({ ...OLD });
    await store.upsert(NEW);
    expect(pm.refreshedGitConfig('paper')).toEqual(NEW);
  });

  it('restating the registry entry clears an earlier session-only pin', async () => {
    const store = fakeRegistry([OLD]);
    const pm = manager(store);
    pm.registerProject({ id: 'paper', gitUrl: 'https://git.example/mine.git' });
    pm.registerProject({ ...OLD });
    await store.upsert(NEW);
    expect(pm.refreshedGitConfig('paper')).toEqual(NEW);
  });

  it('restating compares the held, credential-stripped URL', async () => {
    const store = fakeRegistry([OLD]);
    const pm = manager(store);
    pm.registerProject({ ...OLD, gitUrl: '  https://git.example/old.git  ' });
    await store.upsert(NEW);
    expect(pm.refreshedGitConfig('paper')).toEqual(NEW);
  });

  it('a session-only registration with a differing URL pins', async () => {
    const store = fakeRegistry([OLD]);
    const pm = manager(store);
    const mine: ProjectConfig = { ...OLD, gitUrl: 'https://git.example/mine.git' };
    pm.registerProject(mine);
    await store.upsert(NEW);
    expect(pm.refreshedGitConfig('paper')).toEqual(mine);
  });

  it('a session-only registration with a differing tokenEnv pins', async () => {
    const store = fakeRegistry([OLD]);
    const pm = manager(store);
    const mine: ProjectConfig = { ...OLD, tokenEnv: 'MINE_TOKEN' };
    pm.registerProject(mine);
    await store.upsert(NEW);
    expect(pm.refreshedGitConfig('paper')).toEqual(mine);
  });

  it('a session-only registration with a differing branch or username pins', async () => {
    for (const mine of [
      { ...OLD, branch: 'other' },
      { ...OLD, username: 'someone' },
    ] satisfies ProjectConfig[]) {
      const store = fakeRegistry([OLD]);
      const pm = manager(store);
      pm.registerProject(mine);
      await store.upsert(NEW);
      expect(pm.refreshedGitConfig('paper')).toEqual(mine);
    }
  });

  it('a session-only registration pins when the registry read throws', async () => {
    const store = fakeRegistry([OLD]);
    const pm = manager(store);
    const realRead = store.read.bind(store);
    // The pin decision is the registration's first registry read; only that one fails, since the
    // directory check's own read (`assertDirUnclaimed`) does not catch.
    let reads = 0;
    store.read = () => {
      reads += 1;
      if (reads === 1) throw new Error('registry unreadable');
      return realRead();
    };
    pm.registerProject({ ...OLD });
    expect(reads).toBeGreaterThan(1);
    await store.upsert(NEW);
    expect(pm.refreshedGitConfig('paper')).toEqual(OLD);
  });

  it('keeps the snapshot when the registry entry is a local project', async () => {
    const store = fakeRegistry([OLD]);
    const pm = manager(store);
    await store.upsert({ id: 'paper', mode: 'local', path: workspaceRoot });

    expect(pm.refreshedGitConfig('paper')).toEqual(OLD);
    expect(pm.getProjectConfig('paper')).toEqual(OLD);
  });

  it('keeps a held local project local, whatever the registry now says', async () => {
    // A mode change is not the stale-URL case this exists for: switching a project this process
    // holds in place to a clone under the workspace is left to a restart or a registration.
    const local: ProjectConfig = { id: 'paper', mode: 'local', path: workspaceRoot };
    const store = fakeRegistry([local]);
    const pm = manager(store, [local]);
    await store.upsert(NEW);

    expect(pm.refreshedGitConfig('paper')).toEqual(local);
    expect(pm.getProjectConfig('paper')).toEqual(local);
  });

  it('keeps the snapshot when the registry entry carries an id that is not usable', () => {
    // A store that does not filter ids itself: the entry's id is refused, never adopted. No
    // snapshot holds an unusable id, so the answer is "nothing held".
    const bad = '../escape';
    const store = fakeRegistry([{ id: bad, gitUrl: 'https://git.example/x.git' }]);
    const pm = manager(store, [OLD]);
    expect(pm.refreshedGitConfig(bad)).toBeUndefined();
    expect(pm.knownIds()).not.toContain(bad);
  });

  it('keeps the snapshot when the registry read throws', () => {
    const store = fakeRegistry([OLD]);
    store.read = () => {
      throw new Error('registry unreadable');
    };
    const pm = manager(store);
    expect(pm.refreshedGitConfig('paper')).toEqual(OLD);
  });

  it('keeps the snapshot when the registry has no entry for the id, or no registry is wired', () => {
    expect(manager(fakeRegistry([])).refreshedGitConfig('paper')).toEqual(OLD);
    expect(manager(undefined).refreshedGitConfig('paper')).toEqual(OLD);
  });

  it('answers undefined for an id held nowhere, leaving the error to requireGitProject', () => {
    const pm = manager(fakeRegistry([]));
    expect(pm.refreshedGitConfig('nope')).toBeUndefined();
    expect(() => pm.requireGitProject('nope', 'push to')).toThrow(/Unknown project/);
  });
});

/**
 * `ProjectManager.assertRegistrationUnchanged`: the in-lock re-read of the registration. A remote
 * operation resolves its config and credential before it takes the project lock; a peer's
 * re-registration landing in that window is refused rather than reconciled back.
 */
describe('ProjectManager.assertRegistrationUnchanged', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'wlm-recheck-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  function manager(store: ProjectRegistryStore): ProjectManager {
    return new ProjectManager({ workspaceRoot, sessionId: 'test', projects: [OLD] }, store);
  }

  it('passes when nothing changed, and when only fields the credential does not use changed', async () => {
    const store = fakeRegistry([OLD]);
    const pm = manager(store);
    const cfg = pm.requireGitProject('paper', 'push to');
    expect(() => pm.assertRegistrationUnchanged(cfg)).not.toThrow();
    await store.upsert({ ...OLD, rootFile: 'other.tex', branch: 'main' });
    expect(() => pm.assertRegistrationUnchanged(cfg)).not.toThrow();
  });

  it('refuses a changed gitUrl, naming old and new, redacted and quoted', async () => {
    const store = fakeRegistry([OLD]);
    const pm = manager(store);
    const cfg = pm.requireGitProject('paper', 'push to');
    await store.upsert({ ...OLD, gitUrl: 'https://user:s3cretpassword@git.example/new.git' });
    let message = '';
    try {
      pm.assertRegistrationUnchanged(cfg);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('"paper"');
    expect(message).toContain('changed while this call waited for the project lock');
    expect(message).toContain(
      'gitUrl "https://git.example/old.git" → "https://user:***@git.example/new.git"',
    );
    expect(message).not.toContain('s3cretpassword');
    expect(message).toContain('nothing was fetched or pushed');
    expect(message).toMatch(/retry/i);
  });

  it('refuses a changed tokenEnv or username, naming each', async () => {
    const store = fakeRegistry([OLD]);
    const pm = manager(store);
    const cfg = pm.requireGitProject('paper', 'push to');
    await store.upsert({ ...OLD, tokenEnv: undefined, username: 'new-user' });
    expect(() => pm.assertRegistrationUnchanged(cfg)).toThrow(
      /tokenEnv "OLD_TOKEN" → \(none\).*username "old-user" → "new-user"/,
    );
  });

  it('refuses when a same-process registration replaced the config while the call waited', () => {
    const pm = manager(fakeRegistry([OLD]));
    const cfg = pm.requireGitProject('paper', 'push to');
    pm.registerProject({ id: 'paper', gitUrl: 'https://git.example/mine.git' });
    expect(() => pm.assertRegistrationUnchanged(cfg)).toThrow(
      /old\.git" → "https:\/\/git\.example\/mine\.git"/,
    );
  });
});

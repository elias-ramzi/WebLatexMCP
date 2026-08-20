import path from 'node:path';
import { access } from 'node:fs/promises';
import { Mutex } from 'async-mutex';
import { withFileLock } from '../lib/fileLock.js';
import { projectLockPath } from '../lib/sessionPaths.js';
import { gitUrlOf, isLocalProject, requireGitProject } from '../lib/projectMode.js';
import type { GitProjectConfig, ProjectConfig, ProjectStatus, ServerConfig } from '../types.js';

/**
 * The persisted registry ProjectManager reads to pick up runtime registrations and writes to make
 * them durable. Kept as a narrow interface so the manager stays unit-testable without touching the
 * filesystem (see `src/services/projectRegistry.ts` for the real store).
 */
export interface ProjectRegistryStore {
  read(): ProjectConfig[];
  upsert(cfg: ProjectConfig): Promise<void>;
}

/**
 * Resolves project ids to working directories under the workspace root and reports
 * clone status. The single source of truth for "which project does this call target".
 * Projects can also be registered dynamically at runtime (via project_sync with a gitUrl, or
 * persisted across sessions via register_project).
 */
export class ProjectManager {
  private readonly projects: Map<string, ProjectConfig>;
  private readonly workspaceRoot: string;
  private readonly defaultProject?: string;
  private readonly sessionId: string;
  private readonly registry?: ProjectRegistryStore;

  /** One mutex per project, so concurrent mutating tool calls can't interleave. */
  private readonly locks = new Map<string, Mutex>();

  constructor(config: ServerConfig, registry?: ProjectRegistryStore) {
    this.projects = new Map(config.projects.map((p) => [p.id, p]));
    this.workspaceRoot = config.workspaceRoot;
    this.defaultProject = config.defaultProject;
    this.sessionId = config.sessionId;
    this.registry = registry;
  }

  /**
   * Run `fn` holding the project's lock — serializes writes/commits/pushes per project.
   *
   * Two layers, because sibling agent sessions run separate server processes over the same
   * clone: the mutex serialises this process's own calls, and the lock file serialises us
   * against every other process. Both are needed — git will happily corrupt an index that two
   * processes rewrite at once.
   */
  async runExclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    let lock = this.locks.get(id);
    if (!lock) {
      lock = new Mutex();
      this.locks.set(id, lock);
    }
    return lock.runExclusive(() =>
      withFileLock(projectLockPath(this.workspaceRoot, id), fn, { owner: this.sessionId }),
    );
  }

  /** Register (or update) a project at runtime, in memory only. */
  registerProject(cfg: ProjectConfig): ProjectConfig {
    this.projects.set(cfg.id, cfg);
    return cfg;
  }

  /**
   * Register a project and persist it to the workspace registry, so it survives a restart and is
   * seen by other sessions. Falls back to an in-memory registration when no registry is wired.
   */
  async registerAndPersist(cfg: ProjectConfig): Promise<ProjectConfig> {
    this.registerProject(cfg);
    await this.registry?.upsert(cfg);
    return cfg;
  }

  /**
   * Pull in any runtime registrations a peer session persisted since we last looked, without
   * clobbering our own (env-configured or newer) entries. Cheap enough to run on an unknown-id
   * miss, which is where a not-yet-seen registration would surface.
   */
  private reloadFromRegistry(): void {
    if (!this.registry) return;
    for (const p of this.registry.read()) {
      if (!this.projects.has(p.id)) this.projects.set(p.id, p);
    }
  }

  /** Resolve a project id (or the configured default) to its config, or throw. */
  getProjectConfig(id?: string): ProjectConfig {
    const resolvedId = id ?? this.defaultProject;
    if (!resolvedId) {
      throw new Error('No project specified and no default project is configured.');
    }
    let project = this.projects.get(resolvedId);
    if (!project) {
      // A peer may have registered it since startup — re-read the persisted registry before failing.
      this.reloadFromRegistry();
      project = this.projects.get(resolvedId);
    }
    if (!project) {
      const known = [...this.projects.keys()].join(', ') || '(none)';
      throw new Error(`Unknown project "${resolvedId}". Known projects: ${known}.`);
    }
    return project;
  }

  /**
   * Working directory for a project id: the clone under the workspace for a git project, and the
   * directory itself for a local one — which is the whole point of local mode, since a copy is
   * exactly what it avoids. An unknown id resolves to where its clone *would* go.
   */
  projectPath(id: string): string {
    const cfg = this.projects.get(id);
    if (cfg && isLocalProject(cfg)) return path.resolve(cfg.path);
    return path.join(this.workspaceRoot, id);
  }

  /** Whether a project is edited in place (no remote, no clone). */
  isLocal(id: string): boolean {
    const cfg = this.projects.get(id);
    return cfg !== undefined && isLocalProject(cfg);
  }

  /**
   * Resolve a project that must have a git remote, or throw naming `action`. Every tool that
   * clones, syncs, commits, pushes or resets calls this instead of `getProjectConfig`, so a local
   * project is refused with an explanation rather than quietly operating on whatever repository
   * happens to contain the user's directory.
   */
  requireGitProject(id: string | undefined, action: string): GitProjectConfig {
    return requireGitProject(this.getProjectConfig(id), action);
  }

  /** All known project ids (configured + runtime-registered), for enumeration. */
  knownIds(): string[] {
    return [...this.projects.keys()];
  }

  /**
   * Inverse of `projectPath`: which project a clone directory belongs to, or undefined if it is
   * not one of ours. Lets services that are handed a directory (FileService) attribute work to a
   * project without every caller threading the id through.
   */
  idForDir(dir: string): string | undefined {
    const resolved = path.resolve(dir);
    return this.knownIds().find((id) => path.resolve(this.projectPath(id)) === resolved);
  }

  /** Whether a project's working directory is there: cloned (git) or simply present (local). */
  async hasClone(id: string): Promise<boolean> {
    return this.isReady(this.getProjectConfig(id));
  }

  /**
   * Resolve a project (or default) to its id + working directory, requiring that directory to
   * exist. Used by every read/write tool so they fail with a clear, actionable message.
   */
  async requireProjectDir(id?: string): Promise<{ id: string; dir: string }> {
    const cfg = this.getProjectConfig(id);
    const dir = this.projectPath(cfg.id);
    if (!(await this.isReady(cfg))) {
      throw new Error(
        isLocalProject(cfg)
          ? `Project "${cfg.id}" is local, but its directory does not exist: ${dir}.`
          : `Project "${cfg.id}" is not cloned yet. Run project_sync first.`,
      );
    }
    return { id: cfg.id, dir };
  }

  /** All known projects with their current status. */
  async listProjects(): Promise<ProjectStatus[]> {
    return Promise.all(
      [...this.projects.values()].map(async (p) => ({
        project: p.id,
        path: this.projectPath(p.id),
        mode: isLocalProject(p) ? ('local' as const) : ('git' as const),
        gitUrl: gitUrlOf(p),
        cloned: await this.isReady(p),
      })),
    );
  }

  /**
   * Is the project usable right now? A git project needs a `.git` (an empty dir is a failed
   * clone); a local one only needs to exist, since the server never created it in the first place.
   */
  private async isReady(cfg: ProjectConfig): Promise<boolean> {
    const dir = this.projectPath(cfg.id);
    try {
      await access(isLocalProject(cfg) ? dir : path.join(dir, '.git'));
      return true;
    } catch {
      return false;
    }
  }
}

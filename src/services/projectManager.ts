import path from 'node:path';
import { access } from 'node:fs/promises';
import { Mutex } from 'async-mutex';
import { withFileLock } from '../lib/fileLock.js';
import type { LockAcquisition } from '../lib/fileLock.js';
import { projectLockPath } from '../lib/sessionPaths.js';
import { gitUrlOf, isLocalProject, requireGitProject } from '../lib/projectMode.js';
import type { GitProjectConfig, ProjectConfig, ProjectStatus, ServerConfig } from '../types.js';

/**
 * Below this, a measured mutex wait is treated as scheduling noise rather than genuine
 * contention — an uncontended `runExclusive` still crosses one or two `Date.now()` ms ticks
 * between taking `t0` and the mutex callback actually running (promise microtask scheduling,
 * GC, a loaded CI runner), and reporting THAT as "waited on this session" would be a false
 * positive on every call, not just a contended one. A real same-process wait (a peer call still
 * running) is on the order of the work that call is doing — milliseconds to seconds — so a few
 * ms of headroom cleanly separates the two without needing the contended case to be exact.
 */
const MUTEX_WAIT_NOISE_MS = 10;

/**
 * The persisted registry ProjectManager reads to pick up runtime registrations and writes to make
 * them durable. Kept as a narrow interface so the manager stays unit-testable without touching the
 * filesystem (see `src/services/projectRegistry.ts` for the real store).
 */
export interface ProjectRegistryStore {
  read(): ProjectConfig[];
  /** Id of the persisted default project, or `undefined`. */
  readDefault(): string | undefined;
  upsert(cfg: ProjectConfig, opts?: { makeDefault?: boolean }): Promise<void>;
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
  /**
   * The in-process default project id. Mutable: `registerAndPersist({ makeDefault: true })` may
   * set it (see there for when it is and is not allowed to).
   */
  private defaultProject?: string;
  /**
   * True when `defaultProject` came from `WEB_LATEX_MCP_DEFAULT_PROJECT` — an assertion, like
   * `compilerExplicit` (see CLAUDE.md). It licenses nothing to override it, including a later
   * `register_project { default: true }` in this same process.
   */
  private readonly defaultProjectExplicit: boolean;
  private readonly sessionId: string;
  private readonly registry?: ProjectRegistryStore;

  /** One mutex per project, so concurrent mutating tool calls can't interleave. */
  private readonly locks = new Map<string, Mutex>();

  constructor(config: ServerConfig, registry?: ProjectRegistryStore) {
    this.projects = new Map(config.projects.map((p) => [p.id, p]));
    this.workspaceRoot = config.workspaceRoot;
    this.defaultProject = config.defaultProject;
    this.defaultProjectExplicit = config.defaultProjectExplicit === true;
    this.sessionId = config.sessionId;
    this.registry = registry;
  }

  /**
   * Run `fn` holding the project's lock — serializes writes/commits/pushes per project. `fn`
   * receives the `LockAcquisition` (how long this call waited for the lock, and who it waited
   * on) so a caller like `compile` can report it; most callers ignore the argument.
   *
   * Two layers, because sibling agent sessions run separate server processes over the same
   * clone: the mutex serialises this process's own calls, and the lock file serialises us
   * against every other process. Both are needed — git will happily corrupt an index that two
   * processes rewrite at once.
   */
  async runExclusive<T>(id: string, fn: (lock: LockAcquisition) => Promise<T>): Promise<T> {
    let lock = this.locks.get(id);
    if (!lock) {
      lock = new Mutex();
      this.locks.set(id, lock);
    }
    // Measured before the mutex is even requested, so `waitedMs` below covers BOTH layers: a
    // same-process peer holding the mutex, and a sibling process holding the file lock.
    // `withFileLock` alone only sees the second — a second concurrent call in this same process
    // would otherwise wait out the whole first call on the mutex and then report `waitedMs: 0`,
    // because `withFileLock`'s own clock only starts once the mutex has already let it in.
    const t0 = Date.now();
    return lock.runExclusive(() => {
      // How long this call waited on the mutex alone, before withFileLock has even started its
      // own (file-lock) wait. Read once, right as the mutex admits us.
      const mutexWaitMs = Date.now() - t0;
      return withFileLock(
        projectLockPath(this.workspaceRoot, id),
        (fileLock) => {
          const waitedMs = Date.now() - t0;
          // The file lock saw no contention of its own (the common case: nobody else is touching
          // this clone), but the mutex wait was real — so the holder it waited on was this very
          // session, just a still-running call in this same process.
          const waitedOn =
            fileLock.waitedOn ?? (mutexWaitMs > MUTEX_WAIT_NOISE_MS ? this.sessionId : undefined);
          const combined: LockAcquisition = { waitedMs, ...(waitedOn ? { waitedOn } : {}) };
          return fn(combined);
        },
        { owner: this.sessionId },
      );
    });
  }

  /** Register (or update) a project at runtime, in memory only. */
  registerProject(cfg: ProjectConfig): ProjectConfig {
    this.projects.set(cfg.id, cfg);
    return cfg;
  }

  /**
   * Register a project and persist it to the workspace registry, so it survives a restart and is
   * seen by other sessions. Falls back to an in-memory registration when no registry is wired.
   *
   * `opts.makeDefault: true` persists this project as the registry's default (see
   * `ProjectRegistryStore.upsert`) and, only when `WEB_LATEX_MCP_DEFAULT_PROJECT` was NOT set for
   * this process, also makes it the in-process default immediately — so the very next call that
   * omits `project` in this session resolves to it without waiting on a re-read. An explicit env
   * default is an assertion (see `defaultProjectExplicit`) and is never overridden by this, even
   * though the registry write still happens — a later, env-unset session picks it up via
   * `readDefault()`.
   */
  async registerAndPersist(
    cfg: ProjectConfig,
    opts?: { makeDefault?: boolean },
  ): Promise<ProjectConfig> {
    this.registerProject(cfg);
    await this.registry?.upsert(cfg, opts);
    if (opts?.makeDefault === true) this.applyMakeDefault(cfg.id);
    return cfg;
  }

  /**
   * Make an already-registered project the default, without repeating `gitUrl`/`path` — the
   * documented "make an existing project the default" flow (`register_project { default: true }`
   * with neither field given).
   *
   * Persists the registry's OWN current entry for `id` when it has one — never the in-process
   * `this.projects` snapshot, which can be stale: session A may be holding `paper` from before
   * session B re-registered it with a new `rootFile`/`branch`, and `reloadFromRegistry` only fills
   * in ids `this.projects` is MISSING, never refreshes one it already holds. Persisting A's stale
   * snapshot would silently overwrite B's update — the exact loss this method exists to prevent.
   * Only when the registry has no entry for `id` (an env-configured project, or no registry wired
   * at all) does this fall back to `getProjectConfig(id)`, the in-process config being the only
   * source of truth in that case. Either way, the whole config is persisted with `makeDefault:
   * true`: `ProjectRegistry.upsert`'s `toEntry` writes every field of whatever `ProjectConfig` it
   * is given, so persisting a config rebuilt from scratch out of a caller's partial args would
   * have silently dropped a previously set `rootFile`/`branch`/`username`/`tokenEnv`.
   *
   * This never overwrites `this.projects` with the registry entry — env-configured entries take
   * precedence over the registry and `ProjectManager` cannot tell which is which, only the
   * persisted write uses the fresh entry.
   *
   * (Re-registering with `gitUrl` alone still replaces the entry — that is `upsert`'s existing,
   * unrelated replace-the-whole-entry behaviour and is out of scope here.)
   *
   * Throws the same "Unknown project" error as `getProjectConfig`, naming the known ids, when `id`
   * is not registered anywhere.
   */
  async setDefaultProject(id: string): Promise<ProjectConfig> {
    const cfg = this.registry?.read().find((p) => p.id === id) ?? this.getProjectConfig(id);
    // Fill an in-process gap only — never overwrite an entry this process already holds (it may
    // be env-configured, which takes precedence over the registry). Same rule as
    // `reloadFromRegistry`; without it `projectPath`/`isLocal` answer for a project the registry
    // read above found but this process had never loaded.
    if (!this.projects.has(cfg.id)) this.registerProject(cfg);
    await this.registry?.upsert(cfg, { makeDefault: true });
    this.applyMakeDefault(cfg.id);
    return cfg;
  }

  /**
   * Apply a `makeDefault: true` registration's effect on the in-process default — shared by
   * `registerAndPersist` and `setDefaultProject` so the "only when not overridden by an explicit
   * `WEB_LATEX_MCP_DEFAULT_PROJECT`" rule can't drift between the two call sites. See
   * `defaultProjectExplicit`.
   */
  private applyMakeDefault(id: string): void {
    if (!this.defaultProjectExplicit) {
      this.defaultProject = id;
    }
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

  /**
   * Id of the default project used when a call omits `project`: the in-process one
   * (`WEB_LATEX_MCP_DEFAULT_PROJECT`, or a `makeDefault` registration this process made) if set,
   * else the persisted registry default — a peer session may have set one since this process
   * started. `undefined` when nothing names a default anywhere.
   */
  defaultProjectId(): string | undefined {
    return this.defaultProject ?? this.registry?.readDefault();
  }

  /** Resolve a project id (or the configured default) to its config, or throw. */
  getProjectConfig(id?: string): ProjectConfig {
    // A peer may have persisted a default since this process started — readDefault() picks it up
    // without waiting for a restart, the same way reloadFromRegistry does for an unknown id below.
    const resolvedId = id ?? this.defaultProjectId();
    if (!resolvedId) {
      const known = this.knownIds();
      throw new Error(
        known.length === 0
          ? 'No project specified and no default project is configured. No projects are ' +
              'registered yet — use register_project (or WEB_LATEX_MCP_PROJECTS) first.'
          : 'No project specified and no default project is configured. Known projects: ' +
              `${known.join(', ')}. Pass "project", set WEB_LATEX_MCP_DEFAULT_PROJECT, or ` +
              're-run register_project with default: true.',
      );
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

  /**
   * Whether this directory's owner has told the server it may follow a symlink out of it —
   * `mode: 'local'` **plus** `followSymlinks: true`. `FileService` asks before refusing one.
   *
   * It is an assertion, not an inference: a directory registered in place is usually a working
   * tree with a remote, and git stores a symlink as mode 120000, so "the user registered it" does
   * not establish that the links in it are the user's. Only the user can say that, so only the
   * user does — see `LocalProjectConfig.followSymlinks`.
   */
  followsUserLinks(dir: string): boolean {
    const id = this.idForDir(dir);
    if (id === undefined) return false;
    const cfg = this.projects.get(id);
    return cfg !== undefined && isLocalProject(cfg) && cfg.followSymlinks === true;
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

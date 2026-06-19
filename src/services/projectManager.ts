import path from 'node:path';
import { access } from 'node:fs/promises';
import { Mutex } from 'async-mutex';
import type { ProjectConfig, ProjectStatus, ServerConfig } from '../types.js';

/**
 * Resolves project ids to working directories under the workspace root and reports
 * clone status. The single source of truth for "which project does this call target".
 * Projects can also be registered dynamically at runtime (via project_sync with a gitUrl).
 */
export class ProjectManager {
  private readonly projects: Map<string, ProjectConfig>;
  private readonly workspaceRoot: string;
  private readonly defaultProject?: string;

  /** One mutex per project, so concurrent mutating tool calls can't interleave. */
  private readonly locks = new Map<string, Mutex>();

  constructor(config: ServerConfig) {
    this.projects = new Map(config.projects.map((p) => [p.id, p]));
    this.workspaceRoot = config.workspaceRoot;
    this.defaultProject = config.defaultProject;
  }

  /** Run `fn` holding the project's lock — serializes writes/commits/pushes per project. */
  async runExclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    let lock = this.locks.get(id);
    if (!lock) {
      lock = new Mutex();
      this.locks.set(id, lock);
    }
    return lock.runExclusive(fn);
  }

  /** Register (or update) a project at runtime. */
  registerProject(id: string, gitUrl: string, rootFile?: string): ProjectConfig {
    const cfg: ProjectConfig = { id, gitUrl, rootFile };
    this.projects.set(id, cfg);
    return cfg;
  }

  /** Resolve a project id (or the configured default) to its config, or throw. */
  getProjectConfig(id?: string): ProjectConfig {
    const resolvedId = id ?? this.defaultProject;
    if (!resolvedId) {
      throw new Error('No project specified and no default project is configured.');
    }
    const project = this.projects.get(resolvedId);
    if (!project) {
      const known = [...this.projects.keys()].join(', ') || '(none)';
      throw new Error(`Unknown project "${resolvedId}". Known projects: ${known}.`);
    }
    return project;
  }

  /** Local clone directory for a project id. */
  projectPath(id: string): string {
    return path.join(this.workspaceRoot, id);
  }

  /** Whether a project id has been cloned locally. */
  async hasClone(id: string): Promise<boolean> {
    return this.isCloned(this.projectPath(id));
  }

  /**
   * Resolve a project (or default) to its id + clone dir, requiring it to be cloned.
   * Used by every read/write tool so they fail with a clear, actionable message.
   */
  async requireClonedDir(id?: string): Promise<{ id: string; dir: string }> {
    const cfg = this.getProjectConfig(id);
    const dir = this.projectPath(cfg.id);
    if (!(await this.isCloned(dir))) {
      throw new Error(`Project "${cfg.id}" is not cloned yet. Run project_sync first.`);
    }
    return { id: cfg.id, dir };
  }

  /** All known projects with their current clone status. */
  async listProjects(): Promise<ProjectStatus[]> {
    return Promise.all(
      [...this.projects.values()].map(async (p) => {
        const projectPath = this.projectPath(p.id);
        return {
          project: p.id,
          path: projectPath,
          gitUrl: p.gitUrl,
          cloned: await this.isCloned(projectPath),
        };
      }),
    );
  }

  private async isCloned(projectPath: string): Promise<boolean> {
    try {
      await access(path.join(projectPath, '.git'));
      return true;
    } catch {
      return false;
    }
  }
}

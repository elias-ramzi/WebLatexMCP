import path from 'node:path';
import { access } from 'node:fs/promises';
import { Mutex } from 'async-mutex';
import { withFileLock } from '../lib/fileLock.js';
import type { LockAcquisition } from '../lib/fileLock.js';
import { projectLockPath } from '../lib/sessionPaths.js';
import { gitUrlOf, isLocalProject, requireGitProject } from '../lib/projectMode.js';
import {
  assertValidProjectId,
  childPathInside,
  describeSkippedProject,
  findSkippedProject,
  listIds,
  projectIdFold,
  projectIdProblem,
  quoteId,
} from '../lib/projectId.js';
import {
  pathTokenRefusal,
  redactGitUrlCredentials,
  stripGitUrlCredentials,
} from '../lib/gitUrlCredentials.js';
import { registrationChangeMessage, sameRegistration } from '../lib/registrationChange.js';
import type {
  GitProjectConfig,
  ProjectConfig,
  ProjectStatus,
  ServerConfig,
  SkippedProject,
} from '../types.js';

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
 * Whether a loaded (not caller-supplied) id is usable; reports one that is not and hands it to
 * `record`, so a later call naming it can be told why.
 */
function usableLoadedId(
  id: string,
  source: string,
  workspaceRoot: string,
  record: (skipped: SkippedProject) => void,
): boolean {
  const problem = projectIdProblem(id);
  if (problem === undefined) return true;
  const skipped: SkippedProject = { id, source, kind: 'id', problem };
  record(skipped);
  console.error(`[web-latex-mcp] ${describeSkippedProject(skipped, workspaceRoot)}`);
  return false;
}

/**
 * Whether two configs for one id name the same project: the same mode, and the same `gitUrl` (git)
 * or the same resolved `path` (local) — compared as `registerProject` holds them and
 * `assertDirUnclaimed` resolves them.
 */
function sameLocation(a: ProjectConfig, b: ProjectConfig): boolean {
  if (isLocalProject(a) || isLocalProject(b)) {
    return isLocalProject(a) && isLocalProject(b) && path.resolve(a.path) === path.resolve(b.path);
  }
  return a.gitUrl === b.gitUrl;
}

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
  /**
   * Entries the store holds but did not load, with why — read when a call names an unknown id, so
   * it can say "skipped because …" instead of "Unknown project". Optional for test stores.
   */
  skipped?(): SkippedProject[];
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
   * The in-process default project id. When `defaultProjectExplicit` is true (the
   * `WEB_LATEX_MCP_DEFAULT_PROJECT` env assertion), `defaultProjectId()` returns exactly this —
   * the env assertion always wins. Otherwise this value is only the FALLBACK `defaultProjectId()`
   * uses when no registry is wired at all, or the registry currently names no default: the
   * registry's own `readDefault()` is the live source of truth for every session that did not
   * assert a default through the env var, so a peer session's `register_project { default: true
   * }` reaches this session's very next call, whether or not this process started with a default
   * of its own. Still mutable: `registerAndPersist`/`setDefaultProject` with `makeDefault: true`
   * set it too (via `applyMakeDefault`), so it stays a correct fallback and remains meaningful
   * when no registry is wired (the unit-test / no-registry configuration).
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
  /**
   * Configured ids that were not loaded because `src/lib/projectId.ts` refuses them, with why —
   * from `loadConfig` (`ServerConfig.skippedProjects`) and from the constructor's own check. The
   * registry's skipped entries are not copied here: they are read fresh on a miss, since a peer
   * or a hand edit can change the file at any time.
   */
  private readonly skippedProjects: SkippedProject[];
  /**
   * Ids configured through `WEB_LATEX_MCP_PROJECTS` (`ServerConfig.envProjectIds`). Env always wins
   * over the registry, so neither `registeredRootFile` nor `refreshedGitConfig` lets a registry
   * entry override one of these.
   */
  private readonly envProjectIds: ReadonlySet<string>;
  /**
   * Ids whose in-process config this process set by a registration it did NOT persist —
   * `project_sync { gitUrl }`, which calls `registerProject` directly — and that DIFFERS from the
   * registry's entry for the id (`sameRegistration`). `refreshedGitConfig` never replaces one of
   * these with the registry's entry: this session re-pointed the project on purpose, for itself.
   * A registration that merely restates the registry's entry does not pin, and clears an earlier
   * pin: there is nothing of this session's own to protect, and pinning it brought back the very
   * flip `refreshedGitConfig` removes (a session that once restated the URL kept it after a peer
   * re-pointed the project, and its next push re-pointed `origin` back). `registerAndPersist`
   * clears the pin once its upsert lands, since the registry then holds what this process holds.
   * Startup loading never pins (the constructor fills `projects` directly, not through
   * `registerProject`).
   */
  private readonly sessionPinned = new Set<string>();

  constructor(config: ServerConfig, registry?: ProjectRegistryStore) {
    this.workspaceRoot = config.workspaceRoot;
    this.skippedProjects = [...(config.skippedProjects ?? [])];
    this.envProjectIds = new Set(config.envProjectIds ?? []);
    // `loadConfig` already drops (and reports) an id `src/lib/projectId.ts` refuses; this keeps a
    // config built any other way from putting one where `projectPath` would throw on it.
    this.projects = new Map(
      config.projects
        .filter((p) =>
          usableLoadedId(p.id, 'the configuration', this.workspaceRoot, (s) =>
            this.skippedProjects.push(s),
          ),
        )
        .map((p) => [p.id, p]),
    );
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
    // Before anything else: `withFileLock` creates the lock's directory first thing, so an id that
    // walks out of `.sessions/` would otherwise create a directory wherever it points — and
    // `register_project` takes this lock before the id has been registered anywhere.
    assertValidProjectId(id);
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

  /**
   * Register (or update) a project at runtime, in memory only. Every runtime registration —
   * `register_project` (through `registerAndPersist`) and `project_sync { gitUrl }` — comes
   * through here, so three rules hold for all of them:
   *
   * - the id must be usable as one directory name (`assertValidProjectId`, `src/lib/projectId.ts`);
   * - a `gitUrl` is held trimmed, without any userinfo password or token and without any
   *   credential query parameter (`stripGitUrlCredentials`; a plain login name stays): the config
   *   is persisted, listed, and handed to `GitService.clone`, which writes it to the clone's
   *   `origin` — a token inside it would be stored in plain text in both places. A caller that
   *   must report the removal asks `strippedCredentialsNoteFor` with the URL it passed in, which
   *   judges by this same strip. A URL whose PATH carries a token-like segment is refused
   *   outright, since removing a segment would name another repository;
   * - the working directory must not already belong to a different id (`assertDirUnclaimed`);
   * - a NEW id must not differ from a known one only in case (`assertIdUnaliased`).
   *
   * The registration is session-only — pinned against `refreshedGitConfig` — unless it repeats the
   * registry's current entry for the id (see `sessionPinned`); `registerAndPersist` un-pins.
   *
   * Returns the config as actually registered (URL stripped), which may differ from `cfg`.
   */
  registerProject(cfg: ProjectConfig): ProjectConfig {
    assertValidProjectId(cfg.id);
    let held: ProjectConfig = cfg;
    if (!isLocalProject(cfg)) {
      const stripped = stripGitUrlCredentials(cfg.gitUrl);
      // A token as a path segment cannot be stripped — removing it would name another
      // repository — so the registration is refused before anything is held or persisted.
      // `register_project` refuses it before the project lock too; this is defence in depth.
      if (stripped.pathToken) throw new Error(pathTokenRefusal(cfg.gitUrl));
      held = { ...cfg, gitUrl: stripped.url };
    }
    // Decided before the checks below only because it reads the registry in its own way (it
    // must not throw); nothing is held or pinned unless they pass.
    const restatesRegistry = this.registryHolds(held);
    this.assertDirUnclaimed(held);
    this.assertIdUnaliased(held.id);
    this.projects.set(held.id, held);
    // Session-only until `registerAndPersist` says otherwise — unless it repeats the registry's
    // entry, which leaves nothing to protect (see `sessionPinned`).
    if (restatesRegistry) this.sessionPinned.delete(held.id);
    else this.sessionPinned.add(held.id);
    return held;
  }

  /**
   * Whether the registry's current entry for `cfg.id` is the same registration as `cfg`
   * (`sameRegistration`: location, `branch`, `tokenEnv`, `username`). False with no registry, no
   * entry, or a read that throws — a registration that cannot be compared is pinned, failing
   * toward what the session asked for.
   */
  private registryHolds(cfg: ProjectConfig): boolean {
    if (!this.registry) return false;
    let current: ProjectConfig | undefined;
    try {
      current = this.registry.read().find((p) => p.id === cfg.id);
    } catch {
      return false;
    }
    return current !== undefined && sameRegistration(current, cfg, sameLocation);
  }

  /**
   * Refuse a registration whose working directory another project id already resolves to.
   *
   * `idForDir` maps a directory back to ONE id, and `followsUserLinks` asks it for the link
   * policy — so a second local registration of the same directory had its `followSymlinks`
   * silently ignored (or silently applied, depending on which id came first). Both ids also shared
   * one working tree under two locks, which `runExclusive` exists to prevent. Checked against the
   * registry too (a peer may have registered the directory since this process last looked). The
   * same id at the same directory is an update, never a conflict.
   */
  private assertDirUnclaimed(cfg: ProjectConfig): void {
    this.reloadFromRegistry();
    const dir = path.resolve(this.dirOf(cfg));
    const owner = this.knownIds().find(
      (id) => id !== cfg.id && path.resolve(this.projectPath(id)) === dir,
    );
    if (owner !== undefined) {
      throw new Error(
        `Project ${quoteId(owner)} already uses ${dir}. One directory can belong to one project ` +
          `only — use ${quoteId(owner)} (re-register it to change its settings), or pick a ` +
          'different directory.',
      );
    }
  }

  /**
   * Refuse a NEW id whose case fold (`projectIdFold`) equals a known id's — `Thèse` beside
   * `thèse`, `Paper` beside `paper`. On a case-insensitive disk (macOS, Windows) both name one
   * clone and one `.sessions/<id>/` under two in-process mutexes, which `assertDirUnclaimed`
   * cannot see: it compares resolved paths byte for byte, and the two strings differ. Refused on
   * every platform, so a configuration made on Linux still works when it moves. An id already
   * known is an update and is never refused here, even where a hand-edited configuration holds
   * two that fold together; `assertDirUnclaimed` has just reloaded the registry, so a peer's
   * registration counts.
   */
  private assertIdUnaliased(id: string): void {
    if (this.projects.has(id)) return;
    const fold = projectIdFold(id);
    const alias = this.knownIds().find((known) => projectIdFold(known) === fold);
    if (alias !== undefined) {
      throw new Error(
        `Project id ${quoteId(id)} differs from the existing project ${quoteId(alias)} only in ` +
          'letter case, and on a case-insensitive disk (macOS, Windows) both would name the same ' +
          `directory. Use ${quoteId(alias)}, or pick an id that differs in more than case.`,
      );
    }
  }

  /** The working directory a config resolves to, whether or not it is registered yet. */
  private dirOf(cfg: ProjectConfig): string {
    if (isLocalProject(cfg)) return path.resolve(cfg.path);
    return childPathInside(this.workspaceRoot, cfg.id, 'project id');
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
    const held = this.registerProject(cfg);
    await this.registry?.upsert(held, opts);
    // The registry now holds exactly this config, so it is no longer session-only. Cleared only
    // after the upsert landed: a failed write leaves the id pinned to what this process holds.
    this.sessionPinned.delete(held.id);
    if (opts?.makeDefault === true) this.applyMakeDefault(held.id);
    return held;
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
    if (!this.projects.has(cfg.id)) this.projects.set(cfg.id, cfg);
    await this.registry?.upsert(cfg, { makeDefault: true });
    this.applyMakeDefault(cfg.id);
    return cfg;
  }

  /**
   * What a re-registration of `id` is about to replace, so `register_project` can report which
   * stored fields it would silently drop (`upsert` replaces the whole entry — see
   * `droppedRegistrationFields` in `src/lib/registration.ts`). `project_sync { gitUrl }` asks
   * `heldConfig` instead: it replaces only the in-process config.
   *
   * Prefers the registry's OWN current entry when it has one — a peer session may have
   * re-registered `id` since this process last looked, the same reasoning `setDefaultProject`
   * uses for its own registry read. Falls back to the in-process `this.projects` config for a
   * project that has never been written to the registry at all: one configured through
   * `WEB_LATEX_MCP_PROJECTS`, or registered in-session via `project_sync { gitUrl }`
   * (`registerProject` only ever does `this.projects.set`, never a registry write). Without this
   * fallback, re-registering such a project reports nothing dropped while silently replacing its
   * in-process config — exactly the loss this report exists to name, in the one case the user has
   * no registry entry to inspect.
   *
   * Deliberately not `getProjectConfig(id)`: that throws on an unknown id and can reload from the
   * registry as a side effect, neither of which is wanted for a plain "what do we have on file"
   * lookup. `undefined` when neither source has anything for `id` (first-time registration).
   */
  previousRegistration(id: string): ProjectConfig | undefined {
    return this.registry?.read().find((p) => p.id === id) ?? this.projects.get(id);
  }

  /**
   * The config this process holds for `id` — what `getProjectConfig(id)` returns, including the
   * registry entry it loads on a miss — or `undefined` where that would throw (an id held nowhere).
   * An env-configured id answers with its env config even when the registry holds an entry for it:
   * env wins over the registry, so this is the config a runtime `registerProject(id)` replaces.
   *
   * Unlike `previousRegistration`, which prefers the registry's entry because it is about what a
   * persisting re-registration overwrites on disk; `project_sync { gitUrl }` persists nothing and
   * replaces only the in-process config, so it asks this.
   */
  heldConfig(id: string): ProjectConfig | undefined {
    if (!this.projects.has(id)) this.reloadFromRegistry();
    return this.projects.get(id);
  }

  /**
   * The `rootFile` registered for `id` — the root `compile`, the PDF tools and the viewer use when
   * a call names none — read from the registry's CURRENT entry rather than this process's snapshot.
   *
   * Why: `this.projects` is a snapshot. When peer session B re-registers `paper` with a new
   * `rootFile` (persisted to `<workspace>/registry.json`), this session's entry is never refreshed —
   * `reloadFromRegistry` only fills in MISSING ids — so it kept compiling and serving the old root
   * until a restart, and the hints' advice to "register the project again with rootFile" did
   * nothing for a viewer this session owns.
   *
   * - An env-configured id (`WEB_LATEX_MCP_PROJECTS`) answers from the in-process config: env always
   *   wins over the registry, as it does at startup.
   * - Otherwise, when the registry's current entry for `id` names the SAME project location as the
   *   in-process config (same mode; same `gitUrl` for git, same resolved `path` for local), its
   *   `rootFile` is the answer — `undefined` included, when the peer re-registered without one
   *   (back to auto-detection).
   * - Otherwise — no registry wired, no entry (a project registered in-session by
   *   `project_sync { gitUrl }`, which does not persist), an entry pointing elsewhere, or a
   *   registry that cannot be read — the in-process config's `rootFile`.
   *
   * Only the root follows the registry here, and this method never replaces or writes
   * `this.projects`; a remote operation adopts the whole entry first (`refreshedGitConfig`). Throws the same "Unknown project"
   * error as `getProjectConfig` for an unknown id. A synchronous read of the registry file, once
   * per call — callers read it once and pass the value on.
   */
  registeredRootFile(id: string): string | undefined {
    const held = this.getProjectConfig(id);
    if (this.envProjectIds.has(id) || !this.registry) return held.rootFile;
    let current: ProjectConfig | undefined;
    try {
      current = this.registry.read().find((p) => p.id === id);
    } catch {
      // `ProjectRegistry.read()` reads an unparseable file as empty rather than throwing, but a
      // store that does throw must not fail a compile over a setting it only refines.
      return held.rootFile;
    }
    return current !== undefined && sameLocation(current, held) ? current.rootFile : held.rootFile;
  }

  /**
   * The config a REMOTE operation (`project_sync` without `gitUrl`, `push`, `reset_to_remote`)
   * should use for `id` (or the default project) — the registry's current entry when a peer has
   * re-registered the project since this process loaded it — adopted into `this.projects`.
   * Called before `requireGitProject` and before the credential is resolved, so both follow the
   * adopted URL.
   *
   * Why: every fetch, pull and push reconciles the shared clone's `origin` to the held `gitUrl`
   * while the server owns it (`GitService.reconcileOrigin`). With `this.projects` a snapshot,
   * a peer process that loaded `paper` before session A re-registered it at a new remote kept the
   * old URL, and its next push re-pointed the shared `origin` back and pushed there — sessions
   * flipped `origin` back and forth. Adopting the persisted entry first makes every process
   * converge on the latest persisted registration at its next remote operation.
   *
   * Rules, in order — each but the last answers with the held config, unchanged:
   * - an env-configured id (`WEB_LATEX_MCP_PROJECTS`): env always wins over the registry;
   * - an id pinned by a session-only registration in this process (`sessionPinned`:
   *   `project_sync { gitUrl }` with a registration that differs from the registry's): this
   *   session re-pointed it on purpose. Between such a session and its peers one flip remains,
   *   inherent to a registration nobody else can see. A restatement of the registry's entry
   *   does not pin;
   * - an id this process holds as a local project: a switch from a directory used in place to a
   *   clone under the workspace is a mode change, not the stale URL this exists for;
   * - no registry wired, no registry entry for the id, an entry that is not a git project, an
   *   entry whose id `usableLoadedId` refuses, or a registry read that throws: fail toward the
   *   snapshot, never throw over a refinement;
   * - otherwise the registry's git entry is adopted WHOLESALE — gitUrl, branch, tokenEnv,
   *   username and rootFile together, since a re-registration replaces the whole entry — which
   *   is what a freshly started process would hold. No `assertDirUnclaimed`/`assertIdUnaliased`:
   *   the id is already the registry's, and a git project's directory is `<workspace>/<id>`.
   *
   * `undefined` when the id resolves nowhere; the caller's `requireGitProject` then throws its
   * usual error. Cost: one synchronous `registry.json` read per remote operation, as
   * `registeredRootFile` pays per compile.
   */
  refreshedGitConfig(id?: string): ProjectConfig | undefined {
    const resolvedId = id ?? this.defaultProjectId();
    if (resolvedId === undefined) return undefined;
    const held = this.projects.get(resolvedId);
    if (this.envProjectIds.has(resolvedId) || this.sessionPinned.has(resolvedId)) return held;
    if (held !== undefined && isLocalProject(held)) return held;
    if (!this.registry) return held;
    let current: ProjectConfig | undefined;
    try {
      current = this.registry.read().find((p) => p.id === resolvedId);
    } catch {
      // A store that throws must not fail a push over a refinement; the snapshot stands.
      return held;
    }
    if (
      current === undefined ||
      isLocalProject(current) ||
      !usableLoadedId(current.id, 'the registry', this.workspaceRoot, () => undefined)
    ) {
      return held;
    }
    this.projects.set(resolvedId, current);
    return current;
  }

  /**
   * The in-lock half of `refreshedGitConfig`, for the same remote operations. Each resolves its
   * config and credential BEFORE taking the project lock, and a peer's re-registration (or a
   * same-process `project_sync { gitUrl }`) can land while it waits; reconciling `origin` to the
   * captured URL would then flip it back under the peer. So, inside `runExclusive` and before
   * `reconcileOrigin`, each re-reads the registration here and is refused when the `gitUrl`,
   * `tokenEnv` or `username` it resolved for no longer holds (`registrationChangeMessage`): nothing
   * has been fetched or pushed, and a retry follows the current registration. The re-read adopts
   * it, exactly as the pre-lock refresh would have.
   */
  assertRegistrationUnchanged(cfg: GitProjectConfig): void {
    const message = registrationChangeMessage(cfg, this.refreshedGitConfig(cfg.id));
    if (message !== undefined) throw new Error(message);
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
      // `readProjectRegistry` already skips (and records) an unusable id; this is the backstop
      // for a store that does not, and what it finds is reported through `skipped()` if at all.
      if (
        !this.projects.has(p.id) &&
        usableLoadedId(p.id, 'the registry', this.workspaceRoot, () => undefined)
      ) {
        this.projects.set(p.id, p);
      }
    }
  }

  /**
   * Id of the default project used when a call omits `project`.
   *
   * When `defaultProjectExplicit` is true (`WEB_LATEX_MCP_DEFAULT_PROJECT` was set for this
   * process), that env assertion always wins, full stop — return `this.defaultProject` and never
   * consult the registry.
   *
   * Otherwise the registry's CURRENT default is the live source of truth: a peer session's
   * `register_project { default: true }` must reach every env-unset session's very next call,
   * not only a session that happened to start with no default of its own. (Before this, the
   * in-process value — which for a non-explicit default is only a snapshot of whatever the
   * registry said AT STARTUP — permanently shadowed a later registry update once it was truthy,
   * so a session that started with a registry default never saw a peer retarget it; a session
   * that started with none did, which was the inconsistency.) `this.defaultProject` is consulted
   * only as the fallback: no registry wired at all, or the registry currently names no default.
   *
   * Cost: `readDefault` is a synchronous read of the registry file (`readFileSync`), on the stdio
   * event loop, on every call that omits `project` — and a tool call typically resolves twice
   * (`requireGitProject` then `requireProjectDir` each go through `getProjectConfig`). Accepted
   * deliberately: the file is a few hundred bytes, and a peer-visible default that is actually
   * current outranks a cached one (the inconsistency above). Cache it only if it ever shows up in
   * a profile — and then keyed on the file's mtime, never on process lifetime.
   *
   * `undefined` when nothing names a default anywhere.
   */
  defaultProjectId(): string | undefined {
    if (this.defaultProjectExplicit) return this.defaultProject;
    return this.registry?.readDefault() ?? this.defaultProject;
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
              `${listIds(known)}. Pass "project", set WEB_LATEX_MCP_DEFAULT_PROJECT, or ` +
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
      const known = listIds([...this.projects.keys()]);
      // A configured id that was skipped is not "unknown" to the user — they wrote it down. Say
      // why it was skipped and how to fix it: the startup note went to stderr, which an MCP
      // client never shows.
      const skipped = findSkippedProject(
        [...this.skippedProjects, ...(this.registry?.skipped?.() ?? [])],
        resolvedId,
      );
      if (skipped !== undefined) {
        throw new Error(
          `Project ${quoteId(resolvedId)} is configured but was not loaded. ` +
            `${describeSkippedProject(skipped, this.workspaceRoot)} Known projects: ${known}.`,
        );
      }
      throw new Error(`Unknown project ${quoteId(resolvedId)}. Known projects: ${known}.`);
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
    // Throws rather than resolve `..` or a separator — see `src/lib/projectId.ts`.
    return childPathInside(this.workspaceRoot, id, 'project id');
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
    return this.idsForDir(dir)[0];
  }

  /**
   * Every id whose working directory is `dir`. Registration refuses a second one
   * (`assertDirUnclaimed`), but a hand-edited registry or env config can still hold two, and a
   * policy question must not be answered by whichever happened to come first.
   */
  private idsForDir(dir: string): string[] {
    const resolved = path.resolve(dir);
    return this.knownIds().filter((id) => path.resolve(this.projectPath(id)) === resolved);
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
    // Fails closed: when two ids share the directory (see `idsForDir`), links are followed only
    // if EVERY one of them asserts it — one registration saying no is a no.
    const ids = this.idsForDir(dir);
    if (ids.length === 0) return false;
    return ids.every((id) => {
      const cfg = this.projects.get(id);
      return cfg !== undefined && isLocalProject(cfg) && cfg.followSymlinks === true;
    });
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
          ? `Project ${quoteId(cfg.id)} is local, but its directory does not exist: ${dir}.`
          : `Project ${quoteId(cfg.id)} is not cloned yet. Run project_sync first.`,
      );
    }
    return { id: cfg.id, dir };
  }

  /** All known projects with their current status. */
  async listProjects(): Promise<ProjectStatus[]> {
    return Promise.all(
      [...this.projects.values()].map(async (p) => {
        // Redacted, not dropped: an env-configured or legacy registry URL may still embed a token
        // (registration strips new ones), and the reader should see that it does — without it.
        const gitUrl = gitUrlOf(p);
        return {
          project: p.id,
          path: this.projectPath(p.id),
          mode: isLocalProject(p) ? ('local' as const) : ('git' as const),
          gitUrl: gitUrl === undefined ? undefined : redactGitUrlCredentials(gitUrl),
          cloned: await this.isReady(p),
        };
      }),
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

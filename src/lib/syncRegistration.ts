import type { GitProjectConfig, ProjectConfig } from '../types.js';
import { isLocalProject } from './projectMode.js';
import { stripGitUrlCredentials } from './gitUrlCredentials.js';
import { quoteId } from './projectId.js';
import { droppedFieldList, droppedRegistrationFields, type DroppedField } from './registration.js';

/**
 * The config `project_sync { gitUrl }` registers for `id`.
 *
 * The tool used to register `{ id, gitUrl }` and nothing else, which REPLACED whatever `id` held:
 * a project configured with `rootFile`, `branch`, `username` or `tokenEnv` lost them for the rest
 * of the process — changing what `compile`, the PDF tools and the viewer build, which branch is
 * synced, and which token authenticates — merely because the caller re-stated its URL.
 *
 * `previous` is the config the registration is planned FROM (`syncRegistrationBase`): normally the
 * one this process holds for `id` (`ProjectManager.heldConfig`) — an env-configured project's env
 * config, never a registry entry the env one outranks — or the registry's current entry when the
 * call restates its URL. When it is a GIT project for the SAME remote, those four fields are
 * carried forward. "Same" is judged like for like: both URLs go through `stripGitUrlCredentials`,
 * the strip `registerProject` applies before it holds a URL, so a URL differing only by a pasted
 * secret is the same remote, while neither side's secret is ever part of the comparison (an
 * env-configured `previous.gitUrl` is not stripped when loaded). A different URL — a login name
 * included, which is kept by the strip — and a local `previous` keep the plain replace, and the
 * caller names what that dropped (`syncDroppedNote`).
 *
 * `gitUrl` is returned as given; `registerProject` strips it as it always has.
 */
export function syncRegistration(
  id: string,
  gitUrl: string,
  previous: ProjectConfig | undefined,
): GitProjectConfig {
  const next: GitProjectConfig = { id, gitUrl };
  if (previous === undefined || isLocalProject(previous)) return next;
  if (!sameRemote(previous.gitUrl, gitUrl)) return next;
  // Only fields that are set, so no explicit-`undefined` key reaches the held config.
  if (previous.rootFile !== undefined) next.rootFile = previous.rootFile;
  if (previous.branch !== undefined) next.branch = previous.branch;
  if (previous.username !== undefined) next.username = previous.username;
  if (previous.tokenEnv !== undefined) next.tokenEnv = previous.tokenEnv;
  return next;
}

/** Two URLs compared in the form `registerProject` holds them (trimmed, credentials stripped). */
function sameRemote(a: string, b: string): boolean {
  return stripGitUrlCredentials(a).url === stripGitUrlCredentials(b).url;
}

/**
 * The registry's view of `id` for `planSyncRegistration`: its current entry
 * (`ProjectManager.previousRegistration`, which prefers the registry's entry) and whether `id` is
 * configured through `WEB_LATEX_MCP_PROJECTS` (`ServerConfig.envProjectIds`).
 */
export interface SyncRegistryView {
  entry: ProjectConfig | undefined;
  envConfigured: boolean;
}

/**
 * The config `project_sync { gitUrl }` plans its registration from: the registry's current `entry`
 * when it is a git project whose URL, in held form, is the one given — a restatement of the
 * registry's registration — and otherwise `held`, the config this process holds.
 *
 * Why: `ProjectManager.registerProject` pins a session-only registration against
 * `refreshedGitConfig` unless it repeats the registry's entry in `gitUrl`, `branch`, `tokenEnv`
 * and `username` (`sameRegistration`). Planned from a snapshot older than a peer's
 * re-registration, a restatement carried the snapshot's fields (or, from a snapshot at another
 * URL, none) — differing from the entry, it pinned, and the session kept that URL after the peer
 * re-pointed the project again, its next push flipping `origin` back. Planned from the entry, a
 * restatement repeats it, pins nothing, and clears an earlier pin — even one a session set by
 * re-pointing elsewhere first, which `refreshedGitConfig` (returning a pinned config as held)
 * could not undo.
 *
 * An env-configured id keeps `held`: env wins over the registry. A URL the registry does not
 * hold keeps `held` too — a re-point is the session's own choice and still pins. Pure.
 */
export function syncRegistrationBase(
  gitUrl: string,
  held: ProjectConfig | undefined,
  registry: SyncRegistryView,
): ProjectConfig | undefined {
  const { entry, envConfigured } = registry;
  if (envConfigured || entry === undefined || isLocalProject(entry)) return held;
  return sameRemote(entry.gitUrl, gitUrl) ? entry : held;
}

/**
 * `project_sync`'s result-text sentence for a registration that replaced held fields — `''` when
 * nothing was dropped. One sentence in the existing text channel, no new `structuredContent` key.
 *
 * Two cases, worded apart because they are different events: `id` held a LOCAL project, which
 * syncing as a git project replaced; or it held a git project whose `gitUrl` differs from this one.
 * The latter says "differs", never "another remote": a URL differing only by a login name counts
 * as different (the safe reading), and it may well name the same repository. The remedy names
 * `register_project`, the tool that takes those fields — `project_sync` takes none. No URL is
 * echoed, so nothing a URL carried can reach the message.
 *
 * `failed` words the remedy for a sync that then failed: the URL may be the reason (a typo), so
 * the note does not send the caller back to it unconditionally.
 */
export function syncDroppedNote(
  id: string,
  previous: ProjectConfig | undefined,
  dropped: readonly DroppedField[],
  failed = false,
): string {
  if (previous === undefined || dropped.length === 0) return '';
  const fields = droppedFieldList(dropped);
  const withUrl = failed
    ? 'once the gitUrl is right, call register_project with it'
    : 'call register_project with this gitUrl';
  if (isLocalProject(previous)) {
    return (
      `\n${quoteId(id)} was a local project; syncing it as a git project replaced that ` +
      `configuration, dropping its ${fields}. To give the git project fields of its own, ` +
      `${withUrl} and them.`
    );
  }
  return (
    `\nThis gitUrl differs from the one ${quoteId(id)} was registered with, so its previous ` +
    `configuration was replaced, dropping its ${fields} — to keep them, ${withUrl} and those ` +
    'fields.'
  );
}

/**
 * What `project_sync { gitUrl }` registers for `id`, and the note naming what that dropped —
 * worded for a sync that succeeds (`note`) and for one that then fails (`failedNote`). `held` is
 * the config this process holds; with `registry`, a restatement of the registry's entry is planned
 * from that entry instead (`syncRegistrationBase`), so it carries the entry's fields and drops
 * nothing. The note is judged against the base the plan was made from — except that a local
 * `held` is always what the note judges, since that is the configuration this process drops, and
 * its `rootFile` counts as dropped when the entry's differs, not only when the entry sets none. Pure.
 */
export function planSyncRegistration(
  id: string,
  gitUrl: string,
  held: ProjectConfig | undefined,
  registry?: SyncRegistryView,
): { next: GitProjectConfig; note: string; failedNote: string } {
  const previous = registry ? syncRegistrationBase(gitUrl, held, registry) : held;
  const next = syncRegistration(id, gitUrl, previous);
  // A local `held` is what this call replaces whatever the plan was based on: judged against the
  // registry's entry instead, the note came back empty while the local config was dropped.
  const replaced = held !== undefined && isLocalProject(held) ? held : previous;
  const dropped = droppedRegistrationFields(replaced, next);
  // `droppedRegistrationFields` names a rootFile only when `next` sets none — right for
  // `register_project`, where a new rootFile is the caller's own choice. Here a local `held`'s
  // rootFile replaced by the registry entry's different one is a loss the caller never asked for.
  if (
    replaced !== undefined &&
    isLocalProject(replaced) &&
    replaced.rootFile !== undefined &&
    next.rootFile !== undefined &&
    next.rootFile !== replaced.rootFile &&
    !dropped.some((f) => f.name === 'rootFile')
  ) {
    dropped.unshift({ name: 'rootFile', value: replaced.rootFile });
  }
  return {
    next,
    note: syncDroppedNote(id, replaced, dropped),
    failedNote: syncDroppedNote(id, replaced, dropped, true),
  };
}

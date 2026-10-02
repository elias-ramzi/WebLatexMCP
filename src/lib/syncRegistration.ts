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
 * `previous` is the config this registration REPLACES: the one this process holds for `id`
 * (`ProjectManager.heldConfig`) — an env-configured project's env config, never a registry entry
 * the env one outranks. When it is a GIT project for the SAME remote, those four fields are
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
  if (stripGitUrlCredentials(previous.gitUrl).url !== stripGitUrlCredentials(gitUrl).url) {
    return next;
  }
  // Only fields that are set, so no explicit-`undefined` key reaches the held config.
  if (previous.rootFile !== undefined) next.rootFile = previous.rootFile;
  if (previous.branch !== undefined) next.branch = previous.branch;
  if (previous.username !== undefined) next.username = previous.username;
  if (previous.tokenEnv !== undefined) next.tokenEnv = previous.tokenEnv;
  return next;
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
 * `previous` being the config it replaces (see `syncRegistration`) — worded for a sync that
 * succeeds (`note`) and for one that then fails (`failedNote`). Pure.
 */
export function planSyncRegistration(
  id: string,
  gitUrl: string,
  previous: ProjectConfig | undefined,
): { next: GitProjectConfig; note: string; failedNote: string } {
  const next = syncRegistration(id, gitUrl, previous);
  const dropped = droppedRegistrationFields(previous, next);
  return {
    next,
    note: syncDroppedNote(id, previous, dropped),
    failedNote: syncDroppedNote(id, previous, dropped, true),
  };
}

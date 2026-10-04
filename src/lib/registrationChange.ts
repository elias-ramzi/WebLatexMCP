import { isLocalProject } from './projectMode.js';
import { quoteId } from './projectId.js';
import { redactGitUrlCredentials, stripGitUrlCredentials } from './gitUrlCredentials.js';
import type { GitProjectConfig, ProjectConfig } from '../types.js';

/**
 * A `gitUrl` in the form `registerProject` holds it (trimmed, credentials stripped). A legacy
 * registry entry may still carry a token in its URL; compared raw, it would never equal what a
 * registration holds, and a restating `project_sync { gitUrl }` would pin — or, once adopted inside
 * the lock, be refused on every retry.
 */
function heldUrl(gitUrl: string): string {
  return stripGitUrlCredentials(gitUrl).url;
}

/**
 * Whether a registration repeats `current` — the registry's entry for the same id — in every field
 * a remote operation acts on: the same location (for git, the same `gitUrl` compared in its held,
 * credential-stripped form; for local, the same resolved directory, judged by the caller's
 * `sameLocation`), and the same `branch`, `tokenEnv` and `username`. `rootFile` is not compared:
 * it decides no remote, and `registeredRootFile` follows the registry for it anyway. Pure.
 */
export function sameRegistration(
  a: ProjectConfig,
  b: ProjectConfig,
  sameLocation: (a: ProjectConfig, b: ProjectConfig) => boolean,
): boolean {
  if (isLocalProject(a) || isLocalProject(b)) return sameLocation(a, b);
  return (
    heldUrl(a.gitUrl) === heldUrl(b.gitUrl) &&
    a.branch === b.branch &&
    a.tokenEnv === b.tokenEnv &&
    a.username === b.username
  );
}

/** A field value as a message names it: quoted, or `(none)` when unset. */
function shown(value: string | undefined): string {
  return value === undefined ? '(none)' : quoteId(value);
}

/**
 * The refusal for a remote operation whose registration changed between the config it resolved
 * (and resolved its credential for) before taking the project lock — `before` — and the config the
 * lock-holder re-read — `after` — or `undefined` when nothing it acts on changed. Compared:
 * `gitUrl` in its held form (where the fetch or push goes, and the host the credential is keyed
 * to), `tokenEnv` and `username` (the credential itself). Each change is named old → new; a URL is shown redacted
 * (`redactGitUrlCredentials`) and every value quoted (`quoteId`). Pure.
 */
export function registrationChangeMessage(
  before: GitProjectConfig,
  after: ProjectConfig | undefined,
): string | undefined {
  const id = quoteId(before.id);
  const head = `The registration of project ${id} changed while this call waited for the project lock`;
  const tail = '; nothing was fetched or pushed. Retry the call to use the current registration.';
  if (after === undefined || isLocalProject(after)) {
    return `${head} (it is no longer a git project)${tail}`;
  }
  const changes: string[] = [];
  if (heldUrl(after.gitUrl) !== heldUrl(before.gitUrl)) {
    changes.push(
      `gitUrl ${shown(redactGitUrlCredentials(before.gitUrl))} → ${shown(redactGitUrlCredentials(after.gitUrl))}`,
    );
  }
  if (after.tokenEnv !== before.tokenEnv) {
    changes.push(`tokenEnv ${shown(before.tokenEnv)} → ${shown(after.tokenEnv)}`);
  }
  if (after.username !== before.username) {
    changes.push(`username ${shown(before.username)} → ${shown(after.username)}`);
  }
  return changes.length === 0 ? undefined : `${head} (${changes.join('; ')})${tail}`;
}

import { defaultUsernameForHost, hostFromGitUrl } from '../services/auth.js';
import type { ProjectManager } from '../services/projectManager.js';

/** A resolved host + HTTPS username to store or fetch a credential for. */
export interface CredentialTarget {
  host: string;
  username: string;
}

export interface CredentialTargetInput {
  /** Explicit host, e.g. git.overleaf.com. Takes precedence over `project`. */
  host?: string;
  /** Registered project id to derive the host (and default username) from. */
  project?: string;
  /** HTTPS username override; otherwise the host convention (e.g. `git` for Overleaf). */
  username?: string;
}

/**
 * Resolve a `{ host, username }` from either an explicit host or a registered project, applying the
 * per-host username convention. Shared by `set_credential` and `credential_portal` so both derive
 * the target identically. Throws with an actionable message when neither host nor project is given.
 */
export function resolveCredentialTarget(
  pm: ProjectManager,
  input: CredentialTargetInput,
): CredentialTarget {
  let host = input.host?.trim();
  let username = input.username?.trim();
  if (!host) {
    if (!input.project) {
      throw new Error('Provide a `host` (e.g. git.overleaf.com) or a `project` id.');
    }
    const cfg = pm.requireGitProject(input.project, 'store a credential for');
    host = hostFromGitUrl(cfg.gitUrl);
    if (!host) {
      throw new Error(`Could not determine a host from project "${cfg.id}" (${cfg.gitUrl}).`);
    }
    username = username || cfg.username;
  }
  username = username || defaultUsernameForHost(host);
  return { host, username };
}

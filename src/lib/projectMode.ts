import type { GitProjectConfig, LocalProjectConfig, ProjectConfig } from '../types.js';

/**
 * Which kind of project a config is, and the guard that keeps git operations off a local one.
 *
 * A local project is a directory the user already had — often inside a repo of their own that has
 * nothing to do with the document. Running `commit`, `push` or `discard` against it would operate on
 * *their* repository, so those tools refuse instead of half-working.
 */

export function isLocalProject(cfg: ProjectConfig): cfg is LocalProjectConfig {
  return cfg.mode === 'local';
}

/** The remote of a git project, or undefined for a local one — for listings and reports. */
export function gitUrlOf(cfg: ProjectConfig): string | undefined {
  return isLocalProject(cfg) ? undefined : cfg.gitUrl;
}

/**
 * Narrow to a git project or throw a message that says what to do instead. `action` names the
 * operation being refused ("push", "check status") so the error reads as a sentence.
 */
export function requireGitProject(cfg: ProjectConfig, action: string): GitProjectConfig {
  if (isLocalProject(cfg)) {
    throw new Error(
      `Project "${cfg.id}" is local (edited in place at ${cfg.path}), so there is no remote to ` +
        `${action}. Git operations are available for projects registered with a gitUrl; this one ` +
        'is only read, edited, and compiled where it lives.',
    );
  }
  return cfg;
}

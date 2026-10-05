import type { ProjectConfig } from '../types.js';
import { isLocalProject } from './projectMode.js';
import { quoteId } from './projectId.js';

/** One held field a re-registration drops, with the value it held. */
export interface DroppedField {
  name: 'rootFile' | 'followSymlinks' | 'branch' | 'username' | 'tokenEnv';
  value: string | boolean;
}

/**
 * Which optional fields a re-registration is about to drop relative to what was already held, so
 * `register_project` and `project_sync { gitUrl }` can say so instead of silently losing them.
 * `ProjectRegistry.upsert` replaces the whole stored entry on a re-registration with `gitUrl`/`path`
 * (documented, intentional — docs/configuration.md: "pass every field you want kept") — this
 * helper computes the loss, it never changes what gets persisted.
 *
 * Compares only the fields `previous` actually had: a field the new registration also sets is
 * never reported, even when its value changed — this is a loss check, not a diff. `previous`
 * undefined (first-time registration) drops nothing, of course.
 *
 * One rule for every field, kind change or not: it is dropped only when `previous` had it AND
 * `next` does not carry the same value forward. `rootFile` exists on both kinds, so it survives a
 * kind change too, when repeated. `branch`/`username`/`tokenEnv` (git-only) and `followSymlinks`
 * (local-only) cannot be *set* on the other kind at all, so a kind change drops every one of them
 * `previous` had — not because kind changes are special-cased, but because `next` can never carry
 * a git-only field forward onto a local config or vice versa. `followSymlinks: false` is never
 * reported even when omitted next: the effective value is false either way, so nothing was lost.
 */
export function droppedRegistrationFields(
  previous: ProjectConfig | undefined,
  next: ProjectConfig,
): DroppedField[] {
  if (!previous) return [];

  const dropped: DroppedField[] = [];
  const note = (name: DroppedField['name'], value: string | boolean): void => {
    dropped.push({ name, value });
  };

  // Shared by both kinds: dropped whenever `next` doesn't set it too, kind change or not.
  if (previous.rootFile !== undefined && next.rootFile === undefined) {
    note('rootFile', previous.rootFile);
  }

  if (isLocalProject(previous)) {
    // Local-only. `next` can carry it forward only if it is itself a local config that sets it —
    // a git `next` never has the field at all, so this is also how a kind change drops it.
    if (previous.followSymlinks === true && !(isLocalProject(next) && next.followSymlinks)) {
      note('followSymlinks', previous.followSymlinks);
    }
  } else {
    // Git-only. Same shape: `next` carries a field forward only as a git config that sets it.
    if (previous.branch !== undefined && !(!isLocalProject(next) && next.branch !== undefined)) {
      note('branch', previous.branch);
    }
    if (
      previous.username !== undefined &&
      !(!isLocalProject(next) && next.username !== undefined)
    ) {
      note('username', previous.username);
    }
    if (
      previous.tokenEnv !== undefined &&
      !(!isLocalProject(next) && next.tokenEnv !== undefined)
    ) {
      note('tokenEnv', previous.tokenEnv);
    }
  }
  return dropped;
}

/**
 * The dropped fields as a message lists them — `name=value`, comma-separated. The ONE rendering
 * both `register_project`'s note and `project_sync`'s use, so the two tools show a held value the
 * same way. A string value is stored config a caller once supplied, so it goes through `quoteId`
 * like any other caller-supplied string in a message: a newline or bidi override in a held
 * `rootFile` cannot fake a line, and a backslash shows doubled in both tools alike. A boolean
 * (`followSymlinks`) is the server's own word and is shown bare.
 */
export function droppedFieldList(dropped: readonly DroppedField[]): string {
  return dropped
    .map(({ name, value }) => `${name}=${typeof value === 'string' ? quoteId(value) : value}`)
    .join(', ');
}

/**
 * `register_project`'s result-text addendum for a re-registration that dropped held fields —
 * `''` when nothing was dropped (a first registration, or one that repeated every field).
 *
 * Worded around "configuration", not "registry entry": `previous` may come from either — a
 * registry entry, or a project this process only ever held in memory (env-configured, or
 * registered in-session via `project_sync { gitUrl }`) — and the loss reads the same either way.
 */
export function registrationDroppedNote(id: string, dropped: readonly DroppedField[]): string {
  if (dropped.length === 0) return '';
  return (
    ` Replaced the previous configuration of ${quoteId(id)}, dropping its ` +
    `${droppedFieldList(dropped)} — re-register with them to keep them.`
  );
}

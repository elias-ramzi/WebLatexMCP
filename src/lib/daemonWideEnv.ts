import { createHash } from 'node:crypto';

/**
 * The settings a shared server reads from its own environment only (docs/design/shared-server.md
 * §7.1): one value serves every session, so a client's environment cannot change them. A proxy
 * whose environment sets one differently is told so — by name, never value — through
 * `server_info`'s `ignoredClientEnv`.
 *
 * Not listed, because they are per connection and forwarded as headers: `WEB_LATEX_MCP_SESSION`,
 * `_DEFAULT_PROJECT`, `_NO_OUTPUT_SCHEMA` and the token variables. `WEB_LATEX_MCP_WORKSPACE`
 * chooses which daemon a proxy uses, so it can never differ. `WEB_LATEX_MCP_PORT` is the
 * daemon's alone.
 */
export const DAEMON_WIDE_ENV: readonly string[] = [
  'WEB_LATEX_MCP_PROJECTS',
  'WEB_LATEX_MCP_COMPILER',
  'WEB_LATEX_MCP_REFERENCE_SOURCE',
  'WEB_LATEX_MCP_REWRITE_MODE',
  'WEB_LATEX_MCP_CONTACT_EMAIL',
  'WEB_LATEX_MCP_WRITING_GUIDE',
  'WEB_LATEX_MCP_WRITING_GUIDE_EXTRA',
  'WEB_LATEX_MCP_CONCURRENCY_GUIDE',
  'WEB_LATEX_MCP_SKILLS_DIR',
  'WEB_LATEX_MCP_VIEWER_PORT',
  'WEB_LATEX_MCP_MAX_PARALLEL_BUILDS',
  'WEB_LATEX_MCP_CALL_LOG',
  'WEB_LATEX_MCP_VIEWER_TARGET',
  'WEB_LATEX_MCP_OPEN_PATH',
  'WEB_LATEX_MCP_AUTHOR_NAME',
  'WEB_LATEX_MCP_AUTHOR_EMAIL',
  'WEB_LATEX_MCP_INSTALL_KIND',
];

/**
 * A setting's value as the two sides compare it: a SHA-256 of the trimmed value, unset and blank
 * alike as the empty string. Only the hash crosses the wire; a short value could be guessed from
 * it, which is why it travels only to the daemon, behind its bearer token, and is never shown.
 */
export function hashEnvValue(value: string | undefined): string {
  return createHash('sha256')
    .update(value?.trim() ?? '', 'utf8')
    .digest('hex');
}

/** What a proxy sends: the hash of each daemon-wide setting its environment sets. */
export function clientEnvHashes(env: NodeJS.ProcessEnv): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const name of DAEMON_WIDE_ENV) {
    if (env[name]?.trim()) out[name] = hashEnvValue(env[name]);
  }
  return out;
}

/** The daemon-wide settings a client set differently from `daemonEnv`, by name, in list order. */
export function differingEnv(
  client: Readonly<Record<string, string>>,
  daemonEnv: NodeJS.ProcessEnv,
): string[] {
  return DAEMON_WIDE_ENV.filter(
    (name) => Object.hasOwn(client, name) && client[name] !== hashEnvValue(daemonEnv[name]),
  );
}

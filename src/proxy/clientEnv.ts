import path from 'node:path';
import { standardTokenEnvNames } from '../services/auth.js';
import { readProjectRegistry } from '../services/projectRegistry.js';
import { parseProjects } from '../config.js';
import { isLocalProject } from '../lib/projectMode.js';
import { clientEnvHashes } from '../lib/daemonWideEnv.js';
import {
  HEADER_CLIENT_ENV,
  HEADER_CREDENTIALS,
  HEADER_DEFAULT_PROJECT,
  HEADER_NO_OUTPUT_SCHEMA,
  HEADER_REPLACE_WHEN_IDLE,
  HEADER_SESSION,
  MAX_CREDENTIALS,
  MAX_CREDENTIAL_CHARS,
} from '../daemon/sessionHeaders.js';

/**
 * What the stdio proxy takes from its client's environment (docs/design/shared-server.md §7.1,
 * §7.2): the per-connection settings, sent as headers on `initialize`, and the environment an
 * auto-started daemon gets — the client's, minus everything that belongs to one session.
 */

/** Variables that belong to one connection, never to a daemon all sessions share. */
const PER_CONNECTION = [
  'WEB_LATEX_MCP_SESSION',
  'WEB_LATEX_MCP_DEFAULT_PROJECT',
  'WEB_LATEX_MCP_NO_OUTPUT_SCHEMA',
  // Q2: the daemon serves the central registry; one client's env list would apply to everyone.
  'WEB_LATEX_MCP_PROJECTS',
];

/**
 * The token variables a session may need: the generic and host defaults, and every `tokenEnv` a
 * registered (or env-configured) project names. Read fresh, best-effort: a registry that cannot be
 * read only narrows the list, never fails the proxy.
 */
export function credentialVarNames(env: NodeJS.ProcessEnv, workspaceRoot: string): string[] {
  const names = new Set(standardTokenEnvNames());
  const add = (tokenEnv: string | undefined): void => {
    if (tokenEnv && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(tokenEnv)) names.add(tokenEnv);
  };
  try {
    for (const p of readProjectRegistry(workspaceRoot)) if (!isLocalProject(p)) add(p.tokenEnv);
  } catch {
    // Unreadable registry: the standard names still go.
  }
  try {
    const { projects } = parseProjects(env.WEB_LATEX_MCP_PROJECTS, process.cwd(), workspaceRoot);
    for (const p of projects) if (!isLocalProject(p)) add(p.tokenEnv);
  } catch {
    // An unparseable WEB_LATEX_MCP_PROJECTS names no token variable.
  }
  return [...names];
}

/** The overlay sent for this session: each named variable the env sets, within the header's caps. */
export function credentialOverlay(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const name of names) {
    const value = env[name];
    if (typeof value !== 'string' || value.trim() === '') continue;
    if (value.length > MAX_CREDENTIAL_CHARS) continue; // no token is this long; never send it
    if (Object.keys(out).length >= MAX_CREDENTIALS) break;
    out[name] = value;
  }
  return out;
}

/** The headers this proxy's session is opened with. */
export function sessionRequestHeaders(
  env: NodeJS.ProcessEnv,
  credentialNames: readonly string[],
  opts: { replaceWhenIdle?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = {};
  const session = env.WEB_LATEX_MCP_SESSION?.trim();
  if (session) headers[HEADER_SESSION] = session;
  const project = env.WEB_LATEX_MCP_DEFAULT_PROJECT?.trim();
  if (project) headers[HEADER_DEFAULT_PROJECT] = project;
  const noOutputSchema = env.WEB_LATEX_MCP_NO_OUTPUT_SCHEMA?.trim();
  if (noOutputSchema) headers[HEADER_NO_OUTPUT_SCHEMA] = noOutputSchema;
  const overlay = credentialOverlay(env, credentialNames);
  if (Object.keys(overlay).length > 0) headers[HEADER_CREDENTIALS] = JSON.stringify(overlay);
  const hashes = clientEnvHashes(env);
  if (Object.keys(hashes).length > 0) headers[HEADER_CLIENT_ENV] = JSON.stringify(hashes);
  if (opts.replaceWhenIdle) headers[HEADER_REPLACE_WHEN_IDLE] = '1';
  return headers;
}

/**
 * A variable that looks like it holds a secret, whatever tool it is for (`GH_TOKEN`,
 * `GITHUB_ENTERPRISE_TOKEN`, an `NPM_TOKEN`, an `AWS_SECRET_ACCESS_KEY`): never handed to a daemon
 * every session shares. Names, not values, are judged; erring toward stripping costs nothing, as
 * the daemon's own tokens come per session through headers.
 */
// Whole `_`-separated words only: `AUTHOR` (WEB_LATEX_MCP_AUTHOR_NAME) is not `AUTH`.
const SECRET_NAME =
  /(^|_)(TOKEN|TOKENS|SECRET|SECRETS|PASSWORD|PASSWD|PASS|CREDENTIALS?|API_?KEY|PRIVATE_KEY|AUTH)(_|$)/i;

/** Daemon-wide settings holding a path, resolved against the client's directory before spawning. */
const PATH_SETTINGS = [
  'WEB_LATEX_MCP_WRITING_GUIDE',
  'WEB_LATEX_MCP_WRITING_GUIDE_EXTRA',
  'WEB_LATEX_MCP_CONCURRENCY_GUIDE',
  'WEB_LATEX_MCP_SKILLS_DIR',
];

/**
 * The environment for an auto-started daemon: this client's, so its daemon-wide settings (compiler,
 * guides, author) become the daemon's, but without any token, secret-looking or per-connection
 * variable — tokens reach each session through its own headers, and one in the daemon's env would
 * serve every session (`gh` reads `GH_TOKEN` from it). The daemon runs in the workspace, not the
 * client's directory, so a relative path setting is resolved against `cwd` here first.
 * `WEB_LATEX_MCP_WORKSPACE` is pinned to the resolved workspace the proxy looked in.
 */
export function daemonSpawnEnv(
  env: NodeJS.ProcessEnv,
  workspaceRoot: string,
  credentialNames: readonly string[],
  cwd: string = process.cwd(),
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of [...PER_CONNECTION, ...credentialNames]) delete out[name];
  for (const name of Object.keys(out)) if (SECRET_NAME.test(name)) delete out[name];
  for (const name of PATH_SETTINGS) {
    const value = out[name]?.trim();
    // `~` is expanded by the daemon itself; anything else relative is the client's.
    // A URL (`file://…` for the extra guide) is no relative path either.
    if (
      value &&
      !path.isAbsolute(value) &&
      !value.startsWith('~') &&
      !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ) {
      out[name] = path.resolve(cwd, value);
    }
  }
  out.WEB_LATEX_MCP_WORKSPACE = workspaceRoot;
  return out;
}

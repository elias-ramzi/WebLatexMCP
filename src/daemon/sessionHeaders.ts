import { parseSessionId } from '../config.js';
import { projectIdProblem, quoteId } from '../lib/projectId.js';
import { outputSchemaMode, type OutputSchemaMode } from '../lib/outputSchemaCompat.js';

/**
 * The per-connection settings a client (in practice the stdio proxy, milestone 5) sends on
 * `initialize` (docs/design/shared-server.md §7.1, §7.2). Everything else is the daemon's own.
 * A header that does not parse refuses the `initialize` with the reason — never a silent default.
 */
export const HEADER_SESSION = 'x-web-latex-mcp-session';
export const HEADER_DEFAULT_PROJECT = 'x-web-latex-mcp-default-project';
export const HEADER_CREDENTIALS = 'x-web-latex-mcp-credentials';
export const HEADER_NO_OUTPUT_SCHEMA = 'x-web-latex-mcp-no-output-schema';
export const HEADER_IGNORED_ENV = 'x-web-latex-mcp-ignored-env';

/** Bounds on the credential overlay: a handful of variables, each a token. */
export const MAX_CREDENTIALS = 32;
export const MAX_CREDENTIAL_CHARS = 4096;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface SessionSettings {
  /** The id the client asked for; the daemon may suffix it (`uniqueSessionId`). Absent → random. */
  requestedSessionId?: string;
  defaultProject?: string;
  /** Null-prototype: the names are the client's. */
  credentialOverlay?: Record<string, string>;
  outputSchema: OutputSchemaMode;
  /** Names (never values) of daemon-wide variables the client's env set differently. */
  ignoredEnv: string[];
}

export class SessionHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionHeaderError';
  }
}

type Headers = Record<string, string | string[] | undefined>;

function one(headers: Headers, name: string): string | undefined {
  const v = headers[name];
  if (Array.isArray(v)) {
    if (v.length > 1) throw new SessionHeaderError(`Header ${name} was sent more than once.`);
    return v[0];
  }
  return v;
}

/**
 * Parse the per-connection headers of an `initialize` request. `daemonEnv` supplies the
 * output-schema mode when the client sends none.
 */
export function parseSessionHeaders(
  headers: Headers,
  daemonEnv: NodeJS.ProcessEnv,
): SessionSettings {
  const settings: SessionSettings = {
    outputSchema: outputSchemaMode(daemonEnv),
    ignoredEnv: [],
  };

  const session = one(headers, HEADER_SESSION);
  if (session !== undefined) {
    // The proxy sends its own WEB_LATEX_MCP_SESSION, judged by the same rules as in stdio — but
    // here a value it would have to rewrite is refused: the client named a session and must get
    // that one or an error, not a silently different directory.
    let parsed: string;
    try {
      parsed = parseSessionId(session);
    } catch (err) {
      throw new SessionHeaderError((err as Error).message);
    }
    if (!session.trim() || parsed !== session) {
      throw new SessionHeaderError(
        `Session id ${quoteId(session)} is not usable; use letters, digits, ".", "_" or "-" ` +
          '(at most 64).',
      );
    }
    settings.requestedSessionId = session;
  }

  const project = one(headers, HEADER_DEFAULT_PROJECT);
  if (project !== undefined && project.trim() !== '') {
    const problem = projectIdProblem(project);
    if (problem) {
      throw new SessionHeaderError(`Default project ${quoteId(project)} is not usable: ${problem}`);
    }
    settings.defaultProject = project;
  }

  const credentials = one(headers, HEADER_CREDENTIALS);
  if (credentials !== undefined) settings.credentialOverlay = parseCredentials(credentials);

  const noOutputSchema = one(headers, HEADER_NO_OUTPUT_SCHEMA);
  if (noOutputSchema !== undefined && noOutputSchema.trim() !== '') {
    settings.outputSchema = outputSchemaMode({ WEB_LATEX_MCP_NO_OUTPUT_SCHEMA: noOutputSchema });
  }

  const ignored = one(headers, HEADER_IGNORED_ENV);
  if (ignored !== undefined) {
    const names = ignored
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n !== '');
    const bad = names.find((n) => !ENV_NAME.test(n));
    if (bad !== undefined) {
      throw new SessionHeaderError(`${HEADER_IGNORED_ENV} names ${quoteId(bad)}, not a variable.`);
    }
    const unique = [...new Set(names)];
    if (unique.length > 64) {
      throw new SessionHeaderError(
        `${HEADER_IGNORED_ENV} names ${unique.length} variables; at most 64.`,
      );
    }
    settings.ignoredEnv = unique;
  }
  return settings;
}

/** The credential header: a JSON object of variable name → value. Never echoes a value. */
function parseCredentials(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SessionHeaderError(`${HEADER_CREDENTIALS} is not JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SessionHeaderError(`${HEADER_CREDENTIALS} must be a JSON object.`);
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > MAX_CREDENTIALS) {
    throw new SessionHeaderError(
      `${HEADER_CREDENTIALS} carries ${entries.length} variables; at most ${MAX_CREDENTIALS}.`,
    );
  }
  const overlay = Object.create(null) as Record<string, string>;
  for (const [name, value] of entries) {
    if (!ENV_NAME.test(name)) {
      throw new SessionHeaderError(`${HEADER_CREDENTIALS} names ${quoteId(name)}, not a variable.`);
    }
    if (typeof value !== 'string' || value.length > MAX_CREDENTIAL_CHARS) {
      throw new SessionHeaderError(
        `${HEADER_CREDENTIALS}: the value of ${name} must be a string of at most ` +
          `${MAX_CREDENTIAL_CHARS} characters.`,
      );
    }
    overlay[name] = value;
  }
  return overlay;
}

/**
 * `requested` if no open session holds it, else the first free `requested-2`, `requested-3`, …
 * (§5.2). Two open sessions with one id would share a shadow index and each would see no peer in
 * the other. The suffix keeps the id within `parseSessionId`'s 64 characters.
 */
export function uniqueSessionId(requested: string, taken: (id: string) => boolean): string {
  if (!taken(requested)) return requested;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${requested.slice(0, 64 - suffix.length)}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
}

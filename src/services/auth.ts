import { execCapture } from '../lib/exec.js';

/** Resolved git auth for one project: a username + optional token (HTTPS password). */
export interface AuthConfig {
  token?: string;
  username: string;
}

/** Identity used for commits made by the server. */
export interface CommitIdentity {
  name: string;
  email: string;
}

/** The fields of a project that affect credential resolution. */
export interface CredentialProject {
  gitUrl: string;
  /** Override the HTTPS username for this project. */
  username?: string;
  /** Name of the env var holding this project's token (overrides host defaults). */
  tokenEnv?: string;
}

/** Generic token env, used when no host-specific or per-project token is configured. */
const GENERIC_TOKEN_ENV = 'WEB_LATEX_MCP_TOKEN';

interface HostDefaults {
  tokenEnv: string;
  username: string;
}

/** Where an Overleaf user creates a Git authentication token (Account Settings → Git integration). */
export const OVERLEAF_TOKEN_URL = 'https://www.overleaf.com/user/settings';

/** Per-host conventions for the token env var and HTTPS username. Overridable per project. */
const HOST_DEFAULTS: Record<string, HostDefaults> = {
  'github.com': { tokenEnv: 'GITHUB_TOKEN', username: 'x-access-token' },
  'gitlab.com': { tokenEnv: 'GITLAB_TOKEN', username: 'oauth2' },
  'git.overleaf.com': { tokenEnv: 'OVERLEAF_GIT_TOKEN', username: 'git' },
};

/**
 * The host's defaults, own keys only: the host comes from a caller-supplied git URL, and a host
 * named `constructor` or `__proto__` read back `Object`/`Object.prototype` from the literal above —
 * whose `tokenEnv` is undefined, so the resolver looked up the env var literally named "undefined".
 */
/**
 * The token variables every resolver consults whatever the project: the generic one and each
 * host default. A project's own `tokenEnv` comes on top (`src/proxy/clientEnv.ts`).
 */
export function standardTokenEnvNames(): string[] {
  return [GENERIC_TOKEN_ENV, ...Object.values(HOST_DEFAULTS).map((d) => d.tokenEnv)];
}

function hostDefaults(host: string | undefined): HostDefaults | undefined {
  return host !== undefined && Object.hasOwn(HOST_DEFAULTS, host) ? HOST_DEFAULTS[host] : undefined;
}

function hostOf(gitUrl: string): string | undefined {
  try {
    return new URL(gitUrl).hostname;
  } catch {
    return undefined;
  }
}

/** The host component of a git URL, for callers that don't hold a `URL`. */
export function hostFromGitUrl(gitUrl: string): string | undefined {
  return hostOf(gitUrl);
}

/** The conventional HTTPS username for a host (e.g. `git` for Overleaf), falling back to `git`. */
export function defaultUsernameForHost(host: string | undefined): string {
  return hostDefaults(host)?.username || 'git';
}

export function loadIdentity(env: NodeJS.ProcessEnv = process.env): CommitIdentity {
  return {
    name: env.WEB_LATEX_MCP_AUTHOR_NAME?.trim() || 'WebLatexMCP',
    email: env.WEB_LATEX_MCP_AUTHOR_EMAIL?.trim() || 'web-latex-mcp@localhost',
  };
}

/** The list of secret strings to scrub from any output, for this auth config. */
export function redactionSecrets(auth: AuthConfig): string[] {
  return auth.token ? [auth.token] : [];
}

/**
 * Resolves git credentials per project: token from a per-project env override, then the
 * host-default env, then a generic env, then the macOS Keychain (keyed by host); username
 * from a per-project override or the host default. Tokens are never thrown on — missing
 * credentials yield `{ token: undefined }` (fine for public/file:// remotes).
 */
export class CredentialResolver {
  /** Tokens actually resolved, retained so redaction can scrub them from any output. */
  private readonly seenTokens = new Set<string>();
  /**
   * A session scope's own credential variables (`withOverlay`), consulted before `env` for every
   * token name. Memory only: never written anywhere, never handed to a child process, gone with
   * the resolver. Null-prototype — the names are the client's.
   */
  private readonly overlay: Record<string, string>;
  /** The resolver this one overlays, whose secrets this one's `allSecrets` also scrubs. */
  private base?: CredentialResolver;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    /** Injectable for tests; defaults to spawning real subprocesses. */
    private readonly exec: typeof execCapture = execCapture,
  ) {
    this.overlay = Object.create(null) as Record<string, string>;
  }

  /**
   * A resolver for one session scope: `overlay`'s values win over this resolver's env for every
   * token name (per-project `tokenEnv`, host default, generic), and every other source — `gh` and
   * the git credential helper — is this resolver's, run with this resolver's env; a
   * `storeCredential` goes to this resolver itself. The overlay must hold credentials only: every
   * value in it is scrubbed from the scope's output, whatever its name. Its `allSecrets` is this one's plus the overlay's and whatever it
   * resolved itself, so an error in that scope is scrubbed of its own tokens; nothing it learns
   * flows back here, so it is dropped with the scope.
   */
  withOverlay(overlay: Readonly<Record<string, string>>): CredentialResolver {
    const scoped = new CredentialResolver(this.env, this.exec);
    for (const [name, value] of Object.entries(overlay)) {
      if (typeof value === 'string' && value.trim() !== '') scoped.overlay[name] = value;
    }
    scoped.base = this;
    return scoped;
  }

  /** A token variable's value: the scope's overlay first, then the env; blank counts as unset. */
  private tokenVar(name: string): string | undefined {
    return (
      (Object.hasOwn(this.overlay, name) ? this.overlay[name]?.trim() : undefined) ||
      // Own keys only: a registration's `tokenEnv` is the user's text, and `toString` on a plain
      // env object would otherwise read a function.
      (Object.hasOwn(this.env, name) ? this.env[name]?.trim() : undefined) ||
      undefined
    );
  }

  async resolve(project: CredentialProject): Promise<AuthConfig> {
    const host = hostOf(project.gitUrl);
    const defaults = hostDefaults(host);
    const username = project.username?.trim() || defaults?.username || 'git';
    const token = await this.resolveToken(project, host, defaults);
    if (token) this.seenTokens.add(token);
    return { username, token };
  }

  /**
   * Store a credential in the user's git credential helper (the OS keychain — osxkeychain /
   * Windows Credential Manager / libsecret). This is how a token reaches the server *without*
   * being written into our own config: it lands, encrypted, in the OS store, and later resolves
   * through `git credential fill` like any other helper-backed credential — never persisted by us.
   *
   * `git credential approve` gives no success signal and is a silent no-op when no helper is
   * configured (common on a bare Linux box), so this reads the credential straight back and reports
   * whether it actually stuck — letting the caller tell the user to configure a helper otherwise.
   */
  async storeCredential(
    host: string,
    username: string,
    token: string,
  ): Promise<{ persisted: boolean }> {
    // The keychain is the machine's: a scope stores through the process's resolver, so the token
    // is scrubbed process-wide (and still in this scope, whose `allSecrets` includes the base's).
    if (this.base) return this.base.storeCredential(host, username, token);
    this.seenTokens.add(token); // ensure it's scrubbed from any output, even on error
    await this.exec('git', ['credential', 'approve'], {
      input: `protocol=https\nhost=${host}\nusername=${username}\npassword=${token}\n\n`,
      env: { ...this.env, GIT_TERMINAL_PROMPT: '0' },
      timeoutMs: 5000,
    });
    const readBack = await this.tokenFromGitCredential(host);
    return { persisted: readBack === token };
  }

  /** Every token that could appear in output, so error/redaction covers all providers. */
  allSecrets(): string[] {
    const secrets = new Set<string>([...(this.base?.allSecrets() ?? []), ...this.seenTokens]);
    const envNames = [GENERIC_TOKEN_ENV, ...Object.values(HOST_DEFAULTS).map((d) => d.tokenEnv)];
    for (const name of envNames) {
      const value = this.env[name]?.trim();
      if (value) secrets.add(value);
    }
    // Every overlay value, whatever its name: a per-project `tokenEnv` the client forwarded is as
    // secret as a host default.
    for (const value of Object.values(this.overlay)) {
      const trimmed = value.trim();
      if (trimmed) secrets.add(trimmed);
    }
    return [...secrets];
  }

  private async resolveToken(
    project: CredentialProject,
    host: string | undefined,
    defaults: HostDefaults | undefined,
  ): Promise<string | undefined> {
    // 1. Env vars: per-project override, then host default, then generic.
    const envNames: string[] = [];
    if (project.tokenEnv) envNames.push(project.tokenEnv);
    if (defaults) envNames.push(defaults.tokenEnv);
    envNames.push(GENERIC_TOKEN_ENV);
    for (const name of envNames) {
      const value = this.tokenVar(name);
      if (value) return value;
    }

    if (!host) return undefined;

    // 2. GitHub CLI — works for github.com and any GitHub host gh is authenticated to.
    const ghToken = await this.tokenFromGh(host);
    if (ghToken) return ghToken;

    // 3. The user's git credential helper (cross-platform: osxkeychain / libsecret / manager).
    const credToken = await this.tokenFromGitCredential(host);
    if (credToken) return credToken;

    return undefined;
  }

  private async tokenFromGh(host: string): Promise<string | undefined> {
    try {
      const res = await this.exec('gh', ['auth', 'token', '--hostname', host], { timeoutMs: 5000 });
      const token = res.stdout.trim();
      if (res.code === 0 && token) return token;
    } catch {
      // gh not installed — skip.
    }
    return undefined;
  }

  private async tokenFromGitCredential(host: string): Promise<string | undefined> {
    try {
      const res = await this.exec('git', ['credential', 'fill'], {
        input: `protocol=https\nhost=${host}\n\n`,
        // Never prompt — just query configured helpers.
        env: { ...this.env, GIT_TERMINAL_PROMPT: '0' },
        timeoutMs: 5000,
      });
      if (res.code !== 0) return undefined;
      const token = /^password=(.*)$/m.exec(res.stdout)?.[1]?.trim();
      return token || undefined;
    } catch {
      // git unavailable — skip.
    }
    return undefined;
  }
}

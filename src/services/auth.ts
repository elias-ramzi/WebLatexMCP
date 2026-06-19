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

/** macOS Keychain service name; accounts are keyed by host. */
const KEYCHAIN_SERVICE = 'latex-git-mcp';

/** Generic token env, used when no host-specific or per-project token is configured. */
const GENERIC_TOKEN_ENV = 'GIT_MCP_TOKEN';

interface HostDefaults {
  tokenEnv: string;
  username: string;
}

/** Per-host conventions for the token env var and HTTPS username. Overridable per project. */
const HOST_DEFAULTS: Record<string, HostDefaults> = {
  'github.com': { tokenEnv: 'GITHUB_TOKEN', username: 'x-access-token' },
  'gitlab.com': { tokenEnv: 'GITLAB_TOKEN', username: 'oauth2' },
  'git.overleaf.com': { tokenEnv: 'OVERLEAF_GIT_TOKEN', username: 'git' },
};

function hostOf(gitUrl: string): string | undefined {
  try {
    return new URL(gitUrl).hostname;
  } catch {
    return undefined;
  }
}

export function loadIdentity(env: NodeJS.ProcessEnv = process.env): CommitIdentity {
  return {
    name: env.GIT_MCP_AUTHOR_NAME?.trim() || 'LaTeX Git MCP',
    email: env.GIT_MCP_AUTHOR_EMAIL?.trim() || 'latex-git-mcp@localhost',
  };
}

/**
 * Build an authenticated URL by injecting credentials in-memory. Only http(s) URLs are
 * touched; the result is used transiently and never persisted to .git/config.
 */
export function authenticateUrl(gitUrl: string, auth: AuthConfig): string {
  if (!auth.token) return gitUrl;
  let url: URL;
  try {
    url = new URL(gitUrl);
  } catch {
    return gitUrl;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return gitUrl;
  url.username = encodeURIComponent(auth.username);
  url.password = encodeURIComponent(auth.token);
  return url.toString();
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

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    /** Injectable for tests; defaults to spawning real subprocesses. */
    private readonly exec: typeof execCapture = execCapture,
  ) {}

  async resolve(project: CredentialProject): Promise<AuthConfig> {
    const host = hostOf(project.gitUrl);
    const defaults = host ? HOST_DEFAULTS[host] : undefined;
    const username = project.username?.trim() || defaults?.username || 'git';
    const token = await this.resolveToken(project, host, defaults);
    if (token) this.seenTokens.add(token);
    return { username, token };
  }

  /** Every token that could appear in output, so error/redaction covers all providers. */
  allSecrets(): string[] {
    const secrets = new Set<string>(this.seenTokens);
    const envNames = [GENERIC_TOKEN_ENV, ...Object.values(HOST_DEFAULTS).map((d) => d.tokenEnv)];
    for (const name of envNames) {
      const value = this.env[name]?.trim();
      if (value) secrets.add(value);
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
      const value = this.env[name]?.trim();
      if (value) return value;
    }

    if (!host) return undefined;

    // 2. GitHub CLI — works for github.com and any GitHub host gh is authenticated to.
    const ghToken = await this.tokenFromGh(host);
    if (ghToken) return ghToken;

    // 3. macOS Keychain (account = host).
    if (process.platform === 'darwin') {
      const kcToken = await this.tokenFromKeychain(host);
      if (kcToken) return kcToken;
    }
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

  private async tokenFromKeychain(host: string): Promise<string | undefined> {
    try {
      const res = await this.exec(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', host, '-w'],
        { timeoutMs: 5000 },
      );
      const token = res.stdout.trim();
      if (res.code === 0 && token) return token;
    } catch {
      // security unavailable or no entry — skip.
    }
    return undefined;
  }
}

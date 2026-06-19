import { execCapture } from '../lib/exec.js';

/** Git authentication configuration for the Overleaf remote. */
export interface AuthConfig {
  /** The git token used as the HTTPS password. Undefined for unauthenticated (e.g. file://) remotes. */
  token?: string;
  /** HTTPS username. Overleaf accepts any value with token-as-password; defaults to "git". */
  username: string;
}

/** Identity used for commits made by the server. */
export interface CommitIdentity {
  name: string;
  email: string;
}

/** macOS Keychain service name under which the git token may be stored. */
const KEYCHAIN_SERVICE = 'overleaf-mcp';

export function loadUsername(env: NodeJS.ProcessEnv = process.env): string {
  return env.OVERLEAF_GIT_USERNAME?.trim() || 'git';
}

export function loadIdentity(env: NodeJS.ProcessEnv = process.env): CommitIdentity {
  return {
    name: env.OVERLEAF_GIT_AUTHOR_NAME?.trim() || 'Overleaf MCP',
    email: env.OVERLEAF_GIT_AUTHOR_EMAIL?.trim() || 'overleaf-mcp@localhost',
  };
}

/**
 * Resolve the git token: prefer the environment variable, then fall back to the macOS
 * Keychain (so Claude Desktop, which cannot expand env vars in its config, can still
 * avoid an inline plaintext token). Never throws — returns undefined when unavailable.
 */
export async function resolveToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const fromEnv = env.OVERLEAF_GIT_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  if (process.platform === 'darwin') {
    try {
      const res = await execCapture(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
        { timeoutMs: 5000 },
      );
      const token = res.stdout.trim();
      if (res.code === 0 && token) return token;
    } catch {
      // security not available or no entry — fall through.
    }
  }
  return undefined;
}

export async function loadAuth(env: NodeJS.ProcessEnv = process.env): Promise<AuthConfig> {
  return { token: await resolveToken(env), username: loadUsername(env) };
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

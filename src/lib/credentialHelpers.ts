import { escapeInvisibleChars } from './projectId.js';

/**
 * Which git credential helpers would keep a token for a host, and how to describe where it goes.
 *
 * `git credential approve` is a silent no-op when no helper is configured, so `credential_portal`
 * asks first (`CredentialResolver.credentialHelpers`) rather than collecting a token git will throw
 * away. And "stored in the OS keychain" is only true of some helpers: `store` writes a plain-text
 * file and `cache` forgets the token after a timeout, so every message names the helper instead.
 */

/**
 * The helpers git would run for `https://<host>`, in order, from `git config -z --get-regexp
 * '^credential\..*helper$'` output (NUL-terminated `key\nvalue` records). A key is either
 * `credential.helper` or `credential.<url>.helper`; a URL-scoped key counts when its URL names this
 * host (an approximation of git's urlmatch: scheme, host and optional path, no wildcards). An empty
 * value resets the list, as it does in git.
 */
export function activeHelpers(regexpOutput: string, host: string): string[] {
  const want = host.toLowerCase();
  let helpers: string[] = [];
  for (const record of regexpOutput.split('\0')) {
    if (!record) continue;
    const nl = record.indexOf('\n');
    const key = (nl === -1 ? record : record.slice(0, nl)).trim();
    const value = nl === -1 ? '' : record.slice(nl + 1).trim();
    const m = /^credential\.(?:(.+)\.)?helper$/i.exec(key);
    if (!m) continue;
    if (m[1] !== undefined && !urlNamesHost(m[1], want)) continue;
    if (value === '') helpers = [];
    else helpers.push(value);
  }
  return helpers;
}

function urlNamesHost(url: string, host: string): boolean {
  const m = /^(?:https?:\/\/)?(?:[^@/]*@)?([^/:]+)/i.exec(url);
  return m?.[1]?.toLowerCase() === host;
}

/** The helper's short name: `store` for `store --file x`, `manager` for `/mnt/c/.../git-credential-manager.exe`. */
function helperName(helper: string): string {
  if (helper.startsWith('!')) return '!';
  // A quoted path may contain spaces (`"/mnt/c/Program Files/..."`); take the first word otherwise.
  const quoted = /^"([^"]*)"/.exec(helper)?.[1];
  const first = quoted ?? /^(?:\\.|\S)+/.exec(helper)?.[0]?.replace(/\\(.)/g, '$1') ?? helper;
  const base = first.split(/[\\/]/).pop() ?? first;
  return base.replace(/\.exe$/i, '').replace(/^git-credential-/i, '');
}

/** True when every helper is git's in-memory `cache`, which forgets the token after its timeout. */
export function onlyEphemeral(helpers: readonly string[]): boolean {
  return helpers.length > 0 && helpers.every((h) => helperName(h) === 'cache');
}

/** A phrase naming where a token handed to these helpers ends up, for user-facing messages. */
export function describeHelpers(helpers: readonly string[]): string {
  const names = [...new Set(helpers.map(describeHelper))];
  return names.length === 0 ? 'no credential helper' : names.join(', then ');
}

function describeHelper(helper: string): string {
  switch (helperName(helper).toLowerCase()) {
    case 'osxkeychain':
      return 'the macOS Keychain';
    case 'manager':
    case 'manager-core':
      return 'Git Credential Manager';
    case 'wincred':
      return 'Windows Credential Manager';
    case 'libsecret':
    case 'gnome-keyring':
      return 'the libsecret keyring';
    case 'store':
      return 'a plain-text file readable by your user (git’s “store” helper, ~/.git-credentials by default)';
    case 'cache':
      return 'git’s in-memory “cache” helper, which forgets it after its timeout (15 minutes by default)';
    case '!':
      return 'a custom credential-helper command';
    default:
      return `the “${escapeInvisibleChars(helperName(helper))}” credential helper`;
  }
}

/**
 * What to tell a user whose git has no credential helper: the token would be discarded, and here
 * is how to give it somewhere to go. `wsl` adds Git for Windows' Credential Manager, which WSL can
 * run directly and which keeps the token encrypted.
 */
export function noHelperAdvice(opts: { platform: NodeJS.Platform; wsl: boolean }): string {
  const lines = [
    'git has no credential helper configured, so a token entered now would be thrown away ' +
      '(`git credential approve` keeps nothing without one). Configure one, then try again:',
  ];
  if (opts.platform === 'darwin') {
    lines.push('- macOS Keychain: `git config --global credential.helper osxkeychain`');
  } else if (opts.platform === 'win32') {
    lines.push(
      '- Git Credential Manager (ships with Git for Windows): `git config --global credential.helper manager`',
    );
  } else {
    if (opts.wsl) {
      lines.push(
        '- WSL with Git for Windows installed (encrypted, in Windows Credential Manager): ' +
          '`git config --global credential.helper "/mnt/c/Program\\ Files/Git/mingw64/bin/git-credential-manager.exe"`',
      );
    }
    lines.push(
      '- A desktop keyring: install and configure `git-credential-libsecret` (needs a running keyring daemon).',
    );
    lines.push(
      '- Plain text, readable only by your user: `git config --global credential.helper store` ' +
        '(saves to ~/.git-credentials).',
    );
  }
  lines.push(
    '- Or skip the helper: set the host’s token variable (e.g. `OVERLEAF_GIT_TOKEN`) in the server’s environment.',
  );
  return lines.join('\n');
}

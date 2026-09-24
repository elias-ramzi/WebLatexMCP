import { describe, it, expect } from 'vitest';
import { gitCredentialConfig } from '../../src/services/gitService.js';

const TOKEN = 'tok-unit-9c2dSECRET';
const AUTH = { username: 'git', token: TOKEN };

/** The `-c` keys (everything before the first `=`) the builder hands git. */
function keys(gitUrl: string): string[] {
  const injected = gitCredentialConfig(gitUrl, AUTH);
  if (!injected) throw new Error('expected an injection');
  return injected.config.map((c) => c.slice(0, c.indexOf('=')));
}

describe('gitCredentialConfig — the host goes into a `-c` KEY, so it is validated', () => {
  // WHATWG URL keeps `=`, `;`, `$` and `"` in a host. `=` inside a `-c` key would end the key
  // early and turn the rest into the value; refuse rather than hand git a key the URL chose.
  it.each([
    'https://ex=ample.com/repo.git',
    'https://ex;ample.com/repo.git',
    'https://ex$ample.com/repo.git',
    'https://ex"ample.com/repo.git',
  ])('refuses %s, naming the problem and never the token', (gitUrl) => {
    let thrown: unknown;
    try {
      gitCredentialConfig(gitUrl, AUTH);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/host/i);
    expect(message).not.toContain(TOKEN);
  });

  it.each([
    ['https://git.overleaf.com/abc', 'git.overleaf.com'],
    ['http://127.0.0.1:8080/repo.git', '127.0.0.1:8080'],
    ['https://[::1]:8443/repo.git', '[::1]:8443'],
    ['https://Git-Hub.EXAMPLE.com/me/repo.git', 'git-hub.example.com'],
    // WHATWG keeps `_` in a host, and a docker-compose service name carries one routinely.
    ['https://git_server/me/repo.git', 'git_server'],
    ['http://my_git_host:3000/me/repo.git', 'my_git_host:3000'],
  ])('accepts %s (host %s)', (gitUrl, host) => {
    const scheme = gitUrl.slice(0, gitUrl.indexOf(':'));
    for (const k of keys(gitUrl)) expect(k).toBe(`credential.${scheme}://${host}.helper`);
  });

  it('still injects nothing for a non-http(s) remote or a missing token', () => {
    expect(gitCredentialConfig('file:///tmp/x', AUTH)).toBeNull();
    expect(gitCredentialConfig('git@github.com:me/repo.git', AUTH)).toBeNull();
    expect(gitCredentialConfig('https://github.com/me/repo.git', { username: 'git' })).toBeNull();
  });
});

describe('gitCredentialConfig — only the remote host loses the user’s helpers', () => {
  it('resets the helper list with a URL-scoped empty value, never the global `credential.helper`', () => {
    const injected = gitCredentialConfig('https://git.overleaf.com/abc', AUTH);
    expect(injected).not.toBeNull();
    const config = injected!.config;
    // No unscoped reset: that would clear a private submodule/LFS host's helper too.
    expect(config.some((c) => c.startsWith('credential.helper'))).toBe(false);
    // An empty value first (git: "an empty helper value resets the list"), then the inline one.
    expect(config[0]).toBe('credential.https://git.overleaf.com.helper=');
    expect(config).toHaveLength(2);
    expect(config[1]).toMatch(/^credential\.https:\/\/git\.overleaf\.com\.helper=!/);
    // The command line carries variable names, never the secret.
    for (const c of config) expect(c).not.toContain(TOKEN);
  });
});

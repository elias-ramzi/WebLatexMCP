import { describe, it, expect } from 'vitest';
import { CredentialResolver, authenticateUrl } from '../../src/services/auth.js';

describe('CredentialResolver', () => {
  it('resolves a GitHub remote to GITHUB_TOKEN with the x-access-token username', async () => {
    const r = new CredentialResolver({ GITHUB_TOKEN: 'ghtok' });
    expect(await r.resolve({ gitUrl: 'https://github.com/me/repo.git' })).toEqual({
      username: 'x-access-token',
      token: 'ghtok',
    });
  });

  it('resolves an Overleaf remote to OVERLEAF_GIT_TOKEN with the git username', async () => {
    const r = new CredentialResolver({ OVERLEAF_GIT_TOKEN: 'ovtok' });
    expect(await r.resolve({ gitUrl: 'https://git.overleaf.com/abc' })).toEqual({
      username: 'git',
      token: 'ovtok',
    });
  });

  it('lets a project override the token env and username', async () => {
    const r = new CredentialResolver({ MY_TOKEN: 'mine', GITHUB_TOKEN: 'gh' });
    expect(
      await r.resolve({
        gitUrl: 'https://github.com/me/repo',
        tokenEnv: 'MY_TOKEN',
        username: 'me',
      }),
    ).toEqual({ username: 'me', token: 'mine' });
  });

  it('falls back to the generic GIT_MCP_TOKEN for unknown hosts', async () => {
    const r = new CredentialResolver({ GIT_MCP_TOKEN: 'gen' });
    expect(await r.resolve({ gitUrl: 'https://git.example.com/x/y' })).toEqual({
      username: 'git',
      token: 'gen',
    });
  });

  it('returns no token for an unauthenticated (file://) remote', async () => {
    const r = new CredentialResolver({});
    expect(await r.resolve({ gitUrl: 'file:///tmp/x' })).toEqual({ username: 'git' });
  });

  it('allSecrets enumerates every configured host token for redaction', async () => {
    const r = new CredentialResolver({ GITHUB_TOKEN: 'gh', OVERLEAF_GIT_TOKEN: 'ov' });
    expect(r.allSecrets().sort()).toEqual(['gh', 'ov']);
  });
});

describe('authenticateUrl', () => {
  it('injects credentials into a GitHub HTTPS URL', () => {
    expect(
      authenticateUrl('https://github.com/me/repo.git', {
        username: 'x-access-token',
        token: 'tok',
      }),
    ).toBe('https://x-access-token:tok@github.com/me/repo.git');
  });

  it('leaves file:// URLs untouched', () => {
    expect(authenticateUrl('file:///tmp/x', { username: 'git', token: 'tok' })).toBe(
      'file:///tmp/x',
    );
  });
});

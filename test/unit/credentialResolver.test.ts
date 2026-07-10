import { describe, it, expect } from 'vitest';
import { CredentialResolver, authenticateUrl } from '../../src/services/auth.js';
import type { ExecResult } from '../../src/lib/exec.js';

/** Fake exec that returns a gh token for `gh auth token`, and "no entry" for anything else. */
function ghExec(token: string): (cmd: string, args: string[]) => Promise<ExecResult> {
  return async (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'auth' && args[1] === 'token') {
      return { code: 0, stdout: `${token}\n`, stderr: '', timedOut: false };
    }
    return { code: 1, stdout: '', stderr: 'not found', timedOut: false };
  };
}

const failExec = async (): Promise<ExecResult> => ({
  code: 1,
  stdout: '',
  stderr: 'not found',
  timedOut: false,
});

/** Fake exec: gh fails, but `git credential fill` returns a token. */
function gitCredentialExec(token: string): (cmd: string, args: string[]) => Promise<ExecResult> {
  return async (cmd, args) => {
    if (cmd === 'git' && args[0] === 'credential' && args[1] === 'fill') {
      return {
        code: 0,
        stdout: `protocol=https\nhost=github.com\nusername=x-access-token\npassword=${token}\n`,
        stderr: '',
        timedOut: false,
      };
    }
    return { code: 1, stdout: '', stderr: 'no', timedOut: false };
  };
}

describe('CredentialResolver', () => {
  it('resolves a GitHub remote to GITHUB_TOKEN with the x-access-token username', async () => {
    const r = new CredentialResolver({ GITHUB_TOKEN: 'ghtok' }, failExec);
    expect(await r.resolve({ gitUrl: 'https://github.com/me/repo.git' })).toEqual({
      username: 'x-access-token',
      token: 'ghtok',
    });
  });

  it('resolves an Overleaf remote to OVERLEAF_GIT_TOKEN with the git username', async () => {
    const r = new CredentialResolver({ OVERLEAF_GIT_TOKEN: 'ovtok' }, failExec);
    expect(await r.resolve({ gitUrl: 'https://git.overleaf.com/abc' })).toEqual({
      username: 'git',
      token: 'ovtok',
    });
  });

  it('lets a project override the token env and username', async () => {
    const r = new CredentialResolver({ MY_TOKEN: 'mine', GITHUB_TOKEN: 'gh' }, failExec);
    expect(
      await r.resolve({
        gitUrl: 'https://github.com/me/repo',
        tokenEnv: 'MY_TOKEN',
        username: 'me',
      }),
    ).toEqual({ username: 'me', token: 'mine' });
  });

  it('falls back to the generic WEB_LATEX_MCP_TOKEN for unknown hosts', async () => {
    const r = new CredentialResolver({ WEB_LATEX_MCP_TOKEN: 'gen' }, failExec);
    expect(await r.resolve({ gitUrl: 'https://git.example.com/x/y' })).toEqual({
      username: 'git',
      token: 'gen',
    });
  });

  it('returns no token for an unauthenticated (file://) remote', async () => {
    const r = new CredentialResolver({}, failExec);
    expect(await r.resolve({ gitUrl: 'file:///tmp/x' })).toEqual({ username: 'git' });
  });

  it('uses `gh auth token` when no env token is configured', async () => {
    const r = new CredentialResolver({}, ghExec('gh-cli-token'));
    expect(await r.resolve({ gitUrl: 'https://github.com/me/repo' })).toEqual({
      username: 'x-access-token',
      token: 'gh-cli-token',
    });
  });

  it('prefers an env token over the gh CLI', async () => {
    const r = new CredentialResolver({ GITHUB_TOKEN: 'env-tok' }, ghExec('gh-cli-token'));
    expect((await r.resolve({ gitUrl: 'https://github.com/me/repo' })).token).toBe('env-tok');
  });

  it('falls back to the git credential helper when env and gh have nothing', async () => {
    const r = new CredentialResolver({}, gitCredentialExec('cred-token'));
    expect((await r.resolve({ gitUrl: 'https://github.com/me/repo' })).token).toBe('cred-token');
  });

  it('prefers gh over the git credential helper', async () => {
    const bothExec = async (cmd: string): Promise<ExecResult> => {
      if (cmd === 'gh') return { code: 0, stdout: 'gh-token\n', stderr: '', timedOut: false };
      if (cmd === 'git') return { code: 0, stdout: 'password=cred\n', stderr: '', timedOut: false };
      return { code: 1, stdout: '', stderr: '', timedOut: false };
    };
    const r = new CredentialResolver({}, bothExec);
    expect((await r.resolve({ gitUrl: 'https://github.com/me/repo' })).token).toBe('gh-token');
  });

  it('yields no token when env, gh, and git credential all have nothing', async () => {
    const r = new CredentialResolver({}, failExec);
    expect((await r.resolve({ gitUrl: 'https://github.com/me/repo' })).token).toBeUndefined();
  });

  it('allSecrets enumerates configured host tokens and resolved gh tokens', async () => {
    const r = new CredentialResolver({ GITHUB_TOKEN: 'gh', OVERLEAF_GIT_TOKEN: 'ov' }, ghExec('x'));
    expect(r.allSecrets().sort()).toEqual(['gh', 'ov']);
    // A token resolved via gh is also scrubbed once seen.
    const r2 = new CredentialResolver({}, ghExec('gh-cli-token'));
    await r2.resolve({ gitUrl: 'https://github.com/me/repo' });
    expect(r2.allSecrets()).toContain('gh-cli-token');
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

import { describe, it, expect } from 'vitest';
import { CredentialResolver } from '../../src/services/auth.js';
import type { ExecResult } from '../../src/lib/exec.js';

/**
 * A session scope's credential overlay (docs/design/shared-server.md §7.2): the scope's own token
 * variables win over the process env, its secrets are scrubbed from its own output, and nothing it
 * holds or learns reaches the process's resolver or any other scope.
 */

const failExec = async (): Promise<ExecResult> => ({
  code: 1,
  stdout: '',
  stderr: 'not found',
  timedOut: false,
});

/** Fake exec: `git credential fill` answers with `token`, everything else fails. */
function helperExec(token: string): (cmd: string, args: string[]) => Promise<ExecResult> {
  return async (cmd, args) =>
    cmd === 'git' && args[0] === 'credential' && args[1] === 'fill'
      ? { code: 0, stdout: `password=${token}\n`, stderr: '', timedOut: false }
      : { code: 1, stdout: '', stderr: 'no', timedOut: false };
}

const GITHUB = { gitUrl: 'https://github.com/me/repo.git' };

describe('CredentialResolver.withOverlay', () => {
  it("prefers the scope's token over the process env, for every token name", async () => {
    const base = new CredentialResolver(
      { GITHUB_TOKEN: 'process-gh', THESIS_TOKEN: 'process-thesis' },
      failExec,
    );
    const scope = base.withOverlay({ GITHUB_TOKEN: 'scope-gh', THESIS_TOKEN: 'scope-thesis' });

    expect((await scope.resolve(GITHUB)).token).toBe('scope-gh');
    expect((await scope.resolve({ ...GITHUB, tokenEnv: 'THESIS_TOKEN' })).token).toBe(
      'scope-thesis',
    );
    // The process's own resolver is untouched.
    expect((await base.resolve(GITHUB)).token).toBe('process-gh');
  });

  it('falls through to the process env, then the helpers, where the overlay is silent', async () => {
    const base = new CredentialResolver({ GITHUB_TOKEN: 'process-gh' }, helperExec('from-helper'));
    const scope = base.withOverlay({ GITHUB_TOKEN: '   ', UNRELATED: 'x' });

    expect((await scope.resolve(GITHUB)).token).toBe('process-gh');
    expect((await scope.resolve({ gitUrl: 'https://git.example/r' })).token).toBe('from-helper');
  });

  it("scrubs the scope's own secrets in that scope only", async () => {
    const base = new CredentialResolver({ GITHUB_TOKEN: 'process-gh' }, helperExec('helper-tok'));
    const a = base.withOverlay({ CUSTOM_TOKEN: 'scope-a-secret' });
    const b = base.withOverlay({ GITLAB_TOKEN: 'scope-b-secret' });
    await a.resolve({ gitUrl: 'https://git.example/r' }); // learns helper-tok, in scope a

    expect(a.allSecrets().sort()).toEqual(['helper-tok', 'process-gh', 'scope-a-secret']);
    expect(b.allSecrets().sort()).toEqual(['process-gh', 'scope-b-secret']);
    expect(base.allSecrets()).toEqual(['process-gh']);
  });

  it('keeps a client-chosen variable name from reaching the prototype', async () => {
    const base = new CredentialResolver({}, failExec);
    const overlay = JSON.parse('{"__proto__": "p", "constructor": "c"}') as Record<string, string>;
    const scope = base.withOverlay(overlay);

    expect((await scope.resolve({ ...GITHUB, tokenEnv: 'constructor' })).token).toBe('c');
    expect((await scope.resolve({ ...GITHUB, tokenEnv: 'toString' })).token).toBeUndefined();
    expect(scope.allSecrets().sort()).toEqual(['c', 'p']);
  });

  it("stores a scope's credential through the process resolver, so it is scrubbed everywhere", async () => {
    const calls: string[][] = [];
    const exec = async (cmd: string, args: string[]): Promise<ExecResult> => {
      calls.push([cmd, ...args]);
      return { code: 1, stdout: '', stderr: '', timedOut: false };
    };
    const base = new CredentialResolver({}, exec);
    const scope = base.withOverlay({ GITHUB_TOKEN: 'scope-gh' });

    await scope.storeCredential('github.com', 'me', 'typed-on-the-portal');

    expect(calls[0]).toEqual(['git', 'credential', 'approve']);
    expect(base.allSecrets()).toContain('typed-on-the-portal');
    expect(scope.allSecrets()).toContain('typed-on-the-portal');
  });
});

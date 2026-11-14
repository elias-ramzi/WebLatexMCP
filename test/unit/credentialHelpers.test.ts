import { describe, it, expect } from 'vitest';
import {
  activeHelpers,
  describeHelpers,
  noHelperAdvice,
  onlyEphemeral,
} from '../../src/lib/credentialHelpers.js';

describe('activeHelpers', () => {
  it('keeps global helpers and those scoped to this host, case-insensitively', () => {
    const out =
      'credential.helper\nosxkeychain\0' +
      'credential.https://GIT.overleaf.com/.helper\nstore --file /x\0' +
      'credential.https://github.com.helper\n!gh auth git-credential\0' +
      'credential.git.overleaf.com.username\ngit\0';
    expect(activeHelpers(out, 'git.overleaf.com')).toEqual(['osxkeychain', 'store --file /x']);
  });

  it('treats an empty value as a reset, as git does', () => {
    expect(activeHelpers('credential.helper\nstore\0credential.helper\n\0', 'h')).toEqual([]);
  });
});

describe('describeHelpers', () => {
  it('says plainly when the token lands in a plain-text file', () => {
    expect(describeHelpers(['store'])).toMatch(/plain-text file/);
    expect(describeHelpers(['store --file ~/.creds'])).toMatch(/plain-text file/);
  });

  it('recognises helpers given by path, quoted or with escaped spaces', () => {
    const gcm = 'Git Credential Manager';
    expect(
      describeHelpers(['/mnt/c/Program\\ Files/Git/mingw64/bin/git-credential-manager.exe']),
    ).toBe(gcm);
    expect(describeHelpers(['"/mnt/c/Program Files/Git/git-credential-manager.exe" --x'])).toBe(
      gcm,
    );
    expect(describeHelpers(['osxkeychain'])).toBe('the macOS Keychain');
    expect(describeHelpers(['!f() { echo; }; f'])).toBe('a custom credential-helper command');
  });

  it('escapes invisible characters in an unknown helper name', () => {
    expect(describeHelpers(['evil‮'])).not.toContain('‮');
  });

  it('chains several helpers and drops duplicates', () => {
    expect(describeHelpers(['osxkeychain', 'osxkeychain', 'cache'])).toMatch(
      /^the macOS Keychain, then git’s in-memory/,
    );
  });
});

describe('onlyEphemeral', () => {
  it('is true only when every helper is cache', () => {
    expect(onlyEphemeral(['cache --timeout 900'])).toBe(true);
    expect(onlyEphemeral(['cache', 'store'])).toBe(false);
    expect(onlyEphemeral([])).toBe(false);
  });
});

describe('noHelperAdvice', () => {
  it('offers Git for Windows’ Credential Manager only under WSL', () => {
    expect(noHelperAdvice({ platform: 'linux', wsl: true })).toContain(
      'git-credential-manager.exe',
    );
    expect(noHelperAdvice({ platform: 'linux', wsl: false })).not.toContain('.exe');
    expect(noHelperAdvice({ platform: 'linux', wsl: false })).toContain('credential.helper store');
    expect(noHelperAdvice({ platform: 'darwin', wsl: false })).toContain('osxkeychain');
  });
});

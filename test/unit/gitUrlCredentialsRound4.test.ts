import { describe, it, expect } from 'vitest';
import {
  redactGitUrlCredentials,
  stripGitUrlCredentials,
} from '../../src/lib/gitUrlCredentials.js';

const GHP = 'ghp_' + 'a1B2'.repeat(9);

describe('stripGitUrlCredentials — a login name the URL already publishes is kept', () => {
  // Each of these is long and has a digit or mixed case, so the character-mix rule alone judged it
  // a token and dropped it — the login the user's own credential helper keys its lookup on.
  it.each([
    // Azure DevOps' default clone URL: `https://<org>@dev.azure.com/<org>/…`.
    'https://ContosoEngineeringTeam@dev.azure.com/ContosoEngineeringTeam/proj/_git/repo',
    // Bitbucket / GitHub with the user's own namespace in the path.
    'https://johnsmith1990research@bitbucket.org/johnsmith1990research/thesis.git',
    // Legacy Azure DevOps host: the org is a host label rather than a path segment.
    'https://ContosoEngineeringTeam@ContosoEngineeringTeam.visualstudio.com/proj/_git/repo',
    // AWS CodeCommit HTTPS Git credentials: `<iam-user>-at-<12-digit account id>`.
    'https://alice-at-123456789012@git-codecommit.us-east-1.amazonaws.com/v1/repos/paper',
    'https://Jane.Doe2-at-123456789012@git-codecommit.eu-west-1.amazonaws.com/v1/repos/p',
  ])('keeps %s', (url) => {
    expect(stripGitUrlCredentials(url)).toEqual({ url, stripped: false });
    expect(redactGitUrlCredentials(url)).toBe(url);
  });

  it('still removes a token whatever the path says', () => {
    // A documented prefix wins over a path match, and so does a base64-only character.
    expect(stripGitUrlCredentials(`https://${GHP}@github.com/${GHP}/r`).url).toBe(
      `https://github.com/${GHP}/r`,
    );
    expect(stripGitUrlCredentials('https://abc+DEF@host.example/abc+DEF/r').url).toBe(
      'https://host.example/abc+DEF/r',
    );
    // A long mixed-case name NOT in the path is still judged by its character mix.
    expect(
      stripGitUrlCredentials('https://x4Kp9QzR2mLw7NvB1sTc@gitlab.example.com/g/p.git'),
    ).toEqual({ url: 'https://gitlab.example.com/g/p.git', stripped: true, removed: 'token' });
    // A path segment is compared EXACTLY: it publishes its own spelling, not the name's, so a
    // mixed-case name whose lower-cased form is the segment falls to the character mix (a host
    // label, by contrast, is folded — DNS is case-insensitive).
    expect(
      stripGitUrlCredentials(
        'https://ContosoEngineeringTeam@dev.azure.com/contosoengineeringteam/proj/_git/repo',
      ),
    ).toEqual({
      url: 'https://dev.azure.com/contosoengineeringteam/proj/_git/repo',
      stripped: true,
      removed: 'token',
    });
    // A path segment that merely CONTAINS the name is not a match.
    expect(
      stripGitUrlCredentials(
        'https://x4Kp9QzR2mLw7NvB1sTc@gitlab.example.com/x4Kp9QzR2mLw7NvB1sTcX/p',
      ).stripped,
    ).toBe(true);
    // The query and fragment are not the path.
    expect(
      stripGitUrlCredentials(
        'https://x4Kp9QzR2mLw7NvB1sTc@gitlab.example.com/g/p?x4Kp9QzR2mLw7NvB1sTc',
      ).stripped,
    ).toBe(true);
    // Not the CodeCommit shape: 11 digits.
    expect(
      stripGitUrlCredentials(
        'https://alice-at-12345678901@git-codecommit.us-east-1.amazonaws.com/v1/repos/p',
      ).stripped,
    ).toBe(true);
  });
});

describe('stripGitUrlCredentials — the slashes after the scheme', () => {
  // A WHATWG URL parser reads `https:` followed by ANY run of `/` and `\` (zero included) as
  // `https://`, so each of these carries the token in its userinfo. The `//`-anchored match missed
  // all of them, and the token was persisted.
  it.each([
    [`https:/${GHP}@github.com/o/r.git`],
    [`https:\\\\${GHP}@github.com/o/r.git`],
    [`https:/\\${GHP}@github.com/o/r.git`],
    [`https:///${GHP}@github.com/o/r.git`],
    [`https:${GHP}@github.com/o/r.git`],
    [`HTTP:\\${GHP}@github.com/o/r.git`],
  ])('removes the token from %s and writes the separator as //', (raw) => {
    const scheme = raw.slice(0, raw.indexOf(':') + 1);
    const expected = `${scheme}//github.com/o/r.git`;
    expect(stripGitUrlCredentials(raw)).toEqual({
      url: expected,
      stripped: true,
      removed: 'token',
    });
    expect(new URL(expected).username).toBe('');
    expect(redactGitUrlCredentials(raw)).toBe(`${scheme}//***@github.com/o/r.git`);
  });

  it('removes a password behind an odd separator, keeping the user', () => {
    expect(stripGitUrlCredentials('https:/bob:hunter2@host.example/r').url).toBe(
      'https://bob@host.example/r',
    );
  });

  it('leaves a URL without userinfo byte-identical, whatever its slashes', () => {
    for (const url of ['https:/host.example/r', 'https:\\\\host.example/r']) {
      expect(stripGitUrlCredentials(url)).toEqual({ url, stripped: false });
    }
  });
});

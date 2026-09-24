import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  MAX_PROJECT_ID_LENGTH,
  childPathInside,
  isValidProjectId,
  projectIdProblem,
} from '../../src/lib/projectId.js';
import {
  redactGitUrlCredentials,
  stripGitUrlCredentials,
} from '../../src/lib/gitUrlCredentials.js';
import { ProjectManager } from '../../src/services/projectManager.js';
import { gitUrlOf } from '../../src/lib/projectMode.js';

describe('projectIdProblem', () => {
  it('accepts plain directory names up to the length bound', () => {
    for (const id of [
      'paper',
      'a',
      '0',
      'Thesis_2026',
      'cvpr-26.v2',
      'x'.repeat(64),
      // Safe as a directory name, so accepted since review round 2 (they worked before 0.7).
      'my paper',
      '_x',
      'été',
    ]) {
      expect(projectIdProblem(id), id).toBeUndefined();
    }
    expect(MAX_PROJECT_ID_LENGTH).toBe(64);
  });

  it('refuses anything that is not one plain, portable directory entry', () => {
    for (const id of [
      '',
      '.',
      '..',
      '.hidden',
      '-rf',
      'a/b',
      'a\\b',
      'C:x',
      'tab\there',
      'nul\u0000byte',
      'paper.',
      'x'.repeat(65),
      'CON',
      'nul.txt',
      'com1',
      'registry.json',
      'Registry.JSON.lock',
      'paper.pdf',
      'paper.PDF',
    ]) {
      expect(isValidProjectId(id), JSON.stringify(id)).toBe(false);
    }
  });
});

describe('childPathInside', () => {
  const parent = path.resolve('/ws');
  it('joins a single entry', () => {
    expect(childPathInside(parent, 'paper', 'project id')).toBe(path.join(parent, 'paper'));
  });
  it('refuses anything that is not a direct child', () => {
    for (const name of ['', '.', '..', '../x', 'a/b', 'paper/']) {
      expect(() => childPathInside(parent, name, 'project id'), name).toThrow(/project id/);
    }
  });
});

describe('stripGitUrlCredentials / redactGitUrlCredentials', () => {
  it('removes :token (keeping the user), a bare token@, and a password holding a raw @', () => {
    expect(stripGitUrlCredentials('https://u:t@github.com/o/r.git')).toEqual({
      url: 'https://u@github.com/o/r.git',
      stripped: true,
      removed: 'password',
    });
    expect(stripGitUrlCredentials('https://ghp_tok@github.com/o/r')).toEqual({
      url: 'https://github.com/o/r',
      stripped: true,
      removed: 'token',
    });
    expect(stripGitUrlCredentials('HTTP://u:p@ss@host:8080/r?x=1').url).toBe(
      'HTTP://u@host:8080/r?x=1',
    );
    expect(stripGitUrlCredentials('https://:tok@host/r').url).toBe('https://host/r');
  });

  it('leaves URLs without userinfo, and ssh/scp forms, byte-identical', () => {
    for (const url of [
      'https://git.overleaf.com/abc',
      'https://host/path/with@sign',
      'git@github.com:o/r.git',
      'ssh://git@github.com/o/r.git',
      'file:///tmp/bare.git',
    ]) {
      expect(stripGitUrlCredentials(url), url).toEqual({ url, stripped: false });
      expect(redactGitUrlCredentials(url), url).toBe(url);
    }
  });

  it('redacts to *** so a reader can see a credential is embedded', () => {
    expect(redactGitUrlCredentials('https://u:t@github.com/o/r.git')).toBe(
      'https://u:***@github.com/o/r.git',
    );
    expect(redactGitUrlCredentials('https://ghp_tok@github.com/o/r.git')).toBe(
      'https://***@github.com/o/r.git',
    );
  });
});

describe('stripGitUrlCredentials — which bare userinfo is a token', () => {
  // Bare (colon-less) userinfo that is an access token: removed whole. Every one of these was
  // kept, and so persisted, before review round 3.
  it.each([
    // Bitbucket Data Center HTTP access token: base64, so `+`, `/`, `=` (percent-encoded or raw).
    'NjE0ODM2NzY0NjU0OoGa1+kB2fTGP2JbSdh3o9Xh',
    'NjE0ODM2NzY0NjU0OoGa1%2BkB2fTGP2JbSdh3o9Xh',
    'MDEyMzQ1Njc4OTpabcdef%2Fghij%3D',
    'abcDEF+ghij',
    'shortBase64==',
    // Legacy 20-character GitLab personal access token (no prefix): with a digit, or mixed case.
    'x4Kp9QzR2mLw7NvB1sTc',
    'AbCdEfGhIjKlMnOpQrSt',
    'ab_cd-ef3ghij_klmnop',
  ])('removes %s', (user) => {
    expect(stripGitUrlCredentials(`https://${user}@bitbucket.example.com/scm/p/r.git`)).toEqual({
      url: 'https://bitbucket.example.com/scm/p/r.git',
      stripped: true,
      removed: 'token',
    });
  });

  // Login names people actually put there — Azure DevOps' `<org>@`, Bitbucket's `<user>@`, a
  // `firstname.lastname`, and an e-mail address (its `@` percent-encoded) — are kept.
  it.each([
    'contoso',
    'my-org',
    'jsmith',
    'jsmith42',
    'firstname.lastname',
    'jean-baptiste.delacroix-dupont',
    'Contoso-Research',
    'john.smith%40example.com',
    'jane.doe2024%40example.co.uk',
    'me+git%40gmail.com',
  ])('keeps the login name %s', (user) => {
    const url = `https://${user}@dev.azure.com/org/p/_git/r`;
    expect(stripGitUrlCredentials(url)).toEqual({ url, stripped: false });
  });

  it('judges the trimmed URL, so surrounding whitespace cannot hide a token', () => {
    expect(stripGitUrlCredentials('  https://ghp_tok@github.com/o/r.git\n')).toEqual({
      url: 'https://github.com/o/r.git',
      stripped: true,
      removed: 'token',
    });
    expect(redactGitUrlCredentials(' https://u:t@github.com/o/r.git ')).toBe(
      'https://u:***@github.com/o/r.git',
    );
    expect(stripGitUrlCredentials('  https://github.com/o/r.git ')).toEqual({
      url: 'https://github.com/o/r.git',
      stripped: false,
    });
  });
});

describe('ProjectManager.registerProject — gitUrl whitespace', () => {
  it('holds the trimmed, stripped URL, so a pasted leading space cannot keep a token', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'ovl-trim-'));
    try {
      const pm = new ProjectManager({ workspaceRoot, sessionId: 'test', projects: [] });
      const held = pm.registerProject({
        id: 'paper',
        gitUrl: '  https://x4Kp9QzR2mLw7NvB1sTc@gitlab.example.com/g/p.git\t',
      });
      expect(gitUrlOf(held)).toBe('https://gitlab.example.com/g/p.git');
      expect(gitUrlOf(pm.getProjectConfig('paper'))).toBe('https://gitlab.example.com/g/p.git');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

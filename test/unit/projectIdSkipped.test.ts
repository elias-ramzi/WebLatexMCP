import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { ProjectManager } from '../../src/services/projectManager.js';
import {
  ProjectRegistry,
  readProjectRegistry,
  registryPath,
} from '../../src/services/projectRegistry.js';
import { loadConfig } from '../../src/config.js';
import { projectIdProblem } from '../../src/lib/projectId.js';
import * as gitUrlCredentials from '../../src/lib/gitUrlCredentials.js';
import { resolveCredentialTarget } from '../../src/lib/credentialTarget.js';
import { errorResult } from '../../src/lib/errors.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * Project ids and git URLs:
 *
 * - the id rule refuses only what is unsafe as a directory name, so `thèse`, `My Thesis`,
 *   `paper+notes` — which worked before 0.7 — still do;
 * - an id that IS refused is remembered with its reason, so a caller naming it hears why and how
 *   to fix it rather than a bare "Unknown project" (the stderr note is invisible to MCP clients);
 * - a colon-less userinfo that is a login name (Azure DevOps, Bitbucket) is kept in the URL;
 * - a URL credential in configuration is never echoed by `set_credential`'s target resolution;
 * - an empty registry.json is an empty registry, not a parse error.
 */

let root: string;
let workspaceRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'ovl-idskip-'));
  workspaceRoot = path.join(root, 'ws');
  await mkdir(workspaceRoot);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function config(
  projects: ServerConfig['projects'] = [],
  extra: Partial<ServerConfig> = {},
): ServerConfig {
  return { workspaceRoot, sessionId: 'test', projects, ...extra };
}

describe('the project id rule refuses only what is unsafe', () => {
  it('accepts Unicode letters, spaces and ordinary punctuation', () => {
    for (const id of [
      'thèse',
      'My Thesis',
      'paper+notes',
      '論文',
      "Bob's draft (v2)",
      'a,b;c=d@e!f#g$h%i&j[k]l{m}n~o',
      'x'.repeat(64),
      '論'.repeat(64),
    ]) {
      expect(projectIdProblem(id), JSON.stringify(id)).toBeUndefined();
    }
  });

  it('refuses separators, drive colons, control characters, edge dots/spaces and devices', () => {
    const decomposed = 'the\u0300se'; // "thèse" as e + COMBINING GRAVE ACCENT (NFD)
    expect(decomposed).not.toBe('thèse');
    for (const id of [
      '',
      'a/b',
      'a\\b',
      'C:x',
      '.',
      '..',
      '.hidden',
      '-x',
      'x.',
      'x ',
      ' x',
      'a\u0000b',
      'a\tb',
      'a\nb',
      'a\u007fb',
      'a\u0085b',
      'a\u202eb',
      'a\ud800b',
      'a<b',
      'a>b',
      'a"b',
      'a|b',
      'a?b',
      'a*b',
      'CON',
      'con.txt',
      'nul',
      'Nul.tar.gz',
      'COM1',
      'lpt9',
      'COM\u00b9',
      'registry.json',
      'Registry.JSON.lock',
      'paper.pdf',
      'paper.PDF',
      'x'.repeat(65),
      '\u{1F600}'.repeat(63),
      decomposed,
    ]) {
      expect(projectIdProblem(id), JSON.stringify(id)).toBeDefined();
    }
  });

  it('says a decomposed id is not NFC and names the form to use, rather than normalising it', () => {
    const problem = projectIdProblem('the\u0300se');
    expect(problem).toMatch(/NFC/);
    expect(problem).toContain('"thèse"');
  });

  it('registers a Unicode id end to end, clone path and all', () => {
    const pm = new ProjectManager(config());
    pm.registerProject({ id: 'My Thesis', gitUrl: 'https://git.example/t' });
    expect(pm.projectPath('My Thesis')).toBe(path.join(workspaceRoot, 'My Thesis'));
  });
});

describe('a skipped id is explained, not merely unknown', () => {
  it('getProjectConfig names why a registry entry was skipped and how to migrate it', async () => {
    await writeFile(
      registryPath(workspaceRoot),
      JSON.stringify({
        'a/b': { gitUrl: 'https://git.example/x' },
        ok: { gitUrl: 'https://git.example/ok' },
      }),
    );
    const pm = new ProjectManager(config(), new ProjectRegistry(workspaceRoot));
    let message = '';
    try {
      pm.getProjectConfig('a/b');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('"a/b"');
    expect(message).toContain(registryPath(workspaceRoot));
    expect(message).toMatch(/separator/);
    // The fix: rename the key, and carry the clone and the session state over with it.
    expect(message).toMatch(/rename/i);
    expect(message).toContain('.sessions');
  });

  it('matches a decomposed registry key when the caller types the composed form', async () => {
    await writeFile(
      registryPath(workspaceRoot),
      JSON.stringify({ 'the\u0300se': { gitUrl: 'https://git.example/x' } }),
    );
    const pm = new ProjectManager(config(), new ProjectRegistry(workspaceRoot));
    expect(() => pm.getProjectConfig('thèse')).toThrow(/NFC/);
  });

  it('a registry entry skipped for its shape says so too', async () => {
    await writeFile(registryPath(workspaceRoot), JSON.stringify({ cv: { mode: 'local' } }));
    const pm = new ProjectManager(config(), new ProjectRegistry(workspaceRoot));
    expect(() => pm.getProjectConfig('cv')).toThrow(/cv[\s\S]*skipped/);
  });

  it('an env-configured id that was skipped is explained through loadConfig', () => {
    const cfg = loadConfig(
      {
        WEB_LATEX_MCP_WORKSPACE: workspaceRoot,
        WEB_LATEX_MCP_PROJECTS: JSON.stringify({
          'C:paper': { gitUrl: 'https://git.example/e' },
          paper: { gitUrl: 'https://git.example/p' },
        }),
      },
      root,
      () => false,
      () => [],
      () => undefined,
    );
    expect(cfg.projects.map((p) => p.id)).toEqual(['paper']);
    const pm = new ProjectManager(cfg);
    expect(() => pm.getProjectConfig('C:paper')).toThrow(
      /WEB_LATEX_MCP_PROJECTS[\s\S]*path separator/,
    );
    // The stderr note carries the migration hint as well.
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('.sessions'));
  });

  it('a truly unknown id keeps the plain message', () => {
    const pm = new ProjectManager(config([{ id: 'paper', gitUrl: 'https://git.example/p' }]));
    expect(() => pm.getProjectConfig('nope')).toThrow(
      'Unknown project "nope". Known projects: "paper".',
    );
  });
});

describe('colon-less userinfo is a login name, not a secret', () => {
  it('keeps an Azure DevOps or Bitbucket username in the URL', () => {
    for (const url of [
      'https://contoso@dev.azure.com/contoso/proj/_git/repo',
      'https://alice@bitbucket.org/team/repo.git',
    ]) {
      expect(gitUrlCredentials.stripGitUrlCredentials(url).url, url).toBe(url);
      expect(gitUrlCredentials.redactGitUrlCredentials(url), url).toBe(url);
    }
  });

  it('keeps the username when it removes a password, and redacts only the password', () => {
    expect(
      gitUrlCredentials.stripGitUrlCredentials('https://contoso:PAT123@dev.azure.com/c/p').url,
    ).toBe('https://contoso@dev.azure.com/c/p');
    expect(gitUrlCredentials.redactGitUrlCredentials('https://bob:glpat-S@gitlab.com/r')).toBe(
      'https://bob:***@gitlab.com/r',
    );
  });

  it('still removes a bare userinfo that is an access token', () => {
    for (const token of [
      'ghp_0123456789abcdefghijABCDEFGHIJ012345',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
      'glpat-abcdefghij0123456789',
      'olp_abcdef0123456789',
      '0123456789abcdef0123456789abcdef01234567',
    ]) {
      const url = `https://${token}@github.com/o/r.git`;
      expect(gitUrlCredentials.stripGitUrlCredentials(url).url, token).toBe(
        'https://github.com/o/r.git',
      );
      expect(gitUrlCredentials.redactGitUrlCredentials(url), token).toBe(
        'https://***@github.com/o/r.git',
      );
    }
  });

  it('the note claims only what was removed', () => {
    const noteFor = (
      gitUrlCredentials as unknown as {
        strippedCredentialsNoteFor: (url: string | undefined) => string;
      }
    ).strippedCredentialsNoteFor;
    expect(noteFor('https://alice@bitbucket.org/t/r.git')).toBe('');
    expect(noteFor(undefined)).toBe('');
    const password = noteFor('https://alice:s3cret@bitbucket.org/t/r.git');
    expect(password).toMatch(/password/i);
    expect(password).toMatch(/username .*kept/i);
    const token = noteFor('https://ghp_0123456789abcdefghijABCDEFGHIJ012345@github.com/o/r');
    expect(token).toMatch(/token/i);
    expect(token).not.toMatch(/username .*kept/i);
  });
});

describe('a URL credential already in configuration is never echoed', () => {
  // `errorResult` runs every message through `redact()`, whose URL pattern masks userinfo only up
  // to the FIRST `@`: a password holding a raw `@` came back as `https://***@ss-<token>@host`.
  // The message is now built from `redactGitUrlCredentials`, which takes the last `@`.
  it('set_credential/credential_portal: an unparseable token-bearing gitUrl is not quoted', () => {
    const pm = new ProjectManager(
      config([{ id: 'p', gitUrl: 'https://alice:p@ss-SECRET-tok@exa mple.com/r.git' }]),
    );
    let result: ReturnType<typeof errorResult> | undefined;
    try {
      resolveCredentialTarget(pm, { project: 'p' });
    } catch (err) {
      result = errorResult(err, []);
    }
    const text = JSON.stringify(result);
    expect(text).toMatch(/Could not determine a host/);
    expect(text).not.toContain('SECRET-tok');
  });
});

describe('an empty registry.json', () => {
  it('is an empty registry: register works and the file is written', async () => {
    await writeFile(registryPath(workspaceRoot), '');
    expect(readProjectRegistry(workspaceRoot)).toEqual([]);
    await new ProjectRegistry(workspaceRoot).upsert({
      id: 'paper',
      gitUrl: 'https://git.example/p',
    });
    const raw = JSON.parse(await readFile(registryPath(workspaceRoot), 'utf8'));
    expect(raw).toEqual({ paper: { gitUrl: 'https://git.example/p' } });
  });

  it('whitespace only counts as empty too; any other damage still refuses', async () => {
    await writeFile(registryPath(workspaceRoot), '  \n');
    await expect(
      new ProjectRegistry(workspaceRoot).upsert({ id: 'a', gitUrl: 'https://git.example/a' }),
    ).resolves.toBeUndefined();
    await writeFile(registryPath(workspaceRoot), '{');
    await expect(
      new ProjectRegistry(workspaceRoot).upsert({ id: 'b', gitUrl: 'https://git.example/b' }),
    ).rejects.toThrow(/registry/);
  });
});

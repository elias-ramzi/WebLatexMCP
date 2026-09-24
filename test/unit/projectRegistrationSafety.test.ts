import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { ProjectManager } from '../../src/services/projectManager.js';
import {
  ProjectRegistry,
  readProjectRegistry,
  readProjectRegistryDefault,
  registryPath,
} from '../../src/services/projectRegistry.js';
import { sessionStateDir, sessionDir } from '../../src/lib/sessionPaths.js';
import { loadConfig } from '../../src/config.js';
import { gitUrlOf } from '../../src/lib/projectMode.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * Registration safety: a project id becomes a directory name twice over (the clone under the
 * workspace, and `.sessions/<id>/`), so an id carrying a separator or naming `..` placed a clone,
 * a lock and a session dir wherever it pointed. One bad hand-edited registry entry must not take
 * every other registration down with it, and a local directory may belong to one id only.
 */

let root: string;
let workspaceRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'ovl-regsafe-'));
  workspaceRoot = path.join(root, 'ws');
  await mkdir(workspaceRoot);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function config(projects: ServerConfig['projects'] = []): ServerConfig {
  return { workspaceRoot, sessionId: 'test', projects };
}

describe('project id validation (W1)', () => {
  it('refuses to register an id that walks out of the workspace', () => {
    const pm = new ProjectManager(config());
    expect(() => pm.registerProject({ id: '../../evil', gitUrl: 'https://git.example/x' })).toThrow(
      /project id/i,
    );
    expect(pm.knownIds()).toEqual([]);
  });

  it('refuses ids that are ".", "..", hidden, separator-bearing or overlong', () => {
    const pm = new ProjectManager(config());
    for (const id of ['.', '..', '.sessions', 'a/b', 'a\\b', '', 'x'.repeat(65), 'paper.']) {
      expect(() => pm.registerProject({ id, gitUrl: 'https://git.example/x' }), id).toThrow(
        /project id/i,
      );
    }
    // The ordinary shapes still register.
    for (const id of ['paper', 'Thesis_2026', 'cvpr-26.v2', '0day']) {
      expect(() => pm.registerProject({ id, gitUrl: 'https://git.example/x' }), id).not.toThrow();
    }
  });

  it('never resolves a clone path outside the workspace, even for an unregistered id', () => {
    const pm = new ProjectManager(config());
    expect(() => pm.projectPath('../outside')).toThrow();
  });

  it('runExclusive creates no lock directory outside .sessions for a traversal id', async () => {
    const pm = new ProjectManager(config());
    await expect(pm.runExclusive('../../escaped', async () => 'ran')).rejects.toThrow();
    // `.sessions/../../escaped` is `<root>/escaped` — nothing may have been created there.
    expect(existsSync(path.join(root, 'escaped'))).toBe(false);
    expect(await readdir(root)).toEqual(['ws']);
  });

  it('sessionPaths refuses a project id or session id that leaves its parent', () => {
    expect(() => sessionStateDir(workspaceRoot, '..')).toThrow();
    expect(() => sessionStateDir(workspaceRoot, '../paper')).toThrow();
    expect(() => sessionDir(workspaceRoot, 'paper', '../other')).toThrow();
    expect(sessionStateDir(workspaceRoot, 'paper')).toBe(
      path.join(workspaceRoot, '.sessions', 'paper'),
    );
  });

  it('a persisted registry entry with an invalid id is skipped, and the rest still load', async () => {
    await writeFile(
      registryPath(workspaceRoot),
      JSON.stringify({
        '../paper': { mode: 'local', path: '/tmp/x' },
        thesis: { gitUrl: 'https://git.example/t', default: true },
      }),
    );
    expect(readProjectRegistry(workspaceRoot).map((p) => p.id)).toEqual(['thesis']);
    expect(readProjectRegistryDefault(workspaceRoot)).toBe('thesis');
  });

  it('an env-configured project with an invalid id is reported and skipped, not fatal', () => {
    const cfg = loadConfig(
      {
        WEB_LATEX_MCP_WORKSPACE: workspaceRoot,
        WEB_LATEX_MCP_PROJECTS: JSON.stringify({
          '../escape': { gitUrl: 'https://git.example/e' },
          paper: { gitUrl: 'https://git.example/p' },
        }),
      },
      root,
      () => false,
      () => [],
      () => undefined,
    );
    expect(cfg.projects.map((p) => p.id)).toEqual(['paper']);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('../escape'));
  });
});

describe('registry file damage (W3)', () => {
  it('one malformed entry no longer hides the valid ones on read', async () => {
    await writeFile(
      registryPath(workspaceRoot),
      JSON.stringify({ cv: { mode: 'local' }, thesis: { gitUrl: 'https://git.example/x' } }),
    );
    expect(readProjectRegistry(workspaceRoot).map((p) => p.id)).toEqual(['thesis']);
  });

  it('upsert keeps every other registration — the malformed one included — verbatim', async () => {
    const original = {
      cv: { mode: 'local' },
      thesis: { gitUrl: 'https://git.example/x', rootFile: 'main.tex' },
    };
    await writeFile(registryPath(workspaceRoot), JSON.stringify(original));
    await new ProjectRegistry(workspaceRoot).upsert({
      id: 'paper',
      gitUrl: 'https://git.example/p',
    });
    const raw = JSON.parse(await readFile(registryPath(workspaceRoot), 'utf8'));
    expect(raw.cv).toEqual(original.cv);
    expect(raw.thesis).toEqual(original.thesis);
    expect(raw.paper).toEqual({ gitUrl: 'https://git.example/p' });
  });

  it('upsert refuses to overwrite a file that is not a JSON object, and leaves it untouched', async () => {
    const text = '{ "thesis": { "gitUrl": "https://git.example/x" }, oops';
    await writeFile(registryPath(workspaceRoot), text);
    await expect(
      new ProjectRegistry(workspaceRoot).upsert({ id: 'paper', gitUrl: 'https://git.example/p' }),
    ).rejects.toThrow(/registry\.json/);
    expect(await readFile(registryPath(workspaceRoot), 'utf8')).toBe(text);
  });

  it('makeDefault still clears the flag on every other entry, malformed ones included', async () => {
    await writeFile(
      registryPath(workspaceRoot),
      JSON.stringify({
        cv: { mode: 'local', default: true },
        thesis: { gitUrl: 'https://git.example/x' },
      }),
    );
    await new ProjectRegistry(workspaceRoot).upsert(
      { id: 'thesis', gitUrl: 'https://git.example/x' },
      { makeDefault: true },
    );
    const raw = JSON.parse(await readFile(registryPath(workspaceRoot), 'utf8'));
    expect(raw.cv).toEqual({ mode: 'local' });
    expect(raw.thesis.default).toBe(true);
  });
});

describe('one local directory, one project (W4)', () => {
  it('refuses a second id for a directory another project already uses', async () => {
    const dir = path.join(root, 'draft');
    await mkdir(dir);
    const pm = new ProjectManager(config([{ id: 'a', mode: 'local', path: dir }]));
    expect(() =>
      pm.registerProject({ id: 'b', mode: 'local', path: dir, followSymlinks: true }),
    ).toThrow(/"a"/);
    // Re-registering the same id at the same directory is an update, not a conflict.
    expect(() =>
      pm.registerProject({ id: 'a', mode: 'local', path: dir, followSymlinks: true }),
    ).not.toThrow();
    expect(pm.followsUserLinks(dir)).toBe(true);
  });

  it('refuses a local project pointed at another project’s clone directory', () => {
    const pm = new ProjectManager(config([{ id: 'paper', gitUrl: 'https://git.example/p' }]));
    expect(() =>
      pm.registerProject({ id: 'notes', mode: 'local', path: path.join(workspaceRoot, 'paper') }),
    ).toThrow(/"paper"/);
  });

  it('follows links only when EVERY project sharing a pre-existing directory says so', async () => {
    const dir = path.join(root, 'draft');
    await mkdir(dir);
    // Two ids already sharing a directory (a hand-edited registry): the first one found no
    // longer decides alone — the policy fails closed.
    const pm = new ProjectManager(
      config([
        { id: 'a', mode: 'local', path: dir },
        { id: 'b', mode: 'local', path: dir, followSymlinks: true },
      ]),
    );
    expect(pm.followsUserLinks(dir)).toBe(false);
    const pm2 = new ProjectManager(
      config([
        { id: 'b', mode: 'local', path: dir, followSymlinks: true },
        { id: 'a', mode: 'local', path: dir },
      ]),
    );
    expect(pm2.followsUserLinks(dir)).toBe(false);
  });
});

describe('credentials in a git URL (W2)', () => {
  it('list_projects reports an env-configured URL with its userinfo redacted', async () => {
    const pm = new ProjectManager(
      config([{ id: 'p', gitUrl: 'https://alice:ghp_SECRET@github.com/me/p.git' }]),
    );
    const [listed] = await pm.listProjects();
    expect(listed!.gitUrl).not.toContain('ghp_SECRET');
    // The login name is not a secret and stays visible; only the password is masked.
    expect(listed!.gitUrl).toBe('https://alice:***@github.com/me/p.git');
  });

  it('registerProject never holds a token-bearing http(s) URL, and leaves ssh forms alone', () => {
    const pm = new ProjectManager(config());
    pm.registerProject({ id: 'p', gitUrl: 'https://alice:ghp_SECRET@github.com/me/p.git' });
    expect(gitUrlOf(pm.getProjectConfig('p'))).toBe('https://alice@github.com/me/p.git');
    pm.registerProject({ id: 's', gitUrl: 'git@github.com:me/s.git' });
    expect(gitUrlOf(pm.getProjectConfig('s'))).toBe('git@github.com:me/s.git');
    pm.registerProject({ id: 't', gitUrl: 'ssh://git@github.com/me/t.git' });
    expect(gitUrlOf(pm.getProjectConfig('t'))).toBe('ssh://git@github.com/me/t.git');
  });
});

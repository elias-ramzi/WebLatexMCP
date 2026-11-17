import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  cloneLineNote,
  isGitCloneLine,
  parseGitCloneLine,
  storedCloneLineRefusal,
} from '../../src/lib/gitCloneLine.js';
import { ProjectManager } from '../../src/services/projectManager.js';
import {
  ProjectRegistry,
  readProjectRegistry,
  registryPath,
} from '../../src/services/projectRegistry.js';
import { gitUrlOf } from '../../src/lib/projectMode.js';

/**
 * A `gitUrl` pasted as Overleaf's whole clone command (`git clone https://git@git.overleaf.com/<id>`)
 * registered as written, and every sync after failed with "protocol 'git clone https' is not
 * supported". Registration now reads the URL out of such a line, and a stored one fails fast.
 */

const TOKEN = 'olp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

describe('parseGitCloneLine', () => {
  it('passes a plain URL through untouched', () => {
    for (const url of [
      'https://git@git.overleaf.com/abc',
      '  https://git.overleaf.com/abc  ',
      'git@github.com:o/r.git',
      'ssh://git@host/x.git',
      'gitclone-is-not-a-command',
      'Git clone https://h/x',
    ]) {
      expect(isGitCloneLine(url)).toBe(false);
      expect(parseGitCloneLine(url)).toEqual({ url, fromCloneLine: false });
    }
    expect(cloneLineNote(parseGitCloneLine('https://h/x'))).toBe('');
  });

  it("takes the URL out of Overleaf's clone line", () => {
    const parsed = parseGitCloneLine('git clone https://git@git.overleaf.com/abc');
    expect(parsed).toEqual({ url: 'https://git@git.overleaf.com/abc', fromCloneLine: true });
    expect(cloneLineNote(parsed)).toMatch(/`git clone` prefix was removed/);
    // Surrounding and inner whitespace (a tab, several spaces) is tolerated.
    expect(parseGitCloneLine('  git\tclone   https://h/x.git \n').url).toBe('https://h/x.git');
  });

  it('accepts and ignores a directory argument, saying so', () => {
    const parsed = parseGitCloneLine('git clone https://git.overleaf.com/abc my-paper');
    expect(parsed.url).toBe('https://git.overleaf.com/abc');
    expect(parsed.ignoredDir).toBe('my-paper');
    expect(cloneLineNote(parsed)).toContain('"my-paper" was ignored');
  });

  it('reads -b / --branch / --branch= as the branch', () => {
    for (const line of [
      'git clone -b main https://git.overleaf.com/abc',
      'git clone --branch main https://git.overleaf.com/abc',
      'git clone --branch=main https://git.overleaf.com/abc paper',
      "git clone https://git.overleaf.com/abc -b 'main'",
    ]) {
      const parsed = parseGitCloneLine(line);
      expect(parsed.url, line).toBe('https://git.overleaf.com/abc');
      expect(parsed.branch, line).toBe('main');
      expect(cloneLineNote(parsed), line).toContain('with its branch "main"');
    }
  });

  it('refuses other options, a missing URL and extra arguments, asking for the URL alone', () => {
    for (const line of [
      'git clone https://git.overleaf.com/abc --depth 1',
      'git clone -b https://git.overleaf.com/abc',
      'git clone -b main -b dev https://git.overleaf.com/abc',
      'git clone --branch= https://git.overleaf.com/abc',
      'git clone',
      'git clone https://h/x dir extra',
    ]) {
      expect(() => parseGitCloneLine(line), line).toThrow(/Pass just the repository URL/);
    }
  });

  it('unwraps one matching pair of quotes or <> around the URL, the dir, or a bare URL', () => {
    expect(parseGitCloneLine("git clone 'https://h/x.git'").url).toBe('https://h/x.git');
    const both = parseGitCloneLine('git clone "https://h/x.git" "paper"');
    expect(both.url).toBe('https://h/x.git');
    expect(both.ignoredDir).toBe('paper');
    expect(parseGitCloneLine('git clone <https://h/x.git>').url).toBe('https://h/x.git');
    expect(parseGitCloneLine('"git clone https://h/x.git"').url).toBe('https://h/x.git');
    expect(parseGitCloneLine("'https://h/x.git'")).toEqual({
      url: 'https://h/x.git',
      fromCloneLine: false,
    });
    expect(parseGitCloneLine('<https://h/x.git>').url).toBe('https://h/x.git');
    // A quote inside a local path is the path's own.
    expect(parseGitCloneLine("/home/o'brien/repo").url).toBe("/home/o'brien/repo");
  });

  it('refuses an unbalanced quote, without echoing a credential', () => {
    for (const value of [
      `git clone 'https://u:${TOKEN}@h/x.git`,
      `git clone https://u:${TOKEN}@h/x.git'`,
      `"https://u:${TOKEN}@h/x.git`,
      `<https://u:${TOKEN}@h/x.git"`,
      "git clone ''",
    ]) {
      let message = '';
      try {
        parseGitCloneLine(value);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message, value).toMatch(/unbalanced quote/);
      expect(message).not.toContain(TOKEN);
    }
  });

  it('never echoes a credential in the refusal', () => {
    let message = '';
    try {
      parseGitCloneLine(`git clone --depth 1 https://${TOKEN}@git.overleaf.com/abc`);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('git clone');
    expect(message).not.toContain(TOKEN);
  });
});

describe('a `git clone` line through ProjectManager.registerProject', () => {
  it('registers the URL with a token in the line stripped, and never persists it', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'ovl-cloneline-'));
    try {
      const registry = new ProjectRegistry(workspaceRoot);
      const pm = new ProjectManager({ workspaceRoot, sessionId: 'test', projects: [] }, registry);
      const held = await pm.registerAndPersist({
        id: 'paper',
        gitUrl: `git clone https://git:${TOKEN}@git.overleaf.com/abc`,
      });
      expect(gitUrlOf(held)).toBe('https://git@git.overleaf.com/abc');
      const onDisk = await readFile(registryPath(workspaceRoot), 'utf8');
      expect(onDisk).not.toContain(TOKEN);
      expect(onDisk).not.toContain('git clone');
      expect(onDisk).toContain('https://git@git.overleaf.com/abc');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('strips a token inside a quoted clone line or a quoted bare URL, persisting none', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'ovl-cloneline-'));
    try {
      const registry = new ProjectRegistry(workspaceRoot);
      const pm = new ProjectManager({ workspaceRoot, sessionId: 'test', projects: [] }, registry);
      const a = await pm.registerAndPersist({
        id: 'a',
        gitUrl: `git clone 'https://user:${TOKEN}@github.com/o/r.git'`,
      });
      expect(gitUrlOf(a)).toBe('https://user@github.com/o/r.git');
      const b = await pm.registerAndPersist({
        id: 'b',
        gitUrl: `"https://user:${TOKEN}@github.com/o/s.git"`,
      });
      expect(gitUrlOf(b)).toBe('https://user@github.com/o/s.git');
      const onDisk = await readFile(registryPath(workspaceRoot), 'utf8');
      expect(onDisk).not.toContain(TOKEN);
      expect(onDisk).not.toContain("'https");
      expect(onDisk).not.toContain('\\"https');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('refuses a line with options and stores nothing', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'ovl-cloneline-'));
    try {
      const registry = new ProjectRegistry(workspaceRoot);
      const pm = new ProjectManager({ workspaceRoot, sessionId: 'test', projects: [] }, registry);
      await expect(
        pm.registerAndPersist({ id: 'paper', gitUrl: 'git clone --depth 1 https://h/x.git' }),
      ).rejects.toThrow(/Pass just the repository URL/);
      await expect(readFile(registryPath(workspaceRoot), 'utf8')).rejects.toThrow();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("registers a line's -b as the branch, and refuses one that disagrees with branch", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'ovl-cloneline-'));
    try {
      const registry = new ProjectRegistry(workspaceRoot);
      const pm = new ProjectManager({ workspaceRoot, sessionId: 'test', projects: [] }, registry);
      await expect(
        pm.registerAndPersist({
          id: 'other',
          gitUrl: 'git clone -b dev https://h/y.git',
          branch: 'main',
        }),
      ).rejects.toThrow(/names branch "dev" but branch is "main"/);
      const held = await pm.registerAndPersist({
        id: 'paper',
        gitUrl: 'git clone -b dev https://h/x.git',
      });
      expect(held).toMatchObject({ gitUrl: 'https://h/x.git', branch: 'dev' });
      const onDisk = JSON.parse(await readFile(registryPath(workspaceRoot), 'utf8')) as Record<
        string,
        { gitUrl: string; branch?: string }
      >;
      expect(onDisk['paper']).toMatchObject({ gitUrl: 'https://h/x.git', branch: 'dev' });
      expect(onDisk['other']).toBeUndefined();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe('a stored `git clone` line', () => {
  it('is read as its URL (and -b as its branch) wherever it was stored', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'ovl-cloneline-'));
    try {
      // Exactly what Overleaf's Git menu shows, stored by hand or by an older version.
      const line = 'git clone https://git@git.overleaf.com/6ac8dba0a9e29a8745293d90';
      const pm = new ProjectManager({
        workspaceRoot,
        sessionId: 'test',
        projects: [
          { id: 'paper', gitUrl: line },
          { id: 'branchy', gitUrl: 'git clone -b dev https://h/x.git' },
        ],
        envProjectIds: [],
      });
      expect(gitUrlOf(pm.requireRemoteGitProject('paper', 'sync with'))).toBe(
        'https://git@git.overleaf.com/6ac8dba0a9e29a8745293d90',
      );
      expect(pm.requireRemoteGitProject('branchy', 'sync with')).toMatchObject({
        gitUrl: 'https://h/x.git',
        branch: 'dev',
      });

      // A registry entry is read the same way, its token stripped as registration strips it,
      // and the file left as written.
      await writeFile(
        registryPath(workspaceRoot),
        JSON.stringify({
          stored: { gitUrl: `git clone https://git:${TOKEN}@git.overleaf.com/abc` },
        }),
      );
      const fromRegistry = readProjectRegistry(workspaceRoot).find((p) => p.id === 'stored');
      expect(fromRegistry && gitUrlOf(fromRegistry)).toBe('https://git@git.overleaf.com/abc');
      expect(await readFile(registryPath(workspaceRoot), 'utf8')).toContain('git clone');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('fails fast at a remote operation when it cannot be read, naming the fix', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'ovl-cloneline-'));
    try {
      const line = `git clone --depth 1 https://git:${TOKEN}@git.overleaf.com/abc`;
      const pm = new ProjectManager({
        workspaceRoot,
        sessionId: 'test',
        projects: [{ id: 'paper', gitUrl: line }],
        envProjectIds: [],
      });
      let message = '';
      try {
        pm.requireRemoteGitProject('paper', 'sync with');
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/is a `git clone` command line/);
      expect(message).toContain('register_project { project: "paper"');
      expect(message).toContain('project_sync { project: "paper"');
      expect(message).not.toContain(TOKEN);
      // Left as it is; and a local-only git tool is not refused for it.
      expect(gitUrlOf(pm.getProjectConfig('paper'))).toBe(line);
      expect(() => pm.requireGitProject('paper', 'commit to')).not.toThrow();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('points an env-configured entry at WEB_LATEX_MCP_PROJECTS', () => {
    expect(
      storedCloneLineRefusal('paper', 'git clone https://h/x.git', { envConfigured: true }),
    ).toMatch(/WEB_LATEX_MCP_PROJECTS/);
  });
});

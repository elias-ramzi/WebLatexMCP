import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitUrlOf } from '../../src/lib/projectMode.js';
import { loadConfig, parseExtraWritingGuide } from '../../src/config.js';
import { COMPILER_KINDS } from '../../src/services/compilerResolver.js';

describe('loadConfig', () => {
  const notInRepo = () => false;
  const inRepo = () => true;

  it('falls back to the home cache when unset and not in a git repo', () => {
    const cfg = loadConfig({}, '/some/dir', notInRepo);
    expect(cfg.workspaceRoot).toBe(path.join(os.homedir(), '.web-latex-mcp', 'projects'));
    expect(cfg.workspaceIsLocal).toBe(false);
    expect(cfg.projects).toEqual([]);
    expect(cfg.defaultProject).toBeUndefined();
  });

  it('defaults to workspace-local when unset and inside a git repo', () => {
    const cfg = loadConfig({}, '/work/paper', inRepo);
    expect(cfg.workspaceRoot).toBe(path.join('/work/paper', '.web_latex_mcp'));
    expect(cfg.workspaceIsLocal).toBe(true);
  });

  it('does not default to workspace-local in the home dir even inside a repo', () => {
    const cfg = loadConfig({}, os.homedir(), inRepo);
    expect(cfg.workspaceRoot).toBe(path.join(os.homedir(), '.web-latex-mcp', 'projects'));
    expect(cfg.workspaceIsLocal).toBe(false);
  });

  it('expands a leading ~ in the workspace root', () => {
    const cfg = loadConfig({ WEB_LATEX_MCP_WORKSPACE: '~/tex-projects' });
    expect(cfg.workspaceRoot).toBe(path.join(os.homedir(), 'tex-projects'));
    expect(cfg.workspaceIsLocal).toBe(false);
  });

  it('clones into the launch dir on the "cwd" sentinel', () => {
    const cfg = loadConfig({ WEB_LATEX_MCP_WORKSPACE: '  CWD ' }, '/work/paper');
    expect(cfg.workspaceRoot).toBe(path.join('/work/paper', '.web_latex_mcp'));
    expect(cfg.workspaceIsLocal).toBe(true);
  });

  it('resolves a relative workspace against the launch dir', () => {
    const cfg = loadConfig({ WEB_LATEX_MCP_WORKSPACE: 'clones' }, '/work/paper');
    expect(cfg.workspaceRoot).toBe(path.resolve('/work/paper', 'clones'));
    expect(cfg.workspaceIsLocal).toBe(false);
  });

  it('parses the projects registry and default project', () => {
    const cfg = loadConfig({
      WEB_LATEX_MCP_PROJECTS: JSON.stringify({
        thesis: { gitUrl: 'https://git.overleaf.com/abc', rootFile: 'main.tex' },
        paper: { gitUrl: 'https://github.com/me/paper', branch: 'main', tokenEnv: 'GITHUB_TOKEN' },
      }),
      WEB_LATEX_MCP_DEFAULT_PROJECT: 'thesis',
    });
    expect(cfg.projects).toHaveLength(2);
    expect(cfg.projects[0]).toMatchObject({
      id: 'thesis',
      gitUrl: 'https://git.overleaf.com/abc',
      rootFile: 'main.tex',
    });
    expect(cfg.projects[1]).toMatchObject({
      id: 'paper',
      gitUrl: 'https://github.com/me/paper',
      branch: 'main',
      tokenEnv: 'GITHUB_TOKEN',
    });
    expect(cfg.defaultProject).toBe('thesis');
  });

  it('throws on invalid projects JSON', () => {
    expect(() => loadConfig({ WEB_LATEX_MCP_PROJECTS: '{not json' })).toThrow(/not valid JSON/);
  });

  it('throws when the default project is not in the registry', () => {
    expect(() => loadConfig({ WEB_LATEX_MCP_DEFAULT_PROJECT: 'ghost' })).toThrow(/not present/);
  });

  it('merges persisted projects, with env projects winning on a shared id', () => {
    const persisted = () => [
      { id: 'thesis', gitUrl: 'https://git.overleaf.com/persisted' },
      { id: 'notes', gitUrl: 'https://git.overleaf.com/notes' },
    ];
    const cfg = loadConfig(
      {
        WEB_LATEX_MCP_PROJECTS: JSON.stringify({
          thesis: { gitUrl: 'https://git.overleaf.com/env' },
        }),
      },
      '/some/dir',
      () => false,
      persisted,
    );
    const byId = Object.fromEntries(cfg.projects.map((p) => [p.id, gitUrlOf(p)]));
    expect(byId).toEqual({
      thesis: 'https://git.overleaf.com/env', // env wins
      notes: 'https://git.overleaf.com/notes', // persisted-only survives
    });
  });

  it('accepts a default project that only exists in the persisted registry', () => {
    const persisted = () => [{ id: 'thesis', gitUrl: 'https://git.overleaf.com/persisted' }];
    const cfg = loadConfig(
      { WEB_LATEX_MCP_DEFAULT_PROJECT: 'thesis' },
      '/some/dir',
      () => false,
      persisted,
    );
    expect(cfg.defaultProject).toBe('thesis');
  });

  it('defaults the compiler to latexmk', () => {
    expect(loadConfig({}).compiler).toBe('latexmk');
  });

  it('selects the tectonic compiler (case-insensitively)', () => {
    expect(loadConfig({ WEB_LATEX_MCP_COMPILER: 'tectonic' }).compiler).toBe('tectonic');
    expect(loadConfig({ WEB_LATEX_MCP_COMPILER: '  TECTONIC ' }).compiler).toBe('tectonic');
  });

  it('throws on an unknown compiler', () => {
    expect(() => loadConfig({ WEB_LATEX_MCP_COMPILER: 'pdflatex' })).toThrow(
      /WEB_LATEX_MCP_COMPILER/,
    );
    expect(() => loadConfig({ WEB_LATEX_MCP_COMPILER: 'pdflatex' })).toThrow(
      'WEB_LATEX_MCP_COMPILER "pdflatex" is invalid; expected one of: latexmk, tectonic.',
    );
  });

  it('accepts exactly the backends the fallback knows how to try', () => {
    // One list, not two: validating against a private copy lets loadConfig accept a kind the
    // resolver's fallback loop never iterates (or reject one it does).
    for (const kind of COMPILER_KINDS) {
      expect(loadConfig({ WEB_LATEX_MCP_COMPILER: kind }).compiler).toBe(kind);
    }
  });

  it('does not call an unset compiler var a choice', () => {
    expect(loadConfig({}).compilerExplicit).toBe(false);
  });

  it('records a named compiler as an explicit choice', () => {
    expect(loadConfig({ WEB_LATEX_MCP_COMPILER: 'tectonic' }).compilerExplicit).toBe(true);
  });

  it('treats explicitly naming the default as a choice, not a default', () => {
    // The case a naive `compiler !== 'latexmk'` test gets wrong: naming latexmk outright is an
    // assertion, and must suppress any fallback to whichever backend happens to be installed.
    const cfg = loadConfig({ WEB_LATEX_MCP_COMPILER: 'LATEXMK' });
    expect(cfg.compiler).toBe('latexmk');
    expect(cfg.compilerExplicit).toBe(true);
  });

  it('treats a whitespace-only compiler var as no choice at all', () => {
    // Both answers come from one emptiness rule, so they can never disagree about one input.
    const cfg = loadConfig({ WEB_LATEX_MCP_COMPILER: '   ' });
    expect(cfg.compiler).toBe('latexmk');
    expect(cfg.compilerExplicit).toBe(false);
  });

  it('treats an empty compiler var as no choice at all', () => {
    const cfg = loadConfig({ WEB_LATEX_MCP_COMPILER: '' });
    expect(cfg.compiler).toBe('latexmk');
    expect(cfg.compilerExplicit).toBe(false);
  });

  it('parses the viewer target (default undefined = browser)', () => {
    expect(loadConfig({}).viewerTarget).toBeUndefined();
    expect(loadConfig({ WEB_LATEX_MCP_VIEWER_TARGET: 'vscode' }).viewerTarget).toBe('vscode');
    expect(loadConfig({ WEB_LATEX_MCP_VIEWER_TARGET: '  Browser ' }).viewerTarget).toBe('browser');
  });

  it('throws on an invalid viewer target', () => {
    expect(() => loadConfig({ WEB_LATEX_MCP_VIEWER_TARGET: 'terminal' })).toThrow(
      /WEB_LATEX_MCP_VIEWER_TARGET/,
    );
  });

  it('accepts a local project from the environment, resolving ~ and relative paths', () => {
    const cfg = loadConfig(
      {
        WEB_LATEX_MCP_PROJECTS: JSON.stringify({
          cv: { mode: 'local', path: '~/docs/cv' },
          notes: { mode: 'local', path: 'papers/notes' },
          thesis: { gitUrl: 'https://git.overleaf.com/abc' },
        }),
      },
      '/work',
      notInRepo,
    );

    const byId = Object.fromEntries(cfg.projects.map((p) => [p.id, p]));
    expect(byId.cv).toEqual({
      id: 'cv',
      mode: 'local',
      path: path.join(os.homedir(), 'docs', 'cv'),
    });
    // Relative paths resolve against the launch dir, like WEB_LATEX_MCP_WORKSPACE does.
    expect(byId.notes).toMatchObject({ path: path.resolve('/work', 'papers/notes') });
    expect(gitUrlOf(byId.thesis!)).toBe('https://git.overleaf.com/abc');
  });

  it('carries a local project’s followSymlinks through from the environment', () => {
    // The one way to say "the links in this directory are mine" — so it has to survive parsing,
    // or the guard silently refuses the layout the user configured for.
    const cfg = loadConfig(
      {
        WEB_LATEX_MCP_PROJECTS: JSON.stringify({
          cv: { mode: 'local', path: '/work/cv', followSymlinks: true },
          notes: { mode: 'local', path: '/work/notes' },
        }),
      },
      '/work',
      notInRepo,
    );

    const byId = Object.fromEntries(cfg.projects.map((p) => [p.id, p]));
    expect(byId.cv).toMatchObject({ mode: 'local', followSymlinks: true });
    expect(byId.notes).not.toHaveProperty('followSymlinks');
  });

  it('rejects a project entry that is neither a remote nor a path', () => {
    expect(() =>
      loadConfig({ WEB_LATEX_MCP_PROJECTS: JSON.stringify({ cv: { rootFile: 'cv.tex' } }) }),
    ).toThrow(/invalid/);
  });
});

describe('parseExtraWritingGuide', () => {
  const cwd = '/work/paper';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves a plain absolute path', () => {
    const result = parseExtraWritingGuide('/etc/conventions.md', cwd);
    expect(result).toEqual({ path: '/etc/conventions.md' });
  });

  it('resolves a relative path against cwd', () => {
    const result = parseExtraWritingGuide('conventions.md', cwd);
    expect(result).toEqual({ path: path.join(cwd, 'conventions.md') });
  });

  it('expands a leading ~', () => {
    const result = parseExtraWritingGuide('~/conventions.md', cwd);
    expect(result).toEqual({
      path: path.join(os.homedir(), 'conventions.md'),
    });
  });

  it('accepts a file:// URL and resolves to the same path as the plain-path case', () => {
    const url = pathToFileURL('/etc/conventions.md').toString();
    const result = parseExtraWritingGuide(url, cwd);
    expect(result).toEqual({ path: '/etc/conventions.md' });
  });

  it('is unset when nothing was named', () => {
    expect(parseExtraWritingGuide(undefined, cwd)).toEqual({});
  });

  it('treats a whitespace-only value identically to unset', () => {
    expect(parseExtraWritingGuide('   ', cwd)).toEqual({});
  });

  it('does not throw on an invalid file:// URL, logs to stderr naming both spellings, and returns unset', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = parseExtraWritingGuide('file://%', cwd);
    expect(result).toEqual({});
    expect(spy).toHaveBeenCalled();
    const message = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(message).toContain('WEB_LATEX_MCP_WRITING_GUIDE_EXTRA');
    expect(message).toContain('file://%');
    expect(message).toContain('file:///path/to/conventions.md');
    expect(message).toContain('/path/to/conventions.md');
  });

  it('rejects a bare "file:conventions.md" (no authority) rather than writing to the filesystem root', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = parseExtraWritingGuide('file:conventions.md', cwd);
    expect(result).toEqual({});
    // Must NOT fall through to the plain-path branch and become <cwd>/file:conventions.md.
    expect(result.path).not.toBe(path.join(cwd, 'file:conventions.md'));
    expect(spy).toHaveBeenCalled();
  });

  it('rejects a bare "file:" (yields the filesystem root) rather than resolving to "/"', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = parseExtraWritingGuide('file:', cwd);
    expect(result).toEqual({});
    expect(result.path).not.toBe('/');
    expect(spy).toHaveBeenCalled();
  });

  it('rejects "file:/single-slash" rather than resolving it to a filesystem root path', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = parseExtraWritingGuide('file:/single-slash', cwd);
    expect(result).toEqual({});
    expect(spy).toHaveBeenCalled();
  });

  it('never returns a non-absolute path from a file:// value', () => {
    // Defense in depth: even if a future URL form parses "successfully", the result must be
    // absolute or it is rejected the same way.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = parseExtraWritingGuide('file://', cwd);
    if (result.path !== undefined) {
      expect(path.isAbsolute(result.path)).toBe(true);
    } else {
      expect(spy).toHaveBeenCalled();
    }
  });
});

describe('loadConfig with a malformed WEB_LATEX_MCP_WRITING_GUIDE_EXTRA', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not throw (a bad optional overlay must not take the whole server down)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      loadConfig({ WEB_LATEX_MCP_WRITING_GUIDE_EXTRA: 'file:conventions.md' }, '/work/paper'),
    ).not.toThrow();
    expect(spy).toHaveBeenCalled();
  });

  it('leaves extraWritingGuidePath undefined, same as unset', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cfg = loadConfig(
      { WEB_LATEX_MCP_WRITING_GUIDE_EXTRA: 'file:conventions.md' },
      '/work/paper',
    );
    expect(cfg.extraWritingGuidePath).toBeUndefined();
  });
});

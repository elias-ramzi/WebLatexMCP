import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { gitUrlOf } from '../../src/lib/projectMode.js';
import { loadConfig, parseExtraWritingGuide } from '../../src/config.js';
import { COMPILER_KINDS } from '../../src/services/compilerResolver.js';
import { registryPath } from '../../src/services/projectRegistry.js';

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

  it('throws when the default project is not a known project, naming both sources', () => {
    expect(() => loadConfig({ WEB_LATEX_MCP_DEFAULT_PROJECT: 'ghost' })).toThrow(
      /WEB_LATEX_MCP_DEFAULT_PROJECT "ghost" is not a known project/,
    );
    expect(() => loadConfig({ WEB_LATEX_MCP_DEFAULT_PROJECT: 'ghost' })).toThrow(
      /WEB_LATEX_MCP_PROJECTS and the workspace registry/,
    );
    expect(() => loadConfig({ WEB_LATEX_MCP_DEFAULT_PROJECT: 'ghost' })).toThrow(/\(none\)/);
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
    // (d) from the issue-60 task: an env default naming a registry-only project — this passed
    // before the fix too (loadConfig already validated against the env+registry merge), so it's
    // kept here as a regression guard rather than reported as new coverage.
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

describe('loadConfig defaultProject via an injected readRegistryDefault (hermetic)', () => {
  // Exercises the 5th `readRegistryDefault` parameter directly — no file on disk, so these never
  // risk picking up a real developer workspace's registry.json (unlike writing one to a temp dir,
  // which still exercises the *real* production code path end to end; see the "(real file)" test
  // below for that). Before the fix this parameter didn't exist: `loadConfig` always called the
  // real `readProjectRegistryDefault` unconditionally, so these calls either failed to typecheck
  // (an unknown 5th argument) or, if merely ignored at runtime, exercised the wrong (real) reader
  // — that is the "failed before" this block reports.

  it('uses an injected persisted default when WEB_LATEX_MCP_DEFAULT_PROJECT is unset', () => {
    const cfg = loadConfig(
      {},
      '/some/dir',
      () => false,
      () => [{ id: 'thesis', gitUrl: 'https://git.overleaf.com/abc' }],
      () => 'thesis',
    );
    expect(cfg.defaultProject).toBe('thesis');
    expect(cfg.defaultProjectExplicit).toBe(false);
  });

  it('an explicit env default wins over an injected persisted default', () => {
    const cfg = loadConfig(
      { WEB_LATEX_MCP_DEFAULT_PROJECT: 'paper' },
      '/some/dir',
      () => false,
      () => [
        { id: 'thesis', gitUrl: 'https://git.overleaf.com/abc' },
        { id: 'paper', gitUrl: 'https://git.overleaf.com/def' },
      ],
      () => 'thesis',
    );
    expect(cfg.defaultProject).toBe('paper');
    expect(cfg.defaultProjectExplicit).toBe(true);
  });

  it('ignores an injected default naming a project id outside the merged project list, with a stderr warning', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cfg = loadConfig(
      {},
      '/some/dir',
      () => false,
      () => [], // merged project list does not include "ghost"
      () => 'ghost',
    );
    expect(cfg.defaultProject).toBeUndefined();
    expect(cfg.defaultProjectExplicit).toBe(false);
    expect(spy).toHaveBeenCalled();
    const message = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(message).toContain('ghost');
  });
});

describe('loadConfig defaultProject from a persisted registry.json on disk', () => {
  // Unlike the hermetic block above, this one (real file) goes through the REAL
  // readProjectRegistry/readProjectRegistryDefault (only `insideRepo` is stubbed) against a temp
  // workspace root — proving the on-disk `"default": true` flag `register_project` writes is
  // actually read end to end. Kept to exactly one test so the default (real) readers are only
  // exercised where a test explicitly asks for the real filesystem, never incidentally.
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'ovl-cfg-default-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  async function writeRegistry(map: Record<string, unknown>): Promise<void> {
    await writeFile(registryPath(workspaceRoot), JSON.stringify(map), 'utf8');
  }

  it('(real file) a registry-persisted default is used when WEB_LATEX_MCP_DEFAULT_PROJECT is unset', async () => {
    await writeRegistry({ thesis: { gitUrl: 'https://git.overleaf.com/abc', default: true } });
    const cfg = loadConfig({ WEB_LATEX_MCP_WORKSPACE: workspaceRoot }, '/some/dir', () => false);
    expect(cfg.defaultProject).toBe('thesis');
    expect(cfg.defaultProjectExplicit).toBe(false);
  });
});

describe('parseExtraWritingGuide', () => {
  // Absolute paths are platform-shaped: on Windows `/work/paper` resolves onto the current
  // drive, so the expectations are built from `path.resolve` rather than POSIX literals.
  const cwd = path.resolve('/work/paper');
  const absoluteGuide = path.resolve('/etc/conventions.md');

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves a plain absolute path', () => {
    const result = parseExtraWritingGuide(absoluteGuide, cwd);
    expect(result).toEqual({ path: absoluteGuide });
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
    const url = pathToFileURL(absoluteGuide).toString();
    const result = parseExtraWritingGuide(url, cwd);
    expect(result).toEqual({ path: absoluteGuide });
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

  it('rejects "file://" (resolves to the filesystem root) rather than returning the root', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = parseExtraWritingGuide('file://', cwd);
    expect(result).toEqual({});
    expect(spy).toHaveBeenCalled();
  });

  it('rejects "file:///" (resolves to the filesystem root) rather than returning the root', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = parseExtraWritingGuide('file:///', cwd);
    expect(result).toEqual({});
    expect(spy).toHaveBeenCalled();
  });

  it('rejects a bare filesystem root on the plain-path branch rather than returning it', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = path.parse(path.resolve('/')).root;
    const result = parseExtraWritingGuide(root, cwd);
    expect(result).toEqual({});
    expect(spy).toHaveBeenCalled();
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

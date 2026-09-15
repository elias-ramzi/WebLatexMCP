import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { gitUrlOf } from '../../src/lib/projectMode.js';
import {
  loadConfig,
  parseRewriteMode,
  parseExtraWritingGuide,
  parseReferenceSource,
  parseContactEmail,
} from '../../src/config.js';
import { COMPILER_KINDS } from '../../src/services/compilerResolver.js';
import { registryPath } from '../../src/services/projectRegistry.js';
import { REWRITE_MODES, DEFAULT_REWRITE_MODE } from '../../src/lib/rewriteMode.js';
import { REFERENCE_SOURCES } from '../../src/lib/referenceKey.js';

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

describe('parseRewriteMode', () => {
  const notInRepo = () => false;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults when unset, empty, or whitespace-only', () => {
    expect(parseRewriteMode(undefined)).toEqual({ mode: DEFAULT_REWRITE_MODE, explicit: false });
    expect(parseRewriteMode('')).toEqual({ mode: DEFAULT_REWRITE_MODE, explicit: false });
    expect(parseRewriteMode('   ')).toEqual({ mode: DEFAULT_REWRITE_MODE, explicit: false });
  });

  it('accepts a valid mode, case-insensitively and trimmed', () => {
    for (const mode of REWRITE_MODES) {
      expect(parseRewriteMode(mode)).toEqual({ mode, explicit: true });
      expect(parseRewriteMode(`  ${mode.toUpperCase()}  `)).toEqual({ mode, explicit: true });
    }
  });

  it('falls back to the default (never throws) on a garbage value, and logs the rejection', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A rejected value falls back *and* stays unchosen: naming the default a configuration the
    // user made is how `list_projects` came to label every default install "(env default)".
    expect(parseRewriteMode('sometimes')).toEqual({ mode: DEFAULT_REWRITE_MODE, explicit: false });
    expect(spy).toHaveBeenCalledTimes(1);
    const message = spy.mock.calls[0]?.[0] as string;
    expect(message).toContain('sometimes');
    for (const mode of REWRITE_MODES) {
      expect(message).toContain(mode);
    }
  });

  it('wires the env default into loadConfig as rewriteMode', () => {
    expect(loadConfig({}, '/some/dir', notInRepo).rewriteMode).toBe(DEFAULT_REWRITE_MODE);
    expect(
      loadConfig({ WEB_LATEX_MCP_REWRITE_MODE: 'always' }, '/some/dir', notInRepo).rewriteMode,
    ).toBe('always');

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      loadConfig({ WEB_LATEX_MCP_REWRITE_MODE: 'bogus' }, '/some/dir', notInRepo).rewriteMode,
    ).toBe(DEFAULT_REWRITE_MODE);
    expect(spy).toHaveBeenCalledTimes(1);
    const message = spy.mock.calls[0]?.[0] as string;
    expect(message).toContain('bogus');
  });

  it('wires rewriteModeExplicit into loadConfig too, distinguishing a configured default from the built-in one', () => {
    // rewriteMode is populated the same way whether or not the user set anything — only
    // rewriteModeExplicit tells `list_projects` (envConfigured) apart from a plain default
    // install, so it has to be asserted on its own, not inferred from rewriteMode alone.
    expect(loadConfig({}, '/some/dir', notInRepo).rewriteModeExplicit).toBe(false);

    // A rejected value is not a choice: even though the invalid input falls back to the same
    // mode as unset, it must NOT be reported as explicit — this is the case a hardcoded
    // `rewriteModeExplicit: true` in loadConfig would sail through undetected.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      loadConfig({ WEB_LATEX_MCP_REWRITE_MODE: 'bogus' }, '/some/dir', notInRepo)
        .rewriteModeExplicit,
    ).toBe(false);
    spy.mockRestore();

    expect(
      loadConfig({ WEB_LATEX_MCP_REWRITE_MODE: 'always' }, '/some/dir', notInRepo)
        .rewriteModeExplicit,
    ).toBe(true);
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

describe('parseReferenceSource', () => {
  it('is unset (not a default id) when unset, empty, or whitespace-only', () => {
    // Unlike parseCompilerChoice, unset must stay undefined: the resolver owns fallback
    // order across the three backends, so config must not name a winner.
    expect(parseReferenceSource(undefined)).toEqual({ source: undefined, explicit: false });
    expect(parseReferenceSource('')).toEqual({ source: undefined, explicit: false });
    expect(parseReferenceSource('   ')).toEqual({ source: undefined, explicit: false });
  });

  it('accepts each valid id, case-insensitively and trimmed', () => {
    for (const id of REFERENCE_SOURCES) {
      expect(parseReferenceSource(id)).toEqual({ source: id, explicit: true });
    }
    expect(parseReferenceSource('  DBLP  ')).toEqual({ source: 'dblp', explicit: true });
  });

  it('throws on an invalid value, naming the variable and every valid id', () => {
    expect(() => parseReferenceSource('scopus')).toThrow(/WEB_LATEX_MCP_REFERENCE_SOURCE/);
    expect(() => parseReferenceSource('scopus')).toThrow(
      'WEB_LATEX_MCP_REFERENCE_SOURCE "scopus" is invalid; expected one of: dblp, crossref, openalex.',
    );
  });

  it('wires into loadConfig as referenceSource/referenceSourceExplicit', () => {
    expect(loadConfig({}).referenceSource).toBeUndefined();
    expect(loadConfig({}).referenceSourceExplicit).toBe(false);

    const cfg = loadConfig({ WEB_LATEX_MCP_REFERENCE_SOURCE: 'crossref' });
    expect(cfg.referenceSource).toBe('crossref');
    expect(cfg.referenceSourceExplicit).toBe(true);
  });

  it('propagates the throw through loadConfig on an invalid value', () => {
    expect(() => loadConfig({ WEB_LATEX_MCP_REFERENCE_SOURCE: 'scopus' })).toThrow(
      /WEB_LATEX_MCP_REFERENCE_SOURCE/,
    );
  });
});

describe('parseContactEmail', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is undefined when unset, empty, or whitespace-only', () => {
    expect(parseContactEmail(undefined)).toBeUndefined();
    expect(parseContactEmail('')).toBeUndefined();
    expect(parseContactEmail('   ')).toBeUndefined();
  });

  it('round-trips a good address, trimmed', () => {
    expect(parseContactEmail('  me@example.com  ')).toBe('me@example.com');
  });

  it.each([
    'not-an-email',
    'a@b', // no dot in the domain
    '@b.com', // empty local part
    'a@', // empty domain
    'a b@c.com', // whitespace
    'a@b.com&foo=1', // query-altering character
    'a@b.com/x', // query-altering character
    'a@b.com\npad', // newline
    'a@b@c.com', // two @
  ])('rejects %j without throwing, returning undefined', (bad) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => parseContactEmail(bad)).not.toThrow();
    expect(parseContactEmail(bad)).toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });

  it('logs the rejection to stderr, never stdout (stdout is the JSON-RPC channel)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(parseContactEmail('not-an-email')).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    const message = errorSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain('WEB_LATEX_MCP_CONTACT_EMAIL');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('wires into loadConfig as contactEmail', () => {
    expect(loadConfig({}).contactEmail).toBeUndefined();
    expect(loadConfig({ WEB_LATEX_MCP_CONTACT_EMAIL: 'me@example.com' }).contactEmail).toBe(
      'me@example.com',
    );
  });

  it('never derives a contact email from another address the server already knows', () => {
    // A privacy boundary, and the plausible regression is not "invent an address" — it is
    // "reuse one we already have". The server is configured with a commit-author address; that
    // must NOT become the address sent to Crossref and OpenAlex. Asserting only that an empty
    // env yields undefined pins nothing: there is no code path for it to disable.
    const withAuthor = loadConfig(
      {
        WEB_LATEX_MCP_AUTHOR_EMAIL: 'elias@example.com',
        WEB_LATEX_MCP_AUTHOR_NAME: 'Elias',
      },
      '/some/dir',
      () => true,
    );
    expect(withAuthor.contactEmail).toBeUndefined();

    // And it IS populated when — and only when — its own variable is set.
    const withContact = loadConfig(
      { WEB_LATEX_MCP_CONTACT_EMAIL: 'me@example.com' },
      '/some/dir',
      () => true,
    );
    expect(withContact.contactEmail).toBe('me@example.com');
  });
});

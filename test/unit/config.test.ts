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
import {
  projectLockPath,
  rewriteModePath,
  sessionDir,
  sessionStateDir,
} from '../../src/lib/sessionPaths.js';
import { ShelfStore } from '../../src/services/shelfStore.js';

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is unset (not a default id) when unset, empty, or whitespace-only', () => {
    // Unlike parseCompilerChoice, unset must stay undefined: the resolver owns fallback
    // order across the three backends, so config must not name a winner.
    const unset = { source: undefined, explicit: false, invalid: undefined };
    expect(parseReferenceSource(undefined)).toEqual(unset);
    expect(parseReferenceSource('')).toEqual(unset);
    expect(parseReferenceSource('   ')).toEqual(unset);
  });

  it('accepts each valid id, case-insensitively and trimmed', () => {
    for (const id of REFERENCE_SOURCES) {
      expect(parseReferenceSource(id)).toEqual({ source: id, explicit: true, invalid: undefined });
    }
    expect(parseReferenceSource('  DBLP  ')).toEqual({
      source: 'dblp',
      explicit: true,
      invalid: undefined,
    });
  });

  it('does NOT throw on an invalid value: it reports it as `invalid` and logs to stderr', () => {
    // The blast radius of this setting is search_references and nothing else, so a typo must
    // not take down read_file/compile/commit/push with it. `explicit` stays false: a rejected
    // value is not a choice, so nothing downstream may describe it as one.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(parseReferenceSource('scopus')).toEqual({
      source: undefined,
      explicit: false,
      invalid: 'scopus',
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0]?.[0]);
    // Exactly what the thrown message said, so nothing is lost by not throwing.
    expect(line).toContain(
      'WEB_LATEX_MCP_REFERENCE_SOURCE "scopus" is invalid; expected one of: dblp, crossref, openalex.',
    );
    // And it must say the failure is scoped, or the line reads like the old fatal one.
    expect(line).toMatch(/search_references/);
    // stdout is the JSON-RPC channel: a config warning there corrupts the protocol stream.
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('keeps the rejected value verbatim (trimmed, original case) so a refusal can name it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseReferenceSource('  Crossreff  ').invalid).toBe('Crossreff');
  });

  it('elides an over-long rejected value rather than carrying kilobytes into every refusal', () => {
    // A pasted multi-kilobyte env var reaches a stderr line, the tool refusal AND server_info.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const huge = 'z'.repeat(5000);

    const out = parseReferenceSource(huge);
    expect(out.invalid).not.toBe(huge);
    expect(out.invalid!.length).toBeLessThan(200);
    expect(out.invalid).toMatch(/\(5000 characters\)$/);
    expect(String(errorSpy.mock.calls[0]?.[0]).length).toBeLessThan(600);
  });

  it('wires into loadConfig as referenceSource/referenceSourceExplicit', () => {
    expect(loadConfig({}).referenceSource).toBeUndefined();
    expect(loadConfig({}).referenceSourceExplicit).toBe(false);

    const cfg = loadConfig({ WEB_LATEX_MCP_REFERENCE_SOURCE: 'crossref' });
    expect(cfg.referenceSource).toBe('crossref');
    expect(cfg.referenceSourceExplicit).toBe(true);
  });

  it('wires an invalid value through loadConfig as referenceSourceInvalid, and starts', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cfg = loadConfig({ WEB_LATEX_MCP_REFERENCE_SOURCE: 'scopus' });

    expect(cfg.referenceSourceInvalid).toBe('scopus');
    expect(cfg.referenceSource).toBeUndefined();
    // `referenceSourceExplicit` stays the sole licence for a substitution, and a rejected value
    // is not an assertion — otherwise a typo would pin the resolver to an undefined backend.
    expect(cfg.referenceSourceExplicit).toBe(false);
    // The rest of the server is untouched: this is the whole point of not throwing.
    expect(cfg.compiler).toBe('latexmk');
    expect(cfg.workspaceRoot).toBeTruthy();
  });

  it('leaves referenceSourceInvalid absent for a valid or unset value', () => {
    expect(loadConfig({}).referenceSourceInvalid).toBeUndefined();
    expect(
      loadConfig({ WEB_LATEX_MCP_REFERENCE_SOURCE: 'openalex' }).referenceSourceInvalid,
    ).toBeUndefined();
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
    // Non-ASCII: the address goes into the User-Agent header, and fetch's ByteString check
    // throws before any I/O on a code point above 255 — so every Crossref/OpenAlex request
    // became "could not be reached" while server_info said a contact email was configured.
    '用户@例子.广告',
    // Latin-1 passes that check but is still not ASCII, which a header value has to be to be
    // read the same way by every front. Refused on the same rule rather than a narrower one.
    'josé@example.com',
    // Characters that would break out of the `( ...; mailto:<email>)` User-Agent comment.
    'a(b@c.com',
    'a)b@c.com',
    'a;b@c.com',
    'a\\b@c.com',
  ])('rejects %j without throwing, returning undefined', (bad) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => parseContactEmail(bad)).not.toThrow();
    expect(parseContactEmail(bad)).toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });

  it('accepts only addresses that survive as a User-Agent header value', () => {
    // The property the rejection list above approximates: whatever parseContactEmail lets
    // through is interpolated into a header, and a header that cannot be built fails every
    // request to the backend with a misleading "could not be reached".
    for (const candidate of [
      'me@example.com',
      'first.last+tag@sub.example.org',
      '用户@例子.广告',
    ]) {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const email = parseContactEmail(candidate);
      if (email === undefined) continue;
      expect(
        () => new Headers({ 'User-Agent': `web-latex-mcp/0 (+https://x.test; mailto:${email})` }),
      ).not.toThrow();
    }
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

  it('caps the length at 254 characters (RFC 5321), rejecting one character over', () => {
    // An oversized value is interpolated into a User-Agent header and a `mailto=` query
    // parameter; some fronts answer that with 431, which surfaces as "Crossref could not be
    // reached" with nothing pointing at the env var that caused it. Boundary on both sides.
    const address = (total: number) => `${'a'.repeat(total - '@example.com'.length)}@example.com`;
    const ok = address(254);
    const tooLong = address(255);
    expect(ok).toHaveLength(254);
    expect(tooLong).toHaveLength(255);

    expect(parseContactEmail(ok)).toBe(ok);
    // The cap is measured against the TRIMMED value, like every other check here.
    expect(parseContactEmail(`   ${ok}   `)).toBe(ok);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // A malformed value stays a convenience failure, never a correctness one: no throw.
    expect(() => parseContactEmail(tooLong)).not.toThrow();
    expect(parseContactEmail(tooLong)).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    const message = errorSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain('WEB_LATEX_MCP_CONTACT_EMAIL');
    // The rejected value is echoed elided, not dumped: "too long" is the one rejection reason
    // whose value has no bound, and a multi-kilobyte log line is the same problem again.
    expect(message).not.toContain(tooLong);
    expect(message).toContain('254');
    // stdout is the JSON-RPC channel.
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

describe('a rejected WEB_LATEX_MCP_CONTACT_EMAIL is remembered, never confused with unset', () => {
  // `parseContactEmail` already drops a malformed value and logs one stderr line. What that
  // leaves behind is byte-identical to a default install: `contactEmailConfigured: false` and
  // no polite-pool clause anywhere. `contactEmailInvalid` is what tells the two apart — the
  // same silent-failure doctrine as `referenceSourceInvalid` and `extraWritingGuideLoaded`.
  const rejected = 'someone.private@localhost'; // no dot in the domain, so not usable

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets contactEmailInvalid when the value is set but not a usable address', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cfg = loadConfig({ WEB_LATEX_MCP_CONTACT_EMAIL: rejected }, '/some/dir', () => true);

    expect(cfg.contactEmailInvalid).toBe(true);
    // The flag REPORTS that the polite pool is off; it must never switch it back on.
    expect(cfg.contactEmail).toBeUndefined();
    // And the rest of the server is untouched, as for every other malformed optional setting.
    expect(cfg.compiler).toBe('latexmk');
  });

  it('remembers only the boolean — the rejected address is personal data, and is dropped', () => {
    // Deliberately unlike `referenceSourceInvalid`, which keeps the user's own typo of a
    // backend id. An address identifies a person, and config is copied into server_info.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cfg = loadConfig({ WEB_LATEX_MCP_CONTACT_EMAIL: rejected }, '/some/dir', () => true);

    expect(cfg.contactEmailInvalid).toBe(true);
    expect(JSON.stringify(cfg)).not.toContain(rejected);
    // Not only the whole address: a local part alone still identifies the user.
    expect(JSON.stringify(cfg)).not.toContain('someone.private');
  });

  it('leaves contactEmailInvalid unset for a usable address and for none at all', () => {
    // CONTROL: passes before and after this change. It pins the shape — the flag is set only
    // when a value was actually rejected, so an implementation reporting `false` for every
    // healthy install (which would make the field meaningless in `server_info`) fails here.
    const ok = loadConfig(
      { WEB_LATEX_MCP_CONTACT_EMAIL: 'me@example.com' },
      '/some/dir',
      () => true,
    );
    expect(ok.contactEmail).toBe('me@example.com');
    expect(ok.contactEmailInvalid).toBeUndefined();

    const none = loadConfig({}, '/some/dir', () => true);
    expect(none.contactEmail).toBeUndefined();
    expect(none.contactEmailInvalid).toBeUndefined();
  });

  it('keeps parseContactEmail returning the address itself, for its existing callers', () => {
    // CONTROL: passes before and after. The exported signature is load-bearing for the unit
    // tests above and for anything else reading the address; surfacing the new flag must not
    // change it into an object.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseContactEmail('me@example.com')).toBe('me@example.com');
    expect(parseContactEmail(rejected)).toBeUndefined();
  });
});

describe('WEB_LATEX_MCP_SESSION never names a directory the project state dir already uses', () => {
  // A session's state lives at `<workspace>/.sessions/<project>/<sessionId>/`, beside the
  // project-wide entries in that same directory. A session id equal to one of those names put
  // its session.json/shadow/base INSIDE the shelf store (or onto the lock / rewrite-mode file).
  // The reserved names are read off the real layout, not restated, so a new entry that forgets
  // to reserve itself is caught by the `.every` guard at the bottom of this list rather than
  // silently colliding.
  const ws = path.join(os.tmpdir(), 'ws');
  const stateDir = sessionStateDir(ws, 'p');
  const projectLevel = [
    new ShelfStore(ws, 'any').shelvesDir('p'),
    projectLockPath(ws, 'p'),
    rewriteModePath(ws, 'p'),
  ];
  const reserved = projectLevel.map((entry) => path.basename(entry));

  it('reads every reserved name off an entry directly under the project state dir', () => {
    expect(projectLevel.every((entry) => path.dirname(entry) === stateDir)).toBe(true);
    expect(reserved).toEqual(['shelves', 'project.lock', 'rewrite-mode.json']);
  });

  it.each(reserved)('refuses a session id of %j, which would collide', (name) => {
    // The collision is real, not hypothetical: the session dir IS the project-level entry.
    expect(sessionDir(ws, 'p', name)).toBe(path.join(stateDir, name));
    expect(() => loadConfig({ WEB_LATEX_MCP_SESSION: name })).toThrow(/WEB_LATEX_MCP_SESSION/);
  });

  it.each(['  shelves  ', '-shelves-', 'SHELVES', 'Project.Lock'])(
    'judges the SANITISED id, case-folded, so %j is refused too',
    (raw) => {
      // Sanitising strips edge punctuation, and a case-insensitive disk (macOS, Windows) makes
      // `Shelves/` the same directory as `shelves/`; refusing everywhere keeps it portable.
      expect(() => loadConfig({ WEB_LATEX_MCP_SESSION: raw })).toThrow(/reserved/);
    },
  );

  it('still accepts a name that merely contains a reserved one', () => {
    // CONTROL: passes before and after — the refusal is by whole name, never by substring.
    expect(loadConfig({ WEB_LATEX_MCP_SESSION: 'shelves-2' }).sessionId).toBe('shelves-2');
    expect(loadConfig({ WEB_LATEX_MCP_SESSION: 'writer' }).sessionId).toBe('writer');
  });
});

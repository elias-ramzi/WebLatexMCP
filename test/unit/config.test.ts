import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';

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
    expect(cfg.workspaceRoot).toBe(path.join('/work/paper', 'clones'));
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
  });
});

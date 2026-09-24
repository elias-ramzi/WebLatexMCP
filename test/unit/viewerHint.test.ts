import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import {
  compileViewerHint,
  shouldOpenExternally,
  viewerHint,
  viewerShowsForCompile,
} from '../../src/lib/viewerHint.js';
import { FileService } from '../../src/services/fileService.js';
import { buildDir, buildPdfPath } from '../../src/services/compiler.js';
import type { ServerConfig } from '../../src/types.js';

describe('shouldOpenExternally', () => {
  it('never opens the OS browser in vscode mode', () => {
    expect(shouldOpenExternally('vscode', true)).toBe(false);
    expect(shouldOpenExternally('vscode', undefined)).toBe(false);
  });

  it('opens by default in browser mode, honoring an explicit open flag', () => {
    expect(shouldOpenExternally('browser', undefined)).toBe(true);
    expect(shouldOpenExternally('browser', true)).toBe(true);
    expect(shouldOpenExternally('browser', false)).toBe(false);
  });
});

describe('compileViewerHint', () => {
  const url = 'http://127.0.0.1:41725/p/demo';

  it('says the viewer refreshed only when it shows this very build', () => {
    const hint = compileViewerHint({ url, builtRoot: 'main.tex', shows: { kind: 'this-build' } });
    expect(hint).toContain(url);
    expect(hint).toMatch(/refreshed/);
  });

  it('names the root the viewer shows, and where to see this build, for another root', () => {
    const hint = compileViewerHint({
      url,
      builtRoot: 'supp.tex',
      shows: { kind: 'other-root', shownRoot: 'main.tex' },
    });
    expect(hint).toContain(url);
    expect(hint).not.toMatch(/refreshed/);
    expect(hint).toContain('main.tex');
    expect(hint).toMatch(/render_pages or extract_text with rootFile: "supp\.tex"/);
  });

  it('says a surfaced-copy fallback shows this build but maps no source location', () => {
    const hint = compileViewerHint({
      url,
      builtRoot: 'supp.tex',
      shows: { kind: 'surfaced-copy', shownRoot: 'main.tex' },
    });
    expect(hint).not.toMatch(/refreshed/);
    expect(hint).toMatch(/surfaced copy/);
    expect(hint).toMatch(/no source location/);
  });

  it('claims nothing about which build it shows when that is unknown', () => {
    const hint = compileViewerHint({ url, builtRoot: 'supp.tex', shows: { kind: 'unknown' } });
    expect(hint).toContain(url);
    expect(hint).not.toMatch(/refreshed/);
  });

  it('advertises the viewer (and the comment loop) when it is not running', () => {
    const hint = compileViewerHint(undefined);
    expect(hint).toMatch(/`viewer`/);
    expect(hint).toMatch(/comments/);
    expect(hint).not.toContain('127.0.0.1');
    // It follows the auto-detected root, not every compile.
    expect(hint).toMatch(/auto-detected root/);
    expect(hint).not.toMatch(/on every compile/);
  });
});

describe('viewerHint', () => {
  const url = 'http://127.0.0.1:41725/p/demo';

  it('gives Simple Browser instructions in vscode mode', () => {
    const hint = viewerHint(url, 'vscode', false);
    expect(hint).toContain(url);
    expect(hint).toMatch(/Simple Browser/);
    expect(hint).not.toMatch(/Opened in your browser/);
  });

  it('reports whether the browser was opened in browser mode', () => {
    expect(viewerHint(url, 'browser', true)).toMatch(/Opened in your browser/);
    expect(viewerHint(url, 'browser', false)).toMatch(/Open this URL in a browser/);
  });
});

describe('viewerShowsForCompile', () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const c of cleanups.splice(0)) await c();
  });

  /** A project whose auto-detected root is `main.tex`, with that root's build PDF on disk. */
  async function builtProject() {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-vshows-'));
    cleanups.push(
      () => rm(dir, { recursive: true, force: true }),
      () => rm(buildDir(dir), { recursive: true, force: true }),
    );
    await writeFile(path.join(dir, 'main.tex'), '\\documentclass{article}\n');
    const pdf = buildPdfPath(dir, 'main.tex');
    await mkdir(path.dirname(pdf), { recursive: true });
    await writeFile(pdf, '%PDF-1.4\n');
    const config: ServerConfig = {
      workspaceRoot: dir,
      workspaceIsLocal: false,
      sessionId: 'test',
      projects: [],
    };
    return { dir, config };
  }

  // `compile rootFile: "Main.tex"` on macOS/Windows compiles the same file the viewer detects as
  // `main.tex`, into the same build PDF (the build dir sits on the same case-insensitive disk), yet
  // the paths were compared byte-exact and the hint said the viewer shows another root. The
  // platform is stubbed so the case-insensitive branch runs on the Linux leg too; on Linux itself
  // the two names are two files, and `other-root` stays the right answer.
  it('treats a root spelled in another case as this build where the disk folds case', async () => {
    const { dir, config } = await builtProject();
    const files = new FileService();
    for (const platform of ['darwin', 'win32'] as const) {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
      expect(await viewerShowsForCompile(files, config, 'p', dir, 'Main.tex')).toEqual({
        kind: 'this-build',
      });
    }
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    expect(await viewerShowsForCompile(files, config, 'p', dir, 'Main.tex')).toEqual({
      kind: 'other-root',
      shownRoot: 'main.tex',
    });
    expect(await viewerShowsForCompile(files, config, 'p', dir, 'main.tex')).toEqual({
      kind: 'this-build',
    });
  });
});

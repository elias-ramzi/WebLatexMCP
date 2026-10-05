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
      shows: { kind: 'other-root', shownRoot: 'main.tex', source: 'detected', rootUsable: true },
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
      shows: { kind: 'surfaced-copy', shownRoot: 'main.tex', source: 'detected', rootUsable: true },
    });
    expect(hint).not.toMatch(/refreshed/);
    expect(hint).toMatch(/surfaced copy/);
    expect(hint).toMatch(/no source location/);
  });

  it('says the viewer still shows nothing when its root has no build', () => {
    const hint = compileViewerHint({
      url,
      builtRoot: 'root.tex',
      shows: { kind: 'no-build', shownRoot: 'tpl/main.tex', source: 'detected', rootUsable: true },
    });
    expect(hint).not.toMatch(/refreshed/);
    expect(hint).toContain('"tpl/main.tex" (auto-detected)');
    expect(hint).toMatch(/shows nothing/);
    expect(hint).toMatch(/register_project .*rootFile: "root\.tex"/);
  });

  it('names a registered root as registered', () => {
    const hint = compileViewerHint({
      url,
      builtRoot: 'supp.tex',
      shows: { kind: 'other-root', shownRoot: 'root.tex', source: 'registered', rootUsable: true },
    });
    expect(hint).toContain(`"root.tex" (the project's registered rootFile)`);
  });

  // The reported case: the viewer was opened AFTER the compile, so no running-viewer line could
  // have said it was waiting on another root.
  it('names the root an idle viewer would show when it is another root', () => {
    const hint = compileViewerHint(undefined, {
      builtRoot: 'root.tex',
      shows: {
        kind: 'other-root',
        shownRoot: 'tpl/main.tex',
        source: 'detected',
        rootUsable: true,
      },
    });
    expect(hint).toMatch(/`viewer`/);
    expect(hint).toMatch(/would show "tpl\/main\.tex" \(auto-detected\), not this build/);
    expect(hint).toMatch(/rootFile: "root\.tex"/);
    expect(
      compileViewerHint(undefined, { builtRoot: 'x.tex', shows: { kind: 'this-build' } }),
    ).toBe(compileViewerHint(undefined));
  });

  // In workspace-local mode the idle viewer's root may have no build while the surfaced copy is
  // the build this compile just made: the viewer WOULD show this build (without synctex), so
  // "not this build" is false.
  it('says an idle viewer would show this build as the surfaced copy', () => {
    const hint = compileViewerHint(undefined, {
      builtRoot: 'supp.tex',
      shows: { kind: 'surfaced-copy', shownRoot: 'main.tex', source: 'detected', rootUsable: true },
    });
    expect(hint).not.toMatch(/not this build/);
    expect(hint).toMatch(/would show this build only as the surfaced copy/);
    expect(hint).toContain('"main.tex" (auto-detected), the root it follows, has no build');
    expect(hint).toMatch(/no source location/);
    expect(hint).toMatch(/rootFile: "supp\.tex"/);
  });

  it('says an idle viewer whose root has no build would show nothing', () => {
    const hint = compileViewerHint(undefined, {
      builtRoot: 'root.tex',
      shows: { kind: 'no-build', shownRoot: 'tpl/main.tex', source: 'detected', rootUsable: true },
    });
    expect(hint).not.toMatch(/would show "tpl/);
    expect(hint).toMatch(
      /would follow "tpl\/main\.tex" \(auto-detected\), which has no build, so it would show nothing/,
    );
    expect(hint).toMatch(/rootFile: "root\.tex"/);
  });

  it('gives follow advice that holds for every kind of project', () => {
    const hint = compileViewerHint(undefined, {
      builtRoot: 'root.tex',
      shows: { kind: 'other-root', shownRoot: 'main.tex', source: 'detected', rootUsable: true },
    });
    expect(hint).toMatch(/register_project with its gitUrl or path/);
    expect(hint).toMatch(/branch, username, tokenEnv or followSymlinks/);
    expect(hint).toMatch(/default for compile and the PDF tools/);
    expect(hint).toMatch(/WEB_LATEX_MCP_PROJECTS/);
  });

  // A root name comes from the caller or the filesystem: it must not carry a bidi override or a
  // zero-width character into the message raw, in any case of either branch.
  it('quotes and escapes every root name it puts in a message', () => {
    const shownRoot = 'a\u202Eb.tex';
    const builtRoot = 'c\u200Bd.tex';
    const hints = (['surfaced-copy', 'other-root', 'no-build'] as const).flatMap((kind) => [
      compileViewerHint({
        url,
        builtRoot,
        shows: { kind, shownRoot, source: 'detected', rootUsable: true },
      }),
      compileViewerHint(undefined, {
        builtRoot,
        shows: { kind, shownRoot, source: 'detected', rootUsable: true },
      }),
    ]);
    for (const hint of hints) {
      expect(hint).not.toContain('\u202E');
      expect(hint).not.toContain('\u200B');
      expect(hint).toContain('"c\\u{200B}d.tex"');
    }
    // The running surfaced-copy line names the viewer's root in its "Compile …" advice too.
    expect(hints[0]).toContain('Compile "a\\u{202E}b.tex"');
  });

  // compile without rootFile refuses an unusable registered root, so "Compile it to give the
  // viewer its own build back" was advice that could not succeed.
  it('does not advise compiling a registered root that is not usable', () => {
    const shows = {
      kind: 'surfaced-copy',
      shownRoot: 'gone\u202E.tex',
      source: 'registered',
      rootUsable: false,
    } as const;
    const hint = compileViewerHint({ url, builtRoot: 'supp.tex', shows });
    expect(hint).toMatch(/surfaced copy/);
    expect(hint).not.toMatch(/Compile "/);
    expect(hint).toContain(
      'the registered rootFile "gone\\u{202E}.tex" is not usable in the project (missing, not a ' +
        'file, unreadable, outside it, or an absolute or drive-prefixed path)',
    );
    expect(hint).not.toContain('\u202E');
    expect(hint).toMatch(/register the project again .*rootFile: "supp\.tex"/);
    // A usable registered root keeps the compile advice, word for word.
    const usable = compileViewerHint({
      url,
      builtRoot: 'supp.tex',
      shows: { ...shows, shownRoot: 'root.tex', rootUsable: true },
    });
    expect(usable).toContain('Compile "root.tex" to give the viewer its own build back, or to');
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
    // It follows the project's root (registered, else auto-detected), not every compile.
    expect(hint).toMatch(/registered rootFile, else the auto-detected root/);
    expect(hint).toMatch(/a top-level main\.tex, else the shallowest \.tex with a/);
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
      expect(await viewerShowsForCompile(files, config, 'p', dir, undefined, 'Main.tex')).toEqual({
        kind: 'this-build',
      });
    }
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    expect(await viewerShowsForCompile(files, config, 'p', dir, undefined, 'Main.tex')).toEqual({
      kind: 'other-root',
      shownRoot: 'main.tex',
      source: 'detected',
      rootUsable: true,
    });
    expect(await viewerShowsForCompile(files, config, 'p', dir, undefined, 'main.tex')).toEqual({
      kind: 'this-build',
    });
  });

  // A registered rootFile is what the viewer follows — a nested template main.tex must not win.
  it('follows the registered root over auto-detection', async () => {
    const { dir, config } = await builtProject();
    const files = new FileService();
    await writeFile(path.join(dir, 'root.tex'), '\\documentclass{article}\n');
    const pdf = buildPdfPath(dir, 'root.tex');
    await writeFile(pdf, '%PDF-1.4\n');
    expect(await viewerShowsForCompile(files, config, 'p', dir, 'root.tex', 'root.tex')).toEqual({
      kind: 'this-build',
    });
    expect(await viewerShowsForCompile(files, config, 'p', dir, 'root.tex', 'main.tex')).toEqual({
      kind: 'other-root',
      shownRoot: 'root.tex',
      source: 'registered',
      rootUsable: true,
    });
  });

  it('reports no-build when the root the viewer follows was never compiled', async () => {
    const { dir, config } = await builtProject();
    const files = new FileService();
    expect(await viewerShowsForCompile(files, config, 'p', dir, 'root.tex', 'main.tex')).toEqual({
      kind: 'no-build',
      shownRoot: 'root.tex',
      source: 'registered',
      rootUsable: false,
    });
  });

  // `compile` with no rootFile resolved the very root the viewer follows (registered, else
  // detected); handing it over saves a second auto-detection on every compile.
  it('uses a root the caller already resolved instead of detecting it again', async () => {
    const { dir, config } = await builtProject();
    const files = new FileService();
    const list = vi.spyOn(files, 'list');
    expect(
      await viewerShowsForCompile(files, config, 'p', dir, undefined, 'main.tex', {
        rootFile: 'main.tex',
        source: 'detected',
      }),
    ).toEqual({ kind: 'this-build' });
    expect(list).not.toHaveBeenCalled();
  });

  // The call's own rootFile is never the viewer's root: handed one, it still follows the
  // registered root.
  it('never takes an explicit root as the viewer root', async () => {
    const { dir, config } = await builtProject();
    const files = new FileService();
    await writeFile(path.join(dir, 'root.tex'), '\\documentclass{article}\n');
    await writeFile(buildPdfPath(dir, 'root.tex'), '%PDF-1.4\n');
    expect(
      await viewerShowsForCompile(files, config, 'p', dir, 'root.tex', 'main.tex', {
        rootFile: 'main.tex',
        source: 'argument',
      }),
    ).toEqual({
      kind: 'other-root',
      shownRoot: 'root.tex',
      source: 'registered',
      rootUsable: true,
    });
  });

  // A registered root that is not in the project cannot be compiled (compile refuses it), so the
  // hint must not advise compiling it; a detected root was found on disk and is never re-checked.
  it('says whether a registered root is usable, and never re-checks a detected one', async () => {
    const { dir, config } = await builtProject();
    const files = new FileService();
    await writeFile(path.join(dir, 'root.tex'), '\\documentclass{article}\n');
    await writeFile(buildPdfPath(dir, 'root.tex'), '%PDF-1.4\n');
    expect(await viewerShowsForCompile(files, config, 'p', dir, 'root.tex', 'main.tex')).toEqual({
      kind: 'other-root',
      shownRoot: 'root.tex',
      source: 'registered',
      rootUsable: true,
    });
    const read = vi.spyOn(files, 'read');
    expect(await viewerShowsForCompile(files, config, 'p', dir, undefined, 'root.tex')).toEqual({
      kind: 'other-root',
      shownRoot: 'main.tex',
      source: 'detected',
      rootUsable: true,
    });
    // A top-level main.tex is detected without a read, and a detected root is not judged again.
    expect(read).not.toHaveBeenCalled();
  });
});

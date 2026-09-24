import type { ServerConfig, ViewerTarget } from '../types.js';
import type { FileService } from '../services/fileService.js';
import { buildPdfPath } from '../services/compiler.js';
import { locateViewerPdf } from './pdfLocate.js';
import { detectRootFile } from './rootFile.js';
import { samePath } from './paths.js';

/**
 * Whether the `viewer` tool should launch the OS browser. In VSCode mode we never do — the URL is
 * meant to be opened as a Simple Browser tab inside the editor instead.
 */
export function shouldOpenExternally(target: ViewerTarget, open: boolean | undefined): boolean {
  if (target === 'vscode') return false;
  return open ?? true;
}

/**
 * What the running viewer shows after a compile, relative to the build that compile just made.
 * The viewer never follows `compile`'s `rootFile`: it shows the auto-detected root's build
 * ({@link locateViewerPdf}), or — when that build is gone — the surfaced copy, which holds
 * whichever root compiled last and so maps a click to no source location.
 *
 * - `this-build`: the compiled root IS the root the viewer shows.
 * - `surfaced-copy`: another root's build is missing, so the viewer fell back to the surfaced
 *   copy, which this compile just overwrote — it shows this build, with no synctex behind it.
 * - `other-root`: the viewer shows `shownRoot`'s build, not this one.
 * - `unknown`: the viewer's root could not be determined; claim nothing either way.
 */
export type ViewerShows =
  | { kind: 'this-build' }
  | { kind: 'surfaced-copy'; shownRoot: string }
  | { kind: 'other-root'; shownRoot: string }
  | { kind: 'unknown' };

/**
 * Decide {@link ViewerShows} for a compile of `builtRoot` — by the viewer's own rule, so the
 * compile result cannot promise a refresh the viewer never makes. It asks the very functions the
 * viewer does (`detectRootFile`, then `locateViewerPdf`), and compares the build PDF paths rather
 * than root names, since two roots with one basename share a build PDF. The comparison folds case
 * where the disk does (`samePath`): on macOS/Windows `rootFile: "Main.tex"` compiles the very file
 * the viewer detects as `main.tex`, into the very build PDF it shows, and a byte-exact comparison
 * called that another root. Call it after the compile has written (and surfaced) its PDF. Never
 * throws: this only phrases a hint.
 */
export async function viewerShowsForCompile(
  files: FileService,
  config: ServerConfig,
  id: string,
  dir: string,
  builtRoot: string,
): Promise<ViewerShows> {
  try {
    const shownRoot = await detectRootFile(files, dir);
    const located = await locateViewerPdf(config, id, dir, shownRoot);
    if (located === undefined) return { kind: 'unknown' };
    if (samePath(located.pdf, buildPdfPath(dir, builtRoot))) return { kind: 'this-build' };
    if (located.synctexPdf === null) return { kind: 'surfaced-copy', shownRoot };
    return { kind: 'other-root', shownRoot };
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * A one-line nudge appended to `compile` output so the live viewer is discoverable. When the viewer
 * is already running we surface its URL and say truthfully whether it now shows this build
 * ({@link ViewerShows}); otherwise we advertise that the tool exists, including the review-comment
 * loop it enables.
 */
export function compileViewerHint(
  running: { url: string; shows: ViewerShows; builtRoot: string } | undefined,
): string {
  if (!running) {
    return (
      'Tip: the `viewer` tool opens a live PDF viewer of the auto-detected root file (main.tex, ' +
      'else the first .tex with a \\documentclass) that hot-reloads whenever it is recompiled — ' +
      'and you can select text in it to leave review comments for me to apply (list_comments).'
    );
  }
  const { url, shows, builtRoot } = running;
  const elsewhere =
    `to look at this build of ${builtRoot}, use render_pages or extract_text with ` +
    `rootFile: ${JSON.stringify(builtRoot)}.`;
  switch (shows.kind) {
    case 'this-build':
      return `Live viewer: ${url} — it just refreshed with this build.`;
    case 'surfaced-copy':
      return (
        `Live viewer: ${url} — it shows this build only as the surfaced copy, because ` +
        `${shows.shownRoot} (the root it follows) has no build; a comment made on it carries no ` +
        `source location. Compile ${shows.shownRoot} to give the viewer its own build back.`
      );
    case 'other-root':
      return (
        `Live viewer: ${url} — it shows ${shows.shownRoot} (the auto-detected root), not this ` +
        `build, and did not change; ${elsewhere}`
      );
    case 'unknown':
      return `Live viewer: ${url} — it shows the auto-detected root's build, which may not be this one.`;
  }
}

/** The human-facing hint the `viewer` tool returns, tailored to where the viewer opens. */
export function viewerHint(url: string, target: ViewerTarget, opened: boolean): string {
  if (target === 'vscode') {
    return (
      `PDF viewer: ${url}\n` +
      'Open it as a tab in VSCode: Command Palette (Cmd/Ctrl+Shift+P) → "Simple Browser: Show" → ' +
      'paste the URL. It refreshes automatically each time you compile. Tip: pin ' +
      'WEB_LATEX_MCP_VIEWER_PORT for a stable URL you can bind to a key.'
    );
  }
  return (
    `PDF viewer: ${url}\n` +
    (opened
      ? 'Opened in your browser — it refreshes automatically each time you compile.'
      : 'Open this URL in a browser; it refreshes automatically each time you compile.')
  );
}

import type { ServerConfig, ViewerTarget } from '../types.js';
import type { FileService } from '../services/fileService.js';
import { buildPdfPath } from '../services/compiler.js';
import { locateViewerPdf } from './pdfLocate.js';
import { resolveRootFile, type RootSource } from './rootFile.js';
import { quoteId } from './projectId.js';
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
 * What the viewer shows after a compile, relative to the build that compile just made. The viewer
 * never follows `compile`'s `rootFile`: it shows the project's root — the registered `rootFile`,
 * else the auto-detected one ({@link resolveRootFile}) — from its build ({@link locateViewerPdf}),
 * or, when that build is gone, the surfaced copy, which holds whichever root compiled last and so
 * maps a click to no source location.
 *
 * - `this-build`: the compiled root IS the root the viewer shows.
 * - `surfaced-copy`: the viewer's root has no build, so it fell back to the surfaced copy, which
 *   this compile just overwrote — it shows this build, with no synctex behind it.
 * - `other-root`: the viewer shows `shownRoot`'s build, not this one.
 * - `no-build`: the viewer's root (`shownRoot`) has no build and there is no surfaced copy to fall
 *   back to, so it shows nothing — the "No compiled PDF yet" page right after a successful compile.
 * - `unknown`: the viewer's root could not be determined; claim nothing either way.
 */
export type ViewerShows =
  | { kind: 'this-build' }
  | { kind: 'surfaced-copy'; shownRoot: string; source: RootSource }
  | { kind: 'other-root'; shownRoot: string; source: RootSource }
  | { kind: 'no-build'; shownRoot: string; source: RootSource }
  | { kind: 'unknown' };

/**
 * Decide {@link ViewerShows} for a compile of `builtRoot` — by the viewer's own rule, so the
 * compile result cannot promise a refresh the viewer never makes. It asks the very functions the
 * viewer does (`resolveRootFile` with the project's registered root, then `locateViewerPdf`), and
 * compares the build PDF paths rather than root names, since two roots with one basename share a
 * build PDF. The comparison folds case where the disk does (`samePath`): on macOS/Windows
 * `rootFile: "Main.tex"` compiles the very file the viewer detects as `main.tex`, into the very
 * build PDF it shows, and a byte-exact comparison called that another root. Call it after the
 * compile has written (and surfaced) its PDF. Never throws: this only phrases a hint.
 */
export async function viewerShowsForCompile(
  files: FileService,
  config: ServerConfig,
  id: string,
  dir: string,
  registeredRoot: string | undefined,
  builtRoot: string,
): Promise<ViewerShows> {
  try {
    const { rootFile: shownRoot, source } = await resolveRootFile(files, dir, registeredRoot);
    const located = await locateViewerPdf(config, id, dir, shownRoot);
    if (located === undefined) return { kind: 'no-build', shownRoot, source };
    if (samePath(located.pdf, buildPdfPath(dir, builtRoot))) return { kind: 'this-build' };
    if (located.synctexPdf === null) return { kind: 'surfaced-copy', shownRoot, source };
    return { kind: 'other-root', shownRoot, source };
  } catch {
    return { kind: 'unknown' };
  }
}

/** How a message names the viewer's root: the registered `rootFile`, or the auto-detected one. */
export function describeViewerRoot(root: string, source: RootSource): string {
  return source === 'detected'
    ? `${quoteId(root)} (auto-detected)`
    : `${quoteId(root)} (the project's registered rootFile)`;
}

/** The way to make the viewer follow `builtRoot` instead of the root it follows now. */
function followAdvice(builtRoot: string): string {
  return (
    `to make the viewer follow ${quoteId(builtRoot)}, register the project again (register_project ` +
    `with its gitUrl or path) with rootFile: ${JSON.stringify(builtRoot)}`
  );
}

/**
 * A one-line nudge appended to `compile` output so the live viewer is discoverable. When the viewer
 * is already running we surface its URL and say truthfully whether it now shows this build
 * ({@link ViewerShows}); otherwise we advertise that the tool exists, including the review-comment
 * loop it enables — and, when it would not show this build, which root it would show instead.
 */
export function compileViewerHint(
  running: { url: string; shows: ViewerShows; builtRoot: string } | undefined,
  idle?: { shows: ViewerShows; builtRoot: string },
): string {
  if (!running) {
    const tip =
      "Tip: the `viewer` tool opens a live PDF viewer of the project's root file (its registered " +
      'rootFile, else the auto-detected root: main.tex, else the shallowest .tex with a ' +
      '\\documentclass) that hot-reloads whenever it is recompiled — and you can select text in ' +
      'it to leave review comments for me to apply (list_comments).';
    const shows = idle?.shows;
    if (idle && shows && shows.kind !== 'this-build' && shows.kind !== 'unknown') {
      return (
        `${tip} It would show ${describeViewerRoot(shows.shownRoot, shows.source)}, not this ` +
        `build of ${quoteId(idle.builtRoot)}; ${followAdvice(idle.builtRoot)}.`
      );
    }
    return tip;
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
        `${describeViewerRoot(shows.shownRoot, shows.source)}, the root it follows, has no ` +
        `build; a comment made on it carries no source location. Compile ${shows.shownRoot} to ` +
        `give the viewer its own build back, or ${followAdvice(builtRoot)}.`
      );
    case 'other-root':
      return (
        `Live viewer: ${url} — it shows ${describeViewerRoot(shows.shownRoot, shows.source)}, ` +
        `not this build, and did not change; ${elsewhere} Or ${followAdvice(builtRoot)}.`
      );
    case 'no-build':
      return (
        `Live viewer: ${url} — it follows ${describeViewerRoot(shows.shownRoot, shows.source)}, ` +
        `which has no build, so it still shows nothing; ${followAdvice(builtRoot)}.`
      );
    case 'unknown':
      return `Live viewer: ${url} — it shows the project's root build, which may not be this one.`;
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

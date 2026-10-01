import type { ServerConfig, ViewerTarget } from '../types.js';
import type { FileService } from '../services/fileService.js';
import { buildPdfPath } from '../services/compiler.js';
import { locateViewerPdf } from './pdfLocate.js';
import {
  assertRegisteredRootExists,
  resolveRootFile,
  type ResolvedRoot,
  type RootSource,
} from './rootFile.js';
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
 *
 * `rootUsable` is false only for a registered `shownRoot` that `assertRegisteredRootExists` refuses
 * (missing, not a file, unreadable, outside the project, or spelled as an absolute or
 * drive-prefixed path): `compile` without `rootFile` refuses that root, so no hint may advise
 * compiling it. A detected root was found on disk and is always usable.
 */
export type ViewerShows =
  | { kind: 'this-build' }
  | { kind: 'surfaced-copy'; shownRoot: string; source: RootSource; rootUsable: boolean }
  | { kind: 'other-root'; shownRoot: string; source: RootSource; rootUsable: boolean }
  | { kind: 'no-build'; shownRoot: string; source: RootSource; rootUsable: boolean }
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
 *
 * `viewerRoot` is the viewer's root when the caller already resolved it the viewer's way — a
 * `compile` that named no `rootFile` resolved exactly that (registered, else detected), and
 * passing it saves a second auto-detection (a listing of the tree and a read of its .tex files).
 * A root the call named (`source: 'argument'`) is never the viewer's, so one is ignored and the
 * viewer's root resolved here.
 */
export async function viewerShowsForCompile(
  files: FileService,
  config: ServerConfig,
  id: string,
  dir: string,
  registeredRoot: string | undefined,
  builtRoot: string,
  viewerRoot?: ResolvedRoot,
): Promise<ViewerShows> {
  try {
    const resolved =
      viewerRoot !== undefined && viewerRoot.source !== 'argument'
        ? viewerRoot
        : await resolveRootFile(files, dir, registeredRoot);
    const { rootFile: shownRoot, source } = resolved;
    const located = await locateViewerPdf(config, id, dir, shownRoot);
    if (located !== undefined && samePath(located.pdf, buildPdfPath(dir, builtRoot))) {
      return { kind: 'this-build' };
    }
    const rootUsable = await registeredRootUsable(files, dir, id, resolved);
    if (located === undefined) return { kind: 'no-build', shownRoot, source, rootUsable };
    if (located.synctexPdf === null) {
      return { kind: 'surfaced-copy', shownRoot, source, rootUsable };
    }
    return { kind: 'other-root', shownRoot, source, rootUsable };
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * Whether `compile` would accept `resolved` as its root with no `rootFile` named: false only for a
 * registered root {@link assertRegisteredRootExists} refuses. A detected root costs no I/O here —
 * detection found it on disk. Never throws.
 */
async function registeredRootUsable(
  files: FileService,
  dir: string,
  id: string,
  resolved: ResolvedRoot,
): Promise<boolean> {
  if (resolved.source !== 'registered') return true;
  try {
    await assertRegisteredRootExists(files, dir, id, resolved);
    return true;
  } catch {
    return false;
  }
}

/** How a message names the viewer's root: the registered `rootFile`, or the auto-detected one. */
export function describeViewerRoot(root: string, source: RootSource): string {
  return source === 'detected'
    ? `${quoteId(root)} (auto-detected)`
    : `${quoteId(root)} (the project's registered rootFile)`;
}

/**
 * The way to make the viewer follow `builtRoot` instead of the root it follows now. Worded to hold
 * for every kind of project: a re-registration replaces the stored entry whole (so its other
 * settings must be repeated), the registered root is also what `compile` and the PDF tools default
 * to, and an entry in `WEB_LATEX_MCP_PROJECTS` overrides a registration at the next start.
 */
function followAdvice(builtRoot: string): string {
  const root = quoteId(builtRoot);
  return (
    `to make the viewer follow ${root}, register the project again (register_project with its ` +
    `gitUrl or path) with rootFile: ${root}, repeating any branch, username, tokenEnv or ` +
    `followSymlinks it was registered with — this also makes ${root} the default for compile ` +
    'and the PDF tools (for a project configured in WEB_LATEX_MCP_PROJECTS, set its rootFile ' +
    'there instead: that entry wins at the next start)'
  );
}

/** What a viewer not yet opened would show after this compile, when that is not simply this build. */
function idleViewerNote(shows: ViewerShows, builtRoot: string): string | undefined {
  switch (shows.kind) {
    case 'surfaced-copy':
      return (
        'It would show this build only as the surfaced copy, because ' +
        `${describeViewerRoot(shows.shownRoot, shows.source)}, the root it follows, has no ` +
        `build; a comment made on it carries no source location; ${followAdvice(builtRoot)}.`
      );
    case 'no-build':
      return (
        `It would follow ${describeViewerRoot(shows.shownRoot, shows.source)}, which has no ` +
        `build, so it would show nothing; ${followAdvice(builtRoot)}.`
      );
    case 'other-root':
      return (
        `It would show ${describeViewerRoot(shows.shownRoot, shows.source)}, not this build of ` +
        `${quoteId(builtRoot)}; ${followAdvice(builtRoot)}.`
      );
    case 'this-build':
    case 'unknown':
      return undefined;
  }
}

/**
 * A one-line nudge appended to `compile` output so the live viewer is discoverable. When the viewer
 * is already running we surface its URL and say truthfully whether it now shows this build
 * ({@link ViewerShows}); otherwise we advertise that the tool exists, including the review-comment
 * loop it enables — and, when it would not simply show this build, what it would show instead.
 */
export function compileViewerHint(
  running: { url: string; shows: ViewerShows; builtRoot: string } | undefined,
  idle?: { shows: ViewerShows; builtRoot: string },
): string {
  if (!running) {
    const tip =
      "Tip: the `viewer` tool opens a live PDF viewer of the project's root file (its registered " +
      'rootFile, else the auto-detected root: a top-level main.tex, else the shallowest .tex with ' +
      'a \\documentclass) that hot-reloads whenever it is recompiled — and you can select text ' +
      'in it to leave review comments for me to apply (list_comments).';
    const note = idle ? idleViewerNote(idle.shows, idle.builtRoot) : undefined;
    return note === undefined ? tip : `${tip} ${note}`;
  }
  const { url, shows, builtRoot } = running;
  const elsewhere =
    `to look at this build of ${quoteId(builtRoot)}, use render_pages or extract_text with ` +
    `rootFile: ${quoteId(builtRoot)}.`;
  switch (shows.kind) {
    case 'this-build':
      return `Live viewer: ${url} — it just refreshed with this build.`;
    case 'surfaced-copy': {
      const lead =
        `Live viewer: ${url} — it shows this build only as the surfaced copy, because ` +
        `${describeViewerRoot(shows.shownRoot, shows.source)}, the root it follows, has no ` +
        'build; a comment made on it carries no source location';
      // compile without rootFile refuses an unusable registered root, so advising it cannot help.
      if (!shows.rootUsable) {
        return (
          `${lead}; the registered rootFile ${quoteId(shows.shownRoot)} is not usable in the ` +
          'project (missing, not a file, unreadable, outside it, or an absolute or drive-prefixed ' +
          'path), so ' +
          `compiling it cannot give the viewer its own build back — ${followAdvice(builtRoot)}.`
        );
      }
      return (
        `${lead}. Compile ${quoteId(shows.shownRoot)} to give the viewer its own build back, or ` +
        `${followAdvice(builtRoot)}.`
      );
    }
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

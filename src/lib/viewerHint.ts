import type { ViewerTarget } from '../types.js';

/**
 * Whether the `viewer` tool should launch the OS browser. In VSCode mode we never do — the URL is
 * meant to be opened as a Simple Browser tab inside the editor instead.
 */
export function shouldOpenExternally(target: ViewerTarget, open: boolean | undefined): boolean {
  if (target === 'vscode') return false;
  return open ?? true;
}

/**
 * A one-line nudge appended to `compile` output so the live viewer is discoverable. When the viewer
 * is already running we surface its URL (it just hot-reloaded with this build); otherwise we
 * advertise that the tool exists, including the review-comment loop it enables.
 */
export function compileViewerHint(url: string | undefined): string {
  return url
    ? `Live viewer: ${url} — it just refreshed with this build.`
    : 'Tip: the `viewer` tool opens a live PDF viewer that hot-reloads on every compile — and you ' +
        'can select text in it to leave review comments for me to apply (list_comments).';
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

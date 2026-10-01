import type { FileService } from '../services/fileService.js';

/**
 * Where a root came from: named on this call, registered with the project (`rootFile` in
 * `register_project` / `WEB_LATEX_MCP_PROJECTS`), or guessed by {@link detectRootFile}.
 */
export type RootSource = 'argument' | 'registered' | 'detected';

export interface ResolvedRoot {
  rootFile: string;
  source: RootSource;
}

/**
 * The root a tool should use: the caller's `rootFile`, else the project's registered one, else
 * {@link detectRootFile}. One function for every caller — `compile`, the PDF tools and the viewer
 * — so a project registered with `rootFile: "root.tex"` is built, read and shown as that root
 * everywhere; the registered value used to be stored and then read by nothing, so a nested
 * template `main.tex` won every auto-detection.
 *
 * A registered root is an assertion, like an explicit one: it is used as given, never checked
 * against the tree and silently replaced by a guess.
 */
export async function resolveRootFile(
  files: FileService,
  projectDir: string,
  registered: string | undefined,
  explicit?: string,
): Promise<ResolvedRoot> {
  if (explicit !== undefined) return { rootFile: explicit, source: 'argument' };
  if (registered !== undefined) return { rootFile: registered, source: 'registered' };
  return { rootFile: await detectRootFile(files, projectDir), source: 'detected' };
}

/** How deep a project-relative POSIX path sits: `main.tex` is 0, `tpl/main.tex` is 1. */
function depth(rel: string): number {
  return rel.split('/').length - 1;
}

function isMain(rel: string): boolean {
  return rel === 'main.tex' || rel.endsWith('/main.tex');
}

/**
 * Detect the LaTeX root file. A top-level `main.tex` wins outright. Otherwise the shallowest
 * `.tex` containing `\documentclass` (a `main.tex` first among files at one depth), else the
 * shallowest `main.tex`, else the first `.tex`. Throws when there are none.
 *
 * Depth comes before the name: a vendored template's `tpl/main.tex` used to beat a top-level
 * `root.tex` that holds the real `\documentclass`, and was then compiled and shown in its place.
 */
export async function detectRootFile(files: FileService, projectDir: string): Promise<string> {
  const tex = await files.list(projectDir, { filter: 'tex' });
  const first = tex[0];
  if (!first) {
    throw new Error('No .tex files found in project; specify rootFile explicitly.');
  }

  const topMain = tex.find((f) => f.path === 'main.tex');
  if (topMain) return topMain.path;

  // Stable: files at one depth keep their listing order, apart from `main.tex` going first.
  const ranked = tex
    .map((f, i) => ({ path: f.path, i }))
    .sort(
      (a, b) =>
        depth(a.path) - depth(b.path) ||
        Number(isMain(b.path)) - Number(isMain(a.path)) ||
        a.i - b.i,
    );

  for (const f of ranked) {
    // No baseline: this sniffs every .tex in the project to find the root, and the caller asked for
    // none of them. Recording here would tell the out-of-band-edit guard the server has seen the
    // current bytes of files the user may be hand-editing — and `compile` and the viewer's PDF
    // poller both come through here, so it would keep re-arming all session.
    const { content } = await files.read(projectDir, { path: f.path });
    if (content.includes('\\documentclass')) return f.path;
  }

  return ranked.find((f) => isMain(f.path))?.path ?? first.path;
}

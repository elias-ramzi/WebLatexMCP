import path from 'node:path';
import { stat } from 'node:fs/promises';
import type { ServerConfig } from '../types.js';
import { buildPdfPath } from '../services/compiler.js';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** The PDF the viewer shows, and the build PDF whose `.synctex.gz` maps a click on it to source. */
export interface ViewerPdf {
  /** The file the viewer serves. */
  pdf: string;
  /**
   * The PDF to resolve a click through with synctex — the same file as `pdf` when that is the
   * root's own build, and `null` when `pdf` is the surfaced fallback, which may be another
   * root's and has no synctex of its own beside it.
   */
  synctexPdf: string | null;
}

/**
 * Locate the PDF the viewer shows for a project without recompiling, and the synctex source a
 * click on it resolves through — ONE decision, so the two can never name different roots.
 *
 * It follows {@link locateRootPdf}'s rule for an unnamed root that reads no `.aux`: the detected
 * root's build-dir PDF first, in every workspace mode. It used to prefer the surfaced copy
 * (`<workspace>/<id>.pdf`), which holds whichever root compiled LAST, while a comment's click was
 * mapped through the detected root's build synctex — so after compiling a supplement the viewer
 * showed the supplement and filed each comment against the main document's file and line,
 * silently. The surfaced copy is still shown when the build PDF is gone (a wiped temp dir), but
 * then `synctexPdf` is `null` and a click is kept without a source location rather than mapped
 * through a synctex that may belong to a different document.
 *
 * Returns undefined when nothing has been compiled yet.
 */
export async function locateViewerPdf(
  config: ServerConfig,
  id: string,
  dir: string,
  rootFile: string,
): Promise<ViewerPdf | undefined> {
  const built = buildPdfPath(dir, rootFile);
  const pdf = await locateRootPdf(config, id, dir, rootFile, {
    rootNamed: false,
    readsAux: false,
  });
  if (pdf === undefined) return undefined;
  return { pdf, synctexPdf: pdf === built ? built : null };
}

/** What ties a PDF-reading call to one particular root — see {@link locateRootPdf}. */
export interface RootPdfRequest {
  /** The caller passed `rootFile` explicitly, rather than leaving it to auto-detection. */
  rootNamed: boolean;
  /** The call also reads the root's build-dir `.aux` (`labels`, or pdf_geometry's `floats`). */
  readsAux: boolean;
}

/**
 * Locate the compiled PDF for ONE root, for the tools that read it (`render_pages`,
 * `extract_text`, `pdf_geometry`) and for the viewer ({@link locateViewerPdf}). It prefers the
 * root's own build-dir PDF (`buildPdfPath(dir, rootFile)`), in every workspace mode.
 *
 * Why not the surfaced copy: `<workspace>/<id>.pdf` is ONE file per project that `compile`
 * overwrites with whichever root it built LAST, while the build dir keeps a PDF and an `.aux`
 * per root. A call that resolves `labels`/`floats` through the requested root's `.aux` and then
 * opens the surfaced copy pairs one root's page numbers with another root's pages — a label on
 * `main.tex`'s page 3 read back as the supplement's page 3, with no refusal. Reading the build
 * PDF also makes the answer independent of `workspaceIsLocal`, which it always was outside that
 * mode.
 *
 * The surfaced copy is still a fallback, but only when nothing ties the call to one root: no
 * `rootFile` named and no `.aux` read. There it is honestly "the last compiled PDF" the tools
 * promise, and it outlives a wiped temp build dir. Once a root is named, or an `.aux` is read, a
 * missing build PDF returns undefined (the caller says "compile first") rather than a copy that
 * may belong to a different root.
 */
export async function locateRootPdf(
  config: ServerConfig,
  id: string,
  dir: string,
  rootFile: string,
  request: RootPdfRequest,
): Promise<string | undefined> {
  const built = buildPdfPath(dir, rootFile);
  if (await exists(built)) return built;
  if (config.workspaceIsLocal && !request.rootNamed && !request.readsAux) {
    const surfaced = path.join(config.workspaceRoot, `${id}.pdf`);
    if (await exists(surfaced)) return surfaced;
  }
  return undefined;
}

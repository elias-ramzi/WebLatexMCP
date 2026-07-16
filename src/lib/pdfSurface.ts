import path from 'node:path';
import { copyFile, mkdir } from 'node:fs/promises';

/**
 * Copy a freshly compiled PDF to a predictable, easy-to-open location beside the project's clone
 * — `<workspaceRoot>/<id>.pdf` — and return that path.
 *
 * Build artifacts live in a temp dir (to keep the clone clean), which is awkward to open. For
 * workspace-local clones the workspace root sits inside the user's own project, so surfacing the
 * PDF there lets them open the latest build straight from their editor. The copy is a sibling of
 * the clone dir, not inside it, so it never dirties the project's git; `.web_latex_mcp` is already
 * git-excluded from the host repo.
 */
export async function surfaceCompiledPdf(
  workspaceRoot: string,
  id: string,
  srcPdf: string,
): Promise<string> {
  const dest = path.join(workspaceRoot, `${id}.pdf`);
  if (path.resolve(dest) === path.resolve(srcPdf)) return dest;
  await mkdir(workspaceRoot, { recursive: true });
  await copyFile(srcPdf, dest);
  return dest;
}

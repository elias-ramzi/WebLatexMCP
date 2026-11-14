import path from 'node:path';
import { copyFile, mkdir } from 'node:fs/promises';

/**
 * Copy a freshly compiled PDF to a predictable, easy-to-open location beside the project's clone
 * — `<workspaceRoot>/<id>.pdf` — and return that path.
 *
 * Build artifacts live in a temp dir (to keep the clone clean), which is awkward to open. The
 * workspace holds every project, so surfacing each PDF there puts the latest build of every paper
 * in one folder. The copy is a sibling of the clone dir, not inside it, so it never dirties the
 * project's git; a project id can never end in `.pdf` (`src/lib/projectId.ts`), so no copy can
 * land on a clone.
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

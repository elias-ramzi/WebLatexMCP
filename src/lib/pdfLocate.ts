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

/**
 * Locate the most recently compiled PDF for a project without recompiling: the surfaced copy
 * beside the clone (`<workspace>/<id>.pdf`, workspace-local mode only) is preferred, falling back
 * to the temp build path. Returns undefined when nothing has been compiled yet.
 */
export async function locateProjectPdf(
  config: ServerConfig,
  id: string,
  dir: string,
  rootFile: string,
): Promise<string | undefined> {
  const candidates: string[] = [];
  if (config.workspaceIsLocal) {
    candidates.push(path.join(config.workspaceRoot, `${id}.pdf`));
  }
  candidates.push(buildPdfPath(dir, rootFile));
  for (const c of candidates) {
    if (await exists(c)) return c;
  }
  return undefined;
}

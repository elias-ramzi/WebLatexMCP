import type { FileService } from '../services/fileService.js';

/**
 * Detect the LaTeX root file: prefer main.tex, else the first .tex containing
 * \documentclass, else the first .tex file. Throws when there are none.
 */
export async function detectRootFile(files: FileService, projectDir: string): Promise<string> {
  const tex = await files.list(projectDir, { filter: 'tex' });
  const first = tex[0];
  if (!first) {
    throw new Error('No .tex files found in project; specify rootFile explicitly.');
  }

  const main = tex.find((f) => f.path === 'main.tex' || f.path.endsWith('/main.tex'));
  if (main) return main.path;

  for (const f of tex) {
    // No baseline: this sniffs every .tex in the project to find the root, and the caller asked for
    // none of them. Recording here would tell the out-of-band-edit guard the server has seen the
    // current bytes of files the user may be hand-editing — and `compile` and the viewer's PDF
    // poller both come through here, so it would keep re-arming all session.
    const { content } = await files.read(projectDir, { path: f.path });
    if (content.includes('\\documentclass')) return f.path;
  }

  return first.path;
}

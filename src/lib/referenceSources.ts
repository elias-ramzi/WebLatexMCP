import path from 'node:path';
import type { AppContext } from '../context.js';
import { isProseDocument } from './references.js';

/**
 * Which files in a project could hold references or citations, when the caller did not name one.
 *
 * `.bib` and `.tex` are the obvious ones; prose documents (`.md`, `.txt`, …) are in the list because
 * a bibliography does not have to be a `.bib` — a proposal drafted in markdown carries its reference
 * list as a numbered section, and cites into a shared bibliography with pandoc's `[@key]`.
 *
 * Ordered .bib first so a listing leads with the exact entries, then .tex, then prose.
 */
const RANK: Record<string, number> = { '.bib': 0, '.tex': 1 };

export async function referenceSourceCandidates(ctx: AppContext, dir: string): Promise<string[]> {
  const files = await ctx.files.list(dir);
  return files
    .map((f) => f.path)
    .filter((p) => {
      const ext = path.extname(p).toLowerCase();
      return ext === '.bib' || ext === '.tex' || isProseDocument(p);
    })
    .sort((a, b) => {
      const ra = RANK[path.extname(a).toLowerCase()] ?? 2;
      const rb = RANK[path.extname(b).toLowerCase()] ?? 2;
      return ra - rb || a.localeCompare(b);
    });
}

/** Files whose citations are worth collecting: LaTeX sources and prose drafts, never the `.bib`. */
export async function citingDocumentCandidates(ctx: AppContext, dir: string): Promise<string[]> {
  const files = await ctx.files.list(dir);
  return files
    .map((f) => f.path)
    .filter((p) => path.extname(p).toLowerCase() === '.tex' || isProseDocument(p))
    .sort((a, b) => a.localeCompare(b));
}

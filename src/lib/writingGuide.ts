import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { WRITING_GUIDE_URI } from '../resources/writingGuide.js';
import { CONCURRENCY_GUIDE_URI } from '../resources/concurrencyGuide.js';

/** Path to the bundled guide, relative to this module (works from src/ and dist/). */
function bundledGuidePath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/writing-guide.md');
}

/**
 * Read the LaTeX writing guide that is surfaced to MCP clients as the server's
 * `instructions` hint. Defaults to the bundled `docs/writing-guide.md`; override
 * with `WEB_LATEX_MCP_WRITING_GUIDE` to point at a project-specific guide. Returns
 * `undefined` (and logs to stderr) when the file is absent or empty, so a missing
 * guide never prevents the server from starting.
 */
export async function loadWritingGuide(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const override = env.WEB_LATEX_MCP_WRITING_GUIDE?.trim();
  const path = override ? resolve(override) : bundledGuidePath();
  try {
    const text = (await readFile(path, 'utf8')).trim();
    return text.length > 0 ? text : undefined;
  } catch (err) {
    console.error(
      `[web-latex-mcp] writing guide not loaded from ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/** Heading under which an extra, project-specific guide is appended to the base one. */
export const EXTRA_GUIDE_HEADING = '## Project-specific conventions';

/**
 * Read an ADDITIONAL, project-specific writing guide (e.g. "write `lidar`, never `LiDAR`"),
 * to be appended to (never replacing) the base guide. `absPath` is undefined when the user
 * named nothing — that is not an assertion, so it returns `undefined` silently. A named path
 * that is missing, unreadable, or empty is a typo worth surfacing loudly (the model would
 * otherwise silently ignore the user's conventions with no signal), so that case logs to
 * stderr before returning `undefined` — it never throws, so a bad path never blocks startup.
 */
export async function loadExtraWritingGuide(
  absPath: string | undefined,
): Promise<string | undefined> {
  if (!absPath) return undefined;
  try {
    const text = (await readFile(absPath, 'utf8')).trim();
    if (text.length === 0) {
      console.error(`[web-latex-mcp] extra writing guide at ${absPath} is empty; ignoring it`);
      return undefined;
    }
    return text;
  } catch (err) {
    console.error(
      `[web-latex-mcp] extra writing guide not loaded from ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * Compose the base guide with the additional, project-specific one. The extra comes FIRST, under
 * `EXTRA_GUIDE_HEADING`, then the base guide whole: clients cut `instructions` short (Claude Code
 * keeps about the first 4,000 characters), and a convention the user added through
 * `add_writing_convention` is the text a cut must not drop. The base guide's own structure is
 * left intact as one block after it.
 *
 * `hasExtra` is true only when BOTH a base and an extra guide were actually composed together —
 * it is the one place that fact is decided, so `buildInstructions` never has to re-derive it by
 * sniffing the composed text for `EXTRA_GUIDE_HEADING` (which the base guide could itself
 * contain, or which would be vacuously "present" with no base guide to take precedence over).
 */
export function composeWritingGuide(
  base: string | undefined,
  extra: string | undefined,
): { text: string | undefined; hasExtra: boolean } {
  if (base && extra)
    return { text: `${EXTRA_GUIDE_HEADING}\n\n${extra}\n\n---\n\n${base}`, hasExtra: true };
  if (base) return { text: base, hasExtra: false };
  if (extra) return { text: `${EXTRA_GUIDE_HEADING}\n\n${extra}`, hasExtra: false };
  return { text: undefined, hasExtra: false };
}

/**
 * The rules every session needs, in the order a cut must keep them. `instructions` are put in the
 * model's context for the whole session, so they are paid for in every conversation, and clients
 * cut them short (Claude Code keeps about the first 4,000 characters). So this block is short and
 * comes first; the writing guide follows; the concurrency guide (tens of thousands of characters,
 * mostly the why for humans) is not inlined at all — the tools enforce its rules and their
 * refusals name the remedy — and is pointed to as a resource instead. Keep this block under
 * `ESSENTIALS_MAX_CHARS` (test-pinned).
 *
 * The PDF-comment loop is always included (the comment tools always exist), so instructions are
 * present even with no guide: a vague "resolve my comments" must reliably drive it.
 */
export const ESSENTIALS_MAX_CHARS = 1800;

function essentials(hasWritingGuide: boolean, hasConcurrencyGuide: boolean): string {
  const lines = ['web-latex-mcp rules for every session:'];
  if (hasWritingGuide)
    lines.push(
      `- Writing: follow the LaTeX writing guide below when reading, writing, editing, or reviewing .tex files. If it reaches you cut short, read the whole guide (resource \`${WRITING_GUIDE_URI}\`) before drafting or restyling prose.`,
    );
  lines.push(
    '- References: never hand-write or invent BibTeX entries or \\cite keys; add a reference with `add_citation`. Any other `.bib` change needs the user’s explicit approval and `confirmBibEdit: true`.',
    '- Edits: change only the lines in scope; never reflow, rewrap or re-indent untouched text (git merges line by line).',
    '- Git: `push` rebases and never force-pushes. On a `conflict` result, show the user the sides and resolve only through `push` with `resolutions` and `expectedRemoteHead` — never auto-merge.' +
      (hasConcurrencyGuide ? ` Why, in full: resource \`${CONCURRENCY_GUIDE_URI}\`.` : ''),
    '- PDF comments: when asked to apply, address or resolve the user’s comments / feedback from the `viewer`: `list_comments`, edit at each comment’s `file`/`line` (its `quote` pins the spot), `compile`, then `resolve_comments` with the ids handled. Make every edit before resolving; ask when a comment is ambiguous.',
  );
  return lines.join('\n');
}

/**
 * Build the `instructions` string: `essentials` first, then the (composed) writing guide. The
 * concurrency guide is never inlined — only whether one is served decides whether the essentials
 * point at its resource.
 */
export function buildInstructions(
  writingGuide?: string,
  concurrencyGuide?: string,
  hasExtra = false,
): string {
  const sections = [essentials(writingGuide !== undefined, concurrencyGuide !== undefined)];
  if (writingGuide) {
    // `hasExtra` travels as data from `composeWritingGuide`, not re-derived by sniffing the text
    // for `EXTRA_GUIDE_HEADING` — a base guide could itself contain that literal heading (a false
    // claim of precedence with no extra guide configured), and an extra-only guide (no base)
    // would otherwise vacuously claim precedence over a "rest of the guide" that doesn't exist.
    sections.push(
      "The project's LaTeX writing guide follows." +
        (hasExtra
          ? ' Its "Project-specific conventions" come first and take precedence where they ' +
            'contradict the rest of the guide.'
          : '') +
        '\n\n' +
        writingGuide,
    );
  }
  return sections.join('\n\n---\n\n');
}

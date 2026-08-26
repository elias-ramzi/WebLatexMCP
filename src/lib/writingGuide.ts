import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
 * Compose the base guide with the additional, project-specific one — extra always LAST, under
 * `EXTRA_GUIDE_HEADING`, so the base guide's own structure (headings, ordering) is never
 * disturbed by an overlay appended to it.
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
    return { text: `${base}\n\n${EXTRA_GUIDE_HEADING}\n\n${extra}`, hasExtra: true };
  if (base) return { text: base, hasExtra: false };
  if (extra) return { text: `${EXTRA_GUIDE_HEADING}\n\n${extra}`, hasExtra: false };
  return { text: undefined, hasExtra: false };
}

/**
 * Always-on guidance so a vague request reliably drives the PDF-comment loop. The user places
 * comments by selecting text in the local `viewer` and attaching a note; these instructions tell
 * the client what to do when asked to act on them.
 */
const COMMENT_WORKFLOW =
  'The user can leave review comments on the compiled PDF in this server’s local `viewer` ' +
  '(they select text and attach a note). When the user asks you to apply, address, resolve, or ' +
  'act on their PDF comments / feedback / review notes — e.g. “resolve my comments”, ' +
  '“apply my PDF feedback”, “address the comments” — run this loop for the ' +
  'relevant project:\n' +
  '1. Call `list_comments` to get the open comments (each has the note, the selected `quote`, and ' +
  'the source `file`/`line` with a snippet).\n' +
  '2. Make the requested change at each comment’s `file`/`line`, using the `quote` to pin the ' +
  'exact spot when the line is approximate.\n' +
  '3. `compile` to confirm it still builds (the viewer hot-reloads).\n' +
  '4. Call `resolve_comments` (all, or the specific `ids` you handled) so the viewer clears them.\n' +
  'Make all the edits before resolving, and ask rather than guess when a comment is ambiguous.';

/**
 * Wrap each available guide in a short framing sentence so the client knows what it
 * is and when to apply it, then join them into one `instructions` string. The PDF-comment
 * workflow is always included (the comment tools always exist), so instructions are always
 * present even with no writing/concurrency guide.
 */
export function buildInstructions(
  writingGuide?: string,
  concurrencyGuide?: string,
  hasExtra = false,
): string | undefined {
  const sections: string[] = [];
  if (writingGuide) {
    // `hasExtra` travels as data from `composeWritingGuide`, not re-derived by sniffing the text
    // for `EXTRA_GUIDE_HEADING` — a base guide could itself contain that literal heading (a false
    // claim of precedence with no extra guide configured), and an extra-only guide (no base)
    // would otherwise vacuously claim precedence over a "rest of the guide" that doesn't exist.
    sections.push(
      'When reading, writing, editing, or reviewing LaTeX (.tex) files through this ' +
        "server, follow the project's LaTeX writing guide below." +
        (hasExtra
          ? ' Where the "Project-specific conventions" section contradicts the rest of the ' +
            'guide, the project-specific conventions take precedence.'
          : '') +
        '\n\n' +
        writingGuide,
    );
  }
  if (concurrencyGuide) {
    sections.push(
      'When committing or pushing changes through this server, follow the concurrency ' +
        'and safe-push rules below.\n\n' +
        concurrencyGuide,
    );
  }
  sections.push(COMMENT_WORKFLOW);
  return sections.length > 0 ? sections.join('\n\n---\n\n') : undefined;
}

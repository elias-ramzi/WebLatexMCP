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
): string | undefined {
  const sections: string[] = [];
  if (writingGuide) {
    sections.push(
      'When reading, writing, editing, or reviewing LaTeX (.tex) files through this ' +
        "server, follow the project's LaTeX writing guide below.\n\n" +
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

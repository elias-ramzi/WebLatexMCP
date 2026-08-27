import path from 'node:path';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { withFileLock } from './fileLock.js';

/**
 * Thrown when the server has nowhere to write a remembered writing convention because
 * `WEB_LATEX_MCP_WRITING_GUIDE_EXTRA` was never set.
 */
export class WritingConventionsUnconfiguredError extends Error {}

// No seeded heading here: `composeWritingGuide` already supplies `EXTRA_GUIDE_HEADING` (an H2)
// when this file is spliced under it, so seeding an H1 here would outrank/duplicate that heading
// for any heading-level-aware reader. Seed only a short intro line — readable standalone, and
// explaining where the rules below came from.
const INTRO_NOTE =
  'Rules below are added by `add_writing_convention` (the server appends new rules under this line).';

/**
 * Append one writing-convention rule to the user's configured extra writing-guide file.
 *
 * `targetPath` comes from `ctx.config.extraWritingGuidePath` (set from
 * `WEB_LATEX_MCP_WRITING_GUIDE_EXTRA`) and is the ONLY destination this function ever writes to —
 * it deliberately takes no caller-supplied path. A caller-supplied path here would be a write
 * outside every project sandbox, the same reasoning that makes `check_citations` take a
 * registered project id (`bibliographyProject`) rather than accepting a raw `"project:path"`
 * string: a destination the model can name is a destination the model can be tricked into naming.
 * The only way to change where this writes is for the user to set the env var themselves.
 */
export async function appendWritingConvention(
  targetPath: string | undefined,
  rule: string,
  opts?: { owner?: string },
): Promise<{ path: string; created: boolean }> {
  if (!targetPath) {
    throw new WritingConventionsUnconfiguredError(
      'No extra writing guide is configured, so there is nowhere to remember this convention. ' +
        'Set WEB_LATEX_MCP_WRITING_GUIDE_EXTRA to a file path (e.g. ' +
        '/home/user/writing-conventions.md) or a file:// URL (e.g. ' +
        'file:///home/user/writing-conventions.md) and restart the server.',
    );
  }
  const trimmed = rule.trim();
  if (!trimmed) {
    throw new Error('rule must not be empty or whitespace-only.');
  }

  await mkdir(path.dirname(targetPath), { recursive: true });

  return withFileLock(
    `${targetPath}.lock`,
    async () => {
      // `ProjectManager.runExclusive` only serialises writers within one project; this file is
      // shared across every project AND every sibling agent session (each a separate server
      // process over possibly-different clones), so it needs its own cross-process lock rather
      // than riding on a project lock this tool is not even scoped to.
      const created = !(await exists(targetPath));

      const bullet = formatBullet(trimmed);
      if (created) {
        await appendFile(targetPath, `${INTRO_NOTE}\n\n${bullet}`, 'utf8');
      } else {
        // APPEND-ONLY, structurally: appendFile can never rewrite or drop a line the user wrote
        // by hand — there is no read-modify-write step here to race or to clobber a hand edit.
        // Because appending cannot lose a hand edit, this needs no FileRevisionTracker baseline
        // and no overrideExternalChanges flag — the same reasoning add_citation uses.
        const needsNewline = await lacksTrailingNewline(targetPath);
        await appendFile(targetPath, `${needsNewline ? '\n' : ''}${bullet}`, 'utf8');
      }

      return { path: targetPath, created };
    },
    { owner: opts?.owner },
  );
}

/**
 * Format a rule as a markdown bullet; continuation lines of a multi-line rule stay indented.
 *
 * Every line is escaped (`escapeLeadingBlockMarker`) before the bullet/indent prefix is added:
 * a rule's first line is already shielded from being parsed as a heading or blockquote by the
 * `- ` bullet marker in front of it, but a *continuation* line only gets a 2-space indent, and
 * CommonMark still parses an ATX heading (`#`) or blockquote (`>`) with up to 3 leading spaces.
 * Composed guide text is spliced under `EXTRA_GUIDE_HEADING` (an H2) and read by a heading-aware
 * consumer that treats that heading as delimiting the "Project-specific conventions" section —
 * an unescaped `##`/`>` from rule text could open a heading or blockquote that silently ends (or
 * restructures) that section, so a rule must never be able to do that on any of its lines.
 */
function formatBullet(rule: string): string {
  const lines = rule.split('\n').map(escapeLeadingBlockMarker);
  const first = lines[0] ?? '';
  const rest = lines.slice(1).map((line) => `  ${line}`);
  return [`- ${first}`, ...rest].join('\n') + '\n';
}

/**
 * Neutralise a leading heading (`#`) or blockquote (`>`) marker on one line by escaping it with
 * a backslash — which CommonMark renders as the literal character — rather than rejecting the
 * rule outright. Escaping (not rejecting) is chosen so a rule that merely *starts* with one of
 * these characters (e.g. quoting a hashtag, or starting a sentence with "> " as an arrow) is
 * still recorded, byte-preserved apart from the one inserted backslash; only the character that
 * would open a new block is touched, up to 3 leading spaces of indent (CommonMark still parses a
 * heading/blockquote through that much indent) plus the marker itself.
 */
function escapeLeadingBlockMarker(line: string): string {
  return line.replace(/^( {0,3})([#>])/, '$1\\$2');
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function lacksTrailingNewline(p: string): Promise<boolean> {
  const contents = await readFile(p, 'utf8');
  if (contents.length === 0) return false;
  return !contents.endsWith('\n');
}

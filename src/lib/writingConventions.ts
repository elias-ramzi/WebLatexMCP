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

/**
 * Why direct writes to the extra writing-guide file are refused, and the way forward.
 * Returned from `add_writing_convention` when `confirmGuideEdit` is unset.
 *
 * Unlike a `.bib` write — where the guard exists because entry text must come from DBLP,
 * never the model — the text appended here originates from the model by design (a
 * caller-phrased rule). What the guard buys is the user's acknowledgement, because the
 * write lands outside every project sandbox: `targetPath` is loaded into the server's MCP
 * `instructions` at every future startup, so one call quietly changes what every later
 * session is told to do, for every project, until someone edits the file back out.
 */
export function guideEditBlockedMessage(targetPath: string): string {
  return (
    `Writing to "${targetPath}" is outside every project sandbox and takes effect in ` +
    "every future session — it is loaded into the server's instructions at startup, so " +
    'this call would change what every later session is told to do. First ask the user to ' +
    'confirm they want this convention remembered, then retry with confirmGuideEdit: true.'
  );
}

/**
 * Count the top-level markdown bullets in the extra writing-guide file — used by `server_info`
 * to answer "how much accumulated" without re-loading rule text into context.
 *
 * Deliberately a count, not the text: `server_info` is a routine, cheap diagnostic call, and its
 * output must stay bounded regardless of how large the guide has grown. The human audit path is
 * to open the file at the path `server_info` already prints (`writingGuideExtraPath`) — this
 * function exists only to say whether that's worth doing, not to substitute for doing it.
 *
 * Reads the file live, on every call, rather than reusing the startup snapshot the server's MCP
 * `instructions` and the `guide://latex/writing-guide` resource are built from once at boot:
 * `add_writing_convention` can append a rule mid-session, and a count that only ever reflected
 * the snapshot would silently under-report every rule added since the server started — exactly
 * the blind spot this function closes.
 *
 * Counts every top-level bullet in the file, not just ones `add_writing_convention` wrote: a
 * user who hand-edits the file (adds a bullet directly, or pastes one in) gets counted too,
 * because this reads the file as it stands, not a log of append calls. That is intentional — say
 * so at the call site (`server_info`'s schema `.describe()`), not just here, so a caller doesn't
 * mistake this for "rules the server itself appended".
 *
 * A top-level bullet is a line matching `/^[-*+][ \t]/` — no leading whitespace, and any of the
 * three CommonMark bullet markers (`-`, `*`, `+`) followed by a space or a tab. `formatBullet`
 * always writes `-` followed by a space, but a user hand-editing the file is free to use `*` or
 * `+`, or to separate the marker from the text with a tab — all valid top-level CommonMark
 * bullets — and those must count too. Anchoring at column 0 counts one multi-line rule once, not
 * once per line (continuation lines are indented by `formatBullet`), and still excludes a rule
 * whose own text starts with "- " (appended as `- - text`, itself only one match at column 0).
 *
 * Lines inside a fenced code block (delimited by a line starting with ` ``` `, indented by at
 * most the three spaces CommonMark allows) are skipped even when they look like a bullet: a
 * hand-written region quoting `- a\n- b` inside a fence is example text, not a rule, and counting
 * it would over-report. A line of only markers and whitespace (a spaced thematic break such as
 * `* * *` or `- - -`) is not counted either — it matches the bullet shape but carries no rule.
 *
 * Never throws: an unconfigured path, a missing file, or a permission error all resolve to
 * `undefined` rather than failing the call, because `server_info` is a diagnostic tool a caller
 * may run at any time — a guide file that briefly doesn't exist (mid `mkdir`, deleted by hand,
 * on an unmounted volume) must not turn a routine info call into an error.
 */
export async function countWritingConventions(
  targetPath: string | undefined,
): Promise<number | undefined> {
  if (!targetPath) return undefined;
  let contents: string;
  try {
    contents = await readFile(targetPath, 'utf8');
  } catch {
    return undefined;
  }
  const lines = contents.split(/\r\n|\n/);
  let count = 0;
  let inFence = false;
  for (const line of lines) {
    if (/^ {0,3}```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Belt-and-braces: INTRO_NOTE starts with "Rules below are added by", so the bullet test
    // below already rejects it on its own — this branch cannot currently fire. Kept in case
    // INTRO_NOTE's wording ever changes to start with "- ".
    if (line === INTRO_NOTE) continue;
    if (/^[-*+][ \t]/.test(line) && !/^[-*+\s]+$/.test(line)) count += 1;
  }
  return count;
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

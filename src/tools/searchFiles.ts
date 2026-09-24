import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { toPosix } from '../lib/paths.js';
import { searchProject, type SearchOutcome } from '../lib/searchFiles.js';
import { MAX_CONTEXT_LINES, MAX_LINE_SCAN_CHARS } from '../lib/searchMatch.js';
import { SEARCH_MAX_MATCHES, renderMatchesText } from '../lib/searchBudget.js';

const inputSchema = {
  project: z.string().optional(),
  pattern: z
    .string()
    .min(1)
    .describe(
      'What to look for. LITERAL TEXT by default — `\\Cref{tab:sota}` finds exactly that, ' +
        'backslashes and braces included. Set regex: true to have it read as a JavaScript ' +
        'regular expression instead.',
    ),
  regex: z
    .boolean()
    .optional()
    .describe(
      'Read `pattern` as a JavaScript regular expression. Default false. Some shapes are ' +
        'REFUSED with an explanation rather than run — a group repeated without bound ' +
        '(`(a+)+`); a group that can match in more than one way repeated by a count ' +
        '(`(fig|tab){2}`, `(?:a|aa){0,40}`); repeats and alternations that can match what ' +
        'follows them, and so trade input, multiplying past a fixed cost (`.*a.*b`, `a+a+b`, ' +
        '`.*a{999}b` — one such `.*` alone is fine, as in `.*a{0,2}b`); or pieces that can ' +
        'match nothing piled after such repeats (`x{0,75}x*a*b*c*d*\\}`), or runs that all end ' +
        'at one place and hand on to the same costly piece (`x{0,30}x*a+a{11}b`) — because a ' +
        'regex match cannot be interrupted once started, and those take seconds to forever on ' +
        "one long line, which would use up the search's time budget. Anchor each repeat to " +
        'something it cannot match itself (`[^}]*\\}` rather than `.*\\}`), and drop a leading or trailing `.*`: a match anywhere in the line ' +
        'counts, so it does not change which lines match — except with excludeComments, where ' +
        'a leading `.*` starts every hit at the beginning of the line, so dropping it is what ' +
        'lets a hit inside a `%` comment be seen as commented.',
    ),
  caseInsensitive: z.boolean().optional().describe('Match without regard to case. Default false.'),
  filter: z
    .enum(['tex', 'bib', 'docs', 'assets', 'all'])
    .optional()
    .describe(
      'Which files to search, exactly as list_files defines it: tex -> .tex, bib -> .bib, ' +
        'docs -> prose documents (.md/.markdown/.txt/.rst/.org), assets -> images/pdf, all ' +
        '(default). Assets are never searched whichever filter is set — they are reported in ' +
        '"skipped" instead, so "not searched" never reads as "no match".',
    ),
  subdir: z.string().optional().describe('Restrict the search to a subdirectory of the project.'),
  contextLines: z
    .number()
    .int()
    .min(0)
    .max(MAX_CONTEXT_LINES)
    .optional()
    .describe(
      `Lines of context on each side of a hit (0-${MAX_CONTEXT_LINES}, default 0), so a match ` +
        'can be judged without a follow-up read_file. For a whole passage, use read_file with ' +
        'startLine/endLine.',
    ),
  excludeComments: z
    .boolean()
    .optional()
    .describe(
      'Skip matches that begin inside a LaTeX `%` comment (in .tex/.sty/.cls/.bbl/.ltx/.latex ' +
        'only — `%` is not a comment elsewhere). Default false. A `%` preceded by an odd number ' +
        'of backslashes is a literal percent (`50\\%`) and starts no comment; a match that ' +
        'starts in live text and runs past a `%` is live. The count of comment-only hits is ' +
        'reported as `commentMatches` either way, so one call answers "how many of these are ' +
        'live?" — the reason to reach for this is a manuscript that keeps its history in ' +
        'commented-out blocks, where a rename must not touch them.',
    ),
};

const matchShape = z.object({
  path: z.string().describe('Project-relative, POSIX-separated.'),
  line: z.number().describe('1-based line number.'),
  text: z
    .string()
    .describe(
      'The matching line, truncated (or windowed around the first match, marked with `…`) when ' +
        'it is long. A label for the hit, NOT bytes to paste into edit_file — read_file the ' +
        'line range for that.',
    ),
  before: z.array(z.string()).optional().describe('Context lines before, nearest last.'),
  after: z.array(z.string()).optional().describe('Context lines after, nearest first.'),
});

const outputSchema = {
  matches: z
    .array(matchShape)
    .describe(
      'One entry per matching LINE (as `grep -n`), in path then line order. Several matches on ' +
        'one line are one entry.',
    ),
  totalMatches: z
    .number()
    .describe(
      'Every matching line found in the files that were searched. `matches` is a bounded prefix ' +
        'of this; the difference is what the caps and the payload budget cut.',
    ),
  matchedFiles: z.number(),
  filesSearched: z.number().describe('Files actually opened and scanned.'),
  omittedByCap: z.number().describe(`Matches cut by the ${SEARCH_MAX_MATCHES}-match cap.`),
  omittedBySize: z.number().describe('Matches cut by the rendered-size payload budget.'),
  skipped: z
    .array(
      z.object({
        path: z.string(),
        reason: z.enum(['asset', 'too-large', 'binary', 'unreadable']),
      }),
    )
    .describe(
      'Files the walk found and did NOT search: an image or pdf (asset), one over the text read ' +
        'cap (too-large), one whose bytes are not text — a NUL byte (binary), or one that could ' +
        'not be read (unreadable). Bounded; `skippedByReason` counts them all.',
    ),
  skippedCount: z.number(),
  skippedByReason: z.object({
    asset: z.number(),
    'too-large': z.number(),
    binary: z.number(),
    unreadable: z.number(),
  }),
  commentMatches: z
    .number()
    .describe(
      'Matching lines whose matches ALL fell inside a `%` comment — counted whether or not ' +
        'excludeComments is set, so one call tells live hits from commented ones.',
    ),
  linesTruncatedForScan: z
    .number()
    .describe(
      `Lines longer than ${MAX_LINE_SCAN_CHARS} characters, searched only up to that cap: a ` +
        'match further along one of them was not found.',
    ),
  timedOut: z.boolean().describe('The search budget ran out — this is a partial answer.'),
  filesNotReached: z.number().describe('Files the time budget ran out before opening.'),
  filesPartiallySearched: z
    .number()
    .describe(
      'Files the time budget cut off part-way (at most 1): counted in filesSearched, their ' +
        'matches so far reported, and named with the line reached in `note` — a match further ' +
        'down such a file was not looked for.',
    ),
  note: z
    .string()
    .optional()
    .describe(
      'Present only when something was cut or not searched as asked (the time budget, the ' +
        'payload budget, the per-line scan cap, excludeComments meeting files with no % ' +
        'comment syntax); names what.',
    ),
};

export function registerSearchFiles(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'search_files',
    {
      title: 'Search file contents',
      description:
        'Search the CONTENT of a project’s files — the recursive grep the server could not do. ' +
        'Returns {path, line, text} per matching line, optionally with context lines. The ' +
        'pattern is literal text by default (set regex: true for a regular expression); ' +
        'filter/subdir narrow the file set exactly as list_files does. Use it before any ' +
        'cross-file edit: which files cite a retired \\label, where a metric name still ' +
        'appears, which literals never went through the macro. `excludeComments: true` skips ' +
        'hits inside LaTeX `%` comments, and `commentMatches` reports how many there were ' +
        'either way — so a rename can leave a commented-out provenance block untouched. ' +
        'Read-only: it writes nothing, records no read baseline (so it never arms the ' +
        'out-of-band-edit guard, and a later write_file is not refused because of it), and ' +
        'takes NO project lock, so it never waits on a peer session and creates no session ' +
        'state. No git remote needed — works on a local project. Bounded on every axis: some ' +
        'regex shapes are refused outright, long lines are searched only up to a cap, the ' +
        'search runs under a time budget (a regex search runs on a worker thread that is ' +
        'stopped at the deadline, so no pattern can stall the server), and the payload is cut ' +
        'to a character budget — ' +
        'whatever is cut is counted and named in `note`, never dropped silently.',
      inputSchema,
      outputSchema,
    },
    async ({
      project,
      pattern,
      regex,
      caseInsensitive,
      filter,
      subdir,
      contextLines,
      excludeComments,
    }) => {
      try {
        // requireProjectDir, NEVER requireGitProject: this reads project source, which a
        // mode:'local' project has exactly as a clone does. Git-gating it would refuse the
        // draft-with-no-remote case the tool is most useful for.
        const { dir } = await ctx.projectManager.requireProjectDir(project);
        // No runExclusive. Read-only tools do not lock; the three deliberate exceptions
        // (render_pages, pdf_geometry, extract_text) lock because they read the TEMP BUILD DIR a peer
        // session's compile rewrites in place. This reads project source files, where the worst
        // a concurrent write can do is have a line read before or after an edit — the same race
        // any read_file already runs, and not worth making a search wait on (or time out
        // against) a peer holding the lock, nor worth creating <workspace>/.sessions/<id>/ for.
        const result = await searchProject(ctx.files, dir, {
          pattern,
          regex,
          caseInsensitive,
          filter,
          subdir,
          contextLines,
          excludeComments,
        });

        // The response boundary: every path a tool returns is POSIX on every OS. `FileService`
        // already hands these back POSIX-separated, so this is idempotent here — kept anyway so
        // the guarantee is made where the result is built, and because converting can only ever
        // shorten the JSON (a `\` encodes as `\\`), leaving the budget's charge an upper bound.
        const structuredContent = {
          ...result,
          matches: result.matches.map((m) => ({ ...m, path: toPosix(m.path) })),
          skipped: result.skipped.map((s) => ({ ...s, path: toPosix(s.path) })),
        };

        return {
          content: [{ type: 'text' as const, text: render(structuredContent, contextLines ?? 0) }],
          structuredContent: { ...structuredContent },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

/**
 * The findings as text, so a client that drops `structuredContent` still gets the whole report.
 *
 * Rendered from the ALREADY-BUDGETED payload, never from the full one: the two channels ship in
 * the same result, so a text channel built from the uncut list would restore exactly the
 * oversized payload the budget exists to prevent.
 */
function render(r: SearchOutcome, contextLines: number): string {
  if (r.matches.length === 0 && r.totalMatches === 0) {
    const lines = [`No matches in ${r.filesSearched} file(s) searched.`];
    if (r.commentMatches > 0) {
      lines.push(`${r.commentMatches} line(s) matched inside a % comment and were excluded.`);
    }
    if (r.skippedCount > 0) lines.push(skippedLine(r));
    if (r.note) lines.push(r.note);
    return lines.join('\n');
  }

  const lines = [
    `${r.totalMatches} matching line(s) in ${r.matchedFiles} of ${r.filesSearched} file(s) ` +
      `searched${r.matches.length < r.totalMatches ? `, showing ${r.matches.length}` : ''}`,
  ];
  // The template lives beside the budget's cost function, which calls it: what each match is
  // charged for is exactly what is rendered here.
  lines.push(...renderMatchesText(r.matches, contextLines));

  if (r.commentMatches > 0) {
    lines.push(`${r.commentMatches} matching line(s) were % comments.`);
  }
  if (r.skippedCount > 0) lines.push(skippedLine(r));
  if (r.note) lines.push(r.note);
  return lines.join('\n');
}

function skippedLine(r: SearchOutcome): string {
  const by = Object.entries(r.skippedByReason)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${n} ${reason}`)
    .join(', ');
  return `${r.skippedCount} file(s) NOT searched (${by}) — see "skipped".`;
}

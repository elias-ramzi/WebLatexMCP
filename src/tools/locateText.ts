import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import {
  LOCATE_TEXT_DEFAULT_RESULTS,
  LOCATE_TEXT_MAX_CHARS,
  LOCATE_TEXT_MAX_RESULTS,
  locateTextInProject,
} from '../lib/locateText.js';
import { buildLocateTextResult, LOCATE_TEXT_CONTENT_BUDGET } from '../lib/locateTextBudget.js';
import { MIN_WORDS, QUOTE_MAX_FILES } from '../lib/quoteLocate.js';

const inputSchema = {
  project: z.string().optional(),
  text: z
    .string()
    .min(1)
    .max(LOCATE_TEXT_MAX_CHARS)
    .describe(
      'Text copied from the compiled PDF, as pasted — hyphenated line breaks, ligatures and a ' +
        "review copy's margin line numbers (`traf-103\\nfic`, `except 105`) are handled. Anything " +
        'from the first `-->` on is taken as the instruction that followed the copy and dropped. ' +
        `At least ${MIN_WORDS} words.`,
    ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(LOCATE_TEXT_MAX_RESULTS)
    .optional()
    .describe(
      `How many candidate locations to return (1-${LOCATE_TEXT_MAX_RESULTS}, default ` +
        `${LOCATE_TEXT_DEFAULT_RESULTS}). \`matchCount\` always counts them all.`,
    ),
  paths: z
    .array(z.string())
    .max(QUOTE_MAX_FILES)
    .optional()
    .describe(
      'Search only these project-relative .tex files (matched literally). Default: every .tex ' +
        'file of the project.',
    ),
};

const outputSchema = {
  results: z
    .array(
      z.object({
        file: z.string().describe('Project-relative, POSIX-separated.'),
        line: z.number().describe('1-based line the match starts on.'),
        endLine: z.number().describe('1-based line the match ends on.'),
        matchedBy: z
          .enum(['full', 'leading-window', 'trailing-window'])
          .describe(
            'full: every word of the text, in order. leading-window / trailing-window: only its ' +
              'first or last few words (something the PDF shows is not spelled in the source — a ' +
              'citation number, a macro expansion); a leading-window match that a trailing one ' +
              'closes spans both.',
          ),
        snippet: z
          .string()
          .nullable()
          .describe(
            'The live source lines line..endLine, whole-line % comments left out, cut to a few ' +
              'lines of bounded width (cuts marked with …). A label for the hit, NOT bytes to ' +
              'paste into edit_file — read_file the range for that. null when the payload budget ' +
              'cut it (counted in snippetsOmitted).',
          ),
      }),
    )
    .describe('Candidate locations, in file then position order. Never inside a % comment.'),
  matchCount: z.number().describe('Every candidate found; `results` is a bounded prefix.'),
  unique: z.boolean().describe('Exactly one candidate, and every .tex file in scope was searched.'),
  resultsOmitted: z
    .number()
    .describe(
      `Candidates not returned: beyond maxResults or cut by the ${LOCATE_TEXT_CONTENT_BUDGET}-` +
        'character payload budget.',
    ),
  snippetsOmitted: z.number().describe('Returned candidates whose snippet the budget cut.'),
  variant: z
    .enum(['as-pasted', 'margin-numbers-removed', 'none'])
    .describe(
      'Which reading located the text: as pasted (always tried first), with margin line ' +
        'numbers removed (only when the pasted words were found nowhere), or none.',
    ),
  marginNumbersRemoved: z
    .number()
    .describe('Margin line numbers removed in the reading that located it (0 if as-pasted).'),
  instructionDropped: z
    .boolean()
    .describe('A trailing `--> …` instruction was cut from the text before searching.'),
  wordsSearched: z.number(),
  filesSearched: z.number().describe('.tex files read and searched.'),
  skipped: z
    .array(z.object({ path: z.string(), reason: z.enum(['too-large', 'unreadable']) }))
    .describe('.tex files in scope that were NOT searched. Bounded; skippedCount counts all.'),
  skippedCount: z.number(),
  note: z
    .string()
    .optional()
    .describe('Present when something was cut, not searched, or reinterpreted; names what.'),
};

export function registerLocateText(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'locate_text',
    {
      title: 'Locate PDF text in the sources',
      description:
        'Find where text copied from the compiled PDF lives in the LaTeX source — the way to turn ' +
        'a user\'s pasted passage ("<text> --> fix this") into a file and line range before ' +
        'editing it with edit_file. Matches word by word, so PDF artefacts do not get in the way: ' +
        'hyphenation across lines, ligatures, accents, markup between words (\\emph{…}, ' +
        "{\\'e}), and a review copy's margin line numbers glued to line ends. Text inside % " +
        'comments is never a candidate, so a commented-out old version is not confused with ' +
        'the live one. Returns every candidate (up to maxResults) with file, line, endLine, a ' +
        'short snippet of the live lines and how it matched, plus matchCount and unique. ' +
        'Read-only: no git, no compile, no project lock, no read baseline (a later write is not ' +
        'refused because of it). Works on local projects too.',
      inputSchema,
      outputSchema,
    },
    async ({ project, text, maxResults, paths }) => {
      try {
        // requireProjectDir, never requireGitProject: this reads sources, which a local project
        // has exactly as a clone does. No runExclusive: a read of project source, like
        // search_files.
        const { dir } = await ctx.projectManager.requireProjectDir(project);
        const outcome = await locateTextInProject(ctx.files, dir, text, { paths });
        const { result, text: rendered } = buildLocateTextResult(
          outcome,
          maxResults ?? LOCATE_TEXT_DEFAULT_RESULTS,
        );
        return {
          content: [{ type: 'text' as const, text: rendered }],
          structuredContent: { ...result },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

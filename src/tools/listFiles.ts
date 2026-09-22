import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { toPosix } from '../lib/paths.js';
import {
  FILE_LIST_CONTENT_BUDGET,
  TYPE_PRIORITY,
  planFileList,
  renderFileListText,
} from '../lib/fileListBudget.js';

const inputSchema = {
  project: z.string().optional(),
  filter: z
    .enum(['tex', 'bib', 'docs', 'assets', 'all'])
    .optional()
    .describe(
      'tex -> .tex, bib -> .bib, docs -> prose documents (.md/.markdown/.txt/.rst/.org), ' +
        'assets -> images/pdf, all (default). This narrows the WALK, so it is the way to get ' +
        'entries back that the payload budget omitted.',
    ),
  subdir: z
    .string()
    .optional()
    .describe(
      'Restrict listing to a subdirectory of the project. Narrows the walk itself, so — like ' +
        'filter — it brings back entries the payload budget omitted.',
    ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Return at most this many entries. Only ever NARROWS: the character budget below is fixed ' +
        'and cannot be raised, so omitting this asks for as many as fit.',
    ),
};

const outputSchema = {
  files: z
    .array(
      z.object({
        path: z.string().describe('Project-relative, POSIX-separated.'),
        type: z.enum(['tex', 'bib', 'doc', 'asset', 'other']),
        sizeBytes: z.number(),
      }),
    )
    .describe(
      'The listing, in path order. An EMPTY array means nothing matched — a cut never produces ' +
        'one (at least one entry is always returned), and a cut always shows as ' +
        'files.length < totalFiles with a non-zero counter and a note.',
    ),
  totalFiles: z
    .number()
    .describe(
      'Every matching file the walk found. `files` is a bounded subset of this; the difference ' +
        'is what the counters below account for.',
    ),
  omittedByCap: z.number().describe('Entries cut by the caller-supplied `maxResults`.'),
  omittedBySize: z
    .number()
    .describe(
      `Entries cut by the ${FILE_LIST_CONTENT_BUDGET}-character payload budget, which is ` +
        'charged across both channels (the JSON array and the rendered text lines).',
    ),
  omittedByType: z
    .object({
      tex: z.number(),
      bib: z.number(),
      doc: z.number(),
      other: z.number(),
      asset: z.number(),
    })
    .optional()
    .describe(
      'What was cut, by type — present only when something was cut. Entries are kept in the ' +
        `priority order ${TYPE_PRIORITY.join(' > ')}, so this says which classes went.`,
    ),
  note: z
    .string()
    .optional()
    .describe('Present only when something was cut; names the bound that fired and the remedy.'),
};

export function registerListFiles(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'list_files',
    {
      title: 'List project files',
      description:
        'List files in a project, optionally filtered to .tex / .bib / prose documents / ' +
        'assets. Works on a local project as well as a clone. Bounded: the listing is cut to a ' +
        'character budget charged across both channels, keeping ' +
        `${TYPE_PRIORITY.join(' > ')} in that order — so a figures tree with thousands of ` +
        'entries never starves the .tex sources. Whatever is cut is counted (totalFiles, ' +
        'omittedBySize, omittedByType) and named in `note`, never dropped silently; narrow with ' +
        'subdir or filter to get it back.',
      inputSchema,
      outputSchema,
    },
    async ({ project, filter = 'all', subdir, maxResults }) => {
      try {
        const { dir } = await ctx.projectManager.requireProjectDir(project);
        const files = await ctx.files.list(dir, { filter, subdir });
        // The response boundary: every path a tool returns is POSIX on every OS. `FileService`
        // already hands these back POSIX-separated, so this is idempotent here — kept anyway so
        // the guarantee is made where the result is built, and applied BEFORE the planner so the
        // budget charges the exact bytes that ship.
        const plan = planFileList(
          files.map((f) => ({ ...f, path: toPosix(f.path) })),
          { maxResults },
        );
        return {
          content: [{ type: 'text' as const, text: renderFileListText(plan) }],
          structuredContent: { ...plan },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

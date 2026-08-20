import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';

const inputSchema = {
  project: z.string().optional(),
  includeResolved: z
    .boolean()
    .optional()
    .describe('Include already-resolved comments too (default false: only open ones).'),
};

const commentShape = z.object({
  id: z.string(),
  number: z
    .number()
    .describe(
      'The #N the user sees in the viewer: position among open comments, always 1..N. It is ' +
        'renumbered whenever comments are resolved or deleted, so always act on `id`, not on a ' +
        'number remembered from an earlier listing.',
    ),
  page: z.number(),
  note: z.string(),
  quote: z.string().optional().describe('The PDF text the user selected, if any.'),
  file: z.string().optional().describe('Source file (project-relative), when synctex resolved it.'),
  line: z.number().optional().describe('Source line, when synctex resolved it.'),
  snippet: z.string().optional().describe('A few source lines around `line` for context.'),
  resolved: z.boolean(),
});

const outputSchema = {
  comments: z.array(commentShape),
};

/** How many source lines of context to include on either side of a comment's line. */
const CONTEXT_LINES = 2;

export function registerListComments(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'list_comments',
    {
      title: 'List PDF review comments',
      description:
        'List the comments the user attached to the compiled PDF in the viewer. Each comment has ' +
        'the note, the selected PDF text (`quote`), and — when SyncTeX resolved it — the source ' +
        '`file`/`line` plus a snippet of surrounding source. Use these to make the requested edits, ' +
        'then call resolve_comments so the viewer marks them done. Default lists only open comments.',
      inputSchema,
      outputSchema,
    },
    async ({ project, includeResolved }) => {
      try {
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        const comments = ctx.comments.list(id, { includeResolved });

        const enriched = await Promise.all(
          comments.map(async (c) => {
            let snippet: string | undefined;
            if (c.file && c.line) {
              try {
                const start = Math.max(1, c.line - CONTEXT_LINES);
                const res = await ctx.files.read(dir, {
                  path: c.file,
                  startLine: start,
                  endLine: c.line + CONTEXT_LINES,
                });
                snippet = res.content;
              } catch {
                // File may have moved/been deleted since the comment was made — skip the snippet.
              }
            }
            return {
              id: c.id,
              number: c.number,
              page: c.page,
              note: c.note,
              quote: c.quote,
              file: c.file,
              line: c.line,
              snippet,
              resolved: c.resolved,
            };
          }),
        );

        const text = enriched.length
          ? enriched
              .map((c) => {
                const loc = c.file ? `${c.file}:${c.line}` : `(unresolved — page ${c.page})`;
                const quote = c.quote ? `\n   quote: "${c.quote}"` : '';
                const snip = c.snippet ? `\n   source:\n${indent(c.snippet)}` : '';
                return `#${c.number} [${c.id}] ${loc}\n   note: ${c.note}${quote}${snip}`;
              })
              .join('\n\n')
          : 'No open comments.';

        return {
          content: [{ type: 'text', text }],
          structuredContent: { comments: enriched },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

function indent(s: string): string {
  return s
    .split('\n')
    .map((l) => `     ${l}`)
    .join('\n');
}

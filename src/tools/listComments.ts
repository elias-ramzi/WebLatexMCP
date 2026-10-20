import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { commentSurface, isOwnDocComment } from '../lib/docComments.js';
import {
  COMMENT_NOTE_CAP,
  planCommentsPayload,
  renderCommentsText,
} from '../lib/commentsBudget.js';
import {
  readDocumentLines,
  readSourceLines,
  sliceSnippet,
  unopenablePaths,
  withoutUnopenableLocation,
} from '../lib/sourceSnippet.js';

const inputSchema = {
  project: z.string().optional(),
  includeResolved: z
    .boolean()
    .optional()
    .describe('Include already-resolved comments too (default false: only open ones).'),
  document: z
    .string()
    .optional()
    .describe(
      'Only the comments made on this markdown document in the viewer (its project-relative ' +
        'path, as passed to `viewer`). Omit to list every comment — the PDF and every document.',
    ),
  pdfOnly: z
    .boolean()
    .optional()
    .describe(
      'Only the comments made on the compiled PDF — none from documents. Ignored when ' +
        '`document` is given.',
    ),
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
  page: z
    .number()
    .optional()
    .describe('The PDF page the comment was made on. Absent for a comment on a markdown document.'),
  document: z
    .string()
    .optional()
    .describe(
      'The markdown document the comment was made on in the viewer (project-relative). Then ' +
        '`file` is that document and `line` the source line the server matched the selection to. ' +
        'Absent for a PDF comment.',
    ),
  note: z
    .string()
    .describe(
      "The user's own typed note. Never dropped — it is the one field with no copy anywhere " +
        `else a tool can reach — but clipped past ${COMMENT_NOTE_CAP} characters, and then ` +
        '`noteOmittedChars` says how many went.',
    ),
  noteOmittedChars: z
    .number()
    .optional()
    .describe('Characters cut from the end of `note`. Absent when the note is complete.'),
  quote: z
    .string()
    .optional()
    .describe(
      'The text the user selected (in the PDF or the document), if any — clipped, or dropped entirely, when the result ' +
        'budget runs short. Absent WITHOUT `quoteOmittedChars` means the user selected no text; ' +
        'absent WITH one means it was cut, and the selection is still highlighted in the viewer.',
    ),
  quoteOmittedChars: z
    .number()
    .optional()
    .describe(
      'Characters of `quote` not shown — a clip when `quote` is present, the whole quote when it ' +
        'is absent. Absent when nothing was cut.',
    ),
  file: z
    .string()
    .optional()
    .describe(
      'Source file (project-relative), when synctex resolved it — and when the path it resolved ' +
        'to stays inside the project: a synctex record is written from the document, so one ' +
        'pointing out through a symlink is not handed back as somewhere to read.',
    ),
  line: z.number().optional().describe('Source line, when synctex resolved it.'),
  snippet: z
    .string()
    .optional()
    .describe(
      'The 5 source lines around `line` (2 either side, clamped at the file bounds), so the ' +
        "comment can be acted on without a read_file. Same shape as `compile`'s error snippets.",
    ),
  snippetStartLine: z
    .number()
    .optional()
    .describe("1-based source line of `snippet`'s first line, so the caller can number it."),
  snippetOmittedChars: z
    .number()
    .optional()
    .describe(
      'Characters of `snippet` not shown. A snippet is all-or-nothing, so this is its full ' +
        'length, and its presence is what tells a budget cut apart from the innocent reasons a ' +
        'snippet can be absent (no synctex location, a file that moved, a withheld path). ' +
        'read_file at `file`:`line` fetches it back.',
    ),
  resolved: z.boolean(),
});

const outputSchema = {
  comments: z.array(commentShape),
  commentsOmitted: z
    .number()
    .describe(
      'Comments not listed at all, because even their identity and note did not fit the budget. ' +
        'They are still in the viewer: resolve the ones already handled and list again to reach ' +
        'them. 0 whenever every comment is listed.',
    ),
  quotesOmitted: z
    .number()
    .describe(
      'Listed comments whose `quote` was dropped entirely. A clipped-but-shown quote is not ' +
        'counted here; it is reported per comment as `quoteOmittedChars`.',
    ),
  snippetsOmitted: z.number().describe('Listed comments whose source `snippet` was dropped.'),
  truncated: z
    .boolean()
    .describe(
      'True iff anything at all was cut, clips included. Never inferred from an empty ' +
        '`comments`: an empty list means there are no open comments.',
    ),
  budgetNote: z
    .string()
    .optional()
    .describe(
      'What was cut and how to get it back. Present only when something actually was. Called ' +
        "`budgetNote` rather than `note` because `comments[].note` is the user's own text.",
    ),
};

export function registerListComments(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'list_comments',
    {
      title: 'List viewer review comments',
      description:
        'List the comments the user attached in the viewer — to the compiled PDF, or to a markdown ' +
        'document opened with `viewer` `document` (e.g. a review report). Each comment has the ' +
        'note, the selected text (`quote`), and the source `file`/`line` — via SyncTeX for a PDF ' +
        'comment, the document and its matched line for a document comment (which carries ' +
        '`document` and no `page`) — plus a snippet of surrounding source. Pass `document` to list ' +
        "one document's comments only, or `pdfOnly` for the PDF's. Use these to make the requested edits, " +
        'then call resolve_comments so the viewer marks them done. Default lists only open ' +
        'comments. The result is budgeted: on a long review pass the snippets go first, then the ' +
        'quotes, and only then whole comments — every listed comment keeps its id, location and ' +
        'note, and `truncated`/`budgetNote` say what went.',
      inputSchema,
      outputSchema,
    },
    async ({ project, includeResolved, document, pdfOnly }) => {
      try {
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        const comments = ctx.comments.list(id, {
          includeResolved,
          document: commentSurface(document, pdfOnly),
        });

        // Comments cluster in the file under review, so read each file once rather than once per
        // comment. Records no baseline: the caller asked for the comments, not for these files,
        // and five lines of one is not something they could base a write on — same contract as
        // compile's snippets (see FileService.read).
        // A document comment's `file` is the document the viewer opened, not a path a log named, so
        // it is read by its own rule (readDocumentLines); the key keeps the two kinds apart.
        const sourceOf = new Map<string, string[] | undefined>();
        const keyOf = (c: { file?: string; document?: string }): string =>
          (isOwnDocComment(c) ? 'doc:' : 'src:') + c.file;
        for (const c of comments) {
          if (c.file && c.line && !sourceOf.has(keyOf(c))) {
            const lines = isOwnDocComment(c)
              ? await readDocumentLines(ctx.files, dir, c.file)
              : await readSourceLines(ctx.files, dir, c.file);
            sourceOf.set(keyOf(c), lines);
          }
        }
        // Same rule as compile's diagnostics: a path the *document* chose that leaves the project
        // through a symlink is not reported as openable, not merely left without a snippet. A
        // document comment on its own document is exempt: its `file` is the document the viewer
        // read under the project owner's link policy, not a path a synctex record chose.
        const withheld = await unopenablePaths(
          ctx.files,
          dir,
          comments.filter((c) => !isOwnDocComment(c)),
        );

        const enriched = await Promise.all(
          comments.map(async (raw) => {
            // An own-document comment was checked when it was made; if its document can no
            // longer be read (deleted, or since replaced by a link out of the project), its
            // location is withheld rather than handed back as somewhere read_file will refuse.
            const c = isOwnDocComment(raw)
              ? sourceOf.get(keyOf(raw)) === undefined
                ? withoutUnopenableLocation(raw, new Set([raw.file!]))
                : raw
              : withoutUnopenableLocation(raw, withheld.all);
            let snippet: string | undefined;
            let snippetStartLine: number | undefined;
            if (c.file && c.line) {
              const lines = sourceOf.get(keyOf(c));
              // The file may have moved or shrunk since the comment was made — then no snippet.
              const slice = lines && sliceSnippet(lines, c.line);
              snippet = slice?.snippet;
              snippetStartLine = slice?.snippetStartLine;
            }
            return {
              id: c.id,
              number: c.number,
              page: c.page,
              document: c.document,
              note: c.note,
              quote: c.quote,
              file: c.file,
              line: c.line,
              snippet,
              snippetStartLine,
              resolved: c.resolved,
            };
          }),
        );

        // The budget runs LAST, over comments the unopenable-path guard has already stripped, and
        // it only ever removes fields — so no withheld `file`/`line`/`snippet` can come back
        // through it. Both channels are rendered from the plan and from nothing else (#163).
        const plan = planCommentsPayload(enriched);

        return {
          content: [{ type: 'text', text: renderCommentsText(plan) }],
          structuredContent: { ...plan },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

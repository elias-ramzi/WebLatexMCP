import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { parseReferences, type ReferenceEntry } from '../lib/references.js';
import { referenceSourceCandidates } from '../lib/referenceSources.js';

const inputSchema = {
  project: z.string().optional(),
  path: z
    .string()
    .optional()
    .describe(
      'A single file to read references from — a .bib, a .tex with a thebibliography, or a ' +
        'markdown/plain-text document with a reference list. Omit to scan the whole project.',
    ),
  filter: z
    .string()
    .optional()
    .describe(
      'Case-insensitive substring; keeps entries whose key, title, authors, venue, year or raw ' +
        'text contains it. Use it to answer "is Author 2025 in here?" without reading the file.',
    ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      'Cap on entries returned (default 200). Narrow with `filter` rather than raising it.',
    ),
};

const entrySchema = z.object({
  path: z.string().describe('File the entry was read from, relative to the project root.'),
  line: z.number().describe('1-based line where the entry starts.'),
  format: z
    .enum(['bibtex', 'bibitem', 'prose'])
    .describe(
      'How the entry was written, and so how far the parsed fields can be trusted: `bibtex` is ' +
        'exact, `bibitem` has an exact key and free-text rest, `prose` is entirely heuristic — ' +
        'fall back to `raw` whenever a prose field looks wrong or is missing.',
    ),
  key: z.string().optional().describe('Cite key. Absent for prose entries, which are numbered.'),
  label: z.string().optional().describe('How a numbered prose list refers to the entry ("1").'),
  type: z.string().optional().describe('BibTeX entry type (article, inproceedings, …).'),
  title: z.string().optional(),
  authors: z.array(z.string()),
  truncatedAuthors: z
    .boolean()
    .describe('The author list is abbreviated (`and others` / "et al."), so it will print short.'),
  year: z.number().optional(),
  venue: z.string().optional(),
  doi: z.string().optional(),
  url: z.string().optional(),
  arxivId: z.string().optional(),
  raw: z
    .string()
    .describe('The entry exactly as written — authoritative when a field is doubtful.'),
});

const outputSchema = {
  count: z.number().describe('Entries returned (after `filter`).'),
  totalCount: z.number().describe('Entries found before `filter` and `maxResults` were applied.'),
  truncated: z.boolean(),
  sources: z.array(z.object({ path: z.string(), format: z.string(), count: z.number() })),
  entries: z.array(entrySchema),
};

type Located = ReferenceEntry & { path: string };

function matches(entry: Located, needle: string): boolean {
  const haystack = [
    entry.key,
    entry.label,
    entry.title,
    entry.venue,
    entry.year?.toString(),
    entry.doi,
    ...entry.authors,
    entry.raw,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

function formatEntry(entry: Located): string {
  const id = entry.key ?? (entry.label ? `[${entry.label}]` : '—');
  const authors = entry.authors.length
    ? `${entry.authors.join(', ')}${entry.truncatedAuthors ? ' et al.' : ''}`
    : entry.format === 'prose'
      ? '(authors not split out — see raw)'
      : '(no author field)';
  const where = [entry.venue, entry.year].filter(Boolean).join(' ');
  const title = entry.title ?? entry.raw.slice(0, 120);
  return (
    `${id} — ${title}\n  ${authors}${where ? ` — ${where}` : ''}\n` +
    `  ${entry.path}:${entry.line} (${entry.format})`
  );
}

export function registerListReferences(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'list_references',
    {
      title: 'List a project’s references, structured',
      description:
        'Parse the references OUT OF THE PROJECT (not from the internet) and return them ' +
        'structured — cite key, type, title, authors, year, venue, DOI/arXiv, and the file and ' +
        'line each one sits on. Reads three shapes of bibliography: a BibTeX .bib (fields are ' +
        'exact, @string macros resolved), a LaTeX thebibliography of \\bibitem entries, and a ' +
        'reference list written as prose in a markdown or plain-text document. Use this instead ' +
        'of read_file + regex to answer "does this reference exist?" or "find the entry for ' +
        'Author 2025" — pass `filter` to search. To look a paper UP on DBLP instead, use ' +
        'search_references. Read-only, and it needs no git remote, so it works on a local project.',
      inputSchema,
      outputSchema,
    },
    async ({ project, path: relPath, filter, maxResults = 200 }) => {
      try {
        const { dir } = await ctx.projectManager.requireProjectDir(project);
        const candidates = relPath ? [relPath] : await referenceSourceCandidates(ctx, dir);

        const sources: Array<{ path: string; format: string; count: number }> = [];
        const found: Located[] = [];
        for (const candidate of candidates) {
          const text = await ctx.files.readText(dir, candidate);
          if (!text) continue;
          const parsed = parseReferences(text, candidate);
          if (parsed.length === 0) continue;
          const formats = [...new Set(parsed.map((e) => e.format))].join('+');
          sources.push({ path: candidate, format: formats, count: parsed.length });
          found.push(...parsed.map((e) => ({ ...e, path: candidate })));
        }

        const needle = filter?.trim().toLowerCase();
        const filtered = needle ? found.filter((e) => matches(e, needle)) : found;
        const entries = filtered.slice(0, maxResults);
        const truncated = filtered.length > entries.length;

        const header = relPath
          ? `${entries.length} reference(s) in ${relPath}`
          : sources.length === 0
            ? 'No references found. Point `path` at the file that holds them.'
            : `${entries.length} reference(s) across ${sources.length} file(s): ` +
              sources.map((s) => `${s.path} (${s.count}, ${s.format})`).join(', ');
        const filterNote = needle ? ` matching "${filter}"` : '';
        const truncNote = truncated
          ? `\n\n(${filtered.length - entries.length} more not shown — narrow with \`filter\`.)`
          : '';
        const body = entries.map(formatEntry).join('\n\n');

        return {
          content: [
            {
              type: 'text',
              text: `${header}${filterNote}${body ? `\n\n${body}` : ''}${truncNote}`,
            },
          ],
          structuredContent: {
            count: entries.length,
            totalCount: found.length,
            truncated,
            sources,
            entries,
          },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

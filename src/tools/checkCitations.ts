import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import {
  extractCitations,
  isProseDocument,
  missingRequiredFields,
  parseReferences,
  type ReferenceEntry,
} from '../lib/references.js';
import { citingDocumentCandidates, referenceSourceCandidates } from '../lib/referenceSources.js';

const inputSchema = {
  project: z.string().optional(),
  documents: z
    .array(z.string())
    .optional()
    .describe(
      'Files whose citations to collect (.tex, or markdown/plain-text using pandoc `[@key]`). ' +
        'Omit to use every .tex and prose document in the project.',
    ),
  bibliography: z
    .array(z.string())
    .optional()
    .describe(
      'Files holding the reference entries — a .bib, or a .tex with a thebibliography. Omit to ' +
        'use every bibliography the project has. Point this at another project’s .bib by ' +
        'registering that project and checking there instead; paths stay inside one project.',
    ),
};

const placeSchema = z.object({ path: z.string(), line: z.number() });

const outputSchema = {
  documents: z.array(z.string()).describe('Files whose citations were collected.'),
  bibliographySources: z.array(z.string()).describe('Files the reference entries came from.'),
  entryCount: z.number(),
  citationCount: z.number().describe('Distinct cite keys used across the documents.'),
  undefinedCitations: z
    .array(z.object({ key: z.string(), uses: z.array(placeSchema) }))
    .describe('Cited in a document but absent from every bibliography — these break the build.'),
  uncitedEntries: z
    .array(
      z.object({
        key: z.string(),
        path: z.string(),
        line: z.number(),
        title: z.string().optional(),
      }),
    )
    .describe('In the bibliography but never cited — dead weight, not an error.'),
  duplicateKeys: z
    .array(z.object({ key: z.string(), occurrences: z.array(placeSchema) }))
    .describe('The same cite key defined more than once; later definitions are ignored.'),
  incompleteEntries: z
    .array(
      z.object({
        key: z.string(),
        path: z.string(),
        line: z.number(),
        type: z.string().optional(),
        missing: z.array(z.string()),
      }),
    )
    .describe('BibTeX entries missing a field their type requires ("a|b" means either will do).'),
};

type Located = ReferenceEntry & { path: string };

/** Read and parse each named source, keeping only the ones that actually carry entries. */
async function collectEntries(
  ctx: AppContext,
  dir: string,
  paths: string[],
): Promise<{ entries: Located[]; sources: string[] }> {
  const entries: Located[] = [];
  const sources: string[] = [];
  for (const rel of paths) {
    const text = await ctx.files.readText(dir, rel);
    if (!text) continue;
    const parsed = parseReferences(text, rel).filter((e) => e.key);
    if (parsed.length === 0) continue;
    sources.push(rel);
    entries.push(...parsed.map((e) => ({ ...e, path: rel })));
  }
  return { entries, sources };
}

export function registerCheckCitations(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'check_citations',
    {
      title: 'Cross-check citations against the bibliography',
      description:
        'Cross-reference what the document CITES against what the bibliography DEFINES, in one ' +
        'call: keys cited with no entry (these break the build), entries never cited, cite keys ' +
        'defined twice, and BibTeX entries missing a field their type requires. Reads \\cite / ' +
        '\\citep / \\textcite / \\autocite and friends in .tex, and pandoc `[@key]` in markdown, ' +
        'against .bib files and \\bibitem lists. This is the regex diff you would otherwise write ' +
        'by hand. It does NOT check whether a reference is factually correct — that is ' +
        'search_references against DBLP, or the verify-citations skill. Read-only; no git remote ' +
        'needed, so it works on a local project.',
      inputSchema,
      outputSchema,
    },
    async ({ project, documents, bibliography }) => {
      try {
        const { dir } = await ctx.projectManager.requireProjectDir(project);

        const bibPaths = bibliography ?? (await referenceSourceCandidates(ctx, dir));
        const { entries, sources } = await collectEntries(ctx, dir, bibPaths);
        if (entries.length === 0) {
          throw new Error(
            'No reference entries found. Pass `bibliography` with the file that holds them ' +
              '(a .bib, or the .tex carrying the thebibliography environment).',
          );
        }

        const docPaths = documents ?? (await citingDocumentCandidates(ctx, dir));
        // A file that defines the bibliography inline still cites from its own prose, so it is not
        // excluded here; a .bib never cites anything and is filtered out by the candidate list.
        const uses = new Map<string, Array<{ path: string; line: number }>>();
        const scanned: string[] = [];
        for (const rel of docPaths) {
          const text = await ctx.files.readText(dir, rel);
          if (!text) continue;
          scanned.push(rel);
          for (const use of extractCitations(text, { markdown: isProseDocument(rel) })) {
            const list = uses.get(use.key) ?? [];
            list.push({ path: rel, line: use.line });
            uses.set(use.key, list);
          }
        }

        const defined = new Map<string, Located[]>();
        for (const entry of entries) {
          const list = defined.get(entry.key!) ?? [];
          list.push(entry);
          defined.set(entry.key!, list);
        }

        const undefinedCitations = [...uses.entries()]
          .filter(([key]) => !defined.has(key))
          .map(([key, places]) => ({ key, uses: places }))
          .sort((a, b) => a.key.localeCompare(b.key));

        const uncitedEntries = entries
          .filter((e) => !uses.has(e.key!))
          .map((e) => ({ key: e.key!, path: e.path, line: e.line, title: e.title }))
          .sort((a, b) => a.key.localeCompare(b.key));

        const duplicateKeys = [...defined.entries()]
          .filter(([, list]) => list.length > 1)
          .map(([key, list]) => ({
            key,
            occurrences: list.map((e) => ({ path: e.path, line: e.line })),
          }))
          .sort((a, b) => a.key.localeCompare(b.key));

        const incompleteEntries = entries
          .map((e) => ({
            key: e.key!,
            path: e.path,
            line: e.line,
            type: e.type,
            missing: missingRequiredFields(e),
          }))
          .filter((e) => e.missing.length > 0)
          .sort((a, b) => a.key.localeCompare(b.key));

        const result = {
          documents: scanned,
          bibliographySources: sources,
          entryCount: entries.length,
          citationCount: uses.size,
          undefinedCitations,
          uncitedEntries,
          duplicateKeys,
          incompleteEntries,
        };

        return {
          content: [{ type: 'text', text: render(result) }],
          structuredContent: { ...result },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

interface Report {
  documents: string[];
  bibliographySources: string[];
  entryCount: number;
  citationCount: number;
  undefinedCitations: Array<{ key: string; uses: Array<{ path: string; line: number }> }>;
  uncitedEntries: Array<{ key: string; path: string; line: number; title?: string }>;
  duplicateKeys: Array<{ key: string; occurrences: Array<{ path: string; line: number }> }>;
  incompleteEntries: Array<{ key: string; path: string; line: number; missing: string[] }>;
}

/** The findings as text, so a client that drops `structuredContent` still gets the whole report. */
function render(r: Report): string {
  const lines = [
    `${r.entryCount} entries in ${r.bibliographySources.join(', ') || '(none)'} · ` +
      `${r.citationCount} distinct keys cited across ${r.documents.length} document(s)`,
  ];
  const section = (title: string, items: string[]): void => {
    if (items.length === 0) return;
    lines.push('', `${title} (${items.length}):`, ...items.map((i) => `  ${i}`));
  };
  section(
    'Cited but not defined',
    r.undefinedCitations.map(
      (u) => `${u.key} — ${u.uses.map((x) => `${x.path}:${x.line}`).join(', ')}`,
    ),
  );
  section(
    'Defined but never cited',
    r.uncitedEntries.map((e) => `${e.key} (${e.path}:${e.line})${e.title ? ` — ${e.title}` : ''}`),
  );
  section(
    'Duplicate keys',
    r.duplicateKeys.map(
      (d) => `${d.key} — ${d.occurrences.map((x) => `${x.path}:${x.line}`).join(', ')}`,
    ),
  );
  section(
    'Missing required fields',
    r.incompleteEntries.map((e) => `${e.key} (${e.path}:${e.line}) — ${e.missing.join(', ')}`),
  );
  if (lines.length === 1) lines.push('', 'No problems found.');
  return lines.join('\n');
}

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
        'use every bibliography the project has. Resolved inside `bibliographyProject` when that ' +
        'is set, otherwise inside `project`.',
    ),
  bibliographyProject: z
    .string()
    .optional()
    .describe(
      'Check against ANOTHER registered project’s bibliography — a shared group .bib the draft ' +
        'cites but does not contain. `documents` still resolve in `project` and `bibliography` in ' +
        'this one, each sandboxed to its own project. Findings are then limited to entries this ' +
        'draft actually cites: a shared bibliography is not dead weight for one draft, so ' +
        'uncitedEntries comes back empty (run check_citations inside that project to audit it).',
    ),
};

const placeSchema = z.object({ path: z.string(), line: z.number() });

const outputSchema = {
  documents: z.array(z.string()).describe('Files whose citations were collected.'),
  bibliographySources: z.array(z.string()).describe('Files the reference entries came from.'),
  bibliographyProject: z
    .string()
    .optional()
    .describe(
      'Set only when the bibliography came from a DIFFERENT project than the documents; ' +
        '`bibliographySources` paths are then relative to that project’s root, and every finding ' +
        'below is limited to the keys these documents cite.',
    ),
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
    .describe(
      'In the bibliography but never cited — dead weight, not an error. Always empty when ' +
        '`bibliographyProject` is set: a shared bibliography is meant to hold entries this draft ' +
        'does not cite, so listing them would be noise. Audit it by running check_citations ' +
        'inside that project.',
    ),
  duplicateKeys: z
    .array(z.object({ key: z.string(), occurrences: z.array(placeSchema) }))
    .describe(
      'The same cite key defined more than once; later definitions are ignored. Limited to cited ' +
        'keys when `bibliographyProject` is set.',
    ),
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
    .describe(
      'BibTeX entries missing a field their type requires ("a|b" means either will do). Limited ' +
        'to cited entries when `bibliographyProject` is set.',
    ),
};

type Located = ReferenceEntry & { path: string };

/**
 * Read and parse each named source, keeping the entries that carry a cite key.
 *
 * `keyless` counts the ones dropped for having none — a prose reference list is numbered, not keyed.
 * Those are real references, so "none found" would be a lie; the caller uses the count to say what
 * actually happened instead.
 */
async function collectEntries(
  ctx: AppContext,
  dir: string,
  paths: string[],
): Promise<{ entries: Located[]; sources: string[]; keyless: number; keylessIn: string[] }> {
  const entries: Located[] = [];
  const sources: string[] = [];
  const keylessIn: string[] = [];
  let keyless = 0;
  for (const rel of paths) {
    // The caller receives these entries, `raw` included, so this read is the caller's — see
    // FileService.read on why that decides whether it claims the baseline.
    const text = await ctx.files.readText(dir, rel, { recordBaseline: true });
    if (!text) continue;
    const parsed = parseReferences(text, rel);
    const keyed = parsed.filter((e) => e.key);
    if (parsed.length > keyed.length) {
      keyless += parsed.length - keyed.length;
      keylessIn.push(rel);
    }
    if (keyed.length === 0) continue;
    sources.push(rel);
    entries.push(...keyed.map((e) => ({ ...e, path: rel })));
  }
  return { entries, sources, keyless, keylessIn };
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
        'search_references against DBLP, or the verify-citations skill. Pass ' +
        '`bibliographyProject` to check a draft against a SHARED bibliography that lives in ' +
        'another registered project. Read-only; no git remote needed, so it works on a local ' +
        'project.',
      inputSchema,
      outputSchema,
    },
    async ({ project, documents, bibliography, bibliographyProject }) => {
      try {
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        // Resolved separately, so each path stays sandboxed inside the project it belongs to —
        // the boundary that makes reading across two registered projects safe.
        const bib =
          bibliographyProject === undefined
            ? { id, dir }
            : await ctx.projectManager.requireProjectDir(bibliographyProject);
        // A `bibliographyProject` that resolves to the project we are already in is not foreign,
        // whatever the caller typed — naming the same project (or the default) must not silently
        // narrow the report.
        const foreign = bib.id !== id;
        const where = foreign ? ` in project "${bib.id}"` : '';

        const bibPaths = bibliography ?? (await referenceSourceCandidates(ctx, bib.dir));
        const { entries, sources, keyless, keylessIn } = await collectEntries(
          ctx,
          bib.dir,
          bibPaths,
        );
        if (entries.length === 0) {
          // Found references, but they are numbered rather than keyed — a prose reference list.
          // There is nothing to cross-reference *by*, so say that rather than "none found".
          if (keyless > 0) {
            throw new Error(
              `Found ${keyless} reference(s) in ${keylessIn.join(', ')}${where}, but none carry a cite ` +
                'key — they are a numbered/prose reference list. check_citations matches cite keys, ' +
                'so there is nothing here to cross-reference. Use list_references to read the list, ' +
                'and verify each entry against DBLP with search_references.',
            );
          }
          throw new Error(
            `No reference entries found${where}. Pass \`bibliography\` with the file that holds ` +
              'them (a .bib, or the .tex carrying the thebibliography environment).',
          );
        }

        const docPaths = documents ?? (await citingDocumentCandidates(ctx, dir));
        // A file that defines the bibliography inline still cites from its own prose, so it is not
        // excluded here; a .bib never cites anything and is filtered out by the candidate list.
        const uses = new Map<string, Array<{ path: string; line: number }>>();
        const scanned: string[] = [];
        for (const rel of docPaths) {
          // Ditto: the caller is handed every citation site in these documents, and will act on
          // them, so a later write must still be able to tell that the file moved underneath it.
          const text = await ctx.files.readText(dir, rel, { recordBaseline: true });
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

        // A bibliography belonging to another project is reported on only where this draft
        // touches it. A shared group .bib is *supposed* to hold hundreds of entries this draft
        // does not cite, and its formatting defects are its own project's business — listing them
        // all would bury the one finding that matters under the noise the caller came here to
        // avoid. Within one project every entry is the caller's, so nothing is filtered.
        const relevant = (key: string): boolean => !foreign || uses.has(key);

        const uncitedEntries = foreign
          ? []
          : entries
              .filter((e) => !uses.has(e.key!))
              .map((e) => ({ key: e.key!, path: e.path, line: e.line, title: e.title }))
              .sort((a, b) => a.key.localeCompare(b.key));

        const duplicateKeys = [...defined.entries()]
          .filter(([key, list]) => list.length > 1 && relevant(key))
          .map(([key, list]) => ({
            key,
            occurrences: list.map((e) => ({ path: e.path, line: e.line })),
          }))
          .sort((a, b) => a.key.localeCompare(b.key));

        const incompleteEntries = entries
          .filter((e) => relevant(e.key!))
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
          ...(foreign ? { bibliographyProject: bib.id } : {}),
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
  bibliographyProject?: string;
  entryCount: number;
  citationCount: number;
  undefinedCitations: Array<{ key: string; uses: Array<{ path: string; line: number }> }>;
  uncitedEntries: Array<{ key: string; path: string; line: number; title?: string }>;
  duplicateKeys: Array<{ key: string; occurrences: Array<{ path: string; line: number }> }>;
  incompleteEntries: Array<{ key: string; path: string; line: number; missing: string[] }>;
}

/** The findings as text, so a client that drops `structuredContent` still gets the whole report. */
function render(r: Report): string {
  const from = r.bibliographyProject ? ` (project "${r.bibliographyProject}")` : '';
  const lines = [
    `${r.entryCount} entries in ${r.bibliographySources.join(', ') || '(none)'}${from} · ` +
      `${r.citationCount} distinct keys cited across ${r.documents.length} document(s)`,
  ];
  if (r.bibliographyProject) {
    lines.push(
      `Findings below cover only the keys these documents cite — "${r.bibliographyProject}" is a ` +
        'shared bibliography, so its uncited and unrelated entries are not this draft’s problem. ' +
        `Run check_citations with project: "${r.bibliographyProject}" to audit it as a whole.`,
    );
  }
  // Where the header ends, so "no problems" stays right whether or not the cross-project note
  // above added a line.
  const headerLines = lines.length;
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
  if (lines.length === headerLines) lines.push('', 'No problems found.');
  return lines.join('\n');
}

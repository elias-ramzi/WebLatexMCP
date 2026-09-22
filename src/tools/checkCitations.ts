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
import {
  CITATIONS_MAX_FINDINGS,
  CITATIONS_MAX_PLACES,
  CITATIONS_MAX_RESULTS,
  planCitationsPayload,
  type CitationsPlan,
} from '../lib/citationsBudget.js';

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
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(CITATIONS_MAX_RESULTS)
    .optional()
    .describe(
      `Cap on findings returned in EACH of the four lists (default ${CITATIONS_MAX_FINDINGS}). ` +
        'A character budget applies on top and can cut further — advisory findings first, ' +
        'undefinedCitations last — so raising this does not guarantee a longer report; narrow ' +
        '`documents` or `bibliography` instead. Nothing is ever cut silently: every list has an ' +
        '`…Omitted` count and `note` names which bound fired.',
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
    .array(
      z.object({
        key: z.string(),
        uses: z.array(placeSchema),
        usesOmitted: z
          .number()
          .optional()
          .describe(`Further uses of this key, not listed (max ${CITATIONS_MAX_PLACES} shown).`),
      }),
    )
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
        'inside that project. Being advisory, this is also the first list the output budget cuts.',
    ),
  duplicateKeys: z
    .array(
      z.object({
        key: z.string(),
        occurrences: z.array(placeSchema),
        occurrencesOmitted: z
          .number()
          .optional()
          .describe(
            `Further definitions of this key, not listed (max ${CITATIONS_MAX_PLACES} shown).`,
          ),
      }),
    )
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
        type: z
          .string()
          .optional()
          .describe('BibTeX entry type — it says which fields are required.'),
        missing: z.array(z.string()),
        missingOmitted: z
          .number()
          .optional()
          .describe(`Further missing fields, not listed (max ${CITATIONS_MAX_PLACES} shown).`),
      }),
    )
    .describe(
      'BibTeX entries missing a field their type requires ("a|b" means either will do). Limited ' +
        'to cited entries when `bibliographyProject` is set.',
    ),
  undefinedCitationsOmitted: z
    .number()
    .describe('Undefined citations found but not listed. Cut LAST — these break the build.'),
  uncitedEntriesOmitted: z
    .number()
    .describe('Uncited entries found but not listed. Cut FIRST — advisory, and the longest list.'),
  duplicateKeysOmitted: z.number().describe('Duplicate keys found but not listed.'),
  incompleteEntriesOmitted: z.number().describe('Incomplete entries found but not listed.'),
  note: z
    .string()
    .optional()
    .describe(
      'Present only when a bound cut something; names which list, how many, and whether the ' +
        'per-list cap or the character budget fired. Nothing is ever dropped silently.',
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
    // No baseline. This tool answers a question *about* the bibliography — which keys exist,
    // where, and what they are missing — and returns none of its content, so the caller cannot
    // base a write on having called it. Claiming otherwise would let the next write_file overwrite
    // a hand edit made before the scan, and would hide the file from status's externalChanges.
    const text = await ctx.files.readText(dir, rel);
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
        'search_references against DBLP, Crossref or OpenAlex, or the verify-citations skill. Pass ' +
        '`bibliographyProject` to check a draft against a SHARED bibliography that lives in ' +
        'another registered project. Read-only; no git remote needed, so it works on a local ' +
        'project.',
      inputSchema,
      outputSchema,
    },
    async ({ project, documents, bibliography, bibliographyProject, maxResults }) => {
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
                'and verify each entry against DBLP, Crossref or OpenAlex with search_references.',
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
          // Ditto, and more so: this scans *every* .tex and prose file in the project looking for
          // \cite uses, so recording here would file the whole project as seen — detectRootFile's
          // hole in another tool.
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

        // Every byte of all four lists is document-controlled, and a group .bib carried in the
        // project routinely makes `uncitedEntries` hundreds of rows long on a perfectly ordinary
        // paper. The planner cuts before anything is sent, counts what it cut, and decides the
        // ORDER — advisory findings first, build-breaking ones last (issue #154).
        const plan = planCitationsPayload(
          { undefinedCitations, uncitedEntries, duplicateKeys, incompleteEntries },
          { maxResults },
        );

        const result = {
          documents: scanned,
          bibliographySources: sources,
          ...(foreign ? { bibliographyProject: bib.id } : {}),
          entryCount: entries.length,
          citationCount: uses.size,
          ...plan,
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

/**
 * What `render` reads: the header fields plus the planner's own output shape.
 *
 * The four lists are NOT restated here. They used to be, and had already drifted: the handler
 * emits `incompleteEntries[].type` and `outputSchema` declares it, but the hand-written interface
 * omitted it — harmless (an interface a non-literal argument is checked against permits extra
 * properties, so nothing failed) but exactly the kind of divergence that becomes a real one the
 * moment `render` wants a field the copy forgot. Extending {@link CitationsPlan} makes the
 * renderer's view of the payload the same type the planner produces, so it cannot drift again.
 */
interface Report extends CitationsPlan {
  documents: string[];
  bibliographySources: string[];
  bibliographyProject?: string;
  entryCount: number;
  citationCount: number;
}

/**
 * The findings as text, so a client that drops `structuredContent` still gets the whole report.
 *
 * Rendered from the ALREADY-CUT payload, never from the full lists: both channels ship in the
 * same result, so a text channel built from the uncut findings would restore exactly the
 * oversized payload the budget exists to prevent — the rule `search_files` states at
 * `src/tools/searchFiles.ts`.
 */
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
  // A section whose entries were all cut still has to appear — "(showing 0 of 220)" is a finding,
  // and dropping the heading would read as "no uncited entries" instead.
  const section = (title: string, items: string[], omitted: number): void => {
    if (items.length === 0 && omitted === 0) return;
    const total = items.length + omitted;
    const count = omitted > 0 ? `showing ${items.length} of ${total}` : `${total}`;
    lines.push('', `${title} (${count}):`, ...items.map((i) => `  ${i}`));
  };
  const places = (list: Array<{ path: string; line: number }>, omitted?: number): string =>
    list.map((x) => `${x.path}:${x.line}`).join(', ') + (omitted ? `, +${omitted} more` : '');
  section(
    'Cited but not defined',
    r.undefinedCitations.map((u) => `${u.key} — ${places(u.uses, u.usesOmitted)}`),
    r.undefinedCitationsOmitted,
  );
  section(
    'Defined but never cited',
    r.uncitedEntries.map((e) => `${e.key} (${e.path}:${e.line})${e.title ? ` — ${e.title}` : ''}`),
    r.uncitedEntriesOmitted,
  );
  section(
    'Duplicate keys',
    r.duplicateKeys.map((d) => `${d.key} — ${places(d.occurrences, d.occurrencesOmitted)}`),
    r.duplicateKeysOmitted,
  );
  section(
    'Missing required fields',
    r.incompleteEntries.map(
      (e) =>
        `${e.key} (${e.path}:${e.line}) — ` +
        e.missing.join(', ') +
        (e.missingOmitted ? `, +${e.missingOmitted} more` : ''),
    ),
    r.incompleteEntriesOmitted,
  );
  if (lines.length === headerLines) lines.push('', 'No problems found.');
  if (r.note) lines.push('', r.note);
  return lines.join('\n');
}

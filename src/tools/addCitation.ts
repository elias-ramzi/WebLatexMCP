import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { isBibFile, mergeBibEntry } from '../lib/bib.js';

const inputSchema = {
  project: z.string().optional(),
  key: z
    .string()
    .min(1)
    .describe(
      'DBLP record key from search_references (e.g. "conf/cvpr/HeZRS16"), or a dblp.org URL.',
    ),
  bibFile: z
    .string()
    .optional()
    .describe('Target .bib path. Optional when the project has exactly one .bib file.'),
};

const outputSchema = {
  path: z.string(),
  key: z.string(),
  added: z.boolean(),
  alreadyPresent: z.boolean(),
  bibtex: z.string(),
  diff: z.string(),
};

/** Resolve the .bib file to write to: the explicit one, or the project's sole .bib. */
async function resolveBibFile(
  ctx: AppContext,
  dir: string,
  bibFile: string | undefined,
): Promise<string> {
  if (bibFile) {
    if (!isBibFile(bibFile)) throw new Error(`"${bibFile}" is not a .bib file.`);
    return bibFile;
  }
  const bibs = await ctx.files.list(dir, { filter: 'bib' });
  if (bibs.length === 0) {
    throw new Error(
      'No .bib file in the project. Pass bibFile to choose where to create one (e.g. "references.bib").',
    );
  }
  if (bibs.length > 1) {
    throw new Error(
      `Multiple .bib files (${bibs.map((b) => b.path).join(', ')}). Pass bibFile to pick one.`,
    );
  }
  return bibs[0]!.path;
}

export function registerAddCitation(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'add_citation',
    {
      title: 'Add a citation from DBLP',
      description:
        'Fetch a reference from DBLP by its record key and append it to the bibliography. ' +
        'This is the only sanctioned way to add to a .bib file: the BibTeX is fetched ' +
        'from DBLP server-side, never hand-written, so entries are verifiable. Find the key ' +
        'with search_references first. No-op (alreadyPresent) if the cite key is already in the file.',
      inputSchema,
      outputSchema,
    },
    async ({ project, key, bibFile }) => {
      try {
        const { id, dir } = await ctx.projectManager.requireClonedDir(project);
        return await ctx.projectManager.runExclusive(id, async () => {
          const target = await resolveBibFile(ctx, dir, bibFile);
          // Re-fetch from DBLP so the appended text always originates from the API.
          const bibtex = await ctx.dblp.fetchBibtex(key);
          const existing = await ctx.files.readText(dir, target);
          const merged = mergeBibEntry(existing, bibtex);

          if (merged.alreadyPresent) {
            return {
              content: [
                { type: 'text', text: `${merged.key} is already in ${target}; nothing added.` },
              ],
              structuredContent: {
                path: target,
                key: merged.key,
                added: false,
                alreadyPresent: true,
                bibtex,
                diff: '',
              },
            };
          }

          await ctx.files.write(dir, { path: target, content: merged.content, createDirs: true });
          const { diff } = await ctx.git.diff(dir, { path: target });
          return {
            content: [
              { type: 'text', text: `added ${merged.key} to ${target}\n\n${bibtex}\n\n${diff}` },
            ],
            structuredContent: {
              path: target,
              key: merged.key,
              added: true,
              alreadyPresent: false,
              bibtex,
              diff,
            },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

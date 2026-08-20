import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { changeDiff } from '../lib/changeDiff.js';
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
  /** Where the entry now sits, so the caller can confirm it without re-reading the file. */
  line: z.number().describe('1-based line the entry starts on, in the file after the write.'),
  bibtex: z.string(),
  diff: z.string(),
};

/** 1-based line of the `@type{key,` header in a bibliography, or 1 when it cannot be located. */
function entryLine(content: string, key: string): number {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idx = content.search(new RegExp(`@\\w+\\s*[{(]\\s*${escaped}\\s*,`));
  if (idx === -1) return 1;
  return content.slice(0, idx).split('\n').length;
}

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
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        return await ctx.projectManager.runExclusive(id, async () => {
          const target = await resolveBibFile(ctx, dir, bibFile);
          // Re-fetch from DBLP so the appended text always originates from the API.
          const bibtex = await ctx.dblp.fetchBibtex(key);
          const existing = await ctx.files.readText(dir, target);
          const merged = mergeBibEntry(existing, bibtex);

          if (merged.alreadyPresent) {
            const at = entryLine(existing, merged.key);
            return {
              content: [
                {
                  type: 'text',
                  text: `${merged.key} is already in ${target}:${at}; nothing added.`,
                },
              ],
              structuredContent: {
                path: target,
                key: merged.key,
                added: false,
                alreadyPresent: true,
                line: at,
                bibtex,
                diff: '',
              },
            };
          }

          await ctx.files.write(dir, { path: target, content: merged.content, createDirs: true });
          const diff = await changeDiff(ctx.projectManager, ctx.git, id, dir, target);
          const at = entryLine(merged.content, merged.key);
          const summary = `added ${merged.key} to ${target}:${at}\n\n${bibtex}`;
          return {
            content: [{ type: 'text', text: diff ? `${summary}\n\n${diff}` : summary }],
            structuredContent: {
              path: target,
              key: merged.key,
              added: true,
              alreadyPresent: false,
              line: at,
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

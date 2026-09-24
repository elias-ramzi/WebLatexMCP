import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { changeDiff, changedPath } from '../lib/changeDiff.js';
import { isBibFile, mergeBibEntry } from '../lib/bib.js';

const inputSchema = {
  project: z.string().optional(),
  key: z
    .string()
    .min(1)
    .describe(
      'Namespaced record key from search_references — e.g. "dblp:conf/cvpr/HeZRS16", ' +
        '"crossref:10.1109/CVPR.2016.90", "openalex:W2194775991", or "doi:<doi>" as an alias ' +
        'for crossref. A bare DBLP key, a bare DOI, ' +
        'or a dblp.org / doi.org / openalex.org URL is accepted too. The key decides which ' +
        'service is asked, whatever the configured search source is: it came from a result, ' +
        'so it carries its own provenance.',
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
  /** The bibliography the key belongs to. */
  source: z.string(),
  /**
   * The service that actually issued the BibTeX, when it is not `source`. Only OpenAlex sets
   * this: it publishes no BibTeX, so its records are fetched from Crossref by DOI.
   */
  via: z.string().optional(),
  bibtex: z.string(),
  diff: z
    .string()
    .describe(
      'Confirmation diff against HEAD. Budgeted (#153): a large patch comes back cut at hunk ' +
        'boundaries with a "... N of M hunk(s) omitted" marker — call diff for the whole one. ' +
        'Empty for a local project, and when the entry was already present (nothing was ' +
        'written); never empty merely because it was cut.',
    ),
  diffTruncated: z
    .boolean()
    .describe('True iff the confirmation diff above was cut to fit its budget.'),
};

/** 1-based line of the `@type{key,` header in a bibliography, or 1 when it cannot be located. */
function entryLine(content: string, key: string): number {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idx = content.search(new RegExp(`@\\w+\\s*[{(]\\s*${escaped}\\s*,`));
  if (idx === -1) return 1;
  return content.slice(0, idx).split('\n').length;
}

/**
 * Resolve the .bib file to write to: the explicit one, or the project's sole .bib — plus where
 * it really lands (`FileService.linkTarget`, `null` when no link is involved).
 *
 * The name gate judges the link-resolved name too, as every name-based gate does: a committed
 * in-project `refs.bib -> main.tex` passes `isBibFile` on its own name, and appending BibTeX
 * through it would land in main.tex. A link whose far end is a .bib (a shared bibliography
 * linked in) is fine — that is where the entry belongs.
 */
async function resolveBibFile(
  ctx: AppContext,
  dir: string,
  bibFile: string | undefined,
): Promise<{ bibPath: string; linkTarget: string | null }> {
  let bibPath: string;
  if (bibFile) {
    if (!isBibFile(bibFile)) throw new Error(`"${bibFile}" is not a .bib file.`);
    bibPath = bibFile;
  } else {
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
    bibPath = bibs[0]!.path;
  }
  // `linkTarget` can throw (ELOOP, EACCES); resolving it here, before anything is written, keeps
  // a throw from reporting an error for a citation that already landed.
  const linkTarget = await ctx.files.linkTarget(dir, bibPath);
  if (linkTarget !== null && !isBibFile(linkTarget)) {
    throw new Error(
      `"${bibPath}" is a link to "${linkTarget}", which is not a .bib file; add_citation only ` +
        'appends to a bibliography. Pass bibFile naming the real .bib.',
    );
  }
  return { bibPath, linkTarget };
}

export function registerAddCitation(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'add_citation',
    {
      title: 'Add a citation from a bibliography service',
      description:
        'Fetch a reference from DBLP, Crossref or OpenAlex by its record key and append it to ' +
        'the bibliography. This is the only sanctioned way to add to a .bib file: the BibTeX is ' +
        'fetched from the service server-side, never hand-written, so entries are verifiable. ' +
        'The key decides which service is asked. OpenAlex publishes no BibTeX of its own, so an ' +
        'openalex: key is resolved to its DOI and the entry fetched from Crossref — a record ' +
        'with no DOI is refused rather than assembled by hand. Find the key with ' +
        'search_references first. No-op (alreadyPresent) if the cite key is already in the file.',
      inputSchema,
      outputSchema,
    },
    async ({ project, key, bibFile }) => {
      try {
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        // A cheap, read-only preflight so a project with no usable .bib fails before a network
        // round trip. Not authoritative: the tree can change before the lock is taken, so the
        // target is resolved again under it below.
        await resolveBibFile(ctx, dir, bibFile);
        // Fetched OUTSIDE the lock: it touches no project state, and an openalex: key costs a
        // DOI hop plus a Crossref fetch (15s timeout each) — held under runExclusive, that is as
        // long as a peer's own lock wait (fileLock's DEFAULT_TIMEOUT_MS), so a peer's
        // write/commit could fail with LockTimeoutError behind a citation lookup.
        // Re-fetched from the issuing service so the appended text always originates from the
        // API, never from the model. An OpenAlex key is bridged to Crossref by its DOI, and
        // refused outright when it has none — we never assemble an entry ourselves.
        const fetched = await ctx.references.fetchBibtex(key);
        const bibtex = fetched.bibtex;
        return await ctx.projectManager.runExclusive(id, async () => {
          // Authoritative resolution, under the lock: a peer cannot add a second .bib or plant a
          // link between this check and the write. The link target is resolved here too, BEFORE
          // the write, as write_file/edit_file do.
          const { bibPath, linkTarget } = await resolveBibFile(ctx, dir, bibFile);
          // No baseline from this read: it happens before the already-present early return, and a
          // path that writes nothing must not claim the caller has seen the file (that is exactly
          // what made every compile disarm the guard). The write below is safe without it — see
          // there.
          // Read as bytes and decoded only when the decode is exact: the write below puts back the
          // WHOLE file, so a lossy UTF-8 decode of a legacy Latin-1 bibliography (an accented
          // author is the one byte 0xE9) would rewrite every such byte as U+FFFD, far from the
          // appended entry. Refused before anything is written. An absent file is a new, empty one.
          // Uncapped, like the text read this replaced: the binary read cap (sized for figures)
          // would refuse a large shared bibliography that the append has no reason to refuse.
          const existing = await ctx.files.readTextExact(dir, bibPath);
          if (existing === null) {
            throw new Error(
              `"${bibPath}" is not valid UTF-8 (likely Latin-1 or another legacy encoding), and ` +
                'add_citation rewrites the whole bibliography as UTF-8, which would replace every ' +
                'character it cannot decode with U+FFFD. Nothing was written. Convert the file to ' +
                'UTF-8 first (e.g. iconv -f latin1 -t utf-8), then add the citation again.',
            );
          }
          const merged = mergeBibEntry(existing, bibtex);

          if (merged.alreadyPresent) {
            const at = entryLine(existing, merged.key);
            return {
              content: [
                {
                  type: 'text',
                  text: `${merged.key} is already in ${bibPath}:${at}; nothing added.`,
                },
              ],
              structuredContent: {
                path: bibPath,
                key: merged.key,
                added: false,
                alreadyPresent: true,
                line: at,
                source: fetched.source,
                ...(fetched.via ? { via: fetched.via } : {}),
                bibtex,
                diff: '',
                diffTruncated: false,
              },
            };
          }

          // `merged.content` is the bytes just read under this project's lock plus one entry
          // appended, so it cannot lose a hand edit — it is built on top of it. The staleness
          // check would only refuse a write that is already safe, which is why this read did not
          // need to arm the guard to get past it.
          // A write through an in-project link changes the target, so that is the path to diff —
          // same rule as write_file/edit_file (changedPath in src/lib/changeDiff.ts).
          await ctx.files.write(dir, {
            path: bibPath,
            content: merged.content,
            createDirs: true,
            overrideExternalChanges: true,
          });
          const diff = await changeDiff(
            ctx.projectManager,
            ctx.git,
            id,
            dir,
            changedPath(linkTarget, bibPath),
          );
          const at = entryLine(merged.content, merged.key);
          const from = fetched.via
            ? `${fetched.source} via ${fetched.via}`
            : String(fetched.source);
          const summary = `added ${merged.key} to ${bibPath}:${at} (from ${from})\n\n${bibtex}`;
          // Both channels render from the same budgeted plan, never from the full patch.
          return {
            content: [{ type: 'text', text: diff.diff ? `${summary}\n\n${diff.diff}` : summary }],
            structuredContent: {
              path: bibPath,
              key: merged.key,
              added: true,
              alreadyPresent: false,
              line: at,
              source: fetched.source,
              ...(fetched.via ? { via: fetched.via } : {}),
              bibtex,
              diff: diff.diff,
              diffTruncated: diff.truncated,
            },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { changeDiff, changedPath } from '../lib/changeDiff.js';
import { applyProfile, describeProfile, type ProfiledEntry } from '../lib/citationProfile.js';
import { CITATIONS_MAX_FINDINGS, CITATIONS_MAX_PLACES } from '../lib/citationsBudget.js';
import { SEARCH_SKIPPED_BUDGET } from '../lib/searchBudget.js';
import { resolveBibFile } from './addCitation.js';

/**
 * `apply_citation_profile` (#255): remove, from entries already in a `.bib`, the fields the
 * project's citation profile leaves out — what `add_citation` does to each new entry.
 *
 * A `.bib` change other than `add_citation`'s append, so it takes `confirmBibEdit: true` like
 * `write_file`/`edit_file` (`dryRun: true` lists the change without it, writing nothing). The
 * change itself is `applyProfile`'s: whole fields deleted from the bytes read under the project
 * lock, nothing written, reformatted or reordered. The file is read and written under one lock,
 * and the write is built from those very bytes, so it can lose no hand edit; that is why it
 * passes `overrideExternalChanges`, as `add_citation` does.
 */

/** Entries listed per call: the house figure for a capped list. */
const MAX_LISTED = CITATIONS_MAX_FINDINGS;
/**
 * Character budget for the listed entries, charged on both channels together (the JSON element
 * and its text line). A diagnostic share — the diff shows every change — so the house figure for
 * one, `search_files`' `skipped` list's, reused rather than restated.
 */
const LISTED_BUDGET = SEARCH_SKIPPED_BUDGET;

const inputSchema = {
  project: z.string().optional(),
  bibFile: z
    .string()
    .optional()
    .describe('The .bib to trim. Optional when the project has exactly one .bib file.'),
  keys: z
    .array(z.string().min(1))
    .min(1)
    .max(1000)
    .optional()
    .describe('Trim only the entries with these cite keys. Omit for every entry in the file.'),
  dryRun: z
    .boolean()
    .optional()
    .describe('List what would be removed, write nothing. Needs no confirmBibEdit.'),
  confirmBibEdit: z
    .boolean()
    .optional()
    .describe(
      'Required (true) to write: this changes a .bib, so ask the user to approve first. ' +
        'Without it the call is refused, naming how many fields would go.',
    ),
};

const listedEntry = z.object({
  key: z.string(),
  line: z.number().describe('1-based line the entry starts on, before the change.'),
  type: z.string(),
  removed: z.array(z.string()).describe('Fields removed (or to remove), lower-cased.'),
  removedOmitted: z
    .number()
    .optional()
    .describe(`Further removed fields, not listed (max ${CITATIONS_MAX_PLACES} shown).`),
});

const outputSchema = {
  path: z.string(),
  dryRun: z.boolean(),
  written: z.boolean().describe('True iff the file was changed by this call.'),
  entriesChanged: z.number().describe('Entries that lose (or would lose) at least one field.'),
  fieldsRemoved: z.number().describe('Fields removed (or to remove), over every entry.'),
  entries: z
    .array(listedEntry)
    .describe(
      `The entries changed — at most ${MAX_LISTED}, within a ${LISTED_BUDGET}-character budget ` +
        'over both channels; entriesOmitted counts the rest, and the diff shows every change.',
    ),
  entriesOmitted: z.number().describe('Changed entries not listed in `entries`.'),
  diff: z
    .string()
    .describe(
      'Confirmation diff against HEAD after the write, budgeted like add_citation’s. Empty on a ' +
        'dry run, when nothing changed, and for a local project.',
    ),
  diffTruncated: z.boolean(),
};

type Listed = z.infer<typeof listedEntry>;

/** One listed entry as a text line. */
function entryLine(e: Listed): string {
  const more = e.removedOmitted ? `, +${e.removedOmitted} more` : '';
  return `  ${e.key} (line ${e.line}, @${e.type}): ${e.removed.join(', ')}${more}`;
}

/**
 * The entries to list: capped, then fitted to {@link LISTED_BUDGET} charged on what each sends in
 * both channels (its JSON element and its text line, via the render functions themselves). The
 * first entry is always kept, so a call that changed something never lists nothing; a cite key is
 * the only free text in it.
 */
function planListed(changed: ProfiledEntry[]): { entries: Listed[]; omitted: number } {
  const entries: Listed[] = [];
  let left = LISTED_BUDGET;
  for (const c of changed.slice(0, MAX_LISTED)) {
    const removed = c.removed.slice(0, CITATIONS_MAX_PLACES);
    const e: Listed = {
      key: c.key,
      line: c.line,
      type: c.type,
      removed,
      ...(c.removed.length > removed.length
        ? { removedOmitted: c.removed.length - removed.length }
        : {}),
    };
    const cost = JSON.stringify(e).length + 1 + entryLine(e).length + 1;
    if (cost > left && entries.length > 0) break;
    entries.push(e);
    left -= cost;
  }
  return { entries, omitted: changed.length - entries.length };
}

export function registerApplyCitationProfile(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'apply_citation_profile',
    {
      title: 'Trim existing .bib entries to the citation profile',
      description:
        "Remove, from entries already in a .bib, every field the project's citation profile " +
        '(set_citation_profile) leaves out — what add_citation does to each new entry. Only whole ' +
        '`name = value` fields are deleted; no value is written, reformatted or reordered, and ' +
        'the cite key and entry type never change. This changes a .bib, so it needs the user’s ' +
        'approval and confirmBibEdit: true; dryRun: true lists the change first without it. ' +
        'check_citations reports the entries this would trim (profileViolations).',
      inputSchema,
      outputSchema,
    },
    async ({ project, bibFile, keys, dryRun, confirmBibEdit }) => {
      try {
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        return await ctx.projectManager.runExclusive(id, async () => {
          const profile = await ctx.citationProfiles.get(id);
          if (profile === null) {
            throw new Error(
              `Project "${id}" has no citation profile, so there is nothing to apply. Set one ` +
                'with set_citation_profile first.',
            );
          }
          const { bibPath, linkTarget } = await resolveBibFile(ctx, dir, bibFile);
          // Read as bytes and decoded only when exact, as add_citation does: the write puts back
          // the whole file, and a lossy decode would rewrite every byte it could not read.
          const existing = await ctx.files.readTextExact(dir, bibPath);
          if (existing === null) {
            throw new Error(
              `"${bibPath}" is not valid UTF-8 (likely Latin-1 or another legacy encoding), and ` +
                'apply_citation_profile rewrites the whole bibliography as UTF-8. Nothing was ' +
                'written. Convert the file to UTF-8 first (e.g. iconv -f latin1 -t utf-8).',
            );
          }
          const result = applyProfile(existing, profile, keys ? new Set(keys) : undefined);
          const fieldsRemoved = result.changed.reduce((n, c) => n + c.removed.length, 0);
          const listed = planListed(result.changed);
          const base = {
            path: bibPath,
            dryRun: dryRun === true,
            entriesChanged: result.changed.length,
            fieldsRemoved,
            entries: listed.entries,
            entriesOmitted: listed.omitted,
          };
          const header =
            `${bibPath}: profile ${describeProfile(profile)} — ` +
            `${fieldsRemoved} field(s) in ${result.changed.length} entr` +
            `${result.changed.length === 1 ? 'y' : 'ies'}`;
          const body = [
            ...listed.entries.map(entryLine),
            ...(listed.omitted > 0 ? [`  … ${listed.omitted} more entries`] : []),
          ];
          if (result.changed.length === 0 || dryRun === true) {
            const verdict =
              result.changed.length === 0
                ? 'every entry already matches it; nothing to remove.'
                : 'would be removed (dry run, nothing written).';
            return {
              content: [{ type: 'text', text: [`${header} ${verdict}`, ...body].join('\n') }],
              structuredContent: { ...base, written: false, diff: '', diffTruncated: false },
            };
          }
          if (confirmBibEdit !== true) {
            throw new Error(
              `Applying the citation profile would remove ${fieldsRemoved} field(s) from ` +
                `${result.changed.length} entr${result.changed.length === 1 ? 'y' : 'ies'} of ` +
                `"${bibPath}", and a .bib change needs the user's approval. Show the user the ` +
                'change (dryRun: true lists it), then retry with confirmBibEdit: true.',
            );
          }
          await ctx.files.write(dir, {
            path: bibPath,
            content: result.text,
            overrideExternalChanges: true,
          });
          const diff = await changeDiff(
            ctx.projectManager,
            ctx.git,
            id,
            dir,
            changedPath(linkTarget, bibPath),
          );
          const text = [`${header} removed.`, ...body, ...(diff.diff ? ['', diff.diff] : [])];
          return {
            content: [{ type: 'text', text: text.join('\n') }],
            structuredContent: {
              ...base,
              written: true,
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

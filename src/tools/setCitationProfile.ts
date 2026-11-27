import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { citationProfileSchema, describeProfile, isEmptyProfile } from '../lib/citationProfile.js';

const inputSchema = {
  project: z.string().optional(),
  profile: citationProfileSchema
    .optional()
    .describe(
      'The profile to store, REPLACING whatever was stored: `drop` (fields every entry loses) ' +
        'and/or `keep` (per entry type, the only fields kept). Omit to report what is stored.',
    ),
  clear: z.boolean().optional().describe('Remove the stored profile. Not together with `profile`.'),
};

const outputSchema = {
  profile: citationProfileSchema
    .nullable()
    .describe('The profile in effect after this call, or null when none is stored.'),
  previous: citationProfileSchema
    .nullable()
    .describe('What was stored just before this call (read under the same lock as the write).'),
  changed: z.boolean().describe('False when the call only reported the stored profile.'),
};

export function registerSetCitationProfile(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'set_citation_profile',
    {
      title: "Set a project's citation field profile",
      description:
        'Store which BibTeX fields this project’s bibliography carries — fields to drop from ' +
        'every entry (publisher, month, issn, bibsource, timestamp, biburl, …) and, per entry ' +
        'type, the only fields to keep — so entries from DBLP and Crossref stop arriving in ' +
        'different shapes. add_citation then removes those fields from each fetched entry before ' +
        'appending it, and check_citations reports existing entries that carry one ' +
        '(profileViolations); apply_citation_profile removes them from entries already in a ' +
        '.bib. A profile only ever removes whole fields, never writes a value. Set it when the ' +
        'user asks for a bibliography shape. Stored per project, shared by every session and ' +
        'kept across restarts. Omit `profile` to report what is stored; clear: true removes it.',
      inputSchema,
      outputSchema,
    },
    async ({ project, profile, clear }) => {
      try {
        if (profile !== undefined && clear) {
          throw new Error('Pass either `profile` or clear: true, not both.');
        }
        const { id } = await ctx.projectManager.requireProjectDir(project);
        if (profile === undefined && !clear) {
          const stored = await ctx.citationProfiles.get(id);
          return {
            content: [
              { type: 'text', text: `${id}: citation profile: ${describeProfile(stored)}` },
            ],
            structuredContent: { profile: stored, previous: stored, changed: false },
          };
        }
        // Under the project lock, as add_citation reads it: a citation added while the profile
        // changes is judged by one profile or the other, never half of each.
        return await ctx.projectManager.runExclusive(id, async () => {
          const previous = await ctx.citationProfiles.get(id);
          if (clear || profile === undefined || isEmptyProfile(profile)) {
            await ctx.citationProfiles.clear(id);
          } else {
            await ctx.citationProfiles.set(id, profile);
          }
          const now = await ctx.citationProfiles.get(id);
          return {
            content: [
              {
                type: 'text',
                text:
                  `${id}: citation profile set to: ${describeProfile(now)}` +
                  ` (was: ${describeProfile(previous)}). Entries already in the bibliography are ` +
                  'unchanged; check_citations lists the ones the profile would trim, and ' +
                  'apply_citation_profile trims them with the user’s approval.',
              },
            ],
            structuredContent: { profile: now, previous, changed: true },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

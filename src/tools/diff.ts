import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import {
  DIFF_CONTENT_BUDGET,
  DIFF_MAX_FILES,
  planDiffPayload,
  renderDiffText,
} from '../lib/diffBudget.js';

const inputSchema = {
  project: z.string().optional(),
  path: z.string().optional().describe('Limit the diff to a single file.'),
  staged: z.boolean().optional().describe('Show staged (cached) changes instead of working tree.'),
  ref: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Diff the working tree against this git ref instead of the index — "HEAD~3" to review a ' +
        'session that already committed a few times, a commit sha, or "origin/master" for what ' +
        'this branch has that the remote does not. A two-dot range ("HEAD~3..HEAD") diffs two ' +
        'commits. Cannot be combined with `staged`. On a clone shared by several sessions this ' +
        'spans everyone\'s commits: it answers "what changed", not "what did I change".',
    ),
  detail: z
    .enum(['auto', 'full'])
    .optional()
    .describe(
      `"auto" (the default) fits the result inside a ${DIFF_CONTENT_BUDGET}-character budget ` +
        'charged across BOTH channels (the patch is returned as text and again as ' +
        'structuredContent.diff): whole hunks are dropped from the end, every changed file keeps ' +
        'its diff --git/---/+++ headers, what went is marked in place and counted, and files[] ' +
        `lists at most ${DIFF_MAX_FILES} files. "full" returns the complete patch, uncut and ` +
        'uncapped — use it when you genuinely need every line and your client can take the size; ' +
        'an oversized result may be rejected by the client and deliver nothing at all.',
    ),
};

const outputSchema = {
  diff: z
    .string()
    .describe(
      'The unified patch. Under detail: "auto" this may be cut at hunk boundaries, with a ' +
        '"... N of M hunk(s) omitted" marker where each cut happened. Empty means there is no ' +
        'diff at all — never that one was cut, which always leaves the file headers behind.',
    ),
  files: z
    .array(z.object({ path: z.string(), added: z.number(), removed: z.number() }))
    .describe(`Per-file line counts, at most ${DIFF_MAX_FILES} of them under detail: "auto".`),
  ref: z.string().optional(),
  truncated: z
    .boolean()
    .describe('True iff anything was cut from this result — the patch, or the files list.'),
  diffChars: z
    .number()
    .describe('Characters in the FULL patch, before any cut, so the real size is always known.'),
  hunksOmitted: z.number().describe('Hunks cut from a file the patch still shows.'),
  patchFilesOmitted: z
    .number()
    .describe(
      'Changed files given no section in the patch at all — no headers, no hunks. Distinct from ' +
        'filesOmitted, which is about the files[] summary: the two caps fire independently.',
    ),
  filesOmitted: z.number().describe('Changed files cut from the files[] summary by its cap.'),
  note: z
    .string()
    .optional()
    .describe('What was cut and how to get it. Present only when something actually was.'),
};

export function registerDiff(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'diff',
    {
      title: 'Git diff',
      description:
        'Show the unified diff plus per-file added/removed line counts, for review before ' +
        'committing. Pass `ref` (e.g. "HEAD~3", "origin/master") to diff against a commit instead, ' +
        'so work already committed this session can still be reviewed as a whole. The result is ' +
        `budgeted (${DIFF_CONTENT_BUDGET} characters across both channels): a large patch comes ` +
        'back cut at hunk boundaries, with every cut marked and counted — narrow it with `path`, ' +
        'or pass detail: "full" for the whole thing.',
      inputSchema,
      outputSchema,
    },
    async ({ project, path: relPath, staged, ref, detail }) => {
      try {
        ctx.projectManager.requireGitProject(project, 'diff against');
        const { dir } = await ctx.projectManager.requireProjectDir(project);
        const result = await ctx.git.diff(dir, { path: relPath, staged, ref });
        // ONE plan drives both channels — `renderDiffText` reads the already-budgeted payload and
        // never the full one, so the text and structuredContent cannot disagree about what was
        // cut (the rule `push.ts` follows for a conflict report, and `searchFiles.ts` for its
        // matches).
        const plan = planDiffPayload(result.diff, result.files, { detail: detail ?? 'auto', ref });
        return {
          content: [{ type: 'text', text: renderDiffText(plan) }],
          structuredContent: {
            diff: plan.diff,
            files: plan.files,
            ...(plan.ref ? { ref: plan.ref } : {}),
            truncated: plan.truncated,
            diffChars: plan.diffChars,
            hunksOmitted: plan.hunksOmitted,
            patchFilesOmitted: plan.patchFilesOmitted,
            filesOmitted: plan.filesOmitted,
            ...(plan.note ? { note: plan.note } : {}),
          },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';

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
};

const outputSchema = {
  diff: z.string(),
  files: z.array(z.object({ path: z.string(), added: z.number(), removed: z.number() })),
  ref: z.string().optional(),
};

export function registerDiff(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'diff',
    {
      title: 'Git diff',
      description:
        'Show the unified diff plus per-file added/removed line counts, for review before ' +
        'committing. Pass `ref` (e.g. "HEAD~3", "origin/master") to diff against a commit instead, ' +
        'so work already committed this session can still be reviewed as a whole.',
      inputSchema,
      outputSchema,
    },
    async ({ project, path: relPath, staged, ref }) => {
      try {
        ctx.projectManager.requireGitProject(project, 'diff against');
        const { dir } = await ctx.projectManager.requireProjectDir(project);
        const result = await ctx.git.diff(dir, { path: relPath, staged, ref });
        const summary = result.files.length
          ? result.files.map((f) => `${f.path} +${f.added} -${f.removed}`).join('\n')
          : `No changes${ref ? ` vs ${ref}` : ''}.`;
        return {
          content: [{ type: 'text', text: result.diff ? `${summary}\n\n${result.diff}` : summary }],
          structuredContent: { ...result, ...(ref ? { ref } : {}) },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

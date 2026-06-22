import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AppContext } from '../context.js';
import type { SafePushResult } from '../services/gitService.js';
import { errorResult } from '../lib/errors.js';
import { redact } from '../lib/redact.js';

const conflictHunkSchema = z.object({
  startLine: z.number(),
  endLine: z.number(),
  local: z.array(z.string()),
  remote: z.array(z.string()),
});

const conflictFileSchema = z.object({
  path: z.string(),
  hunks: z.array(conflictHunkSchema),
});

const diffFileSchema = z.object({
  path: z.string(),
  added: z.number(),
  removed: z.number(),
});

const inputSchema = {
  project: z.string().optional().describe('Project id. Defaults to the configured default.'),
  mode: z
    .enum(['direct', 'branch'])
    .optional()
    .describe(
      'direct (default) = safe pull-rebase-then-push. branch = commit to a local review branch ' +
        'and land it only on approval. See docs/CONCURRENCY.md.',
    ),
  message: z
    .string()
    .optional()
    .describe(
      'Commit message. In direct mode, used to commit uncommitted work before pushing. In branch ' +
        'mode (without approve), the message for the review branch commit.',
    ),
  branch: z.string().optional().describe('Branch mode: the local feature branch name.'),
  base: z
    .string()
    .optional()
    .describe('Branch mode: branch to land onto (defaults to the clone default, e.g. master).'),
  approve: z
    .boolean()
    .optional()
    .describe('Branch mode: set true to land an already-reviewed branch onto the base and push.'),
  confirm: z
    .literal(true)
    .describe('Must be set to true to confirm pushing (or staging a review branch).'),
};

const outputSchema = {
  status: z.enum(['pushed', 'conflict', 'nothing-to-push', 'awaiting-approval']),
  pushed: z.boolean(),
  remote: z.string(),
  branch: z.string(),
  summary: z.string(),
  committedSha: z.string().optional(),
  pushedCommits: z.number().optional(),
  // status === 'conflict'
  conflictFiles: z.array(conflictFileSchema).optional(),
  rebasedOnto: z.string().optional(),
  // status === 'awaiting-approval'
  base: z.string().optional(),
  diff: z.string().optional(),
  diffFiles: z.array(diffFileSchema).optional(),
};

/** Flatten a SafePushResult into the tool's flat structuredContent (remote redacted). */
function safePushToolResult(
  res: SafePushResult,
  secrets: Array<string | undefined>,
): CallToolResult {
  const structured: Record<string, unknown> = {
    status: res.status,
    pushed: res.pushed,
    remote: redact(res.remote, secrets),
    branch: res.branch,
    summary: res.summary,
  };
  if (res.committedSha) structured.committedSha = res.committedSha;
  if (res.pushedCommits !== undefined) structured.pushedCommits = res.pushedCommits;
  if (res.conflict) {
    structured.conflictFiles = res.conflict.files;
    structured.rebasedOnto = res.conflict.rebasedOnto;
  }
  const text = res.conflict ? `${res.summary}\n\n${res.conflict.guidance}` : res.summary;
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

export function registerPush(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'push',
    {
      title: 'Push to Overleaf',
      description:
        'Safely push committed changes to the Overleaf remote. Default (direct) mode pull-rebases ' +
        'onto the latest remote before pushing and never force-pushes; a conflict means a human ' +
        'touched the same lines, so it aborts the rebase and returns status "conflict" with both ' +
        'sides — it never auto-resolves. Branch mode commits to a local review branch and lands it ' +
        'only on approve=true. Requires confirm=true. See docs/CONCURRENCY.md.',
      inputSchema,
      outputSchema,
    },
    async ({ project, mode = 'direct', message, branch, base, approve }) => {
      try {
        const cfg = ctx.projectManager.getProjectConfig(project);
        const { id, dir } = await ctx.projectManager.requireClonedDir(cfg.id);
        const auth = await ctx.credentials.resolve(cfg);
        const secrets = ctx.credentials.allSecrets();

        return await ctx.projectManager.runExclusive(id, async () => {
          if (mode === 'branch') {
            if (!branch) throw new Error('Branch mode requires a "branch" name.');
            if (approve) {
              const res = await ctx.git.landBranch(dir, cfg.gitUrl, auth, { branch, base });
              return safePushToolResult(res, secrets);
            }
            if (!message) {
              throw new Error('Branch mode requires a commit "message" to stage the work.');
            }
            const prep = await ctx.git.prepareBranch(dir, { branch, message, base });
            return {
              content: [{ type: 'text', text: prep.summary }],
              structuredContent: {
                status: prep.status,
                pushed: false,
                remote: redact(cfg.gitUrl, secrets),
                branch: prep.branch,
                base: prep.base,
                summary: prep.summary,
                committedSha: prep.committedSha,
                diff: prep.diff,
                diffFiles: prep.files,
              },
            };
          }

          const res = await ctx.git.safePush(dir, cfg.gitUrl, auth, { commitMessage: message });
          return safePushToolResult(res, secrets);
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

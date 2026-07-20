import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AppContext } from '../context.js';
import type { SafePushResult } from '../services/gitService.js';
import { errorResult } from '../lib/errors.js';
import { redact } from '../lib/redact.js';
import { renderConflictText, renderRebasedOver } from '../lib/conflictText.js';

const conflictHunkSchema = z.object({
  startLine: z.number(),
  endLine: z.number(),
  local: z.array(z.string()),
  remote: z.array(z.string()),
});

const conflictFileSchema = z.object({
  path: z.string(),
  base: z.string().nullable().describe('Full content at the merge-base (common ancestor).'),
  ours: z.string().nullable().describe('Full content of our (local) version.'),
  theirs: z.string().nullable().describe('Full content of the remote version that landed.'),
  hunks: z.array(conflictHunkSchema).describe('Marker view of just the overlapping regions.'),
});

const remoteCommitSchema = z.object({ hash: z.string(), message: z.string() });

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
  resolutions: z
    .array(z.object({ path: z.string(), content: z.string() }))
    .optional()
    .describe(
      'Resolve a prior "conflict" result: for each conflicted file, the full merged file content ' +
        '(both sides reconciled). Providing this re-runs the rebase, applies the merges, and pushes ' +
        '(direct mode only). Every conflicted file must be included.',
    ),
  confirmBibEdit: z
    .boolean()
    .optional()
    .describe(
      'Required to include a .bib file among `resolutions` (mirrors the write/edit guard).',
    ),
  expectedRemoteHead: z
    .string()
    .optional()
    .describe(
      'With `resolutions`: the `remoteHead` from the conflict you merged against. If the remote ' +
        'has advanced past it, the push is refused instead of merging over what just landed.',
    ),
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
  pushedSha: z.string().optional(),
  rebasedOver: z.array(remoteCommitSchema).optional(),
  // status === 'conflict'
  conflictFiles: z.array(conflictFileSchema).optional(),
  conflictPaths: z.array(z.string()).optional(),
  rebasedOnto: z.string().optional(),
  remoteHead: z.string().optional(),
  mergeBase: z.string().nullable().optional(),
  remoteCommits: z.array(remoteCommitSchema).optional(),
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
  if (res.pushedSha) structured.pushedSha = res.pushedSha;
  if (res.rebasedOver) structured.rebasedOver = res.rebasedOver;
  if (res.conflict) {
    structured.conflictFiles = res.conflict.files;
    structured.conflictPaths = res.conflict.conflictPaths;
    structured.rebasedOnto = res.conflict.rebasedOnto;
    structured.remoteHead = res.conflict.remoteHead;
    structured.mergeBase = res.conflict.mergeBase;
    structured.remoteCommits = res.conflict.remoteCommits;
  }
  // Put the full resolution payload in the model-visible text, not only structuredContent (which a
  // client may drop): per-file sides, the remote head to echo back, and what landed upstream.
  const text = res.conflict
    ? renderConflictText(res.summary, res.conflict)
    : [res.summary, renderRebasedOver(res.rebasedOver)].filter(Boolean).join('\n');
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

export function registerPush(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'push',
    {
      title: 'Push to Overleaf',
      description:
        'Safely push committed changes to the Overleaf remote. Default (direct) mode pull-rebases ' +
        'onto the latest remote before pushing and never force-pushes; on success it reports the ' +
        'new tip (pushedSha) and the remote commits it rebased over (rebasedOver). A conflict means ' +
        'someone touched the same lines: it aborts the rebase (clone back to pre-push state, nothing ' +
        'half-merged) and returns status "conflict" with a full 3-way payload — per file base/ours/' +
        'theirs plus a marker `hunks` view, and top-level conflictPaths, remoteHead, mergeBase, and ' +
        'remoteCommits (all in the result text, not just structuredContent). It never auto-resolves. ' +
        'To resolve, retry with `resolutions` (the full merged content per conflicted file; the set ' +
        'is validated and missing/extra files are named), optionally passing expectedRemoteHead ' +
        '(the reported remoteHead) so the push is refused if the remote moved again. `.bib` files ' +
        'need confirmBibEdit. Read any side directly with read_file(path, ref) using remoteHead/' +
        'mergeBase. Branch mode commits to a local review branch and lands it only on approve=true. ' +
        'Requires confirm=true. See docs/CONCURRENCY.md.',
      inputSchema,
      outputSchema,
    },
    async ({
      project,
      mode = 'direct',
      message,
      branch,
      base,
      approve,
      resolutions,
      confirmBibEdit,
      expectedRemoteHead,
    }) => {
      try {
        const cfg = ctx.projectManager.getProjectConfig(project);
        const { id, dir } = await ctx.projectManager.requireClonedDir(cfg.id);
        const auth = await ctx.credentials.resolve(cfg);
        const secrets = ctx.credentials.allSecrets();

        return await ctx.projectManager.runExclusive(id, async () => {
          if (resolutions && resolutions.length > 0) {
            if (mode === 'branch') {
              throw new Error('Conflict resolutions are only supported in direct mode.');
            }
            const res = await ctx.git.resolvePush(dir, cfg.gitUrl, auth, {
              resolutions,
              commitMessage: message,
              confirmBibEdit,
              expectedRemoteHead,
            });
            // The resolver rewrote files on disk; drop stale revision baselines so a later edit
            // isn't misread as an out-of-band change.
            ctx.files.resetBaselines(dir);
            return safePushToolResult(res, secrets);
          }

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

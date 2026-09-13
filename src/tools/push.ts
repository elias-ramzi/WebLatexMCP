import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AppContext } from '../context.js';
import type { SafePushResult } from '../services/gitService.js';
import { errorResult } from '../lib/errors.js';
import { redact } from '../lib/redact.js';
import {
  renderConflictText,
  renderLandedUpstream,
  renderRebasedOver,
  buildConflictFilePayload,
} from '../lib/conflictText.js';
import { planConflictPayload, CONFLICT_MAX_FILES } from '../lib/conflictBudget.js';
import { toPosix } from '../lib/paths.js';
import { attributePeers, collectPeerShadows, renderPeerRefusal } from '../lib/peerAttribution.js';
import { foldCase } from '../lib/caseFold.js';

/**
 * Refuse to push while a live sibling session has uncommitted work in the shared clone.
 *
 * A push has to rebase, and a rebase needs a clean tree — so pushing here would mean either
 * sweeping that session's half-finished paragraph into our commit or rewriting the tree
 * underneath it. Neither is ours to do, so we stop and name who to wait for.
 *
 * The refusal attributes each disputed file to whichever live peer's shadow lists it (see
 * `attributePeers` in `src/lib/peerAttribution.ts`) and dates each peer's last write. A file no
 * live peer owns — edited outside this server, or left behind by a session that has since exited
 * — is named as unowned rather than pinned on anyone, but it still blocks the push as long as any
 * live peer exists: this guard is not owner-aware about *whether* to refuse, only about how it
 * explains the refusal.
 */
async function guardPeerWork(ctx: AppContext, id: string, dir: string): Promise<void> {
  const peers = await ctx.sessions.livePeers(id);
  if (peers.length === 0) return;

  const status = await ctx.git.status(dir);
  const dirty = [...status.unstaged, ...status.untracked].map(toPosix);
  if (dirty.length === 0) return;

  // On a `core.ignorecase` clone git reports a dirty file in the index's spelling while a shadow
  // key carries the spelling the session wrote it under; fold both the way git does there, and
  // compare byte-for-byte everywhere else (the same rule `commit` scope "paths" applies).
  const fold = (await ctx.git.isCaseInsensitive(dir)) ? foldCase : (p: string) => p;
  const mine = new Set((await ctx.shadows.changes(id)).map((c) => fold(c.path)));
  const theirs = dirty.filter((p) => !mine.has(fold(p)));
  if (theirs.length === 0) return;

  const attribution = attributePeers(
    theirs,
    peers,
    await collectPeerShadows(ctx.shadows, id, peers),
    fold,
  );
  throw new Error(renderPeerRefusal(theirs, attribution, Date.now()));
}

const conflictHunkSchema = z.object({
  startLine: z.number(),
  endLine: z.number(),
  local: z.array(z.string()),
  remote: z.array(z.string()),
});

const conflictElisionSchema = z.object({
  chars: z.number().describe('The TRUE (untruncated) character count of the elided part.'),
  ref: z
    .string()
    .optional()
    .describe('read_file(path, ref) call that fetches this part in full. Sides only.'),
  count: z.number().optional().describe('hunks only: how many hunks were elided.'),
  spans: z
    .array(z.object({ startLine: z.number(), endLine: z.number() }))
    .optional()
    .describe('hunks only: the line span each elided hunk covered in the conflicted working file.'),
});

/** `null` is ambiguous by itself: "absent" (added/deleted) and "elided for size" both look like
 * `null`. The `elided.<key>` entry is what tells them apart — see `conflictFileSchema.elided`. */
const nullSideDescribe = (label: string, key: 'base' | 'ours' | 'theirs'): string =>
  `Full content ${label}, or null. null with no matching \`elided.${key}\` entry means the file ` +
  `did not exist on this side (added/deleted); null WITH an \`elided.${key}\` entry means the ` +
  "content was dropped to fit the payload budget — fetch it via that entry's `ref`.";

const conflictFileSchema = z.object({
  path: z.string(),
  base: z
    .string()
    .nullable()
    .describe(nullSideDescribe('at the merge-base (common ancestor)', 'base')),
  ours: z.string().nullable().describe(nullSideDescribe('of our (local) version', 'ours')),
  theirs: z
    .string()
    .nullable()
    .describe(nullSideDescribe('of the remote version that landed', 'theirs')),
  hunks: z
    .array(conflictHunkSchema)
    .describe(
      'Marker view of just the overlapping regions. Empty when elided for size — see `elided.hunks`.',
    ),
  elided: z
    .object({
      base: conflictElisionSchema.optional(),
      ours: conflictElisionSchema.optional(),
      theirs: conflictElisionSchema.optional(),
      hunks: conflictElisionSchema.optional(),
    })
    .optional()
    .describe(
      'Present iff some part of this file was dropped to fit the payload budget (conflictDetail: ' +
        '"auto", the default). Absent when everything for this file fit, or when conflictDetail: ' +
        '"full" was requested.',
    ),
});

const diffFileSchema = z.object({
  path: z.string(),
  added: z.number(),
  removed: z.number(),
});

const remoteCommitSchema = z.object({
  hash: z.string(),
  message: z.string(),
  files: z
    .array(diffFileSchema)
    .describe(
      'Files the commit touched, with added/removed line counts — enough to see what a remote ' +
        '"Update on Overleaf." commit changed without a shell. For the content, use `diff` with ' +
        'ref: "<hash>~1..<hash>".',
    ),
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
    .min(1)
    .optional()
    .describe(
      'With `resolutions`: the `remoteHead` from the conflict you merged against. If the remote ' +
        'has advanced past it, the push is refused instead of merging over what just landed. ' +
        'Setting this also disables the automatic lost-race retry: a second remote move during ' +
        'this push is reported as "remote-moved" (nothing pushed) after one attempt, rather than ' +
        'retried up to 3 times.',
    ),
  conflictDetail: z
    .enum(['auto', 'full'])
    .optional()
    .describe(
      'How much of a "conflict" result\'s per-file content to return. "auto" (default) budgets ' +
        'the payload so it fits in a tool result: the marker `hunks` view is allocated first, in ' +
        'file order (it is the least recoverable part once the rebase aborts), then base/ours/' +
        'theirs, in file order and base-then-ours-then-theirs, each also capped individually so ' +
        `one huge side cannot starve every other file. Past ${CONFLICT_MAX_FILES} conflicted ` +
        'files the rest get no per-file detail at all (still fully listed in conflictPaths). An ' +
        'elided side is fetchable in one call via read_file(path, ref); an elided hunks block has ' +
        'no ref of its own — reconstruct it from the (fetched) sides. "full" returns every side ' +
        'of every file in full, uncapped — for a caller that wants the complete payload and can ' +
        'take the size.',
    ),
  confirm: z
    .literal(true)
    .describe('Must be set to true to confirm pushing (or staging a review branch).'),
};

const outputSchema = {
  status: z.enum(['pushed', 'conflict', 'nothing-to-push', 'awaiting-approval', 'remote-moved']),
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
  conflictTruncated: z
    .boolean()
    .optional()
    .describe(
      'True iff any file in conflictFiles has an `elided` entry (conflictDetail: "auto" cut ' +
        'something to fit the payload budget). Absent unless status === "conflict".',
    ),
  // status === 'awaiting-approval'
  base: z.string().optional(),
  diff: z.string().optional(),
  diffFiles: z.array(diffFileSchema).optional(),
};

/**
 * Flatten a SafePushResult into the tool's flat structuredContent (remote redacted). A conflict's
 * per-file payload is bounded by `planConflictPayload` and shared verbatim with the text channel
 * (`renderConflictText` computes the same plan from the same `{ detail }`, deterministically) — so
 * `conflictDetail` decides once and both channels agree on what got cut.
 */
function safePushToolResult(
  res: SafePushResult,
  secrets: Array<string | undefined>,
  conflictDetail: 'auto' | 'full',
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
  if (res.remoteHead && !res.conflict) structured.remoteHead = res.remoteHead;
  if (res.conflict) {
    const plan = planConflictPayload(res.conflict.files, {
      detail: conflictDetail,
      refs: { mergeBase: res.conflict.mergeBase, rebasedOnto: res.conflict.rebasedOnto },
    });
    structured.conflictFiles = buildConflictFilePayload(res.conflict, plan);
    structured.conflictPaths = res.conflict.conflictPaths;
    structured.rebasedOnto = res.conflict.rebasedOnto;
    structured.remoteHead = res.conflict.remoteHead;
    structured.mergeBase = res.conflict.mergeBase;
    structured.remoteCommits = res.conflict.remoteCommits;
    structured.conflictTruncated = plan.truncated;
  }
  // Put the full resolution payload in the model-visible text, not only structuredContent (which a
  // client may drop): per-file sides, the remote head to echo back, and what landed upstream.
  const text = res.conflict
    ? renderConflictText(res.summary, res.conflict, { detail: conflictDetail })
    : res.status === 'remote-moved'
      ? [res.summary, renderLandedUpstream(res.rebasedOver)].filter(Boolean).join('\n')
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
        'half-merged) and returns status "conflict" with a per-file base/ours/theirs plus a marker ' +
        '`hunks` view, and top-level conflictPaths (every conflicted path, never capped or elided), ' +
        'remoteHead, mergeBase, and remoteCommits (all in the result text, not just ' +
        'structuredContent). By default (conflictDetail: "auto") that per-file payload is budgeted ' +
        'to fit in one tool result: hunks are allocated first, in file order, since they cannot be ' +
        'cheaply re-derived once the rebase aborts; base/ours/theirs are allocated next, in file ' +
        'order and base-then-ours-then-theirs, each individually capped so one huge side cannot ' +
        `starve every other file's sides. Past ${CONFLICT_MAX_FILES} conflicted files the rest get ` +
        'no per-file detail at all (still fully listed in conflictPaths); conflictTruncated is true ' +
        'whenever any of that fired. An elided side is fetchable in one call via ' +
        'read_file(path, ref); an elided hunks block has no ref of its own — reconstruct it from ' +
        'the (fetched) sides. Set conflictDetail: "full" for the complete, uncapped payload ' +
        'instead. It never auto-resolves. ' +
        'To resolve, retry with `resolutions` (the full merged content per conflicted file; the set ' +
        'is validated and missing/extra files are named), optionally passing expectedRemoteHead ' +
        '(the reported remoteHead) so the push is refused if the remote moved again. `.bib` files ' +
        'need confirmBibEdit. Read any side directly with read_file(path, ref) using remoteHead/' +
        'mergeBase. Each reported commit (rebasedOver, remoteCommits) lists the files it touched ' +
        'with added/removed line counts; for the content, diff with ref: "<hash>~1..<hash>". ' +
        'If the remote moves during the push, the pull-rebase is retried up to 3 times; ' +
        'if it still loses the race the result is status "remote-moved" (nothing pushed, clone ' +
        'intact) — re-run push. That retry does not apply when expectedRemoteHead was given: it is ' +
        'one attempt only, refused as "remote-moved" on a second lost race. Branch mode commits to ' +
        'a local review branch and lands it only on ' +
        'approve=true. Once past the live-peer guard, untracked files never block a push; uncommitted ' +
        'modifications to files git already ' +
        'tracks do, since git cannot rebase over them — commit first (or discard them); a ' +
        "`message` here commits the WHOLE working tree, including any peers' in-flight work, so " +
        'prefer committing your own edits first. Requires confirm=true. See docs/CONCURRENCY.md.',
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
      conflictDetail = 'auto',
    }) => {
      try {
        const cfg = ctx.projectManager.requireGitProject(project, 'push to');
        const { id, dir } = await ctx.projectManager.requireProjectDir(cfg.id);
        const auth = await ctx.credentials.resolve(cfg);
        const secrets = ctx.credentials.allSecrets();

        return await ctx.projectManager.runExclusive(id, async () => {
          await ctx.sessions.touch(id);
          await ctx.shadows.refresh(id, dir);
          await guardPeerWork(ctx, id, dir);

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
            await ctx.shadows.refresh(id, dir);
            return safePushToolResult(res, secrets, conflictDetail);
          }

          if (mode === 'branch') {
            if (!branch) throw new Error('Branch mode requires a "branch" name.');
            if (approve) {
              const res = await ctx.git.landBranch(dir, cfg.gitUrl, auth, { branch, base });
              return safePushToolResult(res, secrets, conflictDetail);
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
          // The rebase moved HEAD, so carry this session's remaining shadow onto it — and settle
          // whatever of it just went out.
          await ctx.shadows.refresh(id, dir);
          return safePushToolResult(res, secrets, conflictDetail);
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

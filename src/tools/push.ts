import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AppContext } from '../context.js';
import type { SafePushResult } from '../services/gitService.js';
import { errorResult } from '../lib/errors.js';
import { redact } from '../lib/redact.js';
import { redactGitUrlCredentials } from '../lib/gitUrlCredentials.js';
import {
  renderConflictText,
  renderLandedUpstream,
  renderRebasedOver,
  buildConflictFilePayload,
  capRemoteCommits,
} from '../lib/conflictText.js';
import {
  planConflictPayload,
  CONFLICT_MAX_FILES,
  CONFLICT_MAX_SPANS,
  CONFLICT_MAX_COMMITS,
  CONFLICT_MAX_COMMIT_FILES,
} from '../lib/conflictBudget.js';
import { guardPeerWork } from '../lib/peerRefusal.js';
import {
  planPushReviewDiff,
  renderPushReviewText,
  DIFF_CONTENT_BUDGET,
  DIFF_MAX_FILES,
} from '../lib/diffBudget.js';

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
    .describe(
      'Sides only. Normally the read_file(path, ref) call that fetches this part in full — but ' +
        'when the two histories are unrelated there is no merge base to read the `base` side ' +
        'from, and this instead states that, so check it looks like a call before issuing one.',
    ),
  count: z.number().optional().describe('hunks only: how many hunks were elided.'),
  spans: z
    .array(z.object({ startLine: z.number(), endLine: z.number() }))
    .optional()
    .describe(
      'hunks only: the line span each elided hunk covered in the conflicted working file — ' +
        `capped at the first ${CONFLICT_MAX_SPANS}; \`count\` is the true total, so \`count > ` +
        'spans.length` means the rest were dropped.',
    ),
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
  filesOmitted: z
    .number()
    .optional()
    .describe(
      `Files beyond the first ${CONFLICT_MAX_COMMIT_FILES} of this commit, not listed above — ` +
        'diff with ref: "<hash>~1..<hash>" for the full list. Only present on a conflict result ' +
        'with conflictDetail: "auto" (the default) when this commit touched more.',
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
      'With `resolutions`: the `remoteHead` from the conflict you merged against — that commit ' +
        'SHA (4 to 40 hex characters, full or abbreviated as the conflict text prints it); a ref ' +
        'name such as "origin/master" is refused, since it would always match the remote it ' +
        'names. If the remote has advanced past it, the push is refused instead of merging over ' +
        'what just landed. ' +
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
  remoteCommits: z
    .array(remoteCommitSchema)
    .optional()
    .describe(
      `On a conflict result with conflictDetail: "auto" (the default), capped at ${CONFLICT_MAX_COMMITS} ` +
        `commits (each with at most ${CONFLICT_MAX_COMMIT_FILES} files, see \`filesOmitted\`) — see ` +
        '`remoteCommitsOmitted` for how many more landed. Uncapped for conflictDetail: "full", and ' +
        'uncapped on a successful push (rebasedOver).',
    ),
  remoteCommitsOmitted: z
    .number()
    .optional()
    .describe(
      `Commits beyond the ${CONFLICT_MAX_COMMITS} listed in \`remoteCommits\`, not present there — ` +
        'status.behindCommits lists them all, since the clone is back at its pre-push state after a ' +
        'conflict aborts the rebase. Present only on a conflict result with conflictDetail: "auto" ' +
        'when something was actually omitted.',
    ),
  conflictTruncated: z
    .boolean()
    .optional()
    .describe(
      'True iff conflictDetail: "auto" cut anything to fit the payload budget — a file in ' +
        `conflictFiles carries an \`elided\` entry, or conflicted files past ${CONFLICT_MAX_FILES} ` +
        'got no per-file block at all (still listed in conflictPaths). Absent unless status === ' +
        '"conflict".',
    ),
  // status === 'awaiting-approval'
  base: z.string().optional(),
  diff: z
    .string()
    .optional()
    .describe(
      'Branch mode, before approval: the unified patch of the review branch vs its base. ' +
        `Budgeted to ${DIFF_CONTENT_BUDGET} characters, so it may be cut at hunk boundaries with ` +
        'a "... N of M hunk(s) omitted" marker where each cut happened — see diffTruncated and ' +
        'diffNote. Empty means the branch commit changed nothing, never that the patch was cut ' +
        '(a cut always leaves the file headers behind).',
    ),
  diffFiles: z
    .array(diffFileSchema)
    .optional()
    .describe(
      `Per-file added/removed line counts for the review branch, at most ${DIFF_MAX_FILES} of ` +
        'them — see diffFilesOmitted.',
    ),
  diffChars: z
    .number()
    .optional()
    .describe(
      'Branch mode: characters in the FULL review patch, before any cut, so the real size is ' +
        'always known.',
    ),
  diffTruncated: z
    .boolean()
    .optional()
    .describe(
      'Branch mode: true iff anything was cut from the review payload — the patch, or the ' +
        'diffFiles list. Absent unless status === "awaiting-approval".',
    ),
  diffHunksOmitted: z
    .number()
    .optional()
    .describe('Branch mode: hunks cut from a file the review patch still shows.'),
  diffPatchFilesOmitted: z
    .number()
    .optional()
    .describe(
      'Branch mode: changed files given no section in the review patch at all — no headers, no ' +
        'hunks. Distinct from diffFilesOmitted, which is about the diffFiles summary: the two ' +
        'caps fire independently.',
    ),
  diffFilesOmitted: z
    .number()
    .optional()
    .describe('Branch mode: changed files cut from the diffFiles summary by its cap.'),
  diffNote: z
    .string()
    .optional()
    .describe(
      'Branch mode: what was cut from the review payload and how to read the rest. Present only ' +
        'when something actually was cut.',
    ),
};

/**
 * Flatten a SafePushResult into the tool's flat structuredContent (remote redacted). A conflict's
 * per-file payload is bounded by `planConflictPayload`, computed exactly once, and that same plan
 * object is passed verbatim to both `buildConflictFilePayload` and `renderConflictText` — so
 * `conflictDetail` decides once and both channels are asserted (`assertPlanMatchesFile`, file by
 * file) to agree on what got cut, rather than each recomputing its own plan and trusting the two
 * happen to match.
 */
function safePushToolResult(
  res: SafePushResult,
  secrets: Array<string | undefined>,
  conflictDetail: 'auto' | 'full',
): CallToolResult {
  const structured: Record<string, unknown> = {
    status: res.status,
    pushed: res.pushed,
    remote: redact(redactGitUrlCredentials(res.remote), secrets),
    branch: res.branch,
    summary: res.summary,
  };
  if (res.committedSha) structured.committedSha = res.committedSha;
  if (res.pushedCommits !== undefined) structured.pushedCommits = res.pushedCommits;
  if (res.pushedSha) structured.pushedSha = res.pushedSha;
  if (res.rebasedOver) structured.rebasedOver = res.rebasedOver;
  if (res.remoteHead && !res.conflict) structured.remoteHead = res.remoteHead;
  // Planned once here and passed VERBATIM to renderConflictText below (opts.plan) — the file
  // payload and the commit list are each decided exactly once, so text and structuredContent can
  // never disagree about what got cut.
  let plan: ReturnType<typeof planConflictPayload> | undefined;
  if (res.conflict) {
    plan = planConflictPayload(res.conflict.files, {
      detail: conflictDetail,
      refs: { mergeBase: res.conflict.mergeBase, rebasedOnto: res.conflict.rebasedOnto },
    });
    structured.conflictFiles = buildConflictFilePayload(res.conflict, plan);
    structured.conflictPaths = res.conflict.conflictPaths;
    structured.rebasedOnto = res.conflict.rebasedOnto;
    structured.remoteHead = res.conflict.remoteHead;
    structured.mergeBase = res.conflict.mergeBase;
    // "full" is the escape hatch for a caller that wants the complete payload and can take the
    // size — lifting the per-file caps but leaving remoteCommits capped would be inconsistent.
    if (conflictDetail === 'full') {
      structured.remoteCommits = res.conflict.remoteCommits;
    } else {
      const cappedCommits = capRemoteCommits(res.conflict.remoteCommits);
      structured.remoteCommits = cappedCommits.commits;
      if (cappedCommits.omitted > 0) structured.remoteCommitsOmitted = cappedCommits.omitted;
    }
    structured.conflictTruncated = plan.truncated;
  }
  // Put the full resolution payload in the model-visible text, not only structuredContent (which a
  // client may drop): per-file sides, the remote head to echo back, and what landed upstream.
  const text =
    res.conflict && plan
      ? renderConflictText(res.summary, res.conflict, { plan, detail: conflictDetail })
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
        'remoteHead, mergeBase, and remoteCommits (capped by default at ' +
        `${CONFLICT_MAX_COMMITS} commits/${CONFLICT_MAX_COMMIT_FILES} files each — ` +
        'remoteCommitsOmitted says how many more landed, and status.behindCommits always lists ' +
        'every one) (all in the result text, not just structuredContent). By default ' +
        '(conflictDetail: "auto") that per-file payload is budgeted ' +
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
        'approve=true; that pre-approval result carries the branch-vs-base patch in ' +
        `structuredContent.diff (and diffFiles), budgeted to ${DIFF_CONTENT_BUDGET} characters ` +
        `across at most ${DIFF_MAX_FILES} files — a large patch comes back cut at hunk ` +
        'boundaries with every cut marked and counted (diffTruncated, diffNote), and the whole ' +
        'change is one `diff` call away with ref: "<base>...<branch>". ' +
        'Once past the live-peer guard, untracked files never block a push; uncommitted ' +
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
          await guardPeerWork(
            { sessions: ctx.sessions, shadows: ctx.shadows, git: ctx.git },
            id,
            dir,
          );

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
            // The review payload is budgeted exactly as the conflict branch above is (issue
            // #160): `prepareBranch` diffs the whole review branch against its base, so this is
            // the largest patch this tool can produce, and an oversized result is rejected by the
            // client outright and delivers nothing (#68). ONE plan drives both channels —
            // `renderPushReviewText` reads the already-cut plan and never `prep.diff`.
            const review = planPushReviewDiff(prep.diff, prep.files, {
              summary: prep.summary,
              base: prep.base,
              branch: prep.branch,
            });
            return {
              content: [{ type: 'text', text: renderPushReviewText(prep.summary, review) }],
              structuredContent: {
                status: prep.status,
                pushed: false,
                remote: redact(redactGitUrlCredentials(cfg.gitUrl), secrets),
                branch: prep.branch,
                base: prep.base,
                summary: prep.summary,
                committedSha: prep.committedSha,
                diff: review.diff,
                diffFiles: review.diffFiles,
                diffChars: review.diffChars,
                diffTruncated: review.diffTruncated,
                diffHunksOmitted: review.diffHunksOmitted,
                diffPatchFilesOmitted: review.diffPatchFilesOmitted,
                diffFilesOmitted: review.diffFilesOmitted,
                ...(review.diffNote ? { diffNote: review.diffNote } : {}),
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

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { syncState, syncSummary } from '../lib/syncState.js';
import { toPosix } from '../lib/paths.js';
import { foldCase } from '../lib/caseFold.js';
import { collectPeerShadows, formatAge } from '../lib/peerAttribution.js';
import { latestTouch } from '../services/shadowStore.js';
import { renderCommitLines } from '../lib/conflictText.js';

const inputSchema = {
  project: z.string().optional(),
};

const diffFileSchema = z.object({
  path: z.string(),
  added: z.number(),
  removed: z.number(),
});

const commitSchema = z.object({
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

const outputSchema = {
  branch: z.string(),
  ahead: z.number().describe('Local commits not on the remote (unpushed).'),
  behind: z
    .number()
    .describe(
      'Remote commits not local. Non-zero means origin moved since the last sync — a push may conflict.',
    ),
  syncState: z
    .enum(['in-sync', 'ahead', 'behind', 'diverged'])
    .describe(
      'Clone state vs the tracked remote branch, from ahead/behind. "behind"/"diverged" mean ' +
        'origin moved; sync (project_sync) before pushing. Counts reflect the last fetch, not a live remote.',
    ),
  clean: z.boolean(),
  staged: z.array(z.string()),
  unstaged: z.array(z.string()),
  untracked: z.array(z.string()),
  aheadCommits: z
    .array(commitSchema)
    .describe('Local commits not yet on the remote (what a push would send).'),
  behindCommits: z
    .array(commitSchema)
    .describe('Remote commits not yet local (what landed upstream since the last sync).'),
  externalChanges: z
    .array(z.string())
    .describe('Files changed on disk directly (not via this server this session).'),
  session: z.string().describe('Id of this session.'),
  sessionChanges: z
    .array(z.string())
    .describe('Uncommitted files this session edited — what a default commit would send.'),
  otherChanges: z
    .array(z.string())
    .describe(
      "Uncommitted files this session did not edit — another session's in-flight work, or " +
        'edits made outside this server. A default commit leaves these alone.',
    ),
  activeSessions: z
    .array(
      z.object({
        session: z.string(),
        live: z.boolean(),
        lastSeen: z.string(),
        changes: z
          .array(z.string())
          .nullable()
          .describe(
            "Every path in that session's shadow index (all of them, not only currently dirty " +
              'ones); null when the index could not be read.',
          ),
        lastWriteAt: z
          .string()
          .nullable()
          .describe(
            'The last write that session made through this server (edits made outside the ' +
              'server leave no trace here); null when unknown.',
          ),
      }),
    )
    .describe('Other sessions known to be working on this project.'),
  conflictedChanges: z
    .array(z.string())
    .describe(
      'Files this session edited that a commit has since changed on the same lines. They are ' +
        'excluded from commits until re-read and re-edited on the current content.',
    ),
};

export function registerStatus(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'status',
    {
      title: 'Git status',
      description:
        'Show branch, sync state (ahead/behind vs the tracked remote — a non-zero "behind" means ' +
        'origin moved since the last sync and a push may conflict), and staged/unstaged/untracked ' +
        'files. Counts reflect the last fetch; run project_sync to refresh them. Each reported ' +
        'commit (aheadCommits, behindCommits) lists the files it touched with added/removed line ' +
        'counts; for the content, diff with ref: "<hash>~1..<hash>". Also splits the ' +
        "uncommitted changes into this session's and other sessions', and lists the other agent " +
        'sessions currently working on the project.',
      inputSchema,
      outputSchema,
    },
    async ({ project }) => {
      try {
        ctx.projectManager.requireGitProject(project, 'report status against');
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        const status = await ctx.git.status(dir);
        await ctx.sessions.touch(id);
        // Carry this session's shadow onto the current HEAD first, so the split below reflects
        // what a commit would actually do rather than a stale picture.
        await ctx.shadows.refresh(id, dir);
        const changes = await ctx.shadows.changes(id);
        const dirty = [...status.unstaged, ...status.untracked].map(toPosix);
        // git reports a dirty file in the index's spelling; on a `core.ignorecase` clone that can
        // differ in case from the spelling this session wrote it under (its shadow key), so the
        // split folds the way git does there and stays byte-exact everywhere else — the same
        // rule `commit` and `push` apply.
        const fold = (await ctx.git.isCaseInsensitive(dir)) ? foldCase : (p: string) => p;
        const owned = new Set(changes.map((c) => fold(c.path)));
        const sessionChanges = dirty.filter((p) => owned.has(fold(p))).sort();
        const otherChanges = dirty.filter((p) => !owned.has(fold(p))).sort();
        const conflictedChanges = changes.filter((c) => c.conflicted).map((c) => c.path);
        const peers = (await ctx.sessions.peers(id)).filter((p) => !p.self);
        // Read-only, no lock: every peer's shadow index (live or not — a session that exited
        // still gets its last-known changes reported).
        const peerShadows = await collectPeerShadows(ctx.shadows, id, peers);
        // Flag files a human edited directly (as opposed to changes the tools made), so the
        // agent acknowledges them before writing over them.
        const externalChanges = await ctx.files.externalModifications(dir, [
          ...status.unstaged,
          ...status.untracked,
        ]);
        const peerDetail = (p: (typeof peers)[number]): string => {
          const entries = peerShadows.get(p.sessionId) ?? null;
          const segments: string[] = [];
          if (!p.live) segments.push('gone');
          if (entries === null) {
            segments.push('index unreadable');
          } else if (entries.length === 0) {
            segments.push('no changes');
          } else {
            // Cap what the text shows — a peer with a long-running session can list dozens of
            // touched paths, and this line is meant to be skimmed, not to duplicate the structured
            // `changes` array (which stays complete).
            const shown = entries.slice(0, 5).map((e) => e.path);
            const remaining = entries.length - shown.length;
            segments.push(
              remaining > 0 ? `${shown.join(', ')} and ${remaining} more` : shown.join(', '),
            );
            const lastWrite = latestTouch(entries);
            segments.push(
              lastWrite
                ? `last write ${formatAge(lastWrite, Date.now())} ago`
                : 'no write on record',
            );
          }
          return `${p.sessionId} (${segments.join('; ')})`;
        };
        const text = [
          `branch ${status.branch} — ${syncSummary(status.branch, status.ahead, status.behind)}`,
          status.clean ? 'working tree clean' : 'working tree has changes',
          status.staged.length ? `staged: ${status.staged.join(', ')}` : '',
          status.unstaged.length ? `unstaged: ${status.unstaged.join(', ')}` : '',
          status.untracked.length ? `untracked: ${status.untracked.join(', ')}` : '',
          status.behindCommits.length
            ? `landed upstream:\n${renderCommitLines(status.behindCommits).join('\n')}`
            : '',
          status.aheadCommits.length
            ? `to push:\n${renderCommitLines(status.aheadCommits).join('\n')}`
            : '',
          externalChanges.length
            ? `⚠ changed directly (not via tools): ${externalChanges.join(', ')}`
            : '',
          sessionChanges.length
            ? `this session ("${ctx.shadows.sessionId}") changed: ${sessionChanges.join(', ')}`
            : '',
          otherChanges.length ? `changed by others: ${otherChanges.join(', ')}` : '',
          conflictedChanges.length
            ? `⚠ conflicted (this session vs a commit): ${conflictedChanges.join(', ')}`
            : '',
          peers.length ? `other sessions: ${peers.map(peerDetail).join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            ...status,
            syncState: syncState(status.ahead, status.behind),
            externalChanges,
            session: ctx.shadows.sessionId,
            sessionChanges,
            otherChanges,
            conflictedChanges,
            activeSessions: peers.map((p) => {
              const entries = peerShadows.get(p.sessionId) ?? null;
              return {
                session: p.sessionId,
                live: p.live,
                lastSeen: p.heartbeatAt,
                changes: entries ? entries.map((e) => e.path) : null,
                lastWriteAt: entries ? latestTouch(entries) : null,
              };
            }),
          },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

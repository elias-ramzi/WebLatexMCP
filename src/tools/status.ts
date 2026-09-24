import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { syncState, syncSummary } from '../lib/syncState.js';
import { toPosix } from '../lib/paths.js';
import type { RemoteCommit } from '../services/gitService.js';
import { foldCase } from '../lib/caseFold.js';
import { dedupeFolded } from '../lib/peerRefusal.js';
import { collectPeerShadows, formatAge } from '../lib/peerAttribution.js';
import { latestTouch } from '../services/shadowStore.js';
import { splitStalePeers } from '../lib/peerSummary.js';
import {
  planCommitText,
  planStatusPayload,
  renderCommitBlock,
  renderPathListLine,
  STATUS_PEER_TEXT_PATHS,
  type StatusFlatListName,
  type StatusPeerInput,
  type StatusPeerPlan,
} from '../lib/statusBudget.js';

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

/**
 * Appended to every path list the payload budget can cut, because a cut changes what the field
 * promises and a field that still reads as complete is the reading a caller will act on.
 */
const CUT_NOTE =
  'May be cut to fit the result payload budget — pathsOmitted says how many went, per list, and ' +
  'truncated says whether anything did. An empty list always means git reported nothing.';

const outputSchema = {
  branch: z.string(),
  ahead: z.number().describe('Local commits not on the remote (unpushed).'),
  behind: z
    .number()
    .describe(
      'Remote commits not local. Non-zero means origin moved since the last sync — a push may conflict.',
    ),
  syncState: z
    .enum(['in-sync', 'ahead', 'behind', 'diverged', 'remote-branch-missing'])
    .describe(
      'Clone state vs the tracked remote branch, from ahead/behind. "behind"/"diverged" mean ' +
        'origin moved; sync (project_sync) before pushing. "remote-branch-missing" means the ' +
        'tracked branch is gone from the remote (see remoteBranchMissing). Counts reflect the ' +
        'last fetch, not a live remote.',
    ),
  remoteBranchMissing: z
    .boolean()
    .describe(
      'The last fetch found the tracked branch gone from the remote — renamed or deleted ' +
        'upstream. ahead/aheadCommits then count local commits on no remote branch, and behind ' +
        'is 0 because there is nothing to compare against. Never true for an empty remote.',
    ),
  remoteBranchNote: z
    .string()
    .optional()
    .describe('Present only when remoteBranchMissing: what the remote has now and what it means.'),
  clean: z
    .boolean()
    .describe(
      'Whether git reported a clean working tree. Derived from what git reported, never from ' +
        'what this report shows: a path list cut to fit the payload budget (see truncated) ' +
        'changes neither this nor ahead/behind/syncState.',
    ),
  staged: z.array(z.string()).describe(CUT_NOTE),
  unstaged: z.array(z.string()).describe(CUT_NOTE),
  untracked: z.array(z.string()).describe(CUT_NOTE),
  aheadCommits: z
    .array(commitSchema)
    .describe(
      'Local commits not yet on the remote (what a push would send). Complete — never capped ' +
        'while the tracked remote branch exists, unlike the text rendering below it, which shows ' +
        'the first few and says how many more. The one exception: when origin/<branch> is absent ' +
        '(remoteBranchMissing, a remote left with no branches, or a local branch never pushed), ' +
        'ahead counts every commit on no remote branch — possibly the whole history — so this ' +
        'list is then capped at 20 and aheadCommitsOmitted counts the rest.',
    ),
  aheadCommitsOmitted: z
    .number()
    .describe(
      'Commits left out of aheadCommits; 0 whenever the tracked remote branch exists. Non-zero ' +
        'only when origin/<branch> is absent and more than 20 local commits are on no remote ' +
        'branch — ahead still gives the true total.',
    ),
  behindCommits: z
    .array(commitSchema)
    .describe(
      'Remote commits not yet local (what landed upstream since the last sync). Complete — never ' +
        "capped: a conflict result's remoteCommits is capped and points here for the full list.",
    ),
  externalChanges: z
    .array(z.string())
    .describe(`Files changed on disk directly (not via this server this session). ${CUT_NOTE}`),
  session: z.string().describe('Id of this session.'),
  sessionChanges: z
    .array(z.string())
    .describe(
      'Uncommitted files this session edited (staged or not) — what a default commit would send. ' +
        CUT_NOTE,
    ),
  otherChanges: z
    .array(z.string())
    .describe(
      "Uncommitted files this session did not edit (staged or not) — another session's in-flight " +
        'work, or edits made outside this server. A default commit leaves these alone. ' +
        CUT_NOTE,
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
              'ones); null when the index could not be read. May be cut to fit the payload ' +
              'budget — changesOmitted says how many went, and is what tells a cut list apart ' +
              'from a session that recorded nothing.',
          ),
        changesOmitted: z
          .number()
          .describe(
            'Paths cut from changes by the payload budget; 0 when none were. Always 0 when ' +
              'changes is null: unreadable is not a cut, and neither is it "owns nothing".',
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
    .describe(
      'Other sessions known to be working on this project — except a session that has exited, ' +
        'has been quiet for hours, AND whose shadow index records no changes, which is left out ' +
        'here and counted in staleSessions instead.',
    ),
  staleSessions: z
    .number()
    .describe(
      'How many other sessions have exited, gone quiet for hours, and left a shadow index that ' +
        'records no changes, and are therefore left out of activeSessions rather than listed ' +
        'individually. An empty index cannot distinguish "this session recorded nothing" from ' +
        '"the index write itself failed", which is why a session that went quiet only recently ' +
        'stays listed instead. A session record is only removed on a clean shutdown, so a killed ' +
        'agent process leaves one behind forever — without this, activeSessions would grow ' +
        'without bound with sessions that are never coming back. A session whose shadow index ' +
        'could not be READ is never counted here: unreadable is not "owns nothing", so it stays ' +
        'listed individually with changes: null.',
    ),
  conflictedChanges: z
    .array(z.string())
    .describe(
      'Files this session edited that a commit has since changed on the same lines. They are ' +
        'excluded from commits until re-read and re-edited on the current content. ' +
        CUT_NOTE,
    ),
  truncated: z
    .boolean()
    .describe(
      'Whether anything was cut from this report to keep it inside its payload budget — paths, ' +
        "a peer's changes, or a whole session. False means every list here is complete. It is " +
        'never inferred from an empty list, and it never affects clean/ahead/behind/syncState, ' +
        'which come from git.',
    ),
  activeSessionsOmitted: z
    .number()
    .describe(
      'Other sessions not listed individually in activeSessions because the report lists at most ' +
        '20 (live sessions first, then the most recently seen); 0 when none were. Not the same ' +
        'fact as staleSessions, which counts sessions that exited having recorded nothing.',
    ),
  pathsOmitted: z
    .object({
      conflictedChanges: z.number(),
      externalChanges: z.number(),
      sessionChanges: z.number(),
      otherChanges: z.number(),
      activeSessionChanges: z.number(),
      staged: z.number(),
      unstaged: z.number(),
      untracked: z.number(),
    })
    .optional()
    .describe(
      'Paths cut from each list by the payload budget, present only when something was cut. ' +
        'activeSessionChanges is the total across every listed session (the per-session figure ' +
        'is activeSessions[].changesOmitted). Lists are kept in this priority order — ' +
        'conflictedChanges, externalChanges, sessionChanges, otherChanges, activeSessionChanges, ' +
        'staged, unstaged, untracked — so what blocks a commit survives a cut and the untracked ' +
        'tree is what goes.',
    ),
  note: z
    .string()
    .optional()
    .describe(
      'What the payload budget cut and where to look instead. Present only when something was cut.',
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
        'sessions currently working on the project. The path lists are bounded: a working tree ' +
        'with thousands of dirty or untracked files is cut to fit the result, with pathsOmitted ' +
        'saying how many went from each and truncated saying whether anything did. The commit ' +
        'lists are not — aheadCommits and behindCommits are complete, and only the text rendering ' +
        'of them is shortened — except aheadCommits when the tracked remote branch is absent, ' +
        'which is capped with aheadCommitsOmitted counting the rest.',
      inputSchema,
      outputSchema,
    },
    async ({ project }) => {
      try {
        ctx.projectManager.requireGitProject(project, 'report status against');
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        const status = await ctx.git.status(dir, { withCommits: true });
        await ctx.sessions.touch(id);
        // This session's shadow as it stands on the current HEAD, so the split below reflects
        // what a commit would actually do rather than a stale picture — computed, never written:
        // `status` takes no lock, and a persisting refresh here overwrote a concurrent `record`
        // and resurrected entries a peer's `discard` had just settled. The next locked
        // `commit`/`push`/`project_sync` carries the shadow forward for real.
        const changes = await ctx.shadows.refreshedChanges(id, dir);
        // git reports a dirty file in the index's spelling; on a `core.ignorecase` clone that can
        // differ in case from the spelling this session wrote it under (its shadow key), so the
        // split folds the way git does there and stays byte-exact everywhere else — the same
        // rule `commit` and `push` apply. Computed before the dedupe below, not after: on such a
        // clone the three git lists can name the very same file under two different spellings, and
        // deduping on the raw string would let both survive as if they were two files.
        const fold = (await ctx.git.isCaseInsensitive(dir)) ? foldCase : (p: string) => p;
        // Every path list this tool RETURNS is spelled the one way docs/tools.md's opening line
        // promises ("file paths are always POSIX, on every OS"), from one conversion each that
        // feeds the text channel and `structuredContent` alike. git's own output is already
        // `/`-separated, so none of this changes a byte on any platform today — it is the rule
        // being applied uniformly rather than to whichever list happened to get a `toPosix`,
        // which is what left one result carrying two spellings of the same kind of data (#148 §2).
        // Converted HERE and nowhere earlier: `status.unstaged`/`status.untracked` are handed to
        // `ctx.files.externalModifications` below, which resolves them against the filesystem, so
        // that call keeps getting the raw git spelling — the trap `toPosixOut`'s doc comment names.
        const staged = status.staged.map(toPosix);
        const unstaged = status.unstaged.map(toPosix);
        const untracked = status.untracked.map(toPosix);
        const aheadCommits = posixCommits(status.aheadCommits);
        const behindCommits = posixCommits(status.behindCommits);
        // `status.staged` joins the working-tree lists so a path dirty only in the index (a hand
        // `git add`, or an interrupted `commitContents`) is not invisible to `otherChanges`/
        // `sessionChanges` — the same rescue `commit`'s `scope: "paths"` already applies to its own
        // dirty set (`src/tools/commit.ts`, `commitPaths`). Deduped on the folded key, keeping the
        // first-seen spelling for display: a path can be both staged and unstaged (staged once,
        // then edited again), or — on an ignorecase clone — reported under two spellings.
        const dirty = dedupeFolded([...unstaged, ...untracked, ...staged], fold);
        const owned = new Set(changes.map((c) => fold(c.path)));
        const sessionChanges = dirty.filter((p) => owned.has(fold(p))).sort();
        const otherChanges = dirty.filter((p) => !owned.has(fold(p))).sort();
        const conflictedChanges = changes.filter((c) => c.conflicted).map((c) => toPosix(c.path));
        const peers = (await ctx.sessions.peers(id)).filter((p) => !p.self);
        // Read-only, no lock: every peer's shadow index (live or not — a session that exited
        // still gets its last-known changes reported).
        const peerShadows = await collectPeerShadows(ctx.shadows, id, peers);
        // A dead peer with a readably-empty shadow index holds nothing and is never coming back
        // (its record is only removed on a clean shutdown, which it did not have) — collapse it
        // into a count rather than listing it forever. `?? null` matches the lookup everywhere
        // else in this file: a sessionId missing from the map and one mapped to `null` both mean
        // "unreadable", which `isStalePeer` refuses to treat as "owns nothing". A dead peer that
        // went quiet only recently stays listed as well, because an empty index can also mean the
        // index write failed — see `RECENT_HEARTBEAT_GRACE_MS`.
        const now = Date.now();
        const { shown: shownPeers, stale: staleSessions } = splitStalePeers(peers, (p) => ({
          live: p.live,
          entries: peerShadows.get(p.sessionId) ?? null,
          heartbeatAgeMs: now - Date.parse(p.heartbeatAt),
        }));
        // Flag files a human edited directly (as opposed to changes the tools made), so the
        // agent acknowledges them before writing over them.
        // The raw git spellings go in (this reads the files off disk); the result comes back out
        // converted, like every other list here.
        const externalChanges = (
          await ctx.files.externalModifications(dir, [...status.unstaged, ...status.untracked])
        ).map(toPosix);
        // Everything the report may have to cut, handed to the planner in one piece: the flat path
        // lists and every listed peer's shadow index. `status` had no bound of any kind, and every
        // one of these ships twice — as JSON and joined into the text — so the budget is charged
        // across both channels and the text below is rendered from the ALREADY-CUT plan (#175).
        const peerInputs: StatusPeerInput[] = shownPeers.map((p) => {
          const entries = peerShadows.get(p.sessionId) ?? null;
          return {
            session: p.sessionId,
            live: p.live,
            lastSeen: p.heartbeatAt,
            changes: entries ? entries.map((e) => toPosix(e.path)) : null,
            lastWriteAt: entries ? latestTouch(entries) : null,
          };
        });
        const plan = planStatusPayload({
          staged,
          unstaged,
          untracked,
          externalChanges,
          sessionChanges,
          otherChanges,
          conflictedChanges,
          peers: peerInputs,
        });
        // The commit lists are budgeted in the TEXT channel only: `structuredContent`'s copies stay
        // complete because `conflictBudget.ts` caps its own `remoteCommits` and points a caller
        // mid-conflict at `status.behindCommits` for the full list. `renderCommitBlock` goes through
        // `renderCommitLines`, whose trailing "… N more commit(s) (see structuredContent)" is true
        // for exactly this reason.
        const behindText = planCommitText(behindCommits);
        const aheadText = planCommitText(aheadCommits);
        const peerDetail = (p: StatusPeerPlan): string => {
          const segments: string[] = [];
          if (!p.live) segments.push('gone');
          if (p.changes === null) {
            segments.push('index unreadable');
          } else if (p.changes.length === 0 && p.changesOmitted === 0) {
            // "nothing recorded", never "no changes": an empty index also covers a session whose
            // own index write failed, whose dirty lines are in the tree unowned. This line is the
            // channel a human actually reads, so it must not assert what the schema and the docs
            // deliberately stop short of — least of all about the recently-dead peer the grace in
            // `isStalePeer` keeps listed precisely so it stays a named suspect for those lines.
            segments.push('nothing recorded');
          } else {
            // Cap what the text shows — a peer with a long-running session can list dozens of
            // touched paths, and this line is meant to be skimmed, not to duplicate the structured
            // `changes` array. The shown paths come from the PLAN, not from the raw index, so the
            // two channels can never name a path the other one dropped; `and N more` still counts
            // against the true total, so the line stays truthful about how many there are.
            const total = p.changes.length + p.changesOmitted;
            const shown = p.changes.slice(0, STATUS_PEER_TEXT_PATHS);
            const remaining = total - shown.length;
            segments.push(
              remaining > 0 ? `${shown.join(', ')} and ${remaining} more` : shown.join(', '),
            );
            segments.push(
              p.lastWriteAt
                ? `last write ${formatAge(p.lastWriteAt, Date.now())} ago`
                : 'no write on record',
            );
          }
          return `${p.session} (${segments.join('; ')})`;
        };
        // Stale sessions are counted, never dropped silently — the "and N exited with nothing
        // recorded" clause survives even when nothing else is shown, so the line still says the
        // sessions exist rather than vanishing entirely. Same wording rule as `peerDetail` above:
        // what was collapsed is an empty *index*, which is not the same claim as a session that
        // changed nothing.
        const staleClause =
          staleSessions > 0
            ? `${staleSessions} session${staleSessions === 1 ? '' : 's'} exited with nothing recorded`
            : '';
        // A session the budget could not list is counted like a stale one — never dropped silently
        // — and stated as its own clause, because "not listed here" and "exited having recorded
        // nothing" are different facts about a session and a reader must not have to guess which.
        const omittedSessionsClause =
          plan.activeSessionsOmitted > 0
            ? `${plan.activeSessionsOmitted} more session${
                plan.activeSessionsOmitted === 1 ? '' : 's'
              } not listed`
            : '';
        const sessionClauses = [
          plan.peers.length > 0 ? plan.peers.map(peerDetail).join(', ') : '',
          staleClause,
          omittedSessionsClause,
        ].filter(Boolean);
        const otherSessionsLine =
          sessionClauses.length > 0
            ? `other sessions: ${
                sessionClauses.length === 1
                  ? sessionClauses[0]
                  : `${sessionClauses.slice(0, -1).join(', ')}, and ${sessionClauses.at(-1)}`
              }`
            : '';
        // Every list line is rendered from the plan's own paths, never from the full list: a text
        // channel built from the uncut lists would reintroduce exactly the payload the budget
        // exists to prevent — half the feature, reading as though it worked.
        const line = (label: string, name: StatusFlatListName): string =>
          plan.lists[name].length > 0
            ? renderPathListLine(label, plan.lists[name], plan.omitted[name])
            : '';
        const text = [
          `branch ${status.branch} — ${syncSummary(
            status.branch,
            status.ahead,
            status.behind,
            status.remoteBranchMissing,
          )}`,
          status.remoteBranchNote ?? '',
          status.clean ? 'working tree clean' : 'working tree has changes',
          line('staged', 'staged'),
          line('unstaged', 'unstaged'),
          line('untracked', 'untracked'),
          behindCommits.length
            ? `landed upstream:\n${renderCommitBlock(behindText).join('\n')}`
            : '',
          aheadCommits.length
            ? `to push:\n${[
                ...renderCommitBlock(aheadText),
                // Commits the capped (absent-branch) log never returned: the text's own "… N more
                // (see structuredContent)" covers only what structuredContent holds.
                ...(status.aheadCommitsOmitted > 0
                  ? [
                      `  … ${status.aheadCommitsOmitted} more commit(s) on no remote branch, ` +
                        'not listed anywhere (aheadCommitsOmitted)',
                    ]
                  : []),
              ].join('\n')}`
            : '',
          line('⚠ changed directly (not via tools)', 'externalChanges'),
          line(`this session ("${ctx.shadows.sessionId}") changed`, 'sessionChanges'),
          line('changed by others', 'otherChanges'),
          line('⚠ conflicted (this session vs a commit)', 'conflictedChanges'),
          otherSessionsLine,
          plan.note ?? '',
        ]
          .filter(Boolean)
          .join('\n');
        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            ...status,
            // Same values the text above was rendered from — one plan, two renderers — so the two
            // channels cannot disagree about a separator or about what got cut.
            staged: plan.lists.staged,
            unstaged: plan.lists.unstaged,
            untracked: plan.lists.untracked,
            // Not cut by the status budget: `conflictBudget.ts` caps a conflict's own
            // `remoteCommits` and sends the caller here for the full list. `behindCommits` is
            // complete; `aheadCommits` is complete while origin/<branch> exists, and capped at
            // CONFLICT_MAX_COMMITS by GitService.status (the rest counted in `aheadCommitsOmitted`)
            // when it is absent. Only their TEXT rendering is bounded here.
            aheadCommits,
            behindCommits,
            syncState: syncState(status.ahead, status.behind, status.remoteBranchMissing),
            externalChanges: plan.lists.externalChanges,
            session: ctx.shadows.sessionId,
            sessionChanges: plan.lists.sessionChanges,
            otherChanges: plan.lists.otherChanges,
            conflictedChanges: plan.lists.conflictedChanges,
            // Built field by field rather than spread: a plan object that grows a field would
            // otherwise reach the client undeclared, which the SDK passes through and the caller's
            // own validator then rejects with -32602 and no result at all.
            activeSessions: plan.peers.map((p) => ({
              session: p.session,
              live: p.live,
              lastSeen: p.lastSeen,
              changes: p.changes,
              changesOmitted: p.changesOmitted,
              lastWriteAt: p.lastWriteAt,
            })),
            staleSessions,
            activeSessionsOmitted: plan.activeSessionsOmitted,
            truncated: plan.truncated,
            ...(plan.truncated ? { pathsOmitted: plan.omitted } : {}),
            ...(plan.note ? { note: plan.note } : {}),
          },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

/**
 * A commit list with every touched-file path spelled POSIX — the same rule the flat path lists
 * above follow, applied to the one place a path hides inside a nested object. A commit's `files`
 * come from `git --numstat`, so they are already `/`-separated; the conversion is the convention
 * being visible rather than a fix, and it is a no-op on every platform.
 */
function posixCommits(commits: RemoteCommit[]): RemoteCommit[] {
  return commits.map((c) => ({
    ...c,
    files: c.files.map((f) => ({ ...f, path: toPosix(f.path) })),
  }));
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { toPosixOut } from '../lib/paths.js';
import type { SyncResult } from '../services/gitService.js';
import { enrichPullRefusal } from '../lib/peerRefusal.js';
import { strippedCredentialsNoteFor } from '../lib/gitUrlCredentials.js';
import { planSyncRegistration } from '../lib/syncRegistration.js';
import { quoteId } from '../lib/projectId.js';
import { originNote } from '../lib/originRepoint.js';
import { guardPeerWork } from '../lib/peerRefusal.js';
import { cloneLineNote, parseGitCloneLine } from '../lib/gitCloneLine.js';
import { conflictOutputFields, conflictPayload } from '../lib/conflictPayload.js';

const inputSchema = {
  project: z
    .string()
    .optional()
    .describe('Project id. Defaults to the configured default project.'),
  mode: z
    .enum(['auto', 'clone', 'pull', 'rebase'])
    .optional()
    .describe(
      'auto = clone if missing else ff-only pull (default). rebase = fetch, then fast-forward ' +
        'when possible, or — when local commits and the remote have diverged — replay the local ' +
        'commits onto the fetched remote: exactly the rebase push runs before pushing, minus the ' +
        'push. Never pushes. Refused, as push is, while a live peer session has uncommitted work ' +
        'in the clone and over uncommitted changes to tracked files. A conflict aborts it (the ' +
        'clone is left exactly as before) and returns action "conflict".',
    ),
  conflictDetail: z
    .enum(['auto', 'full'])
    .optional()
    .describe(
      'Mode "rebase" only: how much of a "conflict" result\'s per-file content to return — ' +
        'exactly push\'s conflictDetail ("auto", the default, budgets it; "full" is uncapped).',
    ),
  gitUrl: z
    .string()
    .optional()
    .describe(
      'Register a new project at this git URL (requires project id). Stored tokenless: a ' +
        'password or token embedded in an https URL is removed, never stored — supply it with ' +
        'set_credential or `tokenEnv` instead. A pasted `git clone <url>` (or `git clone <url> ' +
        '<dir>`) line is accepted: the URL is taken out of it and the directory ignored; a line ' +
        'with options (-b, --depth) is refused.',
    ),
};

const outputSchema = {
  project: z.string(),
  path: z.string(),
  action: z
    .enum([
      'cloned',
      'pulled',
      'up-to-date',
      'diverged',
      'remote-branch-missing',
      'rebased',
      'conflict',
    ])
    .describe(
      '"remote-branch-missing": the fetch found the tracked branch gone from the remote (renamed ' +
        'or deleted upstream) — nothing was pulled, ahead counts local commits on no remote ' +
        'branch, and note says what the remote has now. "diverged": local commits and the remote ' +
        'both moved and nothing was changed — sync with mode "rebase" to replay the local ' +
        'commits onto the remote. "rebased" (mode "rebase"): the local commits now sit on top of ' +
        'the remote tip; nothing was pushed. "conflict" (mode "rebase"): the rebase hit a ' +
        'conflict and was aborted — the clone is exactly as before; resolve with push ' +
        '`resolutions` + `expectedRemoteHead`, which pushes.',
    ),
  ahead: z.number(),
  behind: z.number(),
  diverged: z.boolean(),
  note: z
    .string()
    .optional()
    .describe(
      'With action "remote-branch-missing": what happened and what it means. With action ' +
        '"rebased": present only when local commits were dropped because an identical change ' +
        'had already landed upstream.',
    ),
  replayedCommits: z
    .number()
    .optional()
    .describe('Action "rebased" only: local commits now replayed on top of the remote tip.'),
  incomingCommits: z
    .number()
    .optional()
    .describe('Action "rebased" only: remote commits the local ones were rebased over.'),
  // action === "conflict": the same budgeted payload push returns on a rebase conflict.
  ...conflictOutputFields,
};

/** A clone/pull failure that already carries this call's notes (`withNotes`). */
class NotedSyncError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function registerProjectSync(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'project_sync',
    {
      title: 'Sync an Overleaf project',
      description:
        'Clone the project if it is not present locally, otherwise fast-forward pull (ff-only). ' +
        'If the local and remote histories have diverged, reports the divergence instead of ' +
        'merging — then sync again with mode "rebase", which replays the local commits onto the ' +
        'fetched remote (the same rebase push runs, minus the push: it never pushes) and reports ' +
        '"rebased", or on a conflict aborts (clone unchanged) and returns action "conflict" with ' +
        "push's conflict payload (conflictPaths, per-file base/ours/theirs/hunks, remoteHead), to " +
        'resolve with push `resolutions` + `expectedRemoteHead` — which pushes. Never run git ' +
        'pull or git rebase by hand in a shell: that bypasses the peer-session guards. ' +
        'If the tracked branch is gone from the remote (renamed or deleted upstream), reports ' +
        '"remote-branch-missing" rather than up-to-date.',
      inputSchema,
      outputSchema,
    },
    async ({ project, mode = 'auto', gitUrl, conflictDetail = 'auto' }) => {
      // What a re-pointing registration dropped (`planSyncRegistration`). Declared outside the
      // `try` because the registration below happens BEFORE the clone/pull, so a sync that then
      // fails (a typo'd gitUrl) has still replaced the held config: the error must name the loss
      // too, or a retry with the right URL — judged against the typo config — never would.
      let droppedNote = '';
      let failedDroppedNote = '';
      // Set once `origin` has been reconciled (inside the lock, below) — re-pointed, or found set
      // by hand to another URL: from then on every result — success, a failed clone/pull, or any
      // later refusal — must say so, since it says where the remote operation went. Last in every
      // text: the dropped-fields and credentials notes describe the registration, this one the
      // clone.
      let repointNote = '';
      // The same note for an error message (`NoteOptions.forError`: a remedy URL with a login name
      // would come out of `errorResult`'s scrubber as `https://***@…`).
      let repointErrorNote = '';
      try {
        // `registerProject` holds the URL without any http(s) secret; the caller must hear that
        // the token they pasted was not used — on success, and above all on a failed clone/pull,
        // which is then most likely an auth failure — exactly as `register_project` says it.
        // A pasted `git clone <url> [<dir>]` line is read as its URL first (a line with options is
        // refused, nothing registered), so the strip and its note judge the URL itself; the
        // caller hears that the prefix went, beside the credentials note it travels with.
        const cloneLine = gitUrl ? parseGitCloneLine(gitUrl) : undefined;
        const urlIn = cloneLine?.url ?? gitUrl;
        const credentialsNote =
          (cloneLine ? cloneLineNote(cloneLine) : '') +
          strippedCredentialsNoteFor(urlIn || undefined);
        // A failed clone/pull carries every note, in the success text's order (dropped fields
        // first), its dropped-fields note worded for a URL that may be the reason it failed; the
        // outer catch adds the plain dropped-fields note and the re-point note to any other failure.
        const withNotes = (err: unknown): unknown =>
          failedDroppedNote || credentialsNote || repointErrorNote
            ? new NotedSyncError(
                `${messageOf(err)}${failedDroppedNote}${credentialsNote}${repointErrorNote}`,
                err,
              )
            : err;
        if (urlIn) {
          if (!project) {
            throw new Error('Registering a project with gitUrl also requires a project id.');
          }
          // A re-stated URL keeps the registration's other fields; a re-point replaces it, and
          // the result text names what that dropped. Judged against the config this process
          // holds, env winning over the registry — or, for a restatement of the registry's URL,
          // against the registry's entry, so a stale snapshot cannot make it pin
          // (`planSyncRegistration`, `syncRegistrationBase`).
          const plan = planSyncRegistration(
            project,
            urlIn,
            ctx.projectManager.heldConfig(project),
            {
              entry: ctx.projectManager.previousRegistration(project),
              envConfigured: ctx.config.envProjectIds?.includes(project) ?? false,
            },
          );
          ctx.projectManager.registerProject(plan.next);
          // Only once the replace happened: a registration that refuses replaced nothing.
          droppedNote = plan.note;
          failedDroppedNote = plan.failedNote;
        } else {
          // No URL given: a peer's persisted re-registration first (`refreshedGitConfig`), so the
          // sync and its credential follow it rather than a stale snapshot's remote. With a URL,
          // the session-only registration above pins this session's choice instead — unless it
          // restates the registry's entry, which pins nothing (`ProjectManager.sessionPinned`).
          ctx.projectManager.refreshedGitConfig(project);
        }
        const cfg = ctx.projectManager.requireRemoteGitProject(project, 'sync with');
        const dir = ctx.projectManager.projectPath(cfg.id);
        const auth = await ctx.credentials.resolve(cfg);

        const result = await ctx.projectManager.runExclusive(cfg.id, async () => {
          // A re-registration that landed while this call waited for the lock is refused, not
          // reconciled back to the URL captured above (`assertRegistrationUnchanged`). With a
          // `gitUrl` too: a registration that restated the registry's entry is not pinned, so a
          // peer's re-registration in the window reaches it the same way.
          ctx.projectManager.assertRegistrationUnchanged(cfg);
          const cloned = await ctx.projectManager.hasClone(cfg.id);

          // A call refused on its arguments writes nothing to `.git/config` (as `push` refuses
          // before it reconciles), so this refusal comes before the reconcile below. The other
          // refusal (`pull` with no clone) has no clone to reconcile.
          if (cloned && mode === 'clone') {
            throw new Error(
              `Project ${quoteId(cfg.id)} is already cloned; use mode "pull" or "auto".`,
            );
          }

          // Where the fetch goes (`GitService.reconcileOrigin`, run again inside `syncPull`'s fetch,
          // where it is then a no-op): an origin the server owns follows the held URL; a hand-set
          // one is kept and named. Called here, after the mode refusal and before the pull, only
          // so this call can REPORT it — on success and on every failure after it.
          if (cloned) {
            const origin = await ctx.git.reconcileOrigin(dir, cfg.gitUrl);
            repointNote = originNote(origin, cfg.gitUrl, dir, 'this sync fetches from it');
            repointErrorNote = originNote(origin, cfg.gitUrl, dir, 'this sync fetches from it', {
              forError: true,
            });
          }

          let result: SyncResult;
          if (!cloned) {
            if (mode === 'pull' || mode === 'rebase') {
              throw new Error(
                `Project ${quoteId(cfg.id)} is not cloned yet; use mode "clone" or "auto".`,
              );
            }
            try {
              await ctx.git.clone(cfg.gitUrl, dir, auth, cfg.branch);
            } catch (err) {
              throw withNotes(err);
            }
            const ab = await ctx.git.aheadBehind(dir);
            result = { action: 'cloned', ahead: ab.ahead, behind: ab.behind, diverged: false };
          } else {
            try {
              result = await ctx.git.syncPull(
                cfg.gitUrl,
                dir,
                auth,
                mode === 'rebase'
                  ? {
                      rebase: true,
                      // push's own guard, run once a rebase is certain: this session's shadow
                      // carried onto HEAD first, then a refusal while a live peer has uncommitted
                      // work the rebase would sweep up or rewrite under it (`guardPeerWork`).
                      beforeRebase: async () => {
                        await ctx.sessions.touch(cfg.id);
                        await ctx.shadows.refresh(cfg.id, dir);
                        await guardPeerWork(
                          { sessions: ctx.sessions, shadows: ctx.shadows, git: ctx.git },
                          cfg.id,
                          dir,
                        );
                      },
                    }
                  : {},
              );
            } catch (err) {
              throw withNotes(
                await enrichPullRefusal(
                  { sessions: ctx.sessions, shadows: ctx.shadows, git: ctx.git },
                  cfg.id,
                  dir,
                  err,
                ),
              );
            }
          }

          // A clone, ff-pull or rebase rewrites files on disk; drop stale baselines so post-sync
          // content isn't misread as an out-of-band user edit. (A conflict aborted the rebase and
          // left the tree as it was, so it rewrote nothing.)
          const rewrote =
            result.action === 'cloned' || result.action === 'pulled' || result.action === 'rebased';
          if (rewrote) ctx.files.resetBaselines(dir);
          if (result.action === 'pulled' || result.action === 'rebased') {
            // A pull moves HEAD but keeps uncommitted work, so this session's changes are still
            // real — carry them onto the new HEAD rather than forgetting whose they are. Peers do
            // the same lazily on their next call.
            await ctx.shadows.refresh(cfg.id, dir);
          }
          return result;
        });

        // The response boundary, below `runExclusive` and every git/fs use of `dir` inside it
        // (`clone`, `syncPull`, `resetBaselines`, `shadows.refresh`), all of which need the host's
        // own spelling. Converted once here: this tool reports the SAME directory
        // `register_project` does, so a native `path` meant one server spelling one project's
        // directory two ways across two calls — the defect #99 is about (#99 names three emitters;
        // this is a fourth, found reviewing that fix).
        // `conflict` is the service's report, never a key of its own: it is flattened into push's
        // budgeted conflict keys (`conflictPayload`, one plan for both channels).
        const { conflict: report, ...rest } = result;
        const conflict = report ? conflictPayload(report, conflictDetail) : undefined;
        const payload = {
          project: cfg.id,
          ...toPosixOut({ path: dir }),
          ...rest,
          ...(conflict ? conflict.fields : {}),
        };
        const headline = `${cfg.id}: ${result.action} (ahead ${result.ahead}, behind ${result.behind})`;
        const body = conflict
          ? conflict.text(
              `${headline} — the rebase stopped on a conflict and was aborted: the clone is ` +
                'exactly as before, and nothing was pushed.',
            )
          : `${headline}${
              result.action === 'diverged'
                ? ' — diverged: nothing was changed. Sync with mode "rebase" to replay the local ' +
                  'commit(s) onto the remote (never pushes), or push, which rebases and then pushes.'
                : result.action === 'rebased'
                  ? ` — replayed ${result.replayedCommits ?? 0} local commit(s) onto ` +
                    `${result.incomingCommits ?? 0} incoming remote commit(s); nothing was pushed.`
                  : ''
            }${result.note ? `\n${result.note}` : ''}`;
        return {
          content: [
            {
              type: 'text',
              text: `${body}${droppedNote}${credentialsNote}${repointNote}`,
            },
          ],
          structuredContent: { ...payload },
        };
      } catch (err) {
        // Same shape as `withNotes`: the note rides on the message, the original error
        // stays the cause, and `errorResult` scrubs the whole text as before.
        const reported =
          (droppedNote || repointErrorNote) && !(err instanceof NotedSyncError)
            ? new Error(`${messageOf(err)}${droppedNote}${repointErrorNote}`, { cause: err })
            : err;
        return errorResult(reported, ctx.credentials.allSecrets());
      }
    },
  );
}

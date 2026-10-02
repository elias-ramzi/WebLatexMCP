import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { toPosixOut } from '../lib/paths.js';
import type { SyncResult } from '../services/gitService.js';
import { enrichPullRefusal } from '../lib/peerRefusal.js';
import { strippedCredentialsNoteFor } from '../lib/gitUrlCredentials.js';
import { planSyncRegistration } from '../lib/syncRegistration.js';
import { quoteId } from '../lib/projectId.js';

const inputSchema = {
  project: z
    .string()
    .optional()
    .describe('Project id. Defaults to the configured default project.'),
  mode: z
    .enum(['auto', 'clone', 'pull'])
    .optional()
    .describe('auto = clone if missing else ff-only pull (default).'),
  gitUrl: z
    .string()
    .optional()
    .describe(
      'Register a new project at this git URL (requires project id). Stored tokenless: a ' +
        'password or token embedded in an https URL is removed, never stored — supply it with ' +
        'set_credential or `tokenEnv` instead.',
    ),
};

const outputSchema = {
  project: z.string(),
  path: z.string(),
  action: z
    .enum(['cloned', 'pulled', 'up-to-date', 'diverged', 'remote-branch-missing'])
    .describe(
      '"remote-branch-missing": the fetch found the tracked branch gone from the remote (renamed ' +
        'or deleted upstream) — nothing was pulled, ahead counts local commits on no remote ' +
        'branch, and note says what the remote has now.',
    ),
  ahead: z.number(),
  behind: z.number(),
  diverged: z.boolean(),
  note: z
    .string()
    .optional()
    .describe('Present only with action "remote-branch-missing": what happened and what it means.'),
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
        'If the local and remote histories have diverged, reports the divergence instead of merging. ' +
        'If the tracked branch is gone from the remote (renamed or deleted upstream), reports ' +
        '"remote-branch-missing" rather than up-to-date.',
      inputSchema,
      outputSchema,
    },
    async ({ project, mode = 'auto', gitUrl }) => {
      // What a re-pointing registration dropped (`planSyncRegistration`). Declared outside the
      // `try` because the registration below happens BEFORE the clone/pull, so a sync that then
      // fails (a typo'd gitUrl) has still replaced the held config: the error must name the loss
      // too, or a retry with the right URL — judged against the typo config — never would.
      let droppedNote = '';
      let failedDroppedNote = '';
      try {
        // `registerProject` holds the URL without any http(s) secret; the caller must hear that
        // the token they pasted was not used — on success, and above all on a failed clone/pull,
        // which is then most likely an auth failure — exactly as `register_project` says it.
        const credentialsNote = strippedCredentialsNoteFor(gitUrl || undefined);
        // A failed clone/pull carries both notes, in the success text's order (dropped fields
        // first), its dropped-fields note worded for a URL that may be the reason it failed; the
        // outer catch adds the plain dropped-fields note alone to any other failure.
        const withNotes = (err: unknown): unknown =>
          failedDroppedNote || credentialsNote
            ? new NotedSyncError(`${messageOf(err)}${failedDroppedNote}${credentialsNote}`, err)
            : err;
        if (gitUrl) {
          if (!project) {
            throw new Error('Registering a project with gitUrl also requires a project id.');
          }
          // A re-stated URL keeps the registration's other fields; a re-point replaces it, and
          // the result text names what that dropped. Judged against the config this replaces —
          // the one this process holds, env winning over the registry (`planSyncRegistration`).
          const plan = planSyncRegistration(
            project,
            gitUrl,
            ctx.projectManager.heldConfig(project),
          );
          ctx.projectManager.registerProject(plan.next);
          // Only once the replace happened: a registration that refuses replaced nothing.
          droppedNote = plan.note;
          failedDroppedNote = plan.failedNote;
        }
        const cfg = ctx.projectManager.requireGitProject(project, 'sync with');
        const dir = ctx.projectManager.projectPath(cfg.id);
        const auth = await ctx.credentials.resolve(cfg);

        const result = await ctx.projectManager.runExclusive(cfg.id, async () => {
          const cloned = await ctx.projectManager.hasClone(cfg.id);

          let result: SyncResult;
          if (!cloned) {
            if (mode === 'pull') {
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
            if (mode === 'clone') {
              throw new Error(
                `Project ${quoteId(cfg.id)} is already cloned; use mode "pull" or "auto".`,
              );
            }
            try {
              result = await ctx.git.syncPull(cfg.gitUrl, dir, auth);
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

          // A clone or ff-pull rewrites files on disk; drop stale baselines so post-sync content
          // isn't misread as an out-of-band user edit.
          if (result.action === 'cloned' || result.action === 'pulled') {
            ctx.files.resetBaselines(dir);
          }
          if (result.action === 'pulled') {
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
        const payload = { project: cfg.id, ...toPosixOut({ path: dir }), ...result };
        return {
          content: [
            {
              type: 'text',
              text: `${cfg.id}: ${result.action} (ahead ${result.ahead}, behind ${result.behind})${
                result.diverged ? ' — diverged, resolve manually before pushing' : ''
              }${result.note ? `\n${result.note}` : ''}${droppedNote}${credentialsNote}`,
            },
          ],
          structuredContent: { ...payload },
        };
      } catch (err) {
        // Same shape as `withNotes`: the note rides on the message, the original error
        // stays the cause, and `errorResult` scrubs the whole text as before.
        const reported =
          droppedNote && !(err instanceof NotedSyncError)
            ? new Error(`${messageOf(err)}${droppedNote}`, { cause: err })
            : err;
        return errorResult(reported, ctx.credentials.allSecrets());
      }
    },
  );
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { LocalChangesOverwriteError, type SyncResult } from '../services/gitService.js';
import {
  attributePeers,
  collectPeerShadows,
  composeClosing,
  renderPeerRefusal,
  type ClosingVocabulary,
} from '../lib/peerAttribution.js';

/**
 * `project_sync`'s framing for the composed closing: pull vocabulary (there is no rebase here —
 * `syncPull` is a plain `merge --ff-only`), retrying by syncing rather than pushing.
 *
 * Only the framing is local. Which commit route applies to which group is composed by
 * `composeClosing` from the attribution, exactly as `push`'s closing is: this used to be a static
 * paragraph offering `scope: "paths"` first, which bounces off `commit`'s peer guard for any path a
 * live session owns — the same dead advice that guard exists to give, one message over. The typed
 * `LocalChangesOverwriteError` above still prescribes `scope: "paths"` for the collision as a
 * whole, which is right for the common case of the caller's own edits; this paragraph is what
 * corrects it for the subset a peer turns out to own.
 */
const PULL_VOCABULARY: ClosingVocabulary = {
  opening:
    'The pull would overwrite this in-flight work. A recent last write means the owner is ' +
    'mid-edit: wait for it to commit.',
  retry: 'Then sync again.',
};

/**
 * A pull refused with `LocalChangesOverwriteError` names which tracked file(s) block it, but not
 * whose edits they are. Attribute each named path to whichever live peer session's shadow claims
 * it — same shape as push's `guardPeerWork` (src/tools/push.ts) — so the caller can tell "wait for
 * a mid-edit peer" from "these are my own uncommitted changes".
 *
 * Paths this session itself owns (per its own shadow) are subtracted first, exactly as
 * `guardPeerWork` subtracts `mine` before attributing `theirs` — otherwise this session's own
 * edits would be reported as "not this session's", which is false. When nothing foreign remains
 * (or no live peer exists at all) there is nothing to attribute, so the plain typed message passes
 * through unchanged.
 *
 * The decoration itself can fail (an unreadable session dir, a transient fs error reading a peer's
 * shadow index) — that must never cost the caller the typed `LocalChangesOverwriteError` it needs
 * to act on, so any failure past the `instanceof` check falls back to the original error unchanged
 * rather than replacing it.
 */
async function enrichLocalChangesOverwrite(
  ctx: AppContext,
  id: string,
  err: unknown,
): Promise<Error> {
  if (!(err instanceof LocalChangesOverwriteError) || err.paths.length === 0) {
    return err instanceof Error ? err : new Error(String(err));
  }
  try {
    const peers = await ctx.sessions.livePeers(id);
    if (peers.length === 0) return err;

    const mine = new Set((await ctx.shadows.changes(id)).map((c) => c.path));
    const theirs = err.paths.filter((p) => !mine.has(p));
    if (theirs.length === 0) return err;

    const attribution = attributePeers(
      theirs,
      peers,
      await collectPeerShadows(ctx.shadows, id, peers),
    );
    const now = Date.now();
    const closing = composeClosing(attribution, PULL_VOCABULARY);
    return new Error(`${err.message}\n\n${renderPeerRefusal(theirs, attribution, now, closing)}`);
  } catch {
    return err;
  }
}

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
    .describe('Register a new project at this Overleaf git URL (requires project id).'),
};

const outputSchema = {
  project: z.string(),
  path: z.string(),
  action: z.enum(['cloned', 'pulled', 'up-to-date', 'diverged']),
  ahead: z.number(),
  behind: z.number(),
  diverged: z.boolean(),
};

export function registerProjectSync(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'project_sync',
    {
      title: 'Sync an Overleaf project',
      description:
        'Clone the project if it is not present locally, otherwise fast-forward pull (ff-only). ' +
        'If the local and remote histories have diverged, reports the divergence instead of merging.',
      inputSchema,
      outputSchema,
    },
    async ({ project, mode = 'auto', gitUrl }) => {
      try {
        if (gitUrl) {
          if (!project) {
            throw new Error('Registering a project with gitUrl also requires a project id.');
          }
          ctx.projectManager.registerProject({ id: project, gitUrl });
        }
        const cfg = ctx.projectManager.requireGitProject(project, 'sync with');
        const dir = ctx.projectManager.projectPath(cfg.id);
        const cloned = await ctx.projectManager.hasClone(cfg.id);
        const auth = await ctx.credentials.resolve(cfg);

        let result: SyncResult;
        if (!cloned) {
          if (mode === 'pull') {
            throw new Error(`Project "${cfg.id}" is not cloned yet; use mode "clone" or "auto".`);
          }
          await ctx.git.clone(cfg.gitUrl, dir, auth, cfg.branch);
          const ab = await ctx.git.aheadBehind(dir);
          result = { action: 'cloned', ahead: ab.ahead, behind: ab.behind, diverged: false };
        } else {
          if (mode === 'clone') {
            throw new Error(`Project "${cfg.id}" is already cloned; use mode "pull" or "auto".`);
          }
          try {
            result = await ctx.git.syncPull(cfg.gitUrl, dir, auth);
          } catch (err) {
            throw await enrichLocalChangesOverwrite(ctx, cfg.id, err);
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

        const payload = { project: cfg.id, path: dir, ...result };
        return {
          content: [
            {
              type: 'text',
              text: `${cfg.id}: ${result.action} (ahead ${result.ahead}, behind ${result.behind})${
                result.diverged ? ' — diverged, resolve manually before pushing' : ''
              }`,
            },
          ],
          structuredContent: { ...payload },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

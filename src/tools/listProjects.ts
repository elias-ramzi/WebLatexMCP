import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import {
  REWRITE_MODES,
  resolveRewriteMode,
  DEFAULT_REWRITE_MODE,
  rewriteModeSourceEnum,
} from '../lib/rewriteMode.js';
import type { RewriteMode } from '../lib/rewriteMode.js';

const outputSchema = {
  projects: z.array(
    z.object({
      project: z.string(),
      path: z.string(),
      mode: z
        .enum(['git', 'local'])
        .describe(
          '"git": a clone of a remote, with the full sync/commit/push workflow. "local": a ' +
            'directory edited in place, which the git tools do not apply to.',
        ),
      gitUrl: z.string().optional().describe('The remote — git projects only.'),
      cloned: z
        .boolean()
        .describe('Git: whether it is cloned yet. Local: whether the directory is there.'),
      rewriteMode: z
        .enum(REWRITE_MODES as unknown as [RewriteMode, ...RewriteMode[]])
        .describe(
          'What edit_file does with replaced text in this project: "always" comments the original ' +
            'out above the replacement, "prose" does so only for prose rewrites, "off" replaces ' +
            'outright. Change it with set_rewrite_mode.',
        ),
      rewriteModeSource: rewriteModeSourceEnum.describe(
        '"project" if stored for this project, "default" if nothing is stored.',
      ),
      envConfigured: z
        .boolean()
        .describe(
          'Whether WEB_LATEX_MCP_REWRITE_MODE actually names a mode on this server, as opposed ' +
            'to `rewriteMode` merely holding the built-in "prose" default. Orthogonal to ' +
            '`rewriteModeSource` (which only distinguishes stored from not-stored): when ' +
            '`rewriteModeSource` is "project" the stored mode wins regardless of this value.',
        ),
    }),
  ),
};

export function registerListProjects(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'List every project this server knows about — from the environment and from the workspace ' +
        'registry — with its local path, its mode ("git", a clone of a remote; "local", a ' +
        'directory edited in place) and whether it is there yet. Start here: if nothing is ' +
        'registered, the result says how to add one.',
      inputSchema: {},
      outputSchema,
    },
    async () => {
      try {
        const listed = await ctx.projectManager.listProjects();
        // The mode is reported here rather than in `status` because `status` requires a git
        // project, and a local in-place draft — the case this mode suits best — would never see it.
        const envDefault = ctx.config.rewriteMode ?? DEFAULT_REWRITE_MODE;
        // Whether to show the mode in the text line at all: suppress it only when the mode is
        // purely the *built-in* default (nothing stored, and no env var configured) — showing
        // nothing there is right, since there is nothing to say. But when
        // WEB_LATEX_MCP_REWRITE_MODE is set, that is a real configured setting a text-only client
        // must still see, even with nothing stored per-project (source stays "default" either way,
        // since that only distinguishes "stored" from "not stored").
        // Not `rewriteMode !== undefined`: loadConfig populates it with the built-in default when
        // the env names nothing, so that test calls every default install "configured".
        const envConfigured = ctx.config.rewriteModeExplicit === true;
        const projects = await Promise.all(
          listed.map(async (p) => {
            const resolved = resolveRewriteMode({
              stored: await ctx.rewriteModes.get(p.project),
              envDefault,
            });
            return {
              ...p,
              rewriteMode: resolved.mode,
              rewriteModeSource: resolved.source,
              envConfigured,
            };
          }),
        );
        // An empty workspace is the one moment the caller definitely does not know the workflow, so
        // spend the empty state teaching it rather than reporting a bare "none".
        const text =
          projects.length === 0
            ? 'No projects registered yet. Add one with register_project({ project: "<id>", ' +
              'gitUrl: "<git remote>" }) — an Overleaf, GitHub, or any git URL. It is persisted to ' +
              'the workspace, so it survives a restart and is visible to your other sessions, and it ' +
              'is cloned right away unless you pass clone: false.'
            : projects
                .map((p) => {
                  const state =
                    p.mode === 'local'
                      ? p.cloned
                        ? 'local, in place'
                        : 'local, MISSING'
                      : p.cloned
                        ? 'cloned'
                        : 'not cloned';
                  const rewrite =
                    p.rewriteModeSource === 'project'
                      ? `, rewrites: ${p.rewriteMode}`
                      : envConfigured
                        ? `, rewrites: ${p.rewriteMode} (env default)`
                        : '';
                  return `- ${p.project} [${state}${rewrite}] -> ${p.path}`;
                })
                .join('\n');
        return {
          content: [{ type: 'text', text }],
          structuredContent: { projects },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

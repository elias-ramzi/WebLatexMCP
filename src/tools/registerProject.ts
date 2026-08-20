import path from 'node:path';
import os from 'node:os';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { toPosix } from '../lib/paths.js';
import type { ProjectConfig } from '../types.js';

const inputSchema = {
  project: z.string().min(1).describe('Project id used in tool calls and as the clone dir name.'),
  gitUrl: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Git remote URL (Overleaf, GitHub, or any git host) — stored tokenless. Give this OR `path`.',
    ),
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Directory of a LaTeX project that already exists on this machine, to compile and edit ' +
        'IN PLACE — no clone, no remote, no second copy. Use this for a .tex that lives in a repo ' +
        'of your own (or nowhere in particular): the server reads and writes exactly these files, ' +
        'so what you compile is what your editor has open. Give this OR `gitUrl`. Git tools ' +
        '(status/diff/commit/push/sync) do not apply to a local project.',
    ),
  rootFile: z
    .string()
    .min(1)
    .optional()
    .describe('Explicit LaTeX root file (e.g. main.tex). Auto-detected when omitted.'),
  branch: z.string().min(1).optional().describe('Branch to clone/track. Defaults to the remote.'),
  username: z
    .string()
    .min(1)
    .optional()
    .describe('HTTPS username override (otherwise a per-host default is used).'),
  tokenEnv: z
    .string()
    .min(1)
    .optional()
    .describe('Name of the env var holding this project’s token (overrides host defaults).'),
  clone: z
    .boolean()
    .optional()
    .describe('Clone the project right away if it is not present locally (default true).'),
};

const outputSchema = {
  project: z.string(),
  path: z.string(),
  mode: z
    .enum(['git', 'local'])
    .describe('"git" for a cloned remote, "local" for a directory edited in place.'),
  persisted: z.boolean(),
  cloned: z
    .boolean()
    .describe('Git: whether the clone is present. Local: whether the directory is there.'),
};

/** Expand a leading `~`, then resolve against the server's launch dir, so any input form works. */
function resolveLocalPath(input: string): string {
  const expanded =
    input === '~'
      ? os.homedir()
      : input.startsWith('~/')
        ? path.join(os.homedir(), input.slice(2))
        : input;
  return path.resolve(expanded);
}

/**
 * A local project is only ever *pointed at*, never created: if the directory is not there, the
 * caller has the wrong path, and silently creating an empty one would hide that.
 */
async function requireDirectory(dir: string): Promise<void> {
  let info;
  try {
    info = await stat(dir);
  } catch {
    throw new Error(`No such directory: ${toPosix(dir)}. A local project must already exist.`);
  }
  if (!info.isDirectory()) {
    throw new Error(
      `${toPosix(dir)} is a file, not a directory. Register the directory that holds the ` +
        'document (the root .tex can be named with rootFile).',
    );
  }
}

export function registerRegisterProject(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'register_project',
    {
      title: 'Register a project (persisted)',
      description:
        'Register a LaTeX project and persist it to the workspace, so it survives a restart and is ' +
        'available to other sessions — no need to set WEB_LATEX_MCP_PROJECTS. Two kinds: pass ' +
        '`gitUrl` for a git-hosted project (Overleaf, GitHub, any remote), which is cloned ' +
        'immediately and can be synced and pushed — the intended path for Claude Desktop, where ' +
        'editing env config is awkward: just paste the git URL in the chat. Or pass `path` for a ' +
        'directory already on this machine, compiled and edited IN PLACE — the right choice for a ' +
        '.tex that lives in a repo of your own, since cloning that repo to reach one file leaves ' +
        'two copies of the document to drift apart. Exactly one of the two. Tokens are never ' +
        'stored; they are resolved per host at git time (see the auth docs).',
      inputSchema,
      outputSchema,
    },
    async ({
      project,
      gitUrl,
      path: localPath,
      rootFile,
      branch,
      username,
      tokenEnv,
      clone = true,
    }) => {
      try {
        if (gitUrl && localPath) {
          throw new Error(
            'Give either gitUrl (a remote to clone) or path (a directory to use in place), not both.',
          );
        }
        if (!gitUrl && !localPath) {
          throw new Error(
            'Give a gitUrl (a remote to clone) or a path (a directory already on this machine).',
          );
        }

        return await ctx.projectManager.runExclusive(project, async () => {
          if (localPath !== undefined) {
            const dir = resolveLocalPath(localPath);
            await requireDirectory(dir);
            const cfg: ProjectConfig = { id: project, mode: 'local', path: dir, rootFile };
            await ctx.projectManager.registerAndPersist(cfg);
            const payload = {
              project,
              path: toPosix(dir),
              mode: 'local' as const,
              persisted: true,
              cloned: true,
            };
            const text =
              `Registered "${project}" -> ${toPosix(dir)} (local, persisted to the workspace ` +
              'registry). Files there are read, edited and compiled in place — nothing is cloned ' +
              'or copied, and git tools (status/diff/commit/push/project_sync) do not apply. ' +
              'Compiled PDFs go to the workspace, not into that directory.';
            return {
              content: [{ type: 'text', text }],
              structuredContent: { ...payload },
            };
          }

          const cfg = await ctx.projectManager.registerAndPersist({
            id: project,
            // Narrowed by the guards above; `localPath` is undefined here.
            gitUrl: gitUrl as string,
            rootFile,
            branch,
            username,
            tokenEnv,
          });
          const dir = ctx.projectManager.projectPath(cfg.id);
          let cloned = await ctx.projectManager.hasClone(cfg.id);

          if (clone && !cloned) {
            const git = ctx.projectManager.requireGitProject(cfg.id, 'clone');
            const auth = await ctx.credentials.resolve(git);
            await ctx.git.clone(git.gitUrl, dir, auth, git.branch);
            ctx.files.resetBaselines(dir);
            cloned = true;
          }

          const payload = {
            project: cfg.id,
            path: dir,
            mode: 'git' as const,
            persisted: true,
            cloned,
          };
          // The clone dir sits inside the user's own repo in workspace-local mode. The server
          // already excluded it at startup; say so, or the caller cannot tell and adds a
          // redundant .gitignore entry on the user's behalf.
          const excludeNote = ctx.config.workspaceExcludePattern
            ? ` The clone dir is already excluded from the host repo's git ` +
              `("${ctx.config.workspaceExcludePattern}" in .git/info/exclude) — no .gitignore ` +
              'entry needed.'
            : '';
          const text =
            `Registered "${cfg.id}" -> ${gitUrl} (persisted to the workspace registry). ` +
            (cloned
              ? `Cloned at ${dir}.`
              : 'Not cloned yet — run project_sync to clone when you are ready.') +
            excludeNote;
          return {
            content: [{ type: 'text', text }],
            structuredContent: { ...payload },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

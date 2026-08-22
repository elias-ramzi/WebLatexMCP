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
      'A project that already exists on this machine, to compile and edit IN PLACE — no clone, ' +
        'no remote, no second copy. Give the directory, or **a file inside it** (e.g. ' +
        '"~/proposals/eurohpc.md" or "paper/main.tex") and the folder holding it is registered; ' +
        'a .tex named this way also becomes the LaTeX `rootFile`. The project is always the ' +
        'whole folder — every file in it is readable and editable, so point at a document in its ' +
        'own directory rather than one sitting loose in your home folder. Use this for a document ' +
        'that lives in a repo of your own, or nowhere in particular: the server reads and writes ' +
        'exactly these files, so what you compile is what your editor has open. Give this OR ' +
        '`gitUrl`. Git tools (status/diff/commit/push/sync) do not apply to a local project.',
    ),
  rootFile: z
    .string()
    .min(1)
    .optional()
    .describe('Explicit LaTeX root file (e.g. main.tex). Auto-detected when omitted.'),
  followSymlinks: z
    .boolean()
    .optional()
    .describe(
      'Local projects only. Let reads and writes follow a symlink that leaves the directory — for ' +
        'the layout where a shared file is linked into the project (`refs.bib -> ~/lab/refs.bib`, ' +
        '`figs/ -> ~/lab/figs`). Default false, and off is the safe answer: a link is followed to ' +
        'wherever it points, so a `notes.tex -> ~/.ssh/id_rsa` would be readable and writable. Set ' +
        'it only when the links in that directory are ones YOU put there — if it is a git working ' +
        'tree, a co-author can commit a symlink (git stores one as mode 120000) and a later pull ' +
        'brings it in. Paths the server picks up on its own (a compile log, a synctex record) are ' +
        'refused either way.',
    ),
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
 * Resolve what the caller pointed at into the directory to register — and, when they named a
 * `.tex`, the root file to compile.
 *
 * People point at the document, not the folder around it: "verify the citations in
 * ~/proposals/eurohpc.md" is the natural way to ask. A project is still a directory (the sandbox,
 * the compile unit, what `list_files` walks), so a file resolves to its parent rather than being
 * refused. Only a `.tex` becomes `rootFile`; a markdown or plain-text document is not a LaTeX root,
 * and naming it as one would break compilation for the sake of a tidier-looking registration.
 *
 * A local project is only ever *pointed at*, never created: if the target is not there, the caller
 * has the wrong path, and silently creating an empty directory would hide that.
 */
async function resolveLocalTarget(
  input: string,
): Promise<{ dir: string; rootFile?: string; pointedAtFile?: string }> {
  const target = resolveLocalPath(input);
  let info;
  try {
    info = await stat(target);
  } catch {
    throw new Error(
      `No such file or directory: ${toPosix(target)}. A local project must already exist.`,
    );
  }
  if (info.isDirectory()) return { dir: target };
  if (!info.isFile()) {
    throw new Error(
      `${toPosix(target)} is neither a file nor a directory. Point "path" at the document, ` +
        'or at the folder holding it.',
    );
  }
  const dir = path.dirname(target);
  const base = path.basename(target);
  return {
    dir,
    rootFile: path.extname(base).toLowerCase() === '.tex' ? base : undefined,
    pointedAtFile: base,
  };
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
      followSymlinks,
      branch,
      username,
      tokenEnv,
      clone = true,
    }) => {
      try {
        if (followSymlinks !== undefined && !localPath) {
          throw new Error(
            'followSymlinks applies to a local project (`path`) only. A clone is shared — anyone ' +
              'with push access can commit a symlink into it — so links out of it are always refused.',
          );
        }
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
            const target = await resolveLocalTarget(localPath);
            const dir = target.dir;
            // An explicit rootFile always wins over the one inferred from the file pointed at.
            const resolvedRoot = rootFile ?? target.rootFile;
            const cfg: ProjectConfig = {
              id: project,
              mode: 'local',
              path: dir,
              rootFile: resolvedRoot,
              followSymlinks,
            };
            await ctx.projectManager.registerAndPersist(cfg);
            const payload = {
              project,
              path: toPosix(dir),
              mode: 'local' as const,
              persisted: true,
              cloned: true,
            };
            // Say which directory was registered when they named a file: the project is the whole
            // folder, so that is what is readable and editable — not just the file they pointed at.
            const inferred = target.pointedAtFile
              ? `Pointed at "${target.pointedAtFile}", so registered the folder holding it. ` +
                (target.rootFile ? `LaTeX root: ${target.rootFile}. ` : '')
              : '';
            // Say which way the link policy landed: it is the one thing about a local project the
            // caller cannot see from the path, and "refs.bib is not there" is otherwise a puzzle.
            const links = followSymlinks
              ? ' Symlinks out of that folder are followed, as you asked — anything linked from it ' +
                'is readable and writable at the far end.'
              : ' A symlink pointing out of that folder is not followed (re-register with ' +
                'followSymlinks: true if the links in it are yours).';
            const text =
              `Registered "${project}" -> ${toPosix(dir)} (local, persisted to the workspace ` +
              `registry). ${inferred}Every file in that folder is readable and editable; they are ` +
              'read, edited and compiled in place — nothing is cloned or copied, and git tools ' +
              '(status/diff/commit/push/project_sync) do not apply. Compiled PDFs go to the ' +
              `workspace, not into that directory.${links}`;
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

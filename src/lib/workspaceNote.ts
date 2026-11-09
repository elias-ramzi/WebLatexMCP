import os from 'node:os';
import path from 'node:path';
import { quoteId } from './projectId.js';
import { toPosix } from './paths.js';

/**
 * Where the workspace is set, worded for every install: the server cannot tell the Desktop
 * extension from an npm or hand-configured one, and the env var is what each of them sets.
 * There is deliberately no tool or portal that moves it — the server reads it once at startup,
 * and in the extension a second place to set it would fight the settings form.
 */
export const WORKSPACE_SETTING =
  'WEB_LATEX_MCP_WORKSPACE (in the Claude Desktop extension: Settings → Extensions → ' +
  'WebLatexMCP → Clone workspace folder)';

/**
 * One sentence naming the workspace and how to move it. A move takes effect at the next start,
 * and the project list lives in the workspace, so the new folder starts with none.
 */
export function workspaceNote(workspaceRoot: string): string {
  return (
    `Workspace (clones and the project list): ${quoteId(toPosix(workspaceRoot))}. ` +
    `To move it, change ${WORKSPACE_SETTING} and restart the server; the new folder starts ` +
    'with an empty project list, and the old one is left as it is.'
  );
}

/**
 * For an empty project list: projects are registered in the server's fallback workspace, which
 * this server is not using. That covers a Desktop extension that ran on the fallback before its
 * form got a default folder, and any server launched with another workspace, so the
 * wording states where the projects are and how to use them, never that they were lost.
 */
export function fallbackWorkspaceNote(fallbackRoot: string, count: number): string {
  const projects = count === 1 ? '1 project is' : `${count} projects are`;
  return (
    `${projects} registered in ${quoteId(toPosix(fallbackRoot))}, a workspace this server is ` +
    `not using. To use them, point ${WORKSPACE_SETTING} at that folder and restart the server.`
  );
}

/**
 * The shell command that moves an older version's workspace-local folder into `workspaceRoot`.
 * `--to` is named whenever the destination is not the default, because the command reads the
 * shell's `WEB_LATEX_MCP_WORKSPACE`, not the server's — a server configured in a client's MCP
 * config would otherwise send the projects to a folder it does not read. `npx`, since the bare
 * binary is not on PATH for an npx or plugin install. Folders come from the launch dir and the
 * environment, so they are quoted and escaped like any id.
 */
export function migrateWorkspaceCommand(legacyRoot: string, workspaceRoot?: string): string {
  const to =
    workspaceRoot !== undefined && path.resolve(workspaceRoot) !== path.resolve(homeWorkspaceRoot())
      ? ` --to ${quoteId(toPosix(workspaceRoot))}`
      : '';
  return `npx web-latex-mcp migrate-workspace ${quoteId(toPosix(legacyRoot))}${to}`;
}

/** One sentence for `list_projects`, `server_info` and stderr naming a leftover older workspace. */
export function legacyWorkspaceNote(
  legacyRoot: string,
  count: number,
  workspaceRoot: string,
): string {
  const projects = count === 1 ? '1 project is' : `${count} projects are`;
  return (
    `${projects} registered in ${quoteId(toPosix(legacyRoot))}, the workspace-local folder of an ` +
    'older version, which this server no longer uses. Move them into the workspace in use with ' +
    `\`${migrateWorkspaceCommand(legacyRoot, workspaceRoot)}\` (close every other session on ` +
    'them first).'
  );
}

/** The default workspace, `~/.web-latex-mcp/projects` (the one `resolveWorkspace` picks unset). */
export function homeWorkspaceRoot(): string {
  return path.join(os.homedir(), '.web-latex-mcp', 'projects');
}

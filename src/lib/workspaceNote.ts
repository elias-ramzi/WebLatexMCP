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
 * this server is not using — most likely a Desktop extension that ran on the fallback before
 * its form got a default folder.
 */
export function fallbackWorkspaceNote(fallbackRoot: string, count: number): string {
  const projects = count === 1 ? '1 project is' : `${count} projects are`;
  return (
    `${projects} registered in ${quoteId(toPosix(fallbackRoot))}, a workspace this server is ` +
    `not using. To get them back, point ${WORKSPACE_SETTING} at that folder and restart the ` +
    'server.'
  );
}

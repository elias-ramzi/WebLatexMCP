import path from 'node:path';
import { readProjectRegistry, registryPath } from '../services/projectRegistry.js';
import { redactGitUrlCredentials } from './gitUrlCredentials.js';
import { escapeInvisibleChars, quoteId } from './projectId.js';
import { homeWorkspaceRoot } from './workspaceNote.js';

export { homeWorkspaceRoot };

function quotePath(p: string): string {
  return escapeInvisibleChars(JSON.stringify(p));
}

/**
 * The sentence an "Unknown project" error adds when the id IS registered — only in the other
 * registry this server does not read.
 *
 * A server whose `WEB_LATEX_MCP_WORKSPACE` names another folder keeps its projects there, while
 * one without it uses the shared `~/.web-latex-mcp/projects/registry.json`. A project registered
 * under one is unknown to the other, and the bare "Unknown project" sent the caller hunting. This reads the home registry
 * **to suggest**, never to load: adopting its entry here would give one id two workspaces, two
 * clones and two lock files, which the per-project lock exists to prevent. The suggestion is the
 * registration to repeat here, or the setting that points this server at the other registry.
 *
 * `''` when this server already uses the home workspace, when the home registry does not name the
 * id, or when it cannot be read (`readProjectRegistry` returns `[]` then). The git URL is
 * redacted, since a legacy entry may still carry a credential.
 */
export function otherRegistryHint(
  id: string,
  workspaceRoot: string,
  homeRoot: string = homeWorkspaceRoot(),
): string {
  if (path.resolve(workspaceRoot) === path.resolve(homeRoot)) return '';
  let entry;
  try {
    entry = readProjectRegistry(homeRoot).find((p) => p.id === id);
  } catch {
    return '';
  }
  if (!entry) return '';
  const where =
    `${quoteId(id)} is registered in ${quotePath(registryPath(homeRoot))}, which this server does ` +
    `not read: its workspace is ${quotePath(workspaceRoot)}.`;
  const register =
    entry.mode === 'local'
      ? `register_project with project ${quoteId(id)} and path ${quotePath(entry.path)}`
      : `register_project with project ${quoteId(id)} and gitUrl ${quotePath(redactGitUrlCredentials(entry.gitUrl))}`;
  return (
    ` ${where} Register it here (${register}), or set WEB_LATEX_MCP_WORKSPACE=` +
    `${quotePath(homeRoot)} to use that registry instead.`
  );
}

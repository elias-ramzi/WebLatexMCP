import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { ProjectConfig, ServerConfig } from './types.js';

const projectsSchema = z.record(
  z.string(),
  z.object({
    gitUrl: z.string().min(1),
    rootFile: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    tokenEnv: z.string().min(1).optional(),
  }),
);

/** Expand a leading `~` to the user's home directory. */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function parseProjects(raw: string | undefined): ProjectConfig[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`GIT_MCP_PROJECTS is not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
  const result = projectsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`GIT_MCP_PROJECTS is invalid: ${result.error.message}`);
  }
  return Object.entries(result.data).map(([id, cfg]) => ({ id, ...cfg }));
}

/**
 * Build the server configuration from environment variables. Pure and side-effect free
 * (other than reading `env`), so it can be unit-tested with a synthetic environment.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const workspaceRaw = env.GIT_MCP_WORKSPACE?.trim();
  const workspaceRoot = workspaceRaw
    ? path.resolve(expandHome(workspaceRaw))
    : path.join(os.homedir(), '.web-latex-mcp', 'projects');

  const projects = parseProjects(env.GIT_MCP_PROJECTS);
  const defaultProject = env.GIT_MCP_DEFAULT_PROJECT?.trim() || undefined;

  if (defaultProject && !projects.some((p) => p.id === defaultProject)) {
    throw new Error(
      `GIT_MCP_DEFAULT_PROJECT "${defaultProject}" is not present in GIT_MCP_PROJECTS.`,
    );
  }

  return { workspaceRoot, projects, defaultProject };
}

import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { CompilerKind, ProjectConfig, ServerConfig } from './types.js';

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

/**
 * Sentinel value for `WEB_LATEX_MCP_WORKSPACE` that clones into the coding agent's own
 * workspace — under `<launch-dir>/.web_latex_mcp` — so the `.tex`/PDF files sit right beside
 * the code the agent is working on. The launch dir is the server's cwd, which for a stdio
 * server spawned by Claude Code (or another agent) is the workspace root.
 */
const WORKSPACE_CWD_SENTINEL = 'cwd';

/** Name of the workspace-local clone directory used by the `cwd` sentinel. */
export const LOCAL_WORKSPACE_DIRNAME = '.web_latex_mcp';

interface ResolvedWorkspace {
  workspaceRoot: string;
  /** True when clones live inside the agent's workspace (the `cwd` sentinel). */
  workspaceIsLocal: boolean;
}

/** Resolve `WEB_LATEX_MCP_WORKSPACE` (raw env value) to an absolute clone root. */
function resolveWorkspace(raw: string | undefined, cwd: string): ResolvedWorkspace {
  const value = raw?.trim();
  if (!value) {
    return {
      workspaceRoot: path.join(os.homedir(), '.web-latex-mcp', 'projects'),
      workspaceIsLocal: false,
    };
  }
  if (value.toLowerCase() === WORKSPACE_CWD_SENTINEL) {
    return { workspaceRoot: path.join(cwd, LOCAL_WORKSPACE_DIRNAME), workspaceIsLocal: true };
  }
  // Relative paths resolve against the launch dir; absolute (and ~-expanded) paths pass through.
  return { workspaceRoot: path.resolve(cwd, expandHome(value)), workspaceIsLocal: false };
}

function parseProjects(raw: string | undefined): ProjectConfig[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`WEB_LATEX_MCP_PROJECTS is not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
  const result = projectsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`WEB_LATEX_MCP_PROJECTS is invalid: ${result.error.message}`);
  }
  return Object.entries(result.data).map(([id, cfg]) => ({ id, ...cfg }));
}

const COMPILERS: readonly CompilerKind[] = ['latexmk', 'tectonic'];

/** Select the compile backend from env, defaulting to latexmk. */
function parseCompiler(raw: string | undefined): CompilerKind {
  const value = raw?.trim().toLowerCase();
  if (!value) return 'latexmk';
  if (!(COMPILERS as readonly string[]).includes(value)) {
    throw new Error(
      `WEB_LATEX_MCP_COMPILER "${raw}" is invalid; expected one of: ${COMPILERS.join(', ')}.`,
    );
  }
  return value as CompilerKind;
}

/**
 * Build the server configuration from environment variables. Pure and side-effect free
 * (other than reading `env`), so it can be unit-tested with a synthetic environment.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ServerConfig {
  const { workspaceRoot, workspaceIsLocal } = resolveWorkspace(env.WEB_LATEX_MCP_WORKSPACE, cwd);

  const projects = parseProjects(env.WEB_LATEX_MCP_PROJECTS);
  const defaultProject = env.WEB_LATEX_MCP_DEFAULT_PROJECT?.trim() || undefined;

  if (defaultProject && !projects.some((p) => p.id === defaultProject)) {
    throw new Error(
      `WEB_LATEX_MCP_DEFAULT_PROJECT "${defaultProject}" is not present in WEB_LATEX_MCP_PROJECTS.`,
    );
  }

  const compiler = parseCompiler(env.WEB_LATEX_MCP_COMPILER);

  return { workspaceRoot, workspaceIsLocal, projects, defaultProject, compiler };
}

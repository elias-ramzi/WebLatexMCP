import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
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
 * Sentinel value for `WEB_LATEX_MCP_WORKSPACE` that forces clones into the coding agent's own
 * workspace — under `<launch-dir>/.web_latex_mcp` — so the `.tex`/PDF files sit right beside
 * the code the agent is working on. The launch dir is the server's cwd, which for a stdio
 * server spawned by Claude Code (or another agent) is the workspace root. This is also the
 * automatic default whenever the launch dir is inside a git repo (see `resolveWorkspace`).
 */
const WORKSPACE_CWD_SENTINEL = 'cwd';

/** Name of the workspace-local clone directory (the `cwd` sentinel and the in-repo default). */
export const LOCAL_WORKSPACE_DIRNAME = '.web_latex_mcp';

interface ResolvedWorkspace {
  workspaceRoot: string;
  /** True when clones live inside the agent's workspace (and are git-excluded from it). */
  workspaceIsLocal: boolean;
}

/** The shared home cache used when the launch dir isn't a suitable workspace. */
function homeWorkspace(): ResolvedWorkspace {
  return {
    workspaceRoot: path.join(os.homedir(), '.web-latex-mcp', 'projects'),
    workspaceIsLocal: false,
  };
}

/** Whether `dir` (or any ancestor) is a git working tree — walked synchronously via `.git`. */
function isInsideGitRepo(dir: string): boolean {
  let cur = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(cur, '.git'))) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/**
 * Resolve `WEB_LATEX_MCP_WORKSPACE` (raw env value) to an absolute clone root.
 *
 * Precedence: an explicit value always wins (the `cwd` sentinel forces workspace-local; any
 * other value is a path). When unset, the default is workspace-local (`<cwd>/.web_latex_mcp`)
 * *if the launch dir is inside a git repo and isn't the home dir itself* — the case where the
 * agent is clearly working in a project and the clone can be git-excluded from it. Otherwise it
 * falls back to the shared home cache (e.g. Claude Desktop launched from `/` or `~`).
 *
 * `insideRepo` is injectable so the default can be unit-tested without touching the filesystem.
 */
function resolveWorkspace(
  raw: string | undefined,
  cwd: string,
  insideRepo: (dir: string) => boolean = isInsideGitRepo,
): ResolvedWorkspace {
  const value = raw?.trim();
  if (!value) {
    const local = path.resolve(cwd) !== path.resolve(os.homedir()) && insideRepo(cwd);
    return local
      ? { workspaceRoot: path.join(cwd, LOCAL_WORKSPACE_DIRNAME), workspaceIsLocal: true }
      : homeWorkspace();
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
 * Build the server configuration from environment variables. Reads the filesystem only to
 * detect whether the launch dir is a git repo (for the workspace default); inject `insideRepo`
 * to keep unit tests hermetic.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  insideRepo?: (dir: string) => boolean,
): ServerConfig {
  const { workspaceRoot, workspaceIsLocal } = resolveWorkspace(
    env.WEB_LATEX_MCP_WORKSPACE,
    cwd,
    insideRepo,
  );

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

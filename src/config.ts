import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { readProjectRegistry } from './services/projectRegistry.js';
// One list of backends, shared with the resolver's fallback loop: a private copy here could
// accept a kind the fallback never tries (or reject one it does).
import { COMPILER_KINDS } from './services/compilerResolver.js';
import type { CompilerKind, ProjectConfig, ServerConfig, ViewerTarget } from './types.js';

/**
 * `WEB_LATEX_MCP_PROJECTS` entries: a git remote to clone, or a directory to use in place. An entry
 * without `mode` is a git project — which is every entry written before local mode existed.
 */
const projectsSchema = z.record(
  z.string(),
  z.union([
    z.object({
      mode: z.literal('git').optional(),
      gitUrl: z.string().min(1),
      rootFile: z.string().min(1).optional(),
      branch: z.string().min(1).optional(),
      username: z.string().min(1).optional(),
      tokenEnv: z.string().min(1).optional(),
    }),
    z.object({
      mode: z.literal('local'),
      path: z.string().min(1),
      rootFile: z.string().min(1).optional(),
      followSymlinks: z.boolean().optional(),
    }),
  ]),
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

function parseProjects(raw: string | undefined, cwd: string): ProjectConfig[] {
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
  return Object.entries(result.data).map(([id, cfg]) =>
    cfg.mode === 'local'
      ? // A path from the environment may be `~`-prefixed or relative to the launch dir, the same
        // as WEB_LATEX_MCP_WORKSPACE. Resolve it once here so everything downstream sees absolute.
        { id, ...cfg, path: path.resolve(cwd, expandHome(cfg.path)) }
      : { id, ...cfg },
  );
}

/**
 * Select the compile backend from env, defaulting to latexmk — and say whether that was a
 * *choice* or merely the default. Both answers come from this one emptiness test so they can
 * never disagree: unset, empty, and whitespace-only alike mean "not chosen", which is what
 * licenses a downstream fallback to whichever backend is installed. Naming a backend — even
 * the default one — is an assertion, never substituted.
 */
function parseCompilerChoice(raw: string | undefined): {
  kind: CompilerKind;
  explicit: boolean;
} {
  const value = raw?.trim().toLowerCase();
  if (!value) return { kind: 'latexmk', explicit: false };
  if (!(COMPILER_KINDS as readonly string[]).includes(value)) {
    throw new Error(
      `WEB_LATEX_MCP_COMPILER "${raw}" is invalid; expected one of: ${COMPILER_KINDS.join(', ')}.`,
    );
  }
  return { kind: value as CompilerKind, explicit: true };
}

/**
 * Resolve `WEB_LATEX_MCP_WRITING_GUIDE_EXTRA` — a path or a `file://` URL to an ADDITIONAL
 * writing guide, appended to (never replacing) the base one.
 *
 * A `file:` value MUST use the authority form `file://...` — a bare `file:conventions.md` (no
 * `//`) is not a relative-path shorthand, it's a URL whose path component is `conventions.md`,
 * which `fileURLToPath` resolves to `/conventions.md` (the filesystem root) — and on Windows to
 * the current drive's root. So: only `/^file:\/\//i` is treated as a URL; anything else starting
 * with `file:` but lacking `//` is malformed and must NOT fall through to the plain-path branch
 * either (that would silently turn it into `<cwd>/file:conventions.md`). Malformed input here is
 * never fatal — an optional overlay must not be able to take the whole server down — so this logs
 * a loud `[web-latex-mcp]` line to stderr (never stdout: that's the JSON-RPC channel) and returns
 * the same "nothing named" result as unset, for `loadConfig` to pass along unchanged.
 */
export function parseExtraWritingGuide(raw: string | undefined, cwd: string): { path?: string } {
  const value = raw?.trim();
  if (!value) return {};
  if (/^file:/i.test(value)) {
    if (!/^file:\/\//i.test(value)) {
      warnMalformedWritingGuideExtra(
        value,
        'a file: value must use the authority form file:// (e.g. file:///path/to/conventions.md), not a bare file:path',
      );
      return {};
    }
    let resolved: string;
    try {
      resolved = fileURLToPath(new URL(value));
    } catch (err) {
      warnMalformedWritingGuideExtra(value, `not a usable file:// URL: ${(err as Error).message}`);
      return {};
    }
    if (!path.isAbsolute(resolved)) {
      warnMalformedWritingGuideExtra(value, `resolved to a non-absolute path "${resolved}"`);
      return {};
    }
    if (isFilesystemRoot(resolved)) {
      warnMalformedWritingGuideExtra(value, `resolved to the filesystem root "${resolved}"`);
      return {};
    }
    return { path: resolved };
  }
  const plainResolved = path.resolve(cwd, expandHome(value));
  if (isFilesystemRoot(plainResolved)) {
    warnMalformedWritingGuideExtra(value, `resolved to the filesystem root "${plainResolved}"`);
    return {};
  }
  return { path: plainResolved };
}

/** True when `resolved` is a filesystem root (POSIX `/`, or a Windows drive root like `C:\`). */
function isFilesystemRoot(resolved: string): boolean {
  return path.dirname(resolved) === resolved || path.basename(resolved) === '';
}

function warnMalformedWritingGuideExtra(raw: string, reason: string): void {
  console.error(
    `[web-latex-mcp] WEB_LATEX_MCP_WRITING_GUIDE_EXTRA "${raw}" is not usable: ${reason}. ` +
      'Accepted forms: a plain path (e.g. /path/to/conventions.md) or a file:// URL with the ' +
      'authority form (e.g. file:///path/to/conventions.md). Ignoring it; no extra writing ' +
      'guide will be loaded.',
  );
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
  readRegistry: (workspaceRoot: string) => ProjectConfig[] = readProjectRegistry,
): ServerConfig {
  const { workspaceRoot, workspaceIsLocal } = resolveWorkspace(
    env.WEB_LATEX_MCP_WORKSPACE,
    cwd,
    insideRepo,
  );

  // Env projects are the explicit source of truth and always win; persisted (runtime-registered)
  // projects fill in the rest, so a git URL added from the chat is still here after a restart.
  const envProjects = parseProjects(env.WEB_LATEX_MCP_PROJECTS, cwd);
  const byId = new Map<string, ProjectConfig>();
  for (const p of readRegistry(workspaceRoot)) byId.set(p.id, p);
  for (const p of envProjects) byId.set(p.id, p);
  const projects = [...byId.values()];

  const defaultProject = env.WEB_LATEX_MCP_DEFAULT_PROJECT?.trim() || undefined;

  if (defaultProject && !projects.some((p) => p.id === defaultProject)) {
    throw new Error(
      `WEB_LATEX_MCP_DEFAULT_PROJECT "${defaultProject}" is not present in WEB_LATEX_MCP_PROJECTS.`,
    );
  }

  const { kind: compiler, explicit: compilerExplicit } = parseCompilerChoice(
    env.WEB_LATEX_MCP_COMPILER,
  );
  const viewerPort = parseViewerPort(env.WEB_LATEX_MCP_VIEWER_PORT);
  const viewerTarget = parseViewerTarget(env.WEB_LATEX_MCP_VIEWER_TARGET);
  const { path: extraWritingGuidePath } = parseExtraWritingGuide(
    env.WEB_LATEX_MCP_WRITING_GUIDE_EXTRA,
    cwd,
  );

  return {
    workspaceRoot,
    workspaceIsLocal,
    sessionId: parseSessionId(env.WEB_LATEX_MCP_SESSION),
    projects,
    defaultProject,
    compiler,
    compilerExplicit,
    viewerPort,
    viewerTarget,
    extraWritingGuidePath,
  };
}

/**
 * Resolve this process's session id. An explicit `WEB_LATEX_MCP_SESSION` is the useful case —
 * it names the session in `status` and keys its shadow of uncommitted work, so parallel agent
 * sessions on one project should each set a distinct, meaningful value. Unset, we generate one,
 * which still isolates this process's changes but reads as anonymous to peers.
 *
 * Sanitised to a safe directory name, since it becomes one under the session state dir.
 */
function parseSessionId(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return `session-${randomBytes(4).toString('hex')}`;
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (!safe) {
    throw new Error(
      `WEB_LATEX_MCP_SESSION "${raw}" has no usable characters; use letters, digits, ".", "_" or "-".`,
    );
  }
  return safe.slice(0, 64);
}

/** Parse the default viewer target from env; undefined (the default) means the OS browser. */
function parseViewerTarget(raw: string | undefined): ViewerTarget | undefined {
  const v = raw?.trim().toLowerCase();
  if (!v) return undefined;
  if (v === 'browser' || v === 'vscode') return v;
  throw new Error(
    `WEB_LATEX_MCP_VIEWER_TARGET "${raw}" is invalid; expected "browser" or "vscode".`,
  );
}

/** Parse an optional fixed viewer port; undefined (the default) means OS-assigned ephemeral. */
function parseViewerPort(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`WEB_LATEX_MCP_VIEWER_PORT "${raw}" is invalid; expected a port 0-65535.`);
  }
  return port;
}

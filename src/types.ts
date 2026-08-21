/**
 * A project the server can operate on. Two kinds, because syncing with a remote and compiling a
 * document are separate jobs: a **git** project is a remote the server clones and pushes back to,
 * a **local** project is a directory that already exists on disk and is edited where it lies.
 *
 * `mode` is the discriminant, and it is optional on the git variant on purpose: every project was a
 * git project before local mode existed, so existing env config and registry entries keep parsing.
 */
export type ProjectConfig = GitProjectConfig | LocalProjectConfig;

/** A project backed by a git remote (Overleaf, GitHub, or any host): cloned, synced, pushed. */
export interface GitProjectConfig {
  /** Friendly id used in tool calls and as the clone directory name. */
  id: string;
  mode?: 'git';
  /** Git remote URL (e.g. https://git.overleaf.com/<id> or https://github.com/<owner>/<repo>). Stored tokenless. */
  gitUrl: string;
  /** Optional explicit LaTeX root file (e.g. main.tex). Auto-detected when omitted. */
  rootFile?: string;
  /** Optional branch to clone/track. Defaults to the remote's default branch. */
  branch?: string;
  /** Optional HTTPS username override (otherwise a per-host default is used). */
  username?: string;
  /** Optional name of the env var holding this project's token (overrides host defaults). */
  tokenEnv?: string;
}

/**
 * A directory compiled and edited **in place** — no clone, no remote, no second copy of the
 * document. For "just build the .tex I already have", which is the case where cloning a repo to
 * reach one file leaves the user with two diverging copies of it.
 */
export interface LocalProjectConfig {
  /** Friendly id used in tool calls. */
  id: string;
  mode: 'local';
  /** Absolute path to the directory holding the document. Files are read and written here. */
  path: string;
  /** Optional explicit LaTeX root file (e.g. main.tex). Auto-detected when omitted. */
  rootFile?: string;
}

/** Where a configured project lives, and whether it is ready to use. */
export interface ProjectStatus {
  project: string;
  path: string;
  mode: 'git' | 'local';
  /** The remote, for git projects; absent for local ones. */
  gitUrl?: string;
  /** Git: whether it has been cloned. Local: whether the directory is there. */
  cloned: boolean;
}

/** A structured compile diagnostic parsed from the LaTeX log. */
export interface StructuredError {
  severity: 'error' | 'warning';
  /** Source file the diagnostic refers to, relative to the project when known. */
  file?: string;
  /** 1-based source line, when known. */
  line?: number;
  message: string;
  /** Short classification, e.g. "Undefined control sequence". */
  rule?: string;
}

/** Local compile backend. */
export type CompilerKind = 'latexmk' | 'tectonic';

/** Resolved server configuration, derived from the environment. */
export interface ServerConfig {
  /** Directory that holds one clone per project. */
  workspaceRoot: string;
  /**
   * True when `workspaceRoot` lives inside the agent's own workspace (the `cwd` sentinel),
   * so the server excludes it from the host repo's git on startup.
   */
  workspaceIsLocal?: boolean;
  /**
   * The pattern the server added to the host repo's `.git/info/exclude` at startup, when it did
   * (see `src/lib/workspaceExclude.ts`). Reported by `server_info`/`register_project` so a caller
   * knows the clone dir is already handled and does not "helpfully" add a redundant `.gitignore`
   * entry. Undefined when nothing was excluded (shared workspace, or not inside a git repo).
   */
  workspaceExcludePattern?: string;
  /**
   * Identifies this server process among sibling sessions sharing the same workspace, so each
   * one's uncommitted work can be tracked and committed separately. From
   * `WEB_LATEX_MCP_SESSION` when set (give each session a meaningful name — it is what `status`
   * shows peers as); otherwise generated per process.
   */
  sessionId: string;
  /** Registered projects. */
  projects: ProjectConfig[];
  /** Project id used when a tool call omits `project`. */
  defaultProject?: string;
  /** Local compile backend. `loadConfig` always resolves this; omit to default to `latexmk`. */
  compiler?: CompilerKind;
  /** Fixed port for the on-demand PDF viewer; omit for an OS-assigned ephemeral port. */
  viewerPort?: number;
  /** Default place to open the viewer: OS browser, or as a VSCode Simple Browser tab. */
  viewerTarget?: ViewerTarget;
}

/** Where the `viewer` tool expects the PDF viewer to be opened. */
export type ViewerTarget = 'browser' | 'vscode';

/** A single git project (Overleaf, GitHub, or any host) the server can operate on. */
export interface ProjectConfig {
  /** Friendly id used in tool calls and as the clone directory name. */
  id: string;
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

/** Clone status for a configured project. */
export interface ProjectStatus {
  project: string;
  path: string;
  gitUrl: string;
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

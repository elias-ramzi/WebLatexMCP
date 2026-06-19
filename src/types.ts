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

/** Resolved server configuration, derived from the environment. */
export interface ServerConfig {
  /** Directory that holds one clone per project. */
  workspaceRoot: string;
  /** Registered projects. */
  projects: ProjectConfig[];
  /** Project id used when a tool call omits `project`. */
  defaultProject?: string;
}

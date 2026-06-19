/** A single Overleaf project the server knows how to clone and operate on. */
export interface ProjectConfig {
  /** Friendly id used in tool calls and as the clone directory name. */
  id: string;
  /** Overleaf git remote URL, e.g. https://git.overleaf.com/<projectId>. Stored tokenless. */
  gitUrl: string;
  /** Optional explicit LaTeX root file (e.g. main.tex). Auto-detected when omitted. */
  rootFile?: string;
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

import { ProjectManager } from './services/projectManager.js';
import { GitService } from './services/gitService.js';
import { FileService } from './services/fileService.js';
import { LatexmkCompiler } from './services/compiler.js';
import type { LatexCompiler } from './services/compiler.js';
import type { AuthConfig, CommitIdentity } from './services/auth.js';
import type { ServerConfig } from './types.js';

/** Shared dependencies handed to every tool handler. */
export interface AppContext {
  config: ServerConfig;
  projectManager: ProjectManager;
  git: GitService;
  files: FileService;
  compiler: LatexCompiler;
}

export function createContext(
  config: ServerConfig,
  auth: AuthConfig,
  identity: CommitIdentity,
): AppContext {
  return {
    config,
    projectManager: new ProjectManager(config),
    git: new GitService(auth, identity),
    files: new FileService(),
    compiler: new LatexmkCompiler(),
  };
}

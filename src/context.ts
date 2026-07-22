import { ProjectManager } from './services/projectManager.js';
import { GitService } from './services/gitService.js';
import { FileService } from './services/fileService.js';
import { createCompiler } from './services/compiler.js';
import { ViewerService } from './services/viewer.js';
import { CredentialResolver } from './services/auth.js';
import { DblpService } from './services/dblp.js';
import { detectRootFile } from './lib/rootFile.js';
import { locateProjectPdf } from './lib/pdfLocate.js';
import type { LatexCompiler } from './services/compiler.js';
import type { CommitIdentity } from './services/auth.js';
import type { ServerConfig } from './types.js';

/** Shared dependencies handed to every tool handler. */
export interface AppContext {
  config: ServerConfig;
  projectManager: ProjectManager;
  git: GitService;
  files: FileService;
  compiler: LatexCompiler;
  viewer: ViewerService;
  credentials: CredentialResolver;
  dblp: DblpService;
}

export function createContext(
  config: ServerConfig,
  credentials: CredentialResolver,
  identity: CommitIdentity,
): AppContext {
  const projectManager = new ProjectManager(config);
  const files = new FileService();

  // The viewer resolves a project's current PDF the same way `compile` surfaces it. Constructed
  // here but not listening — it binds a port only when the `viewer` tool is first called.
  const viewer = new ViewerService({
    knownIds: () => projectManager.knownIds(),
    resolvePdfPath: async (id) => {
      try {
        const { dir } = await projectManager.requireClonedDir(id);
        const root = await detectRootFile(files, dir);
        return (await locateProjectPdf(config, id, dir, root)) ?? null;
      } catch {
        return null; // not cloned / no root / no PDF yet — page waits for a compile
      }
    },
  });

  return {
    config,
    projectManager,
    git: new GitService(identity),
    files,
    compiler: createCompiler(config.compiler ?? 'latexmk'),
    viewer,
    credentials,
    dblp: new DblpService(),
  };
}

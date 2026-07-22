import { ProjectManager } from './services/projectManager.js';
import { GitService } from './services/gitService.js';
import { FileService } from './services/fileService.js';
import { createCompiler, buildPdfPath } from './services/compiler.js';
import { ViewerService } from './services/viewer.js';
import { SyncTexService } from './services/synctex.js';
import { CommentStore } from './services/commentStore.js';
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
  synctex: SyncTexService;
  comments: CommentStore;
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
  const synctex = new SyncTexService();
  const comments = new CommentStore();

  // The viewer resolves a project's current PDF the same way `compile` surfaces it, and (for
  // comments) resolves a clicked PDF point to source via synctex against the build-dir PDF, which
  // is where the `.synctex.gz` lives. Constructed here but not listening — it binds a port only
  // when the `viewer` tool is first called.
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
    addComment: async (id, input) => {
      let file: string | undefined;
      let line: number | undefined;
      try {
        const { dir } = await projectManager.requireClonedDir(id);
        const root = await detectRootFile(files, dir);
        const loc = await synctex.resolve(
          buildPdfPath(dir, root),
          dir,
          input.page,
          input.x,
          input.y,
        );
        if (loc) ({ file, line } = loc);
      } catch {
        // Leave the location unresolved — the note is still kept (Claude can use the quote/page).
      }
      return comments.add(id, { ...input, file, line });
    },
    listComments: (id) => comments.list(id),
    updateComment: (id, commentId, note) => comments.update(id, commentId, { note }),
    deleteComment: (id, commentId) => comments.remove(id, commentId),
    undoDelete: (id) => comments.undo(id),
    resolveComments: (id, ids) => comments.resolve(id, ids),
  });

  return {
    config,
    projectManager,
    git: new GitService(identity),
    files,
    compiler: createCompiler(config.compiler ?? 'latexmk'),
    viewer,
    synctex,
    comments,
    credentials,
    dblp: new DblpService(),
  };
}

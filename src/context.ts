import { ProjectManager } from './services/projectManager.js';
import type { ProjectRegistryStore } from './services/projectManager.js';
import { GitService } from './services/gitService.js';
import { FileService } from './services/fileService.js';
import { createCompiler, buildPdfPath } from './services/compiler.js';
import { ViewerService } from './services/viewer.js';
import { SyncTexService } from './services/synctex.js';
import { CommentStore } from './services/commentStore.js';
import { CredentialResolver } from './services/auth.js';
import { DblpService } from './services/dblp.js';
import { SessionRegistry } from './services/sessionRegistry.js';
import { ShadowStore } from './services/shadowStore.js';
import { CredentialPortal } from './services/credentialPortal.js';
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
  /** Who else is working on a project right now — see `src/services/sessionRegistry.ts`. */
  sessions: SessionRegistry;
  /** This session's own uncommitted changes — see `src/services/shadowStore.ts`. */
  shadows: ShadowStore;
  /** Loopback page for entering a git token off the chat — see `src/services/credentialPortal.ts`. */
  credentialPortal: CredentialPortal;
}

export function createContext(
  config: ServerConfig,
  credentials: CredentialResolver,
  identity: CommitIdentity,
  registry?: ProjectRegistryStore,
): AppContext {
  const projectManager = new ProjectManager(config, registry);
  const files = new FileService();
  const synctex = new SyncTexService();
  const comments = new CommentStore();
  const git = new GitService(identity);

  const sessions = new SessionRegistry(config.workspaceRoot, config.sessionId);
  const shadows = new ShadowStore(config.workspaceRoot, config.sessionId, (dir, rel) =>
    git.readAtRef(dir, 'HEAD', rel),
  );
  // Every mutation this server makes is folded into this session's shadow, so `commit` can later
  // stage this session's lines alone. FileService is handed the hook rather than the store so it
  // stays unaware of sessions; the project id comes from the clone directory it was given.
  files.setMutationRecorder({
    record: async (projectDir, relPath, before, after) => {
      const id = projectManager.idForDir(projectDir);
      if (!id) return; // not one of our clones — nothing to attribute it to
      // Editing is what makes a session worth knowing about, so this doubles as its heartbeat —
      // otherwise a session that only writes would stay invisible to its peers until it committed.
      await sessions.touch(id);
      await shadows.record(id, projectDir, relPath, before, after);
    },
  });

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
    git,
    files,
    compiler: createCompiler(config.compiler ?? 'latexmk'),
    viewer,
    synctex,
    comments,
    credentials,
    dblp: new DblpService(),
    sessions,
    shadows,
    credentialPortal: new CredentialPortal((host, username, token) =>
      credentials.storeCredential(host, username, token),
    ),
  };
}

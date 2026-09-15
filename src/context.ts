import { ProjectManager } from './services/projectManager.js';
import type { ProjectRegistryStore } from './services/projectManager.js';
import { GitService } from './services/gitService.js';
import { FileService } from './services/fileService.js';
import { buildPdfPath } from './services/compiler.js';
import { CompilerResolver } from './services/compilerResolver.js';
import { PdfRenderer } from './services/pdfRender.js';
import { ViewerService } from './services/viewer.js';
import { SyncTexService } from './services/synctex.js';
import { CommentStore } from './services/commentStore.js';
import { CredentialResolver } from './services/auth.js';
import { DblpService } from './services/dblp.js';
import { DoctorService } from './services/doctor.js';
import { SessionRegistry } from './services/sessionRegistry.js';
import { ShadowStore } from './services/shadowStore.js';
import { RewriteModeStore } from './services/rewriteModeStore.js';
import { CredentialPortal } from './services/credentialPortal.js';
import { createSessionRecorder } from './lib/mutationRecorder.js';
import { detectRootFile } from './lib/rootFile.js';
import { locateProjectPdf } from './lib/pdfLocate.js';
import type { PdfRenderService } from './services/pdfRender.js';
import type { CommitIdentity } from './services/auth.js';
import type { ServerConfig } from './types.js';

/** Shared dependencies handed to every tool handler. */
export interface AppContext {
  config: ServerConfig;
  projectManager: ProjectManager;
  git: GitService;
  files: FileService;
  /**
   * Picks the compile backend that actually runs — see `src/services/compilerResolver.ts`. This is
   * the resolver rather than one `LatexCompiler` because the configured backend may not be on PATH,
   * and an *unchosen* default may then be substituted (an explicit choice never is).
   */
  compiler: CompilerResolver;
  /**
   * Rasterizes the compiled PDF so the model can *see* it — see `src/services/pdfRender.ts`.
   * Separate from `compiler` because it reads a finished PDF rather than producing one: it is
   * what `render_pages` renders through and where `compile` gets its `pageCount`.
   */
  pdfRenderer: PdfRenderService;
  viewer: ViewerService;
  synctex: SyncTexService;
  comments: CommentStore;
  credentials: CredentialResolver;
  dblp: DblpService;
  /** Local toolchain diagnostics — see `src/services/doctor.ts`. */
  doctor: DoctorService;
  /** Who else is working on a project right now — see `src/services/sessionRegistry.ts`. */
  sessions: SessionRegistry;
  /** This session's own uncommitted changes — see `src/services/shadowStore.ts`. */
  shadows: ShadowStore;
  /** Sticky per-project rewrite-preservation mode — see `src/services/rewriteModeStore.ts`. */
  rewriteModes: RewriteModeStore;
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
  const rewriteModes = new RewriteModeStore(config.workspaceRoot);
  // The clean-filter hasher lets ShadowStore judge HEAD/shadow equality the way `commitContents`
  // actually writes blobs (gitattributes-filtered), instead of raw bytes — otherwise a clone-wide
  // `* text=auto` normalising a binary asset's line endings looks like a peer's change and sticks
  // the entry `conflicted` forever (#63).
  const shadows = new ShadowStore(
    config.workspaceRoot,
    config.sessionId,
    (dir, rel) => git.readAtRefBytes(dir, 'HEAD', rel),
    undefined,
    (dir, rel, bytes) => git.cleanBlobId(dir, rel, bytes),
    // HEAD's commit sha, once per `refresh`, so a permanently conflicted entry is not re-merged and
    // re-hashed (two `git hash-object` spawns) on every status/commit/push while HEAD stands still.
    (dir) => git.headSha(dir),
    // Two spellings of one name are one file on an ignorecase clone — and must be one shadow
    // entry, or the second spelling's on-disk shadow file overwrites the first's.
    (dir) => git.isCaseInsensitive(dir),
  );
  // Every mutation this server makes is folded into this session's shadow, so `commit` can later
  // stage this session's lines alone. FileService is handed the hook rather than the store so it
  // stays unaware of sessions; the project id comes from the clone directory it was given.
  // A symlink out of a project is refused unless the project's owner has said the links in it are
  // theirs (`followSymlinks` on a local project). See setLinkPolicy.
  files.setLinkPolicy((dir) => projectManager.followsUserLinks(dir));

  files.setMutationRecorder(
    createSessionRecorder({
      idForDir: (dir) => projectManager.idForDir(dir),
      isLocal: (id) => projectManager.isLocal(id),
      touch: (id) => sessions.touch(id),
      record: (id, dir, rel, before, after) => shadows.record(id, dir, rel, before, after),
      markUnrecorded: (id, rel) => shadows.markUnrecorded(id, rel),
    }),
  );

  // The viewer resolves a project's current PDF the same way `compile` surfaces it, and (for
  // comments) resolves a clicked PDF point to source via synctex against the build-dir PDF, which
  // is where the `.synctex.gz` lives. Constructed here but not listening — it binds a port only
  // when the `viewer` tool is first called.
  const viewer = new ViewerService({
    knownIds: () => projectManager.knownIds(),
    resolvePdfPath: async (id) => {
      try {
        const { dir } = await projectManager.requireProjectDir(id);
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
        const { dir } = await projectManager.requireProjectDir(id);
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
    // `compilerExplicit` is the whole licence for a fallback: unset means `compiler` is only a
    // default and may be substituted when it is not installed; set means the user asserted it.
    compiler: new CompilerResolver(config.compiler ?? 'latexmk', config.compilerExplicit ?? false),
    pdfRenderer: new PdfRenderer(),
    viewer,
    synctex,
    comments,
    credentials,
    dblp: new DblpService(),
    doctor: new DoctorService(),
    sessions,
    shadows,
    rewriteModes,
    credentialPortal: new CredentialPortal((host, username, token) =>
      credentials.storeCredential(host, username, token),
    ),
  };
}

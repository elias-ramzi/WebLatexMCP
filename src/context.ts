import { ProjectManager } from './services/projectManager.js';
import type { ProjectRegistryStore } from './services/projectManager.js';
import { GitService } from './services/gitService.js';
import { FileService } from './services/fileService.js';
import { CompilerResolver } from './services/compilerResolver.js';
import { PdfRenderer } from './services/pdfRender.js';
import { ViewerService } from './services/viewer.js';
import { SyncTexService } from './services/synctex.js';
import { CommentStore } from './services/commentStore.js';
import { CredentialResolver } from './services/auth.js';
import { DblpService } from './services/dblp.js';
import { CrossrefService } from './services/crossref.js';
import { OpenAlexService } from './services/openalex.js';
import { ReferenceResolver } from './services/referenceResolver.js';
import { DoctorService } from './services/doctor.js';
import { SessionRegistry } from './services/sessionRegistry.js';
import { ShadowStore } from './services/shadowStore.js';
import { ShelfStore } from './services/shelfStore.js';
import { RewriteModeStore } from './services/rewriteModeStore.js';
import { CredentialPortal } from './services/credentialPortal.js';
import { UpdateService } from './services/updater.js';
import { createSessionRecorder } from './lib/mutationRecorder.js';
import { resolveRootFile } from './lib/rootFile.js';
import { locateViewerPdf } from './lib/pdfLocate.js';
import { quoteId } from './lib/projectId.js';

/**
 * Why a document could not be read, for a message that already names it (quoted): from the
 * errno when there is one, else the sandbox's refusals — FileService raises those without a code.
 */
function documentRefusal(err: unknown): string {
  switch ((err as NodeJS.ErrnoException).code) {
    case 'EACCES':
    case 'EPERM':
      return 'permission denied';
    case 'EISDIR':
      return 'it is a directory';
    case 'ELOOP':
      return 'too many levels of symbolic links';
    case undefined:
      return 'it is outside the project, reached through a symlink out of it, or not a regular file';
    default:
      return `it could not be read (${(err as NodeJS.ErrnoException).code})`;
  }
}
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
  /**
   * Chooses which bibliography backend answers a lookup. Tools go through this, never a
   * concrete backend: which service answers is a resolution decision (config, per-call pin,
   * substitution when one is unreachable) and must have exactly one home.
   */
  references: ReferenceResolver;
  /** Local toolchain diagnostics — see `src/services/doctor.ts`. */
  doctor: DoctorService;
  /** Who else is working on a project right now — see `src/services/sessionRegistry.ts`. */
  sessions: SessionRegistry;
  /** This session's own uncommitted changes — see `src/services/shadowStore.ts`. */
  shadows: ShadowStore;
  /**
   * Work set aside by `shelve`, outside the clone — see `src/services/shelfStore.ts`.
   *
   * Project-scoped, deliberately not session-scoped: any session on the project can list and
   * unshelve one. A shelf only this session could see would reproduce the invisible, unreclaimed
   * `git stash@{0}` that #86 exists to replace.
   */
  shelves: ShelfStore;
  /** Sticky per-project rewrite-preservation mode — see `src/services/rewriteModeStore.ts`. */
  rewriteModes: RewriteModeStore;
  /** Loopback page for entering a git token off the chat — see `src/services/credentialPortal.ts`. */
  credentialPortal: CredentialPortal;
  /** Checks GitHub for a newer release and fetches the Desktop bundle — see `src/services/updater.ts`. */
  updater: UpdateService;
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
  const shelves = new ShelfStore(config.workspaceRoot, config.sessionId);
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

  // The viewer shows a project's PDF and (for comments) resolves a clicked PDF point to source via
  // synctex. Both come from ONE `locateViewerPdf` call, so the page a click lands on and the
  // synctex that maps it are the same root's build: the project root's build-dir PDF, where its
  // `.synctex.gz` lives, or — when that build is gone — the surfaced copy with no synctex mapping,
  // since that copy holds whichever root compiled last. Constructed here but not listening — it
  // binds a port only when the `viewer` tool is first called.
  // The root is the project's registered `rootFile`, else the auto-detected one — the order
  // `compile` and the PDF tools use too (`resolveRootFile`).
  const viewerRoot = async (id: string) => {
    const { dir } = await projectManager.requireProjectDir(id);
    const root = await resolveRootFile(files, dir, projectManager.registeredRootFile(id));
    return { dir, root };
  };
  const viewerPdf = async (id: string) => {
    const { dir, root } = await viewerRoot(id);
    return { dir, located: await locateViewerPdf(config, id, dir, root.rootFile) };
  };
  const viewer = new ViewerService({
    knownIds: () => projectManager.knownIds(),
    resolveRoot: async (id) => {
      try {
        return (await viewerRoot(id)).root;
      } catch {
        return null; // not cloned / no .tex yet — the page says only that nothing is compiled
      }
    },
    // One root resolution per request: the page's `/version` poll needs the PDF and, while there
    // is none, the root it waits for.
    locatePdf: async (id) => {
      let resolved: Awaited<ReturnType<typeof viewerRoot>>;
      try {
        resolved = await viewerRoot(id);
      } catch {
        return { pdf: null, root: null }; // not cloned / no .tex yet — page waits for a compile
      }
      const { dir, root } = resolved;
      try {
        const located = await locateViewerPdf(config, id, dir, root.rootFile);
        return { pdf: located?.pdf ?? null, root };
      } catch {
        return { pdf: null, root }; // no PDF to be had — the page still names the root it awaits
      }
    },
    addComment: async (id, input) => {
      let file: string | undefined;
      let line: number | undefined;
      try {
        const { dir, located } = await viewerPdf(id);
        // No synctex source (the surfaced fallback may be another root's): keep the note
        // unlocated rather than map the click through a different document.
        const synctexPdf = located?.synctexPdf;
        // Only a PDF comment carries the clicked point synctex maps; a document comment never
        // reaches this path (the viewer stores it through `addDocComment`).
        const { page, x, y } = input;
        if (synctexPdf && page !== undefined && x !== undefined && y !== undefined) {
          const loc = await synctex.resolve(synctexPdf, dir, page, x, y);
          if (loc) ({ file, line } = loc);
        }
      } catch {
        // Leave the location unresolved — the note is still kept (Claude can use the quote/page).
      }
      return comments.add(id, { ...input, file, line });
    },
    // The viewer names the surface: `null` from the PDF page (PDF comments only), a document's
    // path from that document's page.
    listComments: (id, document) => comments.list(id, { document }),
    updateComment: (id, commentId, note) => comments.update(id, commentId, { note }),
    deleteComment: (id, commentId) => comments.remove(id, commentId),
    undoDelete: (id, document) => comments.undo(id, document),
    resolveComments: (id, ids, document) => comments.resolve(id, ids, document),
    // A markdown document is read the way `read_file` reads one — inside the project, its links
    // judged by the same policy, a local project as readily as a clone — and records NO baseline:
    // the user's browser asked for it, not the MCP caller, so nothing here vouches for a write.
    readDocument: async (id, relPath) => {
      const { dir } = await projectManager.requireProjectDir(id);
      let read: Awaited<ReturnType<typeof files.read>>;
      try {
        read = await files.read(dir, { path: relPath });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`No such document in project ${quoteId(id)}: ${quoteId(relPath)}.`, {
            cause: err,
          });
        }
        // FileService's own refusals name the path raw; this one reaches a browser page and the
        // tool's result, so it is quoted (escaped) like every caller-supplied string — with a
        // reason taken from the error, never a guess that blames the sandbox for an EACCES.
        throw new Error(`Cannot show document ${quoteId(relPath)}: ${documentRefusal(err)}.`, {
          cause: err,
        });
      }
      if (read.truncated) {
        throw new Error(`Document ${quoteId(relPath)} is too large to show.`);
      }
      return { path: relPath, text: read.content };
    },
    // The viewer resolves the source line itself, from the file it just read; store as given.
    addDocComment: (id, input) => comments.add(id, input),
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
    // A contact email is sent only when the user set WEB_LATEX_MCP_CONTACT_EMAIL. Crossref and
    // OpenAlex offer a faster "polite pool" to identified clients; we never infer an address.
    references: new ReferenceResolver(
      {
        dblp: new DblpService(),
        crossref: new CrossrefService(undefined, { contactEmail: config.contactEmail }),
        openalex: new OpenAlexService(undefined, { contactEmail: config.contactEmail }),
      },
      {
        source: config.referenceSource,
        explicit: config.referenceSourceExplicit,
        // A WEB_LATEX_MCP_REFERENCE_SOURCE value that names no backend: the server starts (the
        // setting governs one tool), and the resolver refuses an unpinned search by name rather
        // than substituting a bibliography the user did not ask for.
        invalidSource: config.referenceSourceInvalid,
      },
    ),
    doctor: new DoctorService(),
    sessions,
    shadows,
    shelves,
    rewriteModes,
    credentialPortal: new CredentialPortal((host, username, token) =>
      credentials.storeCredential(host, username, token),
    ),
    // The install kind is the launcher's assertion (the Desktop extension's manifest sets
    // WEB_LATEX_MCP_INSTALL_KIND); unset, the updater never infers the extension.
    updater: new UpdateService({ installKind: config.installKind }),
  };
}

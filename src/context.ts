import { ProjectManager } from './services/projectManager.js';
import type { ProjectRegistryStore } from './services/projectManager.js';
import { GitService } from './services/gitService.js';
import { FileService } from './services/fileService.js';
import { CompilerResolver } from './services/compilerResolver.js';
import { createCompiler } from './services/compiler.js';
import { gatedCompiler, gatedRenderer } from './services/gatedWork.js';
import { DEFAULT_MAX_PARALLEL_BUILDS, WorkGate } from './lib/workGate.js';
import { PdfRenderer } from './services/pdfRender.js';
import { ViewerService } from './services/viewer.js';
import { SyncTexService } from './services/synctex.js';
import { locateQuoteInProject } from './lib/quoteLocate.js';
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
import { CompileDefaultsStore } from './services/compileDefaultsStore.js';
import { CredentialPortal } from './services/credentialPortal.js';
import { UpdateService } from './services/updater.js';
import { createSessionRecorder } from './lib/mutationRecorder.js';
import { resolveRootFile } from './lib/rootFile.js';
import { locateViewerPdf } from './lib/pdfLocate.js';
import type { PdfRenderService } from './services/pdfRender.js';
import type { CommitIdentity } from './services/auth.js';
import { ProjectLocks } from './lib/projectLocks.js';
import { openScope } from './lib/openScopes.js';
import { parseSessionId } from './config.js';
import { quoteId } from './lib/projectId.js';
import type { ServerConfig } from './types.js';

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
  /** Per-project compile defaults — see `src/services/compileDefaultsStore.ts`. */
  compileDefaults: CompileDefaultsStore;
  /** Loopback page for entering a git token off the chat — see `src/services/credentialPortal.ts`. */
  credentialPortal: CredentialPortal;
  /** Checks GitHub for a newer release and fetches the Desktop bundle — see `src/services/updater.ts`. */
  updater: UpdateService;
}

/**
 * The services every session scope of one process shares (`docs/design/shared-server.md` §5.1):
 * the project lock table, the registry, git, the compiler, the PDF and reference services, the
 * viewer and its comments, the rewrite-mode store, the credential portal and the updater. Each is
 * stateless, a cache, or project- or machine-wide already.
 *
 * What is NOT here is per session, built by `createSessionContext`: the `ProjectManager` (its
 * session-only registrations, pins and in-process default are that session's own — only its
 * mutex table is shared), the `FileService` (a revision baseline means "what this session last
 * saw"; shared, one session's write would move the baseline another relies on and its next write
 * would overwrite that edit instead of throwing `ExternalChangeError`), the session registry,
 * shadow store and shelf store (keyed by session id), and the credential overlay.
 */
export interface SharedServices {
  /** The process-wide configuration; a scope's `config` copies it with its own session fields. */
  config: ServerConfig;
  /** The process's own credentials (its env, `gh`, the keychain); scopes overlay their own. */
  credentials: CredentialResolver;
  registry?: ProjectRegistryStore;
  locks: ProjectLocks;
  git: GitService;
  compiler: CompilerResolver;
  pdfRenderer: PdfRenderService;
  viewer: ViewerService;
  synctex: SyncTexService;
  comments: CommentStore;
  references: ReferenceResolver;
  doctor: DoctorService;
  rewriteModes: RewriteModeStore;
  compileDefaults: CompileDefaultsStore;
  credentialPortal: CredentialPortal;
  updater: UpdateService;
}

/** What one session scope brings of its own; anything left out is the process's. */
export interface SessionOptions {
  sessionId?: string;
  /** With `defaultProjectExplicit`, as `WEB_LATEX_MCP_DEFAULT_PROJECT` would set them. */
  defaultProject?: string;
  defaultProjectExplicit?: boolean;
  /** Credential variables for this scope only, consulted before the process env (§7.2). */
  credentialOverlay?: Readonly<Record<string, string>>;
}

/** One session's `AppContext`, and how to end it. */
export interface SessionScope {
  ctx: AppContext;
  /**
   * End the scope: retract its session record from every project it touched (what a clean
   * process shutdown does) and stop the viewer from consulting its projects. Safe to call again;
   * never throws. From here on peers in this process read the session dead (§5.3,
   * `src/lib/openScopes.ts`). It does not wait for or refuse calls still running in the scope —
   * the daemon's transport does that (milestone 4); a write landing afterwards re-creates the
   * record, which this process reads dead and other processes read by pid.
   */
  close: () => Promise<void>;
}

/** The scopes the shared viewer may consult, newest last (see `createSharedServices`). */
const viewerScopes = new WeakMap<SharedServices, Map<ProjectManager, FileService>>();

export function createSharedServices(
  config: ServerConfig,
  credentials: CredentialResolver,
  identity: CommitIdentity,
  registry?: ProjectRegistryStore,
): SharedServices {
  const locks = new ProjectLocks();
  // One limit on compiles and PDF loads for every session this process serves (`workGate.ts`).
  const gate = new WorkGate(config.maxParallelBuilds ?? DEFAULT_MAX_PARALLEL_BUILDS);
  const synctex = new SyncTexService();
  const comments = new CommentStore();
  const git = new GitService(identity);
  const scopes = new Map<ProjectManager, FileService>();
  // The viewer serves every scope from one port. It resolves a project through a manager of its
  // own (the configuration and the registry) unless a scope that is still open knows the id —
  // a project only that session registered (`project_sync { gitUrl }`) is then found through
  // the session that registered it, as it was when every session had its own viewer.
  // The viewer only reads (root detection, `.tex` lookups) — never a baseline, never a recorded
  // write — so it reads through the FileService of the scope that knows the project, whose link
  // policy is that scope's manager's; with no such scope, through one of its own.
  const viewerManager = new ProjectManager(config, registry, locks);
  const viewerFiles = new FileService();
  viewerFiles.setLinkPolicy((dir) => viewerManager.followsUserLinks(dir));
  const scopeFor = (id: string): { pm: ProjectManager; files: FileService } => {
    for (const [pm, files] of [...scopes].reverse()) {
      if (pm.knownIds().includes(id)) return { pm, files };
    }
    return { pm: viewerManager, files: viewerFiles };
  };

  // The viewer shows a project's PDF and (for comments) resolves a clicked PDF point to source via
  // synctex. Both come from ONE `locateViewerPdf` call, so the page a click lands on and the
  // synctex that maps it are the same root's build: the project root's build-dir PDF, where its
  // `.synctex.gz` lives, or — when that build is gone — the surfaced copy with no synctex mapping,
  // since that copy holds whichever root compiled last. Constructed here but not listening — it
  // binds a port only when the `viewer` tool is first called.
  // The root is the project's registered `rootFile`, else the auto-detected one — the order
  // `compile` and the PDF tools use too (`resolveRootFile`).
  const viewerRoot = async (id: string) => {
    const { pm, files } = scopeFor(id);
    const { dir } = await pm.requireProjectDir(id);
    const root = await resolveRootFile(files, dir, pm.registeredRootFile(id));
    return { dir, root };
  };
  const viewerPdf = async (id: string) => {
    const { dir, root } = await viewerRoot(id);
    return { dir, located: await locateViewerPdf(config, id, dir, root.rootFile) };
  };
  const viewer = new ViewerService({
    knownIds: () => [...new Set([...scopes.keys(), viewerManager].flatMap((pm) => pm.knownIds()))],
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
      let locatedBy: 'synctex' | 'quote' | undefined;
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
          if (loc) {
            ({ file, line } = loc);
            locatedBy = 'synctex';
          }
        }
        // SyncTeX placed nothing: the selected text, if it occurs in exactly one place in the
        // project's .tex files (src/lib/quoteLocate.ts). Text evidence, reported as such.
        if (!file && input.quote) {
          const hit = await locateQuoteInProject(scopeFor(id).files, dir, input.quote);
          if (hit) {
            ({ file, line } = hit);
            locatedBy = 'quote';
          }
        }
      } catch {
        // Leave the location unresolved — the note is still kept (Claude can use the quote/page).
      }
      return comments.add(id, { ...input, file, line, locatedBy });
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
      const { pm, files } = scopeFor(id);
      const { dir } = await pm.requireProjectDir(id);
      let read: Awaited<ReturnType<FileService['read']>>;
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

  const shared: SharedServices = {
    config,
    credentials,
    registry,
    locks,
    git,
    // `compilerExplicit` is the whole licence for a fallback: unset means `compiler` is only a
    // default and may be substituted when it is not installed; set means the user asserted it.
    compiler: new CompilerResolver(
      config.compiler ?? 'latexmk',
      config.compilerExplicit ?? false,
      (kind) => gatedCompiler(createCompiler(kind), gate),
    ),
    pdfRenderer: gatedRenderer(new PdfRenderer(), gate),
    viewer,
    synctex,
    comments,
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
    rewriteModes: new RewriteModeStore(config.workspaceRoot),
    compileDefaults: new CompileDefaultsStore(config.workspaceRoot),
    // The keychain is the machine's, so a token entered on the portal goes through the process's
    // own resolver, whichever session opened the page.
    credentialPortal: new CredentialPortal((host, username, token) =>
      credentials.storeCredential(host, username, token),
    ),
    // The install kind is the launcher's assertion (the Desktop extension's manifest sets
    // WEB_LATEX_MCP_INSTALL_KIND); unset, the updater never infers the extension.
    updater: new UpdateService({ installKind: config.installKind }),
  };
  viewerScopes.set(shared, scopes);
  return shared;
}

/**
 * Build one session's `AppContext` over `shared`. stdio builds exactly one; a daemon builds one
 * per MCP session. The scope's `config` is a copy of the process's with this session's id and
 * default project — read the process's settings from `shared.config` before calling this, since
 * a later write to it does not reach a scope already built.
 */
export function createSessionContext(
  shared: SharedServices,
  opts: SessionOptions = {},
): SessionScope {
  // The id names this session's directories under `.sessions/<project>/`, so it must already be
  // one `parseSessionId` would produce (and not a reserved name, which it refuses). Two open
  // scopes with one id would share a shadow index and see no peer in each other; telling them
  // apart is the daemon's job when it assigns ids (docs/design/shared-server.md §5.2).
  if (
    opts.sessionId !== undefined &&
    (!opts.sessionId.trim() || parseSessionId(opts.sessionId) !== opts.sessionId)
  ) {
    throw new Error(
      `Session id ${quoteId(opts.sessionId)} is not usable; use letters, digits, ".", "_" or "-".`,
    );
  }
  const config: ServerConfig = {
    ...shared.config,
    sessionId: opts.sessionId ?? shared.config.sessionId,
    defaultProject:
      opts.defaultProject !== undefined ? opts.defaultProject : shared.config.defaultProject,
    defaultProjectExplicit:
      opts.defaultProjectExplicit !== undefined
        ? opts.defaultProjectExplicit
        : shared.config.defaultProjectExplicit,
  };
  const projectManager = new ProjectManager(config, shared.registry, shared.locks);
  const files = new FileService();
  const credentials =
    opts.credentialOverlay !== undefined
      ? shared.credentials.withOverlay(opts.credentialOverlay)
      : shared.credentials;
  const { git } = shared;

  const sessions = new SessionRegistry(config.workspaceRoot, config.sessionId, { scoped: true });
  const shelves = new ShelfStore(config.workspaceRoot, config.sessionId);
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
  // Every mutation this session makes is folded into this session's shadow, so `commit` can later
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

  const ctx: AppContext = {
    config,
    projectManager,
    git,
    files,
    compiler: shared.compiler,
    pdfRenderer: shared.pdfRenderer,
    viewer: shared.viewer,
    synctex: shared.synctex,
    comments: shared.comments,
    credentials,
    references: shared.references,
    doctor: shared.doctor,
    sessions,
    shadows,
    shelves,
    rewriteModes: shared.rewriteModes,
    compileDefaults: shared.compileDefaults,
    credentialPortal: shared.credentialPortal,
    updater: shared.updater,
  };

  const scopes = viewerScopes.get(shared);
  scopes?.set(projectManager, files);
  // Open from here until `close`: peers in this process read this session live while it is
  // (`src/lib/openScopes.ts`), however long it stays quiet.
  const markClosed = openScope(config.workspaceRoot, config.sessionId);
  // Not memoised: a write that lands after a close re-creates the record (see `release`), and a
  // second close must retract that one too.
  const close = async (): Promise<void> => {
    scopes?.delete(projectManager);
    markClosed();
    await Promise.all(sessions.trackedProjects().map((id) => sessions.release(id).catch(() => {})));
  };
  return { ctx, close };
}

/**
 * One process, one session: the shared services and a single scope over them. What stdio runs,
 * and what most tests build.
 */
export function createContext(
  config: ServerConfig,
  credentials: CredentialResolver,
  identity: CommitIdentity,
  registry?: ProjectRegistryStore,
): AppContext {
  return createSessionContext(createSharedServices(config, credentials, identity, registry)).ctx;
}

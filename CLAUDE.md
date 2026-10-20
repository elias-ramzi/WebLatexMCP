# CLAUDE.md

Guidance for Claude Code in this repository. Rules here are terse on purpose; the _why_ for each lives
in the JSDoc of the file named, and the tests named pin it. Keep every rule — a rule that reads as
over-cautious is usually the fix for a real bug.

## What this is

An MCP server (stdio) that lets an MCP client read, edit, compile and commit LaTeX in a git-hosted
project (Overleaf, GitHub, any remote) — or compile and edit a plain local directory in place. It keeps
local clones, compiles with `latexmk` (or tectonic), and pushes back to the default branch. User-facing
docs: [README.md](README.md) (landing), [docs/configuration.md](docs/configuration.md) (env vars),
[docs/tools.md](docs/tools.md), [docs/install/](docs/install/README.md),
[docs/CONCURRENCY.md](docs/CONCURRENCY.md).

## Commands

```bash
npm run build        # tsc -p tsconfig.build.json -> dist/ (excludes tests)
npm run dev          # run from source via tsx (src/index.ts)
npm run typecheck    # tsc --noEmit (src AND test)
npm run lint         # eslint
npm run format       # prettier --write   (format:check for CI)
npm test             # vitest: unit + integration (TeX smokes auto-skip)
npm run test:smoke   # test/smoke/** only (real latexmk; needs TeX)

npx vitest run test/unit/logParser.test.ts
npx vitest run -t "refuses to push while a live peer has uncommitted work"
```

Local gate before work is done: `typecheck` + `lint` + `format:check` + `test`.

## Git workflow

- Before committing: `git fetch origin && git rebase origin/dev` (or merge), resolve conflicts, re-run
  the gate. Commit/push only when the user asks.
- `dev` is the integration branch (work branches off it, PRs target it). `main` is release; a guard
  workflow rejects PRs into `main` from anything but `dev` (`.github/workflows/only-dev-into-main.yml`).
- A PR into `dev` must change `CHANGELOG.md`'s `[Unreleased]` section (`.github/workflows/changelog.yml`).

## Architecture

**Thin tool layer over a testable service core.** Tools do schema validation + response formatting;
logic lives in services, unit-testable without an MCP client.

- `src/index.ts` — bootstrap: resolves auth (may hit the Keychain), builds the context, git-excludes a
  workspace-local clone dir from the host repo; sets `GIT_TERMINAL_PROMPT=0` when unset.
- `src/server.ts` — `createServer(ctx)` registers every tool. **Add a new tool here.**
- `src/context.ts` — `AppContext` dependency bag (`projectManager`, `git`, `files`, `compiler`,
  `references`, `shadows`, `sessions`, `shelves`, `credentials`, `pdfRenderer`, `viewer`, …).
- `src/tools/*` — one file per tool: zod `inputSchema`/`outputSchema` + a handler calling services.
- `src/prompts/skills.ts` — exposes each `.claude/skills/*/SKILL.md` (loaded by `src/lib/skills.ts`) as
  an MCP prompt. Adding a skill directory needs no code.
- `.claude-plugin/plugin.json` — points at `.claude/skills` whole but lists shipped **commands and
  agents file by file**, since those dirs also hold dev tooling (`/implement`, `/implement-issue`,
  `/review`, `implementer`, `plan-verifier`). `test/unit/pluginManifest.test.ts` holds each file to
  exactly one of the manifest or its `DEV` list. **Every shipped agent has a `tools:` line** (without
  one it inherits every session tool) and names every server tool in **both** forms,
  `mcp__web-latex-mcp__<tool>` and `mcp__plugin_web-latex-mcp_web-latex-mcp__<tool>` (Claude Code drops
  unresolved entries silently). `reviewAgents.test.ts` checks the read-only allowlists under both
  prefixes and pins `formatter`'s list (read-only tools + `write_file`, `edit_file`).
- `src/services/*` — `ProjectManager` (id→dir, per-project mutex + cross-process lock, runtime
  registration), `GitService` (simple-git wrapper), `FileService` (sandboxed fs), `LatexmkCompiler`
  (implements `LatexCompiler`), `ReferenceResolver` over `DblpService`/`CrossrefService`/
  `OpenAlexService` (injectable `fetch`), `SessionRegistry` + `ShadowStore` (parallel sessions),
  `ShelfStore`, `ProjectRegistry` (`<workspace>/registry.json`), `logParser`, `auth`.

**Two kinds of project** (`ProjectConfig` union, `src/types.ts`): **git** (`gitUrl`, cloned under the
workspace; `mode` optional so old entries parse) or **local** (`mode: 'local'`, `path`, used in place).
`projectPath` returns either dir; `requireProjectDir` requires `.git` for git projects, existence for
local. Git-backed tools call `ctx.projectManager.requireGitProject(id, action)` **first**, refusing a
local project. Helpers: `src/lib/projectMode.ts`.

**Workspace** (`WEB_LATEX_MCP_WORKSPACE`): one dir per git project id, plus `registry.json` and
`.sessions/`. Unset → `<launch-dir>/.web_latex_mcp` when the launch dir is a git repo and not `$HOME`
(git-excluded via `.git/info/exclude`, `src/lib/workspaceExclude.ts`), else `~/.web-latex-mcp/projects`.
`=cwd` forces workspace-local; other values are paths. Detection (`resolveWorkspace`, `src/config.ts`)
is injectable.

**PDF location.** Builds live under a per-user temp build root. In workspace-local mode `compile` also
copies the PDF to `<workspace>/<id>.pdf` (`src/lib/pdfSurface.ts`) — a user convenience, **never a tool
source**: it holds whichever root compiled last. `render_pages`/`extract_text`/`pdf_geometry` read
`rootFile`'s own build PDF (`locateRootPdf`, `src/lib/pdfLocate.ts`), falling back to the surfaced copy
only when no root was named (call or registration) and no `.aux` is read. Root resolution is one
function, `resolveRootFile` (`src/lib/rootFile.ts`: call → registered → detected) for compile, PDF tools
and viewer. The viewer (`locateViewerPdf`) never treats its root as named, so it falls back to the
surfaced copy even for a registered root with no build (`compile`'s hint says `surfaced-copy`); there
`synctexPdf` is `null` and comments keep no source location.

**Registration freshness.**

- Read the registered root via `ProjectManager.registeredRootFile`, never `getProjectConfig(id).rootFile`:
  for a non-env project (`ServerConfig.envProjectIds`) it reads the registry's current entry when it
  names the same location, so a peer's re-registration applies without restart. One sync
  `registry.json` read per call (incl. viewer `/version` polls) is accepted; `upsert` writes
  temp-file+rename, so reads need no lock; a failed read falls back to in-process.
- Other fields keep the in-process snapshot **except at remote operations**: `project_sync` (no
  `gitUrl`), `push`, `reset_to_remote` first call `ProjectManager.refreshedGitConfig`, adopting the
  registry's git entry wholesale — never for an env id, a session-pinned id, an id held locally as a
  local project; fall back to the snapshot on no/local entry, unusable id or a throwing read.
- **A registration pins only when it differs from the registry entry** (`registryHolds`/
  `sameRegistration`, `src/lib/registrationChange.ts`: stripped `gitUrl`, `branch`, `tokenEnv`,
  `username`). A restatement pins nothing and clears an earlier pin; a throwing registry read pins.
  `registerAndPersist` un-pins after upsert. `project_sync { gitUrl }` naming the registry's URL is
  planned from the registry entry (`syncRegistrationBase`, `src/lib/syncRegistration.ts`; env ids
  excepted); its dropped-fields note is still judged against the local `held`.
- **Refresh runs twice**: before the lock, and inside `runExclusive` before `reconcileOrigin` as
  `assertRegistrationUnchanged(cfg)` — a `gitUrl`/`tokenEnv`/`username` change while waiting is refused
  (`registrationChangeMessage`, redacted, quoted; nothing fetched/pushed), never reconciled back.

## Conventions that aren't obvious

### Protocol and output

- **stdout is JSON-RPC.** Never `console.log`; log to stderr. Worker threads too: `search_files`' worker
  is created with `stdout: true, stderr: true` and forwards both to stderr (`src/lib/searchWorker.ts`).
- **Quote and escape every user/document-supplied value in a message.** Ids via `quoteId`/`listIds`
  (`src/lib/projectId.ts`, `escapeInvisibleChars` → `\u{…}`); rejected env values via `quoteEnvValue`
  (`src/config.ts`, cut at 120 chars with true length) for `WEB_LATEX_MCP_COMPILER`, `_VIEWER_TARGET`,
  `_VIEWER_PORT`, `_WRITING_GUIDE_EXTRA`, `_REFERENCE_SOURCE`, `_REWRITE_MODE`, `_CONTACT_EMAIL`,
  `_INSTALL_KIND`; the session recorder's stderr paths likewise. Never a bare template literal.
- **Tool return shape.** `structuredContent` must be a fresh object literal (`{ ...result }`). Every
  catch uses `errorResult(err, ctx.credentials.allSecrets())` (`src/lib/errors.ts`).
- **Every key in `structuredContent` must be declared in `outputSchema`.** The server strips/ignores
  undeclared keys, but the SDK client validates with `additionalProperties: false` and returns
  `-32602` with **no result** (this broke `list_references` and `shelve`). Tests must assert off a
  `listTools()` round trip (a client that never lists caches no validator) and audit the whole payload
  with `expectNoUndeclaredKeys` (`test/helpers/outputSchema.ts`, judged on wire form). Adding a budget
  counter is the change most likely to break a tool.
- **Nothing keyed by a document/user-supplied name is a plain object** (paths, BibTeX types, hosts,
  ids hit `constructor`/`__proto__`). Use `Object.create(null)` (`entryMap`, `parseFields`/
  `emptyFieldMap`, `nullProtoRecord`, `kept` in `referenceFieldsBudget.ts`) or `Map`, and `Object.hasOwn`
  (`hostDefaults`, `src/services/auth.ts`). On-disk JSON stays plain. Pinned by
  `protoKeyedMaps.test.ts`, `shadowStoreProtoKeys.test.ts`, `protoNamedFiles.test.ts`.

### Project ids

- **An id is a directory name and validated as one** (`projectIdProblem`, `src/lib/projectId.ts`; applied
  by `registerProject`, `readProjectRegistry`, `loadConfig`). Refuse only what is unsafe as one dir
  entry — Unicode, spaces, punctuation are fine (`thèse`, `My Thesis`, `論文`). Refused: separators,
  `: < > " | ? *`, backtick, control/bidi/unpaired-surrogate, invisible (`\p{Cf}`/default-ignorable,
  except in-word ZWNJ/ZWJ — `isJoinerInWord`), line/paragraph separators, non-U+0020 spaces, leading
  combining mark, non-NFC (named, **never normalised**), leading `.`/`-`, leading/trailing whitespace,
  trailing `.`, `~`+digit (8.3 names), `__proto__`/`constructor`/`prototype`, >64 chars or >246 UTF-8
  bytes; and under the generous fold `projectIdFold`: Windows device names, `registry.json`,
  `registry.json.*`, `*.pdf`. A **new** id folding onto a known one is refused (`assertIdUnaliased`), as
  is a second id for a claimed directory (`assertDirUnclaimed`); updates never are.
- **An existing invalid id is skipped, never fatal** (`ServerConfig.skippedProjects`,
  `ProjectRegistryStore.skipped`); a call naming it (incl. via `WEB_LATEX_MCP_DEFAULT_PROJECT`) gets
  `describeSkippedProject` (key, `<workspace>/<old id>`, `.sessions/<old id>/`). `childPathInside`
  refuses non-single-segment names at every join (`projectPath`, `sessionStateDir`, `sessionDir`).
- **The registry is judged per entry** (`src/services/projectRegistry.ts`): unusable entries are written
  back verbatim; an empty file is an empty registry; an unparseable/unreadable one is **refused** by
  `upsert`, never overwritten.

### Locking

- **Mutating tools run inside `ctx.projectManager.runExclusive(id, …)`**: write/edit/delete/add_asset/
  commit/push/discard/revert/reset_to_remote/project_sync/add_citation/shelve/unshelve/
  set_rewrite_mode, `register_project`'s clone branch, and `compile` (rewrites the build dir). Read-only
  tools don't — except `render_pages`, `pdf_geometry`, `extract_text`, which read a build dir a peer's
  `compile` rewrites. That is the only reason a reader locks; such a tool's description must say it can
  wait/time out on a peer and creates `<workspace>/.sessions/<id>/`.
- `runExclusive` = in-process mutex + lock file (`src/lib/fileLock.ts`,
  `<workspace>/.sessions/<id>/project.lock`, outside the clone so `project_sync` locks before a first
  clone). It calls `assertValidProjectId` first. Peer-refusal logic for `push`/`project_sync`
  (`guardPeerWork`, `enrichPullRefusal`) lives in `src/lib/peerRefusal.ts`.
- **Lock-file removal is ownership-checked.** Each record has a random `token` (legacy: hash of bytes).
  Every release/reclaim first takes an exclusive removal marker `<lock>.rm-<identity>.<gen>` (only its
  creator removes it; a dead one is stepped past to `gen+1`), re-reads, and removes by
  **rename-then-verify** (`removeRecord`: rename to `<lock>.gone-<pid>-<token>`, re-read, on mismatch
  put back with `link`, never rename). Release removes only its own record (`stillOurs`). `.rm-*`/
  `.gone-*` litter is harmless and left.
- **Abandonment (`isAbandoned`), in order:** same `processNonce`+pid+`threadId` → live iff `heldTokens`
  has the token (added before file creation); same pid, other nonce → heartbeat vs `OWN_PID_STALE_MS`
  (15 s); dead pid → abandoned; live pid → abandoned only when the **same unchanged record is seen stale
  twice ≥ `STALE_CONFIRM_MS` (10 s) apart** on a monotonic clock (`staleAcrossSightings`; laptop sleep).
  `HEARTBEAT_MS` 5 s. **Limit: one host, one pid namespace**; all servers on a workspace must run this
  version. `LockTimeoutError` (30 s) names the holder and the remedy (delete the file if no server runs).
- Windows: contended renames retried (`renameWithRetry`); `writeAtomic` (`sessionRegistry.ts`) uses a
  per-process counter in temp names.

### Parallel sessions, shadows and commit

- **Sessions share a clone; commits don't.** `WEB_LATEX_MCP_SESSION` names the process (`parseSessionId`;
  `RESERVED_SESSION_IDS` refuses `shelves`, `project.lock`, `rewrite-mode.json` — add any new
  project-level entry under `.sessions/<id>/` there by hand). State lives in
  `<workspace>/.sessions/<projectId>/` (`src/lib/sessionPaths.ts`). **Guarantee: a commit contains one
  session's lines and nobody else's.**
- `ShadowStore` keeps per touched file `HEAD + this session's edits`, fed by
  `FileService.setMutationRecorder` (`context.ts`) with the working tree **either side** of each write,
  three-way merged — never the file the model read. `commit` stages shadows via
  `GitService.commitContents` (`read-tree --reset HEAD` + `hash-object` + `update-index`, never
  `git add`). Local projects are skipped.
- After HEAD moves: `refresh(id, dir)` carries shadows forward. Whole-tree rewrites (`discard`,
  `reset_to_remote`) → `clearAll`; path-limited (`discard` with paths, `revert`, `shelve`, `unshelve`) →
  `settleAll`.
- **`refresh` persists and runs only under `runExclusive`.** `status` (lock-free) uses
  `refreshedChanges`, which shares `judge()`/`judgeEntry()` and persists nothing (only its heartbeat).
  In-process, every index RMW (`record`, `markUnrecorded`, `refresh`, `refreshedChanges`, `settle`,
  `settleAll`, `clear`, `clearAll`) is chained through module-level `withIndexLock` keyed by session dir.
  `refresh` settles an entry whose shadow equals an unmoved HEAD (raw bytes; deleted ⇔ absent).
  Entry maps are null-prototype (`entryMap()`; `readIndexAt` copies key by key).
- **Flags.** A same-line collision sets `conflicted`, and it **stays** (base is stale). `incomplete`
  (always with `conflicted`) marks a shadow missing a write: record-time collision (`merge3` conflict or
  binary `before` ≠ shadow) or any byte-changing write to a conflicted entry. `judgeEntry` skips
  `unrecorded`/`incomplete` first — refresh never advances, settles or re-judges them; only
  `settle`/`clear`/`settleAll`/`clearAll` end them. `isFlagged` =
  `conflicted || unrecorded || incomplete` (what `changes()`/`peerEntries()` report). A refresh-found conflict may clear on a HEAD
  move. **Memo:** `refresh` resolves HEAD once (`GitService.headSha`) and skips a conflicted entry whose
  `conflictHead` equals it; only locked `refresh` writes the memo (side deleted, binary, `merge3`
  conflict), `record` only deletes it; a memo never clears a flag (a stale one after an un-committed
  `.gitattributes` edit is accepted).
- Shadows are **bytes**; anything ever non-text (`add_asset`, `writeBytes`) is stickily `binary` and
  **never merged**.
- **Equality of HEAD/shadow/tree goes through the clean filter** (`GitService.cleanBlobId` as the store's
  `cleanHash`), since `commitContents` writes filtered blobs.
- **A recorder failure marks the path** (`markUnrecorded`, `src/lib/mutationRecorder.ts`): the write
  succeeds, the entry becomes `conflicted`+`unrecorded`; peers' `scope: "paths"` refuses it, our own
  commit excludes it.
- **`scope: "paths"`** is the one widening: `git add` of named paths (index reset to HEAD first). It
  refuses any path a **live** peer's shadow lists, and refuses outright when a live peer's index is
  unreadable (`peerEntries` → `null` means unreadable, never "owns nothing").
- **Taking the tree settles what it took**: after `"all"`/`"paths"`, entries under the given paths are
  settled (`settle`/`clear` by `coversPath`) whether or not git staged them. If git has nothing to stage
  for a request covering tracked entries, `commit` settles them and returns `committed: false` with
  `settled` (`settleNothingToCommit`); a request covering nothing tracked still refuses. Naming an
  already-settled path under `"paths"` → `Nothing to commit at: …`.
- **Session commits skip git-ignored paths** (`GitService.ignoredPaths`, once per commit; reported as
  `ignored`, settled). A failing `check-ignore` throws — never read as "nothing ignored". A pathspec
  beyond a symlink → `PathBeyondSymlinkError` (path rebuilt per requested path from git's quoted form;
  points at `discard`). "Tracked" is judged where staging will look: against HEAD (`--no-index` minus
  `ls-tree HEAD`) for `commitContents` and `"paths"`; against the live index for `"all"` with `paths`.
- **`"all"` + `paths` commits only what its paths cover**: list staged names
  (`diff --cached --no-renames --name-only -z`), keep `coversPath` hits, then
  `git commit --only --pathspec-from-file=- --pathspec-file-nul`. Hence **git ≥ 2.25**
  (`MIN_GIT_VERSION`, `src/services/doctor.ts`: older `fail`, unreadable `warn`).
- **`core.ignorecase` folding.** When set (`GitService.isCaseInsensitive`, the clone's config — never the
  filesystem), every by-name lookup folds ASCII case exact-first, like `git add`: ignore filter (both
  bases), `readAtRef`/`readAtRefBytes`, `showAtRef`, `commitContents` (stages under HEAD's spelling),
  `GitService.commit` with paths. `src/lib/caseFold.ts` holds `foldCase` and `canonicalNames`
  (`resolve` also folds the longest tracked dir prefix). Lib functions stay pure — `coversPath`/
  `peerOwnership`/`attributePeers`/`ShadowStore.settle` take an optional `fold`; `commit`, `push`,
  `status` pass it. `ShadowStore.record` folds a new key onto an existing case-variant entry.
  `commitContents` refuses an index spelling one file two ways (remedy: `scope: "paths"`, never
  discard).
- **`commitContents` refuses before any index write**: builds `plan[]` (mode, still-a-link `lstat`,
  `100644` typechange) for every file, then applies. Mode 120000 content is refused unless `lstat` is a
  regular file or ENOENT (fail closed); a link replaced by a file stages as `100644`.
- **Default scope never widens past a live peer** (`resolveCommitScope`, `src/lib/commitScope.ts`):
  tracks a change → `"session"`; none, no live peer → `"all"`; none, **any** live peer → refuse, naming
  peers and both explicit routes. Decided from `trackedAtStart` (`hasChanges` before the opening
  refresh); tracked-then-nothing-left → `Nothing to commit: this session's changes are already at HEAD`
  (no `"all"` suggestion).
- `commit`'s `files`/`leftUncommitted` are budgeted (`src/lib/commitBudget.ts`, `filesOmitted`/
  `leftUncommittedOmitted`); `filesChanged` and `+added -removed` total everything. A `./` prefix names
  the same entry under every scope.
- **A file both this session and a live peer edited is the peer's too** (`disputedPaths`,
  `peerRefusal.ts`): disputed when not ours, or ours and a live peer lists it, or ours and any live
  peer's index is unreadable (`sharedUnconfirmed`). Untracked files count. Advice (`sharedAdvice`):
  session-scoped `commit`, then `push` without `message`.

### revert, shelve, status

- **`revert` settles touched paths in every session (`settleAll`, folded), then `record`s them into
  this session** — not `clearAll` (dropping unrelated peer records lets `"paths"` take their lines), and
  settling across all sessions is what stops a peer's stale shadow re-installing reverted lines.
  `before` is HEAD's bytes, exact because the preflight refuses unless every touched path equals HEAD —
  **absent included**: `dirtyAmong` (`GitService`) `lstat`s every touched path HEAD doesn't track
  (ancestors too; any other error = dirty) and reports extras as `inTheWay` (move by hand; `discard`
  never removes ignored files). Refusal lists cap at 20. Content goes through `asShadowContent`
  (`src/lib/shadowContent.ts`: text only if NUL-free **and** UTF-8 round-trips, else Buffer/binary).
  Then `ctx.files.resetBaselines(dir)` (dir-wide over-reset accepted).
- **`shelve`/`unshelve` never lose work to an unseen error.** A shelf
  (`.sessions/<id>/shelves/<shelfId>/`, `ShelfStore`) is written fully, manifest last, **before** the tree
  is touched. `ShelfEntry.sides()` reads both sides once and refuses a self-contradicting shelf
  (`ShelfCorruptError`, nothing written). **Only ENOENT means absent.** All reads and merges happen
  before the first write; writes go through `writeWithRollback` (`src/lib/shelfRestore.ts`). If HEAD
  moved under a shelved text file and the tree is clean there, `planUnshelveFile` merges with `merge3`
  (`merged`); same-line, non-text, or add/delete → refuse, shelf intact. Refusal payload budgeted by
  `capUnshelveConflict` (`src/lib/shelf.ts`) with `theirs` charged first, cut last, exempt from the
  per-side cap. Ownership as for `revert` (`before` = shelf base on restore, HEAD on merge;
  `resolveUnshelveFile`). A failed `record` is only logged — a known gap, not a pattern.
- **`status` collapses a dead, change-free peer into `staleSessions: N`** — reporting only, never
  deletion (`isStalePeer`/`splitStalePeers`, `src/lib/peerSummary.ts`). One conjunction: `!live`, index
  read as a readable **empty** array (`null` = unreadable → stays listed with `changes: null`), heartbeat
  ≥ `RECENT_HEARTBEAT_GRACE_MS` (2 h — a usefulness window, must exceed `STALE_MS` 30 min), and a finite
  age. **Never call `SessionRegistry.collectGarbage()` from `status`**: `live` is derived (pid namespaces,
  `STALE_MS`; `HEARTBEAT_THROTTLE_MS` 30 s only paces writes), and deleting a racing peer's record
  destroys ownership proof. A test asserts each `session.json` and `shadow.json` **file** survives
  `status` and a corrupt index stays corrupt.
- **A malformed peer record is repaired on read, never dropped** (`SessionRegistry.readRecord`): the
  directory is the authority for the name, missing `startedAt` falls back to the heartbeat; only no
  usable `pid`/`heartbeatAt` is unreadable.

### Remote git: auth, origin, sync, conflicts

- **Auth is per-host and never persisted.** `CredentialResolver` (`src/services/auth.ts`; injectable
  runner): per-project `tokenEnv`/`username` → host-default env → generic → `gh auth token` →
  `git credential fill`. Tools pass the `AuthConfig` per call (`clone`, `syncPull`, `safePush`/
  `resolvePush`/`landBranch`, `resetToRemote`); `GitService` holds none. **A token never touches
  `.git/config` or a command line**: remote ops go through `runRemoteGit` → `execCapture` with the token
  only in the child env (`WEB_LATEX_MCP_GIT_TOKEN`/`_USERNAME`), read by an inline sh-form `!` helper.
  `gitCredentialConfig` sets `credential.<scheme>://<host>.helper` to empty then the inline helper, so
  the user's helpers are bypassed for that host only. `clone` clones from the tokenless URL. Hosts
  outside `CREDENTIAL_HOST_RE` and usernames/tokens with CR/LF/NUL are refused.
- **URL secrets are stripped before persist/echo/clone** (`stripGitUrlCredentials`,
  `src/lib/gitUrlCredentials.ts`, in `ProjectManager.registerProject`). Trim first; any run of `/`/`\` (or
  none) after the scheme; userinfo runs to the **last** `@`. `user:token@` keeps `user@` unless
  `looksLikeToken`: known prefix (`ghp_`, `glpat-`, `ATBB`, `hf_`, …) → token; contains `@` → login;
  `+ = /` → token; a name the URL carries (`publishesName`) → login; CodeCommit `<u>-at-<12 digits>` →
  login; ≥20 chars with digit or mixed case → token. Token-as-username is http(s)-only; a **password** is
  removed from any `<scheme>://` userinfo except `file:` (never judged). On every `<scheme>://` URL
  incl. `file:`: query params in `CREDENTIAL_PARAMS` or with `TOKEN_PREFIX` values are removed cleanly;
  a token-like **path** segment (prefix, ≥`OPAQUE_MIN_LENGTH`, `opaqueTokenMix`) is never stripped but
  flags `pathToken` and **the registration is refused** (`pathTokenRefusal`, before the lock in
  `register_project` and again in `registerProject`). Every "carries a credential" decision uses
  `carriesCredential`.
- Env/legacy URLs are not stripped; they show as `***` via `redactGitUrlCredentials`. `redact` scrubs an
  http(s) userinfo whole to the last `@` behind any separator (`LENIENT_HTTP_USERINFO`), masks only the
  password on other schemes, and masks credential query values / path tokens in free text via
  `maskUrlPathAndQuery` (reusing `urlParts`, `maskCredentialParam`, `isPathToken`). Glued URLs are masked
  right-to-left by `maskUrlRun` (each to the run's end; past `MAX_SUFFIX_MASKED_URLS` (4) only to the next
  scheme). Any-scheme matches start only at a run start (`SCHEME_START`) to stay linear.
- **`origin` is rewritten only while the server owns it** (`GitService.reconcileOrigin`, run from
  `withAuth` and first in `project_sync`/`push`/`reset_to_remote`, under the lock). Ownership record:
  `webLatexMcp.heldUrl`/`webLatexMcp.originUrl` in the clone's local config. A hand-set `origin` is never
  rewritten (named with a `git remote set-url` remedy; the op refuses if the registration also
  changed). An origin carrying a credential is never the server's and is reported, never removed (raw
  origin vs tokenless record). Remedies use the tokenless held URL as written; a relative held path is
  resolved against the server cwd. **Notes are built per channel**: `originNote(…, { forError: true })`
  for errors (since `errorResult` scrubs logins) and plain `originNote` for success — keep both pairs in
  each tool. Decision is pure: `decideOrigin` (`src/lib/originRepoint.ts`). **No URL-similarity
  heuristics.** A url-less `origin` with other `remote.origin.*` keys (`repoConfigRegexp`) is written with
  `set-url` plus the default refspec if none; write failures quote git's scrubbed first stderr line
  (`originWriteFailure`).
- **Sync is ff-only; `push` never force-pushes.** `syncPull` = `fetch --prune` + `merge --ff-only`;
  divergence → `action: 'diverged'`. Direct `push` pull-rebases and pushes, retrying non-ff up to
  `PUSH_RETRY_ROUNDS` (3) then `remote-moved`; branch mode rebases and lands ff-only, once. **Every
  explicit fetch prunes** (`fetchOrigin`). A missing upstream is decided first (`remoteBranchAbsence`;
  only a branch with `branch.<b>.merge` can be missing — an unpushed review branch is `ahead`):
  `project_sync` → `remote-branch-missing` + `note`, `status` → `remoteBranchMissing`/`remoteBranchNote`,
  local commits count as unpushed. `status` lists commits only with `withCommits: true`; without
  `origin/<branch>` `aheadCommits` caps at 20 (`aheadCommitsOmitted`).
- **Conflicts fail safe; resolve through the tool, never auto-merge.** On a rebase conflict `push`
  aborts and returns `status: 'conflict'` with per-file `base`/`ours`/`theirs` + `hunks`,
  `conflictPaths`, `remoteHead`, `remoteCommits`, rendered into the **text** too
  (`src/lib/conflictText.ts`). Retry with `resolutions` (full content, verbatim, applied inside the
  rebase; set validated; `.bib` needs `confirmBibEdit`). `expectedRemoteHead` is a **SHA only** (4–40
  hex, checked first); `resolvePush` fetches once, prefix-matches, and rebases onto **that SHA**
  (`rebase --fork-point --onto <sha> origin/<branch>`), one round; a vanished `origin/<branch>` is
  refused. `read_file` with `ref` reads `theirs`.
- **A resolution path that is a symlink on either side is refused** (rebase aborted):
  `hasLinkOnConflictSide` checks `lstat` and index stages 2/3 for 120000 (base-only links are ordinary);
  paths under a working-tree link (`linkedAncestor`) too. **Every exception in a paused rebase aborts it
  first** (`runRebaseStep`, `tryRebase`). `unmergedPaths` uses `-c core.quotePath=false`.
- **Conflict payload is budgeted by default** (`conflictDetail: 'auto'`, `src/lib/conflictBudget.ts`),
  charged on rendered size of **both** channels summed (`HUNK_MARKER_OVERHEAD`, `HUNK_JSON_OVERHEAD`,
  `HUNK_LINE_ELEMENT_OVERHEAD`, `FILE_HEADER_OVERHEAD`, `SIDE_LABEL_OVERHEAD`, `SIDE_ELISION_OVERHEAD`,
  `HUNK_ELISION_TEXT_OVERHEAD`, `FILE_JSON_OVERHEAD`, `FILE_TEXT_LINE_BREAKS`,
  `HUNKS_BLOCK_TEXT_OVERHEAD`, all test-pinned), pointers reserved before content. `hunks` first, sides
  next (`CONFLICT_SIDE_CAP`, cut first); `CONFLICT_MAX_FILES` (20) detailed files; `conflictPaths` never
  capped. Cut part → `null` **with** an `elided` entry; `null` without one still means absent. `note`
  names only the cap that fired. `'full'` = uncapped. `push.ts` plans once and feeds the same plan to
  `renderConflictText` and `buildConflictFilePayload`. `remoteCommits` capped at `CONFLICT_MAX_COMMITS`
  (20) × `CONFLICT_MAX_COMMIT_FILES` (5) (`remoteCommitsOmitted`, `filesOmitted`).
- **Pathspecs are literal.** Every git call taking a caller/shadow path uses global `--literal-pathspecs`
  (`check-ignore --stdin` excepted); new call sites must too. `discard` restores HEAD+index+tree in one
  write (`checkout --no-overlay HEAD -- <paths>`, git ≥ 2.22; `reset -q --` on unborn HEAD) over paths
  covering a HEAD/index entry (case-resolved on ignorecase), and `clean -f` over every requested path
  (untracked half resolved via `ls-files --others --exclude-standard` on ignorecase; never
  `--icase-pathspecs`). Whole-tree: `checkout --no-overlay HEAD -- .` + `clean -fd`. Unmatched paths →
  `missed`; nothing reached → `discarded: false`. **`missed` paths are still settled in every session**
  (the escape hatch for wedged entries). Path-limited discard uses `settleAll`; only whole-tree uses
  `clearAll`.
- **`diff` with `ref`** takes a commit-ish or one two-dot range (`GitService.resolveDiffRef` validates
  endpoints; leading `-`, three-dot, extra `..`, empty end refused; `ref`+`staged` rejected). Patch forced
  plain (`PLAIN_PATCH_FLAGS`). A ref diff spans peers' commits — document it as "what changed", not
  "what I changed".

### Local projects

- **Local projects never see git.** `status`/`diff`/`commit`/`push`/`discard`/`revert`/`project_sync`/
  `reset_to_remote`/`shelve`/`unshelve`/`list_shelves` and `read_file` with `ref` use
  `requireGitProject`. `changeDiff` (`src/lib/changeDiff.ts`) returns `''` for local projects; the shadow
  recorder skips them. Compiled PDFs go to the workspace, never beside the user's source.

### File writes and guards

- **`.bib` is guarded.** `write_file`/`edit_file`/`delete_file` refuse a `.bib` unless
  `confirmBibEdit: true`. `isBibFile` (`src/lib/bib.ts`) also judges the Windows-opened name (cut at
  first `:`, trailing `.`/spaces stripped) on every platform. The sanctioned path is `add_citation`,
  which fetches BibTeX server-side so entry text never comes from the model (it writes via `FileService`,
  unguarded by design, but refuses a `.bib`-named link to a non-`.bib`). Guards also judge the
  **link-resolved** name (`FileService.linkTarget`, symlinks only, inside `runExclusive`); `linkTarget`
  decides nothing about access (that's `assertNoSymlinkEscape`). `delete_file` judges only the literal
  name.
- **`add_writing_convention` is guarded** — when no guide is configured
  (`ctx.config.extraWritingGuidePath`), the "set `WEB_LATEX_MCP_WRITING_GUIDE_EXTRA`" error wins outright;
  otherwise it refuses (`guideEditBlockedMessage`, `src/lib/writingConventions.ts`) unless
  `confirmGuideEdit: true` (`!== true` check in the tool, like `confirmBibEdit`). The file feeds the MCP
  `instructions` and `guide://latex/writing-guide` at every startup. Writes only to the configured path.
  The rule cannot forge Markdown: split on every CommonMark line ending (`COMMONMARK_LINE_ENDING`, lone
  CR too), leading `#`, `>`, fences, setext underlines escaped (`escapeLeadingBlockMarker`);
  `countWritingConventions` splits the same way.
- **`add_asset` reads outside every sandbox, gated on both ends** (`src/lib/assets.ts` allowlist):
  destination first, source's own name before any syscall, source's realpath target. Returns **no
  diff**; source errors collapse to found/not-found/not-regular/unresolvable (`sourceSyscallError`).
  The realpath'd file is opened once (`O_NOFOLLOW`, `O_NONBLOCK`), `fstat`ed and read through that handle
  up to `MAX_ASSET_BYTES`. UNC/device paths refused before any syscall (`isUncOrDevicePath`). Widen
  `ASSET_EXT` only for genuine figure formats. Destination judged on its link-resolved name too.
- **Rewrite preservation** (`edit_file` only, never `write_file`): old text kept as `% ` lines above the
  replacement, transformed server-side so the block is provably the original bytes, no sentinel
  marker. Modes `off`/`prose`/`always`, default `off`; resolved in one function: per-call
  `preserveOriginal` > project mode (`set_rewrite_mode`, under `.sessions/<id>/`) >
  `WEB_LATEX_MCP_REWRITE_MODE` > `'off'`. `prose` is the one sanctioned inference, allowed only after the
  user opted in. `.bib` targets exempt; `.bib` and comment-syntax checks judge the link-resolved name.
  The hook (`createPreserveTransform`, `src/lib/rewriteMode.ts`) runs **inside**
  `FileService.applyEdits` after its identical/not-found/non-unique guards. Only **line-aligned** string
  matches are preserved (terminators `\n`, `\r\n`, bare `\r`; a `\r` before `\n` is half a CRLF),
  judged in the original file (`judgedAt` over `MatchOrigin`) and also in current content. Range edits
  are whole-line by construction (`commentOut(…, { wholeLines: true })`); a blank-line range deletion
  skips the hook. `commentOut` keeps each line's terminator; `resolveSeparatorLineEnding` prefers the
  byte at the block's end. **`replaceAll` is never preserved** (checked in both `applyEdits` and the
  hook).
- **`applyEdits` tracks preserved blocks** (`PreservedBlock` ledger) and refuses a non-`replaceAll` edit
  matching inside/across one. **Ranges shift on every splice, `replaceAll` included**; `splice` is the
  one place content changes. The hook and its ranges are one option (the type forbids one without the
  other). `assertBlocksStillComments` refuses the whole call if live text was pulled onto a `%` line or a
  block's bare `\r` now meets a `\n`. `unfuse` turns a bare `\r` before a blank LF line into `\n` (only
  pre-existing bytes or terminators reported via the optional `lastRestoredTerminator`).
- **`edit_file` is order-independent** within a call: ranges resolved up front (`pendingRanges`), no-op
  judged there. Empty `newString` on a range deletes the lines **with** their terminator (last
  unterminated line: the preceding one, unless inside a preserved block). A range owns the terminator
  after `endLine`; a string edit touching it is an overlap. **`applyEdits` and `add_citation` refuse
  non-UTF-8 files** (`decodeUtf8Exact`, `src/lib/utf8.ts`; `FileService.readTextExact`); `write_file` is
  the way to replace one.
- **`applyEdits` splices by index — never `String.prototype.replace`** (`$` patterns in `newString`
  corrupt LaTeX). `replaceAll` splices each occurrence in turn (never `split`/`join`). Pinned in
  `test/unit/editFile.test.ts`; test helpers standing in for `applyEdits` must obey it too.
- **Out-of-band edit guard.** `FileRevisionTracker` (`src/services/fileRevisions.ts`) hashes the last
  bytes the server saw; `write_file`/`edit_file`/`delete_file` throw `ExternalChangeError` on mismatch
  unless `overrideExternalChanges: true`; `status` shows `externalChanges`; baselines reset after
  `project_sync`/`discard` (`resetBaselines`). **`read`/`readText` record a baseline only with
  `recordBaseline: true`** — only when the caller asked for the file and got all of it: `read_file`, and
  `list_references` for a bibliography returned whole (`wholeSources`, `src/lib/referenceBaseline.ts`:
  all entries `bibtex`, none cut, raws covering the file but ASCII whitespace). Not `detectRootFile`,
  snippets, `check_citations`, or `add_citation` (which reads/writes under one lock and writes with
  `overrideExternalChanges`; its fetch runs **outside** the lock). A **ranged** read never records
  (enforced in `FileService.read`, on the request, not in `read_file`).
  `FileService.recordBaseline(…, { strictLinks? })` records bytes already held (default `strictLinks: false`, matching reads).
- **Symlinks.** Every path resolves links before acting (`assertNoSymlinkEscape`, writes and deletes and
  dangling targets too) but the `resolveInside` string stays the file's identity (baseline keys).
  **Use `climbsOut(rel)`** (`src/lib/paths.ts`: `..` first segment ended by `path.sep` **or** `/`) —
  never `rel.startsWith('..')`; `''`/absolute are each caller's call. Links out are followed only for
  `mode: 'local'` **plus** explicit `followSymlinks: true`, from every id resolving to that dir, failing
  closed (`setLinkPolicy` from `ProjectManager.followsUserLinks`). `walk` follows under the same flag
  (realpath cycle guard); `subdir` itself is guarded (`guardLinks`). Server-picked paths pass
  `strictLinks: true`. Document-named paths that leave the project are not reported as openable
  (`unopenablePaths`/`withoutUnopenableLocation`, `src/lib/sourceSnippet.ts`, snippet withheld with the
  location; "escaped" vs past `MAX_REPORTED_PATH_CHECKS` counted apart). `resolveThroughLinks` resolves
  chains. Writes through an in-project link are recorded under the target (`attributedPath`); deletes
  under the link-resolved parent + literal last component (`attributedDeletePath`).

### References

- **`ReferenceResolver` decides which bibliography answers.** `search_references`/`add_citation` use
  `ctx.references`. Unset `WEB_LATEX_MCP_REFERENCE_SOURCE` = default: an unavailable backend may be
  substituted (dblp → crossref → openalex), always reported (`hint`/`fallbackFrom`). Set, or per-call
  `source:` = assertion: unavailable is an error. `config.referenceSourceExplicit` (from
  `parseReferenceSource`) is the sole licence. An invalid value is `config.referenceSourceInvalid`:
  logged, shown by `server_info`, refuses **only the unpinned search** (`ReferenceSourceInvalidError`).
- **Only `BackendUnavailableError` substitutes**; zero hits is an answer. `fetchBibtex` routes by the
  key's namespace and never substitutes. Bad 200s (HTML, wrong shape, stalled body) become
  `BackendUnavailableError` in the backend (`assertApiBody`, `assertApiShape`, `fetchOrUnavailable`,
  `readBodyOrUnavailable`, `src/services/referenceBackend.ts`).
- **OpenAlex publishes no BibTeX**: `OpenAlexService` has no `fetchBibtex` (pinned at runtime in
  `test/unit/openalex.test.ts` — keep it); records are fetched from Crossref by DOI; no DOI → refused,
  never assembled from metadata.
- A fetched entry is cut to its own bytes only (`bibtexEntrySpan`): choosing a cut is allowed;
  inserting, reordering, reformatting or completing is not. Closer believed at depth 0 alone on its
  line, or ending the header's own line with no unmatched closer after; otherwise **fail open** (run to
  end).
- Keys are namespaced (`dblp:…`, `crossref:…`, `openalex:W…`) and parsed in `src/lib/referenceKey.ts` — a
  **security boundary** (ids go into URL paths; never partially validated; emitted keys must re-parse,
  `keyRoundTrips`). `normalizeDblpKey` is idempotent: strips once, refuses leftover `rec/` or
  `.bib`/`.html`/`.xml`.
- `WEB_LATEX_MCP_CONTACT_EMAIL` is opt-in only (never from git config); `server_info` reports only
  whether it's set. Must pass `isUsableContactEmail` (printable ASCII, no `( ) ; \ & ? # /`, ≤254, one
  `@`); rejected → ignored, stderr note, `contactEmailInvalid`.
- **A bibliography isn't always a `.bib`** (`src/lib/references.ts`): BibTeX (`@string` resolved),
  `thebibliography`, or prose lists, as `ReferenceEntry` with `format` and `raw` (exact slice for bibtex
  only). Prose extraction under-claims. File selection: `src/lib/referenceSources.ts`. Neither
  `list_references` nor `check_citations` touches git.
- **`check_citations`' `bibliographyProject`** reads a second **registered** project: two sandboxes
  (`documents` in `project`, `bibliography` in the other, each via `requireProjectDir` + `FileService`;
  a project id, never a `project:path` string), read-only, no lock, reported only on cited keys
  (`uncitedEntries` empty). `list_references` gets no equivalent. `documents`/`bibliographySources` cap at
  20 paths / 2000 chars (`CITATIONS_MAX_FILES`, `CITATIONS_FILES_BUDGET`, `src/lib/citationsBudget.ts`;
  `…Omitted`), not raised by `maxResults`; the keyless refusal caps its list at 20.

### Compile

- **Backend preflight; only an unchosen default is substituted** (`CompilerResolver`,
  `src/services/compilerResolver.ts`, calls `isAvailable()`). `config.compilerExplicit` (from
  `parseCompilerChoice` — derive both answers there) is the licence: unset env → missing `latexmk` may
  be swapped, reported in `hint`; set (even to `latexmk`) or per-call `compiler` → error. **Missing =
  ENOENT only**; EACCES/broken shims → `UnrunnableCompilerError` (never substituted; names both ways to
  choose another). Unrunnable alternatives go into `MissingCompilerError.unrunnable`. Refusals name what
  is installed and both routes, and warn that tectonic yields **no snippets**. `compile` returns the
  backend that ran; `server_info` the configured one.
- **`doctor`** grades `engines`, `distribution`, `package-manager` and the TEXMF `tlmgr --usermode` hint
  against the **effective, installed** backend (`tectonicRuns`). Unrunnable configured backend → `fail`;
  missing with unrunnable alternative → `fail`; substitutable missing → `warn`.
- **No shell commands unless opted in — including TeX Live's `shell_escape = p`.** Every latexmk compile
  gets `-no-shell-escape` unless `shellEscape`/`restrictedShellEscape` (`shellEscapeFlag`,
  `src/services/compiler.ts`, never "no flag"); tectonic needs none. Opt-in is judged by
  `shellEscapeRequested(req, backend)` (under tectonic `restrictedShellEscape` doesn't count). Refused
  commands → `shellEscapeRefusedHint` each compile (overlay wording in a variant).
  `refusedShellCommands` (`src/services/logParser.ts`) counts `runsystem(…)…disabled` and LuaTeX's
  `system(<cmd>) executed.` unless the header banner says enabled.
- **Shell-escape state comes only from the engine banner in the log header**
  (`engineShellEscapeBanner`: lines before the first `**<input>` in a log starting `This is …`):
  `'full'`, `'restricted'`, `'none'`, or `undefined` (no header). **Captured output is never a header**
  (`CompileOutcome.capturedOutput`, `LogSource` → `undefined`). Only `'none'` backs "shell escape was
  off". Override warning (`shellEscapeOverriddenHint`, latexmk only) and a variant's "overrode" line
  fire only on a header banner. With no header, a banner-shaped line anywhere (`logShowsShellEscapeBanner`)
  adds only a hedged "may" note. `shellEscapeRefusedHint`: restricted header → name only
  `shellEscape: true`; full header → nothing; otherwise by refused commands — a non-engine first word
  (`pdflatex|xelatex|lualatex|latex|pdftex|xetex|luatex|etex|tex`) → `restrictedShellEscape`; all engine
  calls → `shellEscape: true`; both → both. **Document-writable lines may only add a hint — never choose
  the flag, narrow the risk, suppress a hint, or make a false claim.** TikZ externalization only ever
  gets `shellEscape: true` (`tikzShellEscapeHint`); under a full banner the TikZ hint is silent and the
  collapsed error points at each figure's log. Hedged wording: "usually because shell escape is
  disabled".
- **The build root is per user, verified, fail closed.** `buildRoot()` is pure, never throws:
  `<tmp>/web-latex-mcp-build-<uid>` (POSIX) or `-<user>` where no uid (win32; `userPathSegment`;
  unreadable → `…-unknown.user`, refused by name). Keyed on the uid, not `process.platform`;
  `ensureBuildRoot` picks rules the same way. `ensureBuildRoot()` makes it `0700` non-recursively (a
  missing temp dir → `UnsafeBuildRootError` naming `TMPDIR`/`TEMP`), `lstat`s it: refuses link/junction/
  non-dir; on POSIX refuses another owner or group/other **write** (`mode & 0o022`, never `chmod`ed);
  read-only-for-others is tightened and re-judged. **Not memoised.** Win32 checks only that it's a real
  directory — say so, claim no more. Judged before every build-dir create/read: `outDirFor`, overlay
  compile before `applyOverlay`, `nameFoldFor`, `stageVariant`, `locateRootPdf`, `resolveVariantBuild`,
  `render_pages` before PNG writes. **Nothing below it is made by recursive `mkdir`**:
  `mkdirUnderBuildRoot` (level by level `0700`, existing level kept only as a real dir, ENOENT →
  `ensureBuildRoot` + one retry, root re-judged and leaf re-`lstat`ed). `mirrorSubdirs` judges once per
  mirror with the same rules; `farmMkdir` (`src/lib/variants.ts`) is exclusive non-recursive, `EEXIST` a
  collision. Residuals (say so, don't claim more): a root swapped between judgement and mkdirs gets
  empty dirs made in the target; the temp dir itself isn't judged (sticky `/tmp` assumed). Refusal
  wording: `Refusing to use build root <root>: <reason>. … then retry.` Tests:
  `test/helpers/buildRootSetup.ts` creates the root the server's way.
- **Overlay compiles** (`compile`'s `overlay`, `src/lib/variants.ts`) apply edits in memory
  (`applyEditsToContent`) in a link farm; nothing goes through FileService's write path, the surfaced PDF
  and viewer untouched. `rootFile` judged once on its raw spelling (`refuseLinkedRootDir`: `..`,
  absolute/drive, under a linked dir → refused). Shell escape off unless opted in; an overlaid
  `latexmkrc` refused under an always-on fold and the Windows name (`isLatexmkRcName`). **Name identity
  is asked of the filesystem, never `process.platform`**: project side by `dev:ino`; farm case fold probed
  (`probeCaseInsensitive`) in `<buildDir>/variants` only after `ensureBuildRoot` (`nameFoldFor` enforces),
  never in a project; probe failure → platform default. Fold twins in one source dir refused
  (`farmTwinCheck`, `foldCaseName`). **The farm never overwrites**: `COPYFILE_EXCL`, no copy fallback on
  link `EEXIST`, any `EEXIST` → `farmCollision`. Skip list matches workspace/build root by realpath too.
  Win32 junction refusals: `junctionRefusal`, `junctionFailureMessage(rel, code)` (drive blamed only for
  `EINVAL`).
- **What can't be closed is reported** (`watchSource` before/after snapshot following links; incomplete
  → "could not be checked"). Workspace skipped by equality; build root wholly. Of root `.git` only
  `hooks/`, `config`, `config.worktree`, `commondir`, `info/` are watched (`GIT_WATCHED`), plus each
  submodule git dir's `config`, `config.worktree`, `commondir`, `hooks/` (`GIT_MODULE_WATCHED`,
  `isGitDir` per git's `is_git_directory`). Relies on `compile` holding the project lock across
  snapshot, build and comparison — keep that span. Names budgeted on both channels summed
  (`SOURCE_CHANGES_NAMES_BUDGET`, `OVERLAY_UNREAD_NAMES_BUDGET`, 2000; `sourceChangedHint`,
  `overlayNeverReadHint`).
- Variants: at most `MAX_VARIANTS`, newest by per-project `seq` (no `seq` sorts below, by `usedAt`;
  renumber before `MAX_SAFE_INTEGER`); eviction failures go to stderr + `hint`, never fail the compile.
  PDF tools read a `variant` build only, never falling back.
- **Tectonic** compiles first remove the job's `.aux`, `.fls`, `.log`, `.synctex.gz`, `.fdb_latexmk`
  (`removeRecordsTectonicDoesNotWrite`, regular files/links, never followed).
- **Error snippets only where vouched for** (`src/lib/errorSnippets.ts` over `src/lib/sourceSnippet.ts`):
  location named outright by one `-file-line-error` line (`ParsedDiagnostic.locatedPair`; never paren
  stack + `l.<n>` — so tectonic gets none); source extensions only; line exists and isn't contradicted
  by the `l.<n>` echo (a contradiction sticks); paths rebased with `outcome.logBaseDir` (errors and
  warnings). Failures counted in `omittedSnippetLocations`, outside the 10-location cap.
  `ParsedDiagnostic` stays in `logParser`.
- **`warningsFilter` trims `logTail` and `warnings[]` together** via one `judgeWarning` (passed to
  `shownWarnings.filter` and as `keepWarning` through `planDiagnosticsPayload`'s `fitLogTail` to
  `fitFilteredLog`), which applies `withoutUnopenableLocation` first. Matching is exact and literal; an
  empty array constrains nothing. `ALWAYS_KEEP_PATTERNS` (incl. rerun hints and `FILE_LINE_ERROR`) is
  checked before warning patterns; error phrases pin only on `BARE_ERROR_LINE` (built from
  `PACKAGE_WARNING`'s source). Rerun hints stay filterable in `warnings[]` — don't "fix" the asymmetry.
  The raw-tail fallback **never** fires when a filter emptied the list (`matchedBeforeFilter`). Without
  `keepWarning` output is byte-identical and the paren bookkeeping doesn't run (differential test).
  Tail lines cut at `LOG_TAIL_LINE_CAP` (500); `diagnosticsBudget.ts` charges against 20000: errors
  first, then tail and warnings each guaranteed half, tail keeps its last line ≥
  `LOG_TAIL_LAST_LINE_FLOOR` (80); the first error's `message` cut by `fitFirstError` (floor 500).
  `rawLog: true` is uncut.

### PDF tools

- **Reading needs pdf.js; only rasterizing needs the canvas.** `.mcpbignore` must ship pdf.js's
  `legacy/build/` (`PDFJS_SPECIFIER`; pinned by `test/unit/mcpbignore.test.ts`). Without
  `@napi-rs/canvas`, `installDomMatrixStub` lets everything but rasterizing work. `createCanvasProbe`
  resolves from pdf.js's location, doesn't memoise transient failures (`TRANSIENT_LOAD_CODES`, via
  `cause`), pins "unavailable" once the stub is in. `render_pages` checks pdf.js before blaming the
  backend (`pdfjsUnavailableError` vs `nativeCanvasError`). `doctor`'s `pdf-render` asks `canReadPdf`
  and `canRasterize` apart (`warn`).
- `compile`'s viewer hint (`viewerShowsForCompile`) compares PDF paths with `samePath` (case fold by
  platform — filesystem, not git). Clipped/rescaled renders are `page-<n>-<hash>.png` (`pngName`).
- **A `labels` lookup is believed only on evidence from the page** (`src/lib/labelPages.ts`; the module
  header lists residuals). Without `/PageLabels` the `.aux` page is a candidate accepted only when that
  page's folio reads it (`readFolios`: bare last-line number, else `FOOT_FORMS` — which beat the
  running head — else head; two head readings → `ambiguousFolio`), corroborated by a neighbour
  (`uncorroboratedFolio`; one-page PDFs exempt). A label's own number is never consulted. Refusals:
  arabic restart (`restarted`), last page decimal ≠ page count (`lastPageMismatch`), label defined twice
  (`multiplyDefined`).
- **Beamer decks never use the tree** (recognised by `\@writefile{nav}`); folio route, and refused first
  on any disagreeing `\beamer@slide` record (`slideMismatch`, `AuxFloatsResult.beamerSlides`,
  `SLIDE_FIELD` one brace level). Do not reinstate an identity-tree rule (`pgfpages` defeats it).
- **Any build that loaded `pgfpages`/`pgfmorepages` refuses every label** (`pgfpagesLayout`) —
  `readPgfpagesEvidence` reads `.fls` and `.log` (always the `.log`), `O_NOFOLLOW`, regular, `O_NONBLOCK`;
  zero-byte = unread. Tri-state: `true` refuses, `false` read and clean, `undefined` also refuses
  (`pgfpagesUnknown`). Evidence only ever adds a refusal; no label exempted by name; message says the
  records name the file and when that's spurious.
- **Stale-build refusals**: `nothingShipped` (shipout marks parsed to an empty list, or empty `.log`,
  while the PDF has pages; `undefined` never triggers) then `stalePdf` (`staleBuildEvidence`): the
  `.aux` **strictly** newer than the PDF (`auxNewerThanPdfMs`, `readBuildTimes`, `lstat`, only with
  `pdfPath` → `pairedPdf`; `resolveLabelPages` throws if it isn't the PDF opened) — **no tolerance, equal
  is not newer; don't reintroduce one** — or the engine's closing record (`parseEngineOutput`: last of
  `Output written on … (N pages`, `No pages of output.`, `==> Fatal error occurred…`, searched with line
  breaks removed; unparseable last → `undefined`; markers inside the last `Output written on <path>` are
  the path) disagreeing with the PDF. Test helpers write/back-date the `.aux` first (`stageAux`, 60 s).
  Residuals are missed refusals (LuaTeX `lfs.touch`/`stop_run`, shell escape, killed runs, coarse
  timestamps, clock skew).
- **Shipout marks** (`readShipoutMarks`, `AuxFloatsResult.shipouts`) refuse a resolved page
  (`unverifiedPage`/`shipoutMismatch`) unless shipped with counter p and (folio route) no other page
  with p competes — a competitor is excused only by a single non-decimal reading
  (`printsOtherStylePage`; ≤ `MAX_AMBIGUOUS_CANDIDATES` read via `pagesToVerify`). Consulted only when
  the mark count equals the page count; never resolve or accept. The parser skips box displays, TeX
  errors, and the first line of context pairs. `lstat` + `O_NOFOLLOW` on open.
- `pdf_geometry kinds: ["floats"]` never refuses: it flags `floatsPagesShifted: true` with a note
  (both channels) for pgfpages, and notes "could not be checked" for `undefined`/nothing-shipped/stale.
- `\include`d labels: `findBuildDirAux` follows line-anchored `\@input` by `readdir` lookup per
  component, **never as a path** (no links, no `..`; `lstat`/`realpath` at read), bounded (256 count,
  depth 8, bytes); case-mismatched names unread (`caseMismatch`); unread inputs named (`unreadInputs`).
  For exact lookups: `hyperref` or `pages:`.

### Payload budgets

Every document-controlled payload is budgeted (`src/lib/*Budget.ts`: conflict, floats, search, inline,
referenceFields, referenceRaw, citations, diff, fileList, comments, diagnostics, referenceTyped,
status, commit, extractText, geometry; plus `capUnshelveConflict`). An oversized result is rejected
**undelivered**, worse than a cut one. Rules:

- **Charge the rendered size, summed over every channel it ships in** (markers, JSON punctuation,
  headers, elision text). Best: the cost function calls the render template (`diffBudget.ts`,
  `searchBudget.ts`'s `matchRenderCost`, `commitBudget.ts`, `extractTextBudget.ts`); otherwise pin
  constants with a two-sided render test.
- **Render the text channel from the already-cut payload.**
- **Cut by declared priority** (`ALLOCATION_ORDER`), with the reason for each rank written down.
- **Overlapping lanes**: guarantee each a share, then spend surplus by priority (`statusBudget.ts`,
  `commentsBudget.ts`, `extractTextBudget.ts`, `geometryBudget.ts`, diagnostics tail/warnings); a lane
  needing less releases surplus (test that one big list still gets nearly all). Disjoint lanes
  (`fileListBudget.ts`, `diffBudget.ts`, `commitBudget.ts`) use strict priority.
- **Count every cut** (`…Omitted`, `omittedByCap`); keep "cut" distinguishable from "absent" (a `null`
  meaning elided has an `elided` entry).
- House figures: 20 for capped lists (`capList`, `CONFLICT_MAX_FILES`), 20000 chars for content, 2000
  for a diagnostic share. Reuse constants.
- **A cut changes what a field promises** — amend schema prose, lib docs and `docs/tools.md` too.
- **Every counter is a new `structuredContent` key → declare it in `outputSchema`.**

### search_files

- **Regex search runs on one killable worker thread per call** (`RegexScanWorker`,
  `src/lib/searchWorker.ts`), started on the first scanned file, terminated at `SEARCH_TIME_BUDGET_MS`.
  Inline source with `eval: true` (not type-checked/linted). It returns only each line's first match
  index; worker error/exit rejects (never a partial answer). Cut files counted in
  `filesPartiallySearched` and named in `note`. Literal search uses no worker and checks the deadline
  before every line (`firstHits`' `expired`).
- `assertLinearishRegex` (`src/lib/searchPattern.ts`) runs on every pattern, literal too
  (`MAX_PATTERN_CHARS` 500), refusing estimated catastrophic backtracking (no unbounded/ambiguous
  repeated groups; `MAX_AMBIGUITY_PRODUCT`; `MAX_CHAIN_WORK` with arrivals, `loopHeavy`, convergence
  floor; product of counted bounds). **Brackets must not earn acceptance** — a parity test compares
  bracketed vs written-out forms (`closedWithin`, `closesFirst`). Lookbehinds judged reversed; Annex B
  escapes and case-fold partners (`caseFoldSample`) by what they match; `$` earns no trailing credit.
  Refusals name constructs and suggest rewrites (`dropAdvice`); `regex: false` is always the way out.
  **The estimate isn't the bound — the worker deadline is.** `ANALYZED_LINE_CHARS` must equal
  `MAX_LINE_SCAN_CHARS` (`searchMatch.ts`; test-asserted, not imported).
- `excludeComments` judges by match start; files without `%` comment syntax are named in `note`. Payload
  budgeted on both channels; text rendered from the cut payload.

### TypeScript and platforms

- `tsconfig.json` needs `"types": ["node"]` (TS 6 + @types/node 25).
- `verbatimModuleSyntax` is on: `import type` for types; import paths carry `.js`.
- **Cross-platform (macOS/Linux/Windows).** Output paths are POSIX via `toPosix` (`src/lib/paths.ts`);
  clones force `core.autocrlf=false`. `execCapture` supports `input`/`env`, sets `windowsHide`, decodes
  stderr once whole. Many-path invocations are batched by `chunkPathspecs`. Bare-repo test URLs use
  `pathToFileURL`. CI runs ubuntu + windows + macos; keep code and tests separator-agnostic.

## Testing strategy

- **Unit** tests mock nothing external — temp dirs and canned data (e.g. real LaTeX log snippets).
- **Integration** (`test/integration/`) runs real git against a local bare repo
  (`helpers/bareRepo.ts`, `file://`) — no network, no secrets; branch `master` like Overleaf. Fixture
  templates live under one dir per run (`test/helpers/templateRunDir.ts`, vitest `globalSetup`,
  `provide`/`inject`), removed by the global teardown. Credential injection is tested against
  `helpers/authHttpRemote.ts` (loopback smart-HTTP with Basic auth); run git hermetically there (empty
  `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_ASKPASS=""`, as `gitUrlCredentialEcho.test.ts` does)
  so the developer's credential helpers aren't consulted or polluted.
- **The compile boundary is the `LatexCompiler` interface**, so only smokes need TeX. `test/smoke/**` is
  gated with `describe.skipIf(!available)` and runs in the `tex-smoke` CI job.
- Fixtures: `test/fixtures/sample-latex/` (minimal project + `main-broken.tex`).

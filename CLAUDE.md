# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server (stdio transport) that lets an MCP client read, edit, compile, and commit LaTeX
in a git-hosted project (Overleaf, GitHub, or any git remote) — or compile and edit a plain local
directory in place. It manages local clones of one or more
projects, compiles locally with `latexmk`, and pushes changes back to the default branch.
[README.md](README.md) is a landing page; the user-facing detail lives in `docs/`: environment
variables in [docs/configuration.md](docs/configuration.md), the full tool list in
[docs/tools.md](docs/tools.md), per-client registration in [docs/install/](docs/install/README.md),
and the multi-session model in [docs/CONCURRENCY.md](docs/CONCURRENCY.md).

## Commands

```bash
npm run build        # tsc -p tsconfig.build.json -> dist/ (build excludes tests)
npm run dev          # run from source via tsx (src/index.ts)
npm run typecheck    # tsc --noEmit (covers src AND test)
npm run lint         # eslint
npm run format       # prettier --write   (format:check for CI verification)
npm test             # vitest run: unit + integration (TeX-gated smokes auto-skip)
npm run test:smoke   # only test/smoke/** (real latexmk compile; needs TeX installed)

npx vitest run test/unit/logParser.test.ts          # a single file
npx vitest run -t "refuses to push while a live peer has uncommitted work"   # a single test by name
```

The full local gate before considering work done: `typecheck` + `lint` + `format:check` + `test`.

## Git workflow

**Before committing, always sync with the remote `dev` and resolve any merge conflicts first** — so you
never clobber upstream work and conflicts surface early, not at push time:

```bash
git fetch origin
git rebase origin/dev         # or: git merge origin/dev
# resolve any conflicts, then re-run the full gate
```

- `dev` is the integration branch: work branches off it and pull requests target it. `main` is the
  release branch, and a guard workflow fails any pull request into it from a branch other than
  `dev` (`.github/workflows/only-dev-into-main.yml`). Only commit once the working tree is in sync with
  `origin/dev` and all conflicts are resolved.
- A pull request into `dev` must change the `[Unreleased]` section of `CHANGELOG.md`; CI checks it
  (`.github/workflows/changelog.yml`), and the local gate does not.
- After resolving conflicts, **re-run the gate** (`typecheck` + `lint` + `format:check` + `test`) before
  committing.
- Commit and push only when the user asks.

## Architecture

**Thin tool layer over a testable service core.** Tools do only schema validation + response
formatting; all logic lives in services so it is unit-testable without a live MCP client.

- `src/index.ts` — stdio bootstrap. Resolves auth (async, may hit the Keychain), builds the context, and
  (when the workspace is local) excludes the workspace-local clone dir from the host repo's git.
- `src/server.ts` — `createServer(ctx)` registers every tool. **Add a new tool here.**
- `src/context.ts` — `AppContext`: the dependency bag (`projectManager`, `git`, `files`, `compiler`,
  `references`, `shadows`, `sessions`, `shelves`, `credentials`, `pdfRenderer`, `viewer`, …) passed to
  every tool handler.
- `src/tools/*` — one file per tool: a zod `inputSchema`/`outputSchema` + a handler that calls services.
- `src/prompts/skills.ts` — registers each bundled skill (`.claude/skills/*/SKILL.md`, loaded by
  `src/lib/skills.ts`) as an MCP prompt, so clients that don't read `.claude/skills` (Claude Desktop,
  Cursor) can still run them. Add a skill by adding its directory — no code change.
- `src/services/*` — the core: `ProjectManager` (id→dir resolution, per-project mutex **+
  cross-process lock**, dynamic registration), `GitService` (simple-git wrapper), `FileService`
  (sandboxed fs), `LatexmkCompiler` (implements the `LatexCompiler` interface), `ReferenceResolver`
  (which bibliography answers a lookup — see below) over `DblpService` / `CrossrefService`
  (search + canonical BibTeX fetch) and `OpenAlexService` (search + `resolveDoi` **only** — it
  publishes no BibTeX, so its records are fetched from Crossref by DOI; see below), each with an
  injectable `fetch` for tests, `SessionRegistry` +
  `ShadowStore` (parallel sessions — see below), `ShelfStore` (`shelve`/`unshelve`), `ProjectRegistry`
  (`<workspace>/registry.json`), `logParser`, `auth`.

**Two kinds of project.** `ProjectConfig` is a union (`src/types.ts`): a **git** project (`gitUrl`,
cloned under the workspace) or a **local** one (`mode: 'local'`, `path` — a directory the user already
has, used in place). `mode` is optional on the git variant so every pre-existing env/registry entry
still parses. `ProjectManager.projectPath` returns the clone dir or the local dir accordingly, and
`requireProjectDir` (formerly `requireClonedDir`) requires `.git` for git projects and mere existence
for local ones. Git-backed tools call `ctx.projectManager.requireGitProject(id, action)` **first** and
refuse a local project — otherwise they would operate on whatever repository happens to contain the
user's directory. `src/lib/projectMode.ts` holds the narrowing helpers.

Project state: clones live under a workspace root (`WEB_LATEX_MCP_WORKSPACE`), one dir per git project
id (a validated one — see the project-id bullet below), beside `registry.json` and `.sessions/`.
When unset, the default is workspace-local — `<launch-dir>/.web_latex_mcp` (beside the agent's code;
git-excluded via the host repo's `.git/info/exclude` — `src/lib/workspaceExclude.ts`) — whenever the
launch dir is a git repo and not the home dir; otherwise it falls back to `~/.web-latex-mcp/projects`.
`WEB_LATEX_MCP_WORKSPACE=cwd` forces workspace-local; any other value is a path. The git-repo detection
(`resolveWorkspace` in `src/config.ts`) is injectable so tests stay hermetic. In workspace-local mode
`compile` also surfaces the PDF at `<workspace>/<id>.pdf` beside the clone (`src/lib/pdfSurface.ts`) —
build artifacts otherwise live in a temp dir. That copy is a **convenience for the user, never a
source for a tool**: it holds whichever root compiled last, so `render_pages`/`extract_text`/
`pdf_geometry` read `rootFile`'s own build-dir PDF in every mode (`locateRootPdf`,
`src/lib/pdfLocate.ts`) and fall back to the surfaced copy only when no `rootFile` was named **and**
no `.aux` is read (`labels`, `floats` are per root). The viewer follows the same rule
(`locateViewerPdf`, one call for the page shown and the SyncTeX that maps a click): when it shows the
surfaced fallback, `synctexPdf` is `null` and a comment is kept without a source location rather than
mapped through another root's build. `ProjectManager` also supports runtime registration.

## Conventions that aren't obvious

- **stdout is the JSON-RPC channel.** Never `console.log` from server code — log to **stderr** only.
  That includes a worker thread: its `process.stdout` is piped into the parent's by default, so
  `search_files`' worker is created with `stdout: true, stderr: true` and forwards both to
  `process.stderr` (`src/lib/searchWorker.ts`).
- **A value the user or a document supplied is quoted and escaped before it reaches a message.**
  `JSON.stringify` escapes only C0, so a bidi override, a zero-width space or a newline in an id, an
  env value or a path went through and could forge a log line. Ids go through `quoteId`/`listIds`
  (`src/lib/projectId.ts`; `escapeInvisibleChars` writes control, bidi and invisible characters as
  `\u{…}`, and every valid id displays verbatim), and rejected env values through `quoteEnvValue`
  (`src/config.ts`, the same escaping, cut at 120 characters with the true length):
  `WEB_LATEX_MCP_COMPILER`, `_VIEWER_TARGET`, `_VIEWER_PORT`, `_WRITING_GUIDE_EXTRA`,
  `_REFERENCE_SOURCE`, `_REWRITE_MODE`, `_CONTACT_EMAIL`. The session recorder's stderr warnings quote
  their file path the same way. A new message naming a caller- or config-supplied string uses one of
  these, never a bare template literal.
- **Tool return shape.** `CallToolResult` has an index signature that named types/consts don't satisfy,
  so `structuredContent` must be a **fresh object literal** — spread it: `structuredContent: { ...result }`.
  Use `errorResult(err, ctx.credentials.allSecrets())` (from `src/lib/errors.ts`) in every handler's catch
  so messages are token-scrubbed across every configured host.
  **Every key that spread puts in must be declared in the `outputSchema`, or the call fails.** The
  spread is the whole risk: `{ ...manifest }` and `{ ...entry }` carry whatever the service type
  grew since the schema was written, and nothing on the server complains — `McpServer` validates
  against the schema, reads only `parseResult.success` and throws `parseResult.data` away, and a zod
  object _strips_ rather than _stricts_, so an undeclared key is neither rejected nor removed. It is
  the **client** that refuses it: zod's JSON Schema conversion marks every object node
  `additionalProperties: false`, and the SDK's `Client` compiles an ajv validator per advertised
  schema during `listTools()` and checks every later result against it, so the caller gets
  `-32602 … must NOT have additional properties` and **no result at all**. An undeclared field is a
  broken tool, not a wide payload: `list_references` was uncallable from v0.6.0 (#137) and the
  `shelve` trio from its own first release (#146). Two things follow. A test `Client` that never
  calls `listTools()` caches no validator and so proves nothing about this — assert the advertised
  schema off a `listTools()` round trip. And an assertion on a NAMED field only answers a question
  someone already asked, which the offending key by definition was not; audit the whole payload
  against the schema (`expectNoUndeclaredKeys`, `test/helpers/outputSchema.ts`), judged on the wire
  form, since an explicitly-`undefined` key survives `InMemoryTransport` but not JSON and is not a
  hole.
- **Local projects never see git.** `status`/`diff`/`commit`/`push`/`discard`/`revert`/`project_sync`/
  `reset_to_remote`/`shelve`/`unshelve`/`list_shelves`, and `read_file` with a `ref`, all guard with
  `requireGitProject`. The confirmation
  diff in `write_file`/`edit_file`/`add_citation` goes through `changeDiff` (`src/lib/changeDiff.ts`),
  which returns `''` for a local project rather than diffing the user's own repo. The shadow/session
  recorder in `context.ts` skips them too (no HEAD of ours to three-way merge against). Compiled PDFs
  are surfaced into the workspace, never beside the user's source — keep it that way: in-place means
  read and edit in place, not litter in place.
- **A project id is a directory name, so it is validated as one** (`projectIdProblem`,
  `src/lib/projectId.ts`, applied by `ProjectManager.registerProject`, `readProjectRegistry` and
  `loadConfig`). An id becomes `<workspace>/<id>` and `.sessions/<id>/`, and `path.join` resolves
  `..`, so `../../somewhere` cloned outside the workspace (and a local `../paper` put the lock inside
  project `paper`'s clone, where `scope: "all"` staged it). The rule refuses **only what is unsafe as
  one directory entry**, because every refusal strands an existing config — Unicode letters, spaces
  and punctuation stay fine (`thèse`, `My Thesis`, `論文`): a separator or a Windows-forbidden
  character (`: < > " | ? *`; `<`/`>` also because the id is embedded in the viewer's `<script>`), a
  backtick (skill prompts put the id in a code span), a control, bidi-override or unpaired-surrogate
  character, an invisible one (`\p{Cf}` or default-ignorable — except a ZWNJ/ZWJ between two
  letters-or-marks of a script that spells with it, `isJoinerInWord`), a line or paragraph separator,
  a space other than U+0020, a leading combining mark (so two ids can never look the same), text that
  is not NFC (the NFC form is named, **never substituted**: macOS hands back NFD and Linux keeps bytes,
  so normalising would make one key name two directories on two machines), a leading `.` or `-`,
  leading or trailing whitespace, a trailing `.` (Windows drops it: `paper.` _is_ `paper`), a `~`
  followed by a digit anywhere (an 8.3 short name such as `PAPER-~1` resolves to another directory),
  `__proto__`/`constructor`/`prototype` (ids key plain objects in `registry.json`), more than 64
  characters or **246 UTF-8 bytes** (255 minus the `-<8 hex>` of the `<id>-<hash>` build directory,
  the longest name built from an id), and — compared under `projectIdFold`, a deliberately generous
  full case fold (`regiſtry.json`) — a Windows device name with or without an extension,
  `registry.json` or a name beginning `registry.json.`, and a `*.pdf` name (the surfaced PDF sits
  beside the clones). A **new** id whose fold equals a known id's is refused too
  (`assertIdUnaliased`), as is a second id for a directory another project already uses
  (`assertDirUnclaimed`); an update of a known id never is. **An existing invalid id is skipped,
  never fatal**: env and registry entries are judged one by one, a skipped one is remembered
  (`ServerConfig.skippedProjects`, `ProjectRegistryStore.skipped`), and a call naming it — including
  one that omits `project` while `WEB_LATEX_MCP_DEFAULT_PROJECT` names it, which no longer stops the
  server starting — is told why and how to rename it (`describeSkippedProject`: the key, and both
  `<workspace>/<old id>` and `.sessions/<old id>/`) instead of "Unknown project". `childPathInside`
  refuses a non-single-segment name at every join (`projectPath`, `sessionStateDir`, `sessionDir`),
  as defence in depth. **The registry is judged per entry too** (`src/services/projectRegistry.ts`):
  one bad entry no longer reads the whole file as `{}` for the next upsert to destroy; an entry this
  version cannot use is written back verbatim; an empty `registry.json` is an empty registry; and an
  unparseable or unreadable one is **refused rather than overwritten** by `upsert`.
- **Mutating tools** (write/edit/delete/add_asset/commit/push/discard/revert/reset_to_remote/
  project_sync/add_citation/shelve/unshelve/set_rewrite_mode, `register_project`'s cloning branch, and
  `compile`, which rewrites the build dir) must run inside `ctx.projectManager.runExclusive(id, ...)`
  to serialize per project. Read-only tools don't (`search_files` and `list_shelves` included) —
  with three deliberate exceptions, `render_pages`, `pdf_geometry` and `extract_text`, which read
  the **temp build dir**
  a peer session's `compile` can rewrite underneath them. That is the whole test for the exception:
  a read-only tool locks only when what it reads is a build artifact another session rewrites in
  place, never merely because it reads. The cost is real and belongs in the tool's description —
  such a tool can wait on, or time out against, a peer holding the lock, and it creates
  `<workspace>/.sessions/<id>/`, so "writes nothing" is never true of it without that caveat.
  The lock file lives outside the clone (`src/lib/sessionPaths.ts`), so `project_sync` takes it before a
  first clone too. The peer-refusal logic `push` and `project_sync` share (`guardPeerWork`,
  `enrichPullRefusal`) lives in `src/lib/peerRefusal.ts`, not in the tools.
  `runExclusive` is two layers: an in-process mutex **and** a lock file (`src/lib/fileLock.ts`,
  `<workspace>/.sessions/<id>/project.lock`), because sibling agent sessions are separate server
  processes over the same clone; it calls `assertValidProjectId` before either, since the lock
  `mkdir`s its directory before anything else looks at the id. A persisting `ShadowStore.refresh`
  may only be called under it (below).
- **The lock file admits one holder only because nobody deletes a record they have not re-read
  and own the right to remove.** Reclaiming a stale lock used to delete whatever sat at the path by
  then — a faster waiter's fresh lock included, two holders in about half of trials with a crashed
  holder and three waiters. So every record carries a random `token` (its identity; a legacy
  token-less record is identified by a hash of its bytes), and **every removal, release or reclaim,
  first takes a removal marker** `<lock>.rm-<identity>.<gen>` (created exclusively; only its creator
  removes it; a dead marker is stepped past to `gen + 1`), then re-reads the record and removes it
  only if it is still the same one, by **rename-then-verify** (`removeRecord`: rename aside to
  `<lock>.gone-<pid>-<token>`, re-read the aside, and on a mismatch put it back with `link`, never a
  rename that could overwrite a new lock). A release removes only its own record (`stillOurs`).
  Crash litter (`.rm-*`, `.gone-*`) is harmless and deliberately not cleaned up. Whether a holder
  is abandoned (`isAbandoned`) is decided in a fixed order: a record written by **this thread** —
  same `processNonce`, pid and `worker_threads.threadId` — is live exactly while `heldTokens` holds
  its token (added _before_ the file is created, so a peer call cannot judge a fresh record
  abandoned); same pid under another nonce is a crashed predecessor restarted as the same pid (a
  container's pid 1) or a twin in another namespace, judged by heartbeat alone against
  `OWN_PID_STALE_MS` (15 s); a dead pid is abandoned; a live pid vouched for this boot is abandoned
  only once the **same record, unchanged, has been seen stale twice at least `STALE_CONFIRM_MS`
  (10 s) apart** on a monotonic clock (`staleAcrossSightings`) — a laptop waking from sleep has every
  lock's mtime old before the holder's overdue heartbeat (`HEARTBEAT_MS`, 5 s) lands, so one look at
  the age stole live locks. `processNonce` exists because pid + threadId repeat across pid
  namespaces: two containers on one volume both run node as pid 1, thread 0. **The limit is stated,
  not solved: one host, one pid namespace** — liveness is `process.kill(pid, 0)` on the local process
  table — and every server sharing a workspace must run this version, since a 0.6.x server still
  deletes a lock it judges stale unconditionally. `LockTimeoutError` (30 s) names the holder and ends
  with the remedy: if no other server is running, the lock was left by a crash — delete the named
  file and retry. On Windows a contended rename is retried (`renameWithRetry`), and atomic writes
  (`writeAtomic`, `src/services/sessionRegistry.ts`) use a per-process counter in the temp name, since
  two in-flight writes in one process used to share one temp file and the second rename hit ENOENT.
- **Parallel sessions share a clone; commits don't.** `WEB_LATEX_MCP_SESSION` names this process
  (`config.sessionId`, sanitised by `parseSessionId` in `src/config.ts`; `shelves`, `project.lock` and
  `rewrite-mode.json` are refused in any case, because each already names project-wide state beside
  the session directories — a session called `shelves` wrote its records into the shelf store; a new
  project-level entry under `.sessions/<id>/` must be added to `RESERVED_SESSION_IDS` by hand).
  `ShadowStore` (`src/services/shadowStore.ts`) keeps, per touched file, a shadow
  holding `HEAD + only this session's edits`; `commit` stages that via `GitService.commitContents`
  (`read-tree --reset HEAD` + `hash-object` + `update-index`, never `git add`), so a peer's in-flight
  edits stay uncommitted in the working tree. The shadow is fed by `FileService.setMutationRecorder`
  (wired in `context.ts`) with the working-tree content **either side** of each write — it folds in the
  _change_, three-way merged, never the file the model happened to read, or peers' lines would leak in.
  After HEAD moves, `shadows.refresh(id, dir)` carries shadows forward (lazily, per session); tools that
  rewrite the whole tree (`discard`, `reset_to_remote`) call `shadows.clearAll(id)` instead, and the
  path-limited ones (`discard` with `paths`, `revert`, `shelve`, `unshelve`) call `settleAll`.
  **`refresh` is a read-modify-write of the index and runs only under `runExclusive`**: `status`, the
  one lock-free reader, goes through `refreshedChanges`, which shares `judge()`/`judgeEntry()` with
  `refresh` (so the two cannot disagree) and **persists nothing** — no index, shadow, base or memo;
  `status`'s only write is its own heartbeat in `session.json`. It used to refresh without the lock,
  which could overwrite a concurrent write's record or resurrect entries a peer's `discard` had just
  settled. Within one process every index read-modify-write (`record`, `markUnrecorded`, `refresh`,
  `refreshedChanges`, `settle`, `settleAll`, `clear`, `clearAll`) is also chained through
  `withIndexLock`, a **module-level** map keyed by session directory, because two `ShadowStore`
  instances in one process write each other's indexes through `settleAll`. `refresh` also **settles
  an entry whose shadow equals an unmoved HEAD** (raw bytes; deleted ⇔ absent at HEAD): an edit undone
  by hand or a file created then deleted through the tools otherwise stayed tracked forever, every
  session commit found nothing, and a peer's `scope: "paths"` refused the path. Entry maps are
  **null-prototype** (`entryMap()`; `readIndexAt` copies key by key): on a plain `{}` a file named
  `constructor` read back an inherited function, and one named `__proto__` read back
  `Object.prototype`, which `record` then stamped. A same-line
  collision flags the entry `conflicted` and it **stays** flagged — never clear it on a later edit, since
  its base is stale and committing it would revert what landed. The store enforces that with
  **`incomplete`**, always paired with `conflicted`: it is set on a record-time collision (text
  `merge3` or a binary `before` that does not match the shadow) and on any byte-changing write to an
  entry that is already conflicted — the cases where the shadow is missing a write this session
  made — and `judgeEntry` skips an `unrecorded` or `incomplete` entry before anything else, so no
  refresh advances, settles or re-judges it; `refresh` had been clearing such a flag, after which a
  peer's `scope: "paths"` took the file. `isFlagged` (`conflicted || unrecorded || incomplete`) is what
  `changes()` and `peerEntries()` report as `conflicted`. A conflict found by `refresh` itself (not
  `incomplete`) may still clear when HEAD moves. Shadows are stored as **bytes**, and an
  entry that has ever carried non-text bytes (`add_asset`, `writeBytes`) is flagged `binary` — stickily
  — and is **never three-way merged**: there is no such thing as a merged PNG, so a peer changing the
  same bytes is a `conflicted` entry, not a merge. `commit scope: "paths"` is the one deliberate
  widening: it stages named working-tree paths via `git add` (index reset to HEAD first), so it may
  carry a peer's lines — which is why it refuses any path a **live** peer's shadow index lists, and
  refuses outright when a live peer's index cannot be read (`null` from `peerEntries` means unreadable,
  never "owns nothing"). State lives in
  `<workspace>/.sessions/<projectId>/` (`src/lib/sessionPaths.ts`), outside the clones. Keep this: the
  guarantee is that a commit contains one session's lines and nobody else's. Two refinements keep
  that honest: **equality between HEAD, a shadow and the working tree is judged through the path's
  gitattributes clean filter** (`GitService.cleanBlobId`, wired into `ShadowStore` as its
  `cleanHash`), because `commitContents` writes _filtered_ blobs — under `* text=auto` a CRLF `.svg`
  lands as LF, and raw comparison flagged a file nobody else touched as `conflicted` forever (#63);
  a genuine collision still conflicts. And **a recorder failure marks the path** (`markUnrecorded`,
  via `src/lib/mutationRecorder.ts`): the write is still never failed, but the entry is written
  `conflicted` + `unrecorded`, so a peer's `scope: "paths"` refuses it and this session's own commit
  excludes it, instead of a live session's edit showing up as owned by nobody. And **taking the tree
  deliberately settles what it took**: after a `scope: "all"`/`"paths"` commit, `commit` drops this
  session's entries _under the paths the commit was given_ (`ShadowStore.settle`/`clear`, by
  `coversPath`), whether or not git staged each one — deliberately, since an entry whose working tree
  already equals HEAD stages nothing yet must still un-wedge — and when git reports nothing to stage
  at all for an `"all"`/`"paths"` request that covers a tracked entry (the content is already at HEAD:
  a `push` with `message` committed it, or a hand revert made outside the server), `commit` settles
  those entries and returns `committed: false` with them under `settled`, rather than refusing and
  leaving the only way out an empty commit or a discard; a request covering nothing this session
  tracks still refuses as before. Since the opening `refresh` now settles an entry whose shadow equals
  an unmoved HEAD, that rescue (`settleNothingToCommit`) only ever sees what refresh cannot settle —
  unrecorded, incomplete or conflicted entries, content equal only through the clean filter, a hand
  revert the shadow never saw — and naming an already-settled path under `scope: "paths"` refuses
  (`Nothing to commit at: …`).
  **A session commit skips what git ignores** (`GitService.ignoredPaths`, run once per commit):
  `commitContents` stages by `update-index`, which never consults `.gitignore`/`.git/info/exclude`,
  so the `summarize-paper` note that relies on the exclude was committed and pushed by the default
  scope while `"all"` (`git add -A`) left it alone. Ignored entries are settled and reported under
  `ignored`. **A `check-ignore` that fails is never read as "nothing is ignored"** — returning
  `[]` there would let the commit stage a file git means to exclude, so the filter throws. The one
  failure with a cure of its own is named: a pathspec beyond a symbolic link (git exits 128 having
  named one path) becomes `PathBeyondSymlinkError`, which quotes the path and points at `discard`,
  because a recorded entry under a linked directory otherwise fails every later commit in the
  session, unrelated files included. The path is reconstructed per requested path from git's own
  quoted form rather than captured out of the message, which a path containing a quote or a
  newline defeats; any other failure reports what actually happened. A tracked file matching a pattern is not ignored (as for `git add`) and still commits —
  and "tracked" is judged **where the staging step that follows will look** (`ignoredPaths`'
  `tracked` option): against HEAD for `commitContents` and `scope: "paths"`, which reset the index
  to HEAD first (`check-ignore --no-index` minus what `ls-tree HEAD` lists — a hand `git rm --cached`
  used to get the file reported ignored, and the session's edit dropped, while the reset put it
  straight back); against the live index for `scope: "all"` with `paths`, whose `git add` runs over
  the index as it stands. Keep the two paired, or the filter passes a path `git add` then refuses
  with its raw "Use -f" hint. That `scope: "all"` + `paths` commit then takes **only what its paths
  cover**: it lists the staged names (`diff --cached --no-renames --name-only -z`), keeps those
  `coversPath` covers, and commits them with
  `git commit --only --pathspec-from-file=- --pathspec-file-nul` (stdin, NUL-joined) — anything else already staged stays staged and out of the
  commit, where it used to ride along. That flag is why **the server needs git ≥ 2.25**
  (`MIN_GIT_VERSION` in `src/services/doctor.ts`: older is a `fail`, unreadable a `warn`). When `core.ignorecase` is set, every by-name lookup against HEAD or
  the index folds ASCII case the way `git add` does — a literal pathspec and `git show ref:path`
  never do — with the exact spelling winning when both exist: the ignore filter (both bases),
  `readAtRef`/`readAtRefBytes` (the shadow's base) and `showAtRef` (`read_file` with a `ref`), and
  `commitContents`, which stages under
  HEAD's spelling because `update-index --cacheinfo` does no case-alias lookup. A `Notes.txt`
  edited as `notes.txt` on macOS was otherwise reported ignored, seeded a null shadow base, and
  committed as a second tree entry. The tool layer's own by-name comparisons fold
  the same way: `coversPath`/`peerOwnership`/`attributePeers`/`ShadowStore.settle` take an
  optional `fold`, and `commit` (every scope: the ownership check, the rescue, the session-scope
  `paths` filter, the settle), `push` (attribution, and the split of dirty paths into mine/theirs)
  and `status` (its session/other split) pass `foldCase` (`src/lib/caseFold.ts`, the one home of git's ASCII-only fold and the exact-first
  `canonicalNames` lookup) exactly when `GitService.isCaseInsensitive(dir)` says so — otherwise
  they stay byte-exact, which is what a `--literal-pathspecs` call downstream does too. Before this,
  a live peer's `Notes.txt` entry did not protect a request naming `notes.txt`, and `git add` staged
  the peer's lines. Keep the lib functions pure: the fold is a parameter, the decision is the
  caller's, and the source of truth is one method — `core.ignorecase` in the clone's config, never
  the filesystem: a repository copied onto a case-insensitive disk without that setting keeps every
  comparison byte-exact, as git itself would. `canonicalNames.resolve` also folds the longest
  tracked _directory_ prefix (`sub/new.tex` → `Sub/new.tex` while HEAD tracks `Sub/`), exact-first
  at every depth, so a new file never opens a second, case-differing directory in the tree; and
  on such a clone `ShadowStore.record` folds a new key onto an existing entry that differs only
  in ASCII case (the store is handed `isCaseInsensitive` like its other git hooks), because
  `shadow/<rel>` and `base/<rel>` sit on the same filesystem, where `shadow/notes.txt` _is_
  `shadow/Notes.txt` — a second entry silently overwrote the first's shadow with HEAD's bytes and
  the commit found nothing staged (macOS CI). `commitContents` still refuses, before any index
  write, an index that spells one file two ways (a legacy one), rather than let the second
  `update-index --cacheinfo` win silently — its remedy is a `scope: "paths"` commit naming the file,
  never a discard of either spelling. **Every per-file refusal in `commitContents` runs before the
  first index write**: it builds a `plan[]` (index mode, the still-a-link `lstat` check, the
  `100644` typechange) for every file, then applies `update-index` in a second loop, because refusing
  mid-loop left earlier files staged and a later `scope: "all"` committed the index as it stood. `GitService.commit` with
  `paths` resolves each one to the index's spelling too, since a literal pathspec never folds. The flag is never cleared on an edit, and
  `refresh` never advances or settles an `unrecorded` or `incomplete` entry (its shadow is
  known-incomplete); only a deliberate take (`settle`/`clear`) or a `settleAll`/`clearAll` (discard,
  revert, shelve) ends that state. A conflicted entry's shadow and base are frozen, so
  its `refresh` verdict depends only on HEAD and the clean filter: `refresh` resolves HEAD's commit once per call
  (`GitService.headSha`, wired as the store's `HeadShaReader`) and **skips a conflicted entry whose
  `conflictHead` is that commit** — otherwise every `status`/`commit`/`push` re-merged and re-hashed
  (two `git hash-object` spawns) each permanently conflicted asset, forever. **Only the persisting,
  locked `refresh` writes the memo** (on its three flagging branches: a side deleted, binary, a
  `merge3` conflict); `refreshedChanges` computes the same verdict and stamps nothing, and `record`
  only ever deletes it. The memo never clears a flag; a HEAD move re-evaluates in full, and an entry
  without the field (an older index) is evaluated once and then memoised. A `record`-time collision
  never gets one: it is `incomplete`, which is skipped before the memo is consulted. A `.gitattributes` edit that has not
  reached HEAD can leave a memo stale, and that is accepted: a stale memo can only keep a flag,
  never clear one.
- **`commit` with no `scope` never widens to the whole tree while a live peer shares the clone.**
  `resolveCommitScope` (`src/lib/commitScope.ts`) decides the default: this session tracks a change →
  `"session"`; it tracks none and no peer is live → `"all"` (unchanged when alone); it tracks none and
  **any** live peer exists → refuse, naming the peers and both explicit routes (`scope: "all"`,
  `scope: "paths"`). "Any live peer", not "a peer that owns something": an unreadable or empty index
  is not evidence of nothing. The fallback used to be unconditional, so a peer's in-flight lines were
  swept into a commit nobody asked to widen — and after an ignored-only refusal left the session
  tracking nothing, an identical retry widened. **The default is decided from `trackedAtStart`**,
  read with `hasChanges` _before_ the opening `refresh`: that refresh can settle the session's last
  entry (an edit undone by hand, content a HEAD move absorbed), and deciding afterwards turned "your
  changes are already at HEAD" into `git add -A` over edits nobody offered. So a session that tracked
  something and has nothing left gets
  `Nothing to commit: this session's changes are already at HEAD`, which deliberately does not suggest `"all"`. `commit`'s `files` and `leftUncommitted` are
  budgeted (`src/lib/commitBudget.ts`, `filesOmitted`/`leftUncommittedOmitted`) — a few thousand
  untracked files made the result undeliverable _after_ the commit had landed — while `filesChanged`
  and the headline's `+added -removed` still total every file committed. A `./`-prefixed path names
  the same entry under every scope.
- **A file both this session and a live peer edited is the peer's too.** `disputedPaths`
  (`src/lib/peerRefusal.ts`, shared by `guardPeerWork` and `enrichPullRefusal`) marks a dirty path
  disputed when this session does not own it, **or** when it does and a live peer's shadow also lists
  it, **or** when it does and any live peer's index is unreadable (`sharedUnconfirmed`). The guard
  used to subtract this session's own paths first, so a shared file counted as ours and a `push` with
  `message` (`git add -A`) committed and pushed the peer's lines in it. `dirty` includes untracked
  files, so a `message` push over an untracked file both sessions list refuses too; the advice
  (`sharedAdvice`) is to land this session's lines with a session-scoped `commit`, then push without
  `message`.
- **`revert` settles the reverted paths in every session, then records them as this session's.**
  A revert lands changes in the working tree that no session authored, so it is a write whose
  ownership has to be decided rather than observed (`unshelve` is the other — see its bullet). It is **not** `clearAll`: a revert is inherently
  path-limited (it touches only what the reverted commits touch), and dropping a peer's record for a
  file nothing happened to is exactly what lets a later `commit scope: "paths"` take that peer's
  lines — the same reasoning that makes path-limited `discard` a `settleAll` rather than a
  `clearAll`. So `revert` calls `ShadowStore.settleAll(id, touchedPaths, fold)`, folded on an
  ignorecase clone like every other by-name comparison. Settling those paths across **every** session
  is the load-bearing half: a peer holding a stale entry for a reverted path still has the
  _pre-revert_ bytes as its shadow content, and `commit scope: "session"` stages shadow content
  through `commitContents` — so that peer's next commit would silently re-install the very lines the
  revert just undid, and no `refresh` would catch it, since a `--no-commit` revert never moves HEAD.
  Settling alone would then leave the reverted lines owned by nobody and a session-scoped `commit`
  staging nothing, which breaks the review-with-`diff`, land-with-`commit` separation the tool exists
  to provide — so `revert` also `record`s each touched path into **this** session's shadow, the
  session that asked for the revert. The recorded `before` is HEAD's bytes, and that is exact rather
  than convenient: the dirty-path preflight refuses the whole call unless the working tree already
  equals HEAD for every touched path, so HEAD's bytes _are_ the pre-revert content. "Equals HEAD"
  includes **absent**: `git revert` silently overwrites an ignored file at a path it restores (a note
  kept out of git through `.git/info/exclude` was replaced by old committed bytes), and `status`
  never lists one, so `dirtyAmong` (`GitService`) judges every touched path HEAD does not track on
  disk with `lstat`, ancestors included and any other error read as dirty, and reports what it adds
  beyond `status` as `inTheWay` — the refusal says to move the file by hand, since `discard` never
  removes an ignored file. Refusal path lists are capped at 20. Both sides go into the shadow through
  **`asShadowContent`** (`src/lib/shadowContent.ts`, shared with `unshelve`): bytes are text only when
  NUL-free **and** they survive a UTF-8 round trip, otherwise the Buffer is kept (a sticky `binary`,
  never-merged entry) — decoding any NUL-free file as UTF-8 put U+FFFD into the next session commit
  where a Latin-1 file had `é`. Baselines are
  reset the way `discard` resets them (`ctx.files.resetBaselines(dir)`), or the next `edit_file` on a
  reverted path would throw `ExternalChangeError` for a change the server itself made; that call is
  dir-wide, so it also drops the out-of-band-edit claim for files the revert never touched — an
  accepted over-reset, not an oversight, since `FileService` has no per-path variant.
- **`shelve`/`unshelve` never lose work to an error they cannot see.** A shelf
  (`<workspace>/.sessions/<id>/shelves/<shelfId>/`, `ShelfStore`) is written in full — manifest last —
  **before** the tree is touched, so when clearing the tree fails `shelve` names the shelf and how to
  restore it instead of implying the work is gone. On the way back, `ShelfEntry.sides()` reads both
  sides of a file once and refuses a shelf that contradicts its own manifest (`ShelfCorruptError`,
  nothing written, shelf left as it is), and **only ENOENT means absent**: every read error used to
  be taken for "the shelf recorded a deletion", so an unreadable shelf deleted the user's file,
  reported success and then removed the shelf. All sides, current bytes and HEAD's bytes are read,
  and every merge is run, before the first write; the writes go through `writeWithRollback`
  (`src/lib/shelfRestore.ts`), which rolls back per path and reports any path it could not restore.
  **When HEAD moved under a shelved text file** and the tree is clean there, `planUnshelveFile` merges
  the shelved change onto HEAD's new content with the shadows' `merge3` (reported under `merged`); it
  still refuses, shelf intact, when the changes touch the same lines, the file is not text, or one
  side added or deleted it. Its refusal payload is budgeted by `capUnshelveConflict`
  (`src/lib/shelf.ts`, on `conflictBudget.ts`'s constants) with **`theirs` — the shelved content, the
  one side no tool can read back — charged first and cut last**, and exempt from the per-side cap.
  Ownership is decided as for `revert`: `settleAll` across every session, then `record` into this
  one through `asShadowContent`, with the shelf's base as `before` for a restore and HEAD's bytes for
  a merge (`resolveUnshelveFile` says why). A failed `record` there is only logged, not
  `markUnrecorded` as `revert` does — a known gap, not a pattern to copy.
- **`status` collapses a dead, change-free peer into a count — a report change, never a deletion.**
  A session record is removed only on a clean shutdown (`SessionRegistry.release()`), so a killed
  agent process leaves its record behind forever and `activeSessions` grew without bound with peers
  that hold nothing and are never coming back. `isStalePeer`/`splitStalePeers`
  (`src/lib/peerSummary.ts`) fold a peer into `staleSessions: N` only when it is `!live`, its
  shadow index read back as a readable **empty** array, **and** its heartbeat is at least
  `RECENT_HEARTBEAT_GRACE_MS` (2 hours) old. The guard that matters is the one it would
  be easy to get backwards: **`null` from `ShadowStore.peerEntries` means the index was UNREADABLE,
  never "owns nothing"** — the same fail-closed reading `attributePeers` uses — so a dead peer with
  an unreadable index stays listed individually with `changes: null`. A live peer is never
  collapsed either, whatever it currently holds. The heartbeat clause is the same refusal applied
  to the _other_ ambiguous value: `peerEntries` maps ENOENT and a readable-empty index to the same
  `[]`, so `[]` means "nothing is recorded", not "nothing was changed" — a session whose write
  landed in the tree while its own index write failed is `[]` too, and collapsing it removes the
  only named suspect for lines sitting in `otherChanges`. So the collapse waits. The window is a
  **usefulness** window, not an evidence one — elapsed time says nothing about whether a write
  failed, it only bounds how long someone is still looking at those lines — and saying otherwise
  in a comment is the overclaim to avoid when re-deriving the number. Two sizing rules hold that
  clause up and are both
  easy to lose: the window must **exceed `STALE_MS`**, because `!live` already implies a heartbeat
  at least that old, so anything at or below 30 minutes is vacuous and reads like a working guard
  while firing never; and a **non-finite** age (an unparseable `heartbeatAt`) is never collapsed —
  the opposite sign from `bootIdentity.ts`, where a non-finite age earns nothing, because there
  granting means calling a peer _live_ while here collapsing means asserting it holds nothing.
  `isStalePeer` stays **one conjunction** for the same reason: every clause only narrows, so the
  age clause can only ever collapse fewer peers and is structurally incapable of weakening the
  `null` guard ahead of it.
  **Nothing is reaped from disk, and `SessionRegistry.collectGarbage()` must stay uncalled from
  here.** `status` is read-only and takes no lock, and `live` is _derived_, not authoritative: a pid
  can be invisible across a pid namespace, and a record only reads stale once its heartbeat is older
  than `STALE_MS` (30 minutes) — `HEARTBEAT_THROTTLE_MS` (30 seconds) only paces how often a live
  session rewrites that heartbeat, so do not conflate the two. An idle-but-alive peer therefore
  reads as dead well inside its own session, and deleting its record while it races its own
  `record()` would destroy the ownership proof `commit scope: "paths"` and `push` refuse on. An
  integration test asserts each session's `session.json`, and the `shadow.json` of every session
  that has one, survives a `status` call — the **files**, not merely the directory, since `release()`
  removes only the record and leaves the directory standing, so a directory-only assertion lets that
  shape of "cleanup" land quietly — and that a corrupt index is still corrupt, since "repairing" one
  turns unreadable into "owns nothing". Records accumulate on disk; only the _report_ is bounded.
  One accepted cost: a session killed between its working-tree write and `record()` leaves dirty
  lines with no shadow entry, and now collapses into a bare count instead of surfacing as a named
  suspect for them. The lines stay in `otherChanges` and no guard changes — `commit`/`push` consult
  `livePeers()` — so this is diagnostic loss only. **A malformed peer record is repaired on read,
  never dropped** (`SessionRegistry.readRecord`): the session directory, not the record, is the
  authority for its name (a record claiming `../x`, or another session's id, made `status`, `commit`
  and `push` throw for every session), a missing `startedAt` falls back to the heartbeat, and only a
  record with no usable `pid` or `heartbeatAt` is unreadable — dropping more would make a live peer
  invisible to `livePeers()` and its lines unprotected, which is the fail-open direction.
- **Which bibliography answers a lookup is one decision, and it lives in `ReferenceResolver`.**
  `search_references`/`add_citation` go through `ctx.references`, never a concrete backend.
  Selection is the `CompilerResolver` rule — **an assertion, never an inference**: an unset
  `WEB_LATEX_MCP_REFERENCE_SOURCE` is a _default_, so a backend that cannot answer may be
  substituted (dblp → crossref → openalex), always reported in `hint`/`fallbackFrom`, never
  silently; set — or a per-call `source:` — is an assertion, and an unreachable backend is an
  error rather than a quiet switch to a different bibliography. `config.referenceSourceExplicit`
  is the whole licence for a substitution, derived in one place (`parseReferenceSource`), exactly
  as `compilerExplicit` is. There is a **third** state `compilerExplicit` has no analogue for: a
  value that names no backend at all. It neither throws at startup nor falls back — throwing
  killed every tool in the server over a setting that governs one, and falling back would answer
  from a bibliography the user did not name, which is the inference this rule exists to forbid.
  It is remembered as `config.referenceSourceInvalid`, logged to stderr, reported by
  `server_info`, and refuses the **unpinned search alone** (`ReferenceSourceInvalidError`) — a
  per-call `source:` is an assertion and still wins, and `fetchBibtex` routes by the key and is
  untouched. Scope the refusal to what the setting actually governs. Two distinctions carry the rest, and both are easy to erase:
  **only `BackendUnavailableError` substitutes** — a search that succeeds with zero hits is an
  _answer_ and is returned as-is, because falling through would turn "DBLP has never heard of
  this" into "here is what Crossref found instead", a different claim; and **`fetchBibtex` routes
  by the key, never by the configured source**, and substitutes nothing, since a key names one
  record in one backend. That is why a 200 carrying an anti-bot HTML page or a wrong-shaped JSON
  envelope has to become `BackendUnavailableError` in the _backend_ (`assertApiBody` /
  `assertApiShape` / `fetchOrUnavailable` / `readBodyOrUnavailable` in
  `src/services/referenceBackend.ts`, where the shape is known — the body read needs the same
  wrapper as the fetch call, because the timeout signal governs streaming too, so a stalled body
  threw past the chain) rather than surfacing as an empty result the resolver would believe. The `.bib`
  guarantee constrains this whole layer: **OpenAlex publishes no BibTeX at all**, so
  `OpenAlexService` has no `fetchBibtex` and its records are fetched from Crossref by DOI. The
  resolver's `DoiBackend` records that intent but does **not** enforce it — TypeScript is
  structural, so a grown `fetchBibtex` would still satisfy the declaration; what pins the
  absence is the runtime `expect(svc.fetchBibtex).toBeUndefined()` assertion in
  `test/unit/openalex.test.ts` ("OpenAlexService interface shape"), so keep that test. A
  record with no DOI is _refused_, never assembled from metadata, because an entry composed from
  fields is exactly the model-authored text `add_citation` exists to keep out. For the same
  reason a fetched entry is cut to its own bytes and no further: `bibtexEntrySpan` finds the
  leading run of line-anchored entries (bridging `%` lines and `@string`/`@preamble`/`@comment`
  blocks only when another entry follows) and `fetchBibtex` returns that slice, so a proxy banner in
  front never reaches a bibliography, and junk behind reaches it only when the cut cannot be
  believed. A closer is believed at depth 0 in one of two shapes: **alone on its line** (DBLP), or —
  because Crossref sends a whole entry on one line, where no closer ever stands alone, so the cut
  used to find no end and appended a trailing `<script>` to the `.bib` — **ending the header's own line** with only
  whitespace after it **and no unmatched closer of the entry's pair anywhere after the cut**.
  Everything else **fails open** — the span runs to the end of the text, so nothing after the entry
  is cut — because a truncated entry is worse than an untidy one: braces that never balance, a
  closer reached inside the other delimiter pair, and the documented residual, one-line junk that
  itself carries an unmatched closer (`<script>}</script>`), which comes back whole, junk included.
  Choosing a cut point in the service's bytes is allowed; inserting, reordering,
  reformatting or completing them is not, and that is the whole line. Record keys are
  namespaced (`dblp:conf/cvpr/HeZRS16`, `crossref:10.1109/CVPR.2016.90`, `openalex:W2194775991`)
  and parsed in one pure module, `src/lib/referenceKey.ts`, whose validation is a **security
  boundary** rather than a convenience: every id it returns is interpolated into a request URL
  path, so it never returns a partially-validated value, and a key the server _emits_ must
  re-parse to the same record. **A key is never rewritten into a different record**:
  `normalizeDblpKey` strips once and then refuses what still carries a `rec/` prefix or a
  `.bib`/`.html`/`.xml` suffix, because `DblpService.fetchBibtex` normalises again and
  `dblp:rec/rec/conf/x/y` parsed to one id and fetched another — the function must be idempotent on
  everything it accepts; `search` drops a hit whose key would not round-trip (`keyRoundTrips`).
  `WEB_LATEX_MCP_CONTACT_EMAIL` (Crossref's and OpenAlex's polite
  pool) is opt-in only — never derived from `git config user.email` — and `server_info` reports
  only _whether_ one is set, never the address. It must be printable ASCII without `(`, `)`, `;`,
  `\`, `&`, `?`, `#` or `/`, at most 254 characters, one `@` (`isUsableContactEmail`): a non-ASCII
  address cannot ride in a header, so every Crossref/OpenAlex request failed before any I/O while
  `server_info` called it configured. A rejected value is ignored, noted on stderr (the only place the
  address ever appears) and reported as the boolean `contactEmailInvalid`.
- **Nothing keyed by a document- or user-supplied name may be a plain object.** File paths, BibTeX
  entry types, remote hosts and project ids all turned up as `constructor`, `toString` or
  `__proto__`, and a `{}` answered with `Object.prototype`'s members: a session's edit to a file named
  `constructor` was recorded into nothing and left out of the default commit, one named `__proto__`
  wrote the shadow bookkeeping onto `Object.prototype` itself, `@constructor` crashed
  `list_references`/`check_citations` (`REQUIRED_FIELDS[entry.type]`), and a remote host named
  `constructor` could be handed the value of an environment variable literally named `undefined`.
  Use a null-prototype object (`Object.create(null)`: `entryMap`, `parseFields`/`emptyFieldMap`,
  `nullProtoRecord`, the `kept` map in `referenceFieldsBudget.ts`) or a `Map`, and look a name up with
  `Object.hasOwn` (`hostDefaults` in `src/services/auth.ts`). The on-disk JSON stays a plain object;
  only the in-memory reader changes. `test/unit/protoKeyedMaps.test.ts`,
  `test/unit/shadowStoreProtoKeys.test.ts` and `test/integration/protoNamedFiles.test.ts` pin it.

- **A bibliography is not always a `.bib`.** `src/lib/references.ts` parses references out of three
  shapes — BibTeX (`@string` macros resolved), a LaTeX `thebibliography` of `\bibitem`s, and a prose
  reference list in a markdown/plain-text document — behind one `ReferenceEntry`. Every entry carries its
  `format` and its `raw` (a `bibtex` raw is an exact byte slice; a `bibitem` or prose raw is the
  item's text trimmed), because only `bibtex` fields are exact; the prose extractor
  deliberately under-claims (a `title` only when the text delimits it, authors only before a
  parenthesized year) so a wrong guess never sends a bibliography lookup after the wrong paper. `list_references`
  and `check_citations` are the tools over it, and `src/lib/referenceSources.ts` decides which files to
  scan. Neither touches git — the case they exist for is a draft with no remote and no `.bib`.
- **`check_citations` may read a second project — read-only, and only where the draft touches it.**
  `bibliographyProject` names another registered project whose bibliography to check against (a shared
  group `.bib` the draft cites but does not contain). This is a deliberate widening of what one call can
  reach, and it holds only under these rules — keep them:
  - **Two sandboxes, never one.** `documents` resolve inside `project` and `bibliography` inside
    `bibliographyProject`, each through `requireProjectDir` + `FileService`. No path crosses over; a
    caller cannot reach a directory by naming it as a path, only by naming a **registered** project
    (which the user registered and owns). That is why the field is a project id, not a `"project:path"`
    string — a namespace overloaded onto a path field is one parse bug away from an escape.
  - **Read-only only.** Nothing writes across projects. `add_citation` into someone else's `.bib` stays a
    separate, permissioned act, because the `.bib` guard and "entry text originates from the service"
    both depend on that staying narrow.
  - **No lock is taken**, as for every read-only tool. `runExclusive` is per project and serialises
    writers; two concurrent reads of a `.bib` need nothing, and taking two locks would invite a deadlock
    against a peer session locking them in the other order.
  - **A foreign bibliography is reported on only where the draft cites it** (`uncitedEntries` empty,
    the rest filtered to cited keys). A shared `.bib` is supposed to hold entries this draft does not
    cite; listing 300 of them re-creates the context burn the parameter exists to remove.

  `list_references` deliberately gets **no** equivalent: it already reads whichever project `project`
  names, and a cross-project listing is two calls with nothing to join. Only `check_citations` joins two
  sets, so only it needs to name two projects. Its own `documents` and `bibliographySources` lists are
  capped at 20 paths and 2000 rendered characters each (`CITATIONS_MAX_FILES`,
  `CITATIONS_FILES_BUDGET` in `src/lib/citationsBudget.ts`; `documentsOmitted`/
  `bibliographySourcesOmitted`), and `maxResults` does not raise them — a local project of 1500
  markdown notes returned ~84 KB of paths. The keyless-bibliography refusal caps its file list at 20
  names (by count only).

- **`.bib` files are guarded.** `write_file`/`edit_file`/`delete_file` reject a `.bib` target
  (`isBibFile`, `src/lib/bib.ts`) unless `confirmBibEdit: true` — keep this. `isBibFile` also judges
  the name Windows would open — the final component cut at its first `:`, trailing `.` and spaces
  stripped — because `refs.bib.`, `refs.bib ` and `refs.bib::$DATA` all open `refs.bib` there and
  passed as non-`.bib` names; it applies on every platform, since the extra matches on POSIX are the
  fail-safe direction. The sanctioned write path
  is `add_citation`, which re-fetches BibTeX from the issuing bibliography service server-side so entry
  text never originates from the model. The guard lives in the tool layer, so `add_citation` writing via `FileService` is intentionally
  not blocked — but `add_citation` judges the link-resolved name in the **other** direction: a
  `.bib`-named link to a file that is not one (a committed `refs.bib -> main.tex`) is refused, or the
  entry lands in `main.tex`. The guard judges the **link-resolved** name too (`FileService.linkTarget` — symlinks only: a hard
  link is invisible to `realpath`, and git cannot commit one): an in-project
  `figures/x.png -> refs.bib` passes the escape check (it stays inside) and used to let `write_file`,
  `edit_file` and `add_asset` change the bibliography with no confirmation. `linkTarget` decides
  nothing about whether a path may be used — that stays `assertNoSymlinkEscape` — it only tells the
  tool layer what the path is called at the far end, so every name-based gate can judge that too; it
  runs inside `runExclusive`, so a peer cannot plant the link between the check and the write.
  `delete_file` judges only the literal name: removing a link removes the link, not what it points at
  (a delete _under_ a linked directory does remove the real file — the shadow record follows it, see
  `attributedDeletePath` below — but the name gate still judges what the caller named).
- **`add_writing_convention` is guarded too, for the opposite reason.** When no extra writing guide is
  configured (`ctx.config.extraWritingGuidePath` unset), the unconfigured-guide error wins outright —
  there is nothing to confirm writing to a destination that doesn't exist, so the tool goes straight to
  `appendWritingConvention`'s actionable "set `WEB_LATEX_MCP_WRITING_GUIDE_EXTRA`" error, no
  confirmation round trip. Only once a destination IS configured does it refuse
  (`guideEditBlockedMessage`, `src/lib/writingConventions.ts`) unless `confirmGuideEdit: true` — keep
  this. Where the `.bib` guard exists because entry text must never originate from the model, here the
  appended rule originates **only** from the model (a caller-phrased convention), so the gate cannot be
  "re-fetch from a trusted source" the way `add_citation` is; it is the user's acknowledgement instead.
  This is also the one write in the whole server that lands outside every project sandbox: the target
  file is loaded into the server's MCP `instructions`, and served over `guide://latex/writing-guide`, at
  **every future startup**, so one unguarded call would persist model-authored text into every later
  session's system prompt. The check is `!== true` in the tool layer (an optional boolean, not a
  schema-level `z.literal(true)`), mirroring `confirmBibEdit`'s shape exactly; `appendWritingConvention`
  keeps writing only to `ctx.config.extraWritingGuidePath`, never a caller-named path. Because the
  rule lands in Markdown that becomes a system prompt, it must not be able to forge structure: it is
  split on every CommonMark line ending (`COMMONMARK_LINE_ENDING`, a lone CR included —
  `rule\r# Heading` added a heading), and a leading `#`, `>`, fence (` ``` `/`~~~`) or setext `---`/`===`
  underline is backslash-escaped (`escapeLeadingBlockMarker`); `countWritingConventions` splits the
  same way.
- **`add_asset` is the one _read_ from outside every project sandbox, and it is gated on both ends.**
  `sourcePath` names a file on the machine running the server, by design outside every sandbox, so
  `resolveInside` cannot apply; what makes the read accountable is the asset-extension allowlist
  (`src/lib/assets.ts`) checked on **both** sides: the destination first (before anything is read), the
  source's own name before any syscall, and the source again on its **realpath'd** target, so a symlink
  named `photo.png` pointing at an extensionless secret is judged on where it lands. The first
  implementation gated only the destination and was an arbitrary-file-read primitive
  (`sourcePath: "/etc/passwd"` → `figures/innocent.png`, echoed back by the confirmation diff), which is
  why `add_asset` deliberately returns **no diff** and why every syscall outcome on the source collapses
  to found / not-found / not-a-regular-file / unresolvable with no errno text (`sourceSyscallError`).
  **What was checked is what is read**: the realpath'd file is opened once (`O_NOFOLLOW` and
  `O_NONBLOCK` where the platform has them), checked with `fstat`, and read through that handle up to
  `MAX_ASSET_BYTES` (refused if it grows past the cap mid-read) — resolving, checking and then reading
  by name let a swap in between substitute another file. `O_NOFOLLOW` covers the final component
  only; an intermediate directory swapped after the `realpath` is not claimed. A Windows UNC or
  device path (`\\…`, and `//…` on win32) is refused **before any syscall**
  (`isUncOrDevicePath`), because merely resolving one connects this machine to that server. Widen `ASSET_EXT` only for a genuine figure
  format — it is a security gate, not a convenience — and keep the source-side check: the destination
  check alone constrains nothing about what is read. The destination is judged on its link-resolved name as well
  (`linkTarget`, above): a link named `figures/x.png` whose target is not an asset type is refused.
- **Rewritten prose can be preserved by commenting it out, and the transform lives server-side, not in
  the writing guide.** `edit_file` can prefix the old text with `% ` above the replacement instead of
  discarding it — the habit Overleaf users already have. This has to be a guard the server enforces, not
  a prompt rule asking the model to retype the old text as `%`-commented lines: a preserved block is only
  worth anything if it is provably the bytes that were there, the same reasoning that keeps BibTeX entry
  text originating from a bibliography service rather than from the model retyping it. **`edit_file` only, never
  `write_file`**: a whole-file write has no "old paragraph" to splice a comment above, only an entire old
  file, and commenting out all of it is never what is meant. A `.bib` target stays exempt regardless of
  mode — that file already has its own guard, and a `.bib`'s entries are not prose to preserve either way.
  Both the `.bib` exemption and the comment-syntax check judge the **link-resolved** name too
  (`linkTarget`, as `confirmBibEdit` does): the bytes land in the target, so a `notes.tex` link onto
  `refs.bib` would otherwise put `%` lines into a bibliography, where `%` is not a comment.
  Modes are `off` / `prose` / `always`, default **`off`**: preservation writes bytes the caller did not
  ask for, so it is opt-in, never a silent default. A user turns it on per project with
  `set_rewrite_mode` (sticky state under `<workspace>/.sessions/<projectId>/`, never inside a clone) or
  server-wide with `WEB_LATEX_MCP_REWRITE_MODE`, with a per-call `preserveOriginal` on `edit_file` that
  always wins in both directions, same shape as `compile`'s per-call `compiler:` argument.
  **`prose` is a deliberate, documented exception to "an assertion, never an inference" — but only once a
  user has made the assertion of turning it on.** The rule otherwise governs `followSymlinks` and
  `compilerExplicit`: an inference the server makes on its own initiative. `prose` never does that — the
  server infers nothing until a user has explicitly opted into preservation (per project or server-wide),
  and only inside that opted-in mode does it guess _which_ edits look like a rewrite. That guess is
  allowed here specifically because the two things "assertion, never inference" protects against don't
  apply: `followSymlinks` guards a sandbox escape and `compilerExplicit` guards a silently changed compile
  backend, and getting either wrong is a security hole or a wrong PDF. Guessing wrong about `prose` costs
  a stray `%`-commented paragraph sitting in a diff the tool already returns and the user already reviews
  before pushing — cosmetic, reversible, and visible, with an explicit `preserveOriginal` sitting on top
  for whenever the guess is wrong. That is a cost worth inferring around, once the user has opted in; the
  other two are not, and neither ever fires without the user's own initiative. The preserved block carries
  **no sentinel marker on
  purpose** — it is byte-identical to what a human would have typed on Overleaf, not something stamped
  `% [preserved by web-latex-mcp]`, so a co-author sees a normal commented-out paragraph, not a
  machine-generated one, and `arxiv-clean-project` already strips comments before submission regardless.
  The cost — no tool can later tell an old paragraph from an author's own commented-out note — is
  accepted, not overlooked. The transform is not a pre-pass over the edit list — it runs _inside_
  `FileService.applyEdits`, as the single `opts.preserve` hook called after that method's own
  identical/not-found/non-unique guards, with the actual match position and file content in hand
  (`src/lib/rewriteMode.ts`'s `createPreserveTransform`). That placement is load-bearing, not
  incidental: an edit with `oldString === newString` never reaches the hook at all (`applyEdits`
  rejects it first as a no-op — a range edit at resolution, against the file as the call found it), so there is no risk of the hook turning it into `old` vs.
  `"% " + old + old` — a wrapping pass running _before_ that guard would silently disarm it. Two
  more restrictions on when preservation actually fires, both easy to miss because they read as
  "preserve every edit" from the mode name alone: **only a line-aligned string match is ever
  preserved** — `oldString` must start at the beginning of a line and end at the end of one (or end
  with its own terminator: `\n`, `\r\n` or a bare `\r`; a trailing `\r` with `\n` next is half a
  CRLF, not a terminator), because a mid-line match has no
  safe place to put a `%`-comment without swallowing or reflowing text that was never part of
  `oldString`. Alignment, the separator, the split-CRLF test and whether a consumed terminator is put
  back after the replacement are all **judged in the file as the call found it** (`judgedAt` in
  `src/lib/rewriteMode.ts`, over the `MatchOrigin` that `applyEdits` maps back through its splice
  log, used only when the original bytes at that origin are exactly `oldString`), so an earlier edit in
  the same call cannot change what a later one writes — and line start and line end must **also**
  hold in the current content, since an earlier edit that took a terminator left live text beside
  the match, which a preserved deletion would comment out. A range edit is exempt from alignment
  (whole lines by construction): its block comments out every line the range named, a blank one
  included (`commentOut(…, { wholeLines: true })`), while a blank-line range _deletion_ skips the
  hook and is deleted outright. `commentOut` splits on `\r\n`, `\n` and `\r` and keeps each line's own
  terminator, so a CR-only file stays CR-only, and the separator after a block
  (`resolveSeparatorLineEnding`) prefers the byte actually at the block's end, so a stray CR in an
  LF file is not turned into CRLF; and **a `replaceAll` edit is never preserved**, since there is no single match
  position to comment above — `applyEdits` skips the hook entirely for one, and the hook itself
  checks `edit.replaceAll` again regardless, so neither call site can be the reason this guard
  goes quiet. As with `parseCompilerChoice`, the mode is resolved in exactly one function —
  per-call `preserveOriginal` > stored project mode > `WEB_LATEX_MCP_REWRITE_MODE` > `'off'` —
  so no second code path can derive a different answer.
- **Preservation leaves the old text in the file as a comment, so `applyEdits` tracks what it inserted.**
  Once an edit's original is commented in above its replacement, that text is in the file — and the
  _next_ edit in the same call sees it, because each iteration re-counts against the current content.
  Left alone, a later edit whose live target the earlier edit just replaced would match the comment
  instead: it would rewrite dead text, report success for a change no reader sees, and mutate the block
  this feature calls byte-exact — turning what should be a loud `oldString not found` into silence. So
  `applyEdits` keeps the `[start, end)` ranges of the blocks it inserted and refuses a non-`replaceAll`
  edit whose match intersects (falls inside or across the edge of) one. **The ranges must be shifted on
  _every_ splice, `replaceAll` included** — a `replaceAll`
  runs no hook but still changes length, at every occurrence, and stale ranges fail in both directions:
  they miss a real hit (the original bug, back in full) and refuse edits that only touch live text. Keep
  the ledger in `applyEdits`, which is the only code that sees every splice offset; `FileService` stays on
  pure integer offsets and learns nothing about `%` (it does reason about `\r`/`\n` terminators, below).
  The two halves — the hook and its ranges — are one
  option for that reason: passing a hook without its ranges silently restored the bug, so the type must
  not permit it. Each ledger entry is a `PreservedBlock` (`start`, `end`, the edit that made it, the
  last edit that touched it, `rewrittenTo`, `pairedNl`), and `splice` — the only place content
  changes — shifts it along with the pending ranges, the cut points, the restored terminators and the
  splice log. **At the end of the call `assertBlocksStillComments` refuses the whole call, writing
  nothing**, when a later edit pulled live text onto a `%` line (`P` preserved, then `\nQ` → ` tail`
  gave `% P tail`, which LaTeX silently drops) or when a block's own bare-`\r` terminator now meets a
  `\n` it was not designed to pair with, which would swallow a blank line. Before that, `unfuse`
  visits each range-deletion cut point, last to first, and turns a bare `\r` left directly before a
  blank LF line into `\n`, so the two never read as one CRLF — but only bytes the file had before the
  call, or terminators the hook reports putting back through `lastRestoredTerminator`. That third
  member of `EditTransform` is **optional** in the type: a hook without it silently disables `unfuse`
  for the terminators it restores.
- **`edit_file` is order-independent within a call, and refuses a file it cannot round-trip.**
  Ranges are resolved up front against the file as the call found it (`pendingRanges`: span, the
  terminator after it, the one before it), and **whether a range edit is a no-op is judged there**,
  never at apply time — deleting an unterminated last line and the line before it was refused as
  "identical" in one of the two orders. An empty `newString` on a range **deletes the lines outright,
  terminator included** (for an unterminated last line, the terminator before it — unless that one
  sits inside a block preserved earlier in the call), instead of leaving a blank line, which in LaTeX
  is a `\par`; and a range **always owns** the terminator after its `endLine`, so a string edit that
  touches it is refused as an overlap. A range's `prev` terminator is invalidated when a splice
  touches it and re-measured, with a following range inheriting a deleted range's `prevAtStart` —
  in a mixed bare-CR/LF file an earlier deletion can leave a bare `\r` beside `\n`. **`applyEdits` and
  `add_citation` refuse a file that is not valid UTF-8** (`decodeUtf8Exact`, `src/lib/utf8.ts`:
  decoded text must re-encode to the same bytes; `FileService.readTextExact` for `add_citation`,
  uncapped and baseline-free): both rewrite the whole file, and a lossy decode turned every invalid
  byte of a Latin-1 file — not just the edited text — into U+FFFD. `write_file` is deliberately not
  held to it; it is the documented way to replace such a file.
- **`applyEdits` splices by index; it must never go back to `String.prototype.replace`.** A string
  _replacement_ argument is not literal — `replace` expands `$$`, `$&`, `` $` ``, `$'` and `$1` inside
  it — and LaTeX is full of literal `$`, so `content.replace(oldString, newString)` corrupts any
  `newString` carrying inline math (`$a$`, `$b$`) or a literal `$1`. It was doing so before
  preservation existed; preservation makes it worse, because the replacement is now generated
  server-side and the corruption lands in the block this feature calls byte-exact. The non-`replaceAll`
  path therefore splices at the already-computed `matchIndex` **unconditionally**, not only when a
  transform is present, and `replaceAll` splices each occurrence in turn at its own index (never
  `split`/`join`, which hides the per-occurrence offsets the preserved-range ledger has to be shifted by
  — see the bullet above). Reverting either to
  `replace` reads as a harmless simplification and is not one — a test pins it, with `$`-patterns in
  `newString` (`test/unit/editFile.test.ts`; `oldString` is matched with `indexOf`, where `$` was
  never special). The same rule binds test helpers that stand in for `applyEdits`:
  one that used `replace` made the whole unit layer structurally unable to catch this regression.
- **Out-of-band edits are guarded, and only the caller's reads arm the guard.** `FileService` holds a
  `FileRevisionTracker` (`src/services/fileRevisions.ts`) that hashes a file's bytes as the baseline for
  "what the server last saw". `write_file`/`edit_file`/`delete_file` refuse (throw `ExternalChangeError`)
  when the on-disk bytes changed since — the user editing the clone directly — unless
  `overrideExternalChanges: true`. `status` surfaces `externalChanges`. Baselines reset after
  `project_sync`/`discard` (`ctx.files.resetBaselines`), since those rewrite the tree.
  **`read`/`readText` record a baseline only when passed `recordBaseline: true`, and the default is
  false.** Recording is a claim that _the caller could now base a write on this file_, so record only
  when the caller asked for that file and got all of it: `read_file`, and `list_references` — the
  latter only for a bibliography whose **bytes** it returned whole (#171; `wholeSources`,
  `src/lib/referenceBaseline.ts`): every entry `bibtex`, none cut or dropped (by `maxResults`, a
  filter or a budget), and their `raw`s, in order, covering the file apart from ASCII whitespace. A
  `thebibliography`, a prose list, or a `.bib` with `@string`/`@comment` blocks or `%` comments holds
  text no entry carries, and claiming it let a later `write_file` overwrite a hand edit there without
  `ExternalChangeError`; a whitespace-only hand edit between entries is the accepted gap. Not "the bytes reached the caller" — a snippet's bytes do, and recording one is the bug this
  PR fixed. So: `detectRootFile` sniffing every `.tex` for `\documentclass` does not record (`compile`
  and the viewer's PDF poller both go through it); the five lines `compile`/`list_comments` fetch around
  a location the _log_ chose do not; `check_citations` does not, since it returns cite keys and line
  numbers and no content, and it scans _every_ document in the project. `add_citation` does not either:
  its read sits before the already-present early return, and a path that writes nothing must claim
  nothing — its write passes `overrideExternalChanges` instead, since what it writes is the bytes it just
  read plus one entry and so cannot lose a hand edit. That holds only because the read and the write
  share one lock: `add_citation` fetches the entry **outside** `runExclusive` (an `openalex:` key costs
  a DOI lookup plus a Crossref fetch, as long as a peer's whole lock wait), then resolves the `.bib`
  again, reads and writes it under the lock — never read outside and write inside. Wrong in the safe direction costs one refusal the
  caller can override; the other way silently destroys a user's hand edits, which is what the guard
  exists to prevent.
  **Two refinements keep the rule enforceable rather than merely stated.** A **ranged** read claims
  nothing — `FileService.read` refuses the claim whenever `startLine`/`endLine` is given (#181), and it
  refuses on the _request_, not on whether the range happened to cover the file: `startLine: 1` alone
  does return every byte, but deriving "whole" a second way is a second place to drift, and
  over-refusing costs one re-read while under-refusing destroys an edit. The enforcement sits in
  `FileService.read` and **not** in `read_file`, deliberately — the docstring there is where the rule
  reads as authoritative, which is exactly where it drifted, and a condition restated in the tool would
  be a second home for one rule. `read_file` still passes `recordBaseline: true`: the flag says this is
  the _kind_ of read that is eligible, never "record unconditionally". And
  `FileService.recordBaseline(projectDir, relPath, content, { strictLinks? })` records for bytes the
  caller **already holds** (#182), for the case `list_references` has: whether a file went over the wire
  whole is decided by the budgets and `wholeSources`, which run after every candidate has been read,
  so the claim cannot be made at read time. It closes a window as well as saving a read — re-reading absorbed a hand edit that
  landed between the two reads as the baseline, so the guard never fired for it. Its `strictLinks`
  defaults to **false**, like every read and unlike a server-initiative read: the seam records what a
  read just returned, so its link guard must agree with that read's, or it would refuse exactly the
  files a `followSymlinks: true` project's read allowed.
  **Every path resolves symlinks before acting** (`assertNoSymlinkEscape`): `resolveInside` compares
  strings, which a `notes.tex` pointing outside the clone defeats — and git stores a symlink as mode
  120000, so a collaborator can commit one. The check covers writes and deletes, not just reads, and a
  link whose target does not exist yet (which a write would create out there). It decides only _whether_
  a path may be used, never what the file is **called**: the `resolveInside` string stays its one
  identity, or the revision tracker files a baseline under a key the write never looks up — which is how
  the guard silently stopped firing on macOS (`/var` → `/private/var`) and Windows (8.3 short paths).
  **A link out is followed only where the project's owner said so** (`setLinkPolicy`, injected in
  `context.ts` from `ProjectManager.followsUserLinks`): `mode: 'local'` **plus** an explicit
  `followSymlinks: true` — from **every** id that resolves to that directory, failing closed
  (registration refuses a second id for a directory another project uses, so a shared one arises
  only from a hand-edited registry or env). It is an assertion, never an inference — who ran `git clone` says nothing
  about who placed a link, a directory registered in place is usually a working tree with a remote, and
  a pull can bring in a mode-120000 entry at any time. The layout it exists for is a shared `refs.bib`
  or `figs/` linked into each paper, so `walk` follows linked entries under the same flag (cycle-guarded
  by realpath): `list` skipping what `read` follows made the same project both follow and not follow its
  own links. The walk's **starting point** is judged too (`guardLinks` on `subdir`, for `list_files` and
  `search_files`): it guarded the entries under `subdir` but not `subdir` itself, so a link to the
  home directory passed as `subdir` listed it. A path the server picked up rather than the caller naming it passes `strictLinks: true` and
  is refused either way — every method takes the flag, so this stays honourable for a future
  server-initiative read _or_ write. And the guard does not stop at the read: a path the **document**
  named (a compile log, a synctex record) that leaves the project is not handed back as openable either
  (`unopenablePaths`/`withoutUnopenableLocation` in `src/lib/sourceSnippet.ts`, applied by `compile` to
  errors _and_ warnings and by `list_comments` to every comment) — otherwise the server refuses the read
  and then tells the caller they may make it. Withholding takes the **snippet** with the location (it is
  numbered against `line`), and the two reasons for withholding are counted apart: a path that escaped
  was resolved and found to leave; a path past `MAX_REPORTED_PATH_CHECKS` was never resolved at all.
  Never report the second as the first. `resolveThroughLinks` resolves a link's target in turn, too —
  stopping at the literal target let `notes.tex -> sub/pwned` through a linked `sub` pass the check and
  land outside. **A write through an in-project link is attributed to the link's target**
  (`attributedPath` in `FileService`, fed to the mutation recorder by `write`/`writeBytes`/
  `applyEdits`): the bytes land in the target, so the session's shadow must name the target, or the
  entry carries the link's HEAD blob (its target string) as base and three-way merges text against
  `"main.tex"` — a bogus `conflicted` on the link while the real edit is owned by nobody — and a
  dangling tracked link committed as a mode-120000 blob whose target string _was_ the new text.
  `delete` is attributed to the _parent resolved through links_ plus the literal final component
  (`attributedDeletePath`): `rm` of a link named `link.tex` removes the link, so that name stays; but
  `rm` of `linkdir/notes.tex` through a tracked `linkdir -> realdir` removes the real
  `realdir/notes.tex`, and recording it under the link's path filed a key git rejects ("beyond a
  symbolic link") — every later session commit failed on it, unrelated files included. The baseline key is
  untouched by this — identity for the revision tracker is still the `resolveInside` string; only the
  name the recorder is told changes. And `commitContents` refuses content for a path whose index mode
  is 120000 _unless `lstat` shows a regular file or ENOENT_ (still a link, or unstattable, is refused —
  fail closed), so no stale entry can produce that link-with-text blob again — the index was just reset to HEAD, so its mode says what HEAD has, not
  what the session did: a link the session `delete_file`d and `write_file`d over as a regular file is
  the typechange `git add` records without comment, and stages as `100644`.
- **The compile backend is preflighted, and only an _unchosen_ default is ever substituted.**
  `CompilerResolver` (`src/services/compilerResolver.ts`) calls `isAvailable()` before compiling —
  which nothing did until a user on a tectonic-only machine got a raw `spawn latexmk ENOENT` naming
  neither `WEB_LATEX_MCP_COMPILER` nor the backend on their PATH that would have worked. What licenses
  a substitution is **`config.compilerExplicit`, not availability**: an unset `WEB_LATEX_MCP_COMPILER`
  leaves `latexmk` a _default_, so a missing one may be swapped for whatever is installed — reported
  in the result's `hint`, never silently. **Missing means ENOENT and nothing else**: a backend on PATH
  that cannot run (EACCES, a broken shim) throws `UnrunnableCompilerError` from `probeOnPath`, which
  `select` lets propagate — it is never substituted, default or not, and the message names the
  backend, says no substitute was tried and why, and gives both ways to choose another (it used to
  surface as a bare `spawn latexmk EACCES`). An unrunnable _other_ backend is collected into
  `MissingCompilerError.unrunnable`, so when the needed backend is missing the message leads with it
  and names the unrunnable one after, never offering it as a retry. With `WEB_LATEX_MCP_COMPILER` set — to anything, `latexmk`
  included — the backend is an _assertion_, and a missing backend is an error; a per-call `compiler` argument is always an
  assertion. Same shape as `followSymlinks`: an assertion, never an inference. Derive both answers
  from one place (`parseCompilerChoice` in `src/config.ts`), or a whitespace-only env value makes
  `compiler` a default while `compilerExplicit` calls it a choice. Every refusal names what _is_
  installed (and never claims one when none is), both routes out (`compiler:` and the env var), and —
  when the substitute is tectonic — that it yields **no snippets at all**, because that is a silent
  behaviour change rather than an error: the fallback must not quietly undo the snippet guarantee the
  next bullet exists to make. `compile` returns the backend that actually ran as `compiler`;
  `server_info` reports only the _configured_ one and says so. **`doctor` grades the backend-dependent
  checks — `engines`, `distribution` (the TeX age warning) and `package-manager`, plus the TEXMF
  section's `tlmgr --usermode` hint — against the _effective_ backend, not the configured
  one, and only when that backend is actually installed** (`tectonicRuns`). An unrunnable configured
  backend is a `fail` ("compile will not fall back"), naming the other backend only if it is found;
  so is a missing one whose alternative is unrunnable. A substitutable missing backend is `warn`, not
  `fail` — `ok` means "nothing the server needs is missing", and under a working fallback nothing
  is. But `ok` is `every(status !== 'fail')`, so any _other_ check that fails silently overrides
  that grade: a tectonic machine has no engine and no `tlmgr` on PATH, and reporting either as a
  failure marked the exact setup this fallback exists to rescue as broken. Tectonic bundles its own
  XeTeX and fetches its own packages, so those are category errors, not findings — grade them
  against `effective` or the `warn` above is decorative.
- **An overlay compile builds a what-if variant in a link farm, and never writes the project.**
  `compile`'s `overlay` (`src/lib/variants.ts`) applies `edit_file`'s edits in memory
  (`applyEditsToContent`, the pure half of `FileService.applyEdits`, so both refuse the same edits)
  to files read through `readTextExact` — the project's link policy, **no baseline** — and compiles
  in `buildDir(dir)/variants/<handle>/src/`: a mirror of the project tree whose every file is a
  link to its absolute source path (a symlinked directory is ONE link, never walked; `.git`, the
  workspace and the build root are skipped; win32 uses junctions, hard links and copies), except
  the overlaid files, which are real files — an overlaid path under a linked directory
  materialises that directory first, so nothing is written through a link. The backend runs there
  (`CompileRequest.workDir`) into the variant's own `out/` (`outDir`). Not `TEXINPUTS`: kpathsea
  never searches the path for `./` or `../` names, so those inputs read the source. **The server
  never reads through the farm** — TeX reads what a normal compile would, so the farm adds no read
  surface; the only project files read are the overlaid ones — **except on win32**, where the
  farm's copy fallback does read files through the server: a file symlink is copied (a symlink
  needs a privilege there), and so is a file a hard link cannot reach (another drive than the temp
  dir) or a read-only one (a hard link shares its attributes, and deleting the farm would clear
  the source's read-only bit), all charged against `MAX_FARM_COPY_BYTES` (512 MiB). Two entries
  naming one file (a case variant, a hard link: judged by `lstat` dev+ino, after the platform's
  case fold) are refused, since only the second would reach the farm; and the variant's `.fls` (what the engine
  opened) and `.fdb_latexmk` (what latexmk's other rules read — biber's `.bib`) are checked after
  the compile, so an overlaid file the build never opened is named in `hint` rather
  than producing a variant silently identical to the main build. Nothing goes through FileService's
  write path (no shadow record, no baseline, no rewrite mode), and the surfaced PDF and the viewer
  are left alone. The handle is `v` + 12 hex of SHA-256 over root, engine, backend, shell-escape
  flags and the normalised overlay, so the same overlay reuses its `out/`; a caller-supplied handle
  is checked by `isVariantHandle` **before** any path join (`childPathInside`). After each overlay
  compile, under the lock, all but the `MAX_VARIANTS` (4) most recently compiled variants are removed
  (`rm -rf`, which unlinks a farm's links without following them), never the one just compiled. The
  PDF tools take `variant` and read that build only — its PDF, `.aux`/`.log` (`readAuxFloats`'
  `buildDir`) and its own `render/` — never falling back to the main build.
- **Source context is shown only where it can be vouched for.** `compile` attaches the 5 lines around
  each error (`src/lib/errorSnippets.ts`, over the shared `src/lib/sourceSnippet.ts` that `list_comments`
  uses too). Showing the wrong five lines under a `>` marker is worse than showing none, so a location
  earns its snippet only by clearing every one of these:
  - **The log named it outright** — `file` and `line` off one `-file-line-error` line
    (`ParsedDiagnostic.locatedPair`). A location pieced together from the balanced-paren file stack plus
    a nearby `l.<n>` is never shown: TeX elides a long line with `...`, which can drop an opening `(`,
    pop the stack, and land on a file whose line boilerplate (`\item`, `\end{itemize}`) corroborates.
    That is every diagnostic under **tectonic**, which passes no `-file-line-error` — it gets no
    snippets, by design.
  - **The path is one we open** — only source extensions, because the log is document-controlled
    (`\typeout` can forge a `file:line:` diagnostic naming any file).
  - **The line exists and the log does not contradict it.** TeX's `l.<n>` echo (`ParsedDiagnostic.echo`)
    is evidence _against_ a location, never for one, and a contradiction **sticks** — a co-located
    diagnostic carrying no echo cannot clear it, the same way a shadow-store collision stays flagged.
  - Paths are rebased onto the project root with `outcome.logBaseDir` first (latexmk gets `-cd`, so a
    document at `paper/main.tex` logs `./main.tex`) — **errors and warnings alike**, since every `file` a
    tool returns is one the caller can pass to `read_file`.

  Failing locations are counted into `omittedSnippetLocations`, never left as a silent gap, and they do
  not consume the 10-location cap (a log listing ten TeX-tree `.sty` paths first would otherwise starve
  the real error). `ParsedDiagnostic` lives in `logParser`, not `types.ts`: provenance decides what may
  be shown and never reaches a tool's output.

- **`compile`'s `warningsFilter` trims `logTail` and `warnings[]` together, or neither.** An
  `Overfull \hbox` ships **twice** — structured into `warnings[]`, and again raw in `logTail`, since
  `KEEP_PATTERNS` keeps box lines and `logTail` is returned on every compile — so a filter narrowing
  only `warnings[]` would leave every excluded line sitting in the tail: half the feature, reading as
  though it worked. `fitFilteredLog` takes a `keepWarning` predicate for exactly this (`filterLog` is
  that function with `maxChars: Infinity`), and `compile` builds **one** `judgeWarning` and hands it to
  both `shownWarnings.filter` and, through `planDiagnosticsPayload`'s `fitLogTail`, `keepWarning`, so the
  channels cannot disagree. That predicate applies `withoutUnopenableLocation` to its own candidate
  **first**: `logTail`'s side derives `file` from the log's paren stack, which knows nothing about a
  withheld path, so judging it directly let a `file` filter naming a withheld path empty
  `warnings[]` while leaving that warning in the tail. Matching is exact and literal — no globs, no
  prefixes, no case folding — for the same reason `--literal-pathspecs` is everywhere here: a typo
  must fail conspicuously. An **empty** array constrains nothing rather than matching nothing.
  Inside `fitFilteredLog`, `ALWAYS_KEEP_PATTERNS` is checked **before** `isWarningLine`/`warningRuleOf`,
  because a line can be both: the `Label(s) may have changed. Rerun to get cross-references right.`
  hint matches a warning pattern _and_ the rerun-hint pattern, and the hint must win. It holds
  `FILE_LINE_ERROR` too, mirroring `parseLog`'s branch order — `parseLog` tests it first and
  `continue`s, so a `-file-line-error` line is an error whatever its message says, and without it a
  `./main.tex:12: Package foo Warning: …` was an error to one partition and a filterable warning to
  the other. An error _phrase_ is pinned only where it starts an error-shaped line
  (`BARE_ERROR_LINE`: `LaTeX|Package <x>|Class <x> Error:` at line start, and never on a line
  `PACKAGE_WARNING` matches — the lookahead is built from that regex's own source so the two cannot
  drift): an unanchored `/Error:/` pinned `Package foo Warning: Error: …` in the tail while
  `excludeRule: ["foo"]` dropped it from `warnings[]`. Keep the two partitions aligned: a new `KEEP_PATTERNS` entry that is neither
  always-kept nor a warning line is a bug in waiting. **This is `logTail`-only, deliberately**: a
  rerun hint is still a structured warning, so `excludeRule: ['LaTeX']` still drops it from
  `warnings[]` and counts it in `warningsOmitted` — protected in the tail, filterable in the list.
  Do not "fix" that asymmetry; it changes what `warningsOmitted` means, not just its number.
  The raw-tail fallback must **never** fire when a _filter_ emptied the kept list: the raw tail is
  unfiltered and un-de-noised, so falling back hands back the very warnings `keepWarning` rejected
  plus the font/PDF-statistics noise `filterLog` exists to strip — the feature exactly inverted, and
  silently. `matchedBeforeFilter` is what tells "nothing diagnostic" from "the filter rejected
  everything"; keep them on separate branches. And **with `keepWarning` absent the output stays
  byte-identical and the paren-stack bookkeeping does not run at all** — not merely harmlessly —
  since this runs on every compile of every session; a differential test over generated logs pins
  it, in the strong form that a filter accepting everything is a no-op. **The tail is also bounded in
  characters**, since its 80 lines are un-wrapped logical lines and one `\PackageWarning` could carry
  hundreds of kilobytes: every tail line is cut at `LOG_TAIL_LINE_CAP` (500) with a marker — even at
  `maxChars: Infinity` — and `diagnosticsBudget.ts` charges the tail against the 20000-character
  diagnostics budget: errors first, then the tail and `warnings[]` (overlapping lanes) each guaranteed
  half of what is left, the tail dropping its earliest lines first and always keeping its last,
  cut further if need be but never below `LOG_TAIL_LAST_LINE_FLOOR` (80). The one error always kept
  has its `message` cut to fit too (`fitFirstError`, floor 500), never its `file`, `line` or `snippet`.
  So a warning-heavy build lists fewer warnings, still counted in `warningsOmittedByCap`.
  `rawLog: true` is neither cut nor charged.

- **Reading a PDF needs pdf.js; only rasterizing needs the canvas backend — keep those apart.**
  The Desktop extension's `.mcpbignore` once dropped pdf.js's Node build (`legacy/build/`, which the
  server imports as `PDFJS_SPECIFIER`) on the claim that nothing imported pdf.js in Node, and every PDF
  tool failed with `Cannot find module` while `doctor` blamed the canvas; `test/unit/mcpbignore.test.ts`
  pins what ships. pdf.js needs a `DOMMatrix` global merely to be imported, so when the native backend
  (`@napi-rs/canvas`, a per-platform binary the one-for-every-platform `.mcpb` cannot carry) does not
  load, `installDomMatrixStub` installs an inert class and everything but rasterizing works. The canvas
  probe (`createCanvasProbe`, which resolves the backend **from pdf.js's own location**) does not
  memoise a transient load failure (`TRANSIENT_LOAD_CODES`: EMFILE, ENOMEM, …, found by walking the
  `cause` chain), but once the stub is installed it pins "unavailable" for the life of the process,
  because pdf.js built its module-scope matrices over the stub. `render_pages` refuses inside
  `render()` before opening anything, and checks pdf.js loads **before** blaming the backend
  (`pdfjsUnavailableError` vs `nativeCanvasError`: the extension case, the npm install, restart the
  server) — a broken pdf.js otherwise read as "no canvas". `doctor`'s `pdf-render` asks both
  questions apart (`canReadPdf`, `canRasterize`), `warn` either way. **Every PDF tool reads the
  requested root's own build**: see `locateRootPdf`/`locateViewerPdf` under Architecture — the
  surfaced `<workspace>/<id>.pdf` holds whichever root compiled last, so a label resolved from one
  root's `.aux` rendered the other root's page. `compile`'s viewer hint says which build the viewer
  shows (`viewerShowsForCompile`: this build, only the surfaced copy, or another root), comparing
  build-PDF **paths** through `samePath`, whose case fold is by platform (win32, darwin) — a
  filesystem path, not a git name, so `core.ignorecase` is not the authority here. A clipped or
  re-scaled render is named `page-<n>-<hash>.png` (`pngName`: 12 hex of SHA-256 over the exact clip
  and `dpi`/`maxEdgePx`), because the rounded, scale-free name let two requests overwrite each other
  in the shared build dir and an earlier `pngPath` named the later image.
- **A `labels` lookup is believed only on evidence from the page itself.** Without `/PageLabels`
  (`src/lib/labelPages.ts`), the printed page from the `.aux` was used as the page index on the
  argument that nothing renumbered — but a `report` title page or `\setcounter{page}` shifts every
  page while each printed number stays plausible, and the wrong page came back with a note calling it
  correct. Now the printed page is only a **candidate**, accepted when that PDF page's own folio
  (`readFolios`) reads exactly it: a bare number on the last line, else a whole-line foot form
  (`FOOT_FORMS`: `Page N`, `N of M`, `Page N of M`, `N/M`, a number between equal dashes), which then
  **wins over the running head** — else the head, where two different readings are
  `ambiguousFolio`. The folio must be **corroborated** by a neighbour reading its own adjacent
  number (`uncorroboratedFolio`), because a fancyhdr `Page \thepage` foot, an eso-pic mark or a `[b]`
  table ending in a bare number made a section number or a table cell read as the folio; a one-page
  PDF is the exception, its only page being the only place a label can be. A label's own number is
  never consulted (an `article`'s single digits turn up on nearly every page). Whole documents are
  refused on this route when their arabic numbering **restarts** — a printed page that goes down in
  `.aux` order (`restarted`, every label, main paper included, since a supplement's folios confirm
  the main paper's pages as readily as its own) — or when the last PDF page reads a decimal page
  number other than the page count (`lastPageMismatch`: a restart, or a last page showing another
  number). A label **defined twice** is refused on either route (`multiplyDefined`), not resolved to
  its first record, which is not even the one LaTeX prints. **A beamer deck's tree is never used**: beamer labels each
  page with its frame number, which every overlay slide repeats, so a deck (recognised by
  line-anchored `\@writefile{nav}` records) always takes the folio route, where a footline printing
  `\insertpagenumber` resolves it. Do not reinstate "an identity tree whose length is
  `\beamer@documentpages`": `pgfpages` defeats it — `2 on 1` puts two slides on a sheet, and
  `resize to` (one slide per sheet) defers each shipout a page, so every `\label` records the next
  slide while the tree and the slide count match the PDF exactly (a release candidate shipped that
  rule and rendered the next slide for every label). The same shift fooled the folio route when
  the footline prints `\insertpagenumber` (each sheet shows its true slide), so a deck's label is refused first
  (`slideMismatch`) when its `\newlabel` page disagrees with beamer's own line-anchored
  `\@writefile{snm}{\beamer@slide {<label>}{<slide>}}` record (`AuxFloatsResult.beamerSlides`):
  `\newlabel` expands `\thepage` at shipout, beamer's record `\the\c@page` when the `\label` runs,
  so only a moved shipout separates them. Refuse on ANY disagreeing record, never accept on one — a
  forged record can then only add a refusal; an `allowframebreaks` label whose page was right is
  refused too, the accepted cost. A label with no record keeps the folio route. The record's key is
  matched with one level of braces (`SLIDE_FIELD`, as `readBraceGroup` reads a `\newlabel` key), so
  `fig:{a}` is checked rather than silently skipped.
  **Every label of a build that loaded `pgfpages` is refused first, on either route and in any
  class** (`pgfpagesLayout`): a `\pgfpagesuselayout` holds each page back a shipout, and the
  `/PageLabels` tree and the printed folios move with the `\newlabel` pages, so neither route can
  see the shift — an `article` under `resize to` rendered the next figure for every label, with or
  without `hyperref`. The evidence (`readPgfpagesEvidence`, `AuxFloatsResult.pgfpages`) is the
  build's `.fls` or `.log` naming `pgfpages.sty` or `pgfmorepages.sty` (a drop-in that holds pages
  back the same way without loading `pgfpages.sty`), read from the start only, `O_NOFOLLOW`,
  regular files only. It is tri-state and the three values must stay apart: `true` refuses; `false`
  means a record was read and names neither package; `undefined` means neither was readable, and
  **every label is refused too** (`pgfpagesUnknown`) — whether a layout shifted the build cannot be
  told, and a compile always leaves a `.log`, so this only fires when something removed or replaced
  the build's records; resolving there was the last silent-wrong-page path (#194). The tri-state
  stays in the reader; only the consumer treats `undefined` as a refusal. The `.log` is read even
  when a `.fls` exists, since a `.fls` left by an earlier recorder-on compile is stale. The log is
  document-controlled, which is acceptable only because `true` can only ADD a refusal — never let
  this evidence resolve a page. "Loaded" is wider than "layout in use" (the `.fls` even records a
  file merely opened by `\IfFileExists`); that over-refusal is accepted, since a layout-specific log
  line can be hidden by redefining `\wlog`, which errs the unsafe way; the refusal says the records
  name the file (never that a layout is in use) and that it is spurious for a load without
  `\pgfpagesuselayout` or a mere `\IfFileExists`. No label is exempted by name either — `lastpage`'s
  `LastPage` happens to be written unshifted, but a hand `\label{LastPage}` is not, and telling the
  two apart would need the same forgeable evidence used to accept; the refusal points at `pages:`
  with the page count instead. `slideMismatch` therefore runs only on `pgfpages === false`, and its
  advice is the `allowframebreaks` one. `pdf_geometry kinds: ["floats"]` does not refuse — the index
  is data the caller asked for, and its keys and numbers are true — but flags
  `floatsPagesShifted: true` with a note in both channels, and for `undefined` (an `.aux` read, no
  record beside it) carries a note that the pages could not be checked, without the flag.
  **Behind both routes, the `.log`'s shipout marks** (`[<\count0>…]`, one per page shipped;
  `readShipoutMarks`, `AuxFloatsResult.shipouts`, read only when a label lookup asks) refuse a
  resolved page (`unverifiedPage`/`shipoutMismatch`) unless that PDF page was shipped with the
  label's decimal printed page p as its counter and — on the folio route only, since roman front
  matter under hyperref repeats counters the tree tells apart — no other page shipped with p
  COMPETES: a counter is not a printed page, and an appendix under `\pagenumbering{alph}`/`{Roman}`
  or a supplement under `S\arabic{page}` ships 1, 2, … again while printing `a`, `I`, `S1`. So
  another page with mark p is let through only when its own text, read where `readFolios` looks,
  gives exactly one reading and that reading is a roman numeral, a letter run or a prefixed
  number (`printsOtherStylePage`); no reading, two readings, a missing text (`pagesToVerify` reads
  at most `MAX_AMBIGUOUS_CANDIDATES` such pages per label, only when the check will run) and **any
  decimal reading** keep it a competitor — a decimal is what a section number or table cell
  forges, so it never vouches. That rule only decides whether the marks ADD a refusal; it can
  never accept a page the route refused. The engine writes the marks and a document cannot remove
  one, but it can add one (`\message{[7]}`), so they are consulted only when their count equals
  the PDF's page count — any other length skips the check silently, and then the folio route's
  residual shapes pass as they did without it — and never resolve, move or accept a page. The
  parser skips the places TeX copies document text into the log: a whole box display (warning
  line through the next empty line; an output-routine warning, whose display shares its line, is
  a block of one line), a TeX error from its `file:line:` or `!` line through the next empty
  line, and, outside an error, only the FIRST line of a context pair (`l.<n> …`, `<argument> …`)
  — the line under it is read, because pdfTeX's duplicate-destination warning prints the next
  page's mark there. Real logs put every genuine mark after the skipped blocks. Known parse gaps,
  both of which only change the count and so switch the check off: a LaTeX/package-format error
  (`\GenericError` puts an empty line right after its first line, so the rest of its context and
  help is read), and a mark glued at column 0 onto a line wrapped at exactly 79 columns
  (`\batchmode` runs of `] [n]`, a truncated `...` context line), which `(?<!\S)\[` misses.
  Accepted residuals: an extra and a missed mark can line up to the right count and shift the
  list, which can refuse a correct label or fail to add a refusal it should (either way never
  worse than the route's own answer),
  and a section number opening a competing page (`A`, `S1` above an empty foot) can read as its
  page number and let a repeat through (back to the route's own answer). The log is opened after
  an `lstat` refuses a link, plus `O_NOFOLLOW` where it exists; on Windows a link planted between
  the two is followed, which is harmless only because the marks can do nothing but refuse.
  **Labels in `\include`d chapters** are found by following
  line-anchored `\@input` lines (`findBuildDirAux`): each name is looked up component by component
  in a `readdir` listing of the build dir, **never used as a path** (no symlinks, no `..`; re-checked at
  read with `lstat`/`realpath`), bounded in count (256), depth (8) and bytes; one differing from a
  listed entry only in case is **not read** and is reported as `caseMismatch` with the fix, and every
  unread input is named in `note` (`unreadInputs`). The documented residuals — two adjacent forgeries
  that each read as their own page, a number standing where the folio is looked for above an empty
  foot, a restart whose last page shows no number — stay listed in the module header; load `hyperref`
  (it writes `/PageLabels`) or pass `pages:` for an exact lookup.
- **Every document-controlled payload is budgeted, and the budget is charged against the RENDERED
  size in every channel it ships in.** Sixteen `src/lib/*Budget.ts` libs now solve the same problem —
  `conflictBudget.ts`, `floatsBudget.ts`, `searchBudget.ts`, `inlineBudget.ts`,
  `referenceFieldsBudget.ts`, `referenceRawBudget.ts`, `citationsBudget.ts`, `diffBudget.ts`,
  `fileListBudget.ts`, `commentsBudget.ts`, `diagnosticsBudget.ts`, `referenceTypedBudget.ts`,
  `statusBudget.ts`, `commitBudget.ts`, `extractTextBudget.ts`, `geometryBudget.ts` (plus
  `capUnshelveConflict` in `shelf.ts`, on `conflictBudget.ts`'s constants) — and
  they exist because of #68: a ~67k-character conflict payload a client rejected **undelivered**,
  which is worse than a cut one because the caller gets nothing and no reason. The rules they share
  are not stylistic:
  - **Charge what is rendered, not what is held.** The marker boilerplate, the JSON punctuation,
    the per-file headers and the elision text all cost bytes, and a payload that ships in both the
    text channel and `structuredContent` costs roughly twice its own length — `diff` did exactly
    that. A budget that counts the content once is wrong by 2x, and so is one that charges the
    _larger_ of the two channels — the caller receives their **sum** (`conflictBudget.ts` did this
    until its fourth round; `search_files` reached twice its budget the same way). The strongest form
    is to put the render template beside the cost function and have the cost function **call** it, so
    the two cannot drift (`diffBudget.ts`, `searchBudget.ts`'s `matchRenderCost`, `commitBudget.ts`,
    `extractTextBudget.ts`); where the template has to live elsewhere, pin the constant with
    a test that renders a known input and bounds it from **both** sides, or it can be padded into
    meaninglessness.
  - **Render the text channel from the already-cut payload**, never from the full one, or the
    channel that was supposed to be trimmed reintroduces the payload the budget exists to prevent —
    half the feature, reading as though it worked. `src/tools/searchFiles.ts` states this, and
    `extract_text` and `commit` follow it; `compile`'s `warningsFilter` is the same rule for `logTail`
    and `warnings[]`.
  - **Cut by declared priority, not in declaration order.** A single pool spent top-to-bottom cuts
    the finding that breaks the build because the advisory list ran first. Write the order down
    (`ALLOCATION_ORDER`, `hunks` before the sides) and say why each rank earns its place.
  - **Where the lanes OVERLAP, strict priority is the wrong reading of that rule** — guarantee every
    lane a share first, then spend the surplus in priority order (`statusBudget.ts`,
    `commentsBudget.ts`; `extractTextBudget.ts` — an equal share per page, the surplus in page order;
    `geometryBudget.ts` — water-filling across page × kind, crumbs in `ALLOCATION_ORDER`; and
    `diagnosticsBudget.ts`'s tail/warnings pair). The distinction is whether one cause can populate several lanes at once. In
    `status` it can: an untracked tree of 400 files lands in `untracked`, `otherChanges` AND
    `externalChanges` (an untracked file has no baseline, so `externalModifications` reports every
    one), so a single pool spent top-to-bottom gave lane 1 the whole budget and left the rest at the
    forced keep-at-least-one — 1 path of 400, which is the blowup shape the budget exists to prevent,
    merely inverted. A lane wanting less than its share releases the surplus upward, so the ordinary
    case — one big list, the rest small — still gives the big list nearly the whole budget; pin that
    with a test, or the guarantee quietly becomes an equal split nobody wanted. Where the lanes are
    genuinely disjoint (`fileListBudget.ts`, `diffBudget.ts`, `commitBudget.ts`), strict priority
    stays right.
  - **Count what was cut, never cut silently**, in the house shape (`…Omitted`, `omittedByCap`), and
    keep "cut" structurally unconfusable from "absent" — a `null` that means elided carries a
    matching `elided` entry, and `diff: ''` still means only that there is no diff.
  - **House figures**: 20 for a capped list (`capList`, `CONFLICT_MAX_FILES`), 20000 characters for a
    rendered content budget, 2000 for a merely diagnostic share. Reuse the constant rather than
    restating the number; a second allocation of the same figure is fine and is not a second number,
    but say why the pool is split.
  - **A cut changes what a field promises, so fix the prose too.** `raw` is documented as the entry
    verbatim and "authoritative when a field is doubtful"; once it can be cut, every sentence
    promising that — in the schema, in `referenceFieldsBudget.ts`, in `docs/tools.md` — is false
    until amended. The counter is the amendment's anchor.
  - **Every counter is a new `structuredContent` key, so every counter must be declared in the
    `outputSchema`** — see the tool-return-shape bullet. Adding a budget is the change most likely
    to make a tool uncallable.

- **`search_files` is bounded by a thread it can kill, not by the regex analyzer.** A regex `exec`
  cannot be interrupted, and the deadline was checked between files only, so one slow line held the
  server's only thread. A regex search now runs on **one worker thread per call**
  (`RegexScanWorker`, `src/lib/searchWorker.ts`), started on the first file actually scanned and
  **terminated at the deadline** (`SEARCH_TIME_BUDGET_MS`), mid-`exec` if need be; its source is an
  inline string run with `eval: true` so it resolves the same in `dist/`, the `.mcpb`, tsx and vitest
  (the cost: that code is not type-checked or linted), and it only returns each line's first match
  index — splitting, the scan cap, comments and the window stay on the main thread. A worker that
  errors or exits during a scan rejects: an error, never a partial answer presented as one. Progress
  under-claims (`WORKER_PROGRESS_MS`), and a cut file is counted in `filesPartiallySearched` and named
  in `note` with the line reached. A literal search never starts a worker; it checks the deadline
  **before every line** (`firstHits`' `expired`), since an escaped literal scans linearly. The
  analyzer (`assertLinearishRegex`, `src/lib/searchPattern.ts`) runs on every pattern, literals
  included — one path in, no trusted mode, and `MAX_PATTERN_CHARS` (500) applies to the raw pattern in
  both modes — and refuses a pattern whose **estimated** backtracking per line passes a fixed budget:
  rule 1, no group repeated without bound, and no repeated group that can match more than one way (a
  counted repeat of one, `(fig|tab){2}`, included; a backreference is never rigid); rule 2, no piece entered more than
  `MAX_AMBIGUITY_PRODUCT` times per starting position; rule 3, weighted steps within `MAX_CHAIN_WORK`
  scaled by how many places the pattern can start (`^` or leading written-out text narrows it) — with
  **arrivals** charging a nullable piece once per stop of every open choice point before it
  (`Piece.entry`), `loopHeavy` pricing a quantified capturing or nullable group's steps in full, and a
  **convergence floor** multiplying everything after a place where runs of a _bounded_ choice point
  converge; rule 4, the product of counted bounds. **Brackets must not earn acceptance**: the
  floor carries into and out of groups, and a group that closes a bounded choice point before it
  closes it there as the written-out spelling does — only when every alternative closes it and the
  group cannot be skipped (`closedWithin`), settling the bounded runs that re-entered it
  (`closesFirst`), since `absorbs` alone answers "some alternative" and survives a `?`. Inside a
  group body the enclosing sequence holds part of that record, so there it stays open and
  over-counts (`(?:\s?(\s*\\cite))(.*\\cite)` stays refused). A parity test compares bracketed and
  written-out counts; a bracketed form accepted where its written-out form is refused is a finding.
  Credits lower a choice point's factor only where
  the text proves the runs are kept apart: a written-out run's period, a **bridge** repeat that can
  match neither side of it, a **fence** letter the repeat cannot match, and an optional piece the next
  character decides (**optional-disjoint**). A lookbehind is judged reversed (V8 runs it right to
  left), Annex B escapes (`\01`, `\c` in a class) and — under `caseInsensitive` — case-fold partners
  (`caseFoldSample`) are judged by what they actually match, and `$` earns no trailing credit because
  a line can hold U+2028, which `.` does not match. A refusal names the constructs (with positions
  when two are written alike) and suggests a rewrite (`dropAdvice`: drop a leading or trailing `.*`
  — or, inside a lookaround, bound it, since dropping it would change what the lookaround asserts), with `regex: false` always the way out. **The estimate is not the
  bound — the worker's deadline is**: the slowest accepted patterns known reach about 3x the reference cost,
  and convergence from an _unbounded_ repeat is deliberately not floored. `ANALYZED_LINE_CHARS` (in
  `searchPattern.ts`, deliberately not an import) must equal `MAX_LINE_SCAN_CHARS`
  (`searchMatch.ts`) — a test asserts it — because the analyzer's range for an unbounded repeat _is_
  the line cap: raise the cap without the model and every accepted pattern's worst case grows with
  the square of the difference. `excludeComments` judges a hit by where the **match starts** (so a
  leading `.*` starts every hit at column 0), and a file with no `%` comment syntax is named in
  `note` instead of passing silently. The payload budget (`searchBudget.ts`) is charged on both
  channels.
- **Git auth is per-host and never persisted.** `CredentialResolver` (`src/services/auth.ts`) resolves a
  project's token by remote host (per-project `tokenEnv`/`username` override → host-default env → generic
  → `gh auth token` → `git credential fill`, cross-platform). Its subprocess runner is injectable for tests. Tools resolve it
  (`ctx.credentials.resolve(cfg)`) and pass the `AuthConfig` into `GitService` per call (`clone`,
  `syncPull`, `safePush`/`resolvePush`/`landBranch`, `resetToRemote`) — `GitService` holds no
  credential. **A token never touches `.git/config` or a command line**: every remote operation runs
  through `runRemoteGit`, which spawns git directly via `execCapture` (not simple-git), with the token
  and username only in the child's environment (`WEB_LATEX_MCP_GIT_TOKEN`/`_USERNAME`), read by an
  inline `!` credential helper (sh-form, so it runs on Git for Windows too, and it holds only variable
  names). `gitCredentialConfig` passes it as a process-scoped global `-c` keyed to the remote's own
  scheme and host — `credential.<scheme>://<host>.helper`, first **empty** (git's "reset the helper
  list", for that scheme and host only), then the inline helper — so for that host the user's own
  helpers are neither asked nor told (nothing is stored into their keychain, as when the token sat in
  the URL), while any other host (a submodule, an LFS store, a redirect) keeps them and never sees the
  token. Fetch, pull, push and clone used to write the token-bearing URL into `.git/config` for the
  length of the call (clone saved it as `origin` before fetching), so a kill mid-operation left it on
  disk; now `clone` clones **from** the tokenless URL and `origin` is tokenless from the first byte. A
  host outside `CREDENTIAL_HOST_RE` (`=`, `;`, `$`, `"`, …; `_` is allowed, for docker-compose names
  such as `git_server`) and a username or token holding CR, LF or NUL are refused before anything is
  sent. `index.ts` sets `GIT_TERMINAL_PROMPT=0` when it is unset (`??=`) so
  git fails fast rather than prompting; with no resolved token, git also falls through to its own
  credential helpers (e.g. `gh auth setup-git`). **A URL-embedded secret is stripped before anything
  is persisted, echoed or cloned** (`stripGitUrlCredentials`, `src/lib/gitUrlCredentials.ts`, applied in
  `ProjectManager.registerProject`, so `register_project` and `project_sync` with a `gitUrl`): the URL
  is trimmed first (whitespace defeated the `^` anchor), the scheme separator is any run of `/` and
  `\` or none (`https:/tok@h`, `https:\tok@h` and `https:tok@h` all parse with a userinfo), and the
  userinfo runs to the **last** `@`. `user:token@` keeps `user@` — a login name is not a secret, and
  the user's credential helpers look the credential up by it — unless `looksLikeToken` says the name
  itself is one, checked in this order: a known token prefix (`ghp_`, `glpat-`, `ATBB`, `hf_`, …) →
  token; an `@` in it (an email) → login; `+`, `=` or `/` (base64) → token; a name the URL already
  carries (`publishesName`: host labels case-insensitively, path segments exactly — Azure DevOps'
  `<org>@dev.azure.com/<org>/…`) → login; an AWS CodeCommit `<user>-at-<12 digits>` → login; 20 or
  more characters with a digit or mixed case → token. It errs toward removal. An env-configured or
  legacy URL is **not** stripped (only a registration is), so it is shown with the secret as `***`
  (`redactGitUrlCredentials`: `list_projects`, `push`'s `remote`, `set_credential`'s "no host"
  error), and `redact` scrubs userinfo to the last `@`, so no part of a password containing a raw
  `@` survives in an error.
- **Syncing is ff-only, and `push` never force-pushes.** `project_sync` (`GitService.syncPull`) is
  `fetch --prune` + `merge --ff-only origin/<branch>`, not `git pull`: divergence is reported
  (`action: 'diverged'`), never auto-merged. `push` (direct mode) pull-rebases onto the fetched remote
  and pushes; a push rejected as non-fast-forward is refetched and rebased again, up to
  `PUSH_RETRY_ROUNDS` (3), then reported as `remote-moved` with nothing pushed; branch mode rebases
  the feature branch and lands it with an ff-only merge, one attempt. Keep these guarantees. **Every
  explicit fetch prunes** (`fetchOrigin`; the implicit fetch inside `pull --rebase` does not): a stale
  `origin/<branch>` let a pinned `resolvePush` rebase onto a ghost and recreate a branch a
  collaborator had renamed away. So a missing upstream is decided first, in its own terms
  (`remoteBranchAbsence`): only a branch with a `branch.<b>.merge` upstream can be _missing_ — the
  never-pushed review branch `push` in branch mode leaves the clone on reports `syncState: "ahead"`
  — and then `project_sync` reports `remote-branch-missing` with a `note`, `status` reports
  `remoteBranchMissing`/`remoteBranchNote`, and local commits on no remote branch count as unpushed
  instead of the lenient count calling the clone up to date. `status` lists commits only with
  `withCommits: true` (the `status` tool alone; `commit`, `shelve` and the peer guard skip the logs),
  and with no `origin/<branch>` its `aheadCommits` is capped at 20 (`CONFLICT_MAX_COMMITS`) with
  `aheadCommitsOmitted`; the missing-branch note clips and escapes the remote branch names it lists.
- **Conflicts fail safe, then resolve through the tool — never auto-merge.** On a rebase conflict
  `push` aborts (clone back to pre-push state) and returns `status: 'conflict'` with a per-file
  payload (`base`/`ours`/`theirs` + marker `hunks`) plus
  `conflictPaths`/`remoteHead`/`remoteCommits`. This payload is rendered into the result **text**
  (`src/lib/conflictText.ts`), not only `structuredContent`, so an MCP-only client can resolve
  without a shell. The caller resolves by retrying `push` with `resolutions` (full merged content
  per file — used verbatim, applied _inside_ the rebase via add + `rebase --continue`); the set is
  validated (missing/extra files named), `expectedRemoteHead` guards against a moved remote, and
  `.bib` stays gated behind `confirmBibEdit`. **The pin is a commit SHA and nothing else** (trimmed,
  4–40 hex, checked before any commit or fetch): a ref name such as `origin/master` was resolved at
  check time, which pins nothing. And **it is checked against the one fetch the rebase then targets**:
  `resolvePush` fetches once, reads `origin/<branch>` once, prefix-matches the pin against that full
  SHA, and rebases onto **that SHA** (`rebase --fork-point --onto <sha> origin/<branch>`), never
  through a re-fetching `pull --rebase` — resolving used to fetch twice, so a commit landing between
  the two was rebased onto after the pin had passed, and the verbatim resolution overwrote it. A
  pinned push whose `origin/<branch>` is gone after the fetch is refused in words, and a pinned call
  gets one push round, not `PUSH_RETRY_ROUNDS`. `read_file` accepts a `ref` (e.g. `origin/<branch>`) to read `theirs` directly.
  Keep the merged text originating from the caller. **A resolution is file content, so a path that
  is a symlink on _either_ side of the conflict is refused** (rebase aborted, clone back to its
  pre-push state) — `resolvePush` checks `lstat` in the paused rebase _and_ the ours/theirs index
  stages (2/3) for mode 120000 (`hasLinkOnConflictSide`; a link only in the _base_ stage is one both
  sides already replaced with a file, an ordinary content conflict), inside `GitService`, because
  the link that matters is upstream's, materialised only by the paused rebase, which a pre-check in
  the tool against our HEAD cannot see. Before this, a collaborator's `notes.tex -> /outside` made a
  resolution write through the link into the outside file and then report nothing-to-push, and
  `notes.tex -> refs.bib` reached a `.bib` past the literal-name `confirmBibEdit` gate. A conflicted
  path that lies _under_ a working-tree symlink (`linkedAncestor`) is refused the same way: git itself
  never leaves a conflicted path beneath a link (a side that turns a directory into a link gets the
  file moved aside as an unmerged 120000 entry the stage check already refuses), but a link placed by
  hand while the rebase is paused would have `writeFile` follow it. Every exception raised inside the
  paused rebase — not only the deliberate refusals — aborts it before propagating, so a failed spawn
  never leaves the clone mid-rebase — including the priming rebase onto the pinned SHA (`runRebaseStep`) and
  `push`'s own attempt (`tryRebase`): both abort first when listing the unmerged paths fails, and
  `tryRebase` also when building the conflict report fails. `unmergedPaths` passes `-c core.quotePath=false` like every other
  path-returning git call: without it a conflict on `é.tex` came back C-quoted and could never be
  resolved by name.
  **The per-file payload is budgeted, not "full", by default** (`conflictDetail: 'auto'`,
  `src/lib/conflictBudget.ts`): a conflict on one large file once produced a ~67k-character result past a
  client's cap, undelivered — and a second round showed the budget itself has to be charged against
  RENDERED size (the `<<<<<<<`/`=======`/`>>>>>>>` marker boilerplate, the JSON punctuation around every
  hunk and array element, the per-file `━━━━━ path ━━━━━` header, the per-side label) or a conflict with
  many small hunks/files reproduces the same blowup with the content itself nowhere near the limit —
  `HUNK_MARKER_OVERHEAD`/`HUNK_JSON_OVERHEAD`/`HUNK_LINE_ELEMENT_OVERHEAD`/`FILE_HEADER_OVERHEAD`/
  `SIDE_LABEL_OVERHEAD`/`SIDE_ELISION_OVERHEAD`/`HUNK_ELISION_TEXT_OVERHEAD` name each piece (the last
  two are what an _elision_ itself costs — cutting is not free) and are pinned by tests that render a known input and check the
  constant still accounts for it, so `conflictText.ts`'s templates can't silently drift out from under
  them. A fourth round found every charge taking `Math.max(textCost, jsonCost)`, which bounds each
  channel alone and never what the caller receives: the per-file payload ships in **both**, so every
  charge is now `text + json`, the per-file scaffolding (`FILE_JSON_OVERHEAD`,
  `FILE_TEXT_LINE_BREAKS`, `HUNKS_BLOCK_TEXT_OVERHEAD`, the `null` a cut side still costs) is charged
  too, and the pointer that would replace each cuttable part is reserved before any content is
  admitted, so a cut can never overrun the budget that forced it. A conflict now inlines about half as
  much before eliding. `hunks` are allocated first (least recoverable once the rebase aborts, so cut last) and
  `base`/`ours`/`theirs` next (individually cap at `CONFLICT_SIDE_CAP`, cut first — recoverable in one
  `read_file(path, ref)` call). `CONFLICT_MAX_FILES` (20, matching `capList`'s house style) caps how many
  conflicted files ever get a detailed block at all — the rest stay fully named in the never-capped,
  never-elided `conflictPaths`, which is the one thing a caller needs in order to act. A part that doesn't
  fit comes back `null` with a matching `elided` entry (true size + how to fetch it); `null` with **no**
  `elided` entry keeps meaning what it always did — absent on that side (added/deleted) — and that
  distinction must never blur. The reported `note` names only whichever cap actually fired (per-side,
  aggregate, or file count), never a reason that didn't. `conflictDetail: 'full'` is the uncapped escape
  hatch, unchanged. Text and `structuredContent` are built from ONE plan object — `push.ts` plans once
  and hands the same object to `renderConflictText` and `buildConflictFilePayload`, which assert that
  the plan and the report line up file by file — so they can never disagree about what got cut. When
  the mandatory per-file headers alone exhaust the budget (long paths), the `note` says so first rather
  than blaming the aggregate cap. `remoteCommits` is bounded on a conflict result too — `CONFLICT_MAX_COMMITS`
  (20) commits of `CONFLICT_MAX_COMMIT_FILES` (5) files each, the caps the text channel already applied,
  with `remoteCommitsOmitted` and per-commit `filesOmitted` counting what was cut and the text pointing
  at `status.behindCommits` (uncapped, and identical once the rebase has aborted) instead of at
  `structuredContent`. `rebasedOver` on a successful push and `status`'s own commit lists stay uncapped
  while `origin/<branch>` exists (with it gone, `aheadCommits` is capped — see the sync bullet),
  and `renderCommitLines`'s default "(see structuredContent)" pointer stays true for them.
- **A pathspec handed to git is literal, never a glob.** Every `git add`, `ls-files`, `ls-tree`,
  `diff` (patch and numstat), `status --porcelain`, `show`, `revert`, `commit --only` (paths on stdin,
  NUL-separated) and `discard`'s `checkout`/`clean` call that takes a path the caller or
  a shadow named runs with `--literal-pathspecs` (the global option, _before_ the subcommand;
  `check-ignore --stdin` reads paths, not pathspecs, and needs none): without it `a[1].tex` is a glob that also matches `a1.tex`,
  and under `scope: "paths"` that staged a peer's dirty `a1.tex` past the ownership check, which had
  compared literal names. A new git call site that takes a path must carry the flag too. Callers see
  the same rule in the `paths` description: matched literally, no globs — so a `sections/*.tex` is
  never expanded: `scope: "paths"` refuses it in server words ("not changed in the working tree"),
  every route refuses a path that is neither on disk nor tracked in server words before `git add`
  sees it. `discard` **restores from HEAD, index and working tree in one write**
  (`checkout --no-overlay HEAD -- <paths>`, git ≥ 2.22; `reset -q --` on an unborn HEAD) over every
  path that covers a HEAD **or** index entry (resolved to that spelling on an ignorecase clone, or a
  case-spelled request would silently discard nothing) — it restored from the index, so a staged
  change survived under `discarded: true` — and runs `clean -f` over every requested path, so an
  untracked name is removed rather than tripping `checkout`; the whole-tree form is
  `checkout --no-overlay HEAD -- .` then `clean -fd`; and it settles only the named paths in every session's records (`ShadowStore.settleAll`)
  — `clearAll` is for the whole-tree discard alone, since dropping a peer's unrelated record is what
  lets a later `scope: "paths"` take its lines. **Both halves fold, and the report says what was
  actually reached.** The untracked half has no index entry to resolve against, so on an ignorecase
  clone it is resolved against the working tree's own untracked listing (`ls-files --others
--exclude-standard`) before `clean` sees it — every call keeps `--literal-pathspecs`, because
  `--icase-pathspecs` is mutually exclusive with it and buying the fold by reintroducing globbing in
  the most destructive call in the server is not a trade worth making. Before this the two halves
  disagreed: `discard(['notes.txt'])` restored a modified `Notes.txt` while `discard(['scratch.txt'])`
  left an untracked `Scratch.txt` on disk, and one call folded or not depending on something the
  caller could not see. A path git matched nothing for comes back in `missed` and, when the call
  reached nothing at all, `discarded: false` — `git clean -f` matching nothing exits 0, so the old
  unconditional `discarded: true` told the caller a file was gone while it was still there.
  `discarded` answers "did this reach the paths it was given", not "were bytes destroyed": a tracked
  path already at HEAD is reached and still reports discarded. **A `missed` path is still settled in
  every session's records, deliberately** — a path git can match nothing for is exactly the wedged
  shadow entry that `ignoredPaths`' refusal sends the caller to `discard` to clear, so narrowing the
  settle to reached paths would close that escape hatch. That makes `discarded: false` with records
  settled a visible asymmetry rather than an invisible one; keep it, and keep it written down.
- **`diff` takes a `ref` too, and it is not session-scoped.** `diff` accepts a commit-ish or exactly
  one two-dot `a..b` range (`GitService.resolveDiffRef` validates every endpoint up front, so an
  unknown ref is named rather than surfacing a raw git error, and a leading `-` is refused; a
  three-dot range, a second `..` or an empty end is refused in words rather than silently becoming a
  different comparison); `ref` + `staged` is rejected, not silently resolved. The patch the tool
  parses is forced plain
  (`PLAIN_PATCH_FLAGS`: `--no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/`), since a user's `color.ui=always`, `diff.external` or `diff.noprefix` changed
  it. History is shared across sessions even though `commit` isn't, so a ref diff
  spans peers' commits — it answers "what changed", never "what did I change". Say so wherever it is
  documented.
- **`tsconfig.json` needs `"types": ["node"]`** (TS 6 + @types/node 25 won't auto-load node globals otherwise).
- **verbatimModuleSyntax is on** — use `import type` for type-only imports; import paths carry `.js`.
- **Cross-platform (macOS/Linux/Windows).** Tool output paths are POSIX via `toPosix` (`src/lib/paths.ts`);
  clones force `core.autocrlf=false`. `execCapture` supports `input` (stdin) / `env`, sets
  `windowsHide`, and decodes stderr once, whole, so a multi-byte character split across two chunks is
  not two replacement characters. Anything that passes many paths in one invocation is batched by
  `chunkPathspecs` (Windows' command line), `shelve`/`unshelve`'s probes included; a contended rename
  on Windows is retried (`renameWithRetry`). The bare-repo test helper builds its `file://` URL with `pathToFileURL` (string-concatenated
  `file://C:\…` is invalid on Windows). CI runs the gate on ubuntu + windows + macos; keep new code and
  tests separator-agnostic.

## Testing strategy

- **Unit** tests mock nothing external — they use temp dirs and feed canned data (e.g. `logParser`
  against real LaTeX log snippets).
- **Integration** (`test/integration/`) runs real git against a **local bare repo** created by
  `helpers/bareRepo.ts` (a `file://` stand-in for the Overleaf remote) — **no network, no secrets**.
  What `file://` cannot exercise — credential injection — runs against `helpers/authHttpRemote.ts`, a
  local smart-HTTP `git http-backend` remote that demands Basic auth, still on loopback only.
  Branch is `master` to match Overleaf.
- **The compile boundary is the `LatexCompiler` interface** so nothing needs TeX except the smokes.
  `test/smoke/**` is gated on `latexmk` being installed (`describe.skipIf(!available)`), so it skips
  locally/in the fast CI job and runs in the dedicated `tex-smoke` CI job.
- Fixtures: `test/fixtures/sample-latex/` (a minimal project + `main-broken.tex` for error parsing).

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server (stdio transport) that lets an MCP client read, edit, compile, and commit LaTeX
in a git-hosted project (Overleaf, GitHub, or any git remote) — or compile and edit a plain local
directory in place. It manages local clones of one or more
projects, compiles locally with `latexmk`, and pushes changes back to the default branch. See
[README.md](README.md) for user-facing setup (env vars, Claude Desktop/Code registration, the full tool
list).

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
npx vitest run -t "refuses to push when behind"     # a single test by name
```

The full local gate before considering work done: `typecheck` + `lint` + `format:check` + `test`.

## Git workflow

**Before committing, always sync with the remote `main` and resolve any merge conflicts first** — so you
never clobber upstream work and conflicts surface early, not at push time:

```bash
git fetch origin
git rebase origin/main        # or: git merge origin/main
# resolve any conflicts, then re-run the full gate
```

- The default branch is `main`. Only commit once the working tree is in sync with `origin/main` and all
  conflicts are resolved.
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
  `references`) passed to every tool handler.
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
  `ShadowStore` (parallel sessions — see below), `logParser`, `auth`.

**Two kinds of project.** `ProjectConfig` is a union (`src/types.ts`): a **git** project (`gitUrl`,
cloned under the workspace) or a **local** one (`mode: 'local'`, `path` — a directory the user already
has, used in place). `mode` is optional on the git variant so every pre-existing env/registry entry
still parses. `ProjectManager.projectPath` returns the clone dir or the local dir accordingly, and
`requireProjectDir` (formerly `requireClonedDir`) requires `.git` for git projects and mere existence
for local ones. Git-backed tools call `ctx.projectManager.requireGitProject(id, action)` **first** and
refuse a local project — otherwise they would operate on whatever repository happens to contain the
user's directory. `src/lib/projectMode.ts` holds the narrowing helpers.

Project state: clones live under a workspace root (`WEB_LATEX_MCP_WORKSPACE`), one dir per project id.
When unset, the default is workspace-local — `<launch-dir>/.web_latex_mcp` (beside the agent's code;
git-excluded via the host repo's `.git/info/exclude` — `src/lib/workspaceExclude.ts`) — whenever the
launch dir is a git repo and not the home dir; otherwise it falls back to `~/.web-latex-mcp/projects`.
`WEB_LATEX_MCP_WORKSPACE=cwd` forces workspace-local; any other value is a path. The git-repo detection
(`resolveWorkspace` in `src/config.ts`) is injectable so tests stay hermetic. In workspace-local mode
`compile` also surfaces the PDF at `<workspace>/<id>.pdf` beside the clone (`src/lib/pdfSurface.ts`) —
build artifacts otherwise live in a temp dir. `ProjectManager` also supports runtime registration.

## Conventions that aren't obvious

- **stdout is the JSON-RPC channel.** Never `console.log` from server code — log to **stderr** only.
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
  `reset_to_remote`, and `read_file` with a `ref`, all guard with `requireGitProject`. The confirmation
  diff in `write_file`/`edit_file`/`add_citation` goes through `changeDiff` (`src/lib/changeDiff.ts`),
  which returns `''` for a local project rather than diffing the user's own repo. The shadow/session
  recorder in `context.ts` skips them too (no HEAD of ours to three-way merge against). Compiled PDFs
  are surfaced into the workspace, never beside the user's source — keep it that way: in-place means
  read and edit in place, not litter in place.
- **Mutating tools** (write/edit/delete/add_asset/commit/push/discard/revert/project_sync/add_citation)
  must run inside `ctx.projectManager.runExclusive(id, ...)` to serialize per project. Read-only tools don't —
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
  `runExclusive` is two layers: an in-process mutex **and** a lock file (`src/lib/fileLock.ts`), because
  sibling agent sessions are separate server processes over the same clone.
- **Parallel sessions share a clone; commits don't.** `WEB_LATEX_MCP_SESSION` names this process
  (`config.sessionId`). `ShadowStore` (`src/services/shadowStore.ts`) keeps, per touched file, a shadow
  holding `HEAD + only this session's edits`; `commit` stages that via `GitService.commitContents`
  (`read-tree --reset HEAD` + `hash-object` + `update-index`, never `git add`), so a peer's in-flight
  edits stay uncommitted in the working tree. The shadow is fed by `FileService.setMutationRecorder`
  (wired in `context.ts`) with the working-tree content **either side** of each write — it folds in the
  _change_, three-way merged, never the file the model happened to read, or peers' lines would leak in.
  After HEAD moves, `shadows.refresh(id, dir)` carries shadows forward (lazily, per session); tools that
  rewrite the whole tree (`discard`, `reset_to_remote`) call `shadows.clearAll(id)` instead. A same-line
  collision flags the entry `conflicted` and it **stays** flagged — never clear it on a later edit, since
  its base is stale and committing it would revert what landed. Shadows are stored as **bytes**, and an
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
  a `push` with `message` committed it, or a hand revert), `commit` settles those entries and returns
  `committed: false` with them under `settled`, rather than refusing and leaving the only way out an
  empty commit or a discard; a request covering nothing this session tracks still refuses as before.
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
  with its raw "Use -f" hint. When `core.ignorecase` is set, every by-name lookup against HEAD or
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
  `update-index --cacheinfo` win silently. `GitService.commit` with
  `paths` resolves each one to the index's spelling too, since a literal pathspec never folds. The flag is never cleared on an edit, and
  `refresh` never advances or settles an `unrecorded` entry (its shadow is known-incomplete); only a
  deliberate take or a discard ends that state. A conflicted entry's shadow and base are frozen, so
  its `refresh` verdict depends only on HEAD and the clean filter: `refresh` resolves HEAD's commit once per call
  (`GitService.headSha`, wired as the store's `HeadShaReader`) and **skips a conflicted entry whose
  `conflictHead` is that commit** — otherwise every `status`/`commit`/`push` re-merged and re-hashed
  (two `git hash-object` spawns) each permanently conflicted asset, forever. The memo never clears a
  flag; a HEAD move re-evaluates in full, and an entry without the field (older index, or a
  `record`-time collision) is evaluated once and then memoised. A `.gitattributes` edit that has not
  reached HEAD can leave a memo stale, and that is accepted: a stale memo can only keep a flag,
  never clear one.
- **`revert` settles the reverted paths in every session, then records them as this session's.**
  A revert lands changes in the working tree that no session authored, so it is the one write whose
  ownership has to be decided rather than observed. It is **not** `clearAll`: a revert is inherently
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
  equals HEAD for every touched path, so HEAD's bytes _are_ the pre-revert content. Baselines are
  reset the way `discard` resets them (`ctx.files.resetBaselines(dir)`), or the next `edit_file` on a
  reverted path would throw `ExternalChangeError` for a change the server itself made; that call is
  dir-wide, so it also drops the out-of-band-edit claim for files the revert never touched — an
  accepted over-reset, not an oversight, since `FileService` has no per-path variant.
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
  `livePeers()` — so this is diagnostic loss only.
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
  leading run of line-anchored entries and `fetchBibtex` returns that slice, so neither a proxy
  banner in front nor a `<script>` behind reaches a bibliography — while a body whose braces
  never balance **fails open** — the span runs to the end of the text, so nothing after the
  entry is cut — because a truncated entry is worse than an untidy one. Choosing a cut point in the service's bytes is allowed; inserting, reordering,
  reformatting or completing them is not, and that is the whole line. Record keys are
  namespaced (`dblp:conf/cvpr/HeZRS16`, `crossref:10.1109/CVPR.2016.90`, `openalex:W2194775991`)
  and parsed in one pure module, `src/lib/referenceKey.ts`, whose validation is a **security
  boundary** rather than a convenience: every id it returns is interpolated into a request URL
  path, so it never returns a partially-validated value, and a key the server _emits_ must
  re-parse to the same record. `WEB_LATEX_MCP_CONTACT_EMAIL` (Crossref's and OpenAlex's polite
  pool) is opt-in only — never derived from `git config user.email` — and `server_info` reports
  only _whether_ one is set, never the address.

- **A bibliography is not always a `.bib`.** `src/lib/references.ts` parses references out of three
  shapes — BibTeX (`@string` macros resolved), a LaTeX `thebibliography` of `\bibitem`s, and a prose
  reference list in a markdown/plain-text document — behind one `ReferenceEntry`. Every entry carries its
  `format` and its verbatim `raw`, because only `bibtex` fields are exact; the prose extractor
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
  sets, so only it needs to name two projects.

- **`.bib` files are guarded.** `write_file`/`edit_file`/`delete_file` reject a `.bib` target
  (`isBibFile`, `src/lib/bib.ts`) unless `confirmBibEdit: true` — keep this. The sanctioned write path
  is `add_citation`, which re-fetches BibTeX from the issuing bibliography service server-side so entry
  text never originates from the model. The guard lives in the tool layer, so `add_citation` writing via `FileService` is intentionally
  not blocked. It judges the **link-resolved** name too (`FileService.linkTarget` — symlinks only: a hard
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
  itself stays unchanged and keeps writing only to `ctx.config.extraWritingGuidePath`, never a
  caller-named path.
- **`add_asset` is the one _read_ from outside every project sandbox, and it is gated on both ends.**
  `sourcePath` names a file on the machine running the server, by design outside every sandbox, so
  `resolveInside` cannot apply; what makes the read accountable is the asset-extension allowlist
  (`src/lib/assets.ts`) checked on **both** sides: the destination first (before anything is read), the
  source's own name before any syscall, and the source again on its **realpath'd** target, so a symlink
  named `photo.png` pointing at an extensionless secret is judged on where it lands. The first
  implementation gated only the destination and was an arbitrary-file-read primitive
  (`sourcePath: "/etc/passwd"` → `figures/innocent.png`, echoed back by the confirmation diff), which is
  why `add_asset` deliberately returns **no diff** and why every syscall outcome on the source collapses
  to found / not-found / unresolvable with no errno text. Widen `ASSET_EXT` only for a genuine figure
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
  rejects it first as a no-op), so there is no risk of the hook turning it into `old` vs.
  `"% " + old + old` — a wrapping pass running _before_ that guard would silently disarm it. Two
  more restrictions on when preservation actually fires, both easy to miss because they read as
  "preserve every edit" from the mode name alone: **only a line-aligned match is ever preserved**
  — `oldString` must start at the beginning of a line and end at the end of one (in the file's
  current content, or by ending with its own trailing newline), because a mid-line match has no
  safe place to put a `%`-comment without swallowing or reflowing text that was never part of
  `oldString`; and **a `replaceAll` edit is never preserved**, since there is no single match
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
  pure integer offsets and learns nothing about `%`. The two halves — the hook and its ranges — are one
  option for that reason: passing a hook without its ranges silently restored the bug, so the type must
  not permit it.
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
  both `oldString` and `newString`. The same rule binds test helpers that stand in for `applyEdits`:
  one that used `replace` made the whole unit layer structurally unable to catch this regression.
- **Out-of-band edits are guarded, and only the caller's reads arm the guard.** `FileService` holds a
  `FileRevisionTracker` (`src/services/fileRevisions.ts`) that hashes a file's bytes as the baseline for
  "what the server last saw". `write_file`/`edit_file`/`delete_file` refuse (throw `ExternalChangeError`)
  when the on-disk bytes changed since — the user editing the clone directly — unless
  `overrideExternalChanges: true`. `status` surfaces `externalChanges`. Baselines reset after
  `project_sync`/`discard` (`ctx.files.resetBaselines`), since those rewrite the tree.
  **`read`/`readText` record a baseline only when passed `recordBaseline: true`, and the default is
  false.** Recording is a claim that _the caller could now base a write on this file_, so record only
  when the caller asked for that file and got all of it: `read_file`, and `list_references` (every entry
  verbatim). Not "the bytes reached the caller" — a snippet's bytes do, and recording one is the bug this
  PR fixed. So: `detectRootFile` sniffing every `.tex` for `\documentclass` does not record (`compile`
  and the viewer's PDF poller both go through it); the five lines `compile`/`list_comments` fetch around
  a location the _log_ chose do not; `check_citations` does not, since it returns cite keys and line
  numbers and no content, and it scans _every_ document in the project. `add_citation` does not either:
  its read sits before the already-present early return, and a path that writes nothing must claim
  nothing — its write passes `overrideExternalChanges` instead, since what it writes is the bytes it just
  read plus one entry and so cannot lose a hand edit. Wrong in the safe direction costs one refusal the
  caller can override; the other way silently destroys a user's hand edits, which is what the guard
  exists to prevent.
  **Every path resolves symlinks before acting** (`assertNoSymlinkEscape`): `resolveInside` compares
  strings, which a `notes.tex` pointing outside the clone defeats — and git stores a symlink as mode
  120000, so a collaborator can commit one. The check covers writes and deletes, not just reads, and a
  link whose target does not exist yet (which a write would create out there). It decides only _whether_
  a path may be used, never what the file is **called**: the `resolveInside` string stays its one
  identity, or the revision tracker files a baseline under a key the write never looks up — which is how
  the guard silently stopped firing on macOS (`/var` → `/private/var`) and Windows (8.3 short paths).
  **A link out is followed only where the project's owner said so** (`setLinkPolicy`, injected in
  `context.ts` from `ProjectManager.followsUserLinks`): `mode: 'local'` **plus** an explicit
  `followSymlinks: true`. It is an assertion, never an inference — who ran `git clone` says nothing
  about who placed a link, a directory registered in place is usually a working tree with a remote, and
  a pull can bring in a mode-120000 entry at any time. The layout it exists for is a shared `refs.bib`
  or `figs/` linked into each paper, so `walk` follows linked entries under the same flag (cycle-guarded
  by realpath): `list` skipping what `read` follows made the same project both follow and not follow its
  own links. A path the server picked up rather than the caller naming it passes `strictLinks: true` and
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
  in the result's `hint`, never silently. Set — to anything, `latexmk` included — it is an
  _assertion_, and a missing backend is an error; a per-call `compiler` argument is always an
  assertion. Same shape as `followSymlinks`: an assertion, never an inference. Derive both answers
  from one place (`parseCompilerChoice` in `src/config.ts`), or a whitespace-only env value makes
  `compiler` a default while `compilerExplicit` calls it a choice. Every refusal names what _is_
  installed (and never claims one when none is), both routes out (`compiler:` and the env var), and —
  when the substitute is tectonic — that it yields **no snippets at all**, because that is a silent
  behaviour change rather than an error: the fallback must not quietly undo the snippet guarantee the
  next bullet exists to make. `compile` returns the backend that actually ran as `compiler`;
  `server_info` reports only the _configured_ one and says so. **`doctor` grades the backend-dependent
  checks — `engines` and `package-manager` — against the _effective_ backend, not the configured
  one, and only when that backend is actually installed.** A substitutable missing backend is `warn`, not
  `fail` — `ok` means "nothing the server needs is missing", and under a working fallback nothing
  is. But `ok` is `every(status !== 'fail')`, so any _other_ check that fails silently overrides
  that grade: a tectonic machine has no engine and no `tlmgr` on PATH, and reporting either as a
  failure marked the exact setup this fallback exists to rescue as broken. Tectonic bundles its own
  XeTeX and fetches its own packages, so those are category errors, not findings — grade them
  against `effective` or the `warn` above is decorative.
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
  though it worked. `filterLog` takes a `keepWarning` predicate for exactly this, and `compile`
  builds **one** `judgeWarning` and hands it to both `shownWarnings.filter` and `keepWarning`, so the
  channels cannot disagree. That predicate applies `withoutUnopenableLocation` to its own candidate
  **first**: `logTail`'s side derives `file` from the log's paren stack, which knows nothing about a
  withheld path, so judging it directly let a `file` filter naming a withheld path empty
  `warnings[]` while leaving that warning in the tail. Matching is exact and literal — no globs, no
  prefixes, no case folding — for the same reason `--literal-pathspecs` is everywhere here: a typo
  must fail conspicuously. An **empty** array constrains nothing rather than matching nothing.
  Inside `filterLog`, `ALWAYS_KEEP_PATTERNS` is checked **before** `isWarningLine`/`warningRuleOf`,
  because a line can be both: the `Label(s) may have changed. Rerun to get cross-references right.`
  hint matches a warning pattern _and_ the rerun-hint pattern, and the hint must win. It holds
  `FILE_LINE_ERROR` too, mirroring `parseLog`'s branch order — `parseLog` tests it first and
  `continue`s, so a `-file-line-error` line is an error whatever its message says, and without it a
  `./main.tex:12: Package foo Warning: …` was an error to one partition and a filterable warning to
  the other. Keep the two partitions aligned: a new `KEEP_PATTERNS` entry that is neither
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
  it, in the strong form that a filter accepting everything is a no-op.

- **Every document-controlled payload is budgeted, and the budget is charged against the RENDERED
  size in every channel it ships in.** Thirteen libs now solve the same problem —
  `conflictBudget.ts`, `floatsBudget.ts`, `searchBudget.ts`, `inlineBudget.ts`,
  `referenceFieldsBudget.ts`, `referenceRawBudget.ts`, `citationsBudget.ts`, `diffBudget.ts`,
  `fileListBudget.ts`, `commentsBudget.ts`, `diagnosticsBudget.ts`, `referenceTypedBudget.ts`,
  `statusBudget.ts` — and
  they exist because of #68: a ~67k-character conflict payload a client rejected **undelivered**,
  which is worse than a cut one because the caller gets nothing and no reason. The rules they share
  are not stylistic:
  - **Charge what is rendered, not what is held.** The marker boilerplate, the JSON punctuation,
    the per-file headers and the elision text all cost bytes, and a payload that ships in both the
    text channel and `structuredContent` costs roughly twice its own length — `diff` did exactly
    that. A budget that counts the content once is wrong by 2x. The strongest form is to put the
    render template beside the cost function and have the cost function **call** it, so the two
    cannot drift (`diffBudget.ts`); where the template has to live elsewhere, pin the constant with
    a test that renders a known input and bounds it from **both** sides, or it can be padded into
    meaninglessness.
  - **Render the text channel from the already-cut payload**, never from the full one, or the
    channel that was supposed to be trimmed reintroduces the payload the budget exists to prevent —
    half the feature, reading as though it worked. `searchFiles.ts` states this; `compile`'s
    `warningsFilter` is the same rule for `logTail` and `warnings[]`.
  - **Cut by declared priority, not in declaration order.** A single pool spent top-to-bottom cuts
    the finding that breaks the build because the advisory list ran first. Write the order down
    (`ALLOCATION_ORDER`, `hunks` before the sides) and say why each rank earns its place.
  - **Where the lanes OVERLAP, strict priority is the wrong reading of that rule** — guarantee every
    lane a share first, then spend the surplus in priority order (`statusBudget.ts`,
    `commentsBudget.ts`). The distinction is whether one cause can populate several lanes at once. In
    `status` it can: an untracked tree of 400 files lands in `untracked`, `otherChanges` AND
    `externalChanges` (an untracked file has no baseline, so `externalModifications` reports every
    one), so a single pool spent top-to-bottom gave lane 1 the whole budget and left the rest at the
    forced keep-at-least-one — 1 path of 400, which is the blowup shape the budget exists to prevent,
    merely inverted. A lane wanting less than its share releases the surplus upward, so the ordinary
    case — one big list, the rest small — still gives the big list nearly the whole budget; pin that
    with a test, or the guarantee quietly becomes an equal split nobody wanted. Where the lanes are
    genuinely disjoint (`fileListBudget.ts`, `diffBudget.ts`), strict priority stays right.
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

- **Git auth is per-host and never persisted.** `CredentialResolver` (`src/services/auth.ts`) resolves a
  project's token by remote host (per-project `tokenEnv`/`username` override → host-default env → generic
  → `gh auth token` → `git credential fill`, cross-platform). Its subprocess runner is injectable for tests. Tools resolve it
  (`ctx.credentials.resolve(cfg)`) and pass the `AuthConfig` into `GitService.clone/syncPull/push` per
  call — `GitService` holds no credential. It's injected in-memory and `clone` resets origin to the
  tokenless URL; never write credentials into `.git/config`. `index.ts` sets `GIT_TERMINAL_PROMPT=0` so
  git fails fast rather than prompting; with no resolved token, git also falls through to its own
  credential helpers (e.g. `gh auth setup-git`).
- **`git pull` is ff-only.** Divergence is reported (`action: 'diverged'`), never auto-merged. `push`
  refuses when behind. Keep this guarantee.
- **Conflicts fail safe, then resolve through the tool — never auto-merge.** On a rebase conflict
  `push` aborts (clone back to pre-push state) and returns `status: 'conflict'` with a per-file
  payload (`base`/`ours`/`theirs` + marker `hunks`) plus
  `conflictPaths`/`remoteHead`/`remoteCommits`. This payload is rendered into the result **text**
  (`src/lib/conflictText.ts`), not only `structuredContent`, so an MCP-only client can resolve
  without a shell. The caller resolves by retrying `push` with `resolutions` (full merged content
  per file — used verbatim, applied _inside_ the rebase via add + `rebase --continue`); the set is
  validated (missing/extra files named), `expectedRemoteHead` guards against a moved remote (compare
  full SHAs — abbreviated input is `rev-parse`d first), and `.bib` stays gated behind
  `confirmBibEdit`. `read_file` accepts a `ref` (e.g. `origin/<branch>`) to read `theirs` directly.
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
  never leaves the clone mid-rebase — including the priming `pull --rebase` (`runRebaseStep`) and
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
  them. `hunks` are allocated first (least recoverable once the rebase aborts, so cut last) and
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
  `structuredContent`. `rebasedOver` on a successful push and `status`'s own commit lists stay uncapped,
  and `renderCommitLines`'s default "(see structuredContent)" pointer stays true for them.
- **A pathspec handed to git is literal, never a glob.** Every `git add`, `ls-files`, `ls-tree`,
  `diff` (patch and numstat) and `discard`'s `checkout`/`clean` call that takes a path the caller or
  a shadow named runs with `--literal-pathspecs` (the global option, _before_ the subcommand;
  `check-ignore --stdin` reads paths, not pathspecs, and needs none): without it `a[1].tex` is a glob that also matches `a1.tex`,
  and under `scope: "paths"` that staged a peer's dirty `a1.tex` past the ownership check, which had
  compared literal names. A new git call site that takes a path must carry the flag too. Callers see
  the same rule in the `paths` description: matched literally, no globs — so a `sections/*.tex` is
  never expanded: `scope: "paths"` refuses it in server words ("not changed in the working tree"),
  every route refuses a path that is neither on disk nor tracked in server words before `git add`
  sees it. `discard` with `paths` checks out only the tracked subset (resolved to the index's
  spelling on an ignorecase clone, or a case-spelled request would silently discard nothing) and
  runs `clean -f` over every requested path, so an untracked name is removed rather than tripping
  `checkout`; and it settles only the named paths in every session's records (`ShadowStore.settleAll`)
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
- **`diff` takes a `ref` too, and it is not session-scoped.** `diff` accepts a commit-ish or an `a..b`
  range (`GitService.resolveDiffRef` validates every endpoint up front, so an unknown ref is named
  rather than surfacing a raw git error, and a leading `-` is refused); `ref` + `staged` is rejected,
  not silently resolved. History is shared across sessions even though `commit` isn't, so a ref diff
  spans peers' commits — it answers "what changed", never "what did I change". Say so wherever it is
  documented.
- **`tsconfig.json` needs `"types": ["node"]`** (TS 6 + @types/node 25 won't auto-load node globals otherwise).
- **verbatimModuleSyntax is on** — use `import type` for type-only imports; import paths carry `.js`.
- **Cross-platform (macOS/Linux/Windows).** Tool output paths are POSIX via `toPosix` (`src/lib/paths.ts`);
  clones force `core.autocrlf=false`. `execCapture` supports `input` (stdin) / `env` and sets
  `windowsHide`. The bare-repo test helper builds its `file://` URL with `pathToFileURL` (string-concatenated
  `file://C:\…` is invalid on Windows). CI runs the gate on ubuntu + windows + macos; keep new code and
  tests separator-agnostic.

## Testing strategy

- **Unit** tests mock nothing external — they use temp dirs and feed canned data (e.g. `logParser`
  against real LaTeX log snippets).
- **Integration** (`test/integration/`) runs real git against a **local bare repo** created by
  `helpers/bareRepo.ts` (a `file://` stand-in for the Overleaf remote) — **no network, no secrets**.
  Branch is `master` to match Overleaf.
- **The compile boundary is the `LatexCompiler` interface** so nothing needs TeX except the smokes.
  `test/smoke/**` is gated on `latexmk` being installed (`describe.skipIf(!available)`), so it skips
  locally/in the fast CI job and runs in the dedicated `tex-smoke` CI job.
- Fixtures: `test/fixtures/sample-latex/` (a minimal project + `main-broken.tex` for error parsing).

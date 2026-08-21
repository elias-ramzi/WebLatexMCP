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
  `dblp`) passed to every tool handler.
- `src/tools/*` — one file per tool: a zod `inputSchema`/`outputSchema` + a handler that calls services.
- `src/prompts/skills.ts` — registers each bundled skill (`.claude/skills/*/SKILL.md`, loaded by
  `src/lib/skills.ts`) as an MCP prompt, so clients that don't read `.claude/skills` (Claude Desktop,
  Cursor) can still run them. Add a skill by adding its directory — no code change.
- `src/services/*` — the core: `ProjectManager` (id→dir resolution, per-project mutex **+
  cross-process lock**, dynamic registration), `GitService` (simple-git wrapper), `FileService`
  (sandboxed fs), `LatexmkCompiler` (implements the `LatexCompiler` interface), `DblpService` (DBLP
  search + canonical BibTeX fetch, with an injectable `fetch` for tests), `SessionRegistry` +
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
- **Local projects never see git.** `status`/`diff`/`commit`/`push`/`discard`/`project_sync`/
  `reset_to_remote`, and `read_file` with a `ref`, all guard with `requireGitProject`. The confirmation
  diff in `write_file`/`edit_file`/`add_citation` goes through `changeDiff` (`src/lib/changeDiff.ts`),
  which returns `''` for a local project rather than diffing the user's own repo. The shadow/session
  recorder in `context.ts` skips them too (no HEAD of ours to three-way merge against). Compiled PDFs
  are surfaced into the workspace, never beside the user's source — keep it that way: in-place means
  read and edit in place, not litter in place.
- **Mutating tools** (write/edit/delete/commit/push/discard/clone/add_citation) must run inside
  `ctx.projectManager.runExclusive(id, ...)` to serialize per project. Read-only tools don't.
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
  its base is stale and committing it would revert what landed. State lives in
  `<workspace>/.sessions/<projectId>/` (`src/lib/sessionPaths.ts`), outside the clones. Keep this: the
  guarantee is that a commit contains one session's lines and nobody else's.
- **A bibliography is not always a `.bib`.** `src/lib/references.ts` parses references out of three
  shapes — BibTeX (`@string` macros resolved), a LaTeX `thebibliography` of `\bibitem`s, and a prose
  reference list in a markdown/plain-text document — behind one `ReferenceEntry`. Every entry carries its
  `format` and its verbatim `raw`, because only `bibtex` fields are exact; the prose extractor
  deliberately under-claims (a `title` only when the text delimits it, authors only before a
  parenthesized year) so a wrong guess never sends a DBLP lookup after the wrong paper. `list_references`
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
    separate, permissioned act, because the `.bib` guard and "entry text originates from DBLP" both
    depend on that staying narrow.
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
  is `add_citation`, which re-fetches BibTeX from DBLP server-side so entry text never originates from the
  model. The guard lives in the tool layer, so `add_citation` writing via `FileService` is intentionally
  not blocked.
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
  **Whose link it is decides whether it is followed** (`setLinkPolicy`, injected in `context.ts` from
  `ProjectManager.isLocalDir`). A clone is shared, so a link in it may be anyone's and is refused. A
  `mode: 'local'` project is a directory the user registered in place and owns, so a link they put there
  — one shared `refs.bib` symlinked into each paper is an ordinary layout — is followed. A path the
  server picked up rather than the caller naming it passes `strictLinks: true` and is refused either way;
  that is every read behind `compile`'s and `list_comments`' snippets, whose paths come from a
  document-controlled log or synctex record. Keep that opt-in on any future server-initiative read.
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
- **Conflicts fail safe, then resolve through the tool — never auto-merge.** On a rebase conflict `push`
  aborts (clone back to pre-push state) and returns `status: 'conflict'` with a full 3-way payload per
  file (`base`/`ours`/`theirs` + marker `hunks`) plus `conflictPaths`/`remoteHead`/`remoteCommits`. This
  payload is rendered into the result **text** (`src/lib/conflictText.ts`), not only `structuredContent`,
  so an MCP-only client can resolve without a shell. The caller resolves by retrying `push` with
  `resolutions` (full merged content per file — used verbatim, applied _inside_ the rebase via add +
  `rebase --continue`); the set is validated (missing/extra files named), `expectedRemoteHead` guards
  against a moved remote (compare full SHAs — abbreviated input is `rev-parse`d first), and `.bib` stays
  gated behind `confirmBibEdit`. `read_file` accepts a `ref` (e.g. `origin/<branch>`) to read `theirs`
  directly. Keep the merged text originating from the caller.
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

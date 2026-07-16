# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server (stdio transport) that lets an MCP client read, edit, compile, and commit LaTeX
in a git-hosted project (Overleaf, GitHub, or any git remote). It manages local clones of one or more
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
  (when `WEB_LATEX_MCP_WORKSPACE=cwd`) excludes the workspace-local clone dir from the host repo's git.
- `src/server.ts` — `createServer(ctx)` registers every tool. **Add a new tool here.**
- `src/context.ts` — `AppContext`: the dependency bag (`projectManager`, `git`, `files`, `compiler`,
  `dblp`) passed to every tool handler.
- `src/tools/*` — one file per tool: a zod `inputSchema`/`outputSchema` + a handler that calls services.
- `src/services/*` — the core: `ProjectManager` (id→dir resolution, per-project mutex, dynamic
  registration), `GitService` (simple-git wrapper), `FileService` (sandboxed fs), `LatexmkCompiler`
  (implements the `LatexCompiler` interface), `DblpService` (DBLP search + canonical BibTeX fetch, with
  an injectable `fetch` for tests), `logParser`, `auth`.

Project state: clones live under a workspace root (`WEB_LATEX_MCP_WORKSPACE`), one dir per project id.
Set `WEB_LATEX_MCP_WORKSPACE=cwd` to clone into `<launch-dir>/.web_latex_mcp` (beside the agent's code;
git-excluded via the host repo's `.git/info/exclude` — `src/lib/workspaceExclude.ts`). Config comes from
env (`src/config.ts`); `ProjectManager` also supports runtime registration.

## Conventions that aren't obvious

- **stdout is the JSON-RPC channel.** Never `console.log` from server code — log to **stderr** only.
- **Tool return shape.** `CallToolResult` has an index signature that named types/consts don't satisfy,
  so `structuredContent` must be a **fresh object literal** — spread it: `structuredContent: { ...result }`.
  Use `errorResult(err, ctx.credentials.allSecrets())` (from `src/lib/errors.ts`) in every handler's catch
  so messages are token-scrubbed across every configured host.
- **Mutating tools** (write/edit/delete/commit/push/discard/clone/add_citation) must run inside
  `ctx.projectManager.runExclusive(id, ...)` to serialize per project. Read-only tools don't.
- **`.bib` files are guarded.** `write_file`/`edit_file`/`delete_file` reject a `.bib` target
  (`isBibFile`, `src/lib/bib.ts`) unless `confirmBibEdit: true` — keep this. The sanctioned write path
  is `add_citation`, which re-fetches BibTeX from DBLP server-side so entry text never originates from the
  model. The guard lives in the tool layer, so `add_citation` writing via `FileService` is intentionally
  not blocked.
- **Out-of-band edits are guarded.** `FileService` holds a `FileRevisionTracker`
  (`src/services/fileRevisions.ts`) that hashes each file it reads/writes. `write_file`/`edit_file`/
  `delete_file` refuse (throw `ExternalChangeError`) when the on-disk bytes changed since the server last
  saw them — the user editing the clone directly — unless `overrideExternalChanges: true`. `status`
  surfaces `externalChanges`. Baselines reset after `project_sync`/`discard` (`ctx.files.resetBaselines`),
  since those rewrite the tree. Keep this so a hand-edited clone isn't silently clobbered.
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

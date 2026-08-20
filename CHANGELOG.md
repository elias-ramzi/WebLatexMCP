# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This log starts with the changes made after 0.2.0; for anything earlier, see the git history.

## [Unreleased]

## [0.5.0] - 2026-08-20

### Added

- **Local (in-place) projects.** `register_project` accepts a `path` instead of a `gitUrl` and uses that
  directory where it lies — no clone, no second copy of the document. Registering the surrounding repo
  just to reach one `.tex` previously left two copies to drift apart. Git tools (`status`, `diff`,
  `commit`, `push`, `discard`, `project_sync`, `reset_to_remote`, and `read_file` with a `ref`) refuse a
  local project with an explanation rather than operating on the user's own repository. Compiled PDFs are
  surfaced into the workspace, never beside the source. Also configurable via `WEB_LATEX_MCP_PROJECTS`
  as `{ "mode": "local", "path": … }`.
- **`doctor`** — report the local toolchain a compile depends on: configured compiler, installed engines,
  TeX distribution and whether it is past end of life, the package manager and the repository it would
  install from (flagging a frozen `historic`/`tlnet-final` archive), writable install paths, `git`, and
  the workspace. Local and read-only; `checkRepository: true` also tests the repository over the network.
- **`missingPackages` on the compile result** — packages the local TeX installation lacks are named
  directly (e.g. `["fontawesome"]`) instead of leaving the caller to parse ``File `x.sty' not found``
  out of the log, with a `hint` carrying the install command. Only `.sty`/`.cls` names are reported: a
  missing image is a problem with the document, not with the machine.
- **`list_skills`** — the bundled skills as a tool, so the model can discover and follow one on its own.
  They were previously reachable only as MCP prompts, which a user has to invoke.
- `server_info` and `register_project` now report the `.git/info/exclude` pattern the server added for
  the clone directory, so a caller knows it is already handled and does not add a redundant `.gitignore`
  entry — and that the exclude is local to that checkout.
- Writing guide gains a **Citations** section on where `\cite{}` goes in the prose: never in the
  abstract, on first mention in the main text, re-anchored at each major section boundary (readers jump
  straight to the Method or Experiments), and never twice for the same work within a section.

### Fixed

- The per-project build directory is keyed by the project's full path rather than its basename, so two
  projects whose directories share a name no longer share a build directory (and surface each other's
  PDF).
- `list_projects` no longer points at `OVERLEAF_MCP_PROJECTS`, an environment variable that no longer
  exists; an empty workspace now explains how to register a project.
- Relative paths in `WEB_LATEX_MCP_PROJECTS` resolve against the server's launch directory rather than
  the process working directory.

## [0.4.0] - 2026-07-28

### Added

- **`set_credential`** — store a git token in the OS keychain straight from chat, so a project can be
  authenticated without editing environment variables or shell config. The token is written to the
  platform keychain and never persisted in `.git/config`.
- **`credential_portal`** — enter a git token via a one-off loopback web page instead of typing it into
  the chat, so the secret never travels through the conversation transcript.
- **Persistent project registry.** Projects registered at runtime (via chat) now survive a server
  restart instead of living only in memory, so a client does not have to re-register them each session.
- **One-click Claude Desktop Extension.** The server ships as a `.mcpb` bundle for one-click install in
  Claude Desktop, trimmed from ~50 MB to ~17 MB (6.2 MB packed).

### Changed

- Compilation adopts `latexmk -cd`, running the build from the main file's own directory so projects
  that rely on relative paths compile correctly.
- The credential portal page, the `credential_portal` result, the Desktop install form, and the docs now
  link to <https://www.overleaf.com/user/settings>, where an Overleaf Git authentication token is
  created — no hunting through Overleaf's settings to find it.

## [0.3.0] - 2026-07-24

### Added

- Keyboard shortcuts in the PDF viewer's comment popup: `Shift+Enter` saves the note (triggers the Save
  button) and `Escape` cancels, so the select-to-comment flow no longer needs the mouse. Plain `Enter`
  still inserts a newline; the textarea placeholder advertises both.
- **Parallel sessions on one clone.** Several agent sessions — a session per section, say — can work on
  the same project at once, each committing only its own edits. Each session keeps a shadow of every
  file it touched, holding `HEAD` plus only that session's changes, and `commit` stages that content
  directly instead of running `git add`, so a peer's half-written paragraph in the same file stays
  uncommitted in the working tree. Name a session with `WEB_LATEX_MCP_SESSION`; state lives in
  `<workspace>/.sessions/`, outside the clones. Same file, different paragraphs merges silently; the
  same _lines_ is surfaced and excluded from commits rather than resolved. See
  [Parallel sessions on one clone](docs/CONCURRENCY.md#parallel-sessions-on-one-clone). Requires one
  server process per session (Claude Code); Claude Desktop shares a single session across chats.
- Mutating operations now also take a lock file, so two server processes over the same clone can no
  longer rewrite its git index at once. Abandoned locks are reclaimed once the owning process is gone.
- `status` reports `sessionChanges` / `otherChanges` (who owns each uncommitted file), `activeSessions`,
  and `conflictedChanges`; `commit` reports `scope`, `session`, `leftUncommitted`, and `conflicted`.
  Rendered into the result text too, so clients without structured output still see them.

### Changed

- `commit` commits only the current session's edits by default, once that session has changes to track;
  pass `scope: "all"` for the previous whole-clone behaviour. Sessions that make every edit through the
  tools — the single-session case — are unaffected.
- `push` refuses while another live session has uncommitted work, naming who to wait for: a push has to
  rebase, and a rebase needs a clean tree. Changes nobody owns (edited outside the server, or left by an
  exited session) do not block it.

- `format-latex-project` gains a third cosmetic pass: every `figure`/`table` environment moves into its
  own `figures/<name>.tex` or `tables/<name>.tex` file, `\input`ed from exactly where the float stood.
  Files are named after the float's label, `\includegraphics` paths are left byte-identical, and new
  floats are authored the same way from the start.
- `arxiv-clean-project` skill now gates `--use_external_tikz` on detection: it is offered only when the
  project already externalizes TikZ (`\tikzexternalize` plus one PDF per figure in the prefix folder),
  since `arxiv_latex_cleaner` only substitutes the PDFs and never generates them. Otherwise the skill
  explains what setting externalization up would require (a live source edit and arXiv's TeX Live
  release) and proceeds without the flag.
- Writing guide clarifies two conventions: figure/table caption explanations are descriptive (axes,
  conditions, curves — interpretation stays in the body text), and acronyms are defined once at first
  appearance, only for terms that recur, with the abstract as the standalone exception.

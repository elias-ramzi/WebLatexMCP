# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This log starts with the changes made after 0.2.0; for anything earlier, see the git history.

## [Unreleased]

### Added

- **`compile` returns the source around each error** — a LaTeX message is frequently uninterpretable on
  its own (`Undefined control sequence` names no macro; `Missing $ inserted` points at the line where TeX
  _noticed_, not where you erred), so each error now carries the 5 source lines around it (`snippet`,
  numbered from `snippetStartLine`), rendered into the result **text** as well as `structuredContent` so
  a client that strips structured output still sees it. Errors only — warnings never carry one — at most
  10 distinct locations per compile, attached once per location, and never a guess: a location the parser
  cannot confirm against the file, a line past the end of its file, or a file the document merely _named_
  in its log gets none. `omittedSnippetLocations` says how many locations went without, so a gap is
  reported rather than silent. `list_comments` snippets now have the same shape (`snippetStartLine`
  included).

- **`session-feedback` skill** — a bundled skill to run at the _end_ of a session, which reviews the tool
  calls that actually ran and reports on the **server itself**: what broke, what cost too many calls,
  what capability was missing, what the docs got wrong. Findings are classified
  (`bug`/`friction`/`gap`/`docs`/`skill`), rated blocked/slowed/cosmetic, given a frequency, and checked
  against existing issues (best-effort, via `gh`) so a known problem is marked rather than re-filed. The
  output is **one ready-to-file issue body per finding**, laid out field for field against the repo's
  issue forms — with a _measured_ environment block (server version and whether it is the latest, OS +
  arch + WSL, Node, MCP client, model, install method, TeX toolchain, workspace and project kind): the
  skill runs the commands rather than recalling values, and writes `<unknown — please fill in>` for
  anything it could not measure or was not told. It mutates nothing, scrubs credentials and manuscript
  content before printing, and files an issue only when explicitly asked. Documented in
  [CONTRIBUTING.md](CONTRIBUTING.md#feedback-from-a-session) as the fastest way to contribute.
- **Issue forms ask what actually predicts a bug** — the bug report form gained **MCP client** (which app
  was connected), **Model** (tool-use behavior differs between them), **How was it installed?** (npx,
  global npm, `.mcpb` bundle, plugin, clone — it decides which dependencies shipped), and **TeX
  toolchain** fields, the OS field now asks for architecture and WSL, and the remote dropdown covers a
  local in-place project. `session-feedback` fills the same fields in the same order.
- **`list_references`** — read a project's own references, structured: cite key, entry type, title,
  authors (with `truncatedAuthors` for an `and others` / "et al." list), year, venue, DOI/arXiv, the file
  and line each entry sits on, and its `raw` text. Reads three shapes of bibliography and says which one
  each entry came from: a BibTeX `.bib` (resolving `@string` venue macros), a LaTeX `thebibliography` of
  `\bibitem`s, and **a reference list written as prose in a markdown or plain-text document**. `filter`
  searches across key/title/authors/venue. Read-only and git-free, so it works on a local project.
- **`check_citations`** — cross-check what a document cites against what its bibliography defines, in one
  call: `undefinedCitations` (cited with no entry — these render as `[?]`), `uncitedEntries`,
  `duplicateKeys`, and `incompleteEntries` (missing a field the BibTeX entry type requires). Reads the
  `\cite` family in `.tex` (multi-key and optional-argument forms, skipping commented-out ones) and
  pandoc `[@key]` / `@key` in markdown. Structural only; correctness is still the DBLP pass.
- **`check_citations` spans two projects** — `bibliographyProject` checks a draft against a shared
  bibliography that lives in _another_ registered project, in one call instead of two `list_references`
  calls and a comparison by hand. `documents` resolve inside `project` and `bibliography` inside
  `bibliographyProject`, each sandboxed to its own; the parameter is a **project id**, never a
  `"project:path"` string, so another project is reachable only by naming one you registered. Reading
  only — writing into another project's `.bib` stays a separate, permissioned `add_citation` there.
  Findings are limited to the keys the draft actually cites, since a shared bibliography is supposed to
  hold entries this draft does not use: `uncitedEntries` comes back empty and `duplicateKeys` /
  `incompleteEntries` cover cited entries only (`entryCount` still reports the full size). The answer you
  came for — `undefinedCitations`, the keys the shared `.bib` does not define — is unaffected.
  `list_references` needs no equivalent: it already reads whichever project `project` names.
- **`list_files` filter `docs`** — prose documents (`.md`, `.markdown`, `.txt`, `.rst`, `.org`) are now a
  first-class file `type` (`doc`) rather than `other`, so a markdown draft is findable.
- **`add_citation` returns `line`** — the file and line the entry landed on, so a caller can confirm the
  insertion without re-reading the `.bib`.
- **`register_project` accepts a file, not only a directory.** People point at the document — "verify the
  citations in `~/proposals/eurohpc.md`" — so naming a file now registers the folder holding it instead of
  failing. A `.tex` named this way also becomes the LaTeX `rootFile`; a markdown or plain-text document
  does not, since it is not a LaTeX root. An explicit `rootFile` still wins, and the result says which
  directory was registered — the project is the whole folder, and every file in it is readable.
- **`diff` accepts a `ref`** — so a session that already committed a few times is still reviewable as a
  whole, without dropping to a shell. Takes a commit-ish (`"HEAD~3"`, a sha, `"origin/master"` for what
  the branch has that the remote does not) or a two-dot range (`"a..b"`); `path` still narrows it to one
  file. Every endpoint is resolved before it reaches git, so an unknown ref is reported by name rather
  than surfacing a raw git error, and `ref` alongside `staged` is rejected instead of one silently
  winning. Note it is **not** session-scoped: `commit` takes only your own edits but history is shared,
  so on a clone with several sessions a ref diff spans everyone's commits — it answers "what changed",
  not "what did I change" ([tools.md](docs/tools.md#reviewing-a-whole-session)).

### Changed

- **`verify-citations` works on a document that is neither a `.bib` nor on a remote.** The skill now
  branches on the project's `mode`: it skips `project_sync` and the git-exclude step for a local project
  instead of failing on them, registers an unregistered folder in place, and drives `list_references` /
  `check_citations` rather than hand-parsing with regex. It states per format how far the parsed fields
  can be trusted (`prose` entries are heuristic — query DBLP from `raw`), never annotates a markdown
  draft (no comment syntax stays invisible there), and asks before writing the audit report into a local
  project's directory, which belongs to the user.
- **`search_references` description** — says outright that it queries DBLP over the network and does not
  read the project's `.bib`, and points at `list_references` for searching the references already there.
  It was not clear which side of the boundary the tool sat on.

### Fixed

- **A read the server makes for itself no longer disarms the out-of-band-edit guard.** Detecting the
  root file (`compile`, and the viewer's PDF poller, on a timer) and building `list_comments` snippets
  recorded a revision baseline as though the caller had read those files, so a `write_file` after a
  hand edit could overwrite it with no `ExternalChangeError`. `FileService.read`/`readText` now record
  only when asked to, which only `read_file` and `list_references` do — the two that hand back a whole
  file the caller could base a write on.
- **A symlink can no longer take a read or a write out of a project.** `resolveInside` compares
  strings, so a `notes.tex` symlinked outside it — git stores one as mode 120000, so a collaborator can
  commit it — was read, written, edited and deleted at the far end. Every path resolves links first now,
  including for a file that does not exist yet: a write follows a dangling link and creates the file
  wherever it points. A link's target is resolved in turn, component by component — `notes.tex ->
sub/pwned` with `sub` itself linked outside lands outside, however innocent the literal target
  looks. That holds for **every** project, cloned or local: whether you or the server ran
  `git clone` says nothing about who put a link in the tree, and a directory you registered in place is
  usually a working tree a co-author can push a symlink into. The one layout that needs links — a shared
  `refs.bib` or `figs/` linked into each paper — is a per-project opt-in you set yourself,
  **`followSymlinks: true`** on a local project (`register_project`, `WEB_LATEX_MCP_PROJECTS`, or the
  workspace registry). Where it is on, `list_files` and every tool that scans on its own now see the
  linked files too, so the shared `.bib` is findable instead of readable only by name.
- **A path the _document_ chose is not handed back as one to open.** `compile` refused to read a
  symlinked path for a snippet and then reported it as a `file` you can pass straight to `read_file` —
  so the guard covered the read the server makes rather than the path it offers, and the caller took
  the next hop. A diagnostic (error or warning) whose file leaves the project through a symlink now
  keeps its message and loses its `file`/`line` — and its snippet, which is rendered against that
  line — and the result text says how many were hidden; `list_comments` does the same for a synctex
  record, which the document controls just as much. Resolving those paths is capped, and a location
  past the cap is withheld too but reported as **unchecked**, not as an escape: nobody looked at it,
  so blaming a symlink would send you after a link that is not there.
- **`read_file` no longer counts a phantom last line.** A file ending in a newline reported one line
  more than it has, and a range ending on it returned a blank line; CRLF and CR-only files are now split
  correctly instead of leaving `\r` on every line (or, for CR-only, returning the whole file as line 1).
- **A ranged `read_file` hands back the bytes that are on disk.** Line endings were normalized to `\n`
  on the way out, so pasting a range from a CRLF file into `edit_file`'s `oldString` failed to match;
  the `ref` path also called a whole-file read truncated and dropped the trailing newline, which
  `push` resolutions write straight back into the repository.
- **`rawLog` and the log tail no longer carry `\r`** on a Windows log — the last path that still split
  on `\n` alone.
- **Compile logs written on Windows parse at all.** pdfTeX writes its `.log` in text mode, so every line
  arrives with a trailing `\r` — which the diagnostic patterns do not cross and `extname` keeps. Left
  unhandled it emptied the parser, and CI's TeX job is Linux-only, so nothing caught it.
- **`compile` resolves a root file in a subdirectory.** latexmk's `-cd` makes the log's paths relative
  to the root file's directory, so a document at `paper/main.tex` reported its errors in `main.tex`;
  they are now rebased onto the project root.
- **The collapsed "TikZ externalization failed for N figures" error no longer claims a location** — it
  inherited the first figure's file and line, pointing at source where nothing is wrong.
- **A diagnostic printed without a source position no longer borrows the next one's.** The `l.<n>` scan
  ran past whatever followed, so a `! Package hyperref Error` above an unrelated
  `! Undefined control sequence` was reported at that error's line — including when latexmk printed the
  two on adjacent lines, which is the usual shape.
- **Source context survives an accented document.** pdfTeX elides a long context line at a byte offset,
  so it can cut a UTF-8 character in half; the resulting replacement character made the check that
  guards against a stale location reject a file that was perfectly correct. Measured on real French
  prose, that silently withheld the source for one error location in eight.
- **A warning's `file` is rebased like an error's**, so it too is a path `read_file` can open when the
  root file lives in a subdirectory.

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

- **The `.mcpb` Desktop Extension could not start.** `.mcpbignore` excluded `src/` unanchored, which
  matches a directory of that name at any depth — including `node_modules/debug/src/`, where that
  package's `main` points. The packed bundle was therefore missing the entry point of a transitive
  runtime dependency (via `simple-git`) and died on startup with
  `Cannot find package …/debug/src/index.js`. This affected the published 0.4.0 bundle. Our own
  directories are now anchored (`/src/`, `/test/`, …), and the bundle workflow starts the packed
  server before attaching it to a release, so a bundle that cannot boot never ships again.
- `manifest.json` had fallen a release behind the other version manifests, so a locally built
  Desktop Extension (`npm run bundle`, which does not sync it the way the release workflow does) was
  labelled with the previous version. A unit test now asserts `package.json`, `plugin.json`,
  `marketplace.json`, `manifest.json` and the lockfile all agree, so the gate fails instead.
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

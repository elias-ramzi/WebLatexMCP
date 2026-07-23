# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This log starts with the changes made after 0.2.0; for anything earlier, see the git history.

## [Unreleased]

### Added

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

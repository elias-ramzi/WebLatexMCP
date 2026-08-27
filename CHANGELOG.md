# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This log starts with the changes made after 0.2.0; for anything earlier, see the git history.

## [Unreleased]

### Added

- **Rewrite-preservation mode** — a habit Overleaf users already have, that the model had no way to
  match: when `edit_file` rewrites a sentence or paragraph in a `.tex`/`.sty`/`.cls`/`.bbl` file, it can
  now comment the original out (`% ` on every line) above the replacement instead of discarding it, so a
  rewrite reads in the diff the way a human's would — the old wording still there, commented, for a
  co-author to see. This has to be enforced server-side rather than asked of the model as a writing-guide
  rule: a preserved block is only trustworthy if it is provably the bytes that were there, the same
  reason BibTeX entry text comes from DBLP rather than from the model retyping it. Three modes — `off`
  (default — preservation is opt-in, since it writes bytes the caller did not ask for), `prose`, `always`
  — with `prose` preserving only edits that look like an actual rewrite (>= 8 words, mostly non-markup,
  not a near-identical replacement), so a typo fix or a swapped `\cite` key is left alone. Turn preservation
  on with `set_rewrite_mode` (per project) or `WEB_LATEX_MCP_REWRITE_MODE` (server-wide). The mode is
  sticky per project (`set_rewrite_mode`, persisted outside the clone) and
  defaults from `WEB_LATEX_MCP_REWRITE_MODE`; a per-call `preserveOriginal` on `edit_file` always wins
  over both, in either direction. Never applies to `write_file` (no single old paragraph to comment out
  above — the whole prior file isn't the same thing) or to a `.bib` (already gated by `confirmBibEdit`).
  Preservation only fires on a **line-aligned** match — `oldString` starting at the beginning of a line
  and ending at the end of one — and never on a `replaceAll` edit, since neither leaves a single safe
  place to put a `%`-comment; either case applies the edit unchanged instead. The preserved block carries
  no sentinel marker on purpose — it should look exactly like a paragraph a human commented out by hand,
  and `arxiv-clean-project` already strips comments before submission. `list_projects` and `server_info`
  report the effective/default mode so it is never a hidden setting.

- **`WEB_LATEX_MCP_WRITING_GUIDE_EXTRA`, and an `add_writing_convention` tool to write to it.** The
  existing `WEB_LATEX_MCP_WRITING_GUIDE` only _replaces_ the bundled `docs/writing-guide.md` — fine for
  swapping in a house style wholesale, but it meant a single per-paper preference ("always write lidar,
  never LiDAR") forced copying the whole base guide just to add one line, and any later upstream change
  to that base guide had to be hand-merged back in. The new var names an _additional_ guide (a plain path
  or a `file:///...` URL, so Claude Desktop users can paste a file link) that is composed in **after** the
  base guide, under a "Project-specific conventions" heading, and takes precedence where the two
  contradict — the base guide stays the default and the project layers its exceptions on top. Setting
  both is legal: your replacement base plus your extra on top.
  `add_writing_convention` takes a single `rule` string and appends it as a bullet to that configured
  file, creating it on first use, behind the same cross-process file lock every mutating tool uses. It
  takes no path — the destination is always the one file the server was configured with, never one the
  model names — and it is strictly append-only: it cannot rewrite or drop a line a human already wrote
  there. The rule takes effect starting with the **next** session, not the current one, because MCP
  `instructions` are fixed at connect time; no live-refresh machinery was built for this, since a rule
  that changed what "the current session already agreed to" mid-conversation is a stranger source of
  confusion than a one-session delay. `server_info` now reports the configured path and whether the file
  actually loaded, because a typo'd path would otherwise mean the conventions are silently ignored
  forever with no way to notice.

- **A `render_pages` tool, and `pageCount` on `compile`** — the model could not see what it compiled.
  `compile` returned a log and a PDF path; `viewer` served a pdf.js page for a _human_. Neither put pixels
  where the model could read them, so every visual question had to be answered outside the server — in the
  session this came from, a 140x100cm poster, by installing PyMuPDF and rasterizing by hand six times, which
  moved the whole compile-look-fix loop into the shell and lost the structured error payload on the way.
  `render_pages` rasterizes the last compiled PDF to PNG and returns the images inlined **and** as written
  paths — inlined up to a 5 MB budget on the base64-encoded payload, after which the tail comes back as paths
  only and says so, rather than as a hole in the middle of the page range; a single page too big to inline is
  told what to do about it. At most 8 pages per call, the rest reported in `skippedPages`. It takes `pages`, a
  `clip` rectangle in page fractions, and two sizing knobs: `maxEdgePx` (default 1600)
  fits the returned image to a token-sane size, while `dpi` sets the resolution directly and wins — the precise
  path being to clip one column and ask for 150 dpi. Both are bounded by a 4000px hard cap, and a request that
  reaches it says so (`clamped`) and reports the resolution actually used. Read-only over the last build: it
  never compiles. It takes `runExclusive` despite being read-only _with respect to the project_, because it
  reads the build-dir PDF a peer session's `compile` can rewrite mid-read and writes its PNGs into that same
  build dir — never inside the project, since a `local` project is edited in place, not littered in place.
  Both need the native canvas backend `@napi-rs/canvas`, now declared as an **optional** dependency and reported
  by `doctor` (`pdf-render`). The page count needs it as much as the rasterizing does — pdf.js reaches for DOM
  geometry globals in Node and it is this backend that supplies them, so without it pdf.js cannot open a PDF at
  all; that failure is reported as the missing backend rather than as a broken document. The check is a
  _warning_ and never a failure, because nothing else the server does — compiling, the viewer, editing, the
  whole git side — needs it. The cheap half is `compile`'s new `pageCount`, read from the PDF rather than the
  log: a layout that spilled onto a second page is neither an error nor a warning in TeX's eyes, so one number
  is the only thing that reports it — and the log's own `Output written on … (N pages` line is hard-wrapped at
  79 columns, which is a second reason not to parse it. A count that cannot be read never fails a compile that produced a
  document.

- **Two new skills — `proofread-document` and `review-writing-guide` — and three Claude Code commands that
  parallelize them.** The typo hunter and the guide reviewer existed only as a `.claude/` command and agent, which
  meant they existed only in Claude Code: Claude Desktop and every other MCP client got no proofreading procedure at
  all, and no writing review — not a degraded one, none, since `.claude/commands` and subagents are a Claude Code
  mechanism and the server advertises only `.claude/skills`. Both are now skills, so they ship as MCP prompts and
  through `list_skills` like the other five, each with a single-agent workflow that stands on its own.
  `proofread-document` reports typos as exact minimal substitutions and applies nothing until asked, with the hard
  rule that a sentence you would have phrased differently is not a typo. `review-writing-guide` reviews against
  [`docs/writing-guide.md`](docs/writing-guide.md) — which already reaches every client as the server's own
  instructions, so the guide stays the authority and the skill only says how to review against it — and writes
  nothing whatsoever, not even a report file: it proposes, and the author disposes. Alongside them,
  `/format-latex`, `/hunt-typo` and `/review-writing` fan the per-file reading out across one subagent per file
  (`formatter` and `corrector` on sonnet, `writing-reviewer` on opus with a `--sonnet` override), which is cheaper
  and parallel. The commands and agents **fetch their rules from the skill through `list_skills` at run time**
  rather than restating them, and stop rather than improvise if that call fails — a paraphrased rule is a wrong
  rule, and two copies of a taxonomy drift the first time one is edited. What stays in each command is only what a
  skill cannot say: which part is serial (splitting one main file has nothing to parallelize), which findings need
  more than one file to see (an acronym defined twice, a float never referenced) and so cannot be delegated to a
  single-file agent, and how the fan-out is batched. Contributor tooling under `.claude/` throughout: no tool, no
  runtime behaviour, and nothing in `src/` changed.

- **A `/review` command** — the review half of `review-round`, driven by hand instead of by a
  workflow script, so it costs a session rather than a fleet and reports before it touches
  anything. It scopes the target itself (a PR number through `gh`, a branch, or the working tree),
  resolving the base as the PR's own base and otherwise `origin/dev` — the integration branch —
  rather than `main`, and groups the touched files by the risk they carry here: the
  `src/services`/`src/lib` core, the `src/tools` + `src/server.ts` surface, the `context.ts` /
  `config.ts` wiring, skills and prompts, tests, docs. Then it runs the one gate this repo has
  (`typecheck` + `lint` + `format:check` + `test`) **itself** before delegating, because a green a
  subagent reports is not evidence, and it reads the skip count rather than the pass line — the
  TeX smokes auto-skip wherever `latexmk` is absent, so a green `npm test` over compile-adjacent
  code is a vacuous pass, which is the failure mode the whole review exists to catch. The review
  goes to the existing `plan-verifier` agent (there is no separate reviewer agent here, and one
  more agent restating the same invariants is one more copy to drift), with the stated intent as
  the spec and the CLAUDE.md guards the diff comes near named outright. Report-only by default:
  the implement/verify loop runs only under `--fix`, capped at three rounds, and a finding that is
  really the author's call — a design disagreement, a scope question — is reported and never
  "fixed". Posting the verdict to the PR and pushing the fixes are two separate steps, each gated
  on an explicit go, which is the deliberate difference from the workflow's unattended commit.
  Adapted from a sibling repo: the shape carried over, every rule was rewritten for this one.
  Contributor tooling under `.claude/`; no tool, no runtime behaviour, nothing in `src/`.

- **A `review-round` workflow and the two agents it drives** — contributor tooling under
  `.claude/`, which changes nothing about the server itself: no tool, no runtime behaviour. The
  workflow performs one review round end to end: by default an adversarial reviewer produces the
  round itself against the current branch's diff (a posted PR review-comment URL can be supplied to
  fix an existing round instead), then a planner batches every finding and cleanup
  item into 1–4 self-contained specs ordered so an earlier batch cannot invalidate a later one, an
  `implementer` agent fixes each batch test-first, a `plan-verifier` agent tries adversarially to
  refute it and sends rework back (up to `max_attempts`), and a final auditor reads the whole diff for
  the cross-batch interactions no per-batch reviewer could see, syncs with the remote, runs the gate,
  and commits only when every batch was approved. Adapted from a sibling repo, so what carried over is
  the shape and what was rewritten is every rule: the agents encode _this_ repo's invariants (thin tool
  layer over services, stdout as the JSON-RPC channel, and the guards — `requireGitProject`,
  `runExclusive`, `confirmBibEdit`, `recordBaseline`, symlink resolution, ff-only pull, a
  shadow-store `conflicted` flag that stays flagged, snippets only for log-vouched locations) as
  things a verifier hunts for having been weakened. The vacuous-pass mode they are built to catch is
  this repo's own: `test/smoke/**` auto-skips wherever `latexmk` is absent, so a green `npm test` is
  never accepted as coverage of compile-adjacent code, and `typecheck` is run for the tests the build
  excludes.
- **An `/implement` command** — orchestrates a request the same way by hand: the session writes the
  spec (files, invariants, tests-first with a case just outside every new guard, and the right test
  tier), delegates each bounded task to the `implementer` agent, verifies the assembled diff with
  `plan-verifier`, and proves the work with the one gate this repo has: the local CI
  (`typecheck` + `lint` + `format:check` + `test`) passing.
- **An `/implement-issue` command** — `/implement` assumes the request is worth building because I
  wrote it; an issue or a saved feedback report is written by someone else, so this one triages before
  it builds. It loads the source verbatim (a `gh issue view` including the **comments**, since a
  maintainer reply often narrows or kills the ask; or a markdown file, each issue block in a saved
  feedback report being its own candidate), delegates the judgment to a single agent whose model is
  picked by `--triage-model` (fable or opus, fable by default, and the run says which one ran). It
  separates the observed problem from
  the proposed solution (the proposal being the half more often wrong) and checks the claim against the
  tree with files and lines named, since the behaviour may already exist, may have been fixed since the
  reporter's version, may be a CLAUDE.md guard working as designed, or may be a docs fix rather than a
  code one. The agent advises; the session forms its own call and says where it disagrees. Then it
  **stops**: a building / discarding / deviating / open-questions report, and no `implementer` is
  launched and no file edited until I approve it — an empty accept list being a valid outcome, stated
  outright so a run cannot manufacture work to justify itself. After approval it is `/implement`'s
  pipeline, with the issue's words treated as evidence rather than as a spec, and a close that drafts
  (never posts) the reply owed to the reporter, discarded parts included.

- **A CI check that a PR into `dev` moved the `[Unreleased]` section of this file.** The log is not a
  list of commit subjects — its entries carry the reasoning that is nowhere else: why a guard exists,
  what the alternative was, what a fallback silently changes. A forgotten entry loses that and it is
  never reconstructed later, so the rule is checked rather than trusted. It is a workflow and not a
  test, because it is a fact about a PR rather than about the code: `on: pull_request` hands over the
  base ref, while `npm test` runs on `push` and locally, where there is no base branch and mid-work
  there is legitimately no entry yet — a check that is red all afternoon teaches people to ignore red.
  Narrow on purpose. PRs into `dev` only: a `dev -> main` release PR _is_ the changelog, and the
  auto-merged `main -> dev` back-merge carries no entry by construction, so requiring one there means
  a bot PR that has to be babysat every release. A `no-changelog` label opts out, because the
  alternative for a PR with genuinely nothing to log is a junk entry written to satisfy a bot, which
  costs the log more than the missing rule does. And what is compared is the `[Unreleased]` section
  itself, base-vs-head, not whether the file appears in the diff — the mistake actually made is
  appending to the last released section out of habit, which touching the file does not catch.

### Changed

- **A regression test that passes before its fix is now a finding, not a footnote.** The `implementer`
  agent already had to watch each new test fail on the pre-fix code and report the result, and it did —
  during the review of #52 it said plainly that two of three new tests passed pre-fix, because the `- `
  bullet prefix in front of them already satisfied their regexes. Nothing said what to _do_ with that
  disclosure, so it was read as a status line and passed upward; the vacuous tests were caught two steps
  later by `plan-verifier`. The agent's brief now closes that loop — such a test is rewritten until it
  fails for the right reason, or deleted, and never reported as covered — and `/review` step 3 treats an
  implementer's "passed pre-fix" as a confirmed finding to send back in the same round. A test that
  passes before the fix cannot catch the bug returning, and is also evidence the fix may be aimed at the
  wrong thing, which is the easier signal to skim past. No extra verification round was added: the
  existing one worked, catching both these tests and a TOCTOU race that a fix had itself introduced.

- **The `session-feedback` skill saves its report itself when there is no way to file it.** The report
  was always optional to write, which is right when `gh` can file the findings and wrong when it
  cannot: with `gh` missing or merely logged out, the blocks existed only in the transcript and died
  with the session. The skill now checks `gh auth status` before printing and, on a non-zero exit,
  writes the summary and every issue block to `.claude/session_feedbacks/web-latex-mcp-feedback-<date>.md`
  without asking (appending under a timestamped heading rather than overwriting a report I have not
  filed yet), says why it went there, and names `gh auth login` as the one command that unblocks
  filing. Authenticated, nothing changes: the file stays offered, not written. The same exit code now
  gates the known-issues search, too — an installed-but-logged-out `gh` fails it with an auth error,
  which is not "nothing found", so it counts as skipped and the confirmation checkbox stays unticked.
  The directory ships with its own `.gitignore` (`*`, `!.gitignore`) so a report is never committed,
  and the skill writes those same two lines wherever else it creates the directory.

## [0.6.0] - 2026-08-21

### Added

- **`compile` returns the source around each error** — a LaTeX message is frequently uninterpretable
  on its own (`Undefined control sequence` names no macro; `Missing $ inserted` points at the line
  where TeX _noticed_, not where you erred), so each error now carries the 5 source lines around it
  (`snippet`, numbered from `snippetStartLine`), rendered into the result **text** as well as
  `structuredContent` so a client that strips structured output still sees it. Errors only —
  warnings never carry one — at most 10 distinct locations per compile, attached once per location,
  and never a guess. Earning one takes more than a plausible line: the log has to name the file
  **and** line on one diagnostic line (`-file-line-error`), so a location pieced together from the
  parenthesis stack is counted rather than illustrated — which means **tectonic**, whose logs carry
  no `file:line` at all, gets no snippets by design. A line past the end of its file, a file the
  document merely _named_ in its log, and a location TeX's own echo of the source contradicts all
  get none either. `omittedSnippetLocations` says how many locations went without, so a gap is
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

- **README trimmed.** "Highlights" merges the multi-project and no-remote bullets into one, and the
  surgical-edit and reviewable-push bullets into another; the references bullet now leads with what the
  citation checks do rather than which formats they parse. "What you can do" is five one-line entries
  instead of a paragraph each — the parameters, guards, and edge cases it restated all live in
  [tools.md](docs/tools.md), which it now points at.
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
  strings, so a `notes.tex` symlinked outside it — git stores one as mode 120000, so a collaborator
  can commit it — was read, written, edited and deleted at the far end. Every path resolves links
  first now, including for a file that does not exist yet: a write follows a dangling link and
  creates the file wherever it points. A link's target is resolved in turn, component by component:
  a dangling `notes.tex` pointing at `sub/pwned`, with `sub` itself linked outside, lands outside
  however innocent the literal target looks. That holds for **every** project, cloned or local:
  whether you or the server ran `git clone` says nothing about who put a link in the tree, and a
  directory you registered in place is usually a working tree a co-author can push a symlink into.
  The one layout that needs links — a shared `refs.bib` or `figs/` linked into each paper — is a
  per-project opt-in you set yourself, **`followSymlinks: true`** on a local project
  (`register_project`, `WEB_LATEX_MCP_PROJECTS`, or the workspace registry). Where it is on,
  `list_files` and every tool that scans on its own now see the linked files too, so the shared
  `.bib` is findable instead of readable only by name.
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

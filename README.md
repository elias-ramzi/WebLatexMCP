<div align="center">

<img src="assets/weblatexmcp-lockup-beta.svg" alt="WebLatexMCP — public beta" width="100%" />

# WebLatexMCP

**Read, edit, compile, and commit LaTeX in any git-hosted project — straight from Claude.**

[![CI](https://github.com/elias-ramzi/WebLatexMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/elias-ramzi/WebLatexMCP/actions/workflows/ci.yml)
&nbsp;
![Node ≥ 20](https://img.shields.io/badge/node-%E2%89%A5%2020-3C873A?logo=node.js&logoColor=white)
&nbsp;
![Platforms](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-444)
&nbsp;
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

**Works with**
&nbsp;
[![Claude](https://img.shields.io/badge/Claude-D97757?logo=anthropic&logoColor=white)](docs/install/README.md)

**Pending**
&nbsp;
[![Gemini](https://img.shields.io/badge/Gemini-1C69FF?logo=googlegemini&logoColor=white)](docs/install/gemini.md)
&nbsp;
[![GitHub Copilot](https://img.shields.io/badge/Copilot-24292F?logo=githubcopilot&logoColor=white)](docs/install/copilot.md)
&nbsp;
[![Mistral](https://img.shields.io/badge/Mistral-FA520F?logo=mistralai&logoColor=white)](docs/install/mistral.md)

</div>

> [!WARNING]
> **Public beta — very early development.** WebLatexMCP is now public, but it's in its early stages and
> under active development. Expect bugs, rough edges, and incomplete features. Editing and git operations
> touch real projects, so review diffs before you push. Please
> [report anything you run into](https://github.com/elias-ramzi/WebLatexMCP/issues) — bug reports and
> feedback are hugely welcome.

---

An MCP server that lets Claude **read, edit, compile, and commit LaTeX** in a git-hosted project —
**Overleaf**, **GitHub**, or any git remote. It keeps a local clone, compiles locally (TeX Live +
`latexmk`, or `tectonic`) so you see errors and PDFs without round-tripping, and sends changes back through an explicit
commit → push you review first. Works with **Claude Desktop** and **Claude Code** over stdio, on
**macOS, Linux, and Windows**.

Already have the `.tex` on your machine? Point it at that folder — or straight at the file — and it
reads, edits and compiles the real files **in place** — no remote, no clone, no second copy of the
document.

## Highlights

- 🗂️ **Any project, with or without a remote** — Overleaf, GitHub, or any git remote, side by side, each with its own credentials — or a folder you already have, worked on **in place**, so what Claude compiles is the file your editor has open.
- 🧪 **Local compiles** — `latexmk` (or `tectonic`) runs on your machine and returns structured errors/warnings + the PDF. Each error comes with the 5 source lines around it, so a bare `Undefined control sequence` is readable on the spot (under `latexmk`; `tectonic`'s log names no `file:line`, so it yields none). A package your TeX installation lacks is named outright, and `doctor` reports what that installation actually has.
- 🖼️ **Claude can see the pages** — `render_pages` rasterizes the compiled PDF to PNG and hands the images straight back, so layout questions get answered from the pixels instead of guessed from the log: whether a column silently spilled onto a second page, whether the columns end at comparable heights, whether a figure panel is clipped by its own PDF box. Crop to one column with `clip` (fractions of the page) and raise the `dpi` when you need detail. `compile` also reports `pageCount`, which catches the spill on its own.
- 👀 **Live PDF viewer + review comments** — a local viewer that hot-reloads on every compile (a browser window, or a **VS Code** tab); select text in the PDF to leave notes, and Claude applies them at the right source line via SyncTeX.
- ✏️ **Surgical edits, reviewable pushes** — atomic, exact-match string replacements; `commit` and `push` stay separate, so nothing leaves your machine implicitly.
- 👥 **Parallel sessions** — run a session per section on one clone; each commits only its own edits, so
  nobody sweeps up anyone else's half-written paragraph.
- 🔐 **Tokens stay in memory** — never written to `.git/config`, and scrubbed from all output.
- 📚 **Citations checked, not trusted** — `check_citations` catches what the draft cites but the bibliography never defines (and the reverse), and the `/verify-citations` skill audits every entry against DBLP. Works on a `.bib`, a LaTeX `thebibliography`, or a prose reference list in a markdown draft.
- 🧩 **Bundled Claude Code skills** — project cleanup, typo hunting, writing-guide review, DBLP citation audits, bibliography normalization.

## Install

Pick your client below. Either way, editing, git, and the PDF viewer work without TeX — only `compile`
needs `latexmk` (default) or `tectonic` on your `PATH` — pick either per call with
`compile { compiler: "tectonic" }`, and a missing _default_ falls back to whichever of the two is
installed (a backend you actually chose never does; see
[Compile backend](docs/configuration.md#compile-backend)). Not sure what you have? Ask Claude to run
`doctor` and it reports your engines, TeX distribution, and where packages can be installed.

### Claude Code (CLI or the VS Code extension)

Install the **plugin** — it registers the server **and** the [skills](#skills) in every session, from
any directory:

```bash
# In Claude Code:
/plugin marketplace add elias-ramzi/WebLatexMCP
/plugin install web-latex-mcp@web-latex-tools
```

Prefer just the server? Register the npm package in one line (skills still come through as
[prompts](docs/skills.md#two-ways-a-skill-runs)):

```bash
claude mcp add web-latex-mcp --scope user -- npx -y web-latex-mcp
```

💡 Launch Claude Code **from your paper's own repo** so the LaTeX clone lands right beside your code. The
step-by-step [VS Code quickstart](docs/install/vscode-quickstart.md) is the most-tested path.

### Claude Desktop — one-click extension

Download **`web-latex-mcp.mcpb`** from the
[latest release](https://github.com/elias-ramzi/WebLatexMCP/releases/latest) and drag it onto the Claude
Desktop window (or **Settings → Extensions → Install Extension**). No cloning, building, or JSON editing —
Desktop shows a short, all-optional form (tokens, clone folder). See the
[Desktop Extension guide](docs/install/desktop-extension.md).

### Add your token and your project — from the chat

However you installed, the server needs a token for your git host — for Overleaf, a **Git authentication
token** from [Account Settings → Git integration](https://www.overleaf.com/user/settings). The private
way to hand it over, which **never puts the token in the chat**: ask Claude to open the credential portal.

> 👽 Open the credential portal for my Overleaf token.

`credential_portal` opens a local `127.0.0.1` page where you type the token; it goes straight into your
**OS keychain**, never through the conversation. (Happy to paste it once instead? `set_credential` stores
it in the keychain in a single step.)

Then add your project by just giving Claude the git URL — it registers it with `register_project`, and it
persists across restarts and sessions:

> 👽 Add my Overleaf project https://git.overleaf.com/… and call it "thesis".

Working on a `.tex` that is already on this machine? Give it a folder instead — no token, no remote, and
nothing is cloned ([details](docs/tools.md#local-in-place-projects)):

> 👽 Add the folder ~/papers/neurips as a local project called "paper".

### Other clients & full configuration

Prefer env vars (`WEB_LATEX_MCP_PROJECTS`, per-host tokens, workspace, compiler), or using **Gemini** /
**GitHub Copilot**? It's all in the docs: [Configuration](docs/configuration.md) · per-OS guides for
[macOS](docs/install/macos.md) / [Linux](docs/install/linux.md) / [Windows](docs/install/windows.md) ·
[Gemini](docs/install/gemini.md) · [Copilot](docs/install/copilot.md).

### Project-specific writing conventions

The bundled [writing guide](docs/writing-guide.md) is general — for a per-paper rule ("always write
lidar, never LiDAR", a house citation style), set `WEB_LATEX_MCP_WRITING_GUIDE_EXTRA` to a markdown file
(a plain path, or a `file:///...` URL, so you can paste a file link straight from Claude Desktop). It is
**additional**, not a replacement: it is appended after the base guide under a "Project-specific
conventions" heading, and wins where the two disagree. (Contrast `WEB_LATEX_MCP_WRITING_GUIDE`, which
_replaces_ the base guide outright — setting both is legal and means your replacement base plus your
extra on top.)

Point it at a per-paper `conventions.md` and Claude's `add_writing_convention` tool can append a rule to
it for you — "always write lidar, never LiDAR" becomes a bullet the model follows in later sessions
(new sessions only: MCP `instructions` are fixed at connect time, so a rule added mid-session takes
effect the next time you connect). `server_info` reports the configured path and whether it actually
loaded, so a typo in the path doesn't silently drop your conventions with nothing to tell you.

Scope the variable per project with a per-workspace MCP config `env` block — a `.mcp.json` in Claude
Code, or the equivalent in the Desktop config file — since the env var is per server process, not per
project.

## What you can do

Once connected, ask Claude to work on your project — it drives these [tools](docs/tools.md):

- **Set up** — register a project from the chat (a git URL, or a local folder), sync it, browse and read files.
- **Edit** — create, overwrite, or make surgical string-replacement edits, with the out-of-band-edit guard on. Rewriting a `.tex` paragraph preserves the original by commenting it out above the replacement, the way Overleaf users already do — controlled per project by `set_rewrite_mode` or `WEB_LATEX_MCP_REWRITE_MODE`, and per call by `edit_file`'s `preserveOriginal` (see [Tools](docs/tools.md#rewrite-preservation-mode)).
- **Compile** — `latexmk` or `tectonic`, locally, with structured errors and warnings, the source lines around each error (under `latexmk`; `tectonic`'s log names no `file:line`, so it yields none), and a clickable link to the PDF. `doctor` explains what your TeX installation is missing.
- **Cite** — search [DBLP](https://dblp.org) and add verified BibTeX entries; list the references you already have from a `.bib`, a `thebibliography`, or a markdown draft; and cross-check what the document cites against what the bibliography defines — including a shared bibliography in another registered project.
- **Review & push** — `status` and `diff` (over a `ref`, so a whole session is reviewable at once), then `commit` and `push`: rebase, never force, and a conflict comes back with both sides for you to resolve.
- **Remember a convention** — `add_writing_convention` appends one rule as a bullet to your configured project-specific writing guide (see [above](#project-specific-writing-conventions)), creating the file on first use. It takes no path — the destination is always the configured file — and the rule takes effect starting with your next session.

See the [full tool reference](docs/tools.md) for every parameter, the safety guards, and how conflicts,
shell-escape, and parallel sessions work.

## Skills

Task-specific skills that drive the tools — each stops at the diff, so nothing is committed or pushed
unless you ask:

- **`/format-latex-project`** — split the main file into per-section `\input`s, move each figure/table into its own `\input` file, and reflow to one sentence per line.
- **`/arxiv-clean-project`** — run [arxiv-latex-cleaner](https://github.com/google-research/arxiv-latex-cleaner) to strip comments and draft macros (`\todo`, notes) for arXiv, as a separate submission copy or applied in place.
- **`/verify-citations`** — audit a document's references against DBLP, flag discrepancies, and write a local audit report (read-only for the bibliography). Works on a `.bib`, a LaTeX `thebibliography`, or a markdown reference list — and on a local folder with no git remote.
- **`/format-bibliography`** — deduplicate, normalize cite keys, harmonize venues, propagate renames into `\cite`s.
- **`/proofread-document`** — hunt typos (spelling, doubled words, agreement, punctuation, LaTeX escapes) and report each as an exact minimal fix; applies nothing until you approve, and never rewrites prose for style.
- **`/review-writing-guide`** — review the paper against the [writing guide](docs/writing-guide.md) and report prioritized suggestions with a concrete rewrite each. Proposes, never applies — it writes nothing at all.
- **`/summarize-paper`** — write/update a small local summary of the paper (git-excluded) so future sessions start fast.
- **`/session-feedback`** — run it at the _end_ of a session to review what happened and write up what would improve the server itself: what broke, what took too many calls, what was missing, what the docs got wrong. Ranked by impact, scrubbed of your paper and your tokens, and emitted as ready-to-file issue bodies — the environment (version, OS, client, model, install method, toolchain) measured rather than guessed ([contributing](CONTRIBUTING.md#feedback-from-a-session)).

**How you get them depends on the client:**

- **Claude Code** — [install the plugin](#claude-code-cli-or-the-vs-code-extension)
  (or launch Claude Code from a clone of this repo). Claude picks a skill up on its own when your request
  matches it.
- **Any MCP client** — nothing to install. Every skill is also registered as an **MCP prompt**, so it
  ships with the server; pick it from the client's prompt menu (in Claude Desktop, the `+` in the
  composer) instead of typing `/`. Claude can also find and follow one on its own through the
  `list_skills` tool, without the skills being installed anywhere.
- **Claude Desktop / claude.ai**, for the same automatic behavior Claude Code gets — upload the skills to
  your account: zip each folder under [`.claude/skills/`](.claude/skills/), then upload them under
  **Customize → Skills → + → Create skill**. Needs a paid plan with code execution enabled, and an
  uploaded copy is a snapshot, so re-upload when a skill changes.

**In Claude Code, three of them have a faster front door.** [`/format-latex`](.claude/commands/format-latex.md),
[`/hunt-typo`](.claude/commands/hunt-typo.md), and [`/review-writing`](.claude/commands/review-writing.md) do the same
work as `format-latex-project`, `proofread-document`, and `review-writing-guide`, but fan the per-file reading out
across one subagent per file — cheaper, and parallel. They load the rules from the skill at run time rather than
restating them, so the skill stays the single source of truth and the two cannot drift. Subagents are a Claude Code
mechanism, so everywhere else the skill is the path, and it works on its own.

See the [skills guide](docs/skills.md) for what each skill does, [step-by-step installation](docs/skills.md#installing),
and [the two ways a skill runs](docs/skills.md#two-ways-a-skill-runs).

## Documentation

- [Configuration](docs/configuration.md) — environment variables, per-host token resolution, in-context guides, cross-platform notes.
- [Tools](docs/tools.md) — full tool reference, the DBLP citation flow, and how safe pushes work.
- [Skills](docs/skills.md) — what each bundled skill does, how to install it per client, and the two ways one runs.
- [Concurrency](docs/CONCURRENCY.md) — how the server pushes without clobbering edits made elsewhere, and how parallel sessions share one clone.
- [Writing guide](docs/writing-guide.md) — the LaTeX style conventions surfaced to the client.
- [Contributing](CONTRIBUTING.md) — how to build, test, and open a pull request.

## Contributing

This repo **accepts pull requests** — bug reports, feature ideas, docs fixes, and code changes are all
welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to get set up, run the local gate, and open a PR.

**Telling us how a session went is a contribution too**, and the fastest one to make. At the end of a
session spent working through the server, run the [`/session-feedback`](.claude/skills/session-feedback/SKILL.md)
skill: it looks back over the tool calls that actually ran — the ones that failed, the detours, the
guard that fired for the wrong reason, the thing you wanted and could not do — and writes a short,
ranked write-up. What comes back is **one ready-to-file issue body per finding**, in the same field
order as this repo's issue forms, carrying an environment block it _measured_ — server version (and
whether that is the latest), OS and architecture, Node, MCP client, model, install method, TeX
toolchain — asking you for the few facts a session cannot read about itself rather than inventing them.
It reports on the _server_, never on your paper: it edits nothing, commits nothing, pushes nothing, and
it strips tokens, paths, and manuscript content before printing, because the report is written to be
handed to a stranger. Paste a block into an issue, or say the word and `gh` files it. See
[Feedback from a session](CONTRIBUTING.md#feedback-from-a-session).

A note on maturity: this project is largely vibe-coded, so treat it as best-effort rather than
battle-tested. Robustness isn't guaranteed — expect rough edges, and please report them. It has been
mostly tested on these setups: VS Code + Claude Code extension, the Claude Code CLI, and Claude Desktop
for macOS.

## License

MIT

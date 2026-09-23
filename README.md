<div align="center">

<img src="assets/weblatexmcp-lockup-beta.svg" alt="WebLatexMCP — public beta" width="100%" />

# WebLatexMCP

**LaTeX without the round trip — Claude works on your real project, on your machine.**

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
> **Public beta — early development.** WebLatexMCP is now public, but it's in its early stages and
> under active development. Expect bugs, rough edges, and incomplete features. Editing and git operations
> touch real projects, so review diffs before you push. Please
> [report anything you run into](https://github.com/elias-ramzi/WebLatexMCP/issues) — bug reports and
> feedback are hugely welcome. Run [`/session-feedback`](.claude/skills/session-feedback/SKILL.md) at
> the end of a session and it writes the report for you.

---

Your paper is in Overleaf. Claude is in a chat window. Between them: copy, paste, compile, screenshot,
paste back.

**WebLatexMCP closes that loop.** An MCP server that hands Claude a real checkout of your project, so it
edits the actual `.tex`, compiles it on your machine, and reads the errors that come back — while you
watch the PDF reload beside it. Nothing is pushed until you say so.

## Highlights

- 🗂️ **Any project, with or without a remote** — Overleaf, GitHub, or a local folder.
- 🧪 **Local compiles** — two backends run on your machine: `latexmk`, which is what Overleaf runs, or `tectonic`.
- 👀 **Live PDF viewer + review comments** — a viewer that hot-reloads on every compile, in a browser or a **VS Code** tab. Select text in the PDF to leave a note, and Claude applies it at the right source line.
- 📚 **Citations checked, not trusted** — API (CrossRef, OpenAlex) calls to verify, or add citations.
- 🧩 **Bundled Claude Code skills** — project cleanup, typo hunting, writing-guide review, citation audits, bibliography normalization.
- 🔐 **Tokens stay in memory** — never written to `.git/config`, and scrubbed from all output.

## Install

### Claude Code (CLI or the VS Code extension)

Point Claude at this repo — the plugin registers the server **and** the [skills](#skills) in every
session, from any directory:

> 👽 Please setup the following MCP server https://github.com/elias-ramzi/WebLatexMCP

### Claude Desktop — one-click extension

Download **`web-latex-mcp.mcpb`** from the
[latest release](https://github.com/elias-ramzi/WebLatexMCP/releases/latest) and drag it onto the Claude
Desktop window (or **Settings → Extensions → Install Extension**). No cloning, building, or JSON editing —
Desktop shows a short, all-optional form (tokens, clone folder).

### Then, from the chat

Hand over a token and add your project. The token goes through a local page straight into your **OS
keychain** — never through the conversation:

> 👽 Open the credential portal for my Overleaf token, then add https://git.overleaf.com/… as "thesis".

Everything else — the npm package on its own, per-OS setup, TeX backends, other clients, iPad and
browser — is in the [installation guides](docs/install/README.md).

## Skills

Task-specific skills that drive the tools — each stops at the diff, so nothing is committed or pushed
unless you ask:

- **`/format-latex-project`** — split the main file into per-section `\input`s, move each figure/table into its own `\input` file, and reflow to one sentence per line.
- **`/arxiv-clean-project`** — run [arxiv-latex-cleaner](https://github.com/google-research/arxiv-latex-cleaner) to strip comments and draft macros (`\todo`, notes) for arXiv, as a separate submission copy or applied in place.
- **`/verify-citations`** — audit a document's references against DBLP, Crossref or OpenAlex, flag discrepancies, and write a local audit report.
- **`/format-bibliography`** — deduplicate, normalize cite keys, harmonize venues, propagate renames into `\cite`s.
- **`/proofread-document`** — hunt typos (spelling, doubled words, agreement, punctuation, LaTeX escapes).
- **`/review-writing-guide`** — review the paper against the [writing guide](docs/writing-guide.md) and report prioritized suggestions with a concrete rewrite each.
- **`/summarize-paper`** — write/update a small local summary of the paper (git-excluded) so future sessions start fast.

**How you get them depends on the client:**

- **Claude Code** — [install the plugin](#claude-code-cli-or-the-vs-code-extension), and Claude picks a skill up when your request matches it.
- **Any MCP client** — nothing to install: every skill ships with the server as an **MCP prompt**, in the client's prompt menu.
- **Claude Desktop / claude.ai** — for the same automatic behavior, zip each folder under [`.claude/skills/`](.claude/skills/) and upload them under **Customize → Skills**.

See the [skills guide](docs/skills.md) for what each skill does, [step-by-step installation](docs/skills.md#installing),
and [the two ways a skill runs](docs/skills.md#two-ways-a-skill-runs).

## Documentation

Everything above in depth: [Configuration](docs/configuration.md), [Tools](docs/tools.md), [Skills](docs/skills.md), [Concurrency](docs/CONCURRENCY.md), [Writing guide](docs/writing-guide.md)

## Contributing

This repo **accepts pull requests** — bug reports, feature ideas, docs fixes, and code changes are all
welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to get set up, run the local gate, and open a PR.

**Telling us how a session went is a contribution too**: run the
[`/session-feedback`](.claude/skills/session-feedback/SKILL.md) skill at the end of a session and it
writes up what to improve as ready-to-file issue bodies
([details](CONTRIBUTING.md#feedback-from-a-session)).

A note on maturity: this project is largely vibe-coded, so treat it as best-effort rather than
battle-tested. Robustness isn't guaranteed — expect rough edges, and please report them. It has been
mostly tested on these setups: VS Code + Claude Code extension, the Claude Code CLI, and Claude Desktop
for macOS.

## License

MIT

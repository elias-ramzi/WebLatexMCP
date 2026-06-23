<div align="center">

<img src="assets/LaTeX-MCP-lockup.svg" alt="latex-git-mcp" width="100%" />

# latex-git-mcp

**Read, edit, compile, and commit LaTeX in any git-hosted project — straight from Claude.**

[![CI](https://github.com/elias-ramzi/overleaf_mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/elias-ramzi/overleaf_mcp/actions/workflows/ci.yml)
&nbsp;
![Node ≥ 20](https://img.shields.io/badge/node-%E2%89%A5%2020-3C873A?logo=node.js&logoColor=white)
&nbsp;
![Platforms](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-444)
&nbsp;
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

</div>

---

An MCP server that lets Claude **read, edit, compile, and commit LaTeX** in a git-hosted project —
**Overleaf**, **GitHub**, or any git remote. It keeps a local clone, runs LaTeX compilation locally
(TeX Live + `latexmk`) so you see errors and PDFs without round-tripping, and sends changes back via an
explicit, reviewable commit → push to the repo's default branch. Works with both **Claude Desktop** and
**Claude Code** over stdio, on **macOS, Linux, and Windows**.

## Highlights

- 🗂️ **Multi-project** — Overleaf, GitHub, or any git remote, side by side, each with its own credentials.
- ✏️ **Surgical edits** — atomic, exact-match string replacements; read with optional line ranges.
- 🧪 **Local compiles** — `latexmk` runs on your machine and returns structured errors/warnings + the PDF.
- 🔍 **Reviewable pushes** — `commit` and `push` are separate steps; nothing leaves your machine implicitly.
- 🔐 **Tokens stay in memory** — never written to `.git/config`, and scrubbed from all output.
- 🧹 **One-command cleanup** — a bundled Claude Code skill splits a project into per-section `\input`s and reflows prose to one sentence per line.

## Install

**Step-by-step guides per OS:** [macOS](docs/install/macos.md) · [Linux](docs/install/linux.md) ·
[Windows](docs/install/windows.md) (see [`docs/install/`](docs/install/)). They cover prerequisites
(Node ≥ 20, git, optional `gh` + TeX Live/MiKTeX for `compile`), authentication, and registering the
server with Claude Code and Claude Desktop.

The short version — build, then register:

```bash
npm install && npm run build      # emits dist/index.js (the stdio entry point)
claude mcp add latex-git --scope user -- node /absolute/path/to/overleaf_mcp/dist/index.js
```

Editing and git operations work without TeX; only the `compile` tool needs `latexmk` on your `PATH`.

> **Tip:** `--scope user` makes the server active in every Claude Code session. To keep it active **only
> when you work inside this repo**, skip the CLI and drop a project-scoped `.mcp.json` in the
> `overleaf_mcp` repo root instead — Claude Code loads it only when launched from that directory (it's
> already gitignored, so your config never gets committed). See the [install guides](docs/install/).

## Configuration

Configured entirely through environment variables (set them in your MCP client's `env` block — see the
[install guides](docs/install/) for full `.mcp.json` / `claude_desktop_config.json` examples).

| Variable                                       | Required | Description                                                                                                                   |
| ---------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GIT_MCP_PROJECTS`                             | yes      | JSON map of project id → `{ gitUrl, rootFile?, branch?, username?, tokenEnv? }`.                                              |
| `GIT_MCP_WORKSPACE`                            | no       | Directory holding one clone per project. Default `~/.latex-git-mcp/projects`.                                                 |
| `GIT_MCP_DEFAULT_PROJECT`                      | no       | Project id used when a tool call omits `project`.                                                                             |
| `GIT_MCP_AUTHOR_NAME` / `GIT_MCP_AUTHOR_EMAIL` | no       | Identity used for commits. Default `LaTeX Git MCP <latex-git-mcp@localhost>`.                                                 |
| `GIT_MCP_WRITING_GUIDE`                        | no       | Path to a LaTeX writing guide surfaced to the client. Default bundled [`docs/writing-guide.md`](docs/writing-guide.md).       |
| `GIT_MCP_CONCURRENCY_GUIDE`                    | no       | Path to a concurrency / safe-push guide surfaced to the client. Default bundled [`docs/CONCURRENCY.md`](docs/CONCURRENCY.md). |

`GIT_MCP_PROJECTS` example — one Overleaf project and one GitHub repo:

```json
{
  "thesis": { "gitUrl": "https://git.overleaf.com/0123456789abcdef", "rootFile": "main.tex" },
  "paper": { "gitUrl": "https://github.com/me/paper", "branch": "main" }
}
```

(Find an Overleaf git URL under **Menu → Git** and a token under **Account Settings → Git authentication
token**. For GitHub, create a PAT under **Settings → Developer settings → Personal access tokens**.)

### Tokens — resolved per host

Tokens are used as the HTTPS password. For a project the server tries, in order: a per-project
`tokenEnv`, the host's token env (`GITHUB_TOKEN`, `GITLAB_TOKEN`, `OVERLEAF_GIT_TOKEN`, …), the generic
`GIT_MCP_TOKEN`, the **GitHub CLI** (`gh auth token`), then your **git credential helper**
(`git credential fill` — works on every OS). A project can override with its own `tokenEnv` and/or
`username`, so Overleaf and GitHub projects coexist with different credentials. The
[install guides](docs/install/) walk through each auth method per OS.

Tokens are injected into git operations **in memory only** — after cloning, the remote is reset to a
**tokenless** URL, so nothing lands in `.git/config`. Every known host token is scrubbed from error
messages and tool output. Git runs with `GIT_TERMINAL_PROMPT=0`, so a missing/expired credential fails
fast instead of hanging.

## Tools

All tools take an optional `project` id (defaults to `GIT_MCP_DEFAULT_PROJECT`). File paths are always
POSIX (`/`-separated), on every OS.

| Tool                | Description                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_projects`     | List configured projects and their clone status.                                                                                                               |
| `project_sync`      | Clone if missing, else fast-forward pull. Surfaces divergence instead of merging. Pass `gitUrl` to register a new project.                                     |
| `list_files`        | List files, filter `tex` / `bib` / `assets` / `all`.                                                                                                           |
| `read_file`         | Read a text file (optional line range). Binaries return a path, not bytes.                                                                                     |
| `write_file`        | Create or overwrite a file. A `.bib` target needs `confirmBibEdit: true` (see [Citations](#citations-via-dblp)).                                               |
| `edit_file`         | Surgical string-replacement edits (unique match unless `replaceAll`; atomic). A `.bib` target needs `confirmBibEdit: true`.                                    |
| `delete_file`       | Delete a file from the project. A `.bib` target needs `confirmBibEdit: true`.                                                                                  |
| `search_references` | Search DBLP for publications; returns candidates and their DBLP keys. Read-only.                                                                               |
| `add_citation`      | Fetch a reference from DBLP by key and append it to a `.bib` file. The only sanctioned way to add a citation.                                                  |
| `compile`           | Compile locally with latexmk; returns success, PDF path, structured errors/warnings + raw log tail.                                                            |
| `status`            | Branch, ahead/behind, staged/unstaged/untracked.                                                                                                               |
| `diff`              | Unified diff + per-file line counts.                                                                                                                           |
| `discard`           | Discard uncommitted changes (requires `confirm: true`).                                                                                                        |
| `commit`            | Stage and commit locally. Does **not** push.                                                                                                                   |
| `push`              | Safe push: pull-rebase onto the latest remote, then push (never force). Surfaces conflicts for a human; `mode: "branch"` for review. Requires `confirm: true`. |

### Citations via DBLP

References are added through a verified path, never hand-written. `.bib` files are **protected**:
`write_file`, `edit_file`, and `delete_file` refuse a `.bib` target unless you pass `confirmBibEdit: true`
— a guard so an agent can't quietly rewrite the bibliography. The tool tells the agent to ask you first;
set the flag only after you approve a manual change (removing or fixing an entry).

To add a reference, use the two-step DBLP flow:

1. `search_references` queries the [DBLP search API](https://dblp.org/faq/How+to+use+the+dblp+search+API.html)
   and returns candidates, each with a DBLP record `key`.
2. `add_citation` takes that key, **re-fetches the canonical BibTeX from DBLP server-side**, and appends it
   to the project's `.bib` (deduplicated by cite key — re-adding is a no-op). Because the entry text comes
   from DBLP and not the model, citations are verifiable rather than invented. With one `.bib` in the
   project it's chosen automatically; otherwise pass `bibFile`.

### Writing guide in context

At startup the server reads a LaTeX writing guide and surfaces it to the client two ways: as the MCP
`instructions` hint (so a client like Claude keeps it in context for the whole session — no need to ask
it to read the file) and as a fetchable **resource** at `guide://latex/writing-guide` (so you can
re-open it on demand and clients that ignore `instructions` can still reach it). The bundled
[`docs/writing-guide.md`](docs/writing-guide.md) covers tense, style, figures, equations, bibliography,
and English-usage conventions. Point `GIT_MCP_WRITING_GUIDE` at your own file to override it, or set it
to a non-existent path to ship no guide (the server logs to stderr and starts normally either way; with
no guide, neither the instructions nor the resource is advertised).

### Concurrency guide in context

The same way, the server surfaces a concurrency / safe-push guide as both the `instructions` hint and a
fetchable **resource** at `guide://latex/concurrency`. The bundled [`docs/CONCURRENCY.md`](docs/CONCURRENCY.md)
explains how this server pushes without clobbering edits made elsewhere (people editing in the Overleaf
web editor, or other agents). Override it with `GIT_MCP_CONCURRENCY_GUIDE`.

### Reviewable, safe pushes

`commit` and `push` are separate, and nothing pushes automatically. Review with `status` / `diff`,
`commit` locally, then `push` with `confirm: true`. Because people may also be editing in the Overleaf
web editor, `push` is **safe by default**: it `pull --rebase`s onto the latest remote (immediately before
pushing) and **never force-pushes**. A rebase conflict means the agent and a human touched the same lines —
`push` aborts the rebase and returns `status: "conflict"` with both versions, for a human to resolve; it
never auto-merges. For larger edits, `mode: "branch"` commits to a local review branch and returns its
diff, landing it only on `approve: true`. See [`docs/CONCURRENCY.md`](docs/CONCURRENCY.md) for the full model.

### Bundled skill — reformat an existing project

For **Claude Code**, the repo ships a [`format-latex-project`](.claude/skills/format-latex-project/SKILL.md)
skill that cleans up an existing project in two cosmetic-only passes: it splits the monolithic main file
into per-section `\input{sections/…}` files, and rewrites body paragraphs to **one sentence per line** (the
convention from [`docs/writing-guide.md`](docs/writing-guide.md), which keeps diffs small and edits
surgical). It compiles before and after as a guardrail — the PDF must be unchanged — and stops at the diff
so you review before any `commit`/`push`. Ask Claude to "format my Overleaf project" or invoke
`/format-latex-project`. The skill loads automatically when Claude Code is launched from this repo.

### Cross-platform notes

- File paths in tool output are POSIX (`/`), regardless of OS.
- Clones force `core.autocrlf=false`, so files keep their repo (LF) line endings and `edit_file`'s exact
  match is deterministic on Windows.
- Secrets come from env vars, the GitHub CLI, or your git credential helper — no OS-specific config.

## Development

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run format        # prettier --write
npm test              # vitest: unit + integration (bare-repo stand-in, no secrets)
npm run test:smoke    # full compile/loop smoke (needs latexmk; auto-skips otherwise)
```

CI (GitHub Actions) runs lint + typecheck + build + tests on **ubuntu, windows, and macos**, plus a
separate Linux job that installs a minimal TeX Live + `latexmk` (via `apt`) for the compile smoke.
Integration tests use a local bare repo as an Overleaf/GitHub stand-in, so **no secrets are ever needed**.

## License

MIT

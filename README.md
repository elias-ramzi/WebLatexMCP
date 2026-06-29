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
**Overleaf**, **GitHub**, or any git remote. It keeps a local clone, compiles locally (TeX Live +
`latexmk`) so you see errors and PDFs without round-tripping, and sends changes back through an explicit
commit → push you review first. Works with **Claude Desktop** and **Claude Code** over stdio, on
**macOS, Linux, and Windows**.

## Highlights

- 🗂️ **Multi-project** — Overleaf, GitHub, or any git remote, side by side, each with its own credentials.
- ✏️ **Surgical edits** — atomic, exact-match string replacements; read with optional line ranges.
- 🧪 **Local compiles** — `latexmk` runs on your machine and returns structured errors/warnings + the PDF.
- 🔍 **Reviewable pushes** — `commit` and `push` are separate; nothing leaves your machine implicitly.
- 🔐 **Tokens stay in memory** — never written to `.git/config`, and scrubbed from all output.
- 🧩 **Bundled Claude Code skills** — project cleanup, DBLP citation audits, bibliography normalization.

## Quick start

```bash
npm install && npm run build      # emits dist/index.js (the stdio entry point)
claude mcp add latex-git --scope user -- node /absolute/path/to/overleaf_mcp/dist/index.js
```

Then point the server at your projects with one environment variable:

```json
{
  "thesis": { "gitUrl": "https://git.overleaf.com/0123456789abcdef", "rootFile": "main.tex" },
  "paper": { "gitUrl": "https://github.com/me/paper", "branch": "main" }
}
```

Set that JSON as `GIT_MCP_PROJECTS` in your MCP client's `env` block. Editing and git operations work
without TeX; only `compile` needs `latexmk` on your `PATH`.

**Per-OS setup guides** (prerequisites, authentication, registering with Claude Code & Desktop):
[macOS](docs/install/macos.md) · [Linux](docs/install/linux.md) · [Windows](docs/install/windows.md).

## What you can do

Once connected, ask Claude to work on your project — it drives these [tools](docs/tools.md):

- **Sync & browse** — clone/pull a project, list and read files.
- **Edit** — create, overwrite, or make surgical string-replacement edits to `.tex` files.
- **Compile** — run `latexmk` locally and get back structured errors, warnings, and the PDF path.
- **Cite** — search [DBLP](https://dblp.org) and add verified BibTeX entries (`.bib` files are protected
  from hand-edits — see [Citations](docs/tools.md#citations-via-dblp)).
- **Review & push** — inspect `status` / `diff`, commit, then push safely (rebase, never force; conflicts
  come back to you).

See the [full tool reference](docs/tools.md).

## Skills (Claude Code)

Launched from this repo, Claude Code loads task-specific skills that drive the tools — each stops at the
diff, so nothing is committed or pushed unless you ask:

- **`/format-latex-project`** — split the main file into per-section `\input`s and reflow to one sentence per line.
- **`/verify-citations`** — audit every `.bib` entry against DBLP and flag discrepancies (read-only).
- **`/format-bibliography`** — deduplicate, normalize cite keys, harmonize venues, propagate renames into `\cite`s.

See the [skills guide](docs/skills.md) for details.

## Documentation

- [Configuration](docs/configuration.md) — environment variables, per-host token resolution, in-context guides, cross-platform notes.
- [Tools](docs/tools.md) — full tool reference, the DBLP citation flow, and how safe pushes work.
- [Skills](docs/skills.md) — what each bundled Claude Code skill does.
- [Concurrency](docs/CONCURRENCY.md) — how the server pushes without clobbering edits made elsewhere.
- [Writing guide](docs/writing-guide.md) — the LaTeX style conventions surfaced to the client.
- [Contributing](CONTRIBUTING.md) — how to build, test, and open a pull request.

## Contributing

This repo **accepts pull requests** — bug reports, feature ideas, docs fixes, and code changes are all
welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to get set up, run the local gate, and open a PR.

## License

MIT

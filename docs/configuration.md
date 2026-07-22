# Configuration

The server is configured entirely through **environment variables**, set in your MCP client's `env`
block (see the [install guides](install/) for full `.mcp.json` / `claude_desktop_config.json` examples).

## Environment variables

| Variable                                                   | Required | Description                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEB_LATEX_MCP_PROJECTS`                                   | yes      | JSON map of project id → `{ gitUrl, rootFile?, branch?, username?, tokenEnv? }`.                                                                                                                                                                                                 |
| `WEB_LATEX_MCP_WORKSPACE`                                  | no       | Directory holding one clone per project. Defaults to `<launch-dir>/.web_latex_mcp` when the launch dir is a git repo, else `~/.web-latex-mcp/projects` — see [Workspace-local clones](#workspace-local-clones). Set to `cwd` to force workspace-local, or to a path to override. |
| `WEB_LATEX_MCP_DEFAULT_PROJECT`                            | no       | Project id used when a tool call omits `project`.                                                                                                                                                                                                                                |
| `WEB_LATEX_MCP_COMPILER`                                   | no       | Local compile backend: `latexmk` (default) or `tectonic`. See [Compile backend](#compile-backend).                                                                                                                                                                               |
| `WEB_LATEX_MCP_AUTHOR_NAME` / `WEB_LATEX_MCP_AUTHOR_EMAIL` | no       | Identity used for commits. Default `WebLatexMCP <web-latex-mcp@localhost>`.                                                                                                                                                                                                      |
| `WEB_LATEX_MCP_WRITING_GUIDE`                              | no       | Path to a LaTeX writing guide surfaced to the client. Default bundled [`writing-guide.md`](writing-guide.md).                                                                                                                                                                    |
| `WEB_LATEX_MCP_CONCURRENCY_GUIDE`                          | no       | Path to a concurrency / safe-push guide surfaced to the client. Default bundled [`CONCURRENCY.md`](CONCURRENCY.md).                                                                                                                                                              |
| `WEB_LATEX_MCP_NO_OUTPUT_SCHEMA`                           | no       | Set to `1` to omit `outputSchema`/`structuredContent` from tool results — a workaround for Claude Desktop builds that silently drop calls to servers advertising an output schema. See [Claude Desktop compatibility](#claude-desktop-compatibility).                            |

### `WEB_LATEX_MCP_PROJECTS` example

One Overleaf project and one GitHub repo:

```json
{
  "thesis": { "gitUrl": "https://git.overleaf.com/0123456789abcdef", "rootFile": "main.tex" },
  "paper": { "gitUrl": "https://github.com/me/paper", "branch": "main" }
}
```

Find an Overleaf git URL under **Menu → Git** and a token under **Account Settings → Git authentication
token**. For GitHub, create a PAT under **Settings → Developer settings → Personal access tokens**.

## Workspace-local clones

When you drive the server from a coding agent (Claude Code, and other agents that spawn it over stdio
from your project directory), it's handy to have the LaTeX sitting **right beside the code** — so the
agent can open the `.tex` and the compiled PDF as ordinary workspace files, not only through MCP tools.

**This is the default whenever the launch dir is a git repo.** With no `WEB_LATEX_MCP_WORKSPACE` set,
clones land under `<workspace>/.web_latex_mcp/<project-id>/`, where `<workspace>` is the directory the
server was launched from (the agent's workspace root). On startup the server adds `.web_latex_mcp/` to
the host repo's **`.git/info/exclude`** (never the tracked `.gitignore`), so the LaTeX clones don't
show up as untracked files in your own repo.

In this mode `compile` also **surfaces the PDF** at `<workspace>/.web_latex_mcp/<project>.pdf` (a
sibling of the clone, so it never dirties the project's git), so you can open the latest build straight
from your editor rather than hunting through the temp build dir.

When the launch dir is **not** a git repo — or is your home directory — the default instead falls back
to the shared home cache `~/.web-latex-mcp/projects`. This keeps clients whose launch directory is
unpredictable (e.g. Claude Desktop, which may start at `/` or `~`) out of surprising locations.

To override the default:

```json
{ "env": { "WEB_LATEX_MCP_WORKSPACE": "cwd" } }
```

- `cwd` — force workspace-local even when the auto-detection wouldn't (e.g. a non-repo project dir).
- any **path** (absolute, `~`-relative, or relative to the launch dir) — use that exact directory as
  the shared clone root; nothing is git-excluded.

## Compile backend

The `compile` tool runs locally so you see errors and PDFs without round-tripping through Overleaf.
Two backends are supported; select with `WEB_LATEX_MCP_COMPILER`.

- **`latexmk`** (default) — drives your system TeX install (TeX Live / MacTeX / MiKTeX). This is what
  Overleaf itself runs, so it gives the closest "compiles here == compiles on Overleaf" guarantee and the
  broadest package/engine compatibility. Requires `latexmk` (and a TeX distribution) on your `PATH`.
- **`tectonic`** — a self-contained engine that bundles its own TeX and fetches packages on demand into a
  local cache. No multi-gigabyte TeX install needed, and builds are reproducible. Trade-offs: the first
  compile of a project needs network access to populate the cache, and tectonic is **XeTeX-only** — the
  `engine` argument (`pdflatex`/`xelatex`/`lualatex`) is ignored and the `clean` argument is a no-op.
  Documents that rely on pdfLaTeX-specific behavior may render differently. Requires `tectonic` on your
  `PATH` (`brew install tectonic`, `cargo install tectonic`, or see <https://tectonic-typesetting.github.io>).

Both return the same structured errors/warnings and PDF path, so switching backends changes nothing else.

## Tokens — resolved per host

Tokens are used as the HTTPS password. For a project the server tries, in order: a per-project
`tokenEnv`, the host's token env (`GITHUB_TOKEN`, `GITLAB_TOKEN`, `OVERLEAF_GIT_TOKEN`, …), the generic
`WEB_LATEX_MCP_TOKEN`, the **GitHub CLI** (`gh auth token`), then your **git credential helper**
(`git credential fill` — works on every OS). A project can override with its own `tokenEnv` and/or
`username`, so Overleaf and GitHub projects coexist with different credentials. The
[install guides](install/) walk through each auth method per OS.

Tokens are injected into git operations **in memory only** — after cloning, the remote is reset to a
**tokenless** URL, so nothing lands in `.git/config`. Every known host token is scrubbed from error
messages and tool output. Git runs with `GIT_TERMINAL_PROMPT=0`, so a missing/expired credential fails
fast instead of hanging.

## Guides surfaced to the client

At startup the server reads two guides and surfaces each to the client two ways: as the MCP
`instructions` hint (so a client like Claude keeps it in context for the whole session) and as a
fetchable **resource** (so you can re-open it on demand and clients that ignore `instructions` can still
reach it).

- **Writing guide** — resource `guide://latex/writing-guide`. The bundled
  [`writing-guide.md`](writing-guide.md) covers tense, style, figures, equations, bibliography, and
  English-usage conventions. Override with `WEB_LATEX_MCP_WRITING_GUIDE`.
- **Concurrency guide** — resource `guide://latex/concurrency`. The bundled [`CONCURRENCY.md`](CONCURRENCY.md)
  explains how the server pushes without clobbering edits made elsewhere (the Overleaf web editor, or
  other agents). Override with `WEB_LATEX_MCP_CONCURRENCY_GUIDE`.

Point a guide variable at your own file to override it, or at a non-existent path to ship no guide (the
server starts normally either way; with no guide, neither the instructions nor the resource is
advertised).

## Claude Desktop compatibility

Some Claude Desktop builds **silently fail to dispatch tool calls** to an MCP server whose tools
advertise an `outputSchema` (structured output): the server connects and its tools list fine, but every
call fails with a generic "Tool execution failed" and never reaches the server. If you hit that — and
other MCP servers work in the same app — set:

```json
{ "env": { "WEB_LATEX_MCP_NO_OUTPUT_SCHEMA": "1" } }
```

This drops `outputSchema` and the `structuredContent` field from tool results, leaving the
human-readable text content intact. It is **off by default**, since structured output is valuable for
clients that support it (e.g. Claude Code); it's a targeted workaround for the affected clients only.

## Cross-platform notes

- File paths in tool output are POSIX (`/`), regardless of OS.
- Clones force `core.autocrlf=false`, so files keep their repo (LF) line endings and `edit_file`'s exact
  match is deterministic on Windows.
- Secrets come from env vars, the GitHub CLI, or your git credential helper — no OS-specific config.

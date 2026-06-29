# Configuration

The server is configured entirely through **environment variables**, set in your MCP client's `env`
block (see the [install guides](install/) for full `.mcp.json` / `claude_desktop_config.json` examples).

## Environment variables

| Variable                                       | Required | Description                                                                                                         |
| ---------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `GIT_MCP_PROJECTS`                             | yes      | JSON map of project id → `{ gitUrl, rootFile?, branch?, username?, tokenEnv? }`.                                    |
| `GIT_MCP_WORKSPACE`                            | no       | Directory holding one clone per project. Default `~/.latex-git-mcp/projects`.                                       |
| `GIT_MCP_DEFAULT_PROJECT`                      | no       | Project id used when a tool call omits `project`.                                                                   |
| `GIT_MCP_AUTHOR_NAME` / `GIT_MCP_AUTHOR_EMAIL` | no       | Identity used for commits. Default `LaTeX Git MCP <latex-git-mcp@localhost>`.                                       |
| `GIT_MCP_WRITING_GUIDE`                        | no       | Path to a LaTeX writing guide surfaced to the client. Default bundled [`writing-guide.md`](writing-guide.md).       |
| `GIT_MCP_CONCURRENCY_GUIDE`                    | no       | Path to a concurrency / safe-push guide surfaced to the client. Default bundled [`CONCURRENCY.md`](CONCURRENCY.md). |

### `GIT_MCP_PROJECTS` example

One Overleaf project and one GitHub repo:

```json
{
  "thesis": { "gitUrl": "https://git.overleaf.com/0123456789abcdef", "rootFile": "main.tex" },
  "paper": { "gitUrl": "https://github.com/me/paper", "branch": "main" }
}
```

Find an Overleaf git URL under **Menu → Git** and a token under **Account Settings → Git authentication
token**. For GitHub, create a PAT under **Settings → Developer settings → Personal access tokens**.

## Tokens — resolved per host

Tokens are used as the HTTPS password. For a project the server tries, in order: a per-project
`tokenEnv`, the host's token env (`GITHUB_TOKEN`, `GITLAB_TOKEN`, `OVERLEAF_GIT_TOKEN`, …), the generic
`GIT_MCP_TOKEN`, the **GitHub CLI** (`gh auth token`), then your **git credential helper**
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
  English-usage conventions. Override with `GIT_MCP_WRITING_GUIDE`.
- **Concurrency guide** — resource `guide://latex/concurrency`. The bundled [`CONCURRENCY.md`](CONCURRENCY.md)
  explains how the server pushes without clobbering edits made elsewhere (the Overleaf web editor, or
  other agents). Override with `GIT_MCP_CONCURRENCY_GUIDE`.

Point a guide variable at your own file to override it, or at a non-existent path to ship no guide (the
server starts normally either way; with no guide, neither the instructions nor the resource is
advertised).

## Cross-platform notes

- File paths in tool output are POSIX (`/`), regardless of OS.
- Clones force `core.autocrlf=false`, so files keep their repo (LF) line endings and `edit_file`'s exact
  match is deterministic on Windows.
- Secrets come from env vars, the GitHub CLI, or your git credential helper — no OS-specific config.

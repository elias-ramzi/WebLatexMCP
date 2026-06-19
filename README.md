# latex-git-mcp

An MCP server that lets Claude **read, edit, compile, and commit LaTeX** in a git-hosted project —
**Overleaf**, **GitHub**, or any git remote. It keeps a local clone, runs LaTeX compilation locally
(TeX Live + `latexmk`) so you see errors and PDFs without round-tripping, and sends changes back via an
explicit, reviewable commit → push to the repo's default branch.

Works with both **Claude Desktop** and **Claude Code** over stdio.

## Requirements

- **Node.js ≥ 20** and **git**
- A git remote you can authenticate to over HTTPS with a token:
  - **Overleaf** (Premium): a Git authentication token, or
  - **GitHub**: a Personal Access Token (PAT) with repo access, or any other host.
- For local compilation: **TeX Live** with **`latexmk`** on your `PATH`
  (e.g. `brew install --cask mactex` or `sudo tlmgr install latexmk` on BasicTeX).
  Editing and git operations work without TeX; only the `compile` tool needs it.

## Install

```bash
npm install
npm run build      # emits dist/
```

This produces `dist/index.js`, the stdio entry point.

## Configuration

Configured entirely through environment variables (set them in your MCP client's `env` block).

| Variable                                       | Required | Description                                                                      |
| ---------------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `GIT_MCP_PROJECTS`                             | yes      | JSON map of project id → `{ gitUrl, rootFile?, branch?, username?, tokenEnv? }`. |
| `GIT_MCP_WORKSPACE`                            | no       | Directory holding one clone per project. Default `~/.latex-git-mcp/projects`.    |
| `GIT_MCP_DEFAULT_PROJECT`                      | no       | Project id used when a tool call omits `project`.                                |
| `GIT_MCP_AUTHOR_NAME` / `GIT_MCP_AUTHOR_EMAIL` | no       | Identity used for commits. Default `LaTeX Git MCP <latex-git-mcp@localhost>`.    |

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
`tokenEnv`, the host's token env (below), the generic `GIT_MCP_TOKEN`, the **GitHub CLI**
(`gh auth token`), then the macOS Keychain (service `latex-git-mcp`, account = host):

| host               | token env            | default username |
| ------------------ | -------------------- | ---------------- |
| `github.com`       | `GITHUB_TOKEN`       | `x-access-token` |
| `gitlab.com`       | `GITLAB_TOKEN`       | `oauth2`         |
| `git.overleaf.com` | `OVERLEAF_GIT_TOKEN` | `git`            |
| _any other_        | `GIT_MCP_TOKEN`      | `git`            |

A project can override with its own `tokenEnv` (names an env var holding the token) and/or `username`.
So Overleaf and GitHub projects coexist with different credentials.

**Using the GitHub CLI:** if [`gh`](https://cli.github.com) is installed and authenticated
(`gh auth login`), you can leave `GITHUB_TOKEN` unset — the server runs `gh auth token` to obtain a
token (injected in-memory, never persisted). It also works if you've run `gh auth setup-git` (gh becomes
git's credential helper). Git operations run with `GIT_TERMINAL_PROMPT=0`, so a missing or expired
credential fails fast instead of hanging. Note: for **Claude Desktop**, `gh` must be on the server
process's `PATH` (the GUI launcher may not provide your shell `PATH` — set it in the `env` block if so).

### Token security

- Tokens are injected into git operations **in memory only**. After cloning, the stored remote is reset
  to a **tokenless** URL — no credential lands in `.git/config`.
- Tokens are scrubbed from error messages and tool output (every known host token, not just the one used).
- **macOS Keychain** (so Claude Desktop, which can't expand `${VARS}`, avoids an inline token):

  ```bash
  security add-generic-password -s latex-git-mcp -a github.com -w   # prompts for the token
  ```

## Registering the server

### Claude Code

```bash
claude mcp add latex-git --scope user -- node /absolute/path/to/overleaf_mcp/dist/index.js
```

Set env via `-e KEY=value`, or a project-scoped `.mcp.json` (supports `${VAR}` expansion — commit it
without secrets):

```jsonc
{
  "mcpServers": {
    "latex-git": {
      "command": "node",
      "args": ["./dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}",
        "OVERLEAF_GIT_TOKEN": "${OVERLEAF_GIT_TOKEN}",
        "GIT_MCP_PROJECTS": "{\"paper\":{\"gitUrl\":\"https://github.com/me/paper\",\"branch\":\"main\"}}",
        "GIT_MCP_DEFAULT_PROJECT": "paper",
      },
    },
  },
}
```

Inspect with `/mcp`.

### Claude Desktop

Edit `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`) and **restart the app**. Desktop does
**not** expand env vars, so either inline tokens or use the Keychain:

```jsonc
{
  "mcpServers": {
    "latex-git": {
      "command": "node",
      "args": ["/absolute/path/to/overleaf_mcp/dist/index.js"],
      "env": {
        "GIT_MCP_PROJECTS": "{\"paper\":{\"gitUrl\":\"https://github.com/me/paper\",\"branch\":\"main\"}}",
        "GIT_MCP_DEFAULT_PROJECT": "paper",
        /* tokens omitted -> read from the macOS Keychain (account = host) */
      },
    },
  },
}
```

## Tools

All tools take an optional `project` id (defaults to `GIT_MCP_DEFAULT_PROJECT`).

| Tool            | Description                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `list_projects` | List configured projects and their clone status.                                                                           |
| `project_sync`  | Clone if missing, else fast-forward pull. Surfaces divergence instead of merging. Pass `gitUrl` to register a new project. |
| `list_files`    | List files, filter `tex` / `bib` / `assets` / `all`.                                                                       |
| `read_file`     | Read a text file (optional line range). Binaries return a path, not bytes.                                                 |
| `write_file`    | Create or overwrite a file.                                                                                                |
| `edit_file`     | Surgical string-replacement edits (unique match unless `replaceAll`; atomic).                                              |
| `delete_file`   | Delete a file from the project.                                                                                            |
| `compile`       | Compile locally with latexmk; returns success, PDF path, structured errors/warnings + raw log tail.                        |
| `status`        | Branch, ahead/behind, staged/unstaged/untracked.                                                                           |
| `diff`          | Unified diff + per-file line counts.                                                                                       |
| `discard`       | Discard uncommitted changes (requires `confirm: true`).                                                                    |
| `commit`        | Stage and commit locally. Does **not** push.                                                                               |
| `push`          | Push committed changes to the default branch (requires `confirm: true`; refuses if behind).                                |

### Reviewable, never-surprising pushes

`commit` and `push` are separate, and nothing pushes automatically. Review with `status` / `diff`,
`commit` locally, then `push` with `confirm: true`. `push` targets the repo's default branch and refuses
if the local clone is behind or diverged — run `project_sync` first. (Feature-branch and Pull-Request
workflows are intentionally out of scope.)

## Development

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run format        # prettier --write
npm test              # vitest: unit + integration (bare-repo stand-in, no secrets)
npm run test:smoke    # full compile/loop smoke (needs latexmk; auto-skips otherwise)
```

CI (GitHub Actions) runs lint + typecheck + build + tests on every push/PR, with a separate job that
installs a minimal TeX Live (`scheme-basic` + `latexmk`) for the compile smoke. Integration tests use a
local bare repo as an Overleaf/GitHub stand-in, so **no secrets are ever needed** for the standard run.

## License

MIT

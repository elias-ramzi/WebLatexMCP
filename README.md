# overleaf-mcp

An MCP server that lets Claude **read, edit, compile, and commit LaTeX** in an Overleaf
project through Overleaf's Git remote. It keeps a local clone of the project, runs LaTeX
compilation locally (TeX Live + `latexmk`) so you see errors and PDFs without round-tripping
through Overleaf, and sends changes back via an explicit, reviewable commit → push.

Works with both **Claude Desktop** and **Claude Code** over stdio.

## Requirements

- **Node.js ≥ 20** and **git**
- An **Overleaf Premium** project with Git access, and a Git authentication token
- For local compilation: **TeX Live** with **`latexmk`** on your `PATH`
  (e.g. `brew install --cask mactex` or `sudo tlmgr install latexmk` on top of BasicTeX).
  Editing and git operations work without TeX; only the `compile` tool needs it.

## Install

```bash
npm install
npm run build      # emits dist/
```

This produces `dist/index.js`, the stdio entry point.

## Configuration

The server is configured entirely through environment variables (set them in your MCP
client's `env` block — see below).

| Variable                                                 | Required            | Description                                                                                 |
| -------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------- |
| `OVERLEAF_MCP_PROJECTS`                                  | yes                 | JSON map of project id → `{ "gitUrl": "...", "rootFile"?: "..." }`.                         |
| `OVERLEAF_GIT_TOKEN`                                     | for private remotes | Overleaf git token (used as the HTTPS password). Falls back to the macOS Keychain if unset. |
| `OVERLEAF_MCP_WORKSPACE`                                 | no                  | Directory holding one clone per project. Default `~/.overleaf-mcp/projects`.                |
| `OVERLEAF_MCP_DEFAULT_PROJECT`                           | no                  | Project id used when a tool call omits `project`.                                           |
| `OVERLEAF_GIT_USERNAME`                                  | no                  | HTTPS username (Overleaf accepts any value with token-as-password). Default `git`.          |
| `OVERLEAF_GIT_AUTHOR_NAME` / `OVERLEAF_GIT_AUTHOR_EMAIL` | no                  | Identity used for commits. Default `Overleaf MCP <overleaf-mcp@localhost>`.                 |

Example `OVERLEAF_MCP_PROJECTS`:

```json
{ "thesis": { "gitUrl": "https://git.overleaf.com/0123456789abcdef", "rootFile": "main.tex" } }
```

Find your project's git URL in Overleaf under **Menu → Git**, and generate a token under
**Account Settings → Git authentication token**.

### Token security

- The token is read from the environment (or the macOS Keychain) and injected into git
  operations **in memory only**. After cloning, the stored remote is reset to a **tokenless**
  URL — your token never lands in `.git/config`.
- Tokens are scrubbed from error messages and tool output.
- To use the **macOS Keychain** instead of an env var (recommended for Claude Desktop, which
  cannot expand `${VARS}` in its config):

  ```bash
  security add-generic-password -s overleaf-mcp -a "$USER" -w   # prompts for the token
  ```

## Registering the server

### Claude Code

```bash
claude mcp add overleaf --scope user -- node /absolute/path/to/overleaf_mcp/dist/index.js
```

Set env via `-e KEY=value` flags, or hand-edit a project-scoped `.mcp.json` (which supports
`${VAR}` expansion, so you can commit it without the token):

```jsonc
{
  "mcpServers": {
    "overleaf": {
      "command": "node",
      "args": ["./dist/index.js"],
      "env": {
        "OVERLEAF_GIT_TOKEN": "${OVERLEAF_GIT_TOKEN}",
        "OVERLEAF_MCP_PROJECTS": "{\"thesis\":{\"gitUrl\":\"https://git.overleaf.com/<id>\"}}",
        "OVERLEAF_MCP_DEFAULT_PROJECT": "thesis",
      },
    },
  },
}
```

Inspect with `/mcp`.

### Claude Desktop

Edit `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`) and **restart the app**.
Desktop does **not** expand env vars, so either inline the token or use the Keychain:

```jsonc
{
  "mcpServers": {
    "overleaf": {
      "command": "node",
      "args": ["/absolute/path/to/overleaf_mcp/dist/index.js"],
      "env": {
        "OVERLEAF_MCP_PROJECTS": "{\"thesis\":{\"gitUrl\":\"https://git.overleaf.com/<id>\"}}",
        "OVERLEAF_MCP_DEFAULT_PROJECT": "thesis",
        /* OVERLEAF_GIT_TOKEN omitted -> read from the macOS Keychain */
      },
    },
  },
}
```

## Tools

All tools take an optional `project` id (defaults to `OVERLEAF_MCP_DEFAULT_PROJECT`).

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
| `push`          | Push committed changes to Overleaf (requires `confirm: true`; refuses if behind).                                          |

### Reviewable, never-surprising pushes

`commit` and `push` are separate, and nothing pushes automatically. Review with `status` /
`diff`, `commit` locally, then `push` with `confirm: true`. `push` refuses if the local clone
is behind or diverged — run `project_sync` first.

## Development

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run format        # prettier --write
npm test              # vitest: unit + integration (bare-repo stand-in, no secrets)
npm run test:smoke    # full compile/loop smoke (needs latexmk; auto-skips otherwise)
```

CI (GitHub Actions) runs lint + typecheck + build + tests on every push/PR, with a separate
job that installs a minimal TeX Live (`scheme-basic` + `latexmk`) for the compile smoke.
Integration tests use a local bare repo as an Overleaf stand-in, so **no secrets are ever
needed** for the standard test run.

## License

MIT

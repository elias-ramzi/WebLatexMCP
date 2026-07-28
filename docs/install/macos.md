# WebLatexMCP on macOS

Setup for both **Claude Code** and **Claude Desktop**. Replace `/path/to/WebLatexMCP` with the real
absolute path wherever it appears.

## 1. Prerequisites

```bash
brew install node git        # Node.js >= 20 and git
brew install gh              # optional: GitHub CLI for token-free auth
```

For the `compile` tool only, install TeX + `latexmk`:

```bash
brew install --cask mactex   # full TeX Live (large)
# or BasicTeX (small):
#   brew install --cask basictex
#   sudo tlmgr update --self && sudo tlmgr install latexmk
```

Verify:

```bash
node --version && git --version && latexmk -v
```

## 2. Build the server

```bash
git clone https://github.com/elias-ramzi/WebLatexMCP.git
cd WebLatexMCP
npm install
npm run build
pwd            # note this absolute path; dist/index.js lives under it
```

## 3. Authentication

The server resolves a token per host in this order: per-project `tokenEnv` → host env (`GITHUB_TOKEN`,
`OVERLEAF_GIT_TOKEN`, …) → `WEB_LATEX_MCP_TOKEN` → `gh auth token` → `git credential fill`. Pick one:

- **Env var** (simplest): set `GITHUB_TOKEN` / `OVERLEAF_GIT_TOKEN` in the client `env` block (below).
- **GitHub CLI**: `gh auth login`, then leave `GITHUB_TOKEN` unset.
- **macOS Keychain via git** (`credential.helper osxkeychain` is the default):

  ```bash
  printf 'protocol=https\nhost=github.com\nusername=x\npassword=<TOKEN>\n\n' | git credential approve
  ```

## 4a. Claude Code

```bash
claude mcp add web-latex-mcp --scope user \
  -e WEB_LATEX_MCP_PROJECTS='{"paper":{"gitUrl":"https://github.com/me/paper","branch":"main"}}' \
  -e WEB_LATEX_MCP_DEFAULT_PROJECT=paper \
  -e GITHUB_TOKEN=ghp_xxx \
  -- node /path/to/WebLatexMCP/dist/index.js
```

(Drop the `GITHUB_TOKEN` line if you use `gh` or the Keychain from step 3.) Check it with `/mcp`.

**Scope it to this repo instead.** `--scope user` registers the server for every Claude Code session.
To keep it active **only when you work inside the `WebLatexMCP` repo**, drop a project-scoped
`.mcp.json` in the repo root instead — Claude Code loads it only when launched from that directory:

```json
{
  "mcpServers": {
    "web-latex-mcp": {
      "command": "node",
      "args": ["./dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}",
        "WEB_LATEX_MCP_PROJECTS": "{\"paper\":{\"gitUrl\":\"https://github.com/me/paper\",\"branch\":\"main\"}}",
        "WEB_LATEX_MCP_DEFAULT_PROJECT": "paper"
      }
    }
  }
}
```

`${VAR}` expansion keeps the token in your environment. The repo's `.gitignore` already excludes a local
`.mcp.json`, so your config never gets committed.

## 4b. Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`, then **restart Claude Desktop**:

```json
{
  "mcpServers": {
    "web-latex-mcp": {
      "command": "node",
      "args": ["/path/to/WebLatexMCP/dist/index.js"],
      "env": {
        "WEB_LATEX_MCP_PROJECTS": "{\"paper\":{\"gitUrl\":\"https://github.com/me/paper\",\"branch\":\"main\"}}",
        "WEB_LATEX_MCP_DEFAULT_PROJECT": "paper"
      }
    }
  }
}
```

Desktop does **not** expand `${VARS}`, so either inline `"GITHUB_TOKEN": "ghp_xxx"` or rely on `gh` /
the Keychain helper from step 3.

**Projects without touching this file.** Editing the Desktop config and restarting each time is
awkward, so you don't have to list projects here at all — once the server is registered, just paste your
Overleaf git URL into the chat and ask Claude to add the project. It calls `register_project`, which
persists it (survives restarts, shared across sessions). For the **token**, paste it to Claude too and
ask it to store the credential (`set_credential` puts it in your Keychain), or use the `env` block /
credential helper above — it is never stored with the project. See
[Registering a project without env config](../configuration.md#registering-a-project-without-env-config)
and [Registering credentials in Claude Desktop](../configuration.md#registering-credentials-in-claude-desktop).

## 5. PATH note (important for Claude Desktop)

The macOS GUI launches Claude Desktop with a **minimal `PATH`**, so `node`, `git`, `gh`, and `latexmk`
(in `/Library/TeX/texbin`, `/opt/homebrew/bin`, …) may not be found. Fix either way:

- use absolute commands: `"command": "/opt/homebrew/bin/node"`, or
- add a `PATH` to the `env` block:

  ```jsonc
  "env": { "PATH": "/opt/homebrew/bin:/Library/TeX/texbin:/usr/bin:/bin" }
  ```

Claude Code inherits your shell `PATH`, so this isn't needed there.

## 6. Verify

Ask Claude to run `project_sync` then `list_files`. To smoke-test the server directly:

```bash
WEB_LATEX_MCP_PROJECTS='{}' node /path/to/WebLatexMCP/dist/index.js
```

It logs `server ready on stdio` to stderr and waits for JSON-RPC (Ctrl-C to quit).

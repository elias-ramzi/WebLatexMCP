# latex-git-mcp on macOS

Setup for both **Claude Code** and **Claude Desktop**. Replace `/path/to/overleaf_mcp` with the real
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
git clone https://github.com/elias-ramzi/overleaf_mcp.git
cd overleaf_mcp
npm install
npm run build
pwd            # note this absolute path; dist/index.js lives under it
```

## 3. Authentication

The server resolves a token per host in this order: per-project `tokenEnv` → host env (`GITHUB_TOKEN`,
`OVERLEAF_GIT_TOKEN`, …) → `GIT_MCP_TOKEN` → `gh auth token` → `git credential fill`. Pick one:

- **Env var** (simplest): set `GITHUB_TOKEN` / `OVERLEAF_GIT_TOKEN` in the client `env` block (below).
- **GitHub CLI**: `gh auth login`, then leave `GITHUB_TOKEN` unset.
- **macOS Keychain via git** (`credential.helper osxkeychain` is the default):

  ```bash
  printf 'protocol=https\nhost=github.com\nusername=x\npassword=<TOKEN>\n\n' | git credential approve
  ```

## 4a. Claude Code

```bash
claude mcp add latex-git --scope user \
  -e GIT_MCP_PROJECTS='{"paper":{"gitUrl":"https://github.com/me/paper","branch":"main"}}' \
  -e GIT_MCP_DEFAULT_PROJECT=paper \
  -e GITHUB_TOKEN=ghp_xxx \
  -- node /path/to/overleaf_mcp/dist/index.js
```

(Drop the `GITHUB_TOKEN` line if you use `gh` or the Keychain from step 3.) Check it with `/mcp`.

**Scope it to this repo instead.** `--scope user` registers the server for every Claude Code session.
To keep it active **only when you work inside the `overleaf_mcp` repo**, drop a project-scoped
`.mcp.json` in the repo root instead — Claude Code loads it only when launched from that directory:

```jsonc
// overleaf_mcp/.mcp.json
{
  "mcpServers": {
    "latex-git": {
      "command": "node",
      "args": ["./dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}",
        "GIT_MCP_PROJECTS": "{\"paper\":{\"gitUrl\":\"https://github.com/me/paper\",\"branch\":\"main\"}}",
        "GIT_MCP_DEFAULT_PROJECT": "paper",
      },
    },
  },
}
```

`${VAR}` expansion keeps the token in your environment. The repo's `.gitignore` already excludes a local
`.mcp.json`, so your config never gets committed.

## 4b. Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`, then **restart Claude Desktop**:

```jsonc
{
  "mcpServers": {
    "latex-git": {
      "command": "node",
      "args": ["/path/to/overleaf_mcp/dist/index.js"],
      "env": {
        "GIT_MCP_PROJECTS": "{\"paper\":{\"gitUrl\":\"https://github.com/me/paper\",\"branch\":\"main\"}}",
        "GIT_MCP_DEFAULT_PROJECT": "paper",
      },
    },
  },
}
```

Desktop does **not** expand `${VARS}`, so either inline `"GITHUB_TOKEN": "ghp_xxx"` or rely on `gh` /
the Keychain helper from step 3.

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
GIT_MCP_PROJECTS='{}' node /path/to/overleaf_mcp/dist/index.js
```

It logs `server ready on stdio` to stderr and waits for JSON-RPC (Ctrl-C to quit).

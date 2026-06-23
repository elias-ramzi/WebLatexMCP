# latex-git-mcp on Linux

Setup for **Claude Code** (and notes for **Claude Desktop**, which has no official Linux build). Replace
`/path/to/overleaf_mcp` with the real absolute path wherever it appears. Commands below use Debian/Ubuntu
`apt`; use your distro's package manager equivalently.

## 1. Prerequisites

- **Node.js >= 20.** Distro packages are often old — prefer [nvm](https://github.com/nvm-sh/nvm) or
  [NodeSource](https://github.com/nodesource/distributions):

  ```bash
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
  ```

- **git** (and optionally **gh**):

  ```bash
  sudo apt install -y git gh
  ```

For the `compile` tool only, install TeX + `latexmk`:

```bash
sudo apt install -y texlive texlive-latex-extra latexmk
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
- **git credential helper.** For persistent encrypted storage use libsecret (GNOME Keyring / KWallet):

  ```bash
  sudo apt install -y libsecret-1-0 libsecret-tools
  git config --global credential.helper libsecret
  printf 'protocol=https\nhost=github.com\nusername=x\npassword=<TOKEN>\n\n' | git credential approve
  ```

  If `git-credential-libsecret` isn't packaged on your distro, `gh` or an env var is the easiest path.
  (`credential.helper store` also works but writes a plaintext `~/.git-credentials`.)

## 4a. Claude Code

```bash
claude mcp add latex-git --scope user \
  -e GIT_MCP_PROJECTS='{"paper":{"gitUrl":"https://github.com/me/paper","branch":"main"}}' \
  -e GIT_MCP_DEFAULT_PROJECT=paper \
  -e GITHUB_TOKEN=ghp_xxx \
  -- node /path/to/overleaf_mcp/dist/index.js
```

(Drop the `GITHUB_TOKEN` line if you use `gh` or a credential helper from step 3.) Check it with `/mcp`.
Claude Code inherits your shell `PATH`, so `node`/`git`/`gh`/`latexmk` are found as usual.

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

There is **no official Claude Desktop build for Linux** — use **Claude Code** (above) on Linux. If you run
an unofficial/community Electron build, its config typically lives at
`~/.config/Claude/claude_desktop_config.json` and uses the same shape:

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

A desktop app launched from a `.desktop` launcher may have a reduced `PATH`; if `node` isn't found, use an
absolute command (e.g. `"command": "/home/you/.nvm/versions/node/v22.x/bin/node"`) or add a `PATH` entry
to `env`.

## 5. Verify

Ask Claude to run `project_sync` then `list_files`. To smoke-test the server directly:

```bash
GIT_MCP_PROJECTS='{}' node /path/to/overleaf_mcp/dist/index.js
```

It logs `server ready on stdio` to stderr and waits for JSON-RPC (Ctrl-C to quit).

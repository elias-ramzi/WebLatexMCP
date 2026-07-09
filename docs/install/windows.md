# WebLatexMCP on Windows

Setup for both **Claude Code** and **Claude Desktop**. Commands are for **PowerShell**. Replace
`C:/Users/you/WebLatexMCP` with the real path wherever it appears, and **use forward slashes in JSON**
to avoid backslash escaping.

> Using **WSL**? Treat it as Linux — follow [linux.md](linux.md) inside the WSL shell.

## 1. Prerequisites

```powershell
winget install OpenJS.NodeJS.LTS    # Node.js >= 20
winget install Git.Git              # git (includes Git Credential Manager)
winget install GitHub.cli           # optional: GitHub CLI
```

For the `compile` tool only, install TeX with `latexmk` (MiKTeX bundles it):

```powershell
winget install MiKTeX.MiKTeX        # or TeX Live
```

Open a **new** terminal so `PATH` updates apply, then verify:

```powershell
node --version; git --version; latexmk -v
```

## 2. Build the server

```powershell
git clone https://github.com/elias-ramzi/WebLatexMCP.git
cd WebLatexMCP
npm install
npm run build
```

`dist/index.js` is now under the repo folder; note its full path (e.g. `C:/Users/you/WebLatexMCP`).

## 3. Authentication

The server resolves a token per host in this order: per-project `tokenEnv` → host env (`GITHUB_TOKEN`,
`OVERLEAF_GIT_TOKEN`, …) → `GIT_MCP_TOKEN` → `gh auth token` → `git credential fill`. Pick one:

- **Env var** (simplest): set `GITHUB_TOKEN` / `OVERLEAF_GIT_TOKEN` in the client `env` block (below).
- **GitHub CLI**: `gh auth login`, then leave `GITHUB_TOKEN` unset.
- **Git Credential Manager** (installed with Git for Windows, `credential.helper manager`): the easiest
  route is to let it prompt on your first `git clone`/`push` of the repo. To store a token directly:

  ```powershell
  "protocol=https`nhost=github.com`nusername=x`npassword=<TOKEN>`n`n" | git credential approve
  ```

## 4a. Claude Code

Works in PowerShell, cmd, and WSL. Because shell quoting of JSON is fiddly on Windows, the easiest path is
a project-scoped `.mcp.json`. Put it in the **`WebLatexMCP` repo root** so the server is active **only
when you work inside this repo** — Claude Code loads `.mcp.json` only when launched from that directory:

```jsonc
// WebLatexMCP/.mcp.json
{
  "mcpServers": {
    "web-latex-mcp": {
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

`${VAR}` expansion is supported in Claude Code, so the token stays in your environment. The repo's
`.gitignore` already excludes a local `.mcp.json`, so your config never gets committed. Or, to register
the server **globally** (active in every session, not just inside this repo), use the CLI:

```powershell
claude mcp add web-latex-mcp --scope user `
  -e GIT_MCP_DEFAULT_PROJECT=paper `
  -- node C:/Users/you/WebLatexMCP/dist/index.js
```

Check it with `/mcp`.

## 4b. Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json`
(i.e. `C:\Users\you\AppData\Roaming\Claude\claude_desktop_config.json`), then **restart Claude Desktop**:

```jsonc
{
  "mcpServers": {
    "web-latex-mcp": {
      "command": "node",
      "args": ["C:/Users/you/WebLatexMCP/dist/index.js"],
      "env": {
        "GIT_MCP_PROJECTS": "{\"paper\":{\"gitUrl\":\"https://github.com/me/paper\",\"branch\":\"main\"}}",
        "GIT_MCP_DEFAULT_PROJECT": "paper",
      },
    },
  },
}
```

Desktop does **not** expand `${VARS}`, so either inline `"GITHUB_TOKEN": "ghp_xxx"` or rely on `gh` /
Git Credential Manager from step 3.

## 5. PATH note

Windows GUI apps generally inherit the user `PATH`, so `node`, `git`, `gh`, and `latexmk` are usually
found by Claude Desktop. If `node` isn't found, point `command` at the full path
(e.g. `"C:/Program Files/nodejs/node.exe"`) or add a `PATH` entry to the `env` block.

## 6. Verify

Ask Claude to run `project_sync` then `list_files`. To smoke-test the server directly:

```powershell
$env:GIT_MCP_PROJECTS='{}'; node C:/Users/you/WebLatexMCP/dist/index.js
```

It logs `server ready on stdio` to stderr and waits for JSON-RPC (Ctrl-C to quit).

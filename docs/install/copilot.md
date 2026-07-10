# WebLatexMCP with GitHub Copilot

WebLatexMCP is a standard MCP server over **stdio**, so it works with GitHub Copilot's **agent mode**
with no code changes — only registration. The most tested surface is **Copilot in VS Code**; the same
server also works with **Copilot in Visual Studio 2022** (see the note at the end).

For **prerequisites** (Node.js ≥ 20, git, and TeX + `latexmk`/`tectonic` for the `compile` tool only)
and for **authentication** (per-host token resolution: env var → `gh auth token` → git credential
helper), follow steps 1–3 of your platform guide — they are client-agnostic:
[macOS](macos.md) · [Linux](linux.md) · [Windows](windows.md). This guide picks up at registration.

> **Agent mode required.** MCP tools are only available in Copilot Chat's **Agent** mode. Open Copilot
> Chat and switch the mode dropdown from _Ask_/_Edit_ to **Agent**.

## Where the config lives

VS Code reads MCP servers from either of two places — note Copilot uses the key `"servers"`, **not**
`"mcpServers"`:

- **Workspace:** `.vscode/mcp.json` in the repo — active only when that folder is open, and shareable
  with a team by committing it.
- **User (global):** run **`MCP: Open User Configuration`** from the Command Palette to edit a user-level
  `mcp.json` — active in every workspace.

## Register with `npx` (no clone, no build)

Create `.vscode/mcp.json` in your project (or open the user configuration) with:

```json
{
  "servers": {
    "web-latex-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "web-latex-mcp"],
      "env": {
        "WEB_LATEX_MCP_PROJECTS": "{\"paper\":{\"gitUrl\":\"https://github.com/me/paper\",\"branch\":\"main\"}}",
        "WEB_LATEX_MCP_DEFAULT_PROJECT": "paper",
        "GITHUB_TOKEN": "${env:GITHUB_TOKEN}"
      }
    }
  }
}
```

`${env:VAR}` reads from your environment, so the token stays out of the file. Drop the `GITHUB_TOKEN`
line entirely if you authenticate with `gh` or a git credential helper (steps in the platform guides).

After saving, VS Code shows a **Start** action above the server entry; click it (or run
**`MCP: List Servers`** → _Start_) to launch the server.

For an Overleaf project, use its Git URL and token instead:

```json
"WEB_LATEX_MCP_PROJECTS": "{\"thesis\":{\"gitUrl\":\"https://git.overleaf.com/0123456789abcdef\",\"rootFile\":\"main.tex\"}}",
"OVERLEAF_GIT_TOKEN": "${env:OVERLEAF_GIT_TOKEN}"
```

See [Configuration](../configuration.md) for every environment variable and the full token-resolution
order.

## Prompt for the token instead of reading the environment

To have VS Code ask for the token once (stored in its secret storage) rather than pulling it from the
environment, add an `inputs` block and reference it with `${input:…}`:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "web-latex-token",
      "description": "Git token for WebLatexMCP",
      "password": true
    }
  ],
  "servers": {
    "web-latex-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "web-latex-mcp"],
      "env": {
        "WEB_LATEX_MCP_PROJECTS": "{\"paper\":{\"gitUrl\":\"https://github.com/me/paper\",\"branch\":\"main\"}}",
        "GITHUB_TOKEN": "${input:web-latex-token}"
      }
    }
  }
}
```

## Register from a local clone

If you cloned and built the repo (platform guide, step 2), point Copilot at `dist/index.js` instead of
`npx`:

```json
{
  "servers": {
    "web-latex-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/WebLatexMCP/dist/index.js"],
      "env": {
        "WEB_LATEX_MCP_PROJECTS": "{\"paper\":{\"gitUrl\":\"https://github.com/me/paper\",\"branch\":\"main\"}}",
        "WEB_LATEX_MCP_DEFAULT_PROJECT": "paper",
        "GITHUB_TOKEN": "${env:GITHUB_TOKEN}"
      }
    }
  }
}
```

## Verify

1. Run **`MCP: List Servers`** from the Command Palette — `web-latex-mcp` should show as **Running**,
   and its output channel logs `server ready on stdio`.
2. Open Copilot Chat in **Agent** mode and click the **tools** (🛠) icon — the WebLatexMCP tools
   (`project_sync`, `list_files`, `read_file`, `compile`, `status`, `push`, …) should be listed and
   toggleable.
3. Ask Copilot to run `project_sync` then `list_files` on your project.

To smoke-test the server on its own, without Copilot:

```bash
WEB_LATEX_MCP_PROJECTS='{}' npx -y web-latex-mcp
```

It logs `server ready on stdio` to **stderr** and waits for JSON-RPC (Ctrl-C to quit).

## Notes specific to Copilot

- **Tool confirmations.** Copilot asks for confirmation before running a tool the first time; you can
  choose to allow a tool for the session or workspace. Mutating tools (`write_file`, `commit`, `push`,
  …) always surface, so review before allowing.
- **Schema compatibility.** Every WebLatexMCP tool uses only plain strings, numbers, booleans, and enums
  for its inputs, so all tools register cleanly in Copilot's tool picker.
- **In-context guides.** The writing and concurrency guides are surfaced both as MCP `instructions` and
  as fetchable **resources** (`guide://latex/writing-guide`, `guide://latex/concurrency`). See
  [Configuration → Guides](../configuration.md#guides-surfaced-to-the-client).
- **Skills** are a Claude Code feature and do not apply under Copilot — the tools themselves work
  identically.
- **Copilot in Visual Studio 2022** uses the same MCP protocol; register the server in a `.mcp.json` at
  your solution root (or `%USERPROFILE%\.mcp.json`) with the same `"servers"` shape shown above.

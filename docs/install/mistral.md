# WebLatexMCP with Mistral

WebLatexMCP is a standard MCP server over **stdio**, so it works with Mistral's **Vibe Code CLI**
with no code changes — only registration.

> **Which Mistral surface?** Use the **Vibe Code CLI** (the terminal agent): it launches local
> processes over stdio, which is what this server speaks. **Le Chat** MCP Connectors are a different
> thing — they only reach **remote** servers over HTTPS — so this server does not plug into Le Chat
> directly (see [Le Chat](#a-note-on-le-chat) at the end).

For **prerequisites** (Node.js ≥ 20, git, and TeX + `latexmk`/`tectonic` for the `compile` tool only)
and for **authentication** (per-host token resolution: env var → `gh auth token` → git credential
helper), follow steps 1–3 of your platform guide — they are client-agnostic:
[macOS](macos.md) · [Linux](linux.md) · [Windows](windows.md). This guide picks up at registration.

## Where the config lives

Vibe reads a TOML config, project first:

- **Project:** `./.vibe/config.toml` — active when Vibe runs from that directory.
- **User / global:** `~/.vibe/config.toml` — active everywhere.

Project-level settings take precedence. (`VIBE_HOME` relocates the home config if you use it.)

## Register with `npx` (no clone, no build)

Add to `~/.vibe/config.toml` (create it if it does not exist). MCP servers are an **array of tables**,
so use `[[mcp_servers]]` — add one block per server:

```toml
[[mcp_servers]]
name = "web-latex-mcp"
transport = "stdio"
command = "npx"
args = ["-y", "web-latex-mcp"]

[mcp_servers.env]
WEB_LATEX_MCP_PROJECTS = '{"paper":{"gitUrl":"https://github.com/me/paper","branch":"main"}}'
WEB_LATEX_MCP_DEFAULT_PROJECT = "paper"
```

Note the **single quotes** around the projects JSON: TOML literal strings don't process escapes, so
the inner `"` stay as-is.

For an Overleaf project, use its Git URL instead:

```toml
[mcp_servers.env]
WEB_LATEX_MCP_PROJECTS = '{"thesis":{"gitUrl":"https://git.overleaf.com/0123456789abcdef","rootFile":"main.tex"}}'
WEB_LATEX_MCP_DEFAULT_PROJECT = "thesis"
```

**Keep tokens out of this file.** Unlike the Gemini and Copilot configs, there is no documented
`$VAR` interpolation here, so anything you put in `[mcp_servers.env]` is stored literally. Prefer
leaving the token out entirely and letting the server resolve it from your environment, `gh auth
token`, or a git credential helper — the platform guides above cover that, and
[Configuration](../configuration.md) documents the full resolution order.

## Register from a local clone

If you cloned and built the repo (platform guide, step 2), point Vibe at `dist/index.js`:

```toml
[[mcp_servers]]
name = "web-latex-mcp"
transport = "stdio"
command = "node"
args = ["/path/to/WebLatexMCP/dist/index.js"]

[mcp_servers.env]
WEB_LATEX_MCP_PROJECTS = '{"paper":{"gitUrl":"https://github.com/me/paper","branch":"main"}}'
WEB_LATEX_MCP_DEFAULT_PROJECT = "paper"
```

To scope the server to one repo, put the same block in `./.vibe/config.toml` instead.

Optional timeouts, if a cold `npx` start or a long compile ever trips the defaults. In TOML, keys
written after a sub-table belong to that sub-table — so put these **above** `[mcp_servers.env]`, or
they become environment variables instead:

```toml
[[mcp_servers]]
name = "web-latex-mcp"
transport = "stdio"
command = "npx"
args = ["-y", "web-latex-mcp"]
startup_timeout_sec = 30
tool_timeout_sec = 120

[mcp_servers.env]
WEB_LATEX_MCP_DEFAULT_PROJECT = "paper"
```

## Verify

1. Start the Vibe Code CLI so it launches the server.
2. Run **`/mcp`** to browse connected servers — `web-latex-mcp` should be listed. `/mcp web-latex-mcp`
   lists its tools (`project_sync`, `list_files`, `read_file`, `compile`, `status`, `push`, …).
   (`/connectors` is an alias for `/mcp`.)
3. Ask Vibe to run `project_sync`, then `list_files`, on your project.

To smoke-test the server on its own, without Mistral:

```bash
WEB_LATEX_MCP_PROJECTS='{}' npx -y web-latex-mcp
```

It logs `server ready on stdio` to **stderr** and waits for JSON-RPC (Ctrl-C to quit).

## Notes specific to Mistral

- **The PDF viewer works here.** `viewer` starts a local, loopback-only viewer and opens it in your
  browser — handy from a terminal agent. It hot-reloads on every compile, and you can select text in
  the PDF to leave review comments for the model to apply. See [Tools](../tools.md).
- **In-context guides.** The writing and concurrency guides are surfaced both as MCP `instructions`
  and as fetchable **resources** (`guide://latex/writing-guide`, `guide://latex/concurrency`), so they
  stay reachable on clients that read one but not the other. See
  [Configuration → Guides](../configuration.md#guides-surfaced-to-the-client).
- **Skills** are a Claude Code feature and do not apply here — the tools themselves work identically.

## A note on Le Chat

Le Chat's custom **MCP Connectors** take a **URL**: the server must be reachable over HTTPS with a
valid TLS certificate. WebLatexMCP is a local stdio process, so it is not a drop-in Le Chat connector.

You could bridge stdio to HTTPS and expose it — but think hard before doing that. This server holds
your git credentials, writes to your working tree, and pushes to your remotes; putting it behind a
public URL turns a local tool into a remotely reachable one. If you want WebLatexMCP with Mistral,
the **Vibe Code CLI** path above keeps everything on your machine.

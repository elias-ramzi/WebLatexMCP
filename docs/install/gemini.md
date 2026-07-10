# WebLatexMCP with Gemini

WebLatexMCP is a standard MCP server over **stdio**, so it works with Google's Gemini tools with no
code changes — only registration. This guide covers both surfaces:

- **Gemini CLI** — the terminal agent.
- **Gemini Code Assist** — the VS Code / IntelliJ extension in **agent mode**.

Both read MCP servers from the **same** `settings.json`, so one config serves both.

For **prerequisites** (Node.js ≥ 20, git, and TeX + `latexmk`/`tectonic` for the `compile` tool only)
and for **authentication** (per-host token resolution: env var → `gh auth token` → git credential
helper), follow steps 1–3 of your platform guide — they are client-agnostic:
[macOS](macos.md) · [Linux](linux.md) · [Windows](windows.md). This guide picks up at registration.

## Where the config lives

Gemini merges MCP servers from two files (project overrides home):

- **Home / global:** `~/.gemini/settings.json` — active in every Gemini session.
- **Project:** `<project>/.gemini/settings.json` — active only when Gemini runs from that directory.

Both Gemini CLI and Gemini Code Assist agent mode read these files, so registering once enables the
server in both.

## Register with `npx` (no clone, no build)

Add an `mcpServers` entry to `~/.gemini/settings.json` (create the file if it does not exist):

```json
{
  "mcpServers": {
    "web-latex-mcp": {
      "command": "npx",
      "args": ["-y", "web-latex-mcp"],
      "env": {
        "WEB_LATEX_MCP_PROJECTS": "{\"paper\":{\"gitUrl\":\"https://github.com/me/paper\",\"branch\":\"main\"}}",
        "WEB_LATEX_MCP_DEFAULT_PROJECT": "paper",
        "GITHUB_TOKEN": "$GITHUB_TOKEN"
      }
    }
  }
}
```

Gemini expands `$VAR` and `${VAR}` in `settings.json` string values from your environment, so the token
stays out of the file. Drop the `GITHUB_TOKEN` line entirely if you authenticate with `gh` or a git
credential helper (steps in the platform guides).

For an Overleaf project, use its Git URL and token instead:

```json
"WEB_LATEX_MCP_PROJECTS": "{\"thesis\":{\"gitUrl\":\"https://git.overleaf.com/0123456789abcdef\",\"rootFile\":\"main.tex\"}}",
"OVERLEAF_GIT_TOKEN": "$OVERLEAF_GIT_TOKEN"
```

See [Configuration](../configuration.md) for every environment variable and the full token-resolution
order.

## Register from a local clone

If you cloned and built the repo (platform guide, step 2), point Gemini at `dist/index.js` instead of
`npx`:

```json
{
  "mcpServers": {
    "web-latex-mcp": {
      "command": "node",
      "args": ["/path/to/WebLatexMCP/dist/index.js"],
      "env": {
        "WEB_LATEX_MCP_PROJECTS": "{\"paper\":{\"gitUrl\":\"https://github.com/me/paper\",\"branch\":\"main\"}}",
        "WEB_LATEX_MCP_DEFAULT_PROJECT": "paper",
        "GITHUB_TOKEN": "$GITHUB_TOKEN"
      }
    }
  }
}
```

To scope the server to a single repo, put the same block in `<project>/.gemini/settings.json` instead of
the home file.

## Or add it from the CLI

Recent Gemini CLI versions ship an `mcp` subcommand that edits `settings.json` for you:

```bash
gemini mcp add web-latex-mcp \
  -e WEB_LATEX_MCP_PROJECTS='{"paper":{"gitUrl":"https://github.com/me/paper","branch":"main"}}' \
  -e WEB_LATEX_MCP_DEFAULT_PROJECT=paper \
  -e GITHUB_TOKEN=ghp_xxx \
  -- npx -y web-latex-mcp
```

If your version lacks `gemini mcp add`, edit `settings.json` by hand as shown above — that always works.

## Verify

1. Start Gemini CLI (or reload the Gemini Code Assist window) so it launches the server.
2. Run `/mcp` in Gemini CLI — `web-latex-mcp` should appear as **connected**, listing its tools
   (`project_sync`, `list_files`, `read_file`, `compile`, `status`, `push`, …).
3. Ask Gemini to run `project_sync` then `list_files` on your project.

To smoke-test the server on its own, without Gemini:

```bash
WEB_LATEX_MCP_PROJECTS='{}' npx -y web-latex-mcp
```

It logs `server ready on stdio` to **stderr** and waits for JSON-RPC (Ctrl-C to quit).

## Notes specific to Gemini

- **Tool confirmations.** Gemini prompts before each MCP tool call by default. To let a trusted server
  run without per-call confirmation, add `"trust": true` to its `mcpServers` entry — mutating tools
  (`write_file`, `commit`, `push`, …) will then run without a prompt, so enable it only if you are
  comfortable with that.
- **Schema compatibility.** Gemini's function-calling schema is a strict subset of JSON Schema. Every
  WebLatexMCP tool uses only plain strings, numbers, booleans, and enums for its inputs (no unions or
  free-form maps), so all tools register cleanly.
- **In-context guides.** The writing and concurrency guides are surfaced both as MCP `instructions` and
  as fetchable **resources** (`guide://latex/writing-guide`, `guide://latex/concurrency`), so they remain
  reachable even on clients that read one but not the other. See
  [Configuration → Guides](../configuration.md#guides-surfaced-to-the-client).
- **Skills** are a Claude Code feature and do not apply under Gemini — the tools themselves work
  identically.

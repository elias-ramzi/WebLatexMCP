# Installation guides

In a hurry and using the VS Code extension? Start here:

- ⚡ [**Super fast start (VS Code)**](vscode-quickstart.md) — chat your way through setup; Claude
  builds, registers, and adds your Overleaf project for you.

Per-OS setup for **WebLatexMCP**, each covering both **Claude Code** and **Claude Desktop**:

- [macOS](macos.md)
- [Linux](linux.md) (Claude Desktop has no Linux build — use Claude Code)
- [Windows](windows.md)

All three end at the same place: the server registered over stdio, with a token resolved from an env
var, the GitHub CLI, or your OS git credential helper. See the main [README](../../README.md) for the
full configuration reference and tool list.

## Other MCP clients — pending verification

The server speaks standard MCP over stdio, so any MCP-capable client should work. These guides are
written but **not yet verified end-to-end** — the tested setups are Claude Code and Claude Desktop.
Reports welcome:

- [**Gemini**](gemini.md) — Gemini CLI and Gemini Code Assist (IDE agent mode).
- [**GitHub Copilot**](copilot.md) — Copilot agent mode in VS Code (and Visual Studio 2022).
- [**Mistral**](mistral.md) — the Vibe Code CLI (Le Chat connectors are remote-only, so they can't
  reach a local stdio server).

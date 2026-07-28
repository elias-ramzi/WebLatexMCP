# WebLatexMCP as a Claude Desktop Extension (`.mcpb`)

The lowest-friction way onto **Claude Desktop**: a single [MCP Bundle](https://github.com/anthropics/mcpb)
(`.mcpb`, the successor to `.dxt`) you install with one click — no cloning, no building, and no editing
`claude_desktop_config.json`.

## Install

1. Download **`web-latex-mcp.mcpb`** from the
   [latest release](https://github.com/elias-ramzi/WebLatexMCP/releases/latest).
2. Install it, either way:
   - **drag** the file onto the Claude Desktop window, or
   - open **Settings → Extensions → Install Extension** and select it.
3. Claude Desktop shows a short configuration form — **every field is optional**:

   | Field                      | Maps to                   | Notes                                                                       |
   | -------------------------- | ------------------------- | --------------------------------------------------------------------------- |
   | **Overleaf token**         | `OVERLEAF_GIT_TOKEN`      | Masked. Your Overleaf _Git authentication token_. Leave blank to add later. |
   | **GitHub token**           | `GITHUB_TOKEN`            | Masked. A PAT with `repo` scope, for GitHub-hosted projects.                |
   | **Clone workspace folder** | `WEB_LATEX_MCP_WORKSPACE` | Where local clones live. Blank → `~/.web-latex-mcp/projects`.               |

4. Enable the extension. That's it — the server is registered.

Node.js is bundled with Claude Desktop, so there's nothing else to install for editing and git. Only
**`compile`** needs a TeX toolchain (`latexmk` or `tectonic`) on your `PATH` — see the per-OS guides
([macOS](macos.md), [Windows](windows.md), [Linux](linux.md)) for that and the macOS GUI-`PATH` note.

## Add your project — from the chat, not the config

You don't list projects in the form. Once the extension is on, just tell Claude the git URL:

> 👽 Add my Overleaf project — the git URL is `https://git.overleaf.com/0123…`. Call it `thesis`.

Claude calls [`register_project`](../tools.md#registering-a-project-from-the-chat), which **persists** it
so it's there next time too.

## Credentials — three options, none of which put the token in the config file

- **Enter it in the install form** (Overleaf/GitHub token fields). Masked; handed to the server as an env
  var, not written into a project.
- **`credential_portal`** — ask Claude to open the credential portal; you type the token into a **local
  `127.0.0.1` page**, so it never passes through the chat, and it lands in your OS keychain.
- **`set_credential`** — paste the token to Claude once and it stores it in the OS keychain.

See [Registering credentials in Claude Desktop](../configuration.md#registering-credentials-in-claude-desktop)
for the trade-offs, and [Configuration](../configuration.md) for the full list of settings (anything not
in the form can still be set by editing the extension's generated config, or by using the npm/manual
install instead).

## Build the bundle yourself

Maintainers and contributors can produce the `.mcpb` locally:

```bash
npm run bundle          # builds dist/ and packs web-latex-mcp.mcpb via @anthropic-ai/mcpb
```

On a version tag (`git tag v0.4.0 && git push --tags`) the [`Bundle`](../../.github/workflows/bundle.yml)
workflow builds it with production-only dependencies and attaches `web-latex-mcp.mcpb` to the GitHub
Release automatically. The bundle's contents are controlled by [`manifest.json`](../../manifest.json)
(the config form + entry point) and [`.mcpbignore`](../../.mcpbignore) (what's excluded from the pack).

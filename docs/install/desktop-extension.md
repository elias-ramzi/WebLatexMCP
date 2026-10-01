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

   | Field                      | Maps to                   | Notes                                                                                                               |
   | -------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
   | **Overleaf token**         | `OVERLEAF_GIT_TOKEN`      | Masked. Your Overleaf [Git authentication token](https://www.overleaf.com/user/settings). Leave blank to add later. |
   | **GitHub token**           | `GITHUB_TOKEN`            | Masked. A PAT with `repo` scope, for GitHub-hosted projects.                                                        |
   | **Clone workspace folder** | `WEB_LATEX_MCP_WORKSPACE` | Where local clones live. Blank → `~/.web-latex-mcp/projects`.                                                       |

4. Enable the extension. That's it — the server is registered.

Node.js is bundled with Claude Desktop, so for editing and git the only other thing to install is
**git 2.25 or newer** on your `PATH` (`doctor` checks the version). Only **`compile`** needs a TeX
toolchain (`latexmk` or `tectonic`) on your `PATH` — see the per-OS guides
([macOS](macos.md), [Windows](windows.md), [Linux](linux.md)) for that and the macOS GUI-`PATH` note.

**One tool is unavailable in the extension: `render_pages`.** Rasterizing pages to PNG needs the native
canvas backend `@napi-rs/canvas`, a per-platform binary, and the extension is a single bundle built for
every platform, so it is left out — `render_pages` refuses with a message that says so. Everything else
works, PDFs included: `compile` (and its `pageCount`), `extract_text`, `pdf_geometry` and the viewer. If
you need page images, install the server from npm instead (see the [install guides](README.md));
`doctor` reports which case you are in.

## Update

Ask Claude from any chat:

> 👽 Is there an update for web-latex-mcp? If so, install it.

Claude calls [`update_server`](../tools.md), which compares the running version with the
[latest release](https://github.com/elias-ramzi/WebLatexMCP/releases/latest). With `install: true` it
downloads `web-latex-mcp.mcpb`, checks it against the SHA-256 digest GitHub publishes for that file,
and opens it. Claude Desktop then shows its usual install prompt. **Confirm it there**, and the
extension restarts on the new version (`server_info` reports which one is running). If the bundle
could not be opened automatically, or no install prompt appears, drag the file whose path the tool
gives onto the Claude Desktop window.

You can still update by hand: download the new `.mcpb` from the releases page and install it the same
way as the first time.

## Add your project — from the chat, not the config

You don't list projects in the form. Once the extension is on, just tell Claude the git URL:

> 👽 Add my Overleaf project — the git URL is `https://git.overleaf.com/0123…`. Call it `thesis`.

Claude calls [`register_project`](../tools.md#registering-a-project-from-the-chat), which **persists** it
so it's there next time too.

## Credentials — three options, none of which put the token in the config file

- **Enter it in the install form** (Overleaf/GitHub token fields). Masked; handed to the server as an env
  var, not written into a project. Overleaf tokens are created under
  [Account Settings → Git integration](https://www.overleaf.com/user/settings).
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

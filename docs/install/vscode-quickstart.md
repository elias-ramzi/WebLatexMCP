# ⚡ Super fast start — VS Code (Claude Code extension)

The fastest way to get going: **just chat with Claude and let it set everything up.**
No config files to hand-edit — you clone the repo, then talk your way through the rest.

This is the walkthrough for the **Claude Code extension in VS Code** (it works the same in the
Claude Code CLI). For the manual, per-OS reference, see
[macOS](macos.md) · [Linux](linux.md) · [Windows](windows.md).

---

## Before you start

- **Node.js ≥ 20** and **git** installed.
- The **Claude Code extension** in VS Code ([get it here](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code)).
- An **Overleaf premium account** — Overleaf's git integration is a premium-only feature.

---

## Step 1 · Clone this repository

```bash
git clone https://github.com/elias-ramzi/WebLatexMCP.git
```

Open **either** folder in VS Code and start a Claude Code chat there:

- the **`WebLatexMCP`** repo you just cloned, or
- **your paper's own repo** — so Claude can see your code _and_ write the paper alongside it.

---

## Step 2 · Ask Claude to set up the server

> 👽 **You**
>
> Set up the WebLatexMCP server for me. I cloned it at `../WebLatexMCP`.

> ✦ **Claude**
>
> On it — I'll install dependencies, build the server, and register it with Claude Code.
> _(runs `npm install && npm run build`, then `claude mcp add web-latex-mcp …`)_
>
> Done ✅ The `web-latex-mcp` server is registered. Reload the window and you'll see its tools.

That's the whole install. Reload VS Code when Claude asks, and the tools light up.

---

## Step 3 · Grab your Overleaf token

In Overleaf, open [**Account Settings**](https://www.overleaf.com/user/settings) → **Git Integration →
Authentication tokens** → create a token and copy it.

> 👽 **You**
>
> Here's my Overleaf git token: `olp_xxxxxxxxxxxxxxxx`. How do I wire it in?

> ✦ **Claude**
>
> I'll set it as `OVERLEAF_GIT_TOKEN` in the server's env so it stays out of any file that gets
> committed. The token lives only in memory and is scrubbed from all output. 🔐

---

## Step 4 · Grab your project's git link

In your Overleaf project: **Menu → Git** (or **Integrations**) → copy the clone URL. It looks like:

```
https://git.overleaf.com/0123456789abcdef0123456789
```

> 💡 If you don't see a Git option, the project must be under a **premium** account.

---

## Step 5 · Add the project, with a name you pick

> 👽 **You**
>
> Add this Overleaf project as **`thesis`**: `https://git.overleaf.com/0123456789abcdef0123456789`

> ✦ **Claude**
>
> Added **`thesis`** and cloned it. `main.tex` is the root file. Want me to compile it to check
> everything's wired up?

Pick any name you like (`thesis`, `paper`, `neurips`, …) — that's how you'll refer to the project
in chat.

---

## Step 6 · You're set 🎉

Now just talk to your paper:

> 👽 **You**
>
> In **thesis**, read the intro, tighten the last paragraph, compile, and show me the diff.

> ✦ **Claude**
>
> _(reads `main.tex`, edits, runs `latexmk`, returns the errors/PDF and the diff — nothing is
> committed or pushed until you ask)_

When you're happy, ask Claude to **commit** and **push** — those are always separate, explicit
steps, so nothing leaves your machine implicitly.

---

## See the PDF as a tab in VS Code

The `viewer` tool serves a live PDF viewer on `http://127.0.0.1:<port>` (renders with pdf.js —
zoom, scroll, search, select-to-comment; hot-reloads on every compile). VS Code can show that URL
as an **editor tab** via its built-in **Simple Browser**, so you never leave the editor.

**1 · Tell the server you're in VS Code.** In your MCP server config's `env`, set:

```jsonc
"WEB_LATEX_MCP_VIEWER_TARGET": "vscode",   // return the URL instead of opening your OS browser
"WEB_LATEX_MCP_VIEWER_PORT": "41725"       // pin a port so the URL is stable across sessions
```

**2 · Open it.** Ask Claude to `compile`, then “open the viewer”. It returns a `127.0.0.1` URL.
Open the **Command Palette** (`Cmd/Ctrl+Shift+P`) → **“Simple Browser: Show”** → paste the URL.
The tab stays live and refreshes on every compile — dock it beside your `.tex`.

**One-key open (optional).** With the port pinned, add a keybinding (`Cmd/Ctrl+Shift+P` →
“Preferences: Open Keyboard Shortcuts (JSON)”) so a single chord opens the tab:

```jsonc
{
  "key": "cmd+alt+p",
  "command": "simpleBrowser.show",
  "args": "http://127.0.0.1:41725/p/<your-project-id>",
}
```

Comments you add in the viewer flow straight back to Claude: select text → **💬 Comment** → write
the change, then ask Claude to _“resolve my comments”_ (it reads them via `list_comments`, edits the
source, recompiles, and marks them done). Simple Browser is a sandboxed webview, so if text
selection or the clipboard button misbehaves, fall back to your OS browser (`target: "browser"`).

---

## Where to go next

- **[Configuration](../configuration.md)** — every env var, how tokens resolve per host, project options.
- **[Tools](../tools.md)** — the full tool list, the DBLP citation flow, how safe pushes work.
- **[Skills](../skills.md)** — `/format-latex-project`, `/verify-citations`, and friends.
- Per-OS manual setup: [macOS](macos.md) · [Linux](linux.md) · [Windows](windows.md).

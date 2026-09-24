# Installation guides

The [README](../../README.md#install) has the two one-liners — the plugin for Claude Code, the `.mcpb`
for Claude Desktop. This page has everything they leave out.

In a hurry, start at one of these:

- 🧩 [**One-click Claude Desktop Extension**](desktop-extension.md) — download `web-latex-mcp.mcpb`,
  drag it into Claude Desktop, fill an optional form. No cloning, building, or JSON editing.
- ⚡ [**Super fast start (VS Code)**](vscode-quickstart.md) — chat your way through setup; Claude
  builds, registers, and adds your Overleaf project for you. This is the most-tested path.

## Your token and your project — from the chat

However you installed, the server needs a token for your git host — for Overleaf, a **Git
authentication token** from
[Account Settings → Git integration](https://www.overleaf.com/user/settings). The private way to hand
it over, which **never puts the token in the chat**:

> 👽 Open the credential portal for my Overleaf token.

`credential_portal` opens a local `127.0.0.1` page where you type the token; it goes straight into your
**OS keychain**, never through the conversation. (Happy to paste it once instead? `set_credential`
stores it in the keychain in a single step.)

Then add your project by just giving Claude the git URL — it registers it with `register_project`, and
it persists across restarts and sessions:

> 👽 Add my Overleaf project https://git.overleaf.com/… and call it "thesis".

Working on a `.tex` that is already on this machine? Give it a folder instead — no token, no remote,
and nothing is cloned ([details](../tools.md#local-in-place-projects)):

> 👽 Add the folder ~/papers/neurips as a local project called "paper".

## The server on its own, without the plugin

Prefer just the server? Claude Code registers the npm package in one line — the skills still come
through as [prompts](../skills.md#two-ways-a-skill-runs):

```bash
claude mcp add web-latex-mcp --scope user -- npx -y web-latex-mcp
```

💡 Launch Claude Code **from your paper's own repo** so the LaTeX clone lands right beside your code.

## TeX is optional

Editing, git, and the PDF viewer all work with no TeX installed — only `compile` needs `latexmk` (the
default, and what Overleaf runs) or `tectonic` on your `PATH`. Pick either per call with
`compile { compiler: "tectonic" }`: a missing _default_ falls back to whichever of the two is
installed, while a backend you actually chose never does (see
[Compile backend](../configuration.md#compile-backend)). Not sure what you have? Ask Claude to run
`doctor` and it reports your engines, your TeX distribution, and where packages can be installed.

## Per-OS setup

Each guide covers both **Claude Code** and **Claude Desktop**:

- [macOS](macos.md)
- [Linux](linux.md) (Claude Desktop has no Linux build — use Claude Code)
- [Windows](windows.md)

All three end at the same place: the server registered over stdio, with a token resolved from an env
var, the GitHub CLI, or your OS git credential helper.

## Configuration

Prefer env vars — `WEB_LATEX_MCP_PROJECTS`, per-host tokens, the workspace root, the compiler? The
full reference, including per-host token resolution and the cross-platform notes, is in
[Configuration](../configuration.md).

## No machine of your own — an iPad, an iPhone, or a browser

- 📱 [**Claude Code on the web**](claude-code-web.md) — a cloud session reads your repo's `.mcp.json`
  and runs the server in its own VM, so the whole workflow (compile included, once the environment's
  setup script installs TeX) works from claude.ai/code or the Claude mobile app. The guide also says why
  a **custom connector** is not the answer: the Claude apps reach only remote servers over HTTPS, and
  this one holds your git token, writes your working tree, and pushes.

## Other MCP clients — pending verification

The server speaks standard MCP over stdio, so any MCP-capable client should work. These guides are
written but **not yet verified end-to-end** — the tested setups are Claude Code and Claude Desktop.
Reports welcome:

- [**Gemini**](gemini.md) — Gemini CLI and Gemini Code Assist (IDE agent mode).
- [**GitHub Copilot**](copilot.md) — Copilot agent mode in VS Code (and Visual Studio 2022).
- [**Mistral**](mistral.md) — the Vibe Code CLI (Le Chat connectors are remote-only, so they can't
  reach a local stdio server).

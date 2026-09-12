# WebLatexMCP from an iPad, an iPhone, or a browser

The Claude apps on iOS and iPadOS, and claude.ai itself, connect to **remote** MCP servers over HTTPS —
"custom connectors". WebLatexMCP is a local **stdio** process that needs a filesystem, a git credential
and a TeX installation, so it is not a connector and cannot become one without hosting it somewhere; see
[Why not a custom connector](#why-not-a-custom-connector) at the end.

What does work today, with no code change and no server of your own: **[Claude Code on the
web](https://code.claude.com/docs/en/claude-code-on-the-web)**. Each cloud session is an Ubuntu VM with
your repository cloned into it, and it loads that repo's **`.mcp.json`** — so the server runs there
exactly as it runs on your laptop. You drive the session from a browser at
[claude.ai/code](https://claude.ai/code), or from the **Code** tab of the Claude app on an iPhone or an
iPad.

> [!NOTE]
> Claude Code on the web is in research preview for Pro, Max and Team plans (and Enterprise premium
> seats). The one-time setup below — the cloud environment — is browser-only; once it exists, the phone
> and tablet apps use it.

**Measured, not guessed.** The numbers and the package list in this guide come from a run in an
Anthropic-hosted cloud VM (Ubuntu 24.04, 4 vCPU / 16 GB RAM / 30 GB disk): TeX installed in about
2.5 minutes, and this repo's TeX smoke suite — real `latexmk` compiles, plus `render_pages`
rasterization — passed there unmodified.

## What works there, and what doesn't

| Capability                                                                  | In a cloud session | Why                                                                                                                |
| --------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `read_file` / `write_file` / `edit_file` / `list_files` / `status` / `diff` | ✅                 | Ordinary filesystem work in the VM                                                                                 |
| `project_sync` / `commit` / `push` / `discard` / `reset_to_remote`          | ✅                 | Real git, with a token from the environment (see [Tokens](#tokens))                                                |
| `compile`                                                                   | ✅                 | Once the [setup script](#setup-script--install-tex) installs TeX                                                   |
| `render_pages`                                                              | ✅                 | `@napi-rs/canvas` ships a prebuilt linux-x64 binary. **This is how you look at the PDF from a phone**              |
| `list_references` / `check_citations`                                       | ✅                 | Local parsing, no network                                                                                          |
| `search_references` / `add_citation`                                        | ✅\*               | \*DBLP is not on the default allowlist — add `dblp.org` under [Network access](#network-access)                    |
| `doctor`                                                                    | ✅                 | Worth running first in a fresh environment                                                                         |
| `viewer`                                                                    | ❌                 | It binds `127.0.0.1` inside a VM you have no route to. `render_pages` is the replacement, and it works on a phone  |
| `credential_portal`                                                         | ❌                 | Same reason — the page is loopback-only. Put the token in the environment instead                                  |
| Your clone surviving the session                                            | ⚠️                 | The VM is reclaimed after a period of inactivity. **`push` before you stop**, or the work is gone with the sandbox |

## 1. Pick the repository the session starts from

A cloud session always begins from a GitHub repository, and that is where `.mcp.json` has to live.

- **Paper already on GitHub** — use the paper's own repo. The session then has the `.tex` as ordinary
  files _and_ the server on top of them, which is what earns its place here: a `compile` whose errors
  come back parsed and with the five source lines around each one, `render_pages` to actually see the
  layout, `check_citations`, and a commit scoped to the session rather than to the whole tree.
- **Paper on Overleaf** — it has no GitHub repo, so start the session from any small repo you own (a
  `latex-workbench` holding little more than the `.mcp.json` below) and register the Overleaf project
  from the chat. The clone lands inside the session, and `push` sends it back to Overleaf.

## 2. Commit a `.mcp.json`

At the root of that repository:

```json
{
  "mcpServers": {
    "web-latex-mcp": {
      "command": "npx",
      "args": ["-y", "web-latex-mcp"]
    }
  }
}
```

That is the whole file. No project configuration is needed — add the project from the chat once the
session is up:

> 👽 Add my Overleaf project https://git.overleaf.com/… and call it "thesis".

To have a project present the moment the server boots, add the usual `env` block
([`WEB_LATEX_MCP_PROJECTS`](../configuration.md#environment-variables),
`WEB_LATEX_MCP_DEFAULT_PROJECT`) — but **never a token**: this file is committed. Tokens belong in the
environment's variables, which are not part of the repo.

> [!TIP]
> The session's working directory is the clone, which is a git repo, so the
> [workspace-local default](../configuration.md#workspace-local-clones) applies unchanged: LaTeX clones
> land under `.web_latex_mcp/` and the server adds that to the host repo's `.git/info/exclude` at
> startup, so they never show up in your diff. `compile` surfaces the PDF at
> `.web_latex_mcp/<project>.pdf` beside the clone.

## 3. Configure the cloud environment

One-time, in a desktop browser: [claude.ai/code](https://claude.ai/code) → the environment selector →
**Add cloud environment** (or edit an existing one). Three fields matter.

### Setup script — install TeX

Cloud VMs ship Node, git and `gh`, but no TeX. The setup script runs as root before Claude Code starts,
and what it writes to disk is kept in the environment's cached snapshot, so it runs once and later
sessions start with TeX already there.

```bash
#!/bin/bash
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq || true

# A minimal, fast base: measured at ~34 s and 86 MB on disk.
apt-get install -y --no-install-recommends \
  latexmk texlive-latex-recommended texlive-fonts-recommended || true

# What most papers additionally want (TikZ/pgfplots, algorithm and math packages, biber):
# measured at ~2 min more, for 2.3 GB of TeX in total.
apt-get install -y --no-install-recommends \
  texlive-latex-extra texlive-science texlive-fonts-extra biber || true
```

Three things that script is shaped around:

- **`|| true` on every install.** A setup script that exits non-zero fails the whole session start; a
  transient apt hiccup should cost you a package, not the session.
- **Roughly five minutes total.** Past that the environment cache can't build, and every session pays
  the install again. Both blocks together land near 2.5 minutes, which leaves room — but this is why
  `texlive-full` (7 GB+) is the wrong instinct even though the 30 GB disk would hold it.
- **Add packages one at a time, from evidence.** When a build fails on a package your TeX doesn't have,
  `compile` returns it in `missingPackages` (parsed from the log's ``File `fontawesome.sty' not
found``), so you append exactly that package to the script and rebuild the cache — rather than
  guessing at a distribution-sized install up front.

`apt` works here because `archive.ubuntu.com` and `security.ubuntu.com` are on the default **Trusted**
allowlist, as is `registry.npmjs.org` for the `npx` in your `.mcp.json`. **Tectonic** is the one backend
to avoid in this environment: it fetches its package bundle over the network on first use from a host
that is not on that list, so it needs a Custom entry _and_ a download on each cold session, while an apt
TeX lands in the cached snapshot.

### Tokens

Environment variables are set in the same dialog, in `.env` format:

```
OVERLEAF_GIT_TOKEN=olp_…
```

The [per-host resolution order](../configuration.md#tokens--resolved-per-host) is unchanged — the server
just reads the variable it finds. Two things specific to the cloud:

- **Anyone who can use the environment can read its variables.** On a personal Pro or Max environment
  that is only you. Do not put a personal token in an organization's shared environment.
- **GitHub is usually already handled.** The session authenticates to the repositories attached to it
  through its own git proxy, with no token of yours in the VM. That scope covers the repo the session
  started from — so if you register a **different** GitHub repo as a project, give the environment a
  `GITHUB_TOKEN` as well.

### Network access

The default **Trusted** level covers npm and the Ubuntu archives, but not the hosts this server talks
to. Switch to **Custom**, keep _"Also include default list of common package managers"_ checked, and
list what you need:

```
git.overleaf.com
dblp.org
```

`git.overleaf.com` is what `project_sync` and `push` reach; `dblp.org` is what `search_references` and
`add_citation` query. Add your own git host too if the paper lives somewhere other than GitHub, GitLab
or Bitbucket, which are on the default list already.

## 4. Start a session and check it

From [claude.ai/code](https://claude.ai/code): pick the repository, pick the environment, and open a
session. Then, in order:

> 👽 Run `doctor`.

It reports the engines it found, the TeX distribution, where packages can be installed, and whether the
native canvas backend for `render_pages` is present — the fastest way to tell a cache miss from a
missing package.

> 👽 Add my Overleaf project https://git.overleaf.com/… as "thesis", then compile it and show me page 1.

`compile` then `render_pages` is the loop that replaces the viewer here: the PNG comes back inlined in
the conversation, on whatever device you are holding.

## 5. From the iPhone or iPad

Open the Claude app, go to the **Code** tab, and start a session on that repository — or pick up one you
started in the browser, since sessions persist across devices and survive a closed browser. Everything
above works from there, with two notes:

- **Environments are configured in a browser.** Creating or editing one (the setup script, the
  variables, the allowlist) is desktop-only; the apps use the environment you already defined.
- **`render_pages`, not `viewer`.** Ask for the page you care about — `render_pages` takes `pages` and a
  fractional `clip`, so "show me the top half of page 3" is one call and one image, which is the right
  granularity for a phone screen.
- **Finish with a `push`.** An idle session's VM is reclaimed; an unpushed commit goes with it.

## Skills in a cloud session

The [bundled skills](../skills.md) reach a cloud session by three routes, in increasing order of effort:

- **As MCP prompts, with nothing to install** — they travel with the server, so
  `/web-latex-mcp:verify-citations` and friends are there as soon as the session connects.
- **As the `list_skills` tool** — the model can fetch a procedure itself, which is what makes "check my
  bibliography" work without any of them being installed anywhere.
- **Model-invoked, for real** — skills you enable on your claude.ai account are loaded automatically in
  cloud sessions (see [Claude Desktop and claude.ai — upload the skills](../skills.md#claude-desktop-and-claudeai--upload-the-skills)),
  and a `.claude/skills/` directory committed to the session's repository is picked up like any other
  part of the clone. Plugins declared in the repo's `.claude/settings.json` are installed at session
  start too.

## Parallel sessions are not parallel here

[Parallel sessions on one clone](../CONCURRENCY.md#parallel-sessions-on-one-clone) — the lock file, the
per-session shadows, `commit` taking only your own lines — coordinate server processes that **share a
filesystem**. Two cloud sessions are two VMs with two clones and see nothing of each other, so they meet
where two people would: at the git remote, through `push` and its conflict payload. Run one cloud
session per project, or treat a second one as a co-author rather than as a peer session.

## Why not a custom connector

A connector would have to be this server reachable at an HTTPS URL — which means it also has to be
running _somewhere_ that has your clone, your git token and a TeX installation, because the tools are
not a protocol veneer over an API: they compile, they write a working tree, and they push. Standing that
up is a public URL in front of exactly those three things, and the token it holds is a credential that
can rewrite your paper's history. The reasoning is the same one this repo gives for [Le Chat's
remote-only connectors](mistral.md#a-note-on-le-chat), and it does not get better because the client is
Claude.

The cloud-session route above avoids all of it: the credential lives in your own environment, the VM is
isolated and disposable, and nothing of yours is exposed to the internet.

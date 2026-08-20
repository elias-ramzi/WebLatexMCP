# Configuration

The server is configured entirely through **environment variables**, set in your MCP client's `env`
block (see the [install guides](install/) for full `.mcp.json` / `claude_desktop_config.json` examples).

## Environment variables

| Variable                                                   | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEB_LATEX_MCP_PROJECTS`                                   | no\*     | JSON map of project id → either `{ gitUrl, rootFile?, branch?, username?, tokenEnv? }` (a remote to clone) or `{ mode: "local", path, rootFile? }` (a directory used in place; `~` and relative paths are resolved). \*Not strictly required — you can also register a project at runtime from the chat (`register_project`); set this to have projects present at boot. See [Registering a project without env config](#registering-a-project-without-env-config). |
| `WEB_LATEX_MCP_WORKSPACE`                                  | no       | Directory holding one clone per project. Defaults to `<launch-dir>/.web_latex_mcp` when the launch dir is a git repo, else `~/.web-latex-mcp/projects` — see [Workspace-local clones](#workspace-local-clones). Set to `cwd` to force workspace-local, or to a path to override.                                                                                                                                                                                    |
| `WEB_LATEX_MCP_DEFAULT_PROJECT`                            | no       | Project id used when a tool call omits `project`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `WEB_LATEX_MCP_SESSION`                                    | no       | Name for this session when several agent sessions share one clone (e.g. `intro`, `experiments`). It is what peers see in `status`, and it scopes what `commit` commits. Defaults to a generated id — see [Parallel sessions](#parallel-sessions).                                                                                                                                                                                                                   |
| `WEB_LATEX_MCP_COMPILER`                                   | no       | Local compile backend: `latexmk` (default) or `tectonic`. See [Compile backend](#compile-backend).                                                                                                                                                                                                                                                                                                                                                                  |
| `WEB_LATEX_MCP_AUTHOR_NAME` / `WEB_LATEX_MCP_AUTHOR_EMAIL` | no       | Identity used for commits. Default `WebLatexMCP <web-latex-mcp@localhost>`.                                                                                                                                                                                                                                                                                                                                                                                         |
| `WEB_LATEX_MCP_WRITING_GUIDE`                              | no       | Path to a LaTeX writing guide surfaced to the client. Default bundled [`writing-guide.md`](writing-guide.md).                                                                                                                                                                                                                                                                                                                                                       |
| `WEB_LATEX_MCP_CONCURRENCY_GUIDE`                          | no       | Path to a concurrency / safe-push guide surfaced to the client. Default bundled [`CONCURRENCY.md`](CONCURRENCY.md).                                                                                                                                                                                                                                                                                                                                                 |
| `WEB_LATEX_MCP_SKILLS_DIR`                                 | no       | Directory of skills exposed as MCP prompts (one subdirectory per skill, each with a `SKILL.md`). Default bundled [`.claude/skills`](skills.md).                                                                                                                                                                                                                                                                                                                     |
| `WEB_LATEX_MCP_NO_OUTPUT_SCHEMA`                           | no       | Output-schema client compatibility. Default **auto-detects Claude Desktop** and omits `outputSchema`/`structuredContent` for it only; `1` forces omit for every client, `0` disables. See [Claude Desktop compatibility](#claude-desktop-compatibility).                                                                                                                                                                                                            |

### `WEB_LATEX_MCP_PROJECTS` example

One Overleaf project, one GitHub repo, and one directory compiled in place:

```json
{
  "thesis": { "gitUrl": "https://git.overleaf.com/0123456789abcdef", "rootFile": "main.tex" },
  "paper": { "gitUrl": "https://github.com/me/paper", "branch": "main" },
  "cv": { "mode": "local", "path": "~/docs/cv" }
}
```

The first two are cloned into the workspace and get the full sync/commit/push workflow. The third is
read, edited and compiled **where it lies** — see [Local projects](tools.md#local-in-place-projects).

**Where to find the git URL:** in Overleaf, open the project and go to **Menu → Git** — it shows a URL of
the form `https://git.overleaf.com/<project-id>`. For GitHub (or any git host), use the normal HTTPS
clone URL, e.g. `https://github.com/me/paper`.

> [!TIP]
> You don't have to set this variable at all. You can hand Claude the git URL **straight from the chat**
> and it will register the project for you — see [Registering a project without env
> config](#registering-a-project-without-env-config). Setting `WEB_LATEX_MCP_PROJECTS` is just the way to
> have projects present the moment the server boots.

## Registering a project without env config

Editing a client's `env` block is fiddly — especially in **Claude Desktop**, which needs a JSON edit and
a restart. So the server also lets you register a project **at runtime, from the chat**: give Claude the
project id and its git URL and it calls the `register_project` tool, which:

- **persists** the project to a `registry.json` under the [workspace root](#workspace-local-clones), so
  it survives a restart and is picked up by every other session on the same machine — no env var needed;
- clones it immediately (pass `clone: false` to defer);
- or, given `path` instead of `gitUrl`, registers a **local** project — a directory already on this
  machine, used in place with no clone at all (see [Local projects](tools.md#local-in-place-projects));
- stores only the id, git URL, and options (`rootFile` / `branch` / `username` / `tokenEnv`) — **never a
  token**. Credentials are resolved per host at git time exactly as for env-configured projects (see
  [Tokens](#tokens--resolved-per-host)).

A project configured through `WEB_LATEX_MCP_PROJECTS` always wins over a persisted one with the same id,
so the env stays the source of truth when you use it. (`project_sync` with a `gitUrl` also registers a
project, but only for the current process — use `register_project` to keep it across sessions.) See the
[tool reference](tools.md#registering-a-project-from-the-chat) for the full flow.

## Workspace-local clones

When you drive the server from a coding agent (Claude Code, and other agents that spawn it over stdio
from your project directory), it's handy to have the LaTeX sitting **right beside the code** — so the
agent can open the `.tex` and the compiled PDF as ordinary workspace files, not only through MCP tools.

**This is the default whenever the launch dir is a git repo.** With no `WEB_LATEX_MCP_WORKSPACE` set,
clones land under `<workspace>/.web_latex_mcp/<project-id>/`, where `<workspace>` is the directory the
server was launched from (the agent's workspace root). On startup the server adds `.web_latex_mcp/` to
the host repo's **`.git/info/exclude`** (never the tracked `.gitignore`), so the LaTeX clones don't
show up as untracked files in your own repo.

In this mode `compile` also **surfaces the PDF** at `<workspace>/.web_latex_mcp/<project>.pdf` (a
sibling of the clone, so it never dirties the project's git), so you can open the latest build straight
from your editor rather than hunting through the temp build dir.

When the launch dir is **not** a git repo — or is your home directory — the default instead falls back
to the shared home cache `~/.web-latex-mcp/projects`. This keeps clients whose launch directory is
unpredictable (e.g. Claude Desktop, which may start at `/` or `~`) out of surprising locations.

To override the default:

```json
{ "env": { "WEB_LATEX_MCP_WORKSPACE": "cwd" } }
```

- `cwd` — force workspace-local even when the auto-detection wouldn't (e.g. a non-repo project dir).
- any **path** (absolute, `~`-relative, or relative to the launch dir) — use that exact directory as
  the shared clone root; nothing is git-excluded.

## Parallel sessions

Several agent sessions can work on one paper at once — one per section, say — each a separate server
process sharing a single clone. Give each one a name:

```json
{ "env": { "WEB_LATEX_MCP_SESSION": "experiments" } }
```

That name is what the other sessions see in `status`, and it is what `commit` scopes to: by default a
commit contains only the edits **that session** made, leaving its peers' in-flight work uncommitted in
the working tree. Mutating operations are serialised across processes with a lock file, so two servers
never rewrite the clone's index at once.

Session state (the lock, and each session's record of its own changes) lives under
`<workspace>/.sessions/<project-id>/`, beside the clones rather than inside them — nothing there can be
committed or mistaken for project content. With no `WEB_LATEX_MCP_SESSION` set, a session still works
and is still isolated, but shows up to its peers under a generated id.

This works between processes on **one machine**; it is not coordination between people on different
machines, who still meet at the git remote. See [Parallel sessions on one
clone](CONCURRENCY.md#parallel-sessions-on-one-clone) for the model, the conflict semantics, and the
limits.

## Compile backend

The `compile` tool runs locally so you see errors and PDFs without round-tripping through Overleaf.
Two backends are supported; select with `WEB_LATEX_MCP_COMPILER`.

- **`latexmk`** (default) — drives your system TeX install (TeX Live / MacTeX / MiKTeX). This is what
  Overleaf itself runs, so it gives the closest "compiles here == compiles on Overleaf" guarantee and the
  broadest package/engine compatibility. Requires `latexmk` (and a TeX distribution) on your `PATH`.
- **`tectonic`** — a self-contained engine that bundles its own TeX and fetches packages on demand into a
  local cache. No multi-gigabyte TeX install needed, and builds are reproducible. Trade-offs: the first
  compile of a project needs network access to populate the cache, and tectonic is **XeTeX-only** — the
  `engine` argument (`pdflatex`/`xelatex`/`lualatex`) is ignored and the `clean` argument is a no-op.
  Documents that rely on pdfLaTeX-specific behavior may render differently. Requires `tectonic` on your
  `PATH` (`brew install tectonic`, `cargo install tectonic`, or see <https://tectonic-typesetting.github.io>).

Both return the same structured errors/warnings and PDF path, so switching backends changes nothing else.

## Tokens — resolved per host

Every host uses a token as the **HTTPS password**. For Overleaf, generate one under
[**Account Settings → Git integration → Git authentication token**](https://www.overleaf.com/user/settings).
For GitHub, create a PAT under **Settings → Developer settings → Personal access tokens** with `repo`
scope. GitLab and others: a personal/project access token.

**How the server finds a token.** For each project it tries these sources in order and uses the first
that yields one:

1. the project's **`tokenEnv`** env var, if set (per-project override);
2. the **host's token env** — `GITHUB_TOKEN`, `GITLAB_TOKEN`, `OVERLEAF_GIT_TOKEN`, … ;
3. the generic **`WEB_LATEX_MCP_TOKEN`**;
4. the **GitHub CLI** — `gh auth token` (GitHub only);
5. your **git credential helper** — `git credential fill` (macOS Keychain, Windows Credential Manager,
   libsecret, …; works on every OS).

A project can set its own `tokenEnv` and/or `username`, so an Overleaf project and a GitHub repo coexist
with different credentials. Pick **one** method — you don't need all five. For a single Overleaf project
the simplest is to set `OVERLEAF_GIT_TOKEN` in the client `env` block.

### Registering credentials in Claude Desktop

The token is **never** part of `register_project` or the persisted registry — it is resolved at git time
from the sources above. On Desktop, where hand-editing the config is awkward, you have three ways to get
it in place:

- **Local portal — `credential_portal` (most private).** For when you'd rather the token never appear in
  the chat at all (e.g. a cloud-synced transcript): ask Claude to open the credential portal. It calls
  `credential_portal`, which starts a tiny page on `127.0.0.1`, opens your browser, and lets you type the
  token into a **local form**. The token is POSTed straight to the server on your machine and stored in
  the OS keychain — it never reaches Claude, the tool result, or the conversation. After you submit, ask
  Claude to check and it reports whether it landed. Give a `host` or a `project` to target.
- **From the chat — `set_credential`.** If you're fine pasting the token to Claude once, this is the
  one-step path: it hands the token to your **OS keychain** via `git credential approve` (with
  `confirm: true`) — it lands there encrypted, not in any config file or our registry, and the server
  picks it up on the next git operation. Give a `host` or a `project`. It reports whether a credential
  helper actually kept the token — some bare Linux boxes have none configured, in which case fall back to
  an env var. Pairs with `register_project`: paste the git URL, then the token — no JSON editing.
- **Inline env var.** In `claude_desktop_config.json`, add the host token to the server's `env` block,
  e.g. `"env": { "OVERLEAF_GIT_TOKEN": "olp_xxx" }` (Desktop does **not** expand `${VARS}`, so paste the
  literal value), then restart Desktop.
- **Keychain by hand.** The same thing `set_credential` does, from a terminal:
  - macOS: `printf 'protocol=https\nhost=git.overleaf.com\nusername=git\npassword=<TOKEN>\n\n' | git credential approve`
  - GitHub via the CLI: `gh auth login`.

  The server then picks it up through `git credential fill` / `gh auth token`. See the per-OS
  [install guides](install/) for the exact keychain commands.

Tokens are injected into git operations **in memory only** — after cloning, the remote is reset to a
**tokenless** URL, so nothing lands in `.git/config`. Every known host token is scrubbed from error
messages and tool output. Git runs with `GIT_TERMINAL_PROMPT=0`, so a missing/expired credential fails
fast instead of hanging.

## Guides surfaced to the client

At startup the server reads two guides and surfaces each to the client two ways: as the MCP
`instructions` hint (so a client like Claude keeps it in context for the whole session) and as a
fetchable **resource** (so you can re-open it on demand and clients that ignore `instructions` can still
reach it).

- **Writing guide** — resource `guide://latex/writing-guide`. The bundled
  [`writing-guide.md`](writing-guide.md) covers tense, style, figures, equations, bibliography, and
  English-usage conventions. Override with `WEB_LATEX_MCP_WRITING_GUIDE`.
- **Concurrency guide** — resource `guide://latex/concurrency`. The bundled [`CONCURRENCY.md`](CONCURRENCY.md)
  explains how the server pushes without clobbering edits made elsewhere (the Overleaf web editor, or
  other agents). Override with `WEB_LATEX_MCP_CONCURRENCY_GUIDE`.

Point a guide variable at your own file to override it, or at a non-existent path to ship no guide (the
server starts normally either way; with no guide, neither the instructions nor the resource is
advertised).

## Claude Desktop compatibility

Some Claude Desktop builds **silently fail to dispatch tool calls** to an MCP server whose tools
advertise an `outputSchema` (structured output): the server connects and its tools list fine, but every
call fails with a generic "Tool execution failed" and never reaches the server.

**This is handled automatically — no configuration needed.** The server detects Claude Desktop from the
`clientInfo.name` it sends (`claude-ai`) and omits `outputSchema`/`structuredContent` for that client
only, leaving structured output fully intact for clients that support it (e.g. Claude Code).

`WEB_LATEX_MCP_NO_OUTPUT_SCHEMA` overrides the auto-detection when you need to:

- **`1`** — always omit `outputSchema` (use if another client hits the same bug).
- **`0`** / `false` — never omit, even for Claude Desktop (strict spec behavior).

```json
{ "env": { "WEB_LATEX_MCP_NO_OUTPUT_SCHEMA": "1" } }
```

## Cross-platform notes

- File paths in tool output are POSIX (`/`), regardless of OS.
- Clones force `core.autocrlf=false`, so files keep their repo (LF) line endings and `edit_file`'s exact
  match is deterministic on Windows.
- Secrets come from env vars, the GitHub CLI, or your git credential helper — no OS-specific config.

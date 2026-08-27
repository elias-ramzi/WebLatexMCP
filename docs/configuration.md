# Configuration

The server is configured entirely through **environment variables**, set in your MCP client's `env`
block (see the [install guides](install/) for full `.mcp.json` / `claude_desktop_config.json` examples).

## Environment variables

| Variable                                                   | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEB_LATEX_MCP_PROJECTS`                                   | no\*     | JSON map of project id → either `{ gitUrl, rootFile?, branch?, username?, tokenEnv? }` (a remote to clone) or `{ mode: "local", path, rootFile?, followSymlinks? }` (a directory used in place; `~` and relative paths are resolved; `followSymlinks: true` lets reads, writes and listings follow a symlink out of that directory — off by default, and only ever set it when the links there are yours). \*Not strictly required — you can also register a project at runtime from the chat (`register_project`); set this to have projects present at boot. See [Registering a project without env config](#registering-a-project-without-env-config). |
| `WEB_LATEX_MCP_WORKSPACE`                                  | no       | Directory holding one clone per project. Defaults to `<launch-dir>/.web_latex_mcp` when the launch dir is a git repo, else `~/.web-latex-mcp/projects` — see [Workspace-local clones](#workspace-local-clones). Set to `cwd` to force workspace-local, or to a path to override.                                                                                                                                                                                                                                                                                                                                                                          |
| `WEB_LATEX_MCP_DEFAULT_PROJECT`                            | no       | Project id used when a tool call omits `project`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `WEB_LATEX_MCP_SESSION`                                    | no       | Name for this session when several agent sessions share one clone (e.g. `intro`, `experiments`). It is what peers see in `status`, and it scopes what `commit` commits. Defaults to a generated id — see [Parallel sessions](#parallel-sessions).                                                                                                                                                                                                                                                                                                                                                                                                         |
| `WEB_LATEX_MCP_COMPILER`                                   | no       | Local compile backend: `latexmk` (default) or `tectonic`. Setting it is an **assertion**: that backend is never substituted, and a missing one is an error. Left unset, a missing `latexmk` falls back to an installed `tectonic`. See [Compile backend](#compile-backend).                                                                                                                                                                                                                                                                                                                                                                               |
| `WEB_LATEX_MCP_REWRITE_MODE`                               | no       | Default [rewrite-preservation mode](tools.md#rewrite-preservation-mode) for `edit_file`: `off`, `prose` (default), or `always`. Only the default — a project's own `set_rewrite_mode` setting wins over it, and a per-call `preserveOriginal` wins over both. An invalid or whitespace-only value falls back to `prose` and logs a warning to stderr rather than failing to start.                                                                                                                                                                                                                                                                        |
| `WEB_LATEX_MCP_AUTHOR_NAME` / `WEB_LATEX_MCP_AUTHOR_EMAIL` | no       | Identity used for commits. Default `WebLatexMCP <web-latex-mcp@localhost>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `WEB_LATEX_MCP_WRITING_GUIDE`                              | no       | Path to a LaTeX writing guide surfaced to the client. **Replaces** the bundled [`writing-guide.md`](writing-guide.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `WEB_LATEX_MCP_WRITING_GUIDE_EXTRA`                        | no       | Path or `file://` URL to an ADDITIONAL, project-specific writing guide, **appended to** (never replacing) the base guide. See [Project-specific writing conventions](#project-specific-writing-conventions).                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `WEB_LATEX_MCP_CONCURRENCY_GUIDE`                          | no       | Path to a concurrency / safe-push guide surfaced to the client. Default bundled [`CONCURRENCY.md`](CONCURRENCY.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `WEB_LATEX_MCP_SKILLS_DIR`                                 | no       | Directory of skills exposed as MCP prompts (one subdirectory per skill, each with a `SKILL.md`). Default bundled [`.claude/skills`](skills.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `WEB_LATEX_MCP_NO_OUTPUT_SCHEMA`                           | no       | Output-schema client compatibility. Default **auto-detects Claude Desktop** and omits `outputSchema`/`structuredContent` for it only; `1` forces omit for every client, `0` disables. See [Claude Desktop compatibility](#claude-desktop-compatibility).                                                                                                                                                                                                                                                                                                                                                                                                  |

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

Both return the same structured errors/warnings and PDF path, but not the same **source snippets**:
latexmk is run with `-file-line-error`, tectonic passes no such flag, so its log names no `file:line`
for any diagnostic and every error comes back with no `snippet`/`snippetStartLine` — all of them
counted in `omittedSnippetLocations` instead. A snippet is never guessed, so under tectonic the 5
lines around each error cost a `read_file`.

### Choosing a backend, and when one is substituted

The backend is also selectable **per call**: `compile { compiler: "tectonic" }` uses that backend for
that one compile. Previously the only way to pick one was at launch, so a mis-set backend meant
editing the MCP client config and restarting the server.

Whichever backend is selected is **preflighted** before the compile runs. If it is not on your
`PATH`, `compile` fails with an error naming the missing backend, which backends _are_ installed, the
`compiler:` argument to retry with, and `WEB_LATEX_MCP_COMPILER` — rather than a raw
`spawn latexmk ENOENT` from Node.

**A default falls back; a choice does not.**

- **`WEB_LATEX_MCP_COMPILER` unset** — `latexmk` is only a _default_. If it is missing and `tectonic`
  is installed, `compile` uses tectonic and says so: the result's `hint` reports the substitution, and
  its `compiler` field always names the backend that actually ran.
- **`WEB_LATEX_MCP_COMPILER` set** — to anything, `latexmk` included — or a per-call `compiler:`
  argument: **never** substituted. A missing backend is an error, the one above.

The reason is the one behind [`followSymlinks`](tools.md#local-in-place-projects): a setting is an
assertion, never an inference. Someone who never set the variable never chose `latexmk` — it was the
server's guess, and swapping in the engine that is actually installed keeps the guess honest rather
than failing on a machine that can compile perfectly well. Someone who set it _did_ choose, so
substituting would silently override them — and the two backends are not interchangeable (tectonic is
XeTeX-only and drops every snippet), so the override would surface as a changed PDF rather than as an
error.

## Rewrite-preservation mode

`WEB_LATEX_MCP_REWRITE_MODE` sets the server-wide **default** for whether `edit_file` comments out the
text it replaces instead of discarding it — see [Rewrite-preservation mode](tools.md#rewrite-preservation-mode)
for what each mode does and where it applies. It is only a default: a project's own stored mode (set
with `set_rewrite_mode`) wins over it, and a per-call `preserveOriginal` on `edit_file` wins over both.

Unlike `WEB_LATEX_MCP_COMPILER`, an invalid value here does not fail to start the server — it falls
back to `prose` and logs the rejection to stderr. The two settings look similar (an env default with
tool-level overrides) but differ in what a wrong guess costs: a mis-set compiler backend can silently
change what a document compiles to, or fail outright, so it is worth refusing to guess. A mis-set
rewrite mode only changes whether a comment gets left in a diff you review before pushing, so falling
back rather than refusing to start is the friendlier failure here.

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

### Project-specific writing conventions

`WEB_LATEX_MCP_WRITING_GUIDE` and `WEB_LATEX_MCP_WRITING_GUIDE_EXTRA` do different things, and the names
are easy to mix up:

- `WEB_LATEX_MCP_WRITING_GUIDE` **replaces** the base guide outright — point it at your own guide and the
  bundled one is not read at all.
- `WEB_LATEX_MCP_WRITING_GUIDE_EXTRA` **appends** an additional guide on top of whatever base guide is in
  effect (bundled, or your `WEB_LATEX_MCP_WRITING_GUIDE` replacement) — it never replaces anything. Setting
  both is legal: your replacement base, plus your extra guide layered on top of it.

The extra guide is composed in **last**, under its own `## Project-specific conventions` heading, and
**takes precedence** where it contradicts the base guide — the instructions say so explicitly, so the
model treats a project-specific rule as the tie-breaker rather than picking one at random.

The value accepts either a filesystem path (absolute, `~`-relative, or relative to the launch dir) or a
`file://` URL — the latter so Claude Desktop users, who can't easily hand-edit a JSON `env` block, can
instead paste a file link. Only the **authority form** of a `file://` URL is accepted (e.g.
`file:///home/user/conventions.md`, with the triple slash); a bare `file:relative.md` is rejected. A
malformed value, a missing file, or an unreadable one is a loud warning to **stderr** — it never blocks
startup. In that case the variable is treated as unset: no extra guide is composed, and the base guide
loads normally.

Because the guide is loaded once per server process, scoping a set of conventions to one paper is done
by pointing this variable at a **different file per workspace** — a `.mcp.json` `env` block in Claude
Code, or the equivalent per-project Desktop config.

**Worked example.** A paper's workspace sets:

```json
{ "env": { "WEB_LATEX_MCP_WRITING_GUIDE_EXTRA": "/home/you/papers/lidar-survey/conventions.md" } }
```

Prefer an **absolute** path (or a `file:///...` URL) here. A relative value is resolved against the
**server process's launch directory**, not against the config file — which is the workspace in Claude
Code, but is the app bundle or `/` under Claude Desktop, where `./conventions.md` would silently become
`/conventions.md` and never load. If a relative path does not take, `server_info` reports the resolved
path and whether it loaded.

That `conventions.md` holds:

```markdown
- Always write "lidar", never "LiDAR".
```

Every session started in that workspace now gets the base writing guide plus this rule, with the rule
winning if the two ever disagree. Use the `add_writing_convention` tool (see
[tools.md](tools.md#tools)) to append new rules to this file from the chat instead of hand-editing it.

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

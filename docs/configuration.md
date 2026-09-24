# Configuration

The server is configured entirely through **environment variables**, set in your MCP client's `env`
block (see the [install guides](install/) for full `.mcp.json` / `claude_desktop_config.json` examples).

## Environment variables

| Variable                                                   | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEB_LATEX_MCP_PROJECTS`                                   | no\*     | JSON map of project id → either `{ gitUrl, rootFile?, branch?, username?, tokenEnv? }` (a remote to clone) or `{ mode: "local", path, rootFile?, followSymlinks? }` (a directory used in place; `~` and relative paths are resolved; `followSymlinks: true` lets reads, writes and listings follow a symlink out of that directory — off by default, and only ever set it when the links there are yours). \*Not strictly required — you can also register a project at runtime from the chat (`register_project`); set this to have projects present at boot. Each key must be a valid [project id](#project-ids); an entry whose key is not is skipped with a note on stderr, and the rest still load. See [Registering a project without env config](#registering-a-project-without-env-config). |
| `WEB_LATEX_MCP_WORKSPACE`                                  | no       | Directory holding one clone per project. Defaults to `<launch-dir>/.web_latex_mcp` when the launch dir is a git repo, else `~/.web-latex-mcp/projects` — see [Workspace-local clones](#workspace-local-clones). Set to `cwd` to force workspace-local, or to a path to override.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `WEB_LATEX_MCP_DEFAULT_PROJECT`                            | no       | Project id used when a tool call omits `project`. **Always wins** over a default persisted via `register_project { default: true }`, even across a restart. See [Setting a default project](#setting-a-default-project).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `WEB_LATEX_MCP_SESSION`                                    | no       | Name for this session when several agent sessions share one clone (e.g. `intro`, `experiments`). It is what peers see in `status`, and it scopes what `commit` commits. Reduced to letters, digits, `.`, `_` and `-` (at most 64 characters); `shelves`, `project.lock` and `rewrite-mode.json` are reserved in any case — they name project-wide state beside the session directories — and the server refuses to start with one. Defaults to a generated id — see [Parallel sessions](#parallel-sessions).                                                                                                                                                                                                                                                                                        |
| `WEB_LATEX_MCP_COMPILER`                                   | no       | Local compile backend: `latexmk` (default) or `tectonic`. Setting it is an **assertion**: that backend is never substituted, and a missing one is an error. Left unset, a missing `latexmk` falls back to an installed `tectonic`. See [Compile backend](#compile-backend).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `WEB_LATEX_MCP_REFERENCE_SOURCE`                           | no       | Bibliography backend for `search_references`: `dblp`, `crossref` or `openalex`. Setting it is an **assertion**: only that backend is tried, and one that cannot be reached is an error. Left unset, the server tries DBLP, then Crossref, then OpenAlex, and substitutes one it cannot reach — the result reports which answered. An unrecognised value does **not** stop the server: it is logged to stderr, reported by `server_info`, and makes `search_references` refuse an unpinned search by name (a per-call `source:` still works) — every other tool is unaffected. See [Reference backend](#reference-backend).                                                                                                                                                                          |
| `WEB_LATEX_MCP_CONTACT_EMAIL`                              | no       | Contact address sent to Crossref and OpenAlex, which give identified clients a faster "polite pool". **Opt-in only** — nothing is sent unless you set this, and it is never derived from your git config. A value that is not a plausible address in printable ASCII — with whitespace, a non-ASCII character, any of `&?#/();\`, or more than 254 characters (RFC 5321's limit) — is ignored with a note on stderr, and reported by `server_info` as `contactEmailInvalid` — as a boolean only, never the address, since unlike a mistyped backend id that value is personal data. See [Reference backend](#reference-backend).                                                                                                                                                                    |
| `WEB_LATEX_MCP_REWRITE_MODE`                               | no       | Default [rewrite-preservation mode](tools.md#rewrite-preservation-mode) for `edit_file`: `off` (default — nothing is preserved unless configured), `prose`, or `always`. Only the default — a project's own `set_rewrite_mode` setting wins over it, and a per-call `preserveOriginal` wins over both. An unrecognised value falls back to `off` and logs the rejection to stderr rather than failing to start; an empty or whitespace-only value is treated as unset.                                                                                                                                                                                                                                                                                                                              |
| `WEB_LATEX_MCP_VIEWER_PORT`                                | no       | Fixed loopback port for the PDF `viewer` and the `credential_portal` page. Default: each picks a free port the OS assigns when it starts. A value that is not an integer from 0 to 65535 stops the server at startup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `WEB_LATEX_MCP_VIEWER_TARGET`                              | no       | Where `viewer` sends its URL when a call passes no `target`: `browser` (default — the OS browser) or `vscode` (a VS Code Simple Browser tab). Any other value stops the server at startup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `WEB_LATEX_MCP_AUTHOR_NAME` / `WEB_LATEX_MCP_AUTHOR_EMAIL` | no       | Identity used for commits. Default `WebLatexMCP <web-latex-mcp@localhost>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `WEB_LATEX_MCP_WRITING_GUIDE`                              | no       | Path to a LaTeX writing guide surfaced to the client. **Replaces** the bundled [`writing-guide.md`](writing-guide.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `WEB_LATEX_MCP_WRITING_GUIDE_EXTRA`                        | no       | Path or `file://` URL to an ADDITIONAL, project-specific writing guide, **appended to** (never replacing) the base guide. See [Project-specific writing conventions](#project-specific-writing-conventions).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `WEB_LATEX_MCP_CONCURRENCY_GUIDE`                          | no       | Path to a concurrency / safe-push guide surfaced to the client. Default bundled [`CONCURRENCY.md`](CONCURRENCY.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `WEB_LATEX_MCP_SKILLS_DIR`                                 | no       | Directory of skills exposed as MCP prompts (one subdirectory per skill, each with a `SKILL.md`). Default bundled [`.claude/skills`](skills.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `WEB_LATEX_MCP_NO_OUTPUT_SCHEMA`                           | no       | Output-schema client compatibility. Default **auto-detects Claude Desktop** and omits `outputSchema`/`structuredContent` for it only; `1` forces omit for every client, `0` disables. See [Claude Desktop compatibility](#claude-desktop-compatibility).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `WEB_LATEX_MCP_SESSION_PROBE`                              | no       | Diagnostic only. Logs MCP connection and `_meta` information to **stderr** so a maintainer can find out how a client maps chats onto connections. Off unless set; `0`/`false`/`no`/`off` also mean off. See [Session identity probe](#session-identity-probe).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

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
so the env stays the source of truth when you use it. `registry.json` is read entry by entry: an entry
with an invalid [id](#project-ids) or an unusable shape is skipped with a note on stderr while the
others load, and is carried through untouched when the file is next rewritten. An empty (or
whitespace-only) `registry.json` is an empty registry. One that is not valid JSON at all, or not a
JSON object, is ignored at startup and **never overwritten** — `register_project` refuses until you
fix or move it, rather than drop every registration in it. (`project_sync` with a `gitUrl` also registers a
project, but only for the current process — use `register_project` to keep it across sessions.) See the
[tool reference](tools.md#registering-a-project-from-the-chat) for the full flow.

### Project ids

A project id becomes a directory name twice — the clone at `<workspace>/<id>` and the session state at
`<workspace>/.sessions/<id>/` — so it has to be usable as one directory name on every platform.
Only what is unsafe as one is refused; Unicode letters and digits, spaces and ordinary punctuation
are all fine (`thesis`, `paper-2026`, `thèse`, `My Thesis`, `論文`). An id is refused when it:

- contains a path separator (`/`, `\`) or another character a Windows file name cannot hold
  (`: < > " | ? *`);
- contains a backtick (it would break the code span a skill prompt shows the id in);
- contains a control character, a bidirectional-text control, or an unpaired surrogate (an id shown
  in a message must read as what it is);
- contains an invisible character — a format character or default-ignorable code point such as a
  zero-width space, word joiner, soft hyphen, variation selector or Hangul filler — since two ids
  differing only in one look identical. The exception is a zero-width non-joiner or joiner
  (U+200C/U+200D) _between two letters_ of a script whose spelling uses it (Persian and the other
  Arabic-script languages, Syriac, N'Ko, Mongolian, and the Brahmic scripts such as Devanagari),
  where it changes how the word is drawn; between Latin letters, at either end, or in an emoji
  sequence it is refused. A few correct spellings still fall outside that exception and are
  refused, because accepting them is not simple to do safely: an old-style Malayalam chillu
  (consonant, virama, ZWJ at the end of a word — use the atomic chillu letters U+0D7A–U+0D7F
  instead), a joiner in Myanmar or Khmer text, a Mongolian free variation selector
  (U+180B–U+180D, U+180F), and an Arabic prepended concatenation mark such as the number sign
  (U+0600–U+0605);
- contains a space other than the ordinary space U+0020 — a no-break space, an en/em/thin/hair
  space, an ideographic space — since `My Thesis` and the same text with a no-break space look
  identical; or a line or paragraph separator (U+2028/U+2029);
- starts with a combining mark (it would draw itself onto whatever precedes the id in a message);
- is not NFC-normalised — it is refused rather than normalised for you, since the directory it names
  must be the same on every system, and the message gives the NFC spelling to use;
- starts with `.` (including `.` and `..`) or `-`, starts or ends with whitespace, or ends in `.`
  (Windows drops a trailing dot or space);
- is a Windows device name (`con`, `nul`, `com1`, `lpt¹`, `conin$`, … with or without an
  extension), on any platform, so a configuration stays portable;
- is `registry.json` or begins `registry.json.`, or ends in `.pdf` — `compile` surfaces a project's
  PDF at `<workspace>/<id>.pdf`. These and the device names are compared ignoring case the way a
  case-insensitive disk does, which is more than ASCII case (`regiſtry.json`, with a long s, is
  refused too);
- contains `~` followed by a digit — the shape of a Windows 8.3 short name (`PAPER-~1`), which
  Windows resolves to whatever longer name it abbreviates, such as another project's clone;
- is `__proto__`, `constructor` or `prototype`;
- is longer than 64 characters, or 246 bytes in UTF-8 (the longest directory built from an id,
  the build directory `<id>-<8 hex digits>`, then still fits a 255-byte file name).

`register_project` and `project_sync` refuse an id outside that rule. They also refuse a **new** id
that differs from an existing project's only in letter case (`Thèse` beside `thèse`), since on macOS
and Windows both would name one directory — on every platform, so a configuration keeps working
when it moves. One directory also belongs to one project: registering a second id for a directory
another project already uses is refused.

An id outside the rule that is configured in `WEB_LATEX_MCP_PROJECTS`, or persisted in
`registry.json` by an earlier version, is **skipped at startup** with a note on stderr naming it,
and a call that names it gets the same explanation instead of "Unknown project". That includes a
call that omits `project` while `WEB_LATEX_MCP_DEFAULT_PROJECT` names the skipped id: the server
still starts, and keeps it as the default so the explanation reaches you. To keep using such a
project, rename its key to a valid id **and move its two directories under the workspace root to
the new name**: `<workspace>/<old id>` (the clone, for a git project) and
`<workspace>/.sessions/<old id>/` (its session state). Renaming the key alone leaves the project
looking never cloned, and orphans its session state.

Messages show an id in double quotes, with any control, bidirectional or invisible character
written as `\u{…}`, so what you read is what the id holds.

### Setting a default project

With one project registered and no `WEB_LATEX_MCP_DEFAULT_PROJECT` set, every call that omits `project`
fails, naming the registered ids and how to fix it — including from the chat, without editing config:
call `register_project` with just `project` and `default: true` — no `gitUrl`/`path` needed for a
project already registered, and its stored `rootFile`/`branch`/`username`/`tokenEnv` are kept, read
back from `registry.json` as it stands (for a project configured only through `WEB_LATEX_MCP_PROJECTS`,
from this process's config). That form takes no other field: passing `rootFile`, `branch`, `username`,
`tokenEnv` or `clone: false` with it is refused, because updating one needs `gitUrl` or `path` — and giving
either re-registers the project from those arguments alone, replacing the stored entry, so pass every
field you want kept — the result names any field of the previous configuration (persisted or in-process) the new registration dropped. That:

- makes it the default **immediately** in the current session — the very next call that omits `project`
  resolves to it;
- **persists** the flag (`"default": true` on its `registry.json` entry) so it stays the default across a
  restart and for every other session reading the same workspace — taking effect at once in every
  session that did not assert a default through the env var, whether or not it had one before;
- **replaces** any previous default — only one project is ever the default at a time.

`WEB_LATEX_MCP_DEFAULT_PROJECT` **always wins** when it is set, in every session that sets it, even over a
persisted `default: true` — the same "a setting is an assertion, an unset one is only a guess" rule as
[the compile backend](#compile-backend). `register_project` still persists the flag when asked even while
an env default is set (so a later, env-unset session picks it up), but its result text says the env
default is the one actually in effect this session.

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

Shelves taken by `shelve` live under the same directory, in `shelves/`, but are **project-scoped rather than per-session**: any session on the project can list and reclaim one. That is deliberate — a shelf only its author could see would reproduce the invisible `git stash@{0}` the tool exists to replace.

**Interim limitation: isolation is per server _process_, not per chat.** `WEB_LATEX_MCP_SESSION` is
read once from the environment at startup, so every chat that shares one configured server entry
shares one session identity and one set of shadow records — a `commit` from either chat carries
both chats' edits. To get the per-section isolation described above today, give each session its
**own server entry** with its own `WEB_LATEX_MCP_SESSION`, so each is a separate process. Making
one process serve several independent sessions is tracked in
[#18](https://github.com/elias-ramzi/WebLatexMCP/issues/18); the
[session identity probe](#session-identity-probe) is the measurement that decides how.

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

## Reference backend

`search_references` looks a paper up in an external bibliography, and `add_citation` fetches its
BibTeX from that same service. Three backends are supported.

- **DBLP** — computer science only, but the best metadata and cite keys for it. Serves BibTeX
  directly.
- **Crossref** — every discipline, the broadest coverage, and the publisher of record for most DOIs.
  Serves BibTeX directly, via its own `transform` endpoint.
- **OpenAlex** — broad and open, good for work Crossref indexes thinly. **Publishes no BibTeX of its
  own**: an `openalex:` key is resolved to the record's DOI and the entry fetched from Crossref. A
  record with no DOI is refused rather than assembled from metadata — see below.

### Record keys are namespaced

A search result's `key` names its backend: `dblp:conf/cvpr/HeZRS16`, `crossref:10.1109/CVPR.2016.90`,
`openalex:W2194775991`. `add_citation` routes on that prefix, so a key always goes back to the service
that issued it — whatever `WEB_LATEX_MCP_REFERENCE_SOURCE` says, since the configured source governs
_searching_, not fetching a record you already found. Bare DBLP keys still work, as do bare DOIs and
`dblp.org` / `doi.org` / `openalex.org` URLs.

### Choosing a bibliography, and when one is substituted

`search_references` also takes a per-call `source:` argument, which wins over the environment.

**A default falls back; a choice does not** — the same rule as the
[compile backend](#compile-backend), for the same reason: a setting is an assertion, never an
inference.

- **`WEB_LATEX_MCP_REFERENCE_SOURCE` unset** — the server tries DBLP, then Crossref, then OpenAlex,
  and substitutes one that cannot be reached. The result's `source` always names the backend that
  actually answered, and on a substitution `fallbackFrom` and `hint` say what happened, in the text
  channel as well as in `structuredContent`. A substitution is reported, never silent.
- **`WEB_LATEX_MCP_REFERENCE_SOURCE` set**, or a per-call `source:` — **never** substituted. A backend
  that cannot be reached is an error naming both routes out, rather than a quiet switch to a different
  bibliography than the one you asked for.
- **`WEB_LATEX_MCP_REFERENCE_SOURCE` set to something that is not a backend** (a typo like `crossreff`)
  — the server starts normally, logs the rejection to stderr, and `server_info` reports the value under
  `referenceSourceInvalid`. `search_references` then **refuses** an unpinned search with a message
  naming the value, the three valid ids, and both ways out: fix or unset the variable, or pass
  `source:` on the call — which still works. Nothing else in the server is affected: this setting
  governs `search_references` alone, so a typo in it is not a reason to lose `read_file`, `compile`,
  `commit` or `push`. It refuses rather than falling back to the unpinned order for the same reason a
  reachable-but-unasked-for backend is never substituted: you named a bibliography, and answering from
  a different one is a different claim.

**A search that succeeds with no results is an answer, not a failure.** It is returned as-is and no
other backend is tried: falling through would turn "DBLP has never heard of this" into "here is what
Crossref found instead", which is a different claim. If a paper is outside computer science, retry it
with `source: "crossref"` rather than reading an empty DBLP result as "this reference is wrong".

This fallback earns its keep right now: `dblp.org` currently sits behind an anti-bot proof-of-work
challenge, which it serves with an HTTP 200 and an HTML body. The server detects that and reports it
as a backend being unreachable — so an unpinned lookup simply answers from Crossref instead.

### Why an OpenAlex record without a DOI is refused

`add_citation` is the only sanctioned way into a `.bib`, and it is only worth that status because the
entry text provably comes from the service rather than from a model. OpenAlex serves no BibTeX, so its
records reach a bibliography only through their DOI. When there is no DOI there is no canonical entry
to fetch, and the server will not compose one from metadata — it refuses and tells you to search the
paper on DBLP or Crossref instead. That refusal is deliberate: a synthesized entry would look exactly
like a verified one.

### The polite pool

Crossref and OpenAlex both offer identified clients a faster service tier. The server sends an
identifying `User-Agent` naming the project and version, and — **only if you set
`WEB_LATEX_MCP_CONTACT_EMAIL`** — a `mailto` alongside it. Nothing is sent otherwise: the address is
never read from your git config or inferred any other way, because sending a personal address to a
third party should be a deliberate act. `server_info` reports whether one is configured, never the
address itself.

## Rewrite-preservation mode

`WEB_LATEX_MCP_REWRITE_MODE` sets the server-wide **default** for whether `edit_file` comments out the
text it replaces instead of discarding it — see [Rewrite-preservation mode](tools.md#rewrite-preservation-mode)
for what each mode does and where it applies. It is only a default: a project's own stored mode (set
with `set_rewrite_mode`) wins over it, and a per-call `preserveOriginal` on `edit_file` wins over both.

Unlike `WEB_LATEX_MCP_COMPILER`, an invalid value here does not fail to start the server — it falls
back to `off` and logs the rejection to stderr. The two settings look similar (an env default with
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

**How the token reaches git.** Only through the git process's environment, read by a credential
helper the server configures on that one command for the remote's own scheme and host — never in the
remote URL, `.git/config`, or a command line, so a process killed mid-push leaves nothing on disk.
For that host your own credential helpers are then set aside during the git command: they are
neither asked for the credential nor told about it (a token the resolver itself read from a helper
with `git credential fill` was read from it before the command), so a successful push does not store the token in your keychain. Any
other host a command reaches (a submodule, an LFS store) keeps your helpers and never sees the
token. When none of the sources above yields a token, git runs with your helpers exactly as usual.

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

To check how much has accumulated without opening the file, `server_info` reports
`writingGuideExtraRuleCount` — a live count of the file's top-level bullets, read fresh on every call
(so it also reflects a rule appended earlier in the same session, unlike the instructions text and the
`guide://latex/writing-guide` resource, both fixed at startup). It counts bullets, not text, so use it
to decide whether the file is worth opening for a full read, not as a substitute for reading it.

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

## Session identity probe

`WEB_LATEX_MCP_SESSION_PROBE=1` turns on **diagnostic stderr logging** for one open question: when you
open several chats against a single configured server, does the client open one MCP connection per
chat, one connection that tags each request with a conversation id, or one connection with nothing
distinguishing the chats at all? The answer decides how per-chat session isolation can work
(see [Parallel sessions](#parallel-sessions)), and it cannot be read off the code — it is a property
of the client.

It is **off unless you set it**, and `0`, `false`, `no` or `off` also mean off. When off, nothing is
installed — not a no-op, nothing — so a tool result is byte-identical either way.

With it on, every line is prefixed `[web-latex-mcp][probe]` (one `grep` away from the rest of the log)
and the server reports three things:

- each connection as it initializes, with a **monotonic counter** — so "one connection or N?" is read
  off the highest number rather than counted by hand;
- the `clientInfo` name and version negotiated on that connection, plus the **pid**, which answers the
  other half of the question: one server process or several;
- the `_meta` attached to each tool call, with the tool name, so you can line a call up with what you
  did in which chat. An absent `_meta` prints `(absent)`, kept deliberately distinct from an empty
  `{}` — that difference is itself part of the answer.

Two limits worth knowing before you paste the output anywhere. `_meta` is **client-controlled data of
unknown shape**: it is scrubbed of every configured token before printing and then truncated, in that
order, so a client that echoes a credential into `_meta` does not put it in a log you forward — but it
is still the client's data, so read it before sharing. And everything goes to **stderr**, never stdout,
which carries the JSON-RPC protocol.

```json
{ "env": { "WEB_LATEX_MCP_SESSION_PROBE": "1" } }
```

Leave it off in normal use: it is a measuring device for a specific question, not a logging level.

## Cross-platform notes

- File paths in tool output are POSIX (`/`), regardless of OS.
- Clones force `core.autocrlf=false`, so files keep their repo (LF) line endings and `edit_file`'s exact
  match is deterministic on Windows.
- Secrets come from env vars, the GitHub CLI, or your git credential helper — no OS-specific config.

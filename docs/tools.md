# Tools

All tools take an optional `project` id (defaults to `WEB_LATEX_MCP_DEFAULT_PROJECT`). File paths are always
POSIX (`/`-separated), on every OS.

| Tool                | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_projects`     | List configured projects: path, `mode` (`git` — a clone of a remote; `local` — a directory used in place) and whether each is there yet. When nothing is registered, says how to add one. Read-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `register_project`  | Register a project and **persist** it to the workspace, so it survives a restart and is picked up by other sessions — no `WEB_LATEX_MCP_PROJECTS` needed. Pass `gitUrl` for a git project (cloned immediately unless `clone: false`) — the intended path for Claude Desktop: just paste your Overleaf git URL in the chat. Pass `path` instead for a **local** project: something already on this machine, compiled and edited in place with no clone — a directory, or **a file inside it** (`~/proposals/eurohpc.md`, `paper/main.tex`), in which case the folder holding it is registered and a `.tex` named that way also becomes the `rootFile` (see [Local projects](#local-in-place-projects)). Exactly one of the two. See [Registering a project from the chat](#registering-a-project-from-the-chat).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `project_sync`      | Clone if missing, else fast-forward pull. Surfaces divergence instead of merging. Pass `gitUrl` to register a new project **for this session only** (not persisted — use `register_project` to keep it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `set_credential`    | Store a git token in your **OS keychain** (macOS Keychain / Windows Credential Manager / libsecret) for a `host` (e.g. git.overleaf.com) or a `project`, so the server authenticates without the token ever touching its config or the registry. The chat-friendly way to hand over an Overleaf token (create one under [Account Settings → Git integration](https://www.overleaf.com/user/settings)) on Claude Desktop. Requires `confirm: true`; reports whether a helper actually kept it. See [Registering credentials in Claude Desktop](configuration.md#registering-credentials-in-claude-desktop).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `credential_portal` | Open a small **loopback web page** where you type a git token, so the secret is entered on your machine and stored in the OS keychain **without ever passing through the chat** (ideal when the transcript is cloud-synced). Returns a `127.0.0.1` URL (auto-opens the browser); the token is POSTed straight to the local server, never returned to Claude. Give a `host` or `project`. Call again after submitting to read the result (`stored` / `not-persisted` / `awaiting-entry`). See [Registering credentials in Claude Desktop](configuration.md#registering-credentials-in-claude-desktop).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `list_files`        | List files, filter `tex` / `bib` / `docs` (prose: `.md`/`.markdown`/`.txt`/`.rst`/`.org`) / `assets` / `all`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `read_file`         | Read a text file (optional line range). Pass `ref` (e.g. `origin/main`) to read a committed version — the remote side of a conflict — instead of the working tree. Binaries return a path, not bytes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `write_file`        | Create or overwrite a file. Refuses if the file changed on disk since last read (see [Out-of-band edits](#out-of-band-edits)). A `.bib` target needs `confirmBibEdit: true` (see [Citations](#citations-via-dblp)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `edit_file`         | Surgical string-replacement edits (unique match unless `replaceAll`; atomic). Same out-of-band-edit guard. A `.bib` target needs `confirmBibEdit: true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `delete_file`       | Delete a file from the project. Same out-of-band-edit guard. A `.bib` target needs `confirmBibEdit: true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `list_references`   | Parse the project's **own** references and return them structured — key, type, title, authors, year, venue, DOI/arXiv, plus the file and line each sits on and the entry `raw`. Reads a BibTeX `.bib` (resolving `@string` macros), a LaTeX `thebibliography`, **or a reference list written as prose in a markdown/plain-text document**; each entry says which (`format`). `filter` searches key/title/authors/venue. Needs no remote, so it works on a local project. Read-only — see [References in any format](#references-in-any-format).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `check_citations`   | Cross-check what the document **cites** against what the bibliography **defines**, in one call: `undefinedCitations` (cited, no entry — these render as `[?]`), `uncitedEntries`, `duplicateKeys`, `incompleteEntries` (missing a field the BibTeX type requires). Reads the `\cite` family in `.tex` and pandoc `[@key]` in markdown. `bibliographyProject` checks the draft against a **shared bibliography in another registered project**. Structural only — for whether a reference is _correct_, use `search_references`. Read-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `search_references` | Look a publication up on **DBLP** over the network; returns candidates and their DBLP keys. Does **not** read the project — that's `list_references`. Read-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `add_citation`      | Fetch a reference from DBLP by key and append it to a `.bib` file, returning the `path` and `line` it landed on. The only sanctioned way to add a citation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `compile`           | Compile locally with latexmk; returns success, PDF path, structured errors/warnings (each with the originating source `file` when it can be determined; an **error** also carries a `snippet` — the 5 source lines around it, numbered from `snippetStartLine` — so a message like `Undefined control sequence`, which names no macro, is readable without a `read_file`) + a **de-noised** log tail (only errors/warnings and the `Output written on` summary — font/memory noise stripped; pass `rawLog: true` for the unfiltered tail, or read `logPath` for the full log). Snippets are for errors only (a normal build's hundreds of warnings would bury the result), cover at most 10 distinct locations, appear once per location, and are never guessed: a location the log did not name outright — which is every diagnostic under **tectonic**, whose logs carry no `file:line` — one the log itself contradicts, a line past the end of its file, or a file the document merely _named_ in its log all get none, and `omittedSnippetLocations` counts every location left without one. For workspace-local clones the PDF is surfaced at `.web_latex_mcp/<project>.pdf`. TikZ externalization (`\tikzexternalize`) needs system calls: pass `restrictedShellEscape: true` (preferred) or `shellEscape: true` — see [Shell escape](#shell-escape-for-tikz-externalization). A failure caused by a package missing from your **local TeX installation** names it in `missingPackages` (e.g. `["fontawesome"]`, parsed from the log's ``File `fontawesome.sty' not found`` errors) and carries a `hint` with the install command — only `.sty`/`.cls` names appear there, since a missing image is a document problem, not a missing package. |
| `viewer`            | Start an on-demand local browser viewer for the compiled PDF and return its `http://127.0.0.1:<port>/p/<id>` URL (also opens it unless `open: false`). Renders with pdf.js (zoom/scroll/search) and **hot-reloads on every compile, preserving your page and scroll position** — open it once beside the chat. For clients without a PDF surface (e.g. Claude Desktop). In VS Code pass `target: "vscode"` (or set `WEB_LATEX_MCP_VIEWER_TARGET=vscode`) to get the URL to open as a **Simple Browser** editor tab instead of the OS browser. Binds to loopback only; starts on first call, not at boot. Pin the port with `WEB_LATEX_MCP_VIEWER_PORT`. Read-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `list_comments`     | List the review comments the user attached to the compiled PDF in the viewer (select text → note). Each has the note, the selected PDF `quote`, and — via **SyncTeX** — the source `file`/`line` plus the 5 surrounding source lines (`snippet`, numbered from `snippetStartLine` — the same shape `compile` uses for an error), so Claude can make the requested edits. Default lists only open comments. Read-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `resolve_comments`  | Mark PDF comments resolved after addressing them (by `ids`, or all open ones), so the viewer clears them. Does not edit files or push.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `status`            | Branch, sync state vs the tracked remote — `ahead`/`behind` counts, a `syncState` (`in-sync`/`ahead`/`behind`/`diverged`), and `aheadCommits`/`behindCommits` (the actual commits either side). A non-zero `behind` means origin moved since the last sync and a push may conflict (counts reflect the last fetch — run `project_sync` to refresh). Also staged/unstaged/untracked and `externalChanges` (files edited directly, not via tools). When several sessions share the clone, splits the uncommitted files into `sessionChanges` / `otherChanges` and lists the `activeSessions` — see [Parallel sessions](#parallel-sessions).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `diff`              | Unified diff + per-file line counts. Pass `ref` (`"HEAD~3"`, a sha, `"origin/master"`, or a two-dot range `"a..b"`) to diff the working tree against a commit instead of the index, so work already committed this session can still be reviewed as a whole — see [Reviewing a whole session](#reviewing-a-whole-session).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `discard`           | Discard uncommitted changes (requires `confirm: true`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `commit`            | Stage and commit locally. Does **not** push. By default commits only **this session's** own edits, leaving other sessions' in-flight work uncommitted (`scope: "all"` commits the whole clone) — see [Parallel sessions](#parallel-sessions).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `push`              | Safe push: pull-rebase onto the latest remote, then push (never force). Surfaces conflicts for a human; retry with `resolutions` (merged content per conflicted file) to resolve. `mode: "branch"` for review. Requires `confirm: true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `reset_to_remote`   | Recover from a conflict without raw git: fetch, then hard-reset the clone to `origin/<branch>` (clean tree at the remote head) so you can re-apply edits. Destructive — discards local commits ahead of the remote and any uncommitted changes, and reports what it dropped. Never merges or pushes. Requires `confirm: true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `server_info`       | Report the running server version (read from the package's own `package.json`) plus runtime config: workspace root, whether the workspace is local to the launch dir, the `workspaceExcludePattern` the server added to the host repo's `.git/info/exclude` for the clone dir (present means it is already handled — **do not** add a `.gitignore` entry; note it is local to your checkout and invisible to collaborators), and the configured compiler. Read-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

| `list_skills` | List the LaTeX procedures bundled with this server (formatting, `.bib` normalization, citation verification, arXiv cleaning, paper summaries) with what each does and when to use it; pass `skill` to get one back in full and follow it. The model-facing counterpart to the [skill prompts](skills.md), which the **user** invokes. Read-only. |

| `doctor` | Report the local toolchain a compile depends on — configured compiler, installed engines, TeX distribution **and its age**, the package manager plus the repository it would install from (flagging a frozen `historic`/`tlnet-final` archive), whether `TEXMFHOME` and the system texmf tree are writable, `git`, and the workspace. Returns `ok` / `checks[]` / `engines[]` plus actionable `hints`. Local and read-only; pass `checkRepository: true` to also test the repository over the network (~8s timeout). Call it when a compile fails for a reason about the machine rather than the document — see [Missing packages](#missing-packages). |

## Local (in-place) projects

Not every document lives behind a git remote. A `.tex` inside a repo of your own — a CV in your website
repo, notes in a scratch directory — is registered by **path** instead. Point at the directory, or just at
the document itself:

```jsonc
register_project { "project": "proposal", "path": "~/proposals/eurohpc.md" }
// -> registers ~/proposals, noting it was pointed at eurohpc.md
register_project { "project": "cv", "path": "~/site/cv/resume.tex" }
// -> registers ~/site/cv, with rootFile: resume.tex
```

A project is always a **directory** — that is the sandbox tools read and write within, and the unit
`compile` builds — so naming a file registers the folder around it. Every file in that folder becomes
readable and editable, so point at a document that sits in its own directory rather than one loose in your
home folder. Only a `.tex` is taken as the LaTeX `rootFile`; a markdown or plain-text document is not a
LaTeX root, and an explicit `rootFile` always wins.

Nothing is cloned and nothing is copied: `read_file`, `write_file`, `edit_file` and `compile` operate on
exactly those files, so what Claude compiles is what your editor has open. This matters because the
alternative — registering the surrounding repo as a git project to reach one file — clones the whole
repo, sees only committed state, and leaves you with **two copies of the document** drifting apart.

What holds for a local project:

- **The target must already exist.** The server points at it; it never creates a directory for you.
- **Nothing is written into it but your files.** Build artifacts go to a temp build dir, and the compiled
  PDF is surfaced into the workspace (`<workspace>/<id>.pdf`), never dropped beside your `.tex`.
- **Everything outside that directory is off limits** — the same sandbox as a clone.
- **Git tools do not apply.** `status`, `diff`, `commit`, `push`, `discard`, `project_sync`,
  `reset_to_remote` and `read_file` with a `ref` all refuse with an explanation. There is no remote of
  ours, and the only repository around is _yours_ — the server will not commit to it, or read its
  history, on your behalf. Use your own git for that; the files are right where you left them.
- **The out-of-band-edit guard earns its keep here.** You have this file open in your editor, so
  `write_file`/`edit_file` refuse when the bytes changed since the server last read them (override with
  `overrideExternalChanges: true`).

> [!NOTE]
> Registering a local project points the server at a directory of your choosing, which it can then read
> and write. That is the feature, but it is worth being deliberate about which directory you name — as
> with any tool call, your client asks before the first one.

## Missing packages

A compile that fails because your TeX installation lacks a package reports it directly rather than
leaving you to parse the log:

```jsonc
{
  "success": false,
  "missingPackages": ["fontawesome"],
  "hint": "Missing from your local TeX installation: fontawesome. Install with your TeX distribution …",
}
```

Only `.sty` and `.cls` names appear there — a missing image or `.bbl` is a problem with the document, not
with the machine. Install it the way your distribution expects (`tlmgr install fontawesome`, or
`tlmgr --usermode install fontawesome` when you have no root) and compile again.

If that install fails, run [`doctor`](#tools): it reports whether the package manager can reach anything
at all. The common trap is an end-of-life TeX Live, whose `tlmgr` defaults to a frozen archive —
`tlmgr install` then fails in a way that looks like a network problem but is not:

```
warn distribution     TeX Live 2019/Debian — past end of life
warn package-manager  tlmgr revision 53568 — repository: https://…/historic/systems/texlive/2019/tlnet-final — (frozen archive)
ok   texmf-home       /home/you/texmf (writable)
ok   system-texmf     /usr/local/share/texmf (not writable — needs root)
```

The server never installs anything itself: it diagnoses and tells you the command to run.

## Registering a project from the chat

You don't have to set `WEB_LATEX_MCP_PROJECTS` up front — you can add a project mid-conversation just
by giving Claude its git URL (find an Overleaf URL under **Menu → Git**):

> 👽 Add my Overleaf project — the git URL is `https://git.overleaf.com/0123…`. Call it `thesis`.

Two tools register a project; they differ in whether the registration is remembered:

- **`register_project`** — persists the project to a `registry.json` in the workspace, so it is still
  there after you restart the client and is visible to any other session on the same machine. This is
  the recommended path, and the natural fit for **Claude Desktop**, where hand-editing the env config is
  awkward. It clones right away unless you pass `clone: false`. Re-registering the same id updates it.
- **`project_sync` with `gitUrl`** — a lightweight, **session-only** registration: it lives in this one
  server process and is gone on restart. Handy for a one-off; use `register_project` when you want it to
  stick.

The registry file stores only the id, git URL, and options (`rootFile` / `branch` / `username` /
`tokenEnv`) — **never a token**. Credentials are still resolved per host at git time (see
[Configuration → Tokens](configuration.md#tokens--resolved-per-host)). Projects configured through
`WEB_LATEX_MCP_PROJECTS` always take precedence over a persisted entry with the same id.

## Citations via DBLP

References are added through a verified path, never hand-written. `.bib` files are **protected**:
`write_file`, `edit_file`, and `delete_file` refuse a `.bib` target unless you pass `confirmBibEdit: true`
— a guard so an agent can't quietly rewrite the bibliography. The tool tells the agent to ask you first;
set the flag only after you approve a manual change (removing or fixing an entry).

To add a reference, use the two-step DBLP flow:

1. `search_references` queries the [DBLP search API](https://dblp.org/faq/How+to+use+the+dblp+search+API.html)
   and returns candidates, each with a DBLP record `key`.
2. `add_citation` takes that key, **re-fetches the canonical BibTeX from DBLP server-side**, and appends it
   to the project's `.bib` (deduplicated by cite key — re-adding is a no-op). Because the entry text comes
   from DBLP and not the model, citations are verifiable rather than invented. With one `.bib` in the
   project it's chosen automatically; otherwise pass `bibFile`.

## References in any format

A bibliography is not always a `.bib`, and a document is not always on a remote. A proposal drafted in
markdown carries its reference list as a numbered section; a paper without a `.bib` carries a LaTeX
`thebibliography`. `list_references` reads all three and reports which one each entry came from, so a
caller knows how far to trust the parsed fields:

| `format`  | Source                                      | Fields                                                         |
| --------- | ------------------------------------------- | -------------------------------------------------------------- |
| `bibtex`  | A `.bib` (`@string` venue macros resolved)  | Exact.                                                         |
| `bibitem` | `\bibitem{key} …` in a `.tex`               | Key exact; the description is free text, so fields are a hint. |
| `prose`   | A reference list in `.md` / `.txt` / `.rst` | Heuristic — `raw` is the ground truth.                         |

Prose parsing errs towards under-claiming: a `title` is only filled in when the text delimits it
(quotes, emphasis), and authors only when a parenthesized year separates them from the rest. A field
left empty means "the text didn't say", not "the reference is missing it" — `raw` always carries the
entry verbatim.

`check_citations` then does the cross-reference — the regex diff you would otherwise write by hand:

```jsonc
// check_citations { project: "proposal" }
{
  "undefinedCitations": [{ "key": "ghost2030", "uses": [{ "path": "proposal.md", "line": 4 }] }],
  "uncitedEntries": [{ "key": "never2019cited", "path": "ref.bib", "line": 17 }],
  "duplicateKeys": [],
  "incompleteEntries": [{ "key": "cabon2020virtual", "missing": ["journal|journaltitle"] }],
}
```

Both are read-only and neither touches git, so they work on a [local project](#local-in-place-projects)
with no remote at all. The [`/verify-citations` skill](skills.md) drives them, then checks each entry
against DBLP.

### A bibliography in another project

A draft often does not carry the bibliography it cites: a proposal in one folder, the group's shared
`ref.bib` in an Overleaf project. `bibliographyProject` names the project the entries live in, and the
cross-check happens in one call:

```jsonc
// check_citations { project: "proposal", bibliographyProject: "shared-bib" }
{
  "bibliographySources": ["ref.bib"], // paths relative to "shared-bib"
  "bibliographyProject": "shared-bib",
  "entryCount": 312,
  "undefinedCitations": [{ "key": "ghost2030", "uses": [{ "path": "proposal.md", "line": 4 }] }],
  "uncitedEntries": [], // see below
}
```

Two things about it are deliberate:

- **Each path stays sandboxed in its own project.** `documents` resolve inside `project`,
  `bibliography` inside `bibliographyProject`. Nothing crosses over, and the parameter takes a
  **project id**, not a `"project:path"` string — you reach another project only by naming one you
  registered, never by writing a path that walks out of this one. Reading is all it does: writing across
  projects (`add_citation` into someone else's `.bib`) stays a separate, deliberate act in that project.
- **The findings cover only what your draft cites.** A shared bibliography is _meant_ to hold hundreds of
  entries this draft does not use, so `uncitedEntries` comes back empty and `duplicateKeys` /
  `incompleteEntries` are limited to cited keys — `entryCount` still tells you how big it is. To audit
  the shared bibliography as a whole, run `check_citations` with `project: "shared-bib"` instead.

`undefinedCitations` is the answer you came for: keys the draft cites that the shared bibliography does
not define. Each one has to be added **there** — `add_citation { project: "shared-bib", … }`, from a
DBLP result, with that project's permission.

`list_references` has no equivalent parameter and needs none: it already reads whichever project
`project` names, so listing another project's references is just `list_references { project:
"shared-bib", filter: "…" }`. Only `check_citations` joins two sets, so only it names two projects.

## Shell escape (for TikZ externalization)

Documents that use TikZ externalization (`\usetikzlibrary{external}` + `\tikzexternalize`) compile each
picture in a separate sub-process, which needs TeX's system-call (`\write18`) mechanism. That is disabled
by default, so `compile` exposes two opt-in flags:

- **`restrictedShellEscape: true`** (preferred) — passes `-shell-restricted`, permitting only the helper
  binaries on TeX's allow-list. Safer, and sufficient for many externalization setups.
- **`shellEscape: true`** — passes `-shell-escape`, letting the document run **arbitrary** shell commands
  during compilation.

> ⚠️ **Security.** `-shell-escape` lets a `.tex` file execute arbitrary commands, and the document comes
> from a shared remote others can write to. Both flags default to `false`, are **never** inferred from
> document contents, and a failed compile is **never** silently retried with them enabled. When a compile
> fails only because system calls were disabled, the result carries a `hint` (and collapses the repeated
> per-figure `Package tikz Error`s into one diagnostic) so you can decide whether to re-run with a flag.
> Enable shell escape only for a project you trust; try `restrictedShellEscape` before `shellEscape`.

Independently of the flags, `compile` mirrors the project's subdirectory structure into its build
directory, so a document that writes to a relative path (like externalization's `imgs/` cache) no longer
dies with `I can't write on file`.

## Out-of-band edits

Because clones are ordinary git working trees — and, with [workspace-local clones](configuration.md#workspace-local-clones),
sit right in your editor — you may edit a `.tex` file directly while the agent is working. The server
guards against silently clobbering those edits, the same way `push` refuses when the remote moved:

- The server remembers the content of each file **it gave you in full** — `read_file`, and
  `list_references`, which hands back every entry verbatim — along with everything it writes. Other reads
  do not count, even when some of their bytes reach you: finding the root file to compile, fetching the
  five lines around a compile error or a PDF comment, or scanning your documents to answer a question
  about them (`check_citations` returns cite keys and line numbers, not content). None of those is
  something an edit could be based on, and treating them as if they were would let a later write clobber
  your edits believing they had already been read. Before `write_file`, `edit_file`,
  or `delete_file` touches a file, it re-checks the bytes on disk. If they changed since the server last
  saw them, the tool **refuses** with a message telling the agent to re-read first. Re-reading
  acknowledges your version and lets the next write through; passing `overrideExternalChanges: true`
  deliberately overwrites your on-disk changes.
- `status` reports an `externalChanges` list — files modified on disk directly rather than through the
  tools this session — so the agent can acknowledge your edits before building on them.
- Baselines reset after `project_sync` and `discard`, since those legitimately rewrite the working tree.

The guard is per session and in-memory; it complements git rather than replacing it (`diff` still shows
exactly what changed).

## Parallel sessions

One person can run several agent sessions on the same paper — one per section — each a separate server
process over the same clone. Name each with `WEB_LATEX_MCP_SESSION` (see
[Configuration](configuration.md#parallel-sessions)); the tools then behave as follows.

- **`commit` is session-scoped by default.** It commits only the edits _this_ session made, staging
  them directly rather than running `git add`, so a peer's half-written paragraph in the same file
  stays uncommitted on disk. The result carries `scope`, `session`, and `leftUncommitted` (what was
  deliberately not taken — a file can appear there even when the commit included part of it). Pass
  `scope: "all"` to commit the whole working tree instead, other sessions' work included.
- **`status` says who owns what.** `sessionChanges` / `otherChanges` split the uncommitted files,
  `activeSessions` lists the other sessions and whether they are still live, and `conflictedChanges`
  names files this session can no longer commit.
- **`push` waits for live peers.** A push has to rebase, and a rebase needs a clean tree — so it
  refuses while another live session has uncommitted work, naming who to wait for. Changes nobody owns
  (edited outside the server, or left by an exited session) do not block it.
- **Same-line collisions are surfaced, never guessed.** If this session and someone else changed the
  same lines, the file is flagged and excluded from commits, and stays flagged. The two ways out are
  `commit scope: "all"` (take the working tree as it stands) or `discard` (give up this session's
  version).

Mutating operations are serialised across processes with a lock file, so two servers never rewrite the
clone's index at once. The model, and what it deliberately does not do, is in [Parallel sessions on one
clone](CONCURRENCY.md#parallel-sessions-on-one-clone).

## Reviewing a whole session

`diff` with no `ref` shows uncommitted work — which goes blank the moment you commit, and the workflow
encourages committing several times in a session. Pass `ref` to diff the working tree against a commit
instead:

- `ref: "HEAD~3"` — everything since three commits ago, uncommitted edits included.
- `ref: "<sha>"` — since a commit you noted at the start of the session (`commit` returns its sha).
- `ref: "origin/master"` — what this branch has that the remote does not. (`push` reports the other
  direction, `remoteCommits`, and `status` reports `aheadCommits`.)
- `ref: "HEAD~3..HEAD~1"` — a two-dot range, when you want two commits compared and not the working tree.

`path` still narrows it to one file. `ref` and `staged` are contradictory and are rejected together
rather than one silently winning, and an unresolvable ref is reported by name instead of surfacing a raw
git error.

**On a shared clone this is not session-scoped.** `commit` takes only your own edits, but the history a
ref reaches into is everyone's — so `diff` against `HEAD~3` on a clone with several sessions shows peers'
commits alongside yours. It answers _what changed in this file_, not _what did I change_. For the latter,
diff against the sha your own last `commit` returned, or use `status`, whose `sessionChanges` /
`otherChanges` split is session-aware.

## Reviewable, safe pushes

`commit` and `push` are separate, and nothing pushes automatically. Review with `status` / `diff`,
`commit` locally, then `push` with `confirm: true`. Because people may also be editing in the Overleaf
web editor, `push` is **safe by default**: it `pull --rebase`s onto the latest remote (immediately before
pushing) and **never force-pushes**. A rebase conflict means the agent and a human touched the same lines —
`push` aborts the rebase and returns `status: "conflict"` — a full 3-way payload: each conflicted file's
`base`/`ours`/`theirs` (full contents) plus a marker `hunks` view, and top-level `conflictPaths`,
`remoteHead`, `mergeBase`, and `remoteCommits`. (You can read any side directly with `read_file(path, ref)`
— `ref` takes `remoteHead`/`mergeBase` or any commit sha.) It
never auto-merges. To resolve, retry `push` with a `resolutions` array — the full merged content for each
conflicted file (`.bib` files need `confirmBibEdit: true`); the set is validated (missing/extra files are
named), an optional `expectedRemoteHead` refuses the push if the remote moved again (abbreviated SHAs are
accepted), and success returns `pushedSha`. The whole conflict payload is delivered in the result **text**
(not only `structuredContent`), so a client that drops structured fields can still resolve. A successful
`direct` push also reports `rebasedOver` — the remote commits that landed underneath your change. For
larger edits, `mode: "branch"` commits to a local review branch and returns its diff, landing it only on
`approve: true`. See [`CONCURRENCY.md`](CONCURRENCY.md) for the full model.

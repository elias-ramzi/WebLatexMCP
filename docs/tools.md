# Tools

All tools take an optional `project` id (defaults to `WEB_LATEX_MCP_DEFAULT_PROJECT`). File paths are always
POSIX (`/`-separated), on every OS.

| Tool                | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_projects`     | List configured projects and their clone status.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `project_sync`      | Clone if missing, else fast-forward pull. Surfaces divergence instead of merging. Pass `gitUrl` to register a new project.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `list_files`        | List files, filter `tex` / `bib` / `assets` / `all`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `read_file`         | Read a text file (optional line range). Pass `ref` (e.g. `origin/main`) to read a committed version — the remote side of a conflict — instead of the working tree. Binaries return a path, not bytes.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `write_file`        | Create or overwrite a file. Refuses if the file changed on disk since last read (see [Out-of-band edits](#out-of-band-edits)). A `.bib` target needs `confirmBibEdit: true` (see [Citations](#citations-via-dblp)).                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `edit_file`         | Surgical string-replacement edits (unique match unless `replaceAll`; atomic). Same out-of-band-edit guard. A `.bib` target needs `confirmBibEdit: true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `delete_file`       | Delete a file from the project. Same out-of-band-edit guard. A `.bib` target needs `confirmBibEdit: true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `search_references` | Search DBLP for publications; returns candidates and their DBLP keys. Read-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `add_citation`      | Fetch a reference from DBLP by key and append it to a `.bib` file. The only sanctioned way to add a citation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `compile`           | Compile locally with latexmk; returns success, PDF path, structured errors/warnings (each with the originating source `file` when it can be determined) + a **de-noised** log tail (only errors/warnings and the `Output written on` summary — font/memory noise stripped; pass `rawLog: true` for the unfiltered tail, or read `logPath` for the full log). For workspace-local clones the PDF is surfaced at `.web_latex_mcp/<project>.pdf`. TikZ externalization (`\tikzexternalize`) needs system calls: pass `restrictedShellEscape: true` (preferred) or `shellEscape: true` — see [Shell escape](#shell-escape-for-tikz-externalization).                   |
| `viewer`            | Start an on-demand local browser viewer for the compiled PDF and return its `http://127.0.0.1:<port>/p/<id>` URL (also opens it unless `open: false`). Renders with pdf.js (zoom/scroll/search) and **hot-reloads on every compile, preserving your page and scroll position** — open it once beside the chat. For clients without a PDF surface (e.g. Claude Desktop). In VS Code pass `target: "vscode"` (or set `WEB_LATEX_MCP_VIEWER_TARGET=vscode`) to get the URL to open as a **Simple Browser** editor tab instead of the OS browser. Binds to loopback only; starts on first call, not at boot. Pin the port with `WEB_LATEX_MCP_VIEWER_PORT`. Read-only. |
| `list_comments`     | List the review comments the user attached to the compiled PDF in the viewer (select text → note). Each has the note, the selected PDF `quote`, and — via **SyncTeX** — the source `file`/`line` plus a surrounding snippet, so Claude can make the requested edits. Default lists only open comments. Read-only.                                                                                                                                                                                                                                                                                                                                                  |
| `resolve_comments`  | Mark PDF comments resolved after addressing them (by `ids`, or all open ones), so the viewer clears them. Does not edit files or push.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `status`            | Branch, sync state vs the tracked remote — `ahead`/`behind` counts, a `syncState` (`in-sync`/`ahead`/`behind`/`diverged`), and `aheadCommits`/`behindCommits` (the actual commits either side). A non-zero `behind` means origin moved since the last sync and a push may conflict (counts reflect the last fetch — run `project_sync` to refresh). Also staged/unstaged/untracked and `externalChanges` (files edited directly, not via tools). When several sessions share the clone, splits the uncommitted files into `sessionChanges` / `otherChanges` and lists the `activeSessions` — see [Parallel sessions](#parallel-sessions).                          |
| `diff`              | Unified diff + per-file line counts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `discard`           | Discard uncommitted changes (requires `confirm: true`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `commit`            | Stage and commit locally. Does **not** push. By default commits only **this session's** own edits, leaving other sessions' in-flight work uncommitted (`scope: "all"` commits the whole clone) — see [Parallel sessions](#parallel-sessions).                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `push`              | Safe push: pull-rebase onto the latest remote, then push (never force). Surfaces conflicts for a human; retry with `resolutions` (merged content per conflicted file) to resolve. `mode: "branch"` for review. Requires `confirm: true`.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `reset_to_remote`   | Recover from a conflict without raw git: fetch, then hard-reset the clone to `origin/<branch>` (clean tree at the remote head) so you can re-apply edits. Destructive — discards local commits ahead of the remote and any uncommitted changes, and reports what it dropped. Never merges or pushes. Requires `confirm: true`.                                                                                                                                                                                                                                                                                                                                     |
| `server_info`       | Report the running server version (read from the package's own `package.json`) plus runtime config: workspace root, whether the workspace is local to the launch dir, and the configured compiler. Read-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

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

- The server remembers the content of each file it reads or writes. Before `write_file`, `edit_file`, or
  `delete_file` touches a file, it re-checks the bytes on disk. If they changed since the server last saw
  them, the tool **refuses** with a message telling the agent to re-read first. Re-reading acknowledges
  your version and lets the next write through; passing `overrideExternalChanges: true` deliberately
  overwrites your on-disk changes.
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

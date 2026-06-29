# Tools

All tools take an optional `project` id (defaults to `GIT_MCP_DEFAULT_PROJECT`). File paths are always
POSIX (`/`-separated), on every OS.

| Tool                | Description                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_projects`     | List configured projects and their clone status.                                                                                                               |
| `project_sync`      | Clone if missing, else fast-forward pull. Surfaces divergence instead of merging. Pass `gitUrl` to register a new project.                                     |
| `list_files`        | List files, filter `tex` / `bib` / `assets` / `all`.                                                                                                           |
| `read_file`         | Read a text file (optional line range). Binaries return a path, not bytes.                                                                                     |
| `write_file`        | Create or overwrite a file. A `.bib` target needs `confirmBibEdit: true` (see [Citations](#citations-via-dblp)).                                               |
| `edit_file`         | Surgical string-replacement edits (unique match unless `replaceAll`; atomic). A `.bib` target needs `confirmBibEdit: true`.                                    |
| `delete_file`       | Delete a file from the project. A `.bib` target needs `confirmBibEdit: true`.                                                                                  |
| `search_references` | Search DBLP for publications; returns candidates and their DBLP keys. Read-only.                                                                               |
| `add_citation`      | Fetch a reference from DBLP by key and append it to a `.bib` file. The only sanctioned way to add a citation.                                                  |
| `compile`           | Compile locally with latexmk; returns success, PDF path, structured errors/warnings + raw log tail.                                                            |
| `status`            | Branch, ahead/behind, staged/unstaged/untracked.                                                                                                               |
| `diff`              | Unified diff + per-file line counts.                                                                                                                           |
| `discard`           | Discard uncommitted changes (requires `confirm: true`).                                                                                                        |
| `commit`            | Stage and commit locally. Does **not** push.                                                                                                                   |
| `push`              | Safe push: pull-rebase onto the latest remote, then push (never force). Surfaces conflicts for a human; `mode: "branch"` for review. Requires `confirm: true`. |

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

## Reviewable, safe pushes

`commit` and `push` are separate, and nothing pushes automatically. Review with `status` / `diff`,
`commit` locally, then `push` with `confirm: true`. Because people may also be editing in the Overleaf
web editor, `push` is **safe by default**: it `pull --rebase`s onto the latest remote (immediately before
pushing) and **never force-pushes**. A rebase conflict means the agent and a human touched the same lines —
`push` aborts the rebase and returns `status: "conflict"` with both versions, for a human to resolve; it
never auto-merges. For larger edits, `mode: "branch"` commits to a local review branch and returns its
diff, landing it only on `approve: true`. See [`CONCURRENCY.md`](CONCURRENCY.md) for the full model.

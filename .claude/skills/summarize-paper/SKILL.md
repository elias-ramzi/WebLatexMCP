---
name: summarize-paper
description: Write (or update) a small local markdown summary of the paper so future Claude sessions can pick it up fast without re-reading every .tex. The summary lives in the project clone but is kept out of git (local-only, never pushed) via the clone's .git/info/exclude. Use when the user asks to "summarize the paper", "make/update a paper summary", "write local notes about the project", or "create a cheat-sheet for future sessions". Reads the paper through the latex-git MCP server; writes only a local, git-excluded note (never the .tex or .bib).
---

# Summarize a paper into a local, git-excluded note

Build a compact, high-signal summary of the project's paper and keep it in a **local markdown file** so a
future session can get oriented in seconds instead of re-reading the whole source. The skill **creates**
the note the first time and **updates** it on later runs. It reads the paper through the `latex-git` MCP
tools but only ever writes the one local note — never the `.tex`, never the `.bib`.

The summary is for **Claude's** benefit across sessions: a navigation index and a cheat-sheet, not a
rewrite of the paper. Keep it small (aim for ~1 page) and derive every fact from the actual source — cite
the paper's own `\label`s and section names; don't pad it with outside knowledge about the topic.

## Where it lives, and why it's git-excluded

- **Path:** `paper-summary.local.md` at the **root of the project clone** (configurable — honor a name the
  user gives). A single root-level file, not a subdirectory.
- **Kept out of git via the clone's `.git/info/exclude`**, not a committed `.gitignore`. That matters:
  - `commit` stages with `git add -A`, so an un-ignored local file **would** get committed and pushed to
    Overleaf/GitHub. Excluding it prevents that.
  - It then never shows up in `status`/`diff` noise, and is **preserved by `discard`** (which runs
    `git clean -fd` — git leaves ignored files alone).
  - `.git/info/exclude` is **per-clone and never pushed**, so the file stays truly local and you don't
    modify a tracked `.gitignore` (which would itself be a change destined for the remote). If the user
    explicitly wants the rule shared with collaborators, _then_ add it to `.gitignore` instead — but that
    is a normal `.tex`-side edit they must approve and later commit.

## Workflow

Run in order. Stop and report if a step fails.

1. **Pick the project.** `list_projects`; if the user didn't name one, ask which. Note the project's clone
   **`path`** from the result — you need the absolute path for the exclude step — and that it's `cloned`.
2. **Fetch the latest version first.** Always run `project_sync` **before** reading anything, so the
   summary reflects the current remote source and not a stale local clone. Do this even if you just synced
   in this session — the paper may have moved on Overleaf/GitHub since. If the sync reports divergence or
   fails, stop and report it rather than summarizing an out-of-date clone.
3. **Make the note git-excluded _before_ writing it.** Append the filename to the clone's
   `.git/info/exclude` if it isn't already there, so the file can never be accidentally staged. Using the
   clone `path` from step 1:

   ```bash
   DIR="<clone path from list_projects>"
   NOTE="paper-summary.local.md"
   mkdir -p "$DIR/.git/info"
   grep -qxF "$NOTE" "$DIR/.git/info/exclude" 2>/dev/null || printf '%s\n' "$NOTE" >> "$DIR/.git/info/exclude"
   git -C "$DIR" check-ignore "$NOTE"   # must echo the filename → confirms it's now ignored
   ```

   If `check-ignore` prints nothing, the exclude didn't take — fix it before going further.

4. **Load context.** If the note already exists, `read_file` it first (you're updating, not clobbering —
   see below). Then read the paper: `list_files` with `filter: "tex"`, `read_file` the main file and the
   `\input` section files. Skim, don't memorize — you're extracting structure and headline facts.
5. **Write or update the note** with `write_file` (path `paper-summary.local.md`). Keep it small and
   high-signal (see _What goes in it_). Because the file is git-excluded, `write_file`'s returned `diff`
   will be empty — that's expected, not an error.
6. **Verify it's invisible to git.** Call `status` and confirm the note is **not** in the untracked list
   (the exclude is doing its job).
7. **Report** where the note is, that it's local-only (never pushed), and a one-line list of what you
   captured. No `compile`, no `commit`, no `push` — this skill touches no tracked file.

Everything reads/writes within the one project, so the per-project mutex serializes it.

## What goes in it (small + high-signal)

Lead with a header marker so the file's nature is unmistakable, then the sections below. Drop any section
that doesn't apply rather than padding it.

```markdown
<!--
Local working summary maintained by Claude (the `summarize-paper` skill).
Git-excluded — local only, never pushed to the remote. Safe to edit or delete.
Last updated: 2026-06-29
-->

# <paper title> — working summary

**Venue / target:** … **Status:** … (only if stated in the source — don't invent a deadline)

**In one paragraph:** the problem, the approach, and the contribution.

**Contributions**

- …

**Section map** (the navigation index — the highest-value part)

- `sec:intro` — motivation & contributions — `sections/introduction.tex`
- `sec:method` — … — `sections/method.tex`
- …

**Key terms & notation:** method names, acronyms, symbols — one line each.

**Key results:** datasets, metrics, headline numbers (kept brief).

**Open threads:** `\todo{}`s, stubbed/empty sections, TBD numbers — what's unfinished.

**File map:** main file, `sections/`, figures/tables, `.bib` — where things live.
```

Derive all of this from the text you read (reference the real `\label`s and filenames). The section map +
file map are what actually save compute next session: they let Claude jump straight to the right file.

## Updating an existing summary

When the note is already there, **update in place** — don't regenerate from scratch:

- **Preserve anything a human added.** If the user wrote their own notes (e.g. a `## Notes` or `## TODO`
  section, or inline remarks), keep them verbatim. Only refresh the parts you generated.
- Reconcile the generated sections with the current source: add new sections to the section map, drop
  removed ones, update results/terms that changed.
- Refresh the `Last updated:` date in the header marker.
- Keep the structure stable so the change stays small and reviewable — rewrite only what actually moved.

## Using it in future sessions

This file is the fast path: at the **start** of a new session working on this paper, `read_file`
`paper-summary.local.md` first (if present) before opening the `.tex`. The section/file map tells you
where to look, so you only read the parts you need. If you do substantial work that changes the paper's
structure or claims, re-run this skill at the end to keep the note current.

## After you finish

Report concisely: the note's path, that it's git-excluded and local-only (won't be committed or pushed),
whether you created or updated it, and a one-line summary of what it now covers.

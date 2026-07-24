---
name: arxiv-clean-project
description: Prepare a LaTeX/Overleaf project for arXiv submission with google-research/arxiv-latex-cleaner — strip source comments, delete draft macros (\todo, \note, review environments), and optionally shrink oversized figures to fit arXiv's 50MB limit. Produces either a separate submission-ready copy (the tool's native mode) or applies the cleaning back into the project in place. Use when the user asks to "clean", "arxiv-clean", "prepare for arXiv/submission", "strip comments/todos", or "make a submission copy" of an Overleaf/LaTeX project. Operates on projects served by the web-latex-mcp MCP server. NOT for cosmetic reformatting (that is format-latex-project).
allowed-tools:
  - Bash(arxiv_latex_cleaner:*)
  - Bash(pipx install arxiv-latex-cleaner:*)
  - Bash(pip install arxiv-latex-cleaner:*)
  - Bash(pip install --user arxiv-latex-cleaner:*)
  - Bash(zip:*)
---

# Clean a LaTeX project for arXiv

Run [`arxiv-latex-cleaner`](https://github.com/google-research/arxiv-latex-cleaner) over a git-hosted
LaTeX project served by the `web-latex-mcp` MCP tools. The cleaner is a Python CLI that operates on a
folder and, by default, **strips every `%` comment**, deletes the draft commands and environments you
name (`\todo{...}`, review macros, `note` blocks), and can resize/compress figures.

Unlike `format-latex-project`, this skill **intentionally changes the compiled PDF** — removing todos and
notes removes content. The compile step is a guardrail only for _"still builds cleanly"_, not for
_"identical output"_.

Two output modes; **ask the user which they want each run** (after the baseline compile):

- **Separate copy** — produce a cleaned `<id>_arXiv/` folder **and always a `<id>_arXiv.zip`** beside the
  clone (exact location in step 8), leaving the live project untouched. This is the tool's native behavior
  and the safe default: the working project keeps its comments and todos for ongoing collaboration.
- **In place** — apply the cleaning back into the project through the MCP write/edit/delete tools, guard
  with `compile`, show the `diff`, and `commit`/`push` only if asked. **Destructive**: it strips the
  comments and draft macros out of the live Overleaf project.

## Workflow

Run in order. Stop and report if any step fails.

1. **Pick the project.** If the user didn't name one, call `list_projects` and ask which.
2. **Sync & baseline.** `project_sync` the project, then `compile`. Record success + page count. **If it
   does not compile cleanly to begin with, stop** and tell the user — do not clean a broken project.
3. **Get the clone path from the server — don't guess it.** The cleaner needs a real folder, and
   `list_projects` returns the authoritative one: each project's `path` is its on-disk clone directory
   (`<workspaceRoot>/<id>`), with a `cloned` flag. Call `list_projects`, take the `path` for your project
   as `<clone>`, and confirm `cloned` is true (if not, `project_sync` first). This is drift-proof — the
   server computes `path` the same way it decides where clones live, so it stays correct no matter how
   `WEB_LATEX_MCP_WORKSPACE` is set (home default, the `cwd` workspace-local dir, or an explicit path).
   Set `<workspaceRoot>` to the parent of `<clone>` — **step 8 writes the cleaned copy + zip there**, beside
   the clone. Because server and agent share a filesystem (stdio), the clone — figures and all — is already
   on disk; there is nothing to "pull". If `list_projects` shows the project but `path` is not reachable
   from your shell, the server is not co-located; stop and tell the user rather than producing a partial
   archive.

4. **Ensure the tool is installed.** `arxiv_latex_cleaner --help`. If missing, install it (needs Python
   ≥3.9): prefer `pipx install arxiv-latex-cleaner`, else `pip install --user arxiv-latex-cleaner`.
5. **Detect draft macros to delete.** `grep` the `.tex` for `\usepackage{todonotes}` and common draft
   commands/environments actually used: `\todo`, `\note`, `\comment`, `\fixme`, `\revise`, and any
   custom review macros (`\newcommand{\ER}{...}` etc.). **Present the list and confirm** before deleting
   — removing the wrong command changes the PDF. Split them:
   - `--commands_to_delete` — command _and_ its wrapped text go (e.g. `todo`, `note`, `fixme`).
   - `--commands_only_to_delete` — command wrapper goes, wrapped text stays (e.g. `\revised{keep this}`).
   - `--environments_to_delete` — whole environments go (e.g. a `note`/`comment` env).
6. **Choose the mode.** Ask **separate copy** vs **in place** (defaults per operations below).
7. **Run the cleaner** on a scratchpad _copy_ of the clone (never point it at the live clone's `.git`):

   ```bash
   cp -r "<clone>" "<scratch>/<id>" && rm -rf "<scratch>/<id>/.git"
   arxiv_latex_cleaner "<scratch>/<id>" --keep_bib \
     --commands_to_delete todo note fixme \
     --environments_to_delete note comment
   # -> writes the cleaned tree to <scratch>/<id>_arXiv/  (basename tracks the input dir)
   ```

   Always pass `--keep_bib` (default operation; keeps this repo's `.bib`-guarding intent). Add image or
   TikZ-externalization flags only if the user opted in (see below).

8. **Deliver by mode:**
   - **Separate copy (always zip):** place the cleaned tree **and a zip** beside the clone, in
     `<workspaceRoot>` — clearing any stale prior run first. The zip holds the cleaned files at its root
     (arXiv-ready — no wrapping folder). **No MCP mutation.**

     ```bash
     rm -rf "<workspaceRoot>/<id>_arXiv" "<workspaceRoot>/<id>_arXiv.zip"
     cp -r "<scratch>/<id>_arXiv" "<workspaceRoot>/<id>_arXiv"
     ( cd "<workspaceRoot>/<id>_arXiv" && zip -r "../<id>_arXiv.zip" . )
     ```

     Keep **both** the folder and the zip, then **surface the zip** (see "Surfacing the zip" below) and
     stop — the live project is never touched.

   - **In place:** reconcile the cleaned tree back into the project **through MCP tools** — for each
     changed `.tex`, `write_file` the cleaned content; `delete_file` anything the cleaner dropped. This
     keeps the per-project mutex and guards in play (`.bib` is untouched thanks to `--keep_bib`). Then
     go to step 9.

9. **Recompile (in-place only).** `compile` again — it must still succeed. Fewer pages / removed content
   is expected; broken build is not. If it breaks, fix it, or `discard` and report.
10. **Review (in-place only).** Show the `diff`. Do **not** `commit`/`push` unless the user asks — per
    CLAUDE.md, mutating the remote happens only on explicit request.

Do all MCP edits inside the one project so the per-project mutex serializes them.

## Surfacing the zip (separate-copy mode)

Give the user a usable pointer to `<workspaceRoot>/<id>_arXiv.zip`:

- When `<workspaceRoot>` is **inside the Bash working directory** — the `cwd` sentinel, the common case
  here, where the zip lands under the git-excluded `.web_latex_mcp/` — present a **clickable
  workspace-relative link**, e.g. `[.web_latex_mcp/<id>_arXiv.zip](.web_latex_mcp/<id>_arXiv.zip)`. It is
  durable across sessions and already untracked, so it never shows in this repo's `git status`.
- Otherwise (home-dir default, or an explicit path outside the workspace) give the **absolute path** and
  note it lives outside the IDE workspace, so it can't be a clickable relative link.
- If `<workspaceRoot>` happens to sit inside some _other_ git repo that does not already exclude it, add
  `<id>_arXiv/` and `<id>_arXiv.zip` to that repo's `.git/info/exclude` so the export is never
  accidentally tracked (the same local-exclude trick `summarize-paper` uses).

Report the zip's size and the page count before/after alongside the link.

## Default operations

Enabled by default (chosen for this skill): **strip comments** (intrinsic to the cleaner — there is no
keep-comments flag), **remove `\todo`/notes** (step 5), and **`--keep_bib`**. Comment stripping is why
in-place mode is destructive — call that out to the user before applying it in place.

## Image compression (opt-in)

Only when the user asks (e.g. "shrink it to fit arXiv's 50MB limit"). These act on the clone's binary
assets, which are already on disk (step 3):

- `--resize_images --im_size 1000` — cap the longest side at N px.
- `--convert_png_to_jpg --png_quality 80` — re-encode large PNGs as JPG.
- `--compress_pdf --pdf_im_resolution 500` — ghostscript PDF compression (Linux/macOS only).

Recompile and eyeball figure quality in the PDF before recommending a commit — over-aggressive resizing
degrades figures.

## TikZ externalization (opt-in — only if the project already externalizes)

`--use_external_tikz <dir>` swaps each `tikzpicture` in the cleaned copy for an `\includegraphics` of the
already-externalized PDF found in `<dir>` (the folder the TikZ `external` library wrote to, e.g.
`figures/tikz`). It keeps arXiv from having to compile TikZ at all.

**The flag only substitutes — it never generates.** `arxiv_latex_cleaner` does not run LaTeX, so the
externalized PDFs must already exist in the clone before you run it.

**First check whether the project already externalizes**: `grep` the `.tex` for
`\usetikzlibrary{external}` / `\tikzexternalize` (and its
`\tikzsetexternalprefix` / `\tikzexternalize[prefix=...]` target), then confirm that folder actually holds
one PDF per `tikzpicture`.

- **Already set up** — offer the flag as an opt-in. Note that the externalized PDFs are only as fresh as
  the last shell-escape compile (`latexmk -shell-escape`): if the TikZ source changed afterwards, the
  substituted figures are stale, so have the project recompiled before cleaning.
- **Not set up (or the folder is missing/empty/stale)** — **do not pass the flag** and do not attempt to
  add externalization silently. Tell the user first what it would take:
  - the Overleaf/LaTeX source must be **changed** — load the `external` library, call `\tikzexternalize`
    with a prefix, and compile with shell-escape enabled — which is an edit to the live project, not
    something this cleaning step does on its own;
  - and to trust the resulting PDFs, the **TeX Live release arXiv runs** should be installed locally and
    used for that compile (arXiv documents the current release at
    <https://info.arxiv.org/help/faq/texlive.html>) — figures built against a different TeX Live can
    render differently from what arXiv would produce.

  Then offer to proceed **without** the flag (the normal path — arXiv compiles the TikZ itself), or to
  stop so the user can set externalization up and re-run this skill.

## After you finish

Report concisely: which draft macros/environments were removed, whether comments were stripped, and the
page count before/after. For **separate-copy**, surface the `<id>_arXiv.zip` per "Surfacing the zip"
(clickable relative link when the workspace is local) and confirm the live project was left untouched. For
**in-place**, confirm it still compiles, point the user at the `diff`, and ask whether to commit and push.

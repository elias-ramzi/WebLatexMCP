---
name: arxiv-clean-project
description: Prepare a LaTeX/Overleaf project for arXiv submission with google-research/arxiv-latex-cleaner — strip source comments, delete draft macros (\todo, \note, review environments), and optionally shrink oversized figures to fit arXiv's 50MB limit. Produces either a separate submission-ready copy (the tool's native mode) or applies the cleaning back into the project in place. Use when the user asks to "clean", "arxiv-clean", "prepare for arXiv/submission", "strip comments/todos", or "make a submission copy" of an Overleaf/LaTeX project. Operates on projects served by the web-latex-mcp MCP server. NOT for cosmetic reformatting (that is format-latex-project).
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

- **Separate copy** — produce a cleaned `..._arXiv` folder (and, if asked, a `.zip`) and leave the live
  project untouched. This is the tool's native behavior and the safe default: the working project keeps
  its comments and todos for ongoing collaboration.
- **In place** — apply the cleaning back into the project through the MCP write/edit/delete tools, guard
  with `compile`, show the `diff`, and `commit`/`push` only if asked. **Destructive**: it strips the
  comments and draft macros out of the live Overleaf project.

## Workflow

Run in order. Stop and report if any step fails.

1. **Pick the project.** If the user didn't name one, call `list_projects` and ask which.
2. **Sync & baseline.** `project_sync` the project, then `compile`. Record success + page count. **If it
   does not compile cleanly to begin with, stop** and tell the user — do not clean a broken project.
3. **Locate the clone on disk.** The cleaner needs a real folder. The MCP server clones each project to
   `{WEB_LATEX_MCP_WORKSPACE}/{id}` (default `~/.web-latex-mcp/projects/{id}` when the env var is unset).
   Resolve that path, confirm it is a git repo whose contents match `list_files`. If you can't find it,
   ask the user for the clone path (or, for text-only cleaning, mirror the `.tex` files into the
   scratchpad via `list_files` + `read_file` — see note below).
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
   cp -r "<clone>" "<scratch>/proj" && rm -rf "<scratch>/proj/.git"
   arxiv_latex_cleaner "<scratch>/proj" --keep_bib \
     --commands_to_delete todo note fixme \
     --environments_to_delete note comment
   # -> writes cleaned tree to <scratch>/proj_arXiv/
   ```

   Always pass `--keep_bib` (default operation; keeps this repo's `.bib`-guarding intent). Add image
   flags only if the user opted in (see below).

8. **Deliver by mode:**
   - **Separate copy:** report the `..._arXiv` path. If the user wants a submission archive, zip it
     (`cd <scratch> && zip -r proj_arXiv.zip proj_arXiv`) and give them the path. **No MCP mutation.**
   - **In place:** reconcile the cleaned tree back into the project **through MCP tools** — for each
     changed `.tex`, `write_file` the cleaned content; `delete_file` anything the cleaner dropped. This
     keeps the per-project mutex and guards in play (`.bib` is untouched thanks to `--keep_bib`). Then
     go to step 9.
9. **Recompile (in-place only).** `compile` again — it must still succeed. Fewer pages / removed content
   is expected; broken build is not. If it breaks, fix it, or `discard` and report.
10. **Review (in-place only).** Show the `diff`. Do **not** `commit`/`push` unless the user asks — per
    CLAUDE.md, mutating the remote happens only on explicit request.

Do all MCP edits inside the one project so the per-project mutex serializes them.

## Default operations

Enabled by default (chosen for this skill): **strip comments** (intrinsic to the cleaner — there is no
keep-comments flag), **remove `\todo`/notes** (step 5), and **`--keep_bib`**. Comment stripping is why
in-place mode is destructive — call that out to the user before applying it in place.

## Image compression (opt-in)

Only when the user asks (e.g. "shrink it to fit arXiv's 50MB limit"). These need the real clone with its
binary assets, so they only work on the on-disk clone, not an MCP text mirror:

- `--resize_images --im_size 1000` — cap the longest side at N px.
- `--convert_png_to_jpg --png_quality 80` — re-encode large PNGs as JPG.
- `--compress_pdf --pdf_im_resolution 500` — ghostscript PDF compression (Linux/macOS only).

Recompile and eyeball figure quality in the PDF before recommending a commit — over-aggressive resizing
degrades figures.

## Note: MCP text mirror fallback

If the on-disk clone is unreachable but the user still wants comment/todo cleaning (no image ops), mirror
the project's `.tex` into the scratchpad with `list_files` + `read_file`, run the cleaner there, and
(in-place mode) `write_file` the results back. Image flags are unavailable on this path.

## After you finish

Report concisely: which draft macros/environments were removed, whether comments were stripped, that it
still compiles (in-place) or where the `..._arXiv` copy/zip lives (separate), and the page count
before/after. For in-place, point the user at the `diff` and ask whether to commit and push.

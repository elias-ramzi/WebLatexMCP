---
name: format-latex-project
description: Reformat an existing LaTeX/Overleaf project for clean diffs and modular structure — split the monolithic main file into per-section \input files, move every figure and table into its own \input file, and rewrite paragraphs to one-sentence-per-line. Use when the user asks to "format", "restructure", "modularize", or "clean up" an Overleaf/LaTeX project, to extract figures/tables into separate files, or to apply the one-sentence-per-line convention. Operates on projects served by the web-latex-mcp MCP server. In Claude Code, prefer the /format-latex command, which parallelizes this across sonnet agents; follow this procedure directly in clients without subagents.
---

# Format a LaTeX project

Three cosmetic-only transformations on a git-hosted LaTeX project, applied through the
`web-latex-mcp` MCP tools. **None of them may change the compiled PDF.** The compile step is
the guardrail — if the project compiled before and not after, you broke it.

1. **Modularize sections** — move each section out of the main file into its own file under
   `sections/`, leaving the main file as mostly a list of `\input{...}`.
2. **Modularize floats** — move each `figure`/`table` environment into its own file under
   `figures/` or `tables/`, leaving a one-line `\input{...}` where the float was.
3. **One sentence per line** — within body paragraphs, put each sentence on its own
   source line so `git diff`s stay small and edits stay surgical.

## Workflow

Run these in order. Stop and report if any step fails.

1. **Pick the project.** If the user didn't name one, call `list_projects` and ask which.
2. **Sync & baseline.** `project_sync` the project, then `compile` it. Record success and
   the log. **If it does not compile cleanly to begin with, stop** and tell the user — do
   not reformat a broken project (you won't be able to tell your changes apart from the
   pre-existing breakage).
3. **Find the main file.** Usually the `.tex` with `\documentclass`. `list_files`, then
   `read_file` it.
4. **Apply the transformation(s) the user asked for** (see rules below). Default to doing
   all three unless they asked for only some. Order them: split sections first, then pull
   the floats out of those section files, then reflow the remaining prose — each step then
   works on smaller files and the diffs stay legible.
5. **Recompile.** `compile` again. It must still succeed. Compare the log to the baseline —
   page count / overfull-box warnings should be essentially unchanged. If compilation
   breaks, fix it; if you can't, `discard` and report.
6. **Review.** Show the user the `diff`. Do **not** `commit`/`push` unless they ask — per
   CLAUDE.md, mutating the remote happens only on explicit request.

Do all edits inside one project so the per-project mutex serializes them; prefer
`edit_file` for surgical changes and `write_file` when rewriting a whole file.

## Rule: split into `\input` files

- Create one file per top-level `\section` (and standalone front/back matter like the
  abstract) under `sections/`, named after the section: `sections/introduction.tex`,
  `sections/related-work.tex`, `sections/method.tex`, etc. (kebab-case, ASCII).
- Each new file contains the section's content **starting with its `\section{...}` line**.
  Do not add `\documentclass`, preamble, or `\begin{document}` to section files.
- In the main file, replace the moved block with `\input{sections/introduction}` (no
  `.tex` extension). Keep the relative order identical.
- **Leave the preamble where it is** — everything before `\begin{document}` (documentclass,
  `\usepackage`, macros, title/author) stays in the main file. Only body sections move.
- Don't move `\bibliography`, `\maketitle`, `\appendix`, or similar one-line structural
  commands into section files; they stay in main between the `\input`s.
- Move text verbatim — same characters, same order. The only change is the cut/paste plus
  the `\input` line. (Extracting floats and reflowing to one-sentence-per-line are the
  _other_ rules; you may do all three, but keep the intents clear in the diff if the user
  wants separate commits.)

## Rule: one file per figure and table

Every float lives in its own `.tex` file and is pulled in with `\input`. A section file
should read as prose plus one-line `\input`s, never as pages of `tabular` markup.

- Create `figures/<name>.tex` for each `\begin{figure}`/`figure*` block and
  `tables/<name>.tex` for each `\begin{table}`/`table*` block.
- **Name the file after the label**, minus the prefix: `\label{fig:overview}` →
  `figures/overview.tex`; `\label{tab:sota_results}` → `tables/sota-results.tex`
  (kebab-case, ASCII). If a float has no label, add one following the project's convention
  (`fig:`/`tab:` + descriptive name) and name the file after it — a float worth extracting
  is a float worth referencing.
- The file holds the **whole environment**, from `\begin{figure}` to `\end{figure}`,
  including its `\caption` and `\label`. Nothing else — no `\section`, no surrounding prose.
- Replace the block in the section (or main) file with `\input{figures/overview}` (no `.tex`
  extension), on its own line, **in exactly the same position**. Float placement is
  positional in LaTeX: moving the `\input` up or down moves the float in the PDF.
- Move the content verbatim, placement specifier (`[t]`) and all. This rule is a cut/paste;
  restyling captions or switching to `booktabs` is a separate, non-cosmetic change — do it
  only if the user asks.
- Nested floats (a `subfigure` inside a `figure`) stay together in the parent's file: one
  file per top-level float, not per image.
- Graphics files themselves (`.pdf`/`.png` under `figures/`) don't move. Keep
  `\includegraphics` paths **byte-identical** — they resolve from the main file's directory,
  not from the `\input`ed file's, so a working path stays working.
- **Authoring new floats follows the same rule.** When this project later gains a figure or
  table, write it in its own `figures/`/`tables/` file first and `\input` it — never paste a
  new float body inline into a section file.

## Rule: one sentence per line

Reflow body prose so each sentence begins on a new source line. This changes only newline
placement in plain text — it must not alter a single non-whitespace token.

**Break only between sentences in ordinary paragraph text.** A sentence ends at `.`, `?`,
or `!` followed by a space and a capital/`\`/`$`. After the boundary, start a new line
(no blank line — a blank line starts a new paragraph in LaTeX and would change output).

**Never break inside, and never reflow:**

- Math: inline `$...$`, `\(...\)`, and display `\[...\]`, `equation`, `align`, etc.
- Any `\begin{env}...\end{env}` block (tables, figures, itemize, lstlisting, verbatim).
  Leave its internal formatting alone; only reflow the prose paragraphs around it.
- Comment lines (starting with `%`) and the rest of a line after an inline `%`.
- The preamble (before `\begin{document}`).

**Abbreviations are not sentence ends.** Do not break after `e.g.`, `i.e.`, `et al.`,
`cf.`, `vs.`, `Fig.`, `Eq.`, `Sec.`, `Dr.`, `Mr.`, a lone initial like `A.`, or a period
inside `\autoref{}`/numbers like `3.14`. When unsure whether a period ends a sentence,
**leave the line unbroken** — a missed break is harmless; a wrong one can hurt readability
or, near a command, change spacing.

Keep existing blank lines between paragraphs. Trim trailing whitespace on the lines you
touch.

## After you finish

Report concisely: which files were created (sections, figures, tables), that it still
compiles, and the page count before/after. Flag anything you had to add rather than move —
notably labels invented for unlabelled floats. Point the user at the diff and ask whether to
commit and push.

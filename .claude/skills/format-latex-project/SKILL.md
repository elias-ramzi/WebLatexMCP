---
name: format-latex-project
description: Reformat an existing LaTeX/Overleaf project for clean diffs and modular structure — split the monolithic main file into per-section \input files, and rewrite paragraphs to one-sentence-per-line. Use when the user asks to "format", "restructure", "modularize", or "clean up" an Overleaf/LaTeX project, or to apply the one-sentence-per-line convention. Operates on projects served by the web-latex-mcp MCP server.
---

# Format a LaTeX project

Two cosmetic-only transformations on a git-hosted LaTeX project, applied through the
`web-latex-mcp` MCP tools. **Neither may change the compiled PDF.** The compile step is the
guardrail — if the project compiled before and not after, you broke it.

1. **Modularize** — move each section out of the main file into its own file under
   `sections/`, leaving the main file as mostly a list of `\input{...}`.
2. **One sentence per line** — within body paragraphs, put each sentence on its own
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
   both unless they asked for only one.
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
  the `\input` line. (Reformatting to one-sentence-per-line is the _other_ rule; you may do
  both, but keep the two intents clear in the diff if the user wants separate commits.)

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

Report concisely: which files were created, that it still compiles, and the page count
before/after. Point the user at the diff and ask whether to commit and push.

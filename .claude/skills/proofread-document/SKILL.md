---
name: proofread-document
description: Hunt typos and language errors in a LaTeX/markdown document — spelling, doubled or missing words, subject/verb agreement, punctuation, quotes, unescaped LaTeX characters, and inconsistent hyphenation or capitalization of repeated terms. Reports each finding with its line and an exact minimal replacement, and applies fixes only when asked. Use when the user asks to "proofread", "check for typos", "find spelling/grammar mistakes", or "correct the text" of a paper or draft. Never rewrites prose for style and never touches a .bib. Operates on projects served by the web-latex-mcp MCP server. In Claude Code, prefer the /hunt-typo command, which parallelizes this across sonnet agents; follow this procedure directly in clients without subagents.
---

# Proofread a document

Find typos in a paper served by the `web-latex-mcp` MCP server and report them as exact,
minimal substitutions. **Report only by default** — nothing is edited until the user says
to.

## The one hard rule: you hunt typos, not writing

A typo is text that is _wrong_ — a reader would call it an error, not a choice. If a
sentence is merely clumsy, wordy, passive, repetitive, over-hedged, or something you would
have phrased better, it is not yours. Leave it exactly as it is.

When you catch yourself justifying a finding with "clearer", "smoother", "stronger", "more
concise", or "reads better", delete it: that is the tell that you crossed from correcting
into rewriting. The paper's voice is the author's.

## What counts as a typo — report these

- Misspellings, including in `\label`/`\ref` keys when the mismatch is provable from the
  document itself.
- Doubled words (`the the`), missing articles or prepositions, dropped words.
- Subject/verb and singular/plural disagreement; wrong verb tense against the paper's
  present-tense convention.
- Punctuation: missing or doubled periods and commas, space before punctuation, a missing
  `~` before `\cite`/`\ref`, `e.g.`/`i.e.` without the following comma, `...` where
  `\dots` belongs.
- Quotes: `"` in LaTeX where ` `` ` and `''` belong.
- Unescaped `%`, `&`, `_`, `#` in prose.
- Inconsistent capitalization or hyphenation of a term used more than once (`state of the
art` vs `state-of-the-art`, `Transformer` vs `transformer`).
- Broken math/text spacing that is unambiguously wrong (`$x$is`).

## What is not yours — do not report

- Style, tone, flow, word choice, sentence restructuring, splitting or joining sentences,
  reordering clauses, trimming redundancy, replacing a word with a better one. A sentence
  you would have written differently is not a typo.
- Anything the LaTeX writing guide covers as a _convention_ rather than an error —
  "we"/"our" overuse, caption phrasing, section header sentences, float placement. Those
  are the author's to apply, not yours to enforce.
- Anything inside `\begin{verbatim}`, `lstlisting`, `minted`, or a comment line starting
  with `%`, unless the user puts comments in scope.
- Citation keys, numbers, results, or claims — you cannot verify those by reading.
- Anything in a `.bib` file. Skip `.bib` files entirely; normalizing a bibliography is
  `format-bibliography`, and checking one against DBLP is `verify-citations`.

## How to write a finding

- **Never guess.** If you are not confident the text is wrong, drop it. A false positive
  costs the user more than a missed typo, and a file with no findings is a valid result.
- Each replacement is a **minimal, in-place substitution**: change only the wrong
  characters, preserve surrounding whitespace, and never reflow a line. The project may
  use one-sentence-per-line; keep line breaks exactly as they are.
- `oldText` must occur **exactly once** in the file — extend it with surrounding words
  until it is unique. If you cannot make it unique, give the line number and do not apply
  anything.

## Workflow

1. **Pick the project.** If the user didn't name one, `list_projects` and ask which — do
   not guess.
2. **Build the work list.** `list_files`, then take every `.tex`, `.md`, and `.txt` file,
   **excluding** every `.bib` and anything under a build/output directory. If the user
   named a file or directory, narrow to that. Say how many files you found before you
   start; if there are more than ~25, give the count and ask whether to do all or a subset.
3. **Read each file in full** with `read_file` and collect findings per the rules above.
4. **Report.** One table grouped by file: line, category, old → new, and a one-clause
   reason. Merge findings that contradict each other across files (a term hyphenated one
   way here and another there) into a single consistency finding naming every site. Then
   stop and ask whether to apply.
5. **Apply, only when the user says so.** `edit_file` per finding, one at a time, re-reading
   on any failure rather than retrying blind. Never pass `confirmBibEdit`; never pass
   `overrideExternalChanges`.
6. **Prove nothing broke.** After applying to a LaTeX project, `compile` and paste the
   error count and any remaining error verbatim. If the compile regresses, revert the
   offending edit rather than papering over it.

## After you finish

Report concisely: files scanned, findings by category, fixes applied vs reported, compile
status, and anything you left for the user to decide. Do not `commit` or `push` unless
asked.

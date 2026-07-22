# Skills (Claude Code)

For **Claude Code**, the repo bundles task-specific skills that drive the [tools](tools.md). They load
automatically when you install the [plugin](../README.md#or-install-the-claude-code-plugin--server-and-skills-together)
(server + skills, available in every session) or when Claude Code is launched from a clone of this repo;
each stops at the diff, so nothing is committed or pushed unless you ask. On **other MCP clients** the
same skills are available as prompts — see [Other clients](#other-clients-skills-as-mcp-prompts).

| Skill                                                                     | What it does                                                                                                                                                                                                                                                                                                                                                            | Mutates                     | Invoke                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------- |
| [`format-latex-project`](../.claude/skills/format-latex-project/SKILL.md) | Splits the monolithic main file into per-section `\input{sections/…}` files and reflows body prose to one sentence per line. Cosmetic-only — compiles before/after, the PDF must be unchanged.                                                                                                                                                                          | `.tex`                      | `/format-latex-project` |
| [`arxiv-clean-project`](../.claude/skills/arxiv-clean-project/SKILL.md)   | Runs [arxiv-latex-cleaner](https://github.com/google-research/arxiv-latex-cleaner) to strip `%` comments and delete draft macros (`\todo`, `\note`, review environments), optionally shrinking figures for arXiv's 50MB limit. Produces a separate `…_arXiv` copy or applies the cleaning in place. **Intentionally changes the PDF**; `.bib` is kept via `--keep_bib`. | `.tex` (in-place mode)      | `/arxiv-clean-project`  |
| [`verify-citations`](../.claude/skills/verify-citations/SKILL.md)         | Audits every `.bib` entry (title, authors, venue, year) against DBLP, flags discrepancies for you, writes a local git-excluded audit report, and optionally marks confirmed entries. **Read-only for the `.bib`** unless you approve a change.                                                                                                                          | local report; opt-in `.bib` | `/verify-citations`     |
| [`format-bibliography`](../.claude/skills/format-bibliography/SKILL.md)   | Deduplicates entries, normalizes cite keys to one scheme, harmonizes venue names, and enforces a single field policy — propagating key renames into your `\cite`s. Permission-gated; compile is the guardrail.                                                                                                                                                          | `.bib` + `.tex`             | `/format-bibliography`  |
| [`summarize-paper`](../.claude/skills/summarize-paper/SKILL.md)           | Writes/updates a small local markdown summary of the paper (section + file map, contributions, results) so future sessions get oriented fast. Kept out of git via the clone's `.git/info/exclude` — local-only, never pushed.                                                                                                                                           | local note only             | `/summarize-paper`      |

## Other clients: skills as MCP prompts

`.claude/skills` is a Claude Code mechanism — Claude Desktop, Cursor and other MCP clients never read it.
So the server **also registers every skill as an [MCP prompt](https://modelcontextprotocol.io/specification/server/prompts)**,
under the same name, carrying the same instructions. They travel with the server: install it and the
skills come along, with no per-user upload and no copy to keep in sync.

Prompts are a _user-invoked_ primitive, which is the one real difference from a skill. The model will not
reach for `verify-citations` on its own because you said "check my bibliography" — you pick the prompt
from the client's menu (in Claude Desktop, the `+` in the composer; in Claude Code, `/web-latex-mcp:…`).
Each takes an optional `project` argument, so you can scope the run up front instead of being asked.

Because prompts are flat text, a skill that grows bundled scripts or reference files would only be
partially conveyed this way — the `SKILL.md` body is what ships. All five current skills are
self-contained, so nothing is lost today.

Set `WEB_LATEX_MCP_SKILLS_DIR` to serve your own directory of skills instead (one subdirectory per skill,
each with a `SKILL.md` whose frontmatter has a `name` and `description`).

## `format-latex-project` — reformat an existing project

Cleans up an existing project in two cosmetic-only passes: it splits the monolithic main file into
per-section `\input{sections/…}` files, and rewrites body paragraphs to **one sentence per line** (the
convention from [`writing-guide.md`](writing-guide.md), which keeps diffs small and edits surgical). It
compiles before and after as a guardrail — the PDF must be unchanged — and stops at the diff so you review
before any `commit`/`push`. Ask Claude to "format my Overleaf project".

## `arxiv-clean-project` — prepare a project for arXiv

Runs [arxiv-latex-cleaner](https://github.com/google-research/arxiv-latex-cleaner) over the project to
produce submission-ready LaTeX: it **strips every `%` comment** and **deletes draft macros and
environments** you name (`\todo{…}`, `\note{…}`, review commands, `comment`-style blocks), and can
optionally **shrink oversized figures** (resize images, PNG→JPG, compress PDFs) to fit arXiv's 50MB limit.
Unlike `format-latex-project`, this one **intentionally changes the compiled PDF** — removing todos and
notes removes content — so compile is only a "still builds cleanly" guardrail, not a "PDF unchanged" one.
Before deleting, it detects which draft macros the project actually uses and **confirms the list with you**.
`.bib` files are preserved via `--keep_bib`.

It asks each run which of two modes you want: a **separate `…_arXiv` copy** (plus an optional `.zip`),
leaving the live project untouched — the tool's native, non-destructive behavior — or **applied in place**,
reconciling the cleaned files back through the MCP tools, compiling, and stopping at the diff so you review
before any `commit`/`push`. In-place mode is destructive (it strips your live project's comments), so the
skill flags that first. The cleaner is a Python CLI installed on demand (`pipx`/`pip`). Ask Claude to
"clean my project for arXiv".

## `verify-citations` — audit citations against DBLP

**Audits the references already in your `.bib`** against [DBLP](https://dblp.org). For each entry it
compares the **title**, **authors**, **venue** (reconciling abbreviations like CVPR / NeurIPS / ICLR with
their full names), and **publication year** to the canonical DBLP record via `search_references`. Confident
matches are tallied silently; anything doubtful — a wrong year, a misspelled or missing author, a preprint
cited where a published version exists, or an entry DBLP can't find — is brought back to **you** with the
bib entry shown beside the DBLP record, so you decide what to do. It is **read-only by default and never
edits a `.bib` without your explicit say-so** (consistent with the [`.bib` protection](tools.md#citations-via-dblp));
optionally, on entries you confirm, it adds a `% verified-by-claude` comment (ignored by BibTeX, so the PDF
is unchanged) that later runs skip. Every run also writes a **local, git-excluded audit report**
(`citation-report.local.md` at the clone root — the same local-only mechanism as
[`summarize-paper`](#summarize-paper--local-cheat-sheet-for-future-sessions), never pushed) and surfaces a
link to it, so the findings outlive the chat. Ask Claude to "check my citations".

## `format-bibliography` — normalize the bibliography

Brings a `.bib` into a single house style: it **deduplicates** entries (e.g. an arXiv preprint and its
published version), **renames cite keys** to a consistent `firstauthorYEARtag` scheme
(`chambon2024pointbev`), **harmonizes venue names** (pick short `CVPR` _or_ long "Computer Vision and
Pattern Recognition", not a mix), and applies **one field policy** — strip or systematically add `url` /
`doi` / `pages` (added values are pulled from DBLP, not invented). Unlike `verify-citations`, this one
**edits** the `.bib`, so it is permission-gated: it agrees a policy with you, previews the changes, and
writes only on your go-ahead. Renaming a cite key would break every `\cite{…}`, so the skill **propagates
renames into the `.tex` in the same pass** and uses **compile (no `Citation … undefined` warnings) as its
guardrail**. Reformatted entries get a `% formatted-by-claude` marker so a later run skips them. Ask Claude
to "tidy up my bibliography".

## `summarize-paper` — local cheat-sheet for future sessions

Writes a compact markdown summary of the paper — a one-paragraph thesis, the contributions, a **section
map and file map** (which `\label`/section lives in which `.tex`), key terms, results, and open threads —
so a new session can get oriented in seconds instead of re-reading every source file. On later runs it
**updates** the note in place, preserving any notes you added by hand and refreshing what changed. It reads
the paper through the MCP tools but writes only the one local note (never the `.tex` or `.bib`).

The note (`paper-summary.local.md` by default) lives at the root of the project clone but is **kept out of
git via the clone's `.git/info/exclude`** — so it is never staged by `commit` (which uses `git add -A`),
never shows up in `status`/`diff`, never pushed to Overleaf/GitHub, and survives `discard`. Using the
local exclude rather than a committed `.gitignore` keeps it purely local — no change is ever destined for
the remote. Ask Claude to "summarize the paper" or "update the paper summary"; read the note first at the
start of a session to save the re-reading cost.

# Skills (Claude Code)

For **Claude Code**, the repo bundles task-specific skills that drive the [tools](tools.md). They load
automatically when Claude Code is launched from this repo; each stops at the diff, so nothing is committed
or pushed unless you ask.

| Skill                                                                     | What it does                                                                                                                                                                                                   | Mutates              | Invoke                  |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------- |
| [`format-latex-project`](../.claude/skills/format-latex-project/SKILL.md) | Splits the monolithic main file into per-section `\input{sections/…}` files and reflows body prose to one sentence per line. Cosmetic-only — compiles before/after, the PDF must be unchanged.                 | `.tex`               | `/format-latex-project` |
| [`verify-citations`](../.claude/skills/verify-citations/SKILL.md)         | Audits every `.bib` entry (title, authors, venue, year) against DBLP, flags discrepancies for you, and optionally marks confirmed entries. **Read-only** unless you approve a change.                          | none (opt-in `.bib`) | `/verify-citations`     |
| [`format-bibliography`](../.claude/skills/format-bibliography/SKILL.md)   | Deduplicates entries, normalizes cite keys to one scheme, harmonizes venue names, and enforces a single field policy — propagating key renames into your `\cite`s. Permission-gated; compile is the guardrail. | `.bib` + `.tex`      | `/format-bibliography`  |

## `format-latex-project` — reformat an existing project

Cleans up an existing project in two cosmetic-only passes: it splits the monolithic main file into
per-section `\input{sections/…}` files, and rewrites body paragraphs to **one sentence per line** (the
convention from [`writing-guide.md`](writing-guide.md), which keeps diffs small and edits surgical). It
compiles before and after as a guardrail — the PDF must be unchanged — and stops at the diff so you review
before any `commit`/`push`. Ask Claude to "format my Overleaf project".

## `verify-citations` — audit citations against DBLP

**Audits the references already in your `.bib`** against [DBLP](https://dblp.org). For each entry it
compares the **title**, **authors**, **venue** (reconciling abbreviations like CVPR / NeurIPS / ICLR with
their full names), and **publication year** to the canonical DBLP record via `search_references`. Confident
matches are tallied silently; anything doubtful — a wrong year, a misspelled or missing author, a preprint
cited where a published version exists, or an entry DBLP can't find — is brought back to **you** with the
bib entry shown beside the DBLP record, so you decide what to do. It is **read-only by default and never
edits a `.bib` without your explicit say-so** (consistent with the [`.bib` protection](tools.md#citations-via-dblp));
optionally, on entries you confirm, it adds a `% verified-by-claude` comment (ignored by BibTeX, so the PDF
is unchanged) that later runs skip. Ask Claude to "check my citations".

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

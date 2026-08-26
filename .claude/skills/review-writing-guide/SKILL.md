---
name: review-writing-guide
description: Review a paper against the LaTeX writing guide and report where it diverges — tense, first-person overuse, section signposting, caption and float conventions, equation punctuation and notation, citation placement (never in the abstract, cite on first mention, re-anchor per section, no re-citing within one), acronym definition, en/em dashes and English usage, \autoref and quote marks. Produces a prioritized report with a concrete suggested rewrite per finding. Use when the user asks to "review the writing", "check the style", "does this follow the writing guide", "critique the prose", or "what should I fix before submitting". Read-only — it never edits, commits, or pushes. Operates on projects served by the web-latex-mcp MCP server. In Claude Code, prefer the /review-writing command, which parallelizes this across agents; follow this procedure directly in clients without subagents.
---

# Review a paper against the writing guide

Read a paper served by the `web-latex-mcp` MCP server and report where it diverges from
the LaTeX writing guide.

**This procedure is read-only.** It writes no `.tex`, no `.bib`, and no report file into
the project; it does not `commit` or `push`. Every finding is a _suggestion the author
accepts or rejects_, delivered in the reply. If the author wants a change applied, that is
a separate, explicit request.

## The guide is the authority, not this skill

The full writing guide arrives as this server's MCP instructions ("Writing Academic
Articles in LaTeX"), and lives at `docs/writing-guide.md` in the server repository. **Read
it there and judge against its text** — this skill only says how to conduct the review and
how to report it. Never restate a rule from memory, and never invent one the guide does not
state. If the guide is not in your context, say so and stop rather than reviewing against
a remembered version.

Where a passage is defensible under the guide, it is not a finding. The guide has genuine
latitude in it — "optional, but be consistent", "use sparingly", "prefer the simpler
phrasing" — and a reviewer who reads latitude as a rule produces noise.

## Two kinds of check

Sort every check by what it takes to see it, because this decides who can find it.

**Per-file** — visible by reading one file:

- Tense; first-person overuse ("we"/"our" on things that are not contributions).
- Sentences that need re-reading — flag the sentence, do not rewrite the paragraph.
- Section signposting: does each section open with a header sentence naming its
  subsections?
- Captions: bold title then descriptive explanation; interpretation that belongs in the
  body; the caption test.
- Floats: placement specifier, position relative to the discussion, descriptive labels.
- Equations: notation introduced, punctuation as part of the sentence, `\text`/`\textit`
  in textual sub/superscripts.
- Citations _within_ a section: re-citing the same work twice, and citations in the
  abstract.
- English usage: `i.e.,`/`e.g.,`, ground truth vs ground-truth, hyphen / en dash / em dash
  (including em-dash overuse), `\autoref` over `\ref`/`\cref`, quote marks.

**Whole-paper** — only visible by joining files, so a single-file reader cannot find them
and must not guess at them:

- A float defined but never referred to in the text (`check_citations` and a search for
  `\autoref{fig:`/`tab:` do this better than reading).
- An acronym defined twice, or used before its definition, or introduced and then barely
  reused.
- Citation re-anchoring across major section boundaries: cited on first mention, re-cited
  at its first appearance in Related Work / Method / Experiments.
- A term or notation used inconsistently between sections.
- Bibliography style harmonization and key format (report only — the `.bib` is protected,
  and `format-bibliography` is the skill that changes one).

## How to write a finding

- **Quote the source.** Give file, line, and the exact text as it stands. A finding the
  author cannot locate is not actionable.
- **Name the guide rule** it diverges from, by section ("Citations — do not re-cite within
  the same section"). If you cannot name one, it is your taste, not the guide's rule, and
  you drop it.
- **Propose the concrete replacement**, not a direction. "Consider tightening" is not a
  suggestion; the rewritten sentence is. Keep it minimal and in the author's voice — the
  smallest change that satisfies the rule, never a restyled paragraph.
- **Never guess at content.** Do not propose a citation, a number, or a claim; if a passage
  looks like it needs a citation, say so and leave it to the author — a hallucinated
  reference is worse than a missing one.
- Typos, spelling, and agreement are **not** this review (`proofread-document` is). If you
  notice one in passing, mention it once at the end as an aside, not as a guide finding.

## Workflow

1. **Pick the project.** If the user didn't name one, `list_projects` and ask which — do
   not guess.
2. **Build the work list.** `list_files`, then every `.tex` under the document, excluding
   `.bib` and build/output directories. Narrow to any file or section the user named. Say
   how many files you will read before starting.
3. **Read each file in full** with `read_file` and collect the per-file findings.
4. **Then do the whole-paper pass** over what you read: acronyms, float references,
   citation re-anchoring, cross-section consistency. Keep these separate — they are the
   findings the author cannot get any other way.
5. **Report** (see below). Stop there: propose, do not apply.

## The report

Order by impact, not by file — a reader fixes the top of the list first:

1. **Blocking** — a reader would misread the paper, or a submission rule is broken
   (citations in the abstract, an undefined acronym, an unreferenced float, notation used
   before it is introduced).
2. **Guide divergences** — a named rule, clearly diverged from.
3. **Worth considering** — inside the guide's latitude, offered as judgment.

Under each, group by file, and give: `file:line`, the quoted text, the rule, and the
suggested replacement. End with a short summary: files reviewed, findings per category,
and the three changes you would make first. Say plainly if the paper follows the guide —
finding little is a valid result, and padding the list to look thorough wastes the
author's attention.

Do not `commit`, `push`, or edit anything.

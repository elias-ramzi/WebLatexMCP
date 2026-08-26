---
description: Hunt typos across a paper's files — dispatch one sonnet corrector agent per file, collect the findings, and apply the ones you approve.
argument-hint: <project id> [file/dir filter] [--fix]
---

Hunt typos in the project below by fanning out one `corrector` agent per file. You are
the dispatcher and the reviewer; the agents do the reading.

Target: $ARGUMENTS

**Load the rules before you touch anything:** `list_skills({ skill: "proofread-document" })`.
That skill is the single source of truth for what counts as a typo, what is out of scope,
and how a finding must be written; this command only says who does which part and how the
work fans out. Where the two could disagree, the skill wins — except that the dispatch
below replaces its workflow step 3, since it has no agents. If `list_skills` fails, stop
and tell me.

**Scope: typos only.** This command never rewrites prose, never improves phrasing, and
never applies writing conventions — no reflowing, no restructuring, no word swaps. If a
finding's justification is that the text would read better, it is out of scope and you
drop it. (Cosmetic restructuring is `/format-latex`; this is not that.)

1. **Resolve the target.** If no project id is given, call `list_projects` and ask me which
   one — do not guess. Build the work list per the skill's workflow step 2 (`.tex`/`.md`/
   `.txt`, no `.bib`, no build directories, narrowed to any file/dir filter I passed), with
   one addition: split any file over ~2000 lines by line ranges across two agents. Say how
   many files you found before you dispatch; if more than ~25, tell me the count and ask
   whether to run all or a subset.

2. **Dispatch.** One `corrector` agent per file, launched **in parallel** — batch them in
   groups of at most 8 tool uses per message so the fan-out stays legible. Each agent
   starts empty and loads the rules itself, so your prompt carries only: the project id,
   the exact file path, and whether it may apply fixes. Do not restate the rules to the
   agent — that is the duplication this split exists to avoid. Default is **report only**;
   pass apply authorization only when I passed `--fix`, and never for a `.bib`.

3. **Review.** Collect every finding into one table grouped by file: line, category, old →
   new, and the reason. Then filter it yourself before showing me — and filter hard, since
   an agent that found nothing is a valid result: drop anything the skill puts out of
   scope, anything justified by "clearer" / "reads better" / "more concise", anything where
   the fix changes meaning, and anything that reflows or restructures a line. Report what
   you dropped as a count, not as a list. Findings that contradict each other across files
   (a term hyphenated one way here and another there) get merged into a single consistency
   finding naming every site — no agent can see this, since each has one file.

4. **Apply.** In report-only mode, stop at the table and give me the exact command to
   re-run with `--fix`. In `--fix` mode the agents apply as they go; afterwards re-read any
   file whose edits failed, apply those yourself with `edit_file`, then follow the skill's
   workflow step 6 — `compile`, paste the error count and any remaining error verbatim, and
   revert the offending edit if it regressed rather than papering over it.

5. **Close.** One summary: files scanned, findings by category, fixes applied vs reported,
   compile status, anything you left for me to decide. Do not commit or push unless I ask.

---
description: Review a paper against the writing guide — fan out one reviewer agent per file, add the whole-paper checks yourself, and report prioritized suggestions. Proposes, never edits.
argument-hint: <project id> [file/dir filter] [--sonnet]
---

Review the project below against the LaTeX writing guide by fanning out one
`writing-reviewer` agent per file. You are the dispatcher and the editor of the final
report; the agents do the reading.

Target: $ARGUMENTS

**This command proposes and never applies.** Nothing is written, committed, or pushed —
not the `.tex`, not the `.bib`, and not a report file in the project. The report goes in
your reply. If I want a suggestion applied afterwards, I will ask for it as a separate
request; do not pre-emptively offer to apply them all.

**Load the rules before you touch anything:** `list_skills({ skill: "review-writing-guide" })`.
That skill is the single source of truth for how to review and how to report; the writing
guide itself (this server's MCP instructions, `docs/writing-guide.md` in the server repo)
is the authority on the rules. Where this command and the skill could disagree, the skill
wins — except that the dispatch below replaces its workflow step 3. If `list_skills` fails,
or the writing guide is not in your context, stop and tell me.

1. **Resolve the target.** If no project id is given, call `list_projects` and ask me which
   one — do not guess. Build the work list per the skill's workflow step 2, narrowed to any
   file/dir filter I passed, and split any file over ~2000 lines by line ranges across two
   agents. Say how many files you will review before you dispatch; if more than ~25, tell
   me the count and ask whether to run all or a subset.

2. **Dispatch.** One `writing-reviewer` agent per file, launched **in parallel** — batch
   them in groups of at most 8 tool uses per message. Each agent starts empty and loads the
   rules itself, so your prompt carries only the project id and the exact file path. Do not
   restate the guide to the agent — that is the duplication this split exists to avoid, and
   a paraphrased rule is a wrong rule. Never dispatch onto a `.bib`.

   The agent runs on **opus by default**. If I passed `--sonnet`, override the model to
   sonnet on every dispatch — cheaper and faster, at some cost in judgment on the prose
   checks. Say which model you used in the summary.

3. **Do the whole-paper pass yourself.** The agents cannot see it: acronyms defined twice
   or used before definition, floats never referenced in the text, citation re-anchoring
   across major sections, notation and terminology drifting between sections, `.bib` style
   and key format. Use each agent's `context:` block plus `check_citations` and targeted
   searches rather than re-reading every file.

4. **Report** per the skill's "The report" section — Blocking, then guide divergences, then
   worth-considering; `file:line`, quoted text, the rule, the suggested replacement. Filter
   the agents' findings first and filter hard: drop anything not tied to a named guide rule,
   anything that is taste dressed as a rule, and anything where the suggestion rewrites more
   than the rule requires. Report what you dropped as a count, not a list. Merge findings
   that recur across files into one entry naming every site.

5. **Close.** Files reviewed, model used, findings per category, count dropped, and the
   three changes you would make first. Say plainly if the paper follows the guide — finding
   little is a valid result.

---
description: Format a LaTeX project — split the main file into per-section \input files, then fan out one sonnet formatter agent per section to extract floats and reflow to one sentence per line.
argument-hint: <project id> [--sections-only|--floats-only|--reflow-only]
---

Format the LaTeX project below. You do the serial part (splitting the main file) and the
guardrail compiles; `formatter` agents do the per-file work in parallel.

Target: $ARGUMENTS

**Load the rules before you touch anything:** `list_skills({ skill: "format-latex-project" })`.
That skill is the single source of truth for what each transformation means and what may
never change; this command only says who does which part, in what order, and how the work
fans out. Where the two could disagree, the skill wins — except that the dispatch below
replaces its step 4, since it has no agents. If `list_skills` fails, stop and tell me.

**None of this may change the compiled PDF.** The compile is the guardrail: if it compiled
before and not after, you broke it.

1. **Resolve and baseline.** If no project id is given, call `list_projects` and ask me —
   do not guess. Then follow the skill's workflow steps 1–3: `project_sync`, `compile`,
   record success / page count / overfull-box count, and stop if it does not already
   compile cleanly.

2. **Split sections — serial, you do this.** Apply the skill's **"Rule: split into
   `\input` files"** to the main file yourself. It is one file, so there is nothing to
   parallelize, and its section boundaries are what define the work list for step 3. Skip
   this under `--floats-only`/`--reflow-only` and take the existing `\input`ed section
   files as the work list instead.

3. **Dispatch — parallel.** One `formatter` agent per section file, launched in parallel,
   batched at most 8 tool uses per message. Each agent starts empty and loads the rules
   itself, so your prompt carries only: the project id, the exact file path, and which
   transformations to apply (both by default; only floats under `--floats-only`, only
   reflow under `--reflow-only`). Do not restate the rules to the agent — that is the
   duplication this split exists to avoid. Say how many files you are dispatching first;
   if more than ~25, give me the count and ask whether to run all or a subset.

   Never dispatch onto a `.bib`, and never give two agents the same file. Agents write
   through the same project, so the per-project mutex serializes their writes.

4. **Recompile and review.** The skill's workflow steps 5–6: `compile` must still succeed
   with essentially the baseline page and overfull-box counts, then show me the `diff`. If
   it broke, find the offending file from the error location and fix it with `edit_file`;
   if you cannot, `discard` and report. Report which files each agent created, **every
   label invented** for an unlabelled float, and any agent that failed and why. Do not
   `commit` or `push` unless I ask.

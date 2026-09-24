---
description: Implement a GitHub issue or a markdown spec — triage it first (is it worth building, and which parts), gate on my approval of that call, then orchestrate the build like /implement.
argument-hint: <issue #|issue URL|path/to/spec.md> [--triage-model fable|opus]
---

Implement the request described by the following source, orchestrating rather than doing
everything yourself. Unlike `/implement`, the request arrives written by someone else and
is **not assumed to be worth building as stated** — you triage it, and I approve the
triage before any code is written.

Source: $ARGUMENTS

0. **Load the source, verbatim.** Do not paraphrase it into the plan before I have seen
   your triage against the real text.
   - A number or a GitHub URL → `gh issue view <n> --repo elias-ramzi/WebLatexMCP
--json number,title,body,labels,state,comments`. Read the **comments** too: a
     maintainer reply often narrows or kills the ask. If `gh` is missing or
     unauthenticated (`gh auth status` exits non-zero), say so and ask me to paste the
     issue body or point at a file — do not guess at its contents.
   - A path → read the file. A path under `.claude/session_feedbacks/` is a saved
     feedback report holding several issue blocks: treat **each block as its own
     candidate** through step 1, and tell me if I meant only one of them.
   - Anything else → ask which it is. Do not proceed on an unidentified source.

1. **Triage — is this worth building, and what exactly?** Delegate this step to one agent
   so it starts from the source and the code, not from my framing of either. Pick its
   model from `--triage-model` (`fable` or `opus`); with the flag absent, use `fable`, and
   say which one ran. Give it the full source text and have it come back with, per
   candidate:
   - **What the report actually claims**, separated into the observed problem and the
     proposed solution — the two are not the same ask, and the proposal is the more often
     wrong half.
   - **Is the claim true of this code today?** Verify against the source tree, not the
     issue's word: the behaviour may already exist, may have been fixed since the version
     the reporter ran, may be working as designed by a guard in CLAUDE.md, or may be a
     misread of a tool description (a `docs` fix, not a code one). Name the files and
     lines checked.
   - **Verdict:** build as proposed / build a different way (say which and why) /
     build a reduced part / decline (say what makes it not worth it — cost, a guard it
     would have to weaken, a scope that belongs in a separate ask, an invariant from
     CLAUDE.md it contradicts).
   - **Cost and blast radius:** the files and layers it touches, the guards it comes near,
     and whether it needs new tests at the unit / integration / TeX-gated-smoke tier.

   You then take that report and form **your own** call — the agent advises, it does not
   decide. Where you disagree with it, say so and why.

2. **Gate — report the call and stop.** Before writing a line of code, print, at the level
   of what and why, not of diffs:
   - **Building:** each accepted item in one sentence, with the invariant it must preserve.
   - **Discarding:** each rejected item in one sentence with the reason, including
     anything the source asked for that I might expect to see and won't.
   - **Deviating:** where you are building something other than what was proposed.
   - **Open questions:** anything whose answer would change the shape of the work.
   - The triage model used, and whether the "already true of this code" check was
     verification or inference.

   Then **stop and wait for my approval.** Not a rhetorical pause — no `implementer` agent
   is launched, no file is edited, until I answer. If I trim or extend the list, that
   answer replaces the plan; re-print the revised one-liner list only if the change is
   material. An empty accept list is a valid outcome: report it and stop, do not
   manufacture work to justify the run.

3. **Scope the approved work.** Now write the spec, as `/implement` step 1 does: per task,
   the files, exactly what to build and how (logic in `src/services/*` or `src/lib/*`,
   tools stay thin — a new tool is one file in `src/tools/` registered in
   `src/server.ts`), the invariant it must preserve (name the specific guards from
   CLAUDE.md the task comes near — `requireGitProject`, `runExclusive`, `confirmBibEdit`,
   `recordBaseline`, symlink resolution, ff-only pull, conflicted-stays-flagged, snippet
   provenance), the tests to write first — each one watched failing on pre-fix code, with
   a case for the value just outside every new guard, in the right tier (unit with temp
   dirs / integration against the bare-repo helper / TeX-gated smoke, remembering smokes
   auto-skip without `latexmk`) — and how the task will be proved. The issue's own words
   are evidence, not a spec: where it prescribes an implementation the code cannot carry,
   the spec follows the code and step 2 already said so.

4. **Delegate implementation.** Hand each well-bounded task to the `implementer` agent —
   one task per agent, full spec in the prompt: the agent starts with empty context, so
   restate everything (file paths, the invariants, the tests, any authorization to touch a
   guard or a `.bib` path). Launch independent tasks in parallel; tasks sharing files run
   sequentially, later prompts naming what already landed. Keep for yourself anything
   requiring design judgment, anything touching more than ~3 files at once, and all
   integration between the pieces.

5. **Verify.** When the tasks land, run the local CI gate yourself — never trust a
   subagent's green:

   ```bash
   npm run typecheck && npm run lint && npm run format:check && npm test
   ```

   (typecheck covers `src` and `test`; the build does not — and a green `npm test` says
   nothing about compile behaviour the auto-skipping smokes would have covered, so check
   the skip count.) Then send the full diff to the `plan-verifier` agent with your spec
   from step 3 and its invariants named. Fix confirmed findings (delegating mechanical
   fixes back to `implementer`), re-verify once, and re-run the gate after any fix. Report
   findings you chose not to fix, with reasons.

6. **Close.** Summarize: what was built, the proof (gate output tails, with skips
   distinguished from passes), each accepted item checked off against evidence, what was
   discarded at step 2 and still is, open findings, and the exact next command. If the
   source was a GitHub issue, draft — do not post — the one-paragraph reply that would
   close it, including the discarded parts, since the reporter is owed that. Do not commit
   or comment on the issue unless I say so; when I do, sync with the remote first per
   CLAUDE.md and re-run the gate after resolving any conflicts.

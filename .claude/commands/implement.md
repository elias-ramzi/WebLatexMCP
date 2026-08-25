---
description: Implement a request by orchestrating — write the spec, delegate bounded tasks to the implementer agent, verify adversarially with plan-verifier, prove it with the local CI gate.
argument-hint: <what to implement>
---

Implement the following request, orchestrating rather than doing everything yourself. You
are the planner and integrator; delegate the bounded work.

Request: $ARGUMENTS

1. **Scope.** There is no plan document — you write the spec. Read the code the request
   touches, then produce the task list: for each task, the files, exactly what to build
   and how (logic in `src/services/*` or `src/lib/*`, tools stay thin — a new tool is one
   file in `src/tools/` registered in `src/server.ts`), the invariant it must preserve
   (name the specific guards from CLAUDE.md the task comes near — `requireGitProject`,
   `runExclusive`, `confirmBibEdit`, `recordBaseline`, symlink resolution, ff-only pull,
   conflicted-stays-flagged, snippet provenance), the tests to write first — each one
   watched failing on pre-fix code, with a case for the value just outside every new
   guard, placed in the right tier (unit with temp dirs / integration against the
   bare-repo helper / TeX-gated smoke, remembering smokes auto-skip without `latexmk`) —
   and how the task will be proved. Anything the request leaves ambiguous is a question
   for me, asked now, not a decision made silently. If the request contradicts what the
   code actually does, that is a finding to report, not to paper over.

2. **Delegate implementation.** Hand each well-bounded task to the `implementer` agent —
   one task per agent, full spec in the prompt: the agent starts with empty context, so
   restate everything (file paths, the invariants, the tests, any authorization to touch
   a guard or a `.bib` path). Launch independent tasks in parallel; tasks sharing files
   run sequentially, later prompts naming what already landed. Keep for yourself anything
   requiring design judgment, anything touching more than ~3 files at once, and all
   integration between the pieces.

3. **Verify.** When the tasks land, run the local CI gate yourself — never trust a
   subagent's green:

   ```bash
   npm run typecheck && npm run lint && npm run format:check && npm test
   ```

   (typecheck covers `src` and `test`; the build does not — and a green `npm test` says
   nothing about compile behaviour the auto-skipping smokes would have covered, so check
   the skip count.) Then send the full diff to the `plan-verifier` agent with your spec
   from step 1 and its invariants named. Fix confirmed findings (delegating mechanical
   fixes back to `implementer`), re-verify once, and re-run the gate after any fix.
   Report findings you chose not to fix, with reasons.

4. **Close.** Summarize: what was built, the proof (gate output tails, with skips
   distinguished from passes), the request's acceptance criteria checked off against
   evidence, open findings, and the exact next command. Do not commit unless I say so;
   when I do, sync with the remote first per CLAUDE.md and re-run the gate after
   resolving any conflicts.

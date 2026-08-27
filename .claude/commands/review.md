---
description: Review a PR, branch, or the working tree by orchestrating — scope the diff, review adversarially with the plan-verifier agent, and with --fix loop implement (implementer) → verify until clean (cap 3), then validate the PR.
argument-hint: <PR# | branch | empty for current branch> [--fix]
---

Review the following target, orchestrating rather than doing everything yourself. You
are the scoper and integrator; delegate the review and any fixes.

Target: $ARGUMENTS

Report-only by default. The implement/verify loop (steps 3–4) runs only if the
arguments contain `--fix`; without it, stop after step 2's report and the step 5
verdict, changing nothing.

1. **Scope.** Resolve the target: a number is a GitHub PR (`gh pr view` for the
   description and its base branch, `gh pr diff` for the diff — check out the branch if
   `--fix`); a branch name diffs against its base (a PR's base if there is one, else
   `origin/dev`, the integration branch, falling back to `origin/main`); no target means
   the current branch vs that same base, plus any uncommitted changes. Assemble the
   _stated intent_ — PR description, commit messages, linked issues, `CHANGELOG` entry —
   and read enough of the surrounding code to know what the diff plugs into. Produce the
   review scope: the intent in your own words, the files touched grouped by risk
   (`src/services/*` and `src/lib/*` core, `src/tools/*` + `src/server.ts` surface,
   `src/context.ts`/`src/config.ts` wiring, `.claude/skills` + prompts, tests, docs),
   which CLAUDE.md guards the diff comes near (`requireGitProject`, `runExclusive` and
   the file lock, `confirmBibEdit`, `recordBaseline`/`ExternalChangeError`, symlink
   resolution and `strictLinks`, ff-only pull, conflicted-stays-flagged, snippet
   provenance, compiler substitution only when unchosen, stdout is JSON-RPC), and any
   area the diff touches that the intent does not mention. If the diff is too large for
   one reviewer to hold, split it into coherent slices along those risk groups.

2. **Review.** First run the proof yourself on the target as-is — never trust a green
   you did not run:

   ```bash
   npm run typecheck && npm run lint && npm run format:check && npm test
   ```

   A failing gate is a finding in its own right (blocker), and so is a vacuous green:
   check the skip count, since the TeX smokes auto-skip without `latexmk` (`npm run
test:smoke` if it is installed). The output goes to the reviewer as evidence, not as
   a substitute for reading the code. Then send the diff (or each slice, in parallel) to
   the `plan-verifier` agent with the stated intent as the spec and your scope notes:
   the agent starts with empty context, so restate everything — how to get the diff, the
   intent, which guards matter most for this change, and that new behaviour the intent
   does not claim is itself a finding. Merge and deduplicate the findings, then triage
   them yourself: confirm each against the code before believing it, drop anything the
   reviewer got wrong (say so), and rank what remains. Report the ranked findings with
   file, symbol, severity, and proposed fix. Without `--fix`, this report plus step 5's
   verdict is the deliverable.

3. **Fix** (only with `--fix`). Turn each confirmed finding into a bounded task and hand
   it to the `implementer` agent — one task per agent, full spec in the prompt (files,
   the invariant to preserve, the regression test watched failing first and its tier —
   unit with temp dirs / integration against the bare-repo helper / TeX-gated smoke —
   the proving command, and any explicit authorization to touch a guard or a `.bib`
   path; without that, a guard stays as it is). Independent tasks in parallel; tasks
   sharing files sequentially. Keep for yourself anything requiring design judgment or
   touching more than ~3 files. Findings that are really the author's call (design
   disagreements, scope questions) are not fixed — they stay in the report.
   Read what each agent reports back about its regression test: an implementer saying a
   test **passed before the fix** is a confirmed finding of its own, not a status line to
   pass upward. That test proves nothing, and the fix under it may be aimed at the wrong
   thing — send it back in this round rather than letting step 4 find it.

4. **Verify** (only with `--fix`). Re-run the gate yourself after every fix, then send
   the fix diff to the `plan-verifier` agent with the findings list from step 2 as the
   spec: each finding either fixed or explicitly deferred, no weakened guard, and no new
   behaviour beyond the fixes. If it confirms new problems, loop back to step 2 scoped
   to the fix diff. Cap: 3 rounds total; whatever remains after that is reported, not
   iterated.

5. **Validate.** Deliver the verdict yourself: approve / request-changes, justified by
   the surviving findings and the local proof (gate output tails, skips distinguished
   from passes, formatting clean, cross-platform concerns named — paths POSIX via
   `toPosix`, separator-agnostic tests). Then, **each gated on my explicit go, one at a
   time**: (a) post the findings/verdict as a single PR comment via `gh` — show me the
   exact comment text first; (b) commit the fixes onto the PR branch and push — show me
   the diff summary and commit message first, and sync with the remote per CLAUDE.md
   (re-running the gate after resolving any conflicts) before committing. Never post or
   push without the go.

6. **Close.** Summarize: the verdict, findings fixed vs deferred vs dropped (with
   reasons), the proof, and the exact next command for anything left.

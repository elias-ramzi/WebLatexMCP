---
description: Review a PR, branch, or the working tree by orchestrating — scope the diff, review adversarially with the plan-verifier agent, and with --fix loop implement (implementer) → verify (cap 3 rounds), close with one verify-only pass when fixes landed after the last verification, then validate the PR.
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
   the `plan-verifier` agent — **with `isolation: "worktree"` whenever every byte under
   review is committed**, so the reviewer works in a throwaway copy and cannot invalidate the
   gate you just ran by editing the tree under it. The condition is about uncommitted work,
   not about PR-versus-branch: the no-target case at step 1 includes your uncommitted
   changes, and those cannot reach an isolated worktree, so dispatch that one onto your own
   tree exactly as step 4 does. Know what the copy actually is before you lean on it: the
   worktree is cut from the repo's **default branch** — `main` here, not the `dev` this
   command diffs against — not from your branch and not from the PR, and it carries none of
   your uncommitted work; `git status` in it comes back empty. The object store is shared, so
   give the reviewer the base and head SHAs and tell it to read the code under review with
   `git show <sha>:<path>` / `git grep <pat> <sha>`, or to put its worktree on the code with
   `git switch --detach <sha>` — by SHA, since git refuses a branch another worktree already
   holds, which under `--fix` is exactly what step 1 just did. A plain `Read`/`Grep` in there
   answers about the default branch, and that looks exactly like a missing guard. Say in the
   prompt that the worktree is the agent's own and may be written in, and name the tree that
   may not be: its contract defaults to treating **every** checkout of this repo as
   off-limits, so an unstated grant reads as no grant and it will refuse the mutation probes
   its own checklist asks for. Isolation is also not the whole guard: it keys on the primary
   checkout, so the sibling worktree this repo usually works in is not covered, and the
   agent's own writes land in gitignored `.claude/worktrees/`, which your `git status` cannot
   see — it catches a stray write into your checkout, which is the failure that actually
   happened, and nothing inside the agent's copy. Give it the stated intent as the spec
   and your scope notes:
   the agent starts with empty context, so restate everything — how to get the diff, the
   intent, which guards matter most for this change, and that new behaviour the intent
   does not claim is itself a finding. Tell it the scratchpad path for any probe files,
   and that the tree under review must come back unmodified — your checkout, not the
   throwaway worktree it may have been handed as its own — then check that yourself
   (`git status`) when it reports, rather than assuming.
   Merge and deduplicate the findings, then triage
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
   behaviour beyond the fixes. **Do not pass `isolation: "worktree"` here** — the fixes are
   uncommitted at this point, so an isolated worktree would hold none of them and the
   reviewer would sign off on an empty diff. Dispatch it onto the tree you fixed in, naming
   that path **as the tree under review** — its contract already treats every checkout of
   this repo that way by default, so naming it costs nothing and removes the one thing that
   could be mistaken for a grant — and hold it to read-only by its own contract plus a
   `git status` of your own when it reports. The structural guarantee is available at this
   step only at the price of committing the fixes first and reviewing the commit — that is
   a call to put to me, per step 5, not one to make silently.
   If it confirms new problems, loop back to step 2 scoped
   to the fix diff. Cap: 3 rounds total; whatever remains after that is reported, not
   iterated — but the cap bounds **wall-clock**, and is not a claim that the loop
   converged. The finding rate here has not decayed across rounds: each round has turned
   up fewer but more consequential things, several of them introduced by the previous
   round's own fix. So a round count is not a convergence signal and must never be
   reported as one — "3 rounds" means the budget ran out, not that the diff is clean.
   A verifier that proposes a fix has done its job; one that _applies_ one has not.
   If a reviewer comes back having edited anything, treat its report as unreliable for
   this round — re-verify its claims yourself — and rebuild the fix set from a clean
   worktree rather than trusting the tree it handed back. Findings it raises that are
   real are still real: keep them, drop the edits.

   **Terminating pass — verify-only, no fix step.** The cap leaves a tail: the fixes
   written in answer to the final round go out with no adversarial pass over them. So
   whenever any fix was applied _after_ the most recent verification pass, run exactly one
   more `plan-verifier` pass before step 5. The trigger is "fixes exist that no
   verification has seen", not "three rounds elapsed" — that is always true when the cap
   is reached, and it is false when the loop exits because a verification came back clean
   and nothing changed after it. In that second case there is no tail: skip the pass, and
   say so in step 5's required line. Scope it **only** to "did the last round's fixes
   introduce anything" — the fix diff and the findings it was answering, not a general
   re-review of the target, which step 2 already did. **No fix step is permitted from it.**
   Its findings go to the step 5 verdict and the step 5 PR comment; they never re-enter the
   loop. That is what makes this terminate **by construction** rather than by another
   counter — nothing it finds gets fixed in this invocation, so there is nothing for it to
   loop over. Isolation is step 4's rule for step 4's reason: **do not pass
   `isolation: "worktree"`** — the fixes are still uncommitted, so an isolated worktree
   would hold none of them and the reviewer would sign off on an empty diff. Dispatch it
   onto the tree you fixed in, naming that path as the tree under review (its contract
   already treats every checkout of this repo that way by default, so naming it costs
   nothing and removes the one thing that could be mistaken for a grant), and hold it
   read-only by that contract plus a `git status` of your own when it reports.

5. **Validate.** Deliver the verdict yourself: approve / request-changes, justified by
   the surviving findings and the local proof (gate output tails, skips distinguished
   from passes, formatting clean, cross-platform concerns named — paths POSIX via
   `toPosix`, separator-agnostic tests). One line of that verdict is **required**, with
   the same standing the command gives "skips distinguished from passes" — a verdict
   missing it is incomplete, not merely thinner: **the unreviewed tail.** Write it on its own line, opening with
   the literal token `Unreviewed tail:` — a property a reader has to infer is one step 6 can drop
   and nobody can grep a posted PR comment for; a fixed prefix makes the requirement checkable. Name which
   findings were fixed after the final verification round and are therefore unreviewed;
   when the step 4 terminating pass ran, report what it found, flagged as findings that
   are **unfixed in this invocation by construction**; and when there is no tail — the
   last verification pass covered every fix, or the run was report-only and changed
   nothing — write "none" and say which of those it is. An absent line and a "none" line
   must not look the same. A verdict of "3 rounds, clean" whose third round's fixes no
   reviewer ever attacked is the exact overclaim this line removes.
   Then, **each gated on my explicit go, one at a
   time**: (a) post the findings/verdict as a single PR comment via `gh` — show me the
   exact comment text first; (b) commit the fixes onto the PR branch and push — show me
   the diff summary and commit message first, and sync with the remote per CLAUDE.md
   (re-running the gate after resolving any conflicts) before committing. Never post or
   push without the go.

6. **Close.** Summarize: the verdict, the unreviewed tail (step 5's required line,
   carried verbatim — including its "none"), findings fixed vs deferred vs dropped (with
   reasons), the proof, and the exact next command for anything left. Anything the
   terminating pass raised is "deferred", never "fixed": it is unfixed by construction,
   and a summary that files it anywhere else re-creates the overclaim.

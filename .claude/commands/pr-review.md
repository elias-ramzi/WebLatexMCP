---
description: Multi-agent PR review in rounds; pr-reviewer agents review through separate lenses, findings are verified, and with --fix they are fixed between rounds
argument-hint: '[PR number | PR URL | branch] <low|medium|high|max> [--model opus|sonnet|haiku|fable] [--fix] [--rounds N]'
disable-model-invocation: true
---

Run a multi-round review of a pull request. You are the orchestrator: you read the PR, dispatch
`pr-reviewer` agents (`.claude/agents/pr-reviewer.md`), merge and verify what they find, have the
findings fixed if asked, and report. You do not review the code yourself, beyond checking what
the agents report.

Arguments: `$ARGUMENTS`

## 1. Parse the arguments

- **target** (optional): a PR number, a PR URL, or a branch name. If there is none, review the current
  branch against `dev`.
- **effort** (required): `low`, `medium`, `high` or `max`, given as a bare word or as `--effort X`. If it
  is missing, ask with AskUserQuestion. Do not guess it.
- **`--model`**: `opus` (the default), `sonnet`, `haiku` or `fable`. It is passed as the Agent `model`
  of every agent you dispatch. Your own model does not change.
- **`--fix`**: confirmed findings are fixed between rounds. Without it, nothing in the tree is edited.
- **`--rounds N`**: the maximum number of review (and fix) rounds, 1 by default. A closing review, which
  fixes nothing, always runs after them (section 5).

Reject anything else and print the usage line from `argument-hint`.

## 2. Resolve the target and set up the run

1. If the target is a PR, run `gh pr view <target> --json number,title,body,url,baseRefName,headRefName,headRefOid,isCrossRepository,commits,files,closingIssuesReferences`,
   and `gh issue view <n> --json title,body` for each linked issue (and any issue the body names as
   `#<n>`), since they define what the PR has to do.
   For a branch, or for no target, use `origin/dev` as the base (run `git fetch origin dev` first) and
   the branch as the head. Stop if there is nothing to review: no commits past the merge base and no
   uncommitted changes.
2. Find the **working tree**: a checkout at the head, because the reviewers read the working tree.
   - If the head branch is checked out in a worktree (`git worktree list --porcelain`), use that tree;
     `gh pr checkout` would fail there anyway.
   - Else, if this checkout's `HEAD` is already at the head, use it as it is.
   - Else, if `git status --porcelain` is empty, run `gh pr checkout <n>` (or `git checkout <branch>`)
     here, and note the branch you left so the report can name it.
   - Else the tree is dirty: stop and ask whether to stash, commit, or review from a new worktree
     (`git worktree add ../WebLatexMCP-review-<target> <branch>`, then `npm ci` in it).

   In whichever tree you use, uncommitted changes count as part of what is reviewed; say so if there
   are any. From here on, run every `git`, `npm` and file command in that tree (`git -C <tree>`,
   absolute paths). Agents start in this session's directory, so the prompts name the tree. If `npm`
   is not on `PATH`, say so and go on without the gate (section 4f).

3. `BASE=$(git -C <tree> merge-base origin/<baseRefName> HEAD)`. Create the run directory
   `<session scratchpad>/pr-review/<target>-<YYYYmmdd-HHMMSS>/` and write `context.md` in it. Its first
   line is `Working tree: <absolute path>`. Then: the title, URL, body, the linked issues' titles and
   bodies, base branch, `BASE`, head SHA, the commit list (`git log --format='%h %s' BASE..HEAD`), the
   **PR files** (`git diff --name-only BASE HEAD`, fixed for the whole run), `git diff --stat BASE`, the
   effort, the model, whether `--fix` is on, and the rounds.
4. Split the changed files into **reviewed** and **excluded**. Excluded: `package-lock.json`, `dist/`,
   binary files (fixture PDFs and images), and generated files. Count the changed lines in the
   reviewed files.

## 3. Effort sets the plan

| effort | lenses                                            | verification                                                | findings kept                                         |
| ------ | ------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| low    | correctness, contracts                            | you re-read each cited line                                 | high confidence, severity medium or worse             |
| medium | correctness, contracts, integration               | you check each finding against the code                     | no nits                                               |
| high   | correctness, contracts, integration, design, docs | `pr-reviewer` agents in `verify` mode                       | CONFIRMED and PLAUSIBLE                               |
| max    | all six: also security                            | `verify` mode, two verifiers for each critical/high finding | CONFIRMED and PLAUSIBLE, low-confidence ones included |

At `high` and `max`, if the reviewed files have over ~1500 changed lines, give the correctness lens two
reviewers, each owning half of the files (split by directory, so related files stay together).

Lenses overlap on documentation, so one owns it: text in `README.md`, `docs/`, `CLAUDE.md`,
`CHANGELOG.md`, tool descriptions and `.claude/` markdown belongs to the docs lens when it runs (to
contracts otherwise). The other lenses report a doc problem only as part of a code finding.

## 4. Rounds

For round `r = 1 .. N`:

### a. Prepare

1. Regenerate the reviewed files: `git diff --name-only BASE` plus untracked files
   (`git ls-files --others --exclude-standard`), minus the excluded ones. Fixes may have touched files
   the PR did not.
2. In `round-<r>/`, write `diff.patch` (`git diff BASE -- <reviewed files>`, which includes uncommitted
   fixes from earlier rounds) and `prior.md`: every finding from earlier rounds with its id, file:line,
   summary and status (`fixed`, `rejected` and why, `open`, `skipped` and why, `deferred`), and for
   `--fix` the fixes made so far (`git diff HEAD`, saved as `round-<r>/fixes.patch` and referenced from
   `prior.md`). Point to `gate.md` in the run directory if it exists. In round 1, `prior.md` says
   "none".

### b. Review

Dispatch one `pr-reviewer` agent per lens (or per lens and file half), **all in a single message**, with
`model: <model>`. The prompt for each one:

```text
Mode: review. Lens: <lens>. Effort: <effort>. Round <r> of at most <N>.
Working tree: <abs path>. Read files and run git there (git -C <tree>, absolute paths).
Run directory: <abs path>. Read context.md, round-<r>/prior.md and round-<r>/diff.patch there,
and gate.md if it exists.
Files you own: <all reviewed files | the list>.
<if the docs lens runs and this is not it: "Doc text is the docs lens's; report a doc problem only as
part of a code finding.">
<round > 1: "Earlier rounds' findings and fixes are in prior.md. Check that each fix is right and
broke nothing, and look for what earlier rounds missed: start with the files that got the fewest
findings.">
Report in the JSON format your instructions define.
```

Wait for every reviewer to finish. If one fails or returns no parsable JSON, send it the error with
SendMessage once (load it with ToolSearch first); if it fails again, go on without it and say so in
the report.

### c. Merge

Collect the findings. Merge duplicates (same root cause: same file and nearby lines, or one bug seen
through two lenses) and keep the clearest wording and the highest severity. Drop findings on excluded
files, findings the effort filter excludes, and anything `prior.md` already lists as rejected unless
the reviewer gives new evidence. Give each kept finding a stable id `R<r>-<n>`.

### d. Verify

1. **Hard evidence.** At any effort, you may settle a finding yourself when hard evidence decides it: a
   test run (a finding's `test_check`, or a test you point at the cited code), a `git` result, a
   command's output, `gate.md`. Record the evidence as the reason; the finding needs no verifier.
2. **The rest**, as the effort table says. At `high`/`max`, group the findings by file into at most four
   batches and dispatch one `pr-reviewer` per batch in `mode: verify` (two per critical/high finding at
   `max`, in different batches), all in one message, with the findings' JSON in the prompt, the working
   tree and the run directory. A finding is CONFIRMED if its verifiers confirm it; at `max`, if two
   verifiers disagree, read the code yourself and decide. At `low`/`medium`, read the cited code yourself
   and drop what does not hold up.

REJECTED findings go into the next `prior.md` with the reason.

### e. Fix (only with `--fix`)

First decide whether this is the **last fix step**: round `N`, or a round that will stop early (4g's
rule, which depends only on this round's verdicts).

Fix only CONFIRMED findings. PLAUSIBLE ones are reported, not fixed. Of those:

- **Nits wait for the last fix step**, and are fixed there all at once (with the nits deferred by earlier
  rounds that are still valid). Fixing nits round after round mostly creates new nits. Until then their
  status is `deferred`.
- **Scope.** A fix that touches a file outside the PR files (`context.md`), or loosens a guard
  `CLAUDE.md` describes, is made only for findings of severity medium or worse. Below that the finding
  gets outcome `skipped`, "outside what an automatic fix should change", and is reported. Docstring and
  comment fixes in those files are fine.

Then:

1. Group them so that no two groups touch the same file: a finding's files are its `files_to_fix` (plus
   the test file for its regression test), and findings that share a file go in the same group. Merge
   groups until there are at most four. A finding whose edits split cleanly by file (code in one group,
   docs in another) may be split across groups.
2. Dispatch one `pr-reviewer` per group in `mode: fix`, all in one message, with `model: <model>`, the
   group's findings in JSON, the files it owns, the working tree and the run directory. Fixers run in
   parallel, which is safe only because their files are disjoint. Keep it that way.
3. When they are done, read `git diff` yourself. A fix that is wrong or reaches beyond its finding: correct
   it or undo it with Edit, and record that. Never `git checkout`, `restore`, `reset` or `stash`; they
   would also throw away the user's work. Check each regression test was seen failing before its fix.
4. Do not commit or push.

### f. Gate

Run the local gate in the working tree: `npm run typecheck`, `npm run lint`, `npm run format:check`,
`npm test`, and `npm run test:smoke` when `latexmk` is on `PATH` (say so when it is not: the smokes
skip, and a TeX-path change is then untested). Run it after every fix step; without `--fix`, run it
once, before round 1.

Append a section to `gate.md` in the run directory: which rounds' fixes the tree holds, and for each
step the command, the exit code, and the failures (test names, file:line). Write it before the next
round's `prior.md` or the closing review's dispatch, so those reviewers see it. A failing step is a
finding (severity high unless the output shows otherwise), handled in the next round, or in the closing
review after the last round. A failure that the PR did not cause (it fails at `BASE` too) is named
as such, not charged to the PR.

### g. Close the round

Write `round-<r>/summary.md`: the findings with their verdicts and outcomes, the reviewers that failed,
the files touched, the gate result. Then stop early if:

- with `--fix`: no finding this round was CONFIRMED with severity medium or worse. Its lows and the
  deferred nits were fixed in 4e, and the closing review reviews those fixes.
- without `--fix`: round `r > 1` found nothing that earlier rounds had not already found.

## 5. Closing review

This step always runs, even after an early stop. It reports what work is still missing. It fixes
nothing, whatever `--fix` says.

1. Write `closing/diff.patch` and `closing/prior.md` as in 4a, with the outcome of every round, and make
   sure `gate.md` is up to date.
2. In one message, dispatch:
   - one `pr-reviewer` with `Lens: completeness`, `Mode: review`, owning all reviewed files;
   - if the last round made fixes, the effort's lenses again, told to review the fixes in
     `closing/prior.md` (and the code around them) first: those fixes have not been reviewed yet.
     If the last round made no fixes, the code it reviewed is unchanged, so skip them.
3. Merge and verify the findings as in 4c and 4d (ids `C-<n>`). `needs-run` findings need no
   verification. Do not fix anything: whatever is confirmed here is the remaining work.

## 6. Report

1. If the ReportFindings tool is available, call it once, most severe first, with: every finding still
   open, skipped, deferred or PLAUSIBLE (from the rounds and the closing review), and the fixed findings of
   severity low or worse. Fixed nits are only counted, in the summary. The tool takes at most 32; if
   there are more, keep the most severe and say in the summary where the rest are (the rounds'
   `summary.md`). Pass `level: <effort>`, `verdict` (CONFIRMED/PLAUSIBLE), `outcome` with `--fix`
   (`fixed`, `skipped`, `no_change_needed`), `category` = the lens, and a `failure_scenario`. Do not
   also print the findings as text. Without the tool, print them as a list ranked by severity, each with
   a [file:line](path#Lline) link, the failure scenario and its status.
2. Then **Remaining work**, from the closing review: a verdict on the first line, either "complete as
   far as this review can tell" or "work missing", then the missing items, the open or PLAUSIBLE
   findings, and the runs the PR still needs (a TeX smoke, another OS), each one actionable.
3. Then a short summary: the target, head SHA and working tree, effort/model/rounds run (and why it
   stopped), the reviewers per round, the number of findings kept, rejected and fixed per round (fixed
   nits included), the gate result, and the run directory. With `--fix`: `git diff --stat`, a reminder
   that nothing is committed, and that a fix must still pass CI on all three OSes. If you checked out a
   branch, name the branch the user was on.
4. Do not post anything to GitHub. Offer, in one line, to commit the fixes or to post the findings as PR
   comments.

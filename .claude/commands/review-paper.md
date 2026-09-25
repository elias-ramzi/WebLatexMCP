---
description: Pre-submission peer review of an ML paper by an independent multi-model panel — full reviews on sonnet, opus and fable, an opus devil's advocate, a novelty scout, per-file typo hunters — merged by a fable triage into one final review (summary, strengths, weaknesses, minor weaknesses, questions, typos). Reviews, never edits.
argument-hint: <project id> [venue] [--deadline YYYY-MM-DD] [--focus "..."] [--no-web]
---

Review the paper below before submission with an independent panel of agents on different
models, then merge the panel into one final review with a triage agent. You are the dispatcher
and the clerk; the agents do the reviewing, and the triage does the judging.

Target: $ARGUMENTS

**This command reviews and never edits.** Nothing in the paper is written, committed, or pushed —
not the `.tex`, not the `.bib`. The only files it writes are the review reports, git-excluded, as
step 2 says. Applying a suggestion afterwards is a separate, explicit request.

**Load the method before you touch anything:** `list_skills({ skill: "peer-review" })`. That
skill is the single source of truth for how to review, what each role returns, and how triage
works; this command only says who does which part. Where the two could disagree, the skill wins —
except that the dispatch below replaces its "Single-session workflow". If `list_skills` fails,
stop and tell me.

1. **Resolve the target.** If no project id is given, call `list_projects` and ask me which one —
   do not guess. Take the venue, `--deadline` and `--focus` from the arguments; without a venue,
   use "a top-tier ML conference (NeurIPS/ICML/ICLR)" and say so in the summary — do not block on
   it. State the venue's page limit and score scale only if I gave them or you are sure of this
   year's rules (then mark them "(verify)"); otherwise "unknown". This is the **review context**
   every agent receives.

2. **Prepare.** `compile` once — the agents never compile, since a compile rewrites the build
   directory under the others. Keep the `pdfPath` and `pageCount`; turn every undefined-reference
   and undefined-citation warning into a `CMP-n` item, and add `check_citations`' keys without an
   entry. If the compile fails, stop and show me the first error — a review of a paper that does
   not build is a review of the wrong thing. Then set up the run directory
   `paper-review.local/<YYYYMMDD-HHMM>/` exactly as the skill's "Where the reports go" says —
   git-excluded before the first write on a git project, and only after asking me on a local one
   (if I decline, keep the reports in a temporary directory outside the project). Save the review
   context there as `context.md`, and the `CMP` items as `reports/compile.md`.

3. **Dispatch the panel — in parallel, and independent.** Launch these in the background, at most
   8 tool uses per message. Each agent starts empty and loads the skill itself, so each prompt
   carries only: the project id, the root file, the `pdfPath` and `pageCount`, the review context,
   and (for the reviewers) its reviewer id. Do not restate the method, and **never** pass one
   agent another's report — independence is what makes agreement a signal.

   | Agent                     | Model override | Reviewer id | Saved as                     |
   | ------------------------- | -------------- | ----------- | ---------------------------- |
   | `paper-reviewer`          | `sonnet`       | `SON`       | `reports/sonnet.md`          |
   | `paper-reviewer`          | `opus`         | `OPU`       | `reports/opus.md`            |
   | `paper-reviewer`          | `fable`        | `FAB`       | `reports/fable.md`           |
   | `paper-devils-advocate`   | —              | `DA`        | `reports/devils-advocate.md` |
   | `novelty-scout`           | —              | `NOV`       | `reports/novelty.md`         |
   | `corrector`, one per file | —              | `TYP`       | `reports/typos.md` (merged)  |

   Skip `novelty-scout` when I passed `--no-web` — it sends queries (never the title) to DBLP,
   Crossref, OpenAlex and the web. For `corrector`, build the file list as `/hunt-typo` does
   (`.tex`/`.md`, no `.bib`, no build directories; split a file over ~2000 lines across two
   agents), **report-only** — never pass apply authorization. If there are more than ~25 files,
   tell me the count and ask whether to run all or a subset. Say in one line that the panel is
   running, then wait for the completion notifications; do not poll.

4. **Collect.** Save each reply to its file with `write_file`, and merge the correctors' findings
   into one `reports/typos.md` table in file order. A reply that starts with `failed:`, is empty,
   or lacks its format's headings is re-dispatched **once** with the same prompt; if it fails
   again, note it and carry on.

5. **Triage.** Launch `review-triage` in the foreground with: the project id, the root file, the
   `pdfPath`, the review context, the paths of every saved report, and the list of missing ones.
   Split its reply at the `<<<TRIAGE-LOG>>>` line and save the two parts as `final-review.md` and
   `triage-log.md`. Check that `final-review.md` has exactly the six sections, in order — Summary,
   Strengths, Weaknesses, Minor weaknesses, Questions, Typos — and send it back to the triage
   agent once if not.

6. **Report.** Show `final-review.md` in full — it is the deliverable. Then, from the triage log:
   the predicted outcome, the top of the author action plan, and every item marked UNVERIFIABLE
   that I must check myself. Close with the panel that actually ran (models, any failed agent), the
   venue assumed, and links to `final-review.md`, `triage-log.md` and `reports/`. Never upload,
   publish or share the paper or the reviews anywhere.

To review a revision, run the command again: a new run directory, a fresh panel that never sees
the previous reports. Give only the triage agent the previous `triage-log.md` path, and ask it to
add a "Changes since the previous review" section — which earlier items are resolved, which remain.

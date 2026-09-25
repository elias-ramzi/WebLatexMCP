---
description: Pre-submission peer review of an ML paper by an independent multi-model panel — full reviews on sonnet, opus and fable, an opus devil's advocate, a novelty scout, per-file typo hunters — merged by a fable triage into one final review (summary, strengths, weaknesses, minor weaknesses, questions, typos). Reviews, never edits.
argument-hint: <project id | paper.pdf> [venue] [--deadline YYYY-MM-DD] [--focus "..."] [--no-web]
---

Review the paper below before submission with an independent panel of agents on different
models, then merge the panel into one final review with a triage agent. You are the dispatcher
and the clerk; the agents do the reviewing, and the triage does the judging.

Target: $ARGUMENTS

**This command reviews and never edits.** Nothing in the paper is written, committed, or pushed —
not the `.tex`, not the `.bib`. It writes only the review reports, on the local copy of the
project, and the one `.git/info/exclude` line that keeps them out of git, as step 2 says. Applying a
suggestion afterwards is a separate, explicit request.

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
   `paper-review.local/<YYYYMMDD-HHMM>/` on the local copy, exactly as the skill's "Where the
   reports go" says — git-excluded before the first write. Save the review context there as
   `context.md`, and the `CMP` items as `reports/compile.md`. Write every file of the run with
   `write_file` for a project, and with your own file tool for a bare PDF (below), which has no
   project for `write_file` to write into.

   **A bare PDF instead of a project id** (a co-author's draft, a paper with no sources) needs no
   project: skip `compile` and `check_citations`, put the run directory under the server's
   workspace as the skill says, copy the PDF there as `paper.pdf`, and build `paper.txt` from it
   exactly as the skill's "A bare PDF" says — one `=== p.<n> ===` marker per page, so every agent
   can tell which page a line is on. Every agent then gets those two paths instead of a project id
   and anchors findings as the skill's evidence anchors say for a bare PDF; the typo pass is one
   `corrector` per ~8 pages of `paper.txt`, by line range, each range starting at a page marker.

   **Make sure the agents can open the PDF.** They `Read` the PDF at `pdfPath` (or `paper.pdf` and
   `paper.txt`), and a background agent cannot answer a permission prompt. So `Read` page 1
   yourself, in the foreground, before dispatching: if Claude Code asks, I can allow that
   directory for the session, and the agents inherit it. If I decline, tell the project's agents
   to use `render_pages`/`extract_text` instead of `Read` for the PDF; for a bare PDF, which has no
   such fallback, stop and tell me.

3. **Dispatch the panel — in parallel, and independent.** Each agent starts empty and loads the
   skill itself, so each prompt carries only: the project id, the root file, the `pdfPath` and
   `pageCount`, the review context, and (for the reviewers) its reviewer id. Do not restate the
   method, and **never** pass one agent another's report — independence is what makes agreement a
   signal.

   **The three full reviews are blinded.** Assign `R1`, `R2` and `R3` to the sonnet, opus and fable
   reviewers in a fresh random order each run (e.g. `shuf -e sonnet opus fable`), and record the
   mapping in the run directory as `panel.md` — never in a report, and never in a path you give
   the triage. The triage runs on fable too, so one of the three reviews comes from its own
   model; not knowing which one keeps it from favouring that review.

   | Agent                     | Model override | Reviewer id | Saved as                     |
   | ------------------------- | -------------- | ----------- | ---------------------------- |
   | `paper-reviewer`          | per `panel.md` | `R1`        | `reports/r1.md`              |
   | `paper-reviewer`          | per `panel.md` | `R2`        | `reports/r2.md`              |
   | `paper-reviewer`          | per `panel.md` | `R3`        | `reports/r3.md`              |
   | `paper-devils-advocate`   | —              | `DA`        | `reports/devils-advocate.md` |
   | `novelty-scout`           | —              | `NOV`       | `reports/novelty.md`         |
   | `corrector`, one per file | —              | `TYP`       | `reports/typos.md` (merged)  |

   Skip `novelty-scout` when I passed `--no-web` — it sends queries (never the title) to DBLP,
   Crossref, OpenAlex and the web. For `corrector`, build the file list as `/hunt-typo` does
   (`.tex`/`.md`, no `.bib`, no build directories; split a file over ~2000 lines across two
   agents), and **leave out everything under `paper-review.local/`** — this run's own
   `context.md` and `reports/`, and every earlier run's reports, are not the paper. Correctors are
   **report-only** — never pass apply authorization.

   **Say what the run costs before you launch it**, in one line: how many agents (three full
   reviewers, the devil's advocate, the novelty scout unless `--no-web`, and the corrector count),
   then the triage; that the three reviewers, the devil's advocate and the triage each read the
   whole paper and PDF; and the page count. If the paper is over ~40 pages or there are more than
   ~25 corrector files, ask me before dispatching — all, a subset of files, or no typo pass.
   Otherwise go ahead.

   Launch the panel in the background, at most 8 tool uses per message. Say in one line that it is
   running — naming, unless `--no-web`, that the novelty scout is sending search queries out —
   then wait for the completion notifications; do not poll.

4. **Collect.** Save each reply to its file, and merge the correctors' findings into one
   `reports/typos.md` table in file order. A reply that starts with `failed:`, is empty, or lacks
   its format's headings is re-dispatched **once** with the same prompt; if it fails again, note it
   and carry on.

5. **Triage.** Launch `review-triage` in the foreground with: the project id, the root file, the
   `pdfPath`, the review context, the paths of every saved report (never `panel.md`), and the list
   of missing ones. Split its reply at the `<<<TRIAGE-LOG>>>` line and save the two parts as
   `final-review.md` and `triage-log.md`. Check that `final-review.md` has exactly the six
   sections, in order — Summary, Strengths, Weaknesses, Minor weaknesses, Questions, Typos — and
   send it back to the triage agent once if not.

6. **Report.** Surface `final-review.md` as the skill's "Surfacing the final review" says — in
   the Claude desktop app, send it as a file I can download (`SendUserFile`, `display: "attach"`);
   everywhere, show it in full and link it. Then, from the triage log: the predicted outcome, the
   top of the author action plan, and every item marked UNVERIFIABLE that I must check myself.
   Close with the panel that actually ran (which model each of `R1`–`R3` was, from `panel.md`, and
   any failed agent), the venue assumed, and links to `final-review.md`, `triage-log.md` and
   `reports/`, and name the exclude file that gained the `paper-review.local/` line, if one did.
   Never upload, publish or share the paper or the reviews anywhere.

To review a revision, run the command again: a new run directory, a fresh panel that never sees
the previous reports, and a fresh blinding. Give only the triage agent the previous
`triage-log.md` path, and ask it to add a "Changes since the previous review" section — which
earlier items are resolved, which remain.

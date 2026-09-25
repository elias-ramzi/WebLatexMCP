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

**Check that the server is connected, first.** Every step below — and every agent — runs through
the `web-latex-mcp` tools: the method loads with `list_skills`, the project with `read_file`, the
run directory's place with `server_info`. They may be deferred — named but not yet loaded — in
which case load them with `ToolSearch` first; that counts as connected. If they are neither in
your tool list nor loadable, stop and tell me the server is not connected in this session, pointing at `docs/install/README.md` (or `/mcp`
to reconnect). Do not work around it — not by reading `SKILL.md` from disk, not by writing reports
with the shell — since the agents you would dispatch cannot either.

**Load the method before you touch anything:** `list_skills({ skill: "peer-review" })`. That
skill is the single source of truth for how to review, what each role returns, and how triage
works; this command only says who does which part. Where the two could disagree, the skill wins —
except that the dispatch below replaces its "Single-session workflow". If `list_skills` fails,
stop and tell me.

1. **Resolve the target.** If no project id is given, call `list_projects` and ask me which one —
   do not guess. If `list_projects` shows it `cloned: false`, clone it with `project_sync` and say
   so — that is the one way to get the paper. **Never inspect, fetch from or read any other
   checkout of the paper**, even one you know exists elsewhere on this machine: it may sit at
   another commit, and a fetch there uses credentials that were not offered for this run. Take the
   venue, `--deadline` and `--focus` from the arguments; without a venue,
   use "a top-tier ML conference (NeurIPS/ICML/ICLR)" and say so in the summary — do not block on
   it. State the venue's page limit and score scale only if I gave them or you are sure of this
   year's rules (then mark them "(verify)"); otherwise "unknown". This is the **review context**
   every agent receives.

2. **Prepare.** `compile` once — the agents never compile, since a compile rewrites the build
   directory under the others. Keep the `pdfPath` and `pageCount`; turn every undefined-reference
   and undefined-citation warning into a `CMP-n` item, and add `check_citations`' keys without an
   entry. If the compile fails, stop and show me the first error — a review of a paper that does
   not build is a review of the wrong thing. Then pick the run directory
   `paper-review.local/<YYYYMMDD-HHMM>/` on the local copy and git-exclude it, exactly as the
   skill's "Where the reports go" says — but **write nothing into it until every panel agent has
   returned** (step 4): the reviewers search the project, and a report or note saved there
   mid-run is one `search_files` away from breaking their independence. Keep the review context
   and the `CMP` items in your own context until then. Write every file of the run with
   `write_file` for a project, and with your own file tool for a bare PDF (below), which has no
   project for `write_file` to write into.

   **A bare PDF instead of a project id** (a co-author's draft, a paper with no sources) needs no
   project, but it needs poppler: check `command -v pdfinfo pdftotext pdftoppm` first (the first
   two build `paper.txt`; `Read` needs `pdftoppm` to show a PDF's pages). If any is missing, stop
   and tell me which, with the install line for this OS (`apt-get install poppler-utils`,
   `brew install poppler`, or `conda install -c conda-forge poppler`) — **never install it
   yourself**; that changes my system. Then skip `compile` and `check_citations`, put the run
   directory under the server's workspace as the skill says, copy the PDF there as `paper.pdf`
   (the paper itself is the one thing written before dispatch), and build `paper.txt` from it
   exactly as the skill's "A bare PDF" says — one `=== p.<n> ===` marker per page, so every agent
   can tell which page a line is on. Every agent then gets those two paths instead of a project id
   and anchors findings as the skill's evidence anchors say for a bare PDF; the typo pass is one
   `paper-typo-hunter` per ~8 pages of `paper.txt`, by line range, each range starting at a page
   marker.

   **Make sure the agents can open the PDF.** They `Read` the PDF at `pdfPath` (or `paper.pdf` and
   `paper.txt`), and a background agent cannot answer a permission prompt. So `Read` page 1
   yourself, in the foreground, before dispatching: if Claude Code asks, I can allow that
   directory for the session, and the agents inherit it. `Read` of a PDF over 10 pages needs
   `pages`, and reading pages needs poppler's `pdftoppm`; so test with `pages`, the way the agents
   will read. If I decline, or `pdftoppm` is missing — then give me the poppler install line as
   above, since installing it restores `Read`, and never install it yourself — tell the project's
   agents to use `render_pages`/`extract_text` instead of `Read` for the PDF; for a bare PDF,
   which has no such fallback, stop and tell me.

3. **Dispatch the panel — in parallel, and independent.** Each agent starts empty and loads the
   skill itself, so each prompt carries only: the project id, the root file, the `pdfPath` and
   `pageCount`, the review context, and (for the reviewers) its reviewer id. Do not restate the
   method, and **never** pass one agent another's report — independence is what makes agreement a
   signal.

   **The three full reviews are blinded.** Assign `R1`, `R2` and `R3` to the sonnet, opus and fable
   reviewers in a fresh random order each run (e.g. `shuf -e sonnet opus fable`), and keep the
   mapping in your own context — it is written to `panel.md` only in step 6, after the triage
   has returned, since anything in the project before then is visible to every agent that lists
   files. Never put it in a report or in a prompt. The triage runs on fable too, so one of the three reviews comes from its own
   model; not knowing which one keeps it from favouring that review.

   | Agent                             | Model override | Reviewer id | Saved as                     |
   | --------------------------------- | -------------- | ----------- | ---------------------------- |
   | `paper-reviewer`                  | shuffled       | `R1`        | `reports/r1.md`              |
   | `paper-reviewer`                  | shuffled       | `R2`        | `reports/r2.md`              |
   | `paper-reviewer`                  | shuffled       | `R3`        | `reports/r3.md`              |
   | `paper-devils-advocate`           | —              | `DA`        | `reports/devils-advocate.md` |
   | `novelty-scout`                   | —              | `NOV`       | `reports/novelty.md`         |
   | `paper-typo-hunter`, one per file | —              | `TYP`       | `reports/typos.md` (merged)  |

   Skip `novelty-scout` when I passed `--no-web` — it sends queries (never the title) to DBLP,
   Crossref, OpenAlex and the web. For `paper-typo-hunter`, build the file list from what the
   paper actually compiles: the root file and every file reachable from it through `\input`,
   `\include` and `\subfile` — a `.tex` nothing includes never reaches a reader. No `.bib`; split
   a file over ~2000 lines across two agents; and nothing under `paper-review.local/`, which holds
   reports, not the paper. Use
   `paper-typo-hunter`, never `corrector`: its tool list has no edit tool, so the typo pass is
   read-only by construction rather than by the prompt.

   **Say what the run costs before you launch it**, in one line: how many agents (three full
   reviewers, the devil's advocate, the novelty scout unless `--no-web`, and the typo-hunter count),
   then the triage; that the three reviewers, the devil's advocate and the triage each read the
   whole paper and PDF; the page count; and a rough token figure. From the runs so far: about
   150–320k tokens per full reviewer, the devil's advocate, the novelty scout and the triage each,
   and 70–110k per typo hunter — 1.3M for a 19-page PDF with two typo hunters, 2.4M for a 28-page
   project with nine. If the paper is over ~40 pages or there are more than
   ~25 typo-hunter files, ask me before dispatching — all, a subset of files, or no typo pass.
   Otherwise go ahead.

   Launch the panel in the background, at most 8 tool uses per message. Say in one line that it is
   running — naming, unless `--no-web`, that the novelty scout is sending search queries out —
   then wait for the completion notifications; do not poll.

4. **Collect — once every panel agent has returned**, not as each one does. Then write the run
   directory: `context.md` (the review context), `reports/compile.md` (the `CMP` items), each
   reply to its file, and the typo hunters' findings merged into one `reports/typos.md` table in
   file order. A reply that starts with `failed:`, is empty, or lacks
   its format's headings is re-dispatched **once** with the same prompt; if it fails again, note it
   and carry on.

5. **Triage.** Launch `review-triage` in the foreground with: the project id, the root file, the
   `pdfPath`, the review context, the paths of every saved report, and the list
   of missing ones. Split its reply at the `<<<TRIAGE-LOG>>>` line and save the two parts as
   `final-review.md` and `triage-log.md`. Check that `final-review.md` has exactly the six
   sections, in order — Summary, Strengths, Weaknesses, Minor weaknesses, Questions, Typos — and
   send it back to the triage agent once if not.

6. **Report.** Surface `final-review.md` as the skill's "Surfacing the final review" says — in
   the Claude desktop app, send it as a file I can download (`SendUserFile`, `display: "attach"`)
   as part of this step, without waiting to be asked; everywhere, show it in full and link it.
   Now write `panel.md` — which model each of `R1`–`R3` was. Then, from the triage log: the
   predicted outcome, the top of the author action plan, and every item marked UNVERIFIABLE that I must check myself.
   Close with the panel that actually ran (which model each of `R1`–`R3` was, and any failed
   agent), the venue assumed, and links to `final-review.md`, `triage-log.md` and
   `reports/`, and name the exclude file that gained the `paper-review.local/` line, if one did.
   Never upload, publish or share the paper or the reviews anywhere.

To review a revision, run the command again: a new run directory, a fresh panel that never sees
the previous reports, and a fresh blinding. Give only the triage agent the previous
`triage-log.md` path, and ask it to add a "Changes since the previous review" section — which
earlier items are resolved, which remain.

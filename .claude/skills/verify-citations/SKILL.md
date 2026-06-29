---
name: verify-citations
description: Verify the citations already in a project's .bib bibliography against DBLP — check each entry's title, authors, venue (handling abbreviations like CVPR/NeurIPS), and publication year, flag anything doubtful for the user, and optionally annotate the entries you confirmed. Use when the user asks to "verify", "check", "audit", or "validate" the citations / bibliography / references of a LaTeX/Overleaf project. Read-only by default; never changes a .bib without explicit permission. Operates on projects served by the latex-git MCP server.
---

# Verify a project's citations against DBLP

Audit the references already in a project's `.bib` file(s) against the **DBLP** database (via the
`latex-git` MCP tools) and surface anything that doesn't line up. For each entry you compare four
fields against the canonical DBLP record:

1. **Title** of the paper.
2. **Authors** — the **complete** author list. A citation must name **every** author; a bib entry that
   truncates with `and others` (which biblatex/BibTeX renders as "et al.") is a defect to flag, even when
   the names it does list are correct.
3. **Venue** — conference or journal. Bibliographies and DBLP both abbreviate heavily (CVPR, NeurIPS,
   ICLR…), so normalize before comparing.
4. **Publication year**.

The point is to catch wrong years, misspelled or missing authors, a truncated author list (`and others`),
a preprint cited where a published version exists, a mangled title, or an entry that isn't on DBLP at all —
and to let the **user** decide what to do about each one. You verify; you do not silently fix.

## The one rule that overrides everything

**Never modify a `.bib` file without explicit permission from the user, in this session.** This skill is
**read-only by default**. The only writes it may ever make are:

- (a) optional `% verified-by-claude` comment lines on entries the user agreed to annotate, and
- (b) a correction to an entry that the user explicitly asked you to make.

Both require `confirmBibEdit: true` on the `edit_file`/`write_file` call **and** a clear yes from the
user first. When in doubt, do not write. A missed annotation is harmless; an unrequested edit to someone's
bibliography is not.

**Verification comes from DBLP, not from your own memory.** Do not "confirm" a citation from what you
think you know about the paper — only an actual DBLP match counts. If DBLP can't confirm it, it's
unverified, and you say so.

## Workflow

Run in order. Stop and report if a step fails.

1. **Pick the project.** If the user didn't name one, `list_projects` and ask which.
2. **Sync.** `project_sync` the project so you check the current bibliography, not a stale clone.
3. **Collect the entries.** `list_files` with `filter: "bib"`; `read_file` each `.bib`. Parse out every
   entry — its cite key, `title`, `author`, `year`, and venue (`booktitle` for proceedings, `journal`
   for articles, else `series`/`publisher`/`howpublished`). **Skip** any entry already carrying a
   `% verified-by-claude:` comment (see below) unless the user asks to re-check everything.
4. **Match each entry against DBLP — one paper at a time, sequentially.** For each entry, call
   `search_references` with a query built from the distinctive title words plus the first author's surname
   (e.g. `deep residual learning he`). Keep `maxResults` small (5–8). Classify the result (see
   _Classifying a match_), then move to the next entry. **Do not fan out parallel DBLP calls** (see
   _Pace DBLP requests_ — it rate-limits hard). Process the whole bibliography one entry at a time.
5. **Triage, don't interrogate.** Entries that match confidently need no questions — just count them.
   Only entries with a discrepancy or no match get escalated to the user.
6. **Resolve the doubtful ones with the user.** Go through the flagged entries (one at a time, or a few
   at a time if there are many), showing the `.bib` fields beside the DBLP record and naming the exact
   discrepancy. Let the user decide. **Never resolve a doubt by guessing.**
7. **Report.** A short summary: how many verified cleanly, how many need attention (with the specifics),
   how many weren't found on DBLP.
8. **(Optional, opt-in) Annotate.** If — and only if — the user wants it, add a `% verified-by-claude`
   comment to each confirmed entry (see _Annotating verified entries_). This is the one and only `.bib`
   write the skill makes on its own initiative, and only after an explicit yes.

Do all reads/edits within the one project so the per-project mutex serializes them.

## Pace DBLP requests

DBLP is a free public API and **rate-limits aggressively**. Firing many `search_references` calls at once
(or in big parallel batches) gets you `429 Too Many Requests` and timeouts, which is slower overall than
going steadily — you end up waiting out cooldowns. Lessons from real runs:

- **Go strictly sequential: one `search_references` per entry, awaited before the next.** Paper-by-paper
  is _more_ efficient here than asking for a batch all at once, because it never trips the limiter.
- **Don't burst.** Never issue DBLP queries in parallel, and don't pre-fetch the whole bibliography up
  front.
- **On a `429` or a timeout, back off briefly and retry** — a few seconds, doubling if it repeats
  (e.g. 5s → 10s → 20s). That's enough; **don't sit on multi-minute fixed timers** between every call —
  that's overcorrecting and makes a long bibliography crawl.
- For a large `.bib`, tell the user this part is paced and roughly how long it'll take, so a steady run
  doesn't look stuck.

## Classifying a match

Normalize before comparing — bibliographies are full of LaTeX. Strip `{}` capitalization braces,
`\&`→`&`, accent commands (`\'e`→`e`), and `$…$`; lowercase; collapse whitespace. For authors, compare
on **surnames** (bib uses `Last, First` or `First Last`, `and`-separated; DBLP returns `First Last`), and
check the **count** too — the bib must list every author DBLP does, in the same order.

A bib `author` field ending in `and others` (or containing a literal `et al.`) is **always a defect**,
independent of the name comparison: it means the citation will print an abbreviated author list. Treat it
as a **doubt** and tell the user the full list from DBLP so they can complete the entry.

- **Confident match** — the top DBLP hit's title matches, **every** author matches (same surnames, same
  count, no `and others` truncation), the year is identical, and the venue is consistent after
  abbreviation normalization. No need to bother the user; mark it verified.
- **Doubt** — title matches but something disagrees: a different year (even ±1), a misspelled/missing/extra
  author, a **truncated author list** (`and others` / `et al.` in the bib while DBLP lists more names), a
  venue that doesn't reconcile, **or** the bib cites an arXiv/preprint while DBLP has a published version
  (or vice-versa), **or** several DBLP records are equally plausible. Escalate to the user.
- **Not found** — no DBLP hit has a matching title. Escalate, but note that some legitimate references
  (books, tech reports, standards, very new or niche work) simply aren't indexed by DBLP — "not found"
  means "DBLP can't confirm it", not "it's wrong".

When a field disagrees, prefer treating it as a **doubt** over silently calling it verified. The cost of
asking is a question; the cost of a false "verified" is a citation error shipped to a reviewer.

## Venue abbreviations

The same venue appears in many forms across a `.bib` and DBLP. Treat these as equivalent (DBLP usually
returns the short form on the left; the bib may use any of them):

- **CVPR** = IEEE/CVF Conference on Computer Vision and Pattern Recognition
- **ICCV** = International Conference on Computer Vision · **ECCV** = European Conference on Computer Vision
- **NeurIPS** / **NIPS** = Advances in Neural Information Processing Systems (NIPS was renamed NeurIPS in 2018)
- **ICML** = International Conference on Machine Learning · **ICLR** = International Conference on Learning Representations
- **AAAI** = AAAI Conference on Artificial Intelligence · **IJCAI** = International Joint Conference on AI
- **ACL** / **EMNLP** / **NAACL** = Assoc. for Computational Linguistics venues
- **KDD** = ACM SIGKDD · **SIGIR**, **WWW**, **SIGGRAPH**, **MICCAI**, **TPAMI** (journal), **JMLR** (journal)

This list is not exhaustive — for venues not on it, expand the acronym yourself and compare on meaning,
not exact string. If you can't tell whether two venue strings are the same conference, that's a **doubt**:
ask.

## Asking the user

Use the **AskUserQuestion** tool for each doubtful or not-found entry (batch a few when there are many).
Make the discrepancy obvious. For each, show:

- the **bib entry** as it stands: cite key, title, authors, venue, year;
- the **DBLP candidate(s)**: title, authors, venue, year, and the DBLP key — or "no DBLP match found";
- a one-line statement of **what differs** (e.g. "bib says 2019, DBLP says 2020"; "bib cites the arXiv
  preprint; DBLP has the CVPR 2021 version"; "author _J. Smith_ not on the DBLP record"; "bib truncates
  the authors with `and others` — DBLP lists all 7, paste them in").

Offer concrete choices, e.g. _Accept as-is (mark verified)_ · _Leave unverified / flag it_ · _Update the
entry from DBLP (I'll need your go-ahead to edit the .bib)_. Only act on what the user picks. If they ask
you to fix an entry, that's a `confirmBibEdit: true` edit — make exactly the change they approved and
nothing more; the cleanest fix is usually to remove the stale entry and re-add it with `add_citation`
from the DBLP key (so the new text again originates from DBLP, not from you).

## Annotating verified entries (opt-in — needs permission + `confirmBibEdit`)

Once entries are confirmed, the user may want them marked so a later run can skip them. Only with their
explicit yes, add a single comment line **immediately above** each confirmed entry:

```bibtex
% verified-by-claude: DBLP conf/cvpr/HeZRS16 on 2026-06-24
@inproceedings{he2016deep,
  ...
}
```

- A `%` line in a `.bib` is a **comment** — BibTeX/biber ignore it, so it **cannot change the compiled
  bibliography or PDF**. (No compile is needed to prove that, though you may `compile` if the user wants
  reassurance.)
- Include the DBLP key you matched against and today's date, so the annotation is auditable.
- This is still a write to a protected `.bib`: use `edit_file` with `confirmBibEdit: true`, matching the
  exact `@type{key,` header line so the insertion is surgical.
- **Idempotent:** an entry that already has a `% verified-by-claude:` line is left alone. This is what
  makes re-runs cheap — step 3 skips already-annotated entries.
- Only annotate **confident matches** (or entries the user explicitly accepted). Never annotate something
  still in doubt.

## After you finish

Report concisely: total entries checked, how many verified against DBLP, the specific entries that need
the user's attention and why, and any that weren't on DBLP. If you annotated, say which file(s) you
touched and remind the user that — per CLAUDE.md — `commit`/`push` happen only when they ask, so nothing
has left their machine. Point them at the `diff`.

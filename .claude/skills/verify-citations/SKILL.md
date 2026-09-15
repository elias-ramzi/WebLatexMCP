---
name: verify-citations
description: Verify the references of a document against DBLP, Crossref and OpenAlex — check each one's title, authors, venue (handling abbreviations like CVPR/NeurIPS), and publication year, flag anything doubtful for the user, write an audit report you can open, and optionally annotate the entries you confirmed. Works whatever shape the bibliography has — a BibTeX .bib, a LaTeX thebibliography, or a reference list written as prose in a markdown or plain-text document — and whether the document is on a git remote (Overleaf, GitHub) or is just a directory on this machine with no remote at all. Use when the user asks to "verify", "check", "audit", or "validate" the citations / bibliography / references of a paper, proposal, or draft. Read-only for the bibliography by default (the report is a separate local file, never pushed); never changes it without explicit permission. Operates on projects served by the web-latex-mcp MCP server.
---

# Verify a document's references against DBLP, Crossref and OpenAlex

Audit the references a document actually carries against a **bibliography service** — DBLP,
Crossref or OpenAlex, reached through the `web-latex-mcp` MCP tools' `search_references` /
`add_citation` — and surface anything that doesn't line up. Left unpinned, `search_references`
tries DBLP first, then Crossref, then OpenAlex, substituting one that cannot be reached (dblp.org
in particular currently sits behind an anti-bot proof-of-work wall, so a DBLP attempt may simply
fail — this fallback exists for exactly that case). The result always says which backend actually
answered (`source`), and, only on a substitution, which one it stood in for (`fallbackFrom`) and
why (`hint`). For each reference you compare four fields against the canonical record the
answering service returns:

1. **Title** of the paper.
2. **Authors** — the **complete** author list. A citation must name **every** author; a reference that
   truncates with `and others` / "et al." (which renders as an abbreviated list) is a defect to flag,
   even when the names it does list are correct.
3. **Venue** — conference or journal. Bibliographies and these services both abbreviate heavily
   (CVPR, NeurIPS, ICLR…), so normalize before comparing.
4. **Publication year**.

The point is to catch wrong years, misspelled or missing authors, a truncated author list, a preprint
cited where a published version exists, a mangled title, or a reference none of the three services
can confirm — and to let the **user** decide what to do about each one. You verify; you do not
silently fix.

## What counts as a bibliography

**A bibliography is not always a `.bib`, and a project is not always on a remote.** The verification
is identical in every case; only the reading changes. `list_references` handles all three shapes and
tells you, per entry, which one you got (`format`):

| `format`  | Where it comes from                                           | Trust the parsed fields?                                        |
| --------- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| `bibtex`  | A `.bib` file (`@string` macros already resolved)             | Yes — exact.                                                    |
| `bibitem` | A LaTeX `thebibliography` (`\bibitem{key} …`) inside a `.tex` | Key is exact; the rest is free text, so treat fields as a hint. |
| `prose`   | A reference list in a markdown / plain-text document          | No — heuristic. **Read `raw`** before deciding anything.        |

For `prose` (and often `bibitem`) entries, `title` or `authors` may be missing simply because nothing
in the text delimited them. That is not a defect in the reference — it means you must build the
`search_references` query from `raw` yourself. Never report "no title" as a finding for a prose entry.

## The one rule that overrides everything

**Never modify the bibliography without explicit permission from the user, in this session.** This
skill is **read-only by default**. The only writes it may ever make are:

- (a) optional `% verified-by-claude` comment lines on entries the user agreed to annotate, and
- (b) a correction the user explicitly asked you to make.

For a `.bib` both require `confirmBibEdit: true` on the `edit_file`/`write_file` call **and** a clear
yes from the user first. A `thebibliography` in a `.tex` and a reference list in a `.md` are not
protected by the `.bib` guard — **the rule still applies to them**: the guard is a backstop, not the
policy. When in doubt, do not write. A missed annotation is harmless; an unrequested edit to someone's
bibliography is not.

Writing the **audit report** (see _The audit report_) is not a bibliography write and is exempt: it's
a single file that never touches the document and is never pushed.

**Verification comes from the bibliography service that answered — DBLP, Crossref or OpenAlex —
never from your own memory.** Do not "confirm" a reference from what you think you know about the
paper — only an actual match from one of these services counts. If none of them can confirm it,
it's unverified, and you say so. (An entry a service couldn't be _reached_ to check is a different
thing — see _Handling "not found" vs. "couldn't check"_ — never report that as unverified either.)

## Workflow

Run in order. Stop and report if a step fails.

1. **Pick the project, and note its mode.** `list_projects`. If the user didn't name one, ask which.
   From the result, note the project's **`path`** (you need it for the report) and its **`mode`**:

   - `mode: "git"` — a clone of a remote. Everything below that mentions git applies.
   - `mode: "local"` — a directory on this machine, edited in place. **There is no remote**, so
     `project_sync`, `status`, `diff`, `commit` and `push` all refuse by design. Skip every git step;
     nothing in this skill needs them.

   If the document isn't registered at all — the common case for a draft that lives in some directory
   — register it in place, no clone and no remote required:

   ```
   register_project { project: "proposal", path: "/abs/path/to/the/document.md" }
   ```

   `path` takes the document itself or the folder around it — naming a file registers the folder
   holding it, and the result says which. A project is always a **directory**, so check that the
   folder is the document's own: pointing at a file loose in the user's home directory would make
   the whole of it readable. If it is, register the narrower directory instead.

2. **Sync — git projects only.** `project_sync` so you check the current bibliography, not a stale
   clone. **Skip this entirely for a local project** (there is nothing to sync, and the tool will
   refuse).

3. **Find the references.** Call `list_references` with just the project:

   ```
   list_references { project: "proposal" }
   ```

   It scans every `.bib`, `.tex` and prose document and returns the entries structured — key/label,
   type, title, authors, `truncatedAuthors`, year, venue, DOI/arXiv, the file and line each sits on,
   and `raw`. Use this instead of `read_file` + regex; it also resolves `@string` venue macros, which
   hand-parsing gets wrong.

   - `sources` in the result tells you which files actually carry references. If it's empty, ask the
     user which file holds them and re-call with `path`.
   - If several files carry them (a `.bib` **and** a prose list, say), say so and ask which is
     authoritative before verifying — they may disagree, and that disagreement is itself a finding.

4. **Ask the scope: everything, or only what the draft cites?** Before doing any lookup work, ask
   whether to verify **every** entry or **only those actually cited**. Default to recommending
   **only-cited** — a `.bib` often carries far more entries than the draft uses, and each extra one is
   another (rate-limited) bibliography-service call.

   For a key-based bibliography, `check_citations` does the scoping for you (see _Scoping to cited
   entries_). For a prose reference list there are no keys, so "only-cited" isn't separable — verify
   the whole list and say so.

   **Skip** any entry already carrying a `% verified-by-claude:` comment (see below) unless the user
   asks to re-check everything.

5. **Match each entry against a bibliography service — one paper at a time, sequentially.** For each
   entry, call `search_references` with a query built from the distinctive title words plus the first
   author's surname (e.g. `deep residual learning he`), and leave `source` unset so the server tries
   DBLP, then Crossref, then OpenAlex on its own, substituting one that can't be reached. For a
   `prose` or `bibitem` entry whose `title` came back empty, build the query from `raw` — pick the
   distinctive noun phrase and a surname yourself. Keep `maxResults` small (5–8). Note which backend
   answered (`source` in the result — you need it for the report) and, if it substituted for one that
   was unreachable, `fallbackFrom`/`hint`. Classify the result (see _Classifying a match_ and, for a
   zero-hit answer or a failed call, _Handling "not found" vs. "couldn't check"_), then move to the
   next entry. **Do not fan out parallel lookups** (see _Pace bibliography-service requests_ — all
   three rate-limit hard). Process the whole list one entry at a time.

6. **Triage, don't interrogate.** Entries that match confidently need no questions — just count them.
   Only entries with a discrepancy, no match, or a service that couldn't be reached get escalated to
   the user.

7. **Resolve the doubtful ones with the user.** Go through the flagged entries (one at a time, or a
   few at a time if there are many), showing the reference as written beside the service's candidate
   record and naming the exact discrepancy. Let the user decide. **Never resolve a doubt by guessing.**

8. **Report — inline and to a file.** Give the short inline summary (how many verified cleanly, how
   many need attention with the specifics, how many weren't found by any service, how many couldn't be
   checked because a service was unreachable; if you scoped to cited entries, how many you skipped).
   **Then write the persistent report** per _The audit report_ below and surface its link. Capture
   each flagged entry's **final** status — including how the user resolved it in step 7 (accepted
   as-is, left unverified, or fixed).

9. **(Optional, opt-in) Annotate.** If — and only if — the user wants it, mark each confirmed entry
   (see _Annotating verified entries_). This is the one and only bibliography write the skill makes on
   its own initiative, and only after an explicit yes.

Do all reads/edits within the one project so the per-project mutex serializes them.

## Scoping to cited entries

When the user chooses **only-cited** (step 4) and the bibliography has cite keys, let
`check_citations` do the cross-reference instead of extracting keys by hand:

```
check_citations { project: "proposal" }
```

It reads the `\cite` family in `.tex` (`\cite`, `\citep`, `\citet`, `\autocite`, `\parencite`,
`\textcite`, `\footcite`, multi-key and optional-argument forms, skipping commented-out ones) and
pandoc's `[@key]` / `@key` in markdown, against every `.bib` and `\bibitem` list, and returns:

- **`undefinedCitations`** — cited with no entry. A real defect (an undefined-citation warning, and a
  `[?]` in the PDF). Report these separately; they are not "unverified", they are missing.
- **`uncitedEntries`** — entries nothing cites. Out of scope for verification; mention the count so
  the user knows they were skipped, not verified.
- **`duplicateKeys`** — the same key defined twice; the later definition is silently ignored by
  BibTeX, so this is worth surfacing.
- **`incompleteEntries`** — BibTeX entries missing a field their type requires (an
  `@inproceedings` with no `booktitle`, say). A formatting defect, independent of whether a
  bibliography service confirms the paper — report it alongside those findings.

Verify only the entries whose key appears in the citations. This tool is a **structural** check: it
says nothing about whether a reference is factually right. That is what the bibliography-service pass
is for.

## When the bibliography lives in a different project

A draft often cites a `.bib` that belongs somewhere else — a proposal in one folder, the group's
shared bibliography in an Overleaf project. Register both projects, then name the second one:

```
check_citations { project: "proposal", bibliographyProject: "shared-bib" }
```

`documents` resolve inside `project` and the bibliography inside `bibliographyProject`, each sandboxed
to its own — that boundary is the property worth keeping, so never try to reach another project by
writing a path that walks out of this one.

Read the result with the shared bibliography in mind:

- **`undefinedCitations`** — cited in the draft, absent from the shared `.bib`. This is the finding
  that matters. The entry has to be added **there**: `add_citation { project: "shared-bib", key: … }`
  from a `search_references` result (the namespaced key it returns, whichever service it came from),
  and it needs that project's permission, not this one's.
- **`uncitedEntries`** comes back **empty**, and that is correct rather than a miss — a shared
  bibliography is supposed to hold entries this draft does not cite. Do not report it as a finding,
  and do not go looking for the entries by hand. To audit the shared bibliography as a whole, run
  `check_citations { project: "shared-bib" }` on its own.
- **`duplicateKeys` / `incompleteEntries`** cover only the entries the draft cites, for the same
  reason. `entryCount` still tells you how large the shared `.bib` is.

Then verify each cited entry against a bibliography service as usual, reading it with
`list_references { project: "shared-bib", filter: "<surname or title words>" }` — `filter` is what
keeps this cheap: one query per reference rather than a 300-entry `.bib` in context. When the draft's
own prose reference list and the shared `.bib` disagree on a field, say which project you are quoting
for each. Do not assume the `.bib` is right; it is a _candidate_, and the service that confirms it is
the arbiter.

A prose reference list carries no cite keys, so `check_citations` has nothing to match on. In that
case, keep to the two-call comparison: `list_references { project: "proposal" }` for the draft's own
list, then look each reference up in the shared bibliography by title plus first-author surname plus
year.

## Pace bibliography-service requests

DBLP, Crossref and OpenAlex are all free public APIs and **rate-limit aggressively**. Firing many
`search_references` calls at once (or in big parallel batches) gets you `429 Too Many Requests` and
timeouts on whichever one you're hitting, which is slower overall than going steadily — you end up
waiting out cooldowns. This applies whether a given call lands on DBLP, Crossref, or OpenAlex — the
server may substitute between them per entry, but your calling discipline stays the same. Lessons
from real runs:

- **Go strictly sequential: one `search_references` per entry, awaited before the next.** Paper-by-
  paper is _more_ efficient here than asking for a batch all at once, because it never trips a
  limiter.
- **Don't burst.** Never issue lookups in parallel, and don't pre-fetch the whole list up front.
- **On a `429` or a timeout, back off briefly and retry** — a few seconds, doubling if it repeats
  (e.g. 5s → 10s → 20s). That's enough; **don't sit on multi-minute fixed timers** between every call —
  that's overcorrecting and makes a long bibliography crawl.
- For a large bibliography, tell the user this part is paced and roughly how long it'll take, so a
  steady run doesn't look stuck.

## Classifying a match

Compare on normalized text. `list_references` has already stripped the LaTeX from `bibtex` entries
(capitalization braces, `\&`, accents, `$…$`), so compare lowercased with whitespace collapsed. For
authors, compare on **surnames** (these services return "First Last"; `list_references` normalizes
BibTeX's "Last, First" to match), and check the **count** too — the reference must list every author
the service's record does, in the same order.

`truncatedAuthors: true` — BibTeX `and others`, or a literal "et al." in prose — is **always a
defect**, independent of the name comparison: the rendered citation will not name everyone. Treat it
as a **doubt** and give the user the full list from the confirming record so they can complete the
entry.

- **Confident match** — the top hit's title matches, **every** author matches (same surnames, same
  count, `truncatedAuthors` false), the year is identical, and the venue is consistent after
  abbreviation normalization. No need to bother the user; mark it verified, noting which service
  confirmed it (`source`).
- **Doubt** — the title matches but something disagrees: a different year (even ±1), a
  misspelled/missing/extra author, a truncated author list, a venue that doesn't reconcile, **or** the
  reference cites an arXiv/preprint while the service has a published version (or vice-versa — an
  `arxivId` on the entry with a conference record on the service's side is exactly this case), **or**
  several candidate records are equally plausible. Escalate to the user.
- **Not found** — the service answered (zero matching hits), so this is a real negative — see
  _Handling "not found" vs. "couldn't check"_ below for when to retry before reporting it as such. Note
  that some legitimate references (books, tech reports, standards, very new or niche work, or anything
  outside DBLP's computer-science scope) simply aren't indexed by any of the three — "not found" means
  "no service can confirm it", not "it's wrong". For a **prose** entry, rule out a parsing problem
  first: re-read `raw` and re-query before calling it not-found.
- **Couldn't check** — `search_references` itself failed rather than answering (every backend in the
  default order was unreachable, or a backend you pinned was down). This is **not a verdict about the
  reference** — see the same section below; never fold it into "unverified" or "not found".

When a field disagrees, prefer treating it as a **doubt** over silently calling it verified. The cost
of asking is a question; the cost of a false "verified" is a citation error shipped to a reviewer.

## Handling "not found" vs. "couldn't check"

With three backends, a lookup can come back empty-handed in two very different ways, and conflating
them mis-reports good references as doubtful:

- **The service answered, and found nothing.** `search_references` returned normally, with `source`
  naming the backend that actually looked and `results` empty (or none of the hits matching). This is
  a **real negative** — but also worth a second look before you write it off: DBLP indexes computer
  science only, so a zero-hit answer with `source: "dblp"` is not yet evidence for a paper outside CS.
  Retry once, pinned to `source: "crossref"` (the broadest coverage of the three), before calling it
  not found. Only once the backends you've reasonably tried each come back empty does "not found"
  stand.
- **No service could be reached.** The `search_references` call itself threw — every backend in the
  default order failed (`BackendUnavailableError`-style refusal), or a backend you pinned was down. **This is not an answer about the
  reference at all** — it is an infrastructure hiccup, and reporting it as "unverified" or "not found"
  would flag a perfectly good citation because a service was slow or down (dblp.org's anti-bot wall is
  the case this is most likely to happen for). Back off and retry (see _Pace bibliography-service
  requests_); if it still fails after retries, tell the user the lookup infrastructure was unreachable
  for this entry and leave it **unclassified** in the report — neither "verified" nor "not found".
- **The server refused before searching.** If the message names `WEB_LATEX_MCP_REFERENCE_SOURCE`
  as holding a value that is not a backend, this is a configuration problem, not an outage:
  retrying will not help, and backing off once per entry would burn the whole retry ladder on
  every reference in the bibliography. Either pass `source: "crossref"` for the rest of the run
  (a per-call pin still works) or stop and tell the user to fix or unset that variable.

Only pin `source` deliberately: for a retry after a genuine zero-hit answer, or when the user asks for
one backend by name. The default, unpinned call is what lets the DBLP → Crossref → OpenAlex fallback
run at all — pinning it on every call would throw that safety net away, which is why the skill's
default procedure never does.

## Venue abbreviations

The same venue appears in many forms across a bibliography and these services. Treat these as
equivalent (a service usually returns the short form on the left; the document may use any of them):

- **CVPR** = IEEE/CVF Conference on Computer Vision and Pattern Recognition
- **ICCV** = International Conference on Computer Vision · **ECCV** = European Conference on Computer Vision
- **NeurIPS** / **NIPS** = Advances in Neural Information Processing Systems (NIPS was renamed NeurIPS in 2018)
- **ICML** = International Conference on Machine Learning · **ICLR** = International Conference on Learning Representations
- **AAAI** = AAAI Conference on Artificial Intelligence · **IJCAI** = International Joint Conference on AI
- **ACL** / **EMNLP** / **NAACL** = Assoc. for Computational Linguistics venues
- **KDD** = ACM SIGKDD · **SIGIR**, **WWW**, **SIGGRAPH**, **MICCAI**, **TPAMI** (journal), **JMLR** (journal)

This list is not exhaustive — for venues not on it, expand the acronym yourself and compare on
meaning, not exact string. If you can't tell whether two venue strings are the same conference, that's
a **doubt**: ask.

## Asking the user

Use the **AskUserQuestion** tool for each doubtful or not-found entry (batch a few when there are
many). Make the discrepancy obvious. For each, show:

- the **reference as it stands**: cite key or number, title, authors, venue, year — and for a prose
  entry, the `raw` line, since that is what the user will recognize;
- the **candidate record(s)**, from whichever service answered: title, authors, venue, year, the
  record key, and which service it's from (`source`) — or "no match found on <the service(s) tried>";
- a one-line statement of **what differs** (e.g. "the draft says 2019, DBLP says 2020"; "the reference
  cites the arXiv preprint; Crossref has the CVPR 2021 version"; "author _J. Smith_ not on the
  record"; "the author list is truncated with `and others` — OpenAlex lists all 7, paste them in").

Offer concrete choices, e.g. _Accept as-is (mark verified)_ · _Leave unverified / flag it_ · _Update
the entry from \<service\> (I'll need your go-ahead to edit it)_. Only act on what the user picks. If
they ask you to fix a `.bib` entry, that's a `confirmBibEdit: true` edit — make exactly the change
they approved and nothing more; the cleanest fix is usually to remove the stale entry and re-add it
with `add_citation` from the matching record's key, so the new text again originates from the service
rather than from you (`add_citation` returns the file and line it landed on, so you can confirm
without re-reading).

A **couldn't-check** entry (see _Handling "not found" vs. "couldn't check"_) has nothing to ask the
user about the reference itself — don't route it through AskUserQuestion as if it were a discrepancy.
Just say plainly which entries a service failure left unchecked, and offer to retry.

For a **prose** reference list there is no `add_citation` path — the entry has to be rewritten in the
document's own style. Show the user the exact replacement text and get their yes before writing it.

## Annotating verified entries (opt-in — needs permission)

Once entries are confirmed, the user may want them marked so a later run can skip them. Only with
their explicit yes:

**In a `.bib`** — add a single comment line **immediately above** the entry, naming the namespaced
record key you matched (so it also names which service confirmed it):

```bibtex
% verified-by-claude: dblp:conf/cvpr/HeZRS16 on 2026-06-24
@inproceedings{he2016deep,
  ...
}
```

- A `%` line in a `.bib` is a **comment** — BibTeX/biber ignore it, so it **cannot change the compiled
  bibliography or PDF**. (No compile is needed to prove that, though you may `compile` if the user
  wants reassurance.)
- Use `edit_file` with `confirmBibEdit: true`, matching the exact `@type{key,` header line so the
  insertion is surgical.

**In a `.tex` `thebibliography`** — a `%` comment line above the `\bibitem`, same idea; no
`confirmBibEdit` needed, but the same permission is.

**In a prose document** — there is no comment syntax that stays invisible in the rendered output.
Do **not** annotate a markdown reference list: leave the document alone and let the audit report carry
the record. Say so rather than inventing a marker.

Common to all: include the namespaced record key you matched (e.g. `dblp:conf/cvpr/HeZRS16`,
`crossref:10.1109/CVPR.2016.90`, `openalex:W2194775991`) and today's date, so the annotation is
auditable and names which service confirmed the entry. It is **idempotent** — an entry that already
has a `verified-by-claude:` line is left alone, which is what makes re-runs cheap. Only annotate
**confident matches** (or entries the user explicitly accepted). Never annotate something still in
doubt, and never annotate a **couldn't-check** entry — it was never confirmed by anything.

## The audit report

Every run writes a persistent report and surfaces it — so the findings outlive the chat and the user
can open the full table instead of scrolling back. It is named `citation-report.local.md`. **Where it
goes depends on the project's mode** (step 1):

### Git project — the clone root, git-excluded

The report lands at the **root of the clone** (the `path` from step 1). When clones are
workspace-local this is under `.web_latex_mcp/<id>/`, inside the IDE workspace; when the clone lives
elsewhere (the home-dir default) it's at that clone root all the same.

**Make it git-excluded _before_ writing it**, so it can never be staged:

```bash
DIR="<clone path from list_projects>"
NOTE="citation-report.local.md"
mkdir -p "$DIR/.git/info"
grep -qxF "$NOTE" "$DIR/.git/info/exclude" 2>/dev/null || printf '%s\n' "$NOTE" >> "$DIR/.git/info/exclude"
git -C "$DIR" check-ignore "$NOTE"   # must echo the filename → confirms it's ignored
```

Then `write_file` the report (path `citation-report.local.md`). Because it's git-excluded,
`write_file`'s returned `diff` is empty — expected, not an error. Confirm via `status` that it stays
out of the untracked list. It survives `discard`, and `commit` can't pick it up.

### Local project — ask first, because the directory is the user's

A local project is a directory the user already had, very often inside a repo of their own that has
nothing to do with this server. Dropping a file there is a visible change to **their** working tree,
so **ask before writing it**, and offer both:

- **Write it to the project directory** (`write_file`, path `citation-report.local.md`). If the
  directory is inside a git repo and you have a shell, keep it out of that repo the same way — this
  edits only `.git/info/exclude`, which is local to their checkout and never committed:

  ```bash
  DIR="<path from list_projects>"
  NOTE="citation-report.local.md"
  git -C "$DIR" rev-parse --show-toplevel   # nothing? then it is not in a repo — no exclude needed
  printf '%s\n' "$NOTE" >> "$(git -C "$DIR" rev-parse --git-dir)/info/exclude"
  ```

  If you have no shell (Claude Desktop, Cursor), say plainly that the file will show up as untracked
  in their repo and that deleting it is safe.

- **Skip the file** and give the findings inline only. Perfectly valid — take it if they'd rather not
  have anything written into their directory.

Note that `status`/`diff` refuse on a local project, so you cannot confirm the file's git state
through the server. Don't claim it's excluded unless the `git` command above actually succeeded.

### Surfacing it

- When the file is **inside the IDE/Bash working directory**, present a **clickable
  workspace-relative link**, e.g.
  `[.web_latex_mcp/<id>/citation-report.local.md](.web_latex_mcp/<id>/citation-report.local.md)`.
- Otherwise give the **absolute path** and note it lives outside the workspace, so it can't be a
  clickable relative link.

### Contents

A header marker, then the totals and the per-entry findings (derive every row from the comparisons
you made against whichever service answered — the same evidence you showed inline). Record **which
service confirmed or was checked against** for every entry — a Crossref confirmation and a DBLP one
are different evidence, and the reader should be able to tell them apart:

```markdown
<!--
Local citation-audit report by Claude (the `verify-citations` skill).
Local only, never pushed. Safe to edit or delete.
Generated: 2026-07-16 · Source: ref.bib (bibtex) · Scope: only-cited
-->

# Citation audit — <paper title or project id>

**Totals:** N checked · N verified · N need attention · N not found · N couldn't be checked
(service unreachable) · N skipped (uncited)

## Cited but not defined

- `someref2025` — cited at main.tex:88 — no entry in the bibliography (renders as [?])

## Needs attention

| reference  | field   | as written             | confirmed record | source   | resolution      |
| ---------- | ------- | ---------------------- | ---------------- | -------- | --------------- |
| he2016deep | year    | 2015                   | 2016             | dblp     | user fixed      |
| vaswani17  | authors | truncated `and others` | 8 authors listed | crossref | left unverified |

## Not found

- `key` — title — checked against dblp, crossref (books, tech reports, standards, or very new /
  non-CS work may simply be unindexed by any of the three)

## Could not check (service unreachable)

- `key` — title — dblp and crossref were unreachable when checked; this is not a finding about the
  reference, just an unresolved lookup — retry the audit later to fill it in

## Verified

- `key` — matched `dblp:conf/cvpr/HeZRS16` (list them, or just the count and a source breakdown —
  the user's preference)
```

Drop the "Cited but not defined" section when the bibliography has no cite keys (a prose list), and
identify prose entries by their number and title rather than a key. Drop the "Could not check" section
entirely when every entry got an actual answer from some service — don't leave an empty heading.

On a re-run, overwrite the report with the current findings, preserving any notes the user added by
hand.

## After you finish

Report concisely: total references checked, how many verified (and against which service), the
specific ones that need the user's attention and why, any that no service could confirm, and any that
couldn't be checked because a service was unreachable (distinct from "not found" — don't blur the
two). **Surface the
`citation-report.local.md` link** (clickable when the file is inside the workspace) and note it's
local-only — never pushed. If you annotated, say which file(s) you touched. For a **git** project,
remind the user that — per CLAUDE.md — `commit`/`push` happen only when they ask, so nothing has left
their machine, and point them at the `diff`. For a **local** project there is no commit or push at
all; say instead exactly which files under their directory you changed, so they can review it in
their own git.

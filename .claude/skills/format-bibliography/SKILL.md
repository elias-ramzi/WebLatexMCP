---
name: format-bibliography
description: Normalize and reformat a project's .bib bibliography — find and merge duplicate entries, rename cite keys to a consistent firstauthorYEARtag scheme (e.g. chambon2024pointbev), harmonize venue names (CVPR ↔ "Computer Vision and Pattern Recognition"), and apply one consistent field policy (strip or add url/doi/pages, etc.). Use when the user asks to "format", "reformat", "normalize", "tidy", "clean up", "harmonize", or "deduplicate" the bibliography / .bib / bibtex / citation keys. This skill EDITS the .bib (and the \cite keys in the .tex): it is permission-gated and uses compile as a guardrail. Operates on projects served by the web-latex-mcp MCP server.
---

# Normalize and reformat a project's `.bib` bibliography

Bring a bibliography into a single, consistent house style through the `web-latex-mcp` MCP tools. Four passes,
each one the collaborator asked for:

1. **Deduplicate** — find entries that are the same paper (often an arXiv preprint and its published
   version) and merge them down to one.
2. **Consistent cite keys** — rename to `firstauthorYEARtag` (e.g. `chambon2024pointbev`), and **update
   every `\cite{…}` in the draft to match**.
3. **Harmonize venues** — make every proceedings/journal name use one style: short (`CVPR`) _or_ long
   (`Computer Vision and Pattern Recognition`), the user's choice — not a mix.
4. **One field policy** — either **strip** or **systematically add** the optional fields (`url`, `doi`,
   `pages`, …), consistently across every entry.

Unlike [`verify-citations`](../verify-citations/SKILL.md) (read-only), **this skill rewrites the `.bib`
and the `.tex`.** Treat it accordingly.

## This skill writes — permission first, compile as the guardrail

- **Get explicit approval before any write.** Agree the policy with the user, _preview_ the changes
  (renames, merges, field edits), and only then apply. Never reformat a bibliography unprompted.
- **`.bib` is protected.** Every `.bib` write goes through `edit_file`/`write_file` with
  `confirmBibEdit: true` — set it only after the user has approved the change.
- **The compile is the safety net.** The project must compile cleanly _before_ you start and _after_ you
  finish, **with no `Citation … undefined` warnings** — that warning is the tell-tale of a key rename that
  didn't reach the `.tex`. Reformatting deliberately changes how the bibliography _renders_ (e.g. `CVPR`
  vs the full name); what must **not** change is the _set of papers_ cited or the project's ability to
  compile.
- **Prefer DBLP as the source of truth.** When a value needs to be added or corrected (a venue's canonical
  name, a missing `doi`/`pages`, an author list), pull it from DBLP via `search_references` rather than
  inventing it — same principle as the rest of this server: bibliographic data comes from DBLP, not the
  model. Mechanical transforms (renaming a key, deleting a field, fixing whitespace) you may do directly.
- **Idempotent.** Skip entries already carrying a `% formatted-by-claude:` comment (see the marker
  section) unless the user asks to redo them.
- **Commit/push only when asked** — per CLAUDE.md, stop at the diff.

## Workflow

Run in order. Stop and report if a step fails.

1. **Pick the project.** If the user didn't name one, `list_projects` and ask which.
2. **Sync.** `project_sync` so you reformat the current sources.
3. **Baseline compile.** `compile` and record success + the warning list. **If it does not compile cleanly
   to begin with, stop** and tell the user — you won't be able to tell your changes apart from a
   pre-existing break, and you can't trust the "no undefined citations" check.
4. **Read everything.** `list_files` for `bib` and `tex`; `read_file` each. Parse the `.bib` into entries
   (type, cite key, all fields) and scan the `.tex` for every citation command and key (see _Renaming
   keys_ for the command list). **Skip** entries already marked `% formatted-by-claude:`.
5. **Agree the policy with the user.** Use **AskUserQuestion** to settle, in one go:
   - **Venue style** — short acronyms or full names?
   - **Optional fields** — for each of `url`, `doi`, `pages` (and `isbn`/`publisher`/`address`/`eprint`):
     strip them, add-where-missing (from DBLP), or leave as-is?
   - **Cite-key scheme** — confirm `firstauthorYEARtag` (the default below) or take their variant.
   - **Duplicates** — confirm the merge strategy (which version wins; see _Detecting duplicates_).
6. **Compute and preview.** Produce the full change set _without writing yet_: the key-rename map
   (`old → new`), the merges (which keys collapse into which), and the per-entry field changes. Show it to
   the user and get a clear go-ahead. For a big bibliography, summarize and show a representative sample.
7. **Apply.** With approval: edit the `.bib` entries (`confirmBibEdit: true`), and **propagate every key
   rename/merge into the `.tex`** in the same pass (see _Renaming keys_). Re-fetch added field values from
   DBLP. Do all edits within the one project so the per-project mutex serializes them.
8. **Recompile and verify.** `compile` again. It must succeed with **zero `Citation … undefined`**
   warnings and the same count of distinct papers cited as the baseline. If anything broke, fix it; if you
   can't, `discard` and report.
9. **Mark.** Add a `% formatted-by-claude:` comment to each entry you reformatted (see the marker section).
10. **Review.** Show the `diff` (both `.bib` and `.tex`). Do **not** `commit`/`push` unless asked.

## Citation key scheme: `firstauthorYEARtag`

Lowercase ASCII, letters and digits only. Three parts, concatenated with no separators:

- **firstauthor** — the **family name** of the first author, lowercased, diacritics stripped (`é`→`e`,
  `ü`→`u`), spaces/hyphens/apostrophes removed. For a multi-token surname keep the principal name token
  (e.g. `van den Oord` → `oord`, `Le Cun` → `lecun`).
- **YEAR** — the 4-digit publication `year`.
- **tag** — the paper's **acronym / method name** if it has one, else the **first meaningful word of the
  title**:
  - Many titles are `Acronym: full title` — take the part **before the colon** (`PointBeV: …` → `pointbev`).
  - Otherwise look for a distinctive mixed-case or all-caps token in the title (`ResNet`, `BERT`).
  - No acronym → the **first word of the title**, skipping a leading article (`A`/`An`/`The`). Lowercase,
    letters/digits only.

Example: _Chambon et al., 2024, "PointBeV: A Sparse Approach…"_ → `chambon2024pointbev`.

**Collisions:** if two distinct papers reduce to the same key, append `a`, `b`, `c`, … to disambiguate
(`smith2020deep`, `smith2020deepb`). Two entries that collide **and are the same paper** are duplicates —
merge them instead (next section).

## Detecting duplicates

Two entries are the same paper when any of these hold (normalize first — strip `{}`, LaTeX, case,
whitespace):

- identical `doi`, or
- identical normalized title **and** same first-author surname (year may differ by the preprint/published
  gap), or
- one is an arXiv `@misc`/preprint and the other its published `@inproceedings`/`@article` of the same
  title.

To merge: **keep the published version over the preprint** (confirm with the user when unsure), repoint
every `\cite` of the dropped key to the kept key, and delete the dropped entry. Note the merge in your
report. When both carry useful fields, prefer the kept entry's values but fill gaps from the other (or
from DBLP).

## Harmonizing venues

Apply the user's chosen style (short or long) to every `booktitle`/`journal`. Treat these as the same
venue in either direction — DBLP's venue field is the canonical short form; derive the long form from it:

- **CVPR** = (Proceedings of the IEEE/CVF Conference on) Computer Vision and Pattern Recognition
- **ICCV** = International Conference on Computer Vision · **ECCV** = European Conference on Computer Vision
- **NeurIPS** / **NIPS** = Advances in Neural Information Processing Systems (renamed NeurIPS in 2018)
- **ICML** = International Conference on Machine Learning · **ICLR** = International Conference on Learning Representations
- **AAAI**, **IJCAI**, **ACL**, **EMNLP**, **NAACL**, **KDD**, **SIGIR**, **WWW**, **SIGGRAPH**, **MICCAI**; journals **TPAMI**, **IJCV**, **JMLR**

The list isn't exhaustive — for anything not on it, confirm the canonical name against DBLP rather than
guessing. Don't change which venue an entry claims; only its **spelling/style**. (If an entry's venue
looks _wrong_, that's a `verify-citations` job, not this one — flag it, don't silently "fix" it here.)

## Field policy (`url`, `doi`, `pages`, …)

Apply one rule per field across the whole bibliography, per the user's choice in step 5:

- **Strip** — remove the field from every entry (mechanical; common for `url`/`note`/`eprint` when a venue
  forbids them).
- **Add where missing** — fill the field from the **DBLP record** for that paper (so `doi`/`pages`/`url`
  come from the API, not the model). If DBLP doesn't have it, leave it absent and note which entries
  couldn't be completed.
- **Leave as-is** — don't touch it.

Keep this surgical: change only the fields the policy covers, plus the cite key. Don't rewrite an entry
wholesale unless the user asked you to re-fetch it from DBLP.

## Renaming keys without breaking `\cite`

This is the dangerous part: a renamed key that isn't updated everywhere becomes an undefined citation.

- Build the complete `old → new` map (including merges, where several olds map to one new).
- Replace keys in **every** citation command across **all** `.tex` files: `\cite`, `\citep`, `\citet`,
  `\citeauthor`, `\citeyear`, `\autocite`, `\parencite`, `\textcite`, `\footcite`, `\Cite…`, `\nocite`,
  and friends — including **comma-separated lists** (`\citep{a,b,c}`: rename each key independently) and
  ignoring the optional `[...]` arguments. Also update any `crossref = {oldkey}` inside the `.bib`.
- Rename **one key at a time, both sides together** (its `.bib` entry and all its `.tex` uses), so the
  cite graph is never half-renamed. Watch for accidental substring hits — match whole keys, not
  fragments.
- The **post-compile check is the proof**: zero `Citation … undefined` warnings, and no orphaned entries.
  If the user only wants the `.bib` touched and not the `.tex`, then **do not rename keys** — tell them
  renames require editing the draft.

## The `% formatted-by-claude` marker

After reformatting an entry, add one comment line **immediately above** it so a later run skips it:

```bibtex
% formatted-by-claude: key chambon2024pointbev on 2026-06-29
@inproceedings{chambon2024pointbev,
  ...
}
```

- A `%` line in a `.bib` is a comment — BibTeX/biber ignore it, so the marker never affects the output.
- Record the final cite key and today's date.
- It's a `.bib` write like any other: `edit_file` with `confirmBibEdit: true`.
- This marker is independent of `verify-citations`' `% verified-by-claude:` line; an entry can carry both,
  and renaming its cite key doesn't invalidate the verified marker (that one records the DBLP key).
- Step 4 skips entries that already have this marker — that's what makes re-runs cheap and stops a second
  invocation from re-formatting the same entries.

## After you finish

Report concisely: how many entries were deduplicated (and into which keys), how many keys were renamed
(with the corresponding `.tex` updates), the venue style and field policy applied, and any entries DBLP
couldn't complete. Confirm it still compiles with no undefined citations, and point the user at the `diff`
for both the `.bib` and the `.tex`. Remind them nothing is committed or pushed until they ask.

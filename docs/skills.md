# Skills

The repo bundles task-specific skills that drive the [tools](tools.md) — each stops at the diff, so
nothing is committed or pushed unless you ask. How you install them, and how you invoke them, depends on
the client: see [Installing](#installing) and [Two ways a skill runs](#two-ways-a-skill-runs).

| Skill                                                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                    | Mutates                  | Invoke                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------- |
| [`format-latex-project`](../.claude/skills/format-latex-project/SKILL.md) | Splits the monolithic main file into per-section `\input{sections/…}` files and reflows body prose to one sentence per line. Cosmetic-only — compiles before/after, the PDF must be unchanged.                                                                                                                                                                                                                                  | `.tex`                   | `/format-latex-project` |
| [`arxiv-clean-project`](../.claude/skills/arxiv-clean-project/SKILL.md)   | Runs [arxiv-latex-cleaner](https://github.com/google-research/arxiv-latex-cleaner) to strip `%` comments and delete draft macros (`\todo`, `\note`, review environments), optionally shrinking figures for arXiv's 50MB limit. Produces a separate `…_arXiv` copy or applies the cleaning in place. **Intentionally changes the PDF**; `.bib` is kept via `--keep_bib`.                                                         | `.tex` (in-place mode)   | `/arxiv-clean-project`  |
| [`verify-citations`](../.claude/skills/verify-citations/SKILL.md)         | Audits a document's references (title, authors, venue, year) against DBLP, flags discrepancies for you, writes a local audit report, and optionally marks confirmed entries. Reads a `.bib`, a LaTeX `thebibliography`, or a markdown reference list, on a git project or a local folder. **Read-only for the bibliography** unless you approve a change.                                                                       | local report; opt-in bib | `/verify-citations`     |
| [`format-bibliography`](../.claude/skills/format-bibliography/SKILL.md)   | Deduplicates entries, normalizes cite keys to one scheme, harmonizes venue names, and enforces a single field policy — propagating key renames into your `\cite`s. Permission-gated; compile is the guardrail.                                                                                                                                                                                                                  | `.bib` + `.tex`          | `/format-bibliography`  |
| [`summarize-paper`](../.claude/skills/summarize-paper/SKILL.md)           | Writes/updates a small local markdown summary of the paper (section + file map, contributions, results) so future sessions get oriented fast. Kept out of git via the clone's `.git/info/exclude` — local-only, never pushed.                                                                                                                                                                                                   | local note only          | `/summarize-paper`      |
| [`session-feedback`](../.claude/skills/session-feedback/SKILL.md)         | Ends a session by reviewing what actually happened and reporting on **the server itself** — what broke, what cost too many calls, what capability was missing, what the docs got wrong. Emits one ready-to-file issue body per finding, field for field against the repo's issue forms, with a measured environment (version, OS, client, model, install method, toolchain) and no manuscript content. Filed only when you ask. | nothing                  | `/session-feedback`     |

## Two ways a skill runs

The same `SKILL.md` reaches a client through one of two mechanisms, and they differ in **who decides to
run it** — worth knowing, because it changes how you ask.

**As a skill — model-invoked.** The client reads the skill's `description` and reaches for it on its own
when your request matches: "check my bibliography" pulls in `verify-citations` without you naming it.
This is what Claude Code does with `.claude/skills`, and what an uploaded skill does in Claude Desktop
and claude.ai.

**As an [MCP prompt](https://modelcontextprotocol.io/specification/server/prompts) — user-invoked.** The
server registers every bundled skill as a prompt under the same name, carrying the same instructions, so
clients that don't read `.claude/skills` can still run them. You pick it from the client's prompt menu
(the `+` in Claude Desktop's composer; `/web-latex-mcp:…` in Claude Code) — the model will **not** reach
for it on its own. Each prompt takes an optional `project` argument, so you can scope the run up front
instead of being asked. Because prompts are flat text, a skill that grows bundled scripts or reference
files would only be partially conveyed — the `SKILL.md` body is what ships. All six current skills are
self-contained, so nothing is lost today.

**As the [`list_skills`](tools.md) tool — model-invoked, no install.** The server also exposes its
bundled skills as a tool: `list_skills` returns the catalogue (name + description), and
`list_skills({ skill: "verify-citations", project: "thesis" })` returns that procedure in full, ready to
follow. This is the gap the other two leave: prompts wait for you to pick one, and the model-invoked
route above needs the skills installed into the client. With the tool, an agent that connects to this
server can find the right procedure itself — "check my bibliography" works without the skills being
installed anywhere.

The three coexist: prompts and `list_skills` always work because they travel with the server, and
installing the skills properly on top adds the client's own model-invoked trigger.

## Installing

### Claude Code — the plugin

Installs the server _and_ the skills, in every session, from any directory:

```bash
/plugin marketplace add elias-ramzi/WebLatexMCP
/plugin install web-latex-mcp@web-latex-tools
```

Launching Claude Code from a clone of this repo works too — `.claude/skills` is picked up from the
working directory. Either way you get `/verify-citations` and friends, model-invoked.

### Any MCP client — nothing to install

The prompts come with the server. Once `web-latex-mcp` is connected, the six skills appear in the
client's prompt menu, at the version the server shipped with, and the model can reach the same
procedures through `list_skills`. Nothing to upload, nothing to keep in sync.

### Claude Desktop and claude.ai — upload the skills

To get the **model-invoked** behavior in Claude Desktop (so "verify my citations" just works), upload the
skills to your Claude account. They are per-account, and sync to Desktop, claude.ai, and the Cowork tab.

1. Zip each skill folder from a clone of this repo:

   ```bash
   cd .claude/skills
   for s in */; do zip -r "${s%/}.zip" "$s"; done
   ```

2. In Claude, open **Customize → Skills**, then **+ → Create skill**, and upload one `.zip` per skill.

Requires a Pro, Max, Team, or Enterprise plan with **code execution enabled** — skills are gated on it,
including instruction-only ones like these. On Team and Enterprise you can share an uploaded skill with
your organization so colleagues don't each upload it.

An uploaded skill is a **snapshot**: editing a `SKILL.md` here (or upgrading the server) does not update
it, so re-upload after a change. The prompts have no such drift, which is why both routes are worth
having.

## Serving your own skills

Set `WEB_LATEX_MCP_SKILLS_DIR` to expose a different directory as prompts — one subdirectory per skill,
each with a `SKILL.md` whose frontmatter carries a `name` and a `description`. The default is the bundled
`.claude/skills`.

## `format-latex-project` — reformat an existing project

Cleans up an existing project in three cosmetic-only passes: it splits the monolithic main file into
per-section `\input{sections/…}` files, moves every figure and table into its own
`\input{figures/…}`/`\input{tables/…}` file, and rewrites body paragraphs to **one sentence per line** (the
convention from [`writing-guide.md`](writing-guide.md), which keeps diffs small and edits surgical). It
compiles before and after as a guardrail — the PDF must be unchanged — and stops at the diff so you review
before any `commit`/`push`. Ask Claude to "format my Overleaf project".

## `arxiv-clean-project` — prepare a project for arXiv

Runs [arxiv-latex-cleaner](https://github.com/google-research/arxiv-latex-cleaner) over the project to
produce submission-ready LaTeX: it **strips every `%` comment** and **deletes draft macros and
environments** you name (`\todo{…}`, `\note{…}`, review commands, `comment`-style blocks), and can
optionally **shrink oversized figures** (resize images, PNG→JPG, compress PDFs) to fit arXiv's 50MB limit.
Unlike `format-latex-project`, this one **intentionally changes the compiled PDF** — removing todos and
notes removes content — so compile is only a "still builds cleanly" guardrail, not a "PDF unchanged" one.
Before deleting, it detects which draft macros the project actually uses and **confirms the list with you**.
`.bib` files are preserved via `--keep_bib`.

It asks each run which of two modes you want: a **separate `…_arXiv` copy** (plus an optional `.zip`),
leaving the live project untouched — the tool's native, non-destructive behavior — or **applied in place**,
reconciling the cleaned files back through the MCP tools, compiling, and stopping at the diff so you review
before any `commit`/`push`. In-place mode is destructive (it strips your live project's comments), so the
skill flags that first. The cleaner is a Python CLI installed on demand (`pipx`/`pip`). Ask Claude to
"clean my project for arXiv".

## `verify-citations` — audit citations against DBLP

**Audits the references a document actually carries** against [DBLP](https://dblp.org). For each entry it
compares the **title**, **authors**, **venue** (reconciling abbreviations like CVPR / NeurIPS / ICLR with
their full names), and **publication year** to the canonical DBLP record via `search_references`. Confident
matches are tallied silently; anything doubtful — a wrong year, a misspelled or missing author, an author
list truncated with `and others`, a preprint cited where a published version exists, or an entry DBLP can't
find — is brought back to **you** with the reference shown beside the DBLP record, so you decide what to do.

**It does not need a `.bib`, and it does not need a remote.** Via
[`list_references`](tools.md#references-in-any-format) it reads a BibTeX `.bib`, a LaTeX
`thebibliography`, or a reference list written as prose in a markdown or plain-text draft — and it runs
the same way on a [local project](tools.md#local-in-place-projects) that is just a folder on your machine,
skipping the git steps rather than failing on them. If your document isn't registered yet, it registers the
folder in place. When the bibliography has cite keys it also runs
[`check_citations`](tools.md#references-in-any-format), so keys you cite with no entry come back as their
own finding rather than as "unverified".

It is **read-only by default and never edits the bibliography without your explicit say-so** (for a `.bib`,
also behind the [`.bib` protection](tools.md#citations-via-dblp)); optionally, on entries you confirm, it
adds a `% verified-by-claude` comment (ignored by BibTeX, so the PDF is unchanged) that later runs skip —
never in a markdown draft, where no comment stays invisible. Every run also writes a **local audit report**
(`citation-report.local.md` — git-excluded at the clone root for a git project, and for a local project
only after asking you, since that folder is yours) and surfaces a link to it, so the findings outlive the
chat. Ask Claude to "check my citations".

## `format-bibliography` — normalize the bibliography

Brings a `.bib` into a single house style: it **deduplicates** entries (e.g. an arXiv preprint and its
published version), **renames cite keys** to a consistent `firstauthorYEARtag` scheme
(`chambon2024pointbev`), **harmonizes venue names** (pick short `CVPR` _or_ long "Computer Vision and
Pattern Recognition", not a mix), and applies **one field policy** — strip or systematically add `url` /
`doi` / `pages` (added values are pulled from DBLP, not invented). Unlike `verify-citations`, this one
**edits** the `.bib`, so it is permission-gated: it agrees a policy with you, previews the changes, and
writes only on your go-ahead. Renaming a cite key would break every `\cite{…}`, so the skill **propagates
renames into the `.tex` in the same pass** and uses **compile (no `Citation … undefined` warnings) as its
guardrail**. Reformatted entries get a `% formatted-by-claude` marker so a later run skips them. Ask Claude
to "tidy up my bibliography".

## `summarize-paper` — local cheat-sheet for future sessions

Writes a compact markdown summary of the paper — a one-paragraph thesis, the contributions, a **section
map and file map** (which `\label`/section lives in which `.tex`), key terms, results, and open threads —
so a new session can get oriented in seconds instead of re-reading every source file. On later runs it
**updates** the note in place, preserving any notes you added by hand and refreshing what changed. It reads
the paper through the MCP tools but writes only the one local note (never the `.tex` or `.bib`).

The note (`paper-summary.local.md` by default) lives at the root of the project clone but is **kept out of
git via the clone's `.git/info/exclude`** — so it is never staged by `commit` (which uses `git add -A`),
never shows up in `status`/`diff`, never pushed to Overleaf/GitHub, and survives `discard`. Using the
local exclude rather than a committed `.gitignore` keeps it purely local — no change is ever destined for
the remote. Ask Claude to "summarize the paper" or "update the paper summary"; read the note first at the
start of a session to save the re-reading cost.

## `session-feedback` — report back on the server itself

The odd one out: every other skill works on your document, this one works on **WebLatexMCP**. Run it at
the end of a session and it walks back over the tool calls that actually ran — the ones that errored, the
ones that had to be retried a second way, the fallback to a raw `git`/`latexmk` command, the guard that
fired, the moment you had to re-explain something — and turns them into a report a maintainer can act on.

Each finding is classified (`bug`, `friction`, `gap`, `docs`, `skill`), rated **blocked** / **slowed** /
**cosmetic**, given a frequency, backed by what actually happened rather than by speculation, and checked
against the existing issues (via `gh`, best-effort) so a known problem is marked rather than re-filed. It
keeps the five to eight strongest findings and says what it dropped.

**The output is shaped for the issue tracker**, not for reading: one block per finding whose headings
match [`bug_report.yml`](../.github/ISSUE_TEMPLATE/bug_report.yml) or
[`feature_request.yml`](../.github/ISSUE_TEMPLATE/feature_request.yml) field for field, so pasting is the
whole workflow. The environment block is **measured** — `server_info` for the version (and `npm view` for
whether that is the latest), `uname` for OS/arch/WSL, `node --version`, `doctor` for the TeX toolchain,
`list_projects` for git-vs-local and the remote host. The three facts a session cannot read about itself
— which client, which model, how the server was installed — are asked for once, and left as
`<unknown — please fill in>` if unanswered, because a guessed version sends the maintainer to the wrong
commit. What does not belong in an issue (what went well, what was cut) stays in the chat summary.

It is safe to run on a session that touched sensitive work: it mutates nothing (no `write_file`, no
`commit`, no `push`), and it strips credentials, private paths, and the paper's own content — title,
abstract, results, co-authors — before printing, dropping any finding that cannot be described without
them. Saving the report to a file and opening a GitHub issue are separate, explicit yeses; the report is
never written inside a project clone, where a later `commit` would push it to your co-authors. A clean
session is expected to produce a two-line "nothing to report".

See [Feedback from a session](../CONTRIBUTING.md#feedback-from-a-session) for how it fits into
contributing.

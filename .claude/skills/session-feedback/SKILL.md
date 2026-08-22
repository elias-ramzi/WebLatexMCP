---
name: session-feedback
description: Close a working session by turning what actually happened into a feedback report for WebLatexMCP itself — what broke, what was clumsy, what is missing, what the docs did not say — ranked by impact and emitted as ready-to-file GitHub issue bodies that match the repo's issue forms field for field, stamped with a measured environment (server version, OS, client, model, install method, toolchain) and scrubbed of anything private. Use at the end of a session, or when the user asks to "give feedback", "write a retrospective", "what should I report", "how did this session go", or "file an issue about the MCP server". Reports on the *server and its skills*, never on the paper: it changes no file in the project, commits nothing, and pushes nothing.
---

# End a session with a feedback report for the server

This skill is the one that looks **at the tools, not at the paper**. At the end of a session spent
working through `web-latex-mcp`, review what actually happened and write up what a maintainer could act
on: the calls that failed, the detours that worked but should not have been needed, the capability that
was missing, the documented behavior that turned out to be wrong.

The output is not an essay. It is **one ready-to-file issue body per finding**, laid out to match the
repo's issue forms field for field, so the user copies a block and pastes it into
<https://github.com/elias-ramzi/WebLatexMCP/issues/new/choose> without editing anything — or lets `gh`
file it. Anything that does not belong in an issue (what went well, what you cut) goes in the short chat
summary instead, never in the issue body.

Four rules hold the whole thing up. Break any one and the report is worse than nothing:

1. **Only what happened.** Every finding points at a real moment in this session — a tool call, its
   arguments, the error it returned, the retry that followed. No plausible-sounding problems, no
   speculation about code you did not run.
2. **Measure the environment, never guess it.** A wrong version number sends the maintainer to the wrong
   commit; `<unknown — please fill in>` costs them one question. See _The environment block_.
3. **"Nothing to report" is a valid result.** A smooth session should produce a two-line report saying
   so. Padding the sections with weak findings is how a feedback channel gets ignored.
4. **Scrub before it leaves the machine.** See _Never in the report_.

No project id is needed to run this — if the prompt supplied one, it only tells you which project's
session to look at.

## Workflow

1. **Measure the environment** — the block every finding carries. Do this first; it is the part with
   facts in it. See _The environment block_ for each fact, how to get it, and what to do when you can't.
2. **Reconstruct the session.** Walk the conversation from the start and list, in order, the tool calls
   made and how each ended. Pay attention to the shapes that mark friction:
   - a call that returned an error, and what the next call was;
   - the same tool called repeatedly against the same file or project;
   - a fallback to a raw shell command (`git`, `sed`, `latexmk`) because a tool could not do it;
   - a guard that fired (`.bib` protection, external-change refusal, `requireGitProject`, ff-only pull,
     push-refused-when-behind) — was it right to fire, and did its message explain the way forward?
   - a point where the user had to correct, re-explain, or repeat themselves — that is usually a tool
     description or a doc failing, not a user failing.
3. **Classify each candidate finding** into exactly one bucket. The bucket picks the issue form:
   - **`bug`** — the server did the wrong thing: wrong output, a crash, a guard that fired when it
     should not have (or stayed silent when it should have fired). → **Bug report** form.
   - **`friction`** — it worked, but cost too much: too many round-trips, an unclear error, a payload
     that had to be re-read a second way, a workaround. → **Feature request** form (the problem is the
     cost; the proposal is what would remove it).
   - **`gap`** — the capability simply is not there. This is where new tools, new options, and new
     skills come from. → **Feature request** form.
   - **`docs`** — the behavior is fine but the README/`docs/`/tool description said otherwise, or said
     nothing. → **Feature request** form, with the wrong sentence quoted and the correction proposed.
   - **`skill`** — a bundled skill's procedure misfired, missed a step, or could be sharper. → **Bug
     report** if it did the wrong thing, **Feature request** if it could be better.
4. **Rate the impact** of each: **blocked** (the session could not proceed without a workaround),
   **slowed** (cost extra calls or a detour), **cosmetic** (noticed, worked around trivially). Add the
   **frequency**: once / every time (n/n) / intermittent — that is what separates a flake from a bug.
5. **Check what is already known**, best-effort, so the report does not re-file a known issue:
   - the README carries a _"Nice to have, not there yet"_ note or two — a `gap` already named there is
     already known;
   - if `gh` is available, `gh issue list --repo elias-ramzi/WebLatexMCP --search "<keywords>" --state all`;
   - `CHANGELOG.md` (in a clone, or on GitHub) may show it was already fixed after the version
     `server_info` reported — check the `[Unreleased]` section too.

   Mark each finding _new_ or _already tracked (#N)_; drop the already-fixed ones and say so. Never let
   this step block the report: if `gh` is missing or offline, say the check was skipped — that is what
   the first confirmation checkbox is asserting, so it must be honest.

6. **Rank and cut.** Order by impact (blocked → slowed → cosmetic), keep the strongest **five to eight**,
   and say in the chat summary what you dropped and why. A silent truncation reads as "that was
   everything".
7. **Print the chat summary, then one issue block per finding** (templates below). The blocks are the
   deliverable, and in a client with no filesystem access they are the _only_ deliverable.
8. **Offer to save**, do not save unasked. Default path: `web-latex-mcp-feedback-<YYYY-MM-DD>.md` in the
   directory the client was launched from, holding the summary and every block. **Never** write it with
   `write_file`, and never place it inside a project clone or a local project directory: it is not part
   of the user's manuscript, and inside a clone it is one `commit` away from being pushed to their
   co-authors. If the user insists on a path inside a clone, git-exclude it first via that clone's
   `.git/info/exclude` (the trick `summarize-paper` uses).
9. **Offer to file.** Filing is outward-facing and public, so it needs an explicit yes — never file as a
   side effect of writing the report. Show the exact titles first, then, with permission and `gh`
   available, one call per finding:

   ```bash
   gh issue create --repo elias-ramzi/WebLatexMCP \
     --title "bug: push rejects a valid resolutions set after a rebase conflict" \
     --label bug --body-file finding-1.md
   ```

   `--label` is not optional: `gh` posts through the API and bypasses the form, so the label the form
   would have applied (`bug` / `enhancement`) has to be set by hand. Without `gh`, hand back the title
   and the block and point at
   <https://github.com/elias-ramzi/WebLatexMCP/issues/new/choose> — blank issues are disabled, so the
   user picks **Bug report** or **Feature request** and pastes field by field.

**Titles.** `bug: <what breaks>` / `feat: <the capability>` / `docs: <what is wrong>`, under ~70
characters, naming the tool: `bug: edit_file refuses after project_sync rewrites the tree`. Not
"problem with editing".

**One issue per finding.** Never bundle unrelated findings — an issue should be one thing that can be
closed. Two findings with the same root cause are one issue.

This skill mutates nothing: no `write_file` into a project, no `commit`, no `push`, no `compile`. If a
finding needs a fix in the user's paper, that is a separate request they make separately.

## The environment block

Measure these once, reuse in every block. Where a command is given, run it — do not answer from memory.

| Fact                 | How to get it                                                                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server version       | `server_info` → `version`. Running from a clone, add the commit: `git -C <repo> rev-parse --short HEAD`.                                                                |
| Is it the latest?    | `npm view web-latex-mcp version` (best-effort, network). "0.4.0, latest is 0.5.0" pre-empts the first reply every stale report gets.                                    |
| OS, arch, WSL        | `uname -sr -m` on Unix, `cmd /c ver` on Windows. WSL shows as `microsoft` in `uname -r` — say so, its path and locking behavior differ: `Ubuntu 24.04 (WSL2) · x86_64`. |
| Node version         | `node --version`. The client spawns the server, possibly with a different Node than your shell's — if they could differ, say which one you measured.                    |
| MCP client + version | Claude Code CLI (`claude --version`), Claude Code VS Code extension, Claude Desktop, Cursor, Gemini CLI, GitHub Copilot, or another MCP client. **Ask** — see below.    |
| Model                | Which AI drove the session (`Claude Opus 5`, `Mistral Large`, …). Name what you are sure of; an exact build number you do not know is `unknown`, not a guess.           |
| Install method       | `npx web-latex-mcp`, global npm, the `.mcpb` bundle, the Claude Code plugin, or from a clone. It decides which dependencies shipped, so it decides which bugs exist.    |
| Compiler + TeX       | `doctor` → configured compiler, engines, TeX distribution and year. Only when the session compiled; omit otherwise rather than padding.                                 |
| Workspace + project  | `server_info` → `workspaceLocal`; `list_projects` → git or local in-place, and the **host** (Overleaf / GitHub / GitLab / other). The host, never the URL.              |
| Parallel sessions    | Was `WEB_LATEX_MCP_SESSION` set, or another client working the same clone? Concurrency bugs are unreadable without it.                                                  |

**What you cannot measure, ask for — once, in one message, before printing.** The client, the model, and
the install method cannot be read from inside the session; the user answers all three in a line. If they
don't, write `<unknown — please fill in>` in the field and leave it. **Never infer a client from the
conversation's feel, and never round a version up to one you did not read.** A blank field costs the
maintainer a question; a wrong one costs them an afternoon.

If the session has no shell (a plain MCP client running this as a prompt), you can still get the server
version, workspace, projects, and toolchain from `server_info`, `list_projects`, and `doctor` — ask the
user for OS, Node, client, model, and install method, and mark whatever is left.

## Never in the report

It is written to be shared with strangers, so before printing it, re-read it and strip:

- **Credentials** — tokens, `https://user:token@host/…` remotes, anything from `set_credential` or the
  credential portal. The server scrubs tokens out of _its_ error messages, but a shell command the
  session ran, or something the user pasted, is not covered.
- **Unpublished research** — the paper's title, abstract, claims, results, figures, author list,
  collaborators, deadlines, venue. If an error was about `sections/method.tex`, the filename is enough;
  the sentence that triggered it is not needed.
- **Private identifiers** — private repo URLs and project ids, absolute paths carrying a username or an
  employer. Write `~/…` or `<workspace>/<project>/main.tex`.
- **Log dumps** — keep the two or three lines that identify the failure, not the whole compile log.

When a finding cannot be explained without one of these, generalize it (`\input` of a file with a space
in its name, not the actual name) or drop the finding and say one was dropped. The second confirmation
checkbox ("no tokens or private URLs") is a claim you are making on the user's behalf — earn it.

## Chat summary (print this first)

Short, for the user, never pasted into an issue:

```markdown
**3 findings** — 1 bug (blocked), 1 gap (slowed), 1 docs (cosmetic). 2 dropped as cosmetic.
Highest impact: `push` rejected a valid `resolutions` set, so the conflict had to be resolved by hand.
Worked well: the conflict payload carried both sides in the text, no shell needed to read it.
Environment: v0.5.0 (latest) · Claude Code VS Code ext · Claude Opus 5 · npx · Ubuntu 24.04 (WSL2) · Node v22.14.0
Below: 3 blocks, ready to paste — say the word and I file them with `gh`.
```

## Issue block — `bug` (matches `.github/ISSUE_TEMPLATE/bug_report.yml`)

One fenced block per finding, headings in the form's field order, so it pastes straight down the form.

````markdown
### What happened?

Steps to reproduce:

1. `push` on a git project whose remote had moved on → returned `status: "conflict"` for
   `sections/method.tex` with the 3-way payload.
2. Retried `push` with `resolutions: { "sections/method.tex": "<merged content>" }` and the
   `expectedRemoteHead` from the first result.

Expected: the merged content is applied inside the rebase and the push completes.
Actual: rejected with `<the error line, verbatim>`; the clone stayed at the pre-push state.

Frequency: every time (3/3).
Impact: blocked — resolved by hand with `git rebase --continue` in a shell instead.

### Relevant output

```shell
push: resolution set does not match conflicted files (missing: sections/method.tex)
```

### OS

Ubuntu 24.04 (WSL2), x86_64

### Node version

v22.14.0

### WebLatexMCP version / commit

0.5.0 (latest on npm)

### How was it installed?

npx web-latex-mcp

### MCP client

Claude Code (VS Code extension) v1.2.3

### Model

Claude Opus 5

### TeX toolchain

latexmk 4.86 · TeX Live 2025 · pdflatex, xelatex, lualatex _(omit this field when the session never compiled)_

### Git remote

GitHub

### Confirmations

- [x] I searched existing issues and this has not been reported.
- [x] My logs/output contain no tokens or private URLs.
````

Tick a confirmation only if it is true: if the `gh` search was skipped, say
`- [ ] Could not search existing issues (gh unavailable)` rather than ticking it.

## Issue block — `feat` / `docs` (matches `.github/ISSUE_TEMPLATE/feature_request.yml`)

For `gap`, `friction`, and `docs` findings. Shorter — no toolchain dump, but keep the environment line
that makes the request concrete.

```markdown
### What problem does this solve?

Checking a draft's `\cite`s against a **shared group bibliography** registered as a second project takes
two `list_references` calls plus a manual comparison — `check_citations` stays inside one project's
sandbox. In this session that was ~40 entries compared by hand.

Encountered with: v0.5.0 · Claude Code (VS Code extension) · npx · Ubuntu 24.04 (WSL2) · Node v22.14.0

### Proposed solution

Let `check_citations` take an optional `bibliographyProject`, resolving the `.bib` through that
project's sandbox while the `.tex` scan stays in the first. A rough sketch — the maintainer will know
whether the sandbox boundary allows it.

### Alternatives considered

- Two `list_references` calls and a comparison — what was done; works, does not scale past a few dozen.
- Registering one project over the parent directory of both — defeats the sandbox and mixes two remotes.

### Confirmations

- [x] I searched existing issues and this has not been requested.
```

## After you finish

Report concisely: how many findings by bucket, the single highest-impact one in a sentence, whether the
`gh` search ran, where the file was saved (or that nothing was written), and whether anything was filed.
If the session was clean, say that plainly — it is a real result, not an empty one.

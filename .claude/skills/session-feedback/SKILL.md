---
name: session-feedback
description: Close a working session by turning what actually happened into a feedback report for WebLatexMCP itself — what broke, what was clumsy, what is missing, what the docs did not say — ranked by impact, stamped with the environment, scrubbed of anything private, and ready to paste into a GitHub issue. Use at the end of a session, or when the user asks to "give feedback", "write a retrospective", "what should I report", "how did this session go", or "file an issue about the MCP server". Reports on the *server and its skills*, never on the paper: it changes no file in the project, commits nothing, and pushes nothing.
---

# End a session with a feedback report for the server

This skill is the one that looks **at the tools, not at the paper**. At the end of a session spent
working through `web-latex-mcp`, review what actually happened and write up what a maintainer could act
on: the calls that failed, the detours that worked but should not have been needed, the capability that
was missing, the documented behavior that turned out to be wrong.

The output is a short report — printed in the chat, optionally saved to a file, optionally filed as a
GitHub issue on [`elias-ramzi/WebLatexMCP`](https://github.com/elias-ramzi/WebLatexMCP) once the user
says so. It is a **contribution artifact**: written to be read by someone who was not in this session.

Three rules hold the whole thing up. Break any one and the report is worse than nothing:

1. **Only what happened.** Every finding points at a real moment in this session — a tool call, its
   arguments, the error it returned, the retry that followed. No plausible-sounding problems, no
   speculation about code you did not run.
2. **"Nothing to report" is a valid result.** A smooth session should produce a two-line report saying
   so. Padding the sections with weak findings is how a feedback channel gets ignored.
3. **Scrub before it leaves the machine.** See _Never in the report_ below.

No project id is needed to run this — if the prompt supplied one, it only tells you which project's
session to look at.

## Workflow

1. **Stamp the environment.** Call `server_info` (version, workspace root/local, compiler) and — if
   anything in the session touched `compile` — `doctor` (engines, TeX distribution and its age). Add
   what you know about the client (Claude Code CLI / VS Code extension / Claude Desktop / other) and the
   OS. A finding without a version is a finding nobody can reproduce.
2. **Reconstruct the session.** Walk the conversation from the start and list, in order, the tool calls
   made and how each ended. Pay attention to the shapes that mark friction:
   - a call that returned an error, and what the next call was;
   - the same tool called repeatedly against the same file or project;
   - a fallback to a raw shell command (`git`, `sed`, `latexmk`) because a tool could not do it;
   - a guard that fired (`.bib` protection, external-change refusal, `requireGitProject`, ff-only pull,
     push-refused-when-behind) — was it right to fire, and did its message explain the way forward?
   - a point where the user had to correct, re-explain, or repeat themselves — that is usually a tool
     description or a doc failing, not a user failing.
3. **Classify each candidate finding** into exactly one bucket:
   - **`bug`** — the server did the wrong thing: wrong output, a crash, a guard that fired when it
     should not have (or stayed silent when it should have fired).
   - **`friction`** — it worked, but cost too much: too many round-trips, an unclear error, a payload
     that had to be re-read a second way, a workaround.
   - **`gap`** — the capability simply is not there. This is where new tools, new options, and new
     skills come from.
   - **`docs`** — the behavior is fine but the README/`docs/`/tool description said otherwise, or said
     nothing.
   - **`skill`** — a bundled skill's procedure misfired, missed a step, or could be sharper.
4. **Rate the impact** of each: **blocked** (the session could not proceed without a workaround),
   **slowed** (cost extra calls or a detour), **cosmetic** (noticed, worked around trivially).
5. **Check what is already known**, best-effort, so the report does not re-file a known issue:
   - the README carries a _"Nice to have, not there yet"_ note or two — a `gap` already named there is
     already known;
   - if `gh` is available, `gh issue list --repo elias-ramzi/WebLatexMCP --search "<keywords>" --state all`;
   - if this session ran from a clone of the server repo, `CHANGELOG.md` may show it was already fixed
     after the version `server_info` reported.

   Mark each finding _new_ or _already tracked (#N)_. Never let this step block the report: if `gh` is
   missing or offline, say the check was skipped.

6. **Rank and cut.** Order by impact (blocked → slowed → cosmetic), keep the strongest **five to eight**,
   and say explicitly in the report what you dropped and why. A silent truncation reads as "that was
   everything".
7. **Write the report** using the template below. Print it in the chat — that is the deliverable, and in
   a client with no filesystem access it is the _only_ deliverable.
8. **Offer to save it**, do not save it unasked. Default path: `web-latex-mcp-feedback-<YYYY-MM-DD>.md`
   in the directory the client was launched from. **Never** write it with `write_file`, and never place
   it inside a project clone or a local project directory: it is not part of the user's manuscript, and
   inside a clone it is one `commit` away from being pushed to their co-authors. If the user insists on
   a path inside a clone, git-exclude it first via that clone's `.git/info/exclude` (the trick
   `summarize-paper` uses).
9. **Offer to file it.** Filing is outward-facing and public, so it needs an explicit yes — never file
   as a side effect of writing the report. With permission and `gh` available:

   ```bash
   gh issue create --repo elias-ramzi/WebLatexMCP --title "<title>" --body-file <report.md>
   ```

   Otherwise hand back a suggested title plus the body, ready to paste at
   <https://github.com/elias-ramzi/WebLatexMCP/issues/new>. **Split it** when the findings are unrelated:
   one issue per `bug`, and a single combined issue for the `gap`/`friction`/`docs` set — one thread per
   thing that can be closed. Show the user the exact titles before creating anything.

This skill mutates nothing: no `write_file` into a project, no `commit`, no `push`, no `compile`. If a
finding needs a fix in the user's paper, that is a separate request they make separately.

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
in its name, not the actual name) or drop the finding and say one was dropped.

## Report template

Drop any section that is empty rather than padding it.

```markdown
# WebLatexMCP session feedback — <YYYY-MM-DD>

**Environment** — server v<x.y.z> · workspace <local|shared> · compiler <latexmk|tectonic> ·
client <Claude Code CLI | VS Code extension | Claude Desktop | …> · <OS> · <TeX distribution, if compiled>
**Session shape** — <n> project(s) (<git|local>), roughly <n> tool calls: <compile ×6, edit_file ×12, push ×2 (1 conflict)>
**Known-issue check** — searched open + closed issues for <keywords> | skipped (`gh` unavailable)

## Findings

### 1. <one-line title> — `bug` · blocked · new

- **What happened** — the call, and how it ended.
- **Expected** — what the docs or the tool description led me to expect.
- **Evidence** — `push` returned `status: "conflict"` with `conflictPaths: ["sections/method.tex"]`; the
  retry with `resolutions` failed with `<the error line>`.
- **Impact** — blocked: worked around by <what was done instead>.
- **Suggested fix** — optional, only when there is a concrete one. An honest "no idea" beats a guess.

### 2. <…> — `gap` · slowed · already tracked (#12)

…

## Worked well

One or two lines, no more — enough that nobody "fixes" a part that is doing its job.

## Dropped from this report

- <n> cosmetic findings, and <n> that could not be described without quoting the manuscript.
```

## After you finish

Report concisely: how many findings by bucket, the single highest-impact one in a sentence, where the
file was saved (or that nothing was written), and whether anything was filed. If the session was clean,
say that plainly — it is a real result, not an empty one.

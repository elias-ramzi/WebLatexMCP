# Concurrent Editing and Safe Pushing

How this server pushes changes without clobbering edits made elsewhere in the
document. These are the rules Claude follows when committing and pushing through
the WebLatexMCP server, and that human contributors should understand too.

---

## The setup: two concurrency models

An Overleaf project's Git bridge is an ordinary Git remote — in practice a single
`master` branch. But the people editing the document are not all using Git:

- **Web-editor users** type in Overleaf's real-time editor. Their keystrokes are
  reconciled by operational transforms (OT) and committed back to the Git history
  **opaquely** — you see commits appear on `master`, not the individual edits.
- **AI agents** (Claude, through this server) clone the repo, edit files, commit,
  and push over Git.

So we are bridging two concurrency models: OT inside Overleaf, Git on our side.
The web side can advance `master` at any moment, without warning. Every push has
to assume the remote may have moved since we last looked.

## The core rule

**Always `pull --rebase` before pushing. Never force-push.**

Rebasing replays our local commits on top of whatever is currently on `master`, so
we add our work _after_ everyone else's instead of on top of a stale base. A
force-push would overwrite commits made on the web side — silently destroying
other people's work. There is no situation in this workflow where force-pushing is
correct.

The `push` tool enforces this automatically (see [Quick reference](#quick-reference)).

## Surgical edits are a concurrency strategy, not just style

Git merges at **line granularity**. Two commits that change _different_ lines merge
cleanly with no human involvement; two commits that change the _same_ line
conflict. That single fact drives how we edit:

- **One sentence per line.** LaTeX flows lines into paragraphs, so this costs
  nothing in the rendered PDF, but it makes each sentence an independent unit that
  Git can merge on its own. A web user rewording sentence 3 while the agent fixes
  sentence 7 produces zero conflicts.
- **Only modify lines within the stated edit scope.** Never reflow, rewrap, or
  re-indent untouched regions. Reflowing a paragraph rewrites every line in it, so
  a one-word fix turns into a whole-paragraph diff that collides with any
  concurrent edit anywhere in that paragraph. A localized edit touches only the
  lines it must.

Surgical, localized edits are therefore the primary way we avoid conflicts in the
first place. (This is also why the [writing guide](writing-guide.md) asks for one
sentence per line and targeted changes.)

## Conflict policy: fail safe, never auto-resolve

A rebase conflict means the agent and a human edited the **same lines**. There is
no safe automatic answer — picking either side risks discarding someone's
intended change.

So we do **not** auto-resolve. On any conflict the tool:

1. **Aborts the rebase** (`git rebase --abort`), returning the local clone to
   exactly its pre-push state — nothing half-merged is left behind.
2. **Surfaces both versions** — the conflicting files, the line ranges, and for
   each hunk both the local (our) text and the remote (upstream) text — as a
   structured result with `status: "conflict"`.
3. **Stops**, and waits for a human to adjudicate.

Failing safe and asking a human beats merging wrong. A conflict is information, not
an error to be papered over.

### The conflict result carries everything needed to resolve

Aborting is the _default_, not a dead end. The `status: "conflict"` result is a full
3-way merge payload, so an MCP-only client (e.g. Claude Desktop) has the same material
a shell-capable agent (Claude Code) would get from raw `git`. Per conflicted file it
returns the **full content of all three sides**:

- `base` — the merge-base (common ancestor), so you can tell "they changed this line,
  we didn't" from "we both changed it";
- `ours` — our (local) full version;
- `theirs` — the full remote version that landed;
- `hunks` — a compact `<<<<<<<`-style marker view of just the overlap (an addition, not
  a substitute for the full sides).

Plus, at the top level: `conflictPaths` (the scope up front), `remoteHead` (the commit
we conflicted against), and `remoteCommits` (the hashes/messages that landed upstream).
`theirs` is otherwise invisible — a `read_file` only sees the working tree — so it is
included in full. (You can also fetch any committed version directly with
`read_file(path, ref)`, e.g. `ref: "origin/master"`.)

### Resolving a conflict through the tool

Once you've reconciled the sides, apply the merge back through the same `push` tool —
no shell required:

- Retry `push` with a **`resolutions`** array — for each conflicted file, the full
  merged file content. The submitted `content` is used **verbatim** as the resolved
  blob, so you are responsible for folding in the remote's non-conflicting edits too
  (which is exactly why you were handed `theirs` in full). The tool re-runs the rebase,
  writes your content, `git add`s it, `git rebase --continue`s, and pushes.
- The set is **validated**: omit a conflicted file and the tool re-surfaces the full
  report naming what's missing; include a file that wasn't in conflict and it's
  rejected by name (nothing is pushed). A wrong `resolutions` tells you exactly what's
  wrong instead of silently re-aborting.
- Pass **`expectedRemoteHead`** (the `remoteHead` from the conflict you merged against).
  If the remote advanced again since you computed the merge, the push is refused rather
  than applying your merge over a stale `theirs`.
- The merged text always originates from the caller — nothing is auto-merged. `.bib`
  files may only be included when **`confirmBibEdit: true`**, mirroring the
  write/edit/delete guard.
- On success the result includes **`pushedSha`**, the new tip now on the remote.

Why this is needed at all: a rebase replays our local _commit_ onto the moved remote,
so the same overlapping line conflicts on _every_ retry regardless of what the
working tree looks like — editing the file and pushing again just re-conflicts. The
merged content has to be applied _inside_ the rebase (add + `--continue`), which is
exactly what `resolutions` does.

## The sync-lag caveat

Overleaf's Git bridge does **not** instantly reflect in-flight web edits. Someone
can be typing in the web editor right now, and those changes will not appear in the
Git history until the bridge commits them. This means even a _clean_ push — one
that rebased without conflict — can land on top of live edits that simply had not
been committed yet.

We cannot eliminate this, only shrink the window:

- **Keep the push window short.** The tool fetches and `pull --rebase`s
  _immediately_ before the actual `git push`, so the gap between "this is the
  current `master`" and "pushed" is as small as possible.
- **For high-stakes pushes, coordinate timing.** Before a large or structural push,
  it is worth asking collaborators to pause web edits for a moment, or pushing when
  the document is quiet.

## Structural mitigation: split the paper into section files

Conflicts can only happen when two people touch the same file. The most effective
structural defense is to make that rare:

```latex
% main.tex
\input{sections/intro}
\input{sections/method}
\input{sections/experiments}
\input{sections/related-work}
```

With each section in its own file, people working in different sections touch
different files, which essentially never conflict. Combined with one-sentence-per-
line editing _within_ a file, this keeps the conflict surface tiny.

## Optional review flow for larger edits

For a big or risky change, you do not have to push straight to `master`. The
`push` tool's **branch mode** lets the agent stage the work for human review first:

1. The agent commits its work to a **local** feature branch (the branch is never
   pushed — the Overleaf bridge only reliably syncs `master`).
2. The tool returns the full `git diff` of the branch against `master` for a human
   to read.
3. Only on explicit approval does the tool rebase the branch onto a freshly fetched
   `master`, fast-forward `master`, and push — with the same abort-and-surface
   behavior if the rebase conflicts.

This is the right mode when you want eyes on the change before it reaches the shared
document.

## Quick reference

The `push` tool returns a structured result with a `status` field:

| Mode                     | What happens                                                                                                              | Result `status`                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `direct` (default)       | Commit pending work → fetch → `pull --rebase` → fetch → `pull --rebase` (right before pushing) → `push`. Never `--force`. | `pushed` / `nothing-to-push` / `conflict` |
| `branch` (no `approve`)  | Commit work to a local-only feature branch; return its diff vs `master`.                                                  | `awaiting-approval`                       |
| `branch` + `approve`     | Rebase the reviewed branch onto fresh `master`, fast-forward, push.                                                       | `pushed` / `conflict`                     |
| `direct` + `resolutions` | Re-run the rebase, apply the merged content for each conflicted file, `--continue`, push. `.bib` needs `confirmBibEdit`.  | `pushed` / `conflict` / `nothing-to-push` |

**Reading a `conflict` result.** The rebase was already aborted — your clone is
back to its pre-push state, nothing is half-merged. `conflictFiles` gives each
conflicting file's full `base`/`ours`/`theirs` plus a marker `hunks` view, and the
top level carries `conflictPaths`, `remoteHead`, and `remoteCommits`. Reconcile the
three sides, then retry `push` with a **`resolutions`** array carrying each
conflicted file's full merged content (see [Resolving a conflict through the
tool](#resolving-a-conflict-through-the-tool)). Don't just edit and push again —
the same commit replays and re-conflicts.

> Note: this server is branch-agnostic (it rebases onto whatever the clone's
> default branch is), but for Overleaf that branch is `master`, so this document
> says `master` throughout.

---

_Read alongside the [LaTeX writing guide](writing-guide.md): the editing habits it
prescribes are what make these merges clean._

# Concurrent Editing and Safe Pushing

Why this server pushes the way it does — the model behind safe pushing, the editing
habits that keep merges clean, and the limits we can't engineer away. This is the
_why_; for the exact tool arguments and result fields, see [`tools.md`](tools.md)
(the tool descriptions and their `conflict` results are self-contained — an MCP-only
client can resolve without a shell).

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
correct. The `push` tool enforces this automatically.

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
first place — the conflict never has to be resolved because it never happens. (This
is also why the [writing guide](writing-guide.md) asks for one sentence per line and
targeted changes.)

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

## Conflict policy: fail safe, never auto-resolve

A rebase conflict means the agent and a human edited the **same lines**. There is
no safe automatic answer — picking either side risks discarding someone's intended
change. So we do **not** auto-resolve. On any conflict `push`:

1. **Aborts the rebase**, returning the local clone to exactly its pre-push state —
   nothing half-merged is left behind.
2. **Surfaces all three sides** — the merge-base, our version, and the version that
   landed on the remote — as a structured `status: "conflict"` result (also rendered
   into the result _text_, so a client that drops structured fields can still read it).
3. **Stops**, and waits for a human to adjudicate.

Failing safe and asking a human beats merging wrong. A conflict is information, not
an error to be papered over.

**Resolving it stays in the tools — no shell needed.** You reconcile the three sides
and hand the merged content back through the same `push` tool; the merged text always
originates from the caller, nothing is auto-merged. If redoing your edits is easier
than computing a line-by-line merge, you can instead rewind the clone to the current
remote and re-apply. The exact arguments (the `resolutions` array, the
`expectedRemoteHead` guard, `reset_to_remote`) and the fields on a `conflict` result
are documented in [`tools.md`](tools.md#reviewable-safe-pushes) — this document only
covers the policy: **the resolution always comes from a human, never from an
auto-merge.**

## The sync-lag caveat

Overleaf's Git bridge does **not** instantly reflect in-flight web edits. Someone
can be typing in the web editor right now, and those changes will not appear in the
Git history until the bridge commits them. This means even a _clean_ push — one that
rebased without conflict — can land on top of live edits that simply had not been
committed yet. This is a limitation of the bridge, not something the tools can
detect; no `pull --rebase` can rebase onto a commit that doesn't exist yet.

We cannot eliminate this, only shrink the window:

- **Keep the push window short.** The tool fetches and `pull --rebase`s
  _immediately_ before the actual `git push`, so the gap between "this is the
  current `master`" and "pushed" is as small as possible.
- **For high-stakes pushes, coordinate timing.** Before a large or structural push,
  it is worth asking collaborators to pause web edits for a moment, or pushing when
  the document is quiet.

## Optional review flow for larger edits

For a big or risky change, you do not have to push straight to `master`. The `push`
tool's **branch mode** stages the work on a **local** feature branch (never pushed —
the Overleaf bridge only reliably syncs `master`) and returns its full diff against
`master` for a human to read. Only on explicit approval does it rebase onto a freshly
fetched `master`, fast-forward, and push — with the same abort-and-surface behavior
if the rebase conflicts. This is the right mode when you want eyes on the change
before it reaches the shared document.

---

> Note: this server is branch-agnostic (it rebases onto whatever the clone's default
> branch is), but for Overleaf that branch is `master`, so this document says
> `master` throughout.

_Read alongside the [LaTeX writing guide](writing-guide.md): the editing habits it
prescribes are what make these merges clean. For the tool-by-tool mechanics, see
[`tools.md`](tools.md)._

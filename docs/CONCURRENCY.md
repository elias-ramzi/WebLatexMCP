# Concurrent Editing and Safe Pushing

Why this server pushes the way it does — the model behind safe pushing, the editing
habits that keep merges clean, and the limits we can't engineer away. This is the
_why_; for the exact tool arguments and result fields, see [`tools.md`](tools.md)
(the tool descriptions and their `conflict` results are self-contained — an MCP-only
client can resolve without a shell).

---

## The setup: three concurrency models

An Overleaf project's Git bridge is an ordinary Git remote — in practice a single
default branch (`main`; older projects may still use `master`). But the people
editing the document are not all using Git:

- **Web-editor users** type in Overleaf's real-time editor. Their keystrokes are
  reconciled by operational transforms (OT) and committed back to the Git history
  **opaquely** — you see commits appear on `main`, not the individual edits.
- **AI agents** (Claude, through this server) clone the repo, edit files, commit,
  and push over Git.
- **Several agent sessions at once** — one person running a session per section,
  say — each a separate server process, all editing the _same_ local clone.

So we are bridging concurrency models: OT inside Overleaf, Git against the remote,
and a shared working tree between sibling sessions. The web side can advance `main`
at any moment, without warning, so every push has to assume the remote may have
moved since we last looked. And the working tree can change under a session at any
moment, so no session may assume the files on disk hold only its own work.

The rest of this document covers the remote (agent ↔ web) half. For the local half,
see [**parallel sessions**](#parallel-sessions-on-one-clone) below.

## The core rule

**Always `pull --rebase` before pushing. Never force-push.**

Rebasing replays our local commits on top of whatever is currently on `main`, so
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
  current `main`" and "pushed" is as small as possible.
- **For high-stakes pushes, coordinate timing.** Before a large or structural push,
  it is worth asking collaborators to pause web edits for a moment, or pushing when
  the document is quiet.

## Parallel sessions on one clone

Everything above is about the _remote_. This section is about the _local_ clone, when
one person runs several agent sessions on the same paper — one per section, say — and
each is a separate server process sharing a single working tree.

Two things break if that is left unmanaged. Git has no tolerance for two processes
rewriting an index at once, so operations must be serialised across processes, not
just within one. And `git add` cannot tell whose change is whose, so one session
committing would sweep up another's half-written paragraph under its own message.

### Naming your sessions

Set `WEB_LATEX_MCP_SESSION` per session to something meaningful — `intro`,
`experiments` — and it becomes what peers see in `status`. Without it a session still
works and is still isolated, but it shows up to the others under a generated id.

### Serialising across processes

Every mutating operation takes a lock file beside the clone for the duration, on top
of the in-process mutex. A session that crashes cannot release its lock, so a lock is
reclaimed once its owning process is gone, or once it stops being refreshed. Callers
wait rather than fail; only a genuinely stuck holder produces an error, and it names
the session holding it.

### Committing only your own work

Each session keeps a **shadow** of every file it has touched, holding `HEAD + only
this session's edits`, while the working tree holds everyone's. `commit` stages the
shadow directly rather than running `git add`, so the commit contains that session's
lines and leaves its peers' edits sitting uncommitted on disk, exactly where they
were.

The shadow is maintained from the _change_, not the result: when a session writes a
file, what is folded into its shadow is the difference its own write made, three-way
merged, never the whole file it happened to read. That is what keeps a peer's lines
out of it. After HEAD moves — a peer commits, a pull lands, a push rebases — each
session carries its shadow onto the new HEAD by three-way merge, lazily, on its next
call. No session has to be running for another to make progress.

Two consequences worth knowing:

- `commit` reports `leftUncommitted` — what is still dirty that it deliberately did
  not take. A file can appear there even though the commit included part of it; that
  is the two-sessions-one-file case, working as intended.
- `commit scope: "all"` is the escape hatch: it commits the whole working tree, other
  sessions' work included. Use it deliberately, not as a default.

### When two sessions edit the same lines

Same file, different paragraphs, is the case this is built for and it merges silently.
Same _lines_ is a genuine collision, and it is treated exactly like a rebase conflict:
surfaced, never guessed at. The file is flagged (`conflictedChanges` in `status`,
`conflicted` on a commit result) and excluded from commits, and it stays flagged —
later edits do not quietly clear it, because that session's shadow is anchored to a
base the file has since moved past, and committing it would revert whatever landed in
between.

There are two honest ways out, and both are the caller's decision: commit with
`scope: "all"` to take the working tree as it stands, or discard those files to give
up that session's version.

### Pushing with peers around

A push has to rebase, and a rebase needs a clean tree. So `push` refuses while a live
peer session has uncommitted work, naming who to wait for — the alternative would be
sweeping their in-flight paragraph into the push or rewriting the tree underneath
them. Changes nobody owns (edited outside the server, or left by a session that has
since exited) do not block it.

The practical rhythm: sessions commit as they finish a piece, and whoever pushes does
so when the others are between edits.

### What this does not do

- **It is one machine only.** All of it rests on a shared filesystem. Two people on
  two laptops see none of it, and coordinate through the remote as they always did.
- **It attributes, it does not lock.** No session is prevented from editing any file.
  Splitting the paper into per-section files remains the real defence — it makes
  collisions rare rather than merely legible.
- **A session that dies leaves its edits behind.** They stay in the working tree, but
  the record of whose they were is eventually collected; they then show up as
  unattributed changes, committable with `scope: "all"`.

## Optional review flow for larger edits

For a big or risky change, you do not have to push straight to `main`. The `push`
tool's **branch mode** stages the work on a **local** feature branch (never pushed —
the Overleaf bridge only reliably syncs the default branch) and returns its full diff
against `main` for a human to read. Only on explicit approval does it rebase onto a
freshly fetched `main`, fast-forward, and push — with the same abort-and-surface behavior
if the rebase conflicts. This is the right mode when you want eyes on the change
before it reaches the shared document.

---

> Note: this server is branch-agnostic — it rebases onto whatever the clone's default
> branch actually is. This document says `main` throughout because that is Overleaf's
> current default; older projects may still use `master`, and everything here applies
> unchanged to either.

_Read alongside the [LaTeX writing guide](writing-guide.md): the editing habits it
prescribes are what make these merges clean. For the tool-by-tool mechanics, see
[`tools.md`](tools.md)._

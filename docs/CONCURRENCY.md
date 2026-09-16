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
   By default that per-file payload is **budgeted** to fit in one tool result: `hunks`
   are kept first (least recoverable once the rebase aborts), then `base`/`ours`/`theirs`,
   each capped individually; whatever doesn't fit comes back `null` with a matching
   `elided` entry (its true size plus a `read_file(path, ref)` pointer to fetch it in
   full) — distinct from an ordinary `null` with no `elided` entry, which just means
   the file didn't exist on that side. Past 20 conflicted files the rest get no
   per-file detail at all, though every path stays listed in `conflictPaths`.
   `conflictDetail: "full"` asks for the old, uncapped behavior instead. See
   [`tools.md`](tools.md#reviewable-safe-pushes) for the field-level detail.
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
wait rather than fail for up to 30 seconds; a holder still busy past that (a long fetch)
or a genuinely stuck one produces an error, and it names
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
- `commit scope: "paths"` is for work that never went through the server — a file a
  script produced, an edit made with the client's own tools. Nobody's shadow holds it,
  so a session-scoped commit cannot see it, and `scope: "all"` would take a peer's
  in-flight work along with it. `"paths"` stages exactly the named files, refuses an
  empty list, and refuses a path a live session owns — taking that is what `"all"`
  is for, and it stays a deliberate act.

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
up that session's version (which also throws away any other session's uncommitted
work at those paths — `discard` reverts the working tree, not one session's view of
it). Taking the tree settles the record; and when git finds
nothing to stage for the paths taken — the content is already at HEAD, because a
`push` with `message` committed it or a hand edit reverted it — the record is settled
without a commit (`committed: false`, the files under `settled`), so a stale flag never
forces an empty commit to get out.

One more thing a session commit never takes: a file git ignores. Staging from the
shadow bypasses `git add`, which is the only place `.gitignore` and
`.git/info/exclude` are consulted, so `commit` asks git first and skips those files
(reported under `ignored`) — they stay in the working tree, out of every commit and
every push, as the exclude entry intended. And because no scope can ever commit one, an
ignored entry is settled and its record dropped whatever its `conflicted`/`unrecorded`
state, so it never wedges the default scope behind a remedy that cannot work.

### Pushing with peers around

A push has to rebase, and a rebase needs a clean tree. So `push` refuses while a live
peer session exists and the tree holds work that is not this session's — the
alternative would be sweeping their in-flight paragraph into the push or rewriting
the tree underneath them.

On a `core.ignorecase` clone (git's default on macOS and Windows) ownership is judged with git's
own ASCII case fold, so a peer's `notes.txt` and git's `Notes.txt` are one file; elsewhere the
comparison is byte-exact. The refusal says what is known: per live session, the files its shadow owns, how long
ago it last wrote through the server, and how long ago it was last seen; and, apart,
the files no live session owns (edited outside the server, or left by a session that
has since exited). That is what separates "wait" from "take over": a write seconds old
is a peer mid-paragraph; one hours old, from a session that is merely still open, is a
judgement the caller can now make with `commit scope: "all"` (peer-owned files) or
`"paths"` (files no live session owns) — never with `discard`, which has no ownership
guard and would destroy the owner's uncommitted work. A session
whose index cannot be read is treated as owning everything, never as owning nothing.
A write is never failed because its shadow record could not be written, but the
failure is not silent either: the path is marked in the session's index as
`conflicted` (and `unrecorded`), so a peer's `commit scope: "paths"` refuses it as
owned and the session's own commit excludes it until it is taken deliberately with
`scope: "all"` or discarded — and taking it settles it, so the session's default scope
works again afterwards. What remains is the case where the index itself cannot be
written (a full or unwritable `.sessions/`): then the edit is in the tree with no entry
naming it, and it shows up as owned by nobody.
`status` carries the same per-session `changes` and `lastWriteAt`, for checking
without attempting a push.

Not every peer `status` lists by name, though. A session that has died — no live process _from this
boot_ behind its recorded pid, and a heartbeat older than the staleness window — and whose shadow
index reads back as a readable, empty
array (it committed everything before exiting, or never made a server-side edit) is folded into a
single `staleSessions: N` count instead. Three cases are deliberately NOT collapsed: a **live** peer,
however little it currently holds, because it may write again any moment; a **dead peer that still
holds entries**, since those are exactly the changes `status` exists to surface; and a dead peer
whose shadow index came back **unreadable** (`null`, not empty) — `null` means "cannot tell", never
"owns nothing", so it stays listed individually with `changes: null` rather than being counted as
harmless.

The collapse is report-level only — nothing is deleted from `<workspace>/.sessions/<projectId>/`.
`status` is read-only and takes no lock, and a session that reads as dead by its stale heartbeat can
still be mid-write (a slow `record()`, a paused process); reaping its files out from under that write
would destroy the exact ownership proof `push`'s peer guard and `commit scope: "paths"` depend on to
tell this session's in-flight edits from a peer's. Both of those guards resolve peers through
`SessionRegistry.livePeers`, which the collapse never touches — a peer folded into `staleSessions`
was already dead by `livePeers`' own definition, so nothing that used to be refused starts being
allowed, and nothing that used to be allowed starts being refused. Session records accumulate on disk
for as long as the workspace exists; only what `status` chooses to print is bounded.

Liveness itself is derived, never trusted — a session that crashes cannot retract its record. A peer
counts as live if its recorded pid still names a running process **and** that pid can be tied to the
current boot (there are two ways it can be, both below), **or** its heartbeat is inside the 30-minute
staleness window. The heartbeat clause is a bounded grace, which is what lets an idle-but-alive
session go on being protected: a session heartbeats from `status`, `commit` and `push`, and from the
mutation recorder on every server-side write, so anything actually doing work stays fresh — but a
session merely waiting on its user is still perfectly real. The pid clause carried no such bound
before #78 — it was the only unbounded route to `live`, and that is exactly where it broke: a pid is
unique only within one boot, so on a workspace that survives a reboot a dead session's recorded pid
can be handed to an unrelated process. `pidAlive` then answered true forever. The record never aged
into `staleSessions`, and — because `guardPeerWork` refuses while any live peer exists **whatever
that peer owns**, being owner-aware only about how it words the refusal — it blocked every `push`
made while the tree carried a dirty path this session had not itself recorded, permanently, with no
cure but deleting a JSON file by hand. In the reboot case that condition is almost always met: the
dead session's own abandoned edits are still in the tree and are owned by nobody.

So the pid is scoped to its boot. Each record is stamped with the instant the machine booted
(`bootedAt`, derived in `src/lib/bootIdentity.ts` from `os.uptime()`), and the pid clause only counts
when that stamp matches the current boot. The stamp is approximate — second-resolution uptime, and a
clock NTP can step — so the comparison carries a generous tolerance, deliberately biased toward
"same boot": calling two boots one merely leaves today's behaviour in place (a spurious refusal, which
is the safe way to be wrong), while calling one boot two would revoke a live session's pid grant and
let its uncommitted work read as owned by nobody. A record with **no** stamp — written by a build from
before the field existed — earns no pid grant _from the stamp_, since the stamp is what makes a pid
meaningful; it reaches the pid clause by two other routes instead, both below — the clock-free one
while it goes on heartbeating after the judging process started, and a bounded 24-hour grace on the
pid alone once it has gone quiet. Both matter, because a stampless record exists _because its owning
process runs the old build_, and that process will never write a stamp however often it heartbeats —
so a stamp-only rule would strand a still-running old-build session, whose files a new-build peer's
`commit scope: "paths"` would then take. Past the grace it does read dead, which is what keeps a
genuine legacy ghost clearing itself instead of sitting on disk forever. What
this does not catch is pid reuse _within_ a single boot (pid wraparound), which would need the OS's
per-process start time — and that has no portable source across Linux, macOS and Windows.

A derived stamp is only as good as its clock, so the pid clause has a second route that needs no clock
at all. `Date.now() - os.uptime() * 1000` drifts whenever the wall clock is stepped without uptime
advancing, and that drift accumulates over the life of a boot rather than being write-time jitter: on
the WSL2 machine this was developed on it had already moved 4m32s, about 90% of the tolerance, inside
one boot, and an overnight sleep steps it by hours. That is the unsafe direction — a live peer holding
uncommitted edits loses its stamp match _and_ has a stale heartbeat, both clauses dying at once, and
`commit scope: "paths"` stops refusing its files. So a record whose `heartbeatAt` is at or after **this
process's own start** earns the pid grant outright: it must have been written during the current boot,
because a reboot would have killed us. That proof is immune to drift, since a clock step moves future
readings and not the two past ones being compared, and it is what rescues both the drifted live peer
and the stampless old-build session above — in each case only from the moment they heartbeat again
after we start. It only ever supplements the stamp — it can vouch for nothing written before this
process started, so an older peer still needs its `bootedAt`.

That argument rests on one assumption, recorded here rather than asserted away: both readings are
_wall-clock_ ones (`touch()` writes `heartbeatAt` off `Date.now()`), so it holds only while the clock
did not step **backward** between the peer's last heartbeat and our own start — which a dual-boot
machine with a local-time RTC, or NTP correcting a fast RTC at boot, can do. A ghost that heartbeated
at wall 10:55 before a reboot that reset the clock to 09:58 clears the route at 10:00 and keeps the
unbounded pid grant: the original defect, reproduced. It is documented rather than closed because it
fails **closed** — a ghost reading live costs a spurious refusal, exactly the pre-fix behaviour — and
never in the direction that lets a live peer's lines be swept.

What clears no route at all reads dead, and there are two shapes of that — plus a **container**,
which cuts either way depending on the runtime. A **clock step** strands a
live peer, and the deciding quantity is not when either process started relative to the step:
`isSameBoot` compares the stamp the peer derived at its last heartbeat against the one we derive now,
so what matters is the drift accumulated between that heartbeat and the `peers()` call judging it. A
step anywhere inside that span pushes the two past the tolerance — including one that happens after
the judging process started, so long as the peer's last heartbeat predates our module load, which is
exactly when `writtenSinceProcessStart` cannot speak for it either.

A still-running **old-build** session was the same shape with no clock step at all, and the most
reachable of them: its pid is genuinely alive, its record carries no `bootedAt` and never will, and
once its last heartbeat was older than both the staleness window and our own start, neither route
held. That is the ordinary upgrade window — heartbeats come only from `status`, `commit`, `push` and
the mutation recorder, so an agent session waiting on its user goes quiet for precisely that long —
and it failed **open**: `guardPeerWork` saw no live peer, so a `push` carrying a `message`
(`git add -A`) or a `commit scope: "paths"` could take that session's uncommitted lines. So a
stampless record now keeps its pid grant on the pid alone, for a bounded `LEGACY_PID_GRACE_MS` (24
hours) — "no stamp" is an absence of evidence, unlike a stamp that names another boot, and the grace
acts only in that absence. The bound is what keeps this from being the original defect again: a
legacy ghost whose pid has been reused clears itself within a day rather than never, and a stampless
session idle beyond the grace does read dead, deliberately. A record whose stamp merely drifted gets
no such grace — it has a stamp, the stamp disagrees, and granting it anyway would re-grant the
boot-reused ghost for a day. And in a **container** the answer
depends on the runtime: under a plain one `/proc/uptime` is the host's while pids are namespaced, so
`pidAlive` false-positives survive there, fail-closed, as wraparound does — but under LXCFS or gVisor
`/proc/uptime` _is_ virtualised per container, so two containers derive different stamps and an idle
peer in another one reads dead, fail-open, the way the old-build session used to. The legacy grace
does not rescue that one either: those records carry a stamp, it is simply the wrong host's.

Every path list in that refusal is capped at 20 (`REFUSAL_PATH_CAP`): the header's
disputed set, each session's `owns`, the unowned line, and the closing's copy of it.
The cap costs more here than in the conflict payload, because the refusal is an error
and so has only a text channel — a dropped path is dropped from the response, not
merely from one of two renderings of it. `status` is what makes that affordable: its
`otherChanges` is the same disputed set — staged, unstaged and untracked alike, so a
path modified only in the index is not left out — and its `activeSessions[].changes` is
complete per session, both uncapped in `structuredContent` even though its own text shows
five paths per peer. The refusal names them only when a cap actually fired, never as
boilerplate — and names them as a derivation rather than as two fields to go read.
That is deliberate: there is no `unowned`-shaped field in `status`, and `otherChanges`
is the whole disputed set, peer-owned files included, so feeding it to
`commit scope: "paths"` — which is what the closing advises for unowned files — would
bounce off the live-peer guard and fail the whole call. The files no live session owns
are `otherChanges` minus every live session's `changes`, a null `changes` claiming
everything, and the message says so. It also claims no more than that: `status` names
every omitted path, among more besides, rather than reporting these lists back. The
stronger claim holds for `push`, whose disputed set is built exactly as `otherChanges`
is, but not for `project_sync`, whose blocking set is the paths an incoming commit
would overwrite, tracked or untracked — a strict subset no `status` field reproduces. A message two
tools share may only assert what is true for both.

`project_sync` takes the same per-project lock every mutating tool does, so a peer's
write never interleaves with a fast-forward pull — and a peer waiting on that lock gives
up after 30 seconds, so a sync that fetches for longer costs it one refused call rather
than a silently interleaved one.

Once past that peer guard — no live peer, or every live peer's work is already
committed — the push still has to rebase, and git itself draws a further line:
**untracked files never block it.** They ride through the rebase untouched, whoever
left them (a build artifact, a peer's new file after it has exited). What does block
it is an **uncommitted modification to a file git already tracks**, because git cannot
rebase over one; `push` refuses and names every such file, and offers the ways out —
`commit` (this session's edits by default, `scope: "all"` for the whole tree), a
`message` on push (which commits the _whole_ working tree, any peers' work included),
or `discard`. Separately, if the incoming remote commit would **add** a path that
already exists, untracked, in the local tree, git refuses that specific rebase step
too; `push` reports it by name and leaves the clone exactly as it was — nothing
pushed, no rebase left in progress. Either way, the fix is the same: commit the
colliding file (so the next push surfaces a proper conflict instead of this abort) or
delete/move it, then read the remote version with `read_file(path, ref="origin/<branch>")`.

If a collaborator's push lands in the gap between our fetch and our push, `push` retries the same
pull-rebase-then-push sequence up to 3 rounds before giving up as `status: "remote-moved"` (nothing
pushed, clone intact) — a genuine rebase conflict on any round is reported immediately, not retried.
Two cases take one attempt only and report `remote-moved` on the first lost race: a `resolutions`
push that passed `expectedRemoteHead` (the caller asked to be refused if the remote moved again), and
branch-mode landing, whose summary then prescribes the direct-mode push that recovers from it.

The practical rhythm: sessions commit as they finish a piece, and whoever pushes does
so when the others are between edits.

### What this does not do

- **It is one machine only.** All of it rests on a shared filesystem. Two people on
  two laptops see none of it, and coordinate through the remote as they always did.
- **It attributes, it does not lock.** No session is prevented from editing any file.
  Splitting the paper into per-section files remains the real defence — it makes
  collisions rare rather than merely legible.
- **A peer's `register_project { default: true }` reaches this session at once** — its next
  call that omits `project` resolves to the peer's choice, whether or not this session had a
  default before. Only a session that asserted one through `WEB_LATEX_MCP_DEFAULT_PROJECT`
  keeps its own.
- **A session that dies leaves its edits behind.** They stay in the working tree; once its
  process is gone — or its recorded pid belongs to a different boot — and its heartbeat is
  stale, it stops counting as live, and its files show up as changes no live session owns,
  committable with `scope: "all"` or `scope: "paths"`.

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

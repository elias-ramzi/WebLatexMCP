/**
 * Deciding how much of a `status` result may be returned, against a character budget charged on the
 * RENDERED payload in BOTH channels. A pure planner over plain data, the same shape as
 * `src/lib/conflictBudget.ts` (issue #68), `src/lib/diffBudget.ts`, `src/lib/commentsBudget.ts` and
 * `src/lib/fileListBudget.ts`: a budget, a plan, a human-readable `note`, and a tool layer that only
 * maps the plan onto response shapes. It imports nothing from the tool layer and touches no
 * fs/process/clock, so it stays testable without a live MCP client.
 *
 * Why it exists (issue #175). `status` was the last document-controlled payload in the server with
 * **no bound of any kind** — no cap, no counter — and it ships every one of its lists twice: as a
 * `z.array(z.string())` in `structuredContent` and again `join(', ')`ed into the result text.
 * `staged`, `unstaged`, `untracked`, `externalChanges`, `sessionChanges`, `otherChanges`,
 * `conflictedChanges` and every peer's `activeSessions[].changes` are all filled from the working
 * tree, which the server does not control: an untracked `figures/` tree, a regenerated build
 * directory, or a `mode: 'local'` project registered on a directory the user fills however they
 * like, all reach thousands of paths. At ~60 characters of path in two channels that is the #68
 * shape exactly — a payload the client rejects **undelivered**, so the caller gets no status and no
 * reason. `status` is the tool an agent calls first and most, which makes it the worst one to lose
 * entirely.
 *
 * Four decisions carry this module.
 *
 *  1. **The commit lists are deliberately NOT in this budget's structured half.**
 *     `structuredContent.behindCommits`/`aheadCommits` stay complete, because
 *     `src/lib/conflictBudget.ts` caps its own `remoteCommits` at `CONFLICT_MAX_COMMITS` and points
 *     the caller at `status.behindCommits` as the complete list (`CONFLICT_COMMITS_MORE_HINT` in
 *     `conflictText.ts` says so in words). Which fields carry such a promise, and which code made
 *     it, is enumerated in {@link STATUS_COMPLETENESS_PROMISES} (#187) rather than left to prose
 *     nobody re-reads. Capping them here would silently falsify that pointer and
 *     leave a caller mid-conflict with no complete list anywhere. Their TEXT rendering is bounded
 *     instead — see {@link planCommitText} — which is what `renderCommitLines`' own
 *     "(see structuredContent)" trailing line was built for. The consequence is stated rather than
 *     hidden: a `status` on a clone hundreds of commits behind still returns a large
 *     `structuredContent`, by decree, and this module does not pretend otherwise.
 *  2. **Cut by {@link ALLOCATION_ORDER}, not in declaration order.** A single pool spent
 *     top-to-bottom would cut the conflicted paths that block a commit because the untracked
 *     figures tree ran first.
 *  3. **Charge BOTH channels.** A path is emitted twice per list it appears in, so a budget
 *     counting it once is wrong by 2x ({@link pathCost}).
 *  4. **An empty list must keep meaning "git reported nothing".** `untracked: []` is a real answer
 *     and the budget must never be able to forge it, so a non-empty list always keeps at least one
 *     path ({@link planStatusPayload}), every cut is counted in `pathsOmitted`, and `truncated` says
 *     at a glance that something went. Same rule per peer: a peer whose `changes` the budget emptied
 *     would read as the "nothing recorded" state that `staleSessions` and `peerDetail` treat as
 *     load-bearing, so a peer that recorded anything keeps at least one path too.
 *
 * What this module must NOT do, and does not: `clean`, `ahead`, `behind` and `syncState` are derived
 * from what git reported, never from what the report shows, so nothing here touches them. And no
 * guard reads this report — `commit` and `push` refuse on `livePeers()`/`peerEntries()` directly —
 * so bounding it weakens no ownership guarantee. This is a reporting change only.
 */

import type { RemoteCommit } from '../services/gitService.js';
import { renderCommitLines } from './conflictText.js';
import { CONFLICT_MAX_COMMITS } from './conflictBudget.js';
// The surrogate-safe clip, imported rather than re-implemented: a cut landing between the halves of
// an astral character leaves a lone surrogate, which is not text and which a JSON encoder either
// rejects or silently replaces on the way into `structuredContent`. That subtlety is worth exactly
// one implementation in the codebase (`commentsBudget.ts` states the reasoning in full).
import { clipText } from './commentsBudget.js';

/**
 * Total character budget for one `status` result's PATH LISTS across BOTH channels combined.
 *
 * 20000 is this codebase's house figure for a rendered content budget — `CONFLICT_CONTENT_BUDGET`,
 * `FLOATS_CONTENT_BUDGET`, `SEARCH_CONTENT_BUDGET`, `CITATIONS_CONTENT_BUDGET`,
 * `DIFF_CONTENT_BUDGET`, `COMMENTS_CONTENT_BUDGET` — sized so the worst case lands well under the
 * ~67k a client actually rejected (#68). Nothing about a path list argues for a different number,
 * and a second figure for the same class of defect only invites the question of which one is right.
 *
 * It buys roughly 150 dirty paths at ordinary lengths, and a dirty path is typically charged twice
 * (once in `staged`/`unstaged`/`untracked` and once in the `sessionChanges`/`otherChanges` split),
 * which is deliberate: both renderings ship, so both are paid for.
 */
export const STATUS_CONTENT_BUDGET = 20000;

/**
 * Withheld from the budget to pay for the single {@link StatusPayloadPlan.note}, which also ships in
 * both channels (a trailing text line and `structuredContent.note`). The note describes the cuts, so
 * charging it per-part would be circular; reserving a flat allowance and pinning (in
 * `test/unit/statusBudget.test.ts`) that the longest note this module can produce fits inside it
 * gives the same guarantee without the circularity. Same technique as `DIFF_NOTE_RESERVE` and
 * `FILE_LIST_NOTE_RESERVE`; larger than either because this note has more to say — it names eight
 * lanes, their cut counts, the whole priority order, and the two routes back — and because it is
 * charged twice, once per channel.
 */
export const STATUS_NOTE_RESERVE = 2200;

/**
 * The JSON punctuation, key names, per-list text labels and counter digits wrapped around the path
 * payload — everything except the path elements themselves (charged exactly by {@link pathCost}),
 * the peer records (charged by {@link peerIdentityCost}) and the note (reserved above).
 *
 * It deliberately does **not** cover `aheadCommits`/`behindCommits`: those are out of this budget by
 * decree (see the module note), so charging them would take budget away from the paths without
 * bounding anything. Pinned by a test that stringifies a real result and checks this still accounts
 * for it, the technique `diffBudget.ts`, `commentsBudget.ts` and `fileListBudget.ts` all use.
 */
export const STATUS_JSON_SCAFFOLD_OVERHEAD = 1200;

/**
 * Most peers ever listed individually in `activeSessions`, matching `capList`/`CONFLICT_MAX_FILES`'
 * house figure of 20.
 *
 * This array grows without bound on its own, independently of any one peer's `changes`: a session
 * record is removed only on a clean shutdown, and `splitStalePeers` collapses a dead record only
 * when its shadow index reads back readably **empty** — so a killed agent that had recorded even one
 * path stays listed forever. Twenty named sessions is already more than any human runs at once; past
 * that the names stop being actionable and become the unbounded payload this module exists to stop.
 *
 * Counted in {@link StatusPayloadPlan.activeSessionsOmitted}, which is a different fact from
 * `staleSessions` and must stay one: `staleSessions` counts peers that hold nothing and are never
 * coming back, this counts peers the report had no room for.
 */
export const STATUS_MAX_SESSIONS = 20;

/**
 * How many of a peer's paths the text channel names before "and N more" — the cap `status`'s
 * `peerDetail` has always applied, named here so {@link peerPathCost} charges the text side for
 * exactly the paths that are rendered and no others.
 */
export const STATUS_PEER_TEXT_PATHS = 5;

/**
 * Character budget for ONE commit block in the TEXT channel (`landed upstream:` and `to push:` each
 * get their own allocation of this figure).
 *
 * 2000 is the house figure for a merely diagnostic share, and it is the right instrument here rather
 * than the 20000 content budget for one specific reason: unlike a path list, this block is a
 * *rendering of data that ships complete in the same result*. `renderCommitLines` already ends a
 * truncated block with "… N more commit(s) (see structuredContent)", and for `status` that pointer
 * is true — `behindCommits`/`aheadCommits` are uncapped. Nothing is lost by bounding the prose view
 * of a list the caller already has in full.
 *
 * The pool is split into two allocations of the same figure rather than shared, because the two
 * blocks answer different questions ("what landed upstream" vs "what a push would send") and a clone
 * that is far behind must not be able to starve the list of what it is about to push.
 */
export const STATUS_COMMIT_TEXT_BUDGET = 2000;

/**
 * Longest single commit message the text channel renders, before an ellipsis. An unconditional
 * per-field cap rather than a budget mechanism, so one commit's line is the same size whether it is
 * rendered alone or alongside nineteen others — the same shape (and reasoning) as
 * `COMMENT_NOTE_CAP`. `RemoteCommit.message` is the commit *subject*, so 200 characters is already
 * generous for anything written by a human; a pathological one comes from the remote, which is
 * exactly the document-controlled input this family budgets. The full message ships untouched in
 * `structuredContent`, so this clip omits nothing from the result and therefore earns no `…Omitted`
 * counter of its own — unlike the path lists, which are cut in both channels.
 */
export const STATUS_COMMIT_MESSAGE_CAP = 200;

/** The `,` between two JSON array elements, charged per path. */
const ELEMENT_SEPARATOR_OVERHEAD = 1;

/** The `, ` the text channel puts between two paths on a list line, charged per path. */
const TEXT_SEPARATOR_OVERHEAD = 2;

/**
 * Charged once per listed peer for the text segment `<session> (gone; … ; last write 3h ago)` minus
 * the paths themselves, which {@link peerPathCost} charges. A flat allowance for a template whose
 * only unbounded part is the session id (charged separately below) and the paths; pinned by a test
 * against the longest segment `status`'s `peerDetail` can produce with no paths in it.
 */
const PEER_TEXT_IDENTITY_OVERHEAD = 60;

/**
 * The order the character budget is ALLOCATED in — highest value first, so the list cut **first** is
 * the one written **last**. Reading it back to front as a cut priority:
 *
 *  8. `untracked` is cut first. It is the class that is unbounded in practice (a `figures/` tree, a
 *     stray build directory, a `mode: 'local'` directory the server does not control), the least
 *     informative per entry — a caller learns little from the 4000th `.png` that they did not learn
 *     from the first — and the most precisely recoverable: `list_files` enumerates exactly this,
 *     under its own budget, with nothing else competing for it.
 *  7. `unstaged` and 6. `staged` next, and they are cut before anything below them for a reason that
 *     is structural rather than editorial: the three git lists are **redundant with the split above
 *     them**. `sessionChanges ∪ otherChanges` is precisely `staged ∪ unstaged ∪ untracked`, deduped
 *     — `status.ts` builds it that way. So cutting these loses the index-vs-working-tree distinction
 *     for a path, never the path itself, as long as the split survives. `unstaged` outranks
 *     `staged` only because a staged-but-unmodified path is the rarer state and the one a caller is
 *     more likely to have put there deliberately.
 *  5. `activeSessionChanges` — every path in a peer's shadow index. Ranked above the redundant git
 *     lists because it is recoverable from nothing else in the result (it names paths a peer owns
 *     that are not even dirty), and below the four lists above it because nothing acts on it: the
 *     ownership guards `commit` and `push` apply read `peerEntries()` directly and are unaffected by
 *     what this report shows.
 *  4. `otherChanges` — uncommitted work this session did not do. What a default `commit` leaves
 *     alone, and the explanation for a `commit scope: "paths"` or `push` refusal.
 *  3. `sessionChanges` — what a default `commit` would send. This is the tool's answer to "what am I
 *     about to commit", so it outranks the report of what someone else is doing.
 *  2. `externalChanges` — files a human edited directly. A write to one of these throws
 *     `ExternalChangeError` until acknowledged, so it is what a caller cannot plan around without.
 *  1. `conflictedChanges` is cut last of all. These paths are excluded from every commit until
 *     re-read and re-edited, so a caller acting without them believes work is landing that is not.
 *     They are also, by construction, the shortest list here.
 *
 * A lane added here may not be a field {@link STATUS_COMPLETENESS_PROMISES} lists: that inventory's
 * `field` type subtracts this array's own members, so the promise stops compiling first (#187).
 */
export const ALLOCATION_ORDER = [
  'conflictedChanges',
  'externalChanges',
  'sessionChanges',
  'otherChanges',
  'activeSessionChanges',
  'staged',
  'unstaged',
  'untracked',
] as const;

/** A lane of {@link ALLOCATION_ORDER}. */
export type StatusListName = (typeof ALLOCATION_ORDER)[number];

/** The lanes that are flat top-level path lists (everything but the per-peer lane). */
export type StatusFlatListName = Exclude<StatusListName, 'activeSessionChanges'>;

/** The flat lanes in allocation order, for iteration and for a tally in a stable order. */
export const FLAT_LIST_ORDER: readonly StatusFlatListName[] = ALLOCATION_ORDER.filter(
  (n): n is StatusFlatListName => n !== 'activeSessionChanges',
);

/* ─────────────────────────────── The completeness inventory (#187) ───────────────────────────────
 *
 * Which `status` fields OTHER code has promised a caller are complete, so a budget landing on one
 * fails **here, at the budget**, instead of silently falsifying a sentence in another file.
 *
 * Why it exists. Two modules cut a list of their own and tell the caller that `status` holds the
 * whole of what they cut. `conflictBudget.ts` (`CONFLICT_MAX_COMMITS`) survived #175's budget
 * because that work's spec named it and a test pinned it. `peerAttribution.ts`'s refusal did not —
 * it went on claiming `status` listed the omitted paths "uncapped" for a release (#185, corrected
 * by #186). The only difference between the two was whether a human remembered the second pointer
 * existed; nothing structural stopped it, and nothing structural stopped a third.
 *
 * What the inventory is NOT. It is **not** a list of the `status` fields other code POINTS AT.
 * `otherChanges` is pointed at by `peerAttribution.ts` and is budgeted anyway, deliberately: it is
 * the list that actually blows up (an untracked `figures/` tree, a regenerated build directory),
 * and exempting it to keep a sentence true would undo most of #175 — so #186 rewrote the sentence
 * instead. A field is listed here only when another module **delegates** completeness to it: that
 * module cut something of its own and told the caller the whole of it is in this field. A pointer
 * that names a field while saying it is bounded delegates nothing, and belongs in
 * {@link STATUS_UNPROMISED_POINTERS} below, which is the other half of the same decision.
 *
 * Two compile-time guards carry most of the weight, and they are symmetric. A promise's `field` is
 * typed {@link CompleteStatusField}, which is {@link ALLOCATION_ORDER}'s lanes SUBTRACTED from the
 * budgetable fields — so adding a promised field to the allocation order stops this file compiling.
 * An unpromised pointer's `field` is typed {@link StatusListName}, the lanes themselves — so
 * REMOVING a bounded field from the allocation order (option 2 of #185, the trade to keep a
 * sentence true) stops it compiling too. Each mistake fails in the file where it is made.
 *
 * What this does NOT catch, plainly. Nothing forces the author of a **new** pointer to register it:
 * a third module can still cut its own list and point at, say, `status.conflictedChanges` without
 * touching this file, and no test will notice. What the inventory buys is that registering is one
 * line, that a registered promise then fails loudly at the budget, and that an entry says WHO
 * depends on it — so a reader can check whether the dependency still exists (`evidence` is
 * asserted against the dependent's own source in `test/unit/statusBudget.test.ts`) rather than
 * treating the list as sacred. If `conflictBudget.ts` ever stops pointing at `behindCommits`, that
 * dependent goes; if a field's last dependent goes, so does its exemption.
 */

/**
 * Every `status` field this module has an opinion about: the budgeted lanes, plus the two commit
 * lists it deliberately leaves out of the budget.
 *
 * A `status` field that is neither — `branch`, `ahead`, `syncState`, `session` — is derived from
 * what git reported and carries no document-controlled payload, so it is not this module's business
 * and is not enumerated here.
 */
export type BudgetableStatusField = StatusListName | 'aheadCommits' | 'behindCommits';

/**
 * The fields a completeness promise may name.
 *
 * Defined by SUBTRACTING {@link StatusListName} rather than listed by hand, which is the whole
 * guard: put a promised field into {@link ALLOCATION_ORDER} and it leaves this type, so the entry
 * promising it no longer typechecks. The mistake is caught in the file that makes it.
 */
export type CompleteStatusField = Exclude<BudgetableStatusField, StatusListName>;

/** One module whose own cut is honest only because a `status` field ships complete. */
export interface CompletenessDependent {
  /** POSIX path from the repo root, so a test can read the file and check the promise is still there. */
  module: string;
  /** What in `module` does the cutting — the export, or the function, that made `status` the answer. */
  cap: string;
  /**
   * A literal fragment of the promise as `module` spells it. Asserted to still appear in that
   * file: when it does not, the dependency has moved or gone, and the exemption has to be
   * re-decided rather than inherited.
   */
  evidence: string;
  /** Why that module cannot answer the question itself. */
  because: string;
}

/** One `status` field that must ship complete, and every module that depends on it. */
export interface StatusCompletenessPromise {
  field: CompleteStatusField;
  /** Never empty: a field with no dependent is a preference, not a promise, and loses its exemption. */
  dependents: readonly CompletenessDependent[];
  /** What bounds this field in practice — why the exemption is affordable rather than merely wanted. */
  affordable: string;
}

/**
 * The `status` fields other code depends on being complete. Consumed by
 * `test/unit/statusBudget.test.ts` (no listed field may be a budget lane; every dependent's promise
 * must still be in its source), `test/unit/statusPointerClaim.test.ts` (every listed field is
 * advertised, and advertised as uncapped) and `test/integration/statusCompleteness.test.ts` (every
 * listed field ships whole through a real `status` call whose other lists were cut), plus
 * `test/unit/conflictBudget.test.ts`, which asserts its own cap's delegation is registered here.
 */
export const STATUS_COMPLETENESS_PROMISES: readonly StatusCompletenessPromise[] = [
  {
    field: 'behindCommits',
    affordable:
      'Bounded by how far one clone has drifted from its remote since the last sync, which is ' +
      "the remote's commit rate — not by anything a document or a build directory controls. " +
      'The cost is stated rather than hidden: a clone hundreds of commits behind returns a large ' +
      '`structuredContent`, by decree.',
    dependents: [
      {
        module: 'src/lib/conflictBudget.ts',
        cap: 'CONFLICT_MAX_COMMITS',
        evidence: 'status.behindCommits',
        because:
          "A conflict's own `remoteCommits` is capped at 20 in both channels; the caller is told " +
          'the rest are in `status.behindCommits`, which is true only because the aborted rebase ' +
          'put the clone back at its pre-push state, so `status` still sees every one of them.',
      },
      {
        module: 'src/lib/conflictText.ts',
        cap: 'CONFLICT_COMMITS_MORE_HINT',
        evidence: 'status.behindCommits',
        because:
          'The same cap in the TEXT channel. This is the one the caller actually reads mid-' +
          'conflict, and it points here instead of at `structuredContent` precisely because ' +
          '`remoteCommits` is itself capped — `status` is the only complete list left.',
      },
      {
        module: 'src/tools/push.ts',
        cap: 'capRemoteCommits, via CONFLICT_MAX_COMMITS',
        evidence: 'status.behindCommits',
        because:
          'The advertised `remoteCommitsOmitted` description and the tool description both send a ' +
          'caller here for the commits the conflict payload left out, so the promise ships in the ' +
          "schema a model reads, not only in a result's text.",
      },
      {
        module: 'src/lib/conflictText.ts',
        cap: 'DEFAULT_COMMITS_MORE_HINT, ending the block planCommitText bounded',
        evidence: '(see structuredContent)',
        because:
          "`status`'s own `landed upstream:` block is cut to " +
          '`STATUS_COMMIT_TEXT_BUDGET` and ends by sending the caller to `structuredContent` for ' +
          'the rest — a pointer from one channel of a result into the other, false the moment the ' +
          'structured half is cut too.',
      },
    ],
  },
  {
    field: 'aheadCommits',
    affordable:
      "Bounded by how many commits this clone has made since its last push — the session's own " +
      'work, not a document-controlled list.',
    dependents: [
      {
        module: 'src/lib/conflictText.ts',
        cap: 'DEFAULT_COMMITS_MORE_HINT, ending the block planCommitText bounded',
        evidence: '(see structuredContent)',
        because:
          "`status`'s `to push:` block is cut to `STATUS_COMMIT_TEXT_BUDGET` and ends by sending " +
          'the caller to `structuredContent` for the rest. No OTHER tool delegates to ' +
          '`aheadCommits` today — it is listed because `status` itself does, in the same result.',
      },
    ],
  },
];

/** Just the promised field names, for a consumer that iterates them. */
export const COMPLETE_STATUS_FIELDS: readonly CompleteStatusField[] =
  STATUS_COMPLETENESS_PROMISES.map((p) => p.field);

/**
 * A pointer into `status` that names a **budgeted** field on purpose — the other half of the
 * inventory, and the reason it cannot be read as "every field a pointer names must be complete".
 *
 * Typed `field: StatusListName`, so an entry here stops compiling if its field ever leaves
 * {@link ALLOCATION_ORDER}: un-budgeting a list whose pointer was written to warn about the budget
 * is as much a drift as budgeting a promised one, just in the other direction.
 */
export interface UnpromisedStatusPointer {
  /** The lane the pointer names. Must be, and stay, budgeted. */
  field: StatusListName;
  /** POSIX path from the repo root of the module that names it. */
  module: string;
  /** A literal fragment of that pointer, asserted to still be in `module`'s source. */
  evidence: string;
  /** Why it stays budgeted although something points at it. */
  why: string;
}

/**
 * Pointers into `status` that carry no completeness promise, recorded so the next reader can tell
 * "budgeted, and the pointer says so" from "nobody has looked at this one yet".
 */
export const STATUS_UNPROMISED_POINTERS: readonly UnpromisedStatusPointer[] = [
  {
    field: 'otherChanges',
    module: 'src/lib/peerAttribution.ts',
    evidence: 'Those lists are budgeted too',
    why:
      'This is exactly the list that blows up, and the single largest contributor to the ' +
      'undelivered-payload failure #175 exists to stop. #185 was the refusal calling it uncapped; ' +
      '#186 fixed the sentence rather than the budget, and the sentence now names `truncated`, ' +
      '`pathsOmitted.otherChanges` and `activeSessionsOmitted` as the way to tell a complete ' +
      'answer from a cut one.',
  },
  {
    field: 'activeSessionChanges',
    module: 'src/lib/peerAttribution.ts',
    evidence: '`activeSessions[].changes`',
    why:
      'Capped per peer, and the peer list itself capped at `STATUS_MAX_SESSIONS`, for the same ' +
      'reason. The refusal points at it as one input to a subtraction and says in the same breath ' +
      'that the subtraction may run over short lists and yield a lower bound.',
  },
];

/** One peer as `status` has already assembled it, before any bound is applied. */
export interface StatusPeerInput {
  session: string;
  live: boolean;
  lastSeen: string;
  /** Every path in that peer's shadow index; `null` when the index could not be READ. */
  changes: string[] | null;
  lastWriteAt: string | null;
}

/** One peer as it will be sent, with what the budget took from it. */
export interface StatusPeerPlan extends StatusPeerInput {
  /**
   * Paths cut from `changes` by the budget. `changes: null` (unreadable) always carries 0 here —
   * unreadable is not "owns nothing" and is not a cut either, and the two must never blur.
   */
  changesOmitted: number;
}

/** The flat path lists, keyed by lane name. */
export type StatusLists = Record<StatusFlatListName, string[]>;

/** What the planner decided about one `status` result. */
export interface StatusPayloadPlan {
  /** The kept paths per lane, each a PREFIX of the input list — never reordered, never cherry-picked. */
  lists: StatusLists;
  /** The listed peers, in the input order, each with its own `changes` cut. */
  peers: StatusPeerPlan[];
  /** Paths cut per lane. Always present, every lane keyed, 0 where nothing went. */
  omitted: Record<StatusListName, number>;
  /** Peers not listed at all (see {@link STATUS_MAX_SESSIONS}) — never the same fact as `staleSessions`. */
  activeSessionsOmitted: number;
  /**
   * True iff anything at all was cut. Never inferred from an empty list: an empty list means git
   * reported nothing, and the two must stay unconfusable. Says nothing about `clean`/`ahead`/
   * `behind`/`syncState`, which come from git and are untouched by any of this.
   */
  truncated: boolean;
  /** What was cut and where to look instead. Present only when {@link truncated}. */
  note?: string;
}

export interface StatusPayloadInput extends StatusLists {
  peers: StatusPeerInput[];
}

export interface StatusPayloadOptions {
  /** Total characters across both channels. Defaults to {@link STATUS_CONTENT_BUDGET}. */
  budget?: number;
  /** Most peers listed individually. Defaults to {@link STATUS_MAX_SESSIONS}. */
  maxSessions?: number;
}

/**
 * One list line of the result text, rendered here beside the cost function that charges it so the
 * charge and the text are the same code and cannot drift (the `diffBudget.ts` technique).
 *
 * With `omitted === 0` the output is byte-for-byte what `status` has always emitted — `label: a, b`
 * — so an unbudgeted call is unchanged on the wire. The marker appears only where something went.
 */
export function renderPathListLine(
  label: string,
  paths: readonly string[],
  omitted: number,
): string {
  const body = paths.join(', ');
  return omitted > 0 ? `${label}: ${body} (+${omitted} more, not shown)` : `${label}: ${body}`;
}

/**
 * What one path costs once this server has rendered it: its JSON element in `structuredContent`
 * (escaping and all — `JSON.stringify` is the only honest measure of a path carrying a backslash or
 * a quote) plus the element comma, plus its text on the list line plus the `, ` after it. Both
 * channels ship in the same result, so they add.
 */
export function pathCost(p: string): number {
  return JSON.stringify(p).length + ELEMENT_SEPARATOR_OVERHEAD + p.length + TEXT_SEPARATOR_OVERHEAD;
}

/**
 * What one of a peer's paths costs. Past {@link STATUS_PEER_TEXT_PATHS} the text channel does not
 * render it at all (`peerDetail` says "and N more" instead), so only the JSON side is charged —
 * charging the text for a path that is never printed would cut paths to pay for nothing.
 */
export function peerPathCost(p: string, shownInText: boolean): number {
  const json = JSON.stringify(p).length + ELEMENT_SEPARATOR_OVERHEAD;
  return shownInText ? json + p.length + TEXT_SEPARATOR_OVERHEAD : json;
}

/**
 * What one listed peer costs before any of its paths: the JSON record `status` emits for it (minus
 * the `changes` elements) plus its text segment. Charged as MANDATORY before any lane is allocated,
 * because a peer listed without its identity is not a peer anyone can act on — bounded by
 * {@link STATUS_MAX_SESSIONS}, which is what keeps this from eating the budget.
 */
export function peerIdentityCost(p: StatusPeerInput): number {
  const json = JSON.stringify({
    session: p.session,
    live: p.live,
    lastSeen: p.lastSeen,
    changes: p.changes === null ? null : [],
    lastWriteAt: p.lastWriteAt,
    changesOmitted: 0,
  }).length;
  return json + ELEMENT_SEPARATOR_OVERHEAD + p.session.length + PEER_TEXT_IDENTITY_OVERHEAD;
}

/**
 * Plan which paths fit.
 *
 * Peers are capped first (see {@link STATUS_MAX_SESSIONS}) and their identities charged as mandatory
 * content. What is left is then spent in **two passes over {@link ALLOCATION_ORDER}**, and the
 * second pass alone is not enough:
 *
 *  - **Pass 1 gives every lane an equal guaranteed share** (the remaining budget divided by the
 *    number of lanes). Strict priority on its own starves a lane whose predecessor is large — and in
 *    the case this module exists for they are large *for the same reason*: a 400-file untracked tree
 *    lands in `externalChanges`, `otherChanges` and `untracked` at once, and spending top-to-bottom
 *    left the last two with the one path keep-at-least-one forced. A `status` reporting 1 of 400
 *    files changed by others is not a bounded report, it is a wrong one. This is the same shape as
 *    `commentsBudget.ts`'s first pass, which pays every comment's identity before any comment's
 *    quote.
 *  - **Pass 2 spends everything left in strict priority**, resuming each lane where pass 1 stopped.
 *    A lane that wanted less than its share leaves the surplus to the lanes above it, so in the
 *    ordinary case — one big list, the rest small — the big list still gets almost the whole budget.
 *
 * Within a lane the paths are charged in the order given, and the kept part is a **prefix**: nothing
 * is reordered and the cheap ones are never preferred, because a cherry-picked list is a different
 * answer to the question asked (the rule `floatsBudget.ts`, `searchBudget.ts` and `diffBudget.ts`
 * all keep).
 *
 * **Keep-at-least-one, and here it is load-bearing rather than a courtesy.** A non-empty lane always
 * keeps its first path, because `untracked: []` is the answer "git reported nothing untracked" and
 * the budget must never be able to forge it. The same rule applies per peer, where the forged answer
 * would be worse still: a readably-empty `changes` is the "nothing recorded" state that `peerDetail`
 * renders in words and that `splitStalePeers` reads, and neither must ever be told that by a cut. It
 * runs **after** both passes so it can never consume a share another lane was owed, and the running
 * total absorbs the full cost, so the overrun is bounded by one path per list plus one per peer.
 */
export function planStatusPayload(
  input: StatusPayloadInput,
  opts: StatusPayloadOptions = {},
): StatusPayloadPlan {
  const budget = opts.budget ?? STATUS_CONTENT_BUDGET;
  const maxSessions = opts.maxSessions ?? STATUS_MAX_SESSIONS;

  const keptPeers = selectPeers(input.peers, maxSessions);
  const activeSessionsOmitted = input.peers.length - keptPeers.length;
  const peers: StatusPeerPlan[] = keptPeers.map((p) => ({ ...p, changesOmitted: 0 }));

  let remaining = Math.max(budget - STATUS_JSON_SCAFFOLD_OVERHEAD - STATUS_NOTE_RESERVE, 0);
  for (const p of keptPeers) remaining -= peerIdentityCost(p);

  // One unit per thing that is cut independently: a flat list is one unit, and every listed peer's
  // `changes` is its own unit inside the `activeSessionChanges` lane, so one talkative peer cannot
  // consume the share of the next.
  const units: Record<StatusListName, Unit[]> = {
    conflictedChanges: [flatUnit(input.conflictedChanges)],
    externalChanges: [flatUnit(input.externalChanges)],
    sessionChanges: [flatUnit(input.sessionChanges)],
    otherChanges: [flatUnit(input.otherChanges)],
    activeSessionChanges: peers
      .filter((p) => p.changes !== null)
      .map((p) => ({ source: p.changes!, kept: [], cost: peerCostAt })),
    staged: [flatUnit(input.staged)],
    unstaged: [flatUnit(input.unstaged)],
    untracked: [flatUnit(input.untracked)],
  };

  // Two passes. The first gives every lane an equal guaranteed share; the second spends whatever is
  // left in strict {@link ALLOCATION_ORDER}. See the doc comment above for why neither alone does.
  const share = Math.floor(Math.max(remaining, 0) / ALLOCATION_ORDER.length);
  for (const pass of [share, Number.POSITIVE_INFINITY]) {
    for (const lane of ALLOCATION_ORDER) {
      let laneRemaining = Math.min(Math.max(remaining, 0), pass);
      for (const unit of units[lane]) {
        while (unit.kept.length < unit.source.length) {
          const cost = unit.cost(unit.source[unit.kept.length]!, unit.kept.length);
          if (cost > laneRemaining) break;
          laneRemaining -= cost;
          remaining -= cost;
          unit.kept.push(unit.source[unit.kept.length]!);
        }
        if (laneRemaining <= 0) break;
      }
    }
  }

  // Keep-at-least-one, applied after both passes so it can never consume a share another lane was
  // owed. It is allowed to overrun, by at most one path per unit — a bound worth paying, because the
  // alternative is a budget that can forge "git reported nothing" (or "this peer recorded nothing").
  for (const lane of ALLOCATION_ORDER) {
    for (const unit of units[lane]) {
      if (unit.kept.length === 0 && unit.source.length > 0) {
        remaining -= unit.cost(unit.source[0]!, 0);
        unit.kept.push(unit.source[0]!);
      }
    }
  }

  const omitted: Record<StatusListName, number> = {
    conflictedChanges: 0,
    externalChanges: 0,
    sessionChanges: 0,
    otherChanges: 0,
    activeSessionChanges: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
  };
  for (const lane of ALLOCATION_ORDER) {
    for (const unit of units[lane]) omitted[lane] += unit.source.length - unit.kept.length;
  }

  const lists: StatusLists = {
    conflictedChanges: units.conflictedChanges[0]!.kept,
    externalChanges: units.externalChanges[0]!.kept,
    sessionChanges: units.sessionChanges[0]!.kept,
    otherChanges: units.otherChanges[0]!.kept,
    staged: units.staged[0]!.kept,
    unstaged: units.unstaged[0]!.kept,
    untracked: units.untracked[0]!.kept,
  };
  let unit = 0;
  for (const peer of peers) {
    if (peer.changes === null) continue;
    const u = units.activeSessionChanges[unit]!;
    unit += 1;
    peer.changesOmitted = u.source.length - u.kept.length;
    peer.changes = u.kept;
  }

  const truncated = activeSessionsOmitted > 0 || ALLOCATION_ORDER.some((l) => omitted[l] > 0);
  const plan: StatusPayloadPlan = {
    lists,
    peers,
    omitted,
    activeSessionsOmitted,
    truncated,
  };
  if (truncated) plan.note = buildStatusNote(plan, { budget, maxSessions });
  return plan;
}

/**
 * One independently-cut run of paths mid-plan: where they come from, what has been kept so far, and
 * what the next one costs. `cost` takes the index within the run because a peer's path is charged
 * for the text channel only while the text still renders it ({@link peerPathCost}).
 */
interface Unit {
  source: readonly string[];
  kept: string[];
  cost: (path: string, index: number) => number;
}

function flatUnit(source: readonly string[]): Unit {
  return { source, kept: [], cost: (p) => pathCost(p) };
}

function peerCostAt(path: string, index: number): number {
  return peerPathCost(path, index < STATUS_PEER_TEXT_PATHS);
}

/**
 * Which peers are listed when there are more than `maxSessions` of them: live peers first, then the
 * most recently seen, because a live peer is the one whose lines this session can still collide with
 * and a recent heartbeat is the only evidence available about the rest. Selection order only — the
 * kept peers are returned in the ORIGINAL order, since selection order and presentation order answer
 * different questions (`fileListBudget.ts` makes the same split).
 *
 * An unparseable `lastSeen` sorts last rather than first: the same sign `isStalePeer` uses for a
 * non-finite age, where granting the benefit of the doubt would be an assertion the data does not
 * support.
 */
function selectPeers(peers: readonly StatusPeerInput[], maxSessions: number): StatusPeerInput[] {
  if (peers.length <= maxSessions) return [...peers];
  const seenAt = (p: StatusPeerInput): number => {
    const ms = Date.parse(p.lastSeen);
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
  };
  const ranked = peers
    .map((peer, index) => ({ peer, index }))
    .sort(
      (a, b) =>
        Number(b.peer.live) - Number(a.peer.live) ||
        seenAt(b.peer) - seenAt(a.peer) ||
        a.index - b.index,
    )
    .slice(0, maxSessions)
    .sort((a, b) => a.index - b.index);
  return ranked.map((r) => r.peer);
}

/** `untracked 412, unstaged 3`, in allocation order, listing only what was actually cut. */
function tallyText(omitted: Record<StatusListName, number>): string {
  return ALLOCATION_ORDER.filter((lane) => omitted[lane] > 0)
    .map((lane) => `${lane} ${omitted[lane]}`)
    .join(', ');
}

/**
 * The `note`, naming ONLY the bound that actually fired — reporting a cap that did not fire sends the
 * reader looking for a cause that is not there (`conflictBudget.ts`'s rule for its three caps).
 *
 * It states plainly that the omitted paths are in **neither** channel, because unlike a conflict
 * side there is no `read_file` that fetches them back; the routes named are the ones that actually
 * enumerate the same ground (`list_files` for untracked paths, `diff` for tracked ones).
 *
 * Exported so a test can charge the WORST note this module can produce — every counter at seven
 * digits, both causes firing at once — against {@link STATUS_NOTE_RESERVE}, which is the pin that
 * lets the planner withhold a flat allowance instead of charging the note per-part.
 */
export function buildStatusNote(
  plan: StatusPayloadPlan,
  ctx: { budget: number; maxSessions: number },
): string {
  const paths = ALLOCATION_ORDER.reduce((n, lane) => n + plan.omitted[lane], 0);
  const causes: string[] = [];
  if (paths > 0) {
    causes.push(
      `${paths} path(s) omitted: the ${ctx.budget}-char payload budget was reached (charged ` +
        `across both channels: the JSON arrays and the rendered text lines); omitted by list: ` +
        `${tallyText(plan.omitted)}`,
    );
  }
  if (plan.activeSessionsOmitted > 0) {
    causes.push(
      `${plan.activeSessionsOmitted} other session(s) not listed: at most ${ctx.maxSessions} are ` +
        `reported individually (live sessions first, then the most recently seen) — this is not ` +
        `the same as staleSessions, which counts sessions that recorded nothing`,
    );
  }
  return (
    `${causes.join('. ')}. Lists are kept in this priority order — ${ALLOCATION_ORDER.join(', ')} ` +
    `— so what blocks a commit survives a cut and the untracked tree is what goes. Omitted paths ` +
    `are in neither channel: use list_files for untracked paths and diff for tracked ones. ` +
    `branch, clean, ahead, behind, syncState, aheadCommits and behindCommits are unaffected — ` +
    `they come from git, not from this list.`
  );
}

/** What {@link planCommitText} decided about one commit block's TEXT rendering. */
export interface CommitTextPlan {
  /**
   * The same commits, in the same order and the same number, with any over-long `message` clipped.
   * Never the input objects mutated — a clipped commit is a fresh object, so `structuredContent`
   * keeps the real message.
   */
  commits: RemoteCommit[];
  /** What to pass `renderCommitLines` as `maxCommits`; 0 when there are no commits. */
  maxCommits: number;
  /** Commits whose message was clipped for the text. The full message ships in `structuredContent`. */
  messagesClipped: number;
}

/**
 * One commit block as the text channel renders it, through the shared `renderCommitLines` — which is
 * what {@link planCommitText} charges, so the plan and the render are the same call and cannot drift.
 *
 * `renderCommitLines`' own trailing "… N more commit(s) (see structuredContent)" line is the whole
 * reason a smaller `maxCommits` is safe here: `status`'s structured commit lists are complete, so
 * that default pointer is true for this caller (`DEFAULT_COMMITS_MORE_HINT`, `conflictText.ts`).
 */
export function renderCommitBlock(plan: CommitTextPlan): string[] {
  return renderCommitLines(plan.commits, { maxCommits: plan.maxCommits });
}

/**
 * Bound ONE commit block in the TEXT channel — and only there.
 *
 * `renderCommitLines` already caps at `CONFLICT_MAX_COMMITS` commits of `CONFLICT_MAX_COMMIT_FILES`
 * files, which bounds the line COUNT but not the size: `message` and the file paths come from the
 * remote, so twenty commits of multi-kilobyte subjects render to whatever the remote wrote. So each
 * message is clipped at {@link STATUS_COMMIT_MESSAGE_CAP} and the commit count is then lowered until
 * the rendered block fits {@link STATUS_COMMIT_TEXT_BUDGET} — at least one commit always survives,
 * since a block that names nothing tells the caller nothing.
 *
 * Nothing here is a cut from the RESULT: `structuredContent.behindCommits`/`aheadCommits` stay
 * complete and untouched, which is the invariant `conflictBudget.ts` depends on. That is why this
 * returns no `…Omitted` counter — there is nothing omitted to count, only something not re-rendered.
 */
export function planCommitText(
  commits: readonly RemoteCommit[],
  opts: { budget?: number; messageCap?: number; maxCommits?: number } = {},
): CommitTextPlan {
  const budget = opts.budget ?? STATUS_COMMIT_TEXT_BUDGET;
  const messageCap = opts.messageCap ?? STATUS_COMMIT_MESSAGE_CAP;
  const ceiling = opts.maxCommits ?? CONFLICT_MAX_COMMITS;

  let messagesClipped = 0;
  const clipped = commits.map((c) => {
    const cut = clipText(c.message, messageCap);
    if (cut.omitted === 0) return c;
    messagesClipped += 1;
    return { ...c, message: cut.text };
  });

  let maxCommits = Math.min(clipped.length, ceiling);
  while (
    maxCommits > 1 &&
    renderCommitBlock({ commits: clipped, maxCommits, messagesClipped }).join('\n').length > budget
  ) {
    maxCommits -= 1;
  }
  return { commits: clipped, maxCommits, messagesClipped };
}

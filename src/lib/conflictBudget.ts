import type { ConflictHunk } from './conflictParser.js';
import type { ConflictFileDetail } from '../services/gitService.js';

/**
 * Deciding which parts of a rebase conflict report may be inlined in full, against a character
 * budget shared by BOTH output channels — the model-visible text (`conflictText.ts`) and
 * `structuredContent.conflictFiles` (`src/tools/push.ts`). Pulled out as a pure planner, the same
 * shape as `src/lib/inlineBudget.ts` solves for `render_pages`: a budget, a plan, a human-readable
 * `note`, and a tool layer that only maps the plan onto response shapes.
 *
 * Why this exists: a rebase conflict on one ~20k-character file produced a ~67k-character tool
 * result — past a client's result cap, so it was never delivered. The offending weight was almost
 * entirely `base`/`ours`/`theirs`/`hunks` (96.6% of it); the fields a caller actually needs to act
 * (`remoteHead`, `mergeBase`, `conflictPaths`, `remoteCommits`) were a few percent, buried
 * underneath. Two bugs compounded: the per-side cap that already existed in the text channel
 * (`INLINE_CAP`, now `CONFLICT_SIDE_CAP`) was never applied to `structuredContent` at all, and
 * even in the text channel it capped one side of one file in isolation — a 10-file conflict, or
 * ten oversized `hunks` blocks, had no aggregate ceiling.
 *
 * A second round of bugs surfaced once real multi-file/multi-hunk conflicts were measured: the
 * budget above counted only `local`/`remote`/`base`/`ours`/`theirs` *content* — never the marker
 * boilerplate `renderHunkMarkers` wraps around every hunk, the JSON punctuation
 * `structuredContent` wraps around every hunk and array element, or the per-file header / per-side
 * label lines. 10 files × 200 tiny hunks rendered 64,361 characters of text — right back at the
 * size that failed — because ~55 chars/hunk of boilerplate in the text channel (and a
 * similar-order amount of JSON punctuation in the structured channel) went entirely unbudgeted.
 * Separately, nothing capped the number of *files* detailed: 250 conflicted files with one tiny
 * hunk each rendered 50,501 characters of pure per-file headers and elision pointers, with
 * `truncated: false` — pure structural overhead, no content, and no reported ceiling. Both are
 * fixed here: the allocation decisions below are against the *rendered* size of each part (content
 * plus its named overhead), not the raw content size, and a hard cap
 * (`CONFLICT_MAX_FILES`) bounds how many files ever get a detailed per-file block — the rest stay
 * listed (uncapped) in the top-level `conflictPaths` only.
 *
 * A third round: `structuredContent` is JSON, and `JSON.stringify` expands every `\`, `"`, literal
 * newline, and control character in a side's or a hunk line's content — LaTeX is backslash-dense,
 * so a content-length charge alone can under-count by a wide margin (a control-character-heavy
 * side measured 6× its raw length once escaped). Every content charge below is now the real
 * `JSON.stringify` cost, not raw `content.length`. Separately, the elision boilerplate itself —
 * the `(N chars, elided — read_file(...))` pointer, and an elided `hunks` block's line-span list —
 * was charged **zero**, so a conflict where *nothing* fits (every side oversized, every hunks
 * block starved) still rendered tens of thousands of characters of pure "here's what got cut"
 * text. Both are fixed the same way as everything else here: named overhead constants, or (where
 * the shape is structural rather than a flat template — a hunk's JSON, an elided hunk block's
 * spans/count) the exact `JSON.stringify` of what will actually be sent, charged against the same
 * shared budget so eliding something no longer "costs nothing" and staying silent forever.
 */

/**
 * Per-side cap: above this many characters, ONE side of ONE file is elided even if the total
 * budget below would otherwise allow it. This is the same value the text channel already enforced
 * as `INLINE_CAP` before this module existed — kept here as the single source so `conflictText.ts`
 * cannot drift from what `push.ts` enforces on the structured channel.
 */
export const CONFLICT_SIDE_CAP = 12000;

/**
 * Total character budget across every file's `hunks` + `base` + `ours` + `theirs` combined —
 * charged at their RENDERED size (content plus the overhead constants below), not raw content, so
 * this is actually a bound on what the caller receives rather than on an internal accounting
 * fiction. Sized so the worst case lands well under the ~67k that originally failed.
 */
export const CONFLICT_CONTENT_BUDGET = 20000;

/**
 * Hard cap on how many conflicted files ever get a detailed per-file block (hunks/base/ours/
 * theirs, elided or not). Files past this cap get NO per-file block at all — not even an elided
 * placeholder — but remain fully present in the top-level `conflictPaths`, which is never capped.
 * 20 matches the house style for capped lists elsewhere in this codebase (`capList` in
 * `gitService.ts`). Without this, a conflict touching hundreds of files produces hundreds of
 * headers and pointers with no content in them at all — pure structural overhead that the
 * per-part budget above never sees, because there is no "part" to elide, only a block to omit
 * entirely.
 */
export const CONFLICT_MAX_FILES = 20;

/** Cap on how many line spans an elided `hunks` block reports (its own `count` still reports the
 * true, uncapped number of hunks) — eliding hunks to save space must not itself emit an unbounded
 * array of spans. Mirrors `capList`'s style elsewhere in this codebase. */
export const CONFLICT_MAX_SPANS = 20;

/**
 * Cap on how many of a conflict's `remoteCommits` ever get a detailed entry in EITHER channel —
 * `renderCommitLines`'s (`conflictText.ts`) own long-standing default for the text channel,
 * pulled out and named so `structuredContent.remoteCommits` (`push.ts`, via `capRemoteCommits`)
 * cannot drift from what the text channel already caps at. Commits beyond this stay uncapped in
 * `status.behindCommits`, since the clone is back at its pre-push state after a conflict aborts
 * the rebase — that field lists every one of them.
 */
export const CONFLICT_MAX_COMMITS = 20;

/**
 * Cap on how many files ONE remote commit's `files` list shows in either channel — also
 * `renderCommitLines`'s existing text-channel default, named for the same reason as
 * `CONFLICT_MAX_COMMITS`. A commit past this cap still names how many more via `filesOmitted`
 * (structured) or a "… N more file(s)" line (text); the full list is one `diff` call away
 * (`ref: "<hash>~1..<hash>"`).
 */
export const CONFLICT_MAX_COMMIT_FILES = 5;

/**
 * Literal characters `renderHunkMarkers` (`conflictText.ts`) wraps around ONE hunk's `local`/
 * `remote` content in the text channel — `<<<<<<< ours (lines X-Y)` / `=======` /
 * `>>>>>>> theirs` plus the newlines joining them to the content — EXCLUDING the digits of
 * `startLine`/`endLine` (charged separately below, exactly, since the planner knows their real
 * width) and excluding the content itself. Pinned by a test in `conflictText.test.ts` that renders
 * a known hunk and checks this constant still accounts for the whole boilerplate, so a future edit
 * to `renderHunkMarkers` that changes this text is caught here — not discovered as a silent
 * under-count weeks later.
 */
export const HUNK_MARKER_OVERHEAD = 47;

/**
 * Literal characters one hunk costs once JSON-encoded as an entry of
 * `structuredContent.conflictFiles[].hunks` — the `{"startLine":,"endLine":,"local":[],
 * "remote":[]}` key names and punctuation — EXCLUDING the `startLine`/`endLine` digits (charged
 * exactly, as for the text channel) and excluding the per-element quoting cost of the `local`/
 * `remote` arrays (`HUNK_LINE_ELEMENT_OVERHEAD` below). Pinned alongside `HUNK_MARKER_OVERHEAD`.
 */
export const HUNK_JSON_OVERHEAD = 48;

/** Extra characters ONE string element of a hunk's `local`/`remote` array costs once JSON-encoded
 * — the two quote characters `JSON.stringify` adds around it (the array-separator comma is
 * already accounted for: it costs exactly as much as the `\n` `.join('\n')` uses to measure
 * content, so it falls out of the content-length term instead). */
export const HUNK_LINE_ELEMENT_OVERHEAD = 2;

/** Literal characters of the file separator header line in the text channel
 * (`━━━━━ ${path} ━━━━━`), excluding the path itself (charged exactly, via its own length, since
 * paths vary). This line renders for every file inside `CONFLICT_MAX_FILES`, whether or not
 * anything inside that file ends up elided — so it is charged unconditionally, up front. */
export const FILE_HEADER_OVERHEAD = 12;

/**
 * Literal characters of one side's label line when rendered in full (`${label}:\n`) in the text
 * channel. The three labels differ in length ("base (common ancestor)" / "ours (local)" /
 * "theirs (remote that landed)"); this uses the longest of them plus `:\n` so one constant safely
 * covers all three without under-counting.
 */
export const SIDE_LABEL_OVERHEAD = 'theirs (remote that landed)'.length + ':\n'.length;

/**
 * The same literal used to derive `SIDE_LABEL_OVERHEAD` above, kept as its own name for the
 * elision-line constant below — duplicated here (rather than imported from `conflictText.ts`'s
 * `SIDE_LABELS`) so this module never imports from `conflictText.ts`, which already imports from
 * here; a circular import between the two would follow otherwise.
 */
const LONGEST_SIDE_LABEL = 'theirs (remote that landed)';

/**
 * Literal characters `renderSide`'s ELIDED branch wraps around one side — `${label}: (` + the
 * `chars` digits + ` chars, elided — ` + the hint + `)` — sized against the longest label (so a
 * shorter one never under-counts, same technique as `SIDE_LABEL_OVERHEAD`), EXCLUDING the digits
 * of `chars` and the hint text (charged exactly, via {@link sideElisionHint}: the `read_file(...)`
 * pointer's real length when a ref exists, or the no-merge-base hint's real length — which varies
 * by whether the file's hunks are actually on screen — when it does not). Pinned against the real
 * `renderSide` output in `conflictText.test.ts`.
 */
export const SIDE_ELISION_OVERHEAD =
  LONGEST_SIDE_LABEL.length + ': ('.length + ' chars, elided — '.length + ')'.length;

/**
 * Literal characters `renderHunksBlock`'s ELIDED branch wraps around one file's hunks —
 * `overlap: (` + the `count` digits + ` hunk(s), ` + the `chars` digits + ` chars, elided — ` +
 * the span text + `; fetch base/ours/theirs to reconstruct the merge)` — EXCLUDING the `count`/
 * `chars` digits and the span text (both charged exactly: {@link renderElidedHunkSpans} produces
 * the exact text, so its length is measured directly rather than approximated). Pinned against the
 * real `renderHunksBlock` output in `conflictText.test.ts`.
 */
export const HUNK_ELISION_TEXT_OVERHEAD = 87;

/**
 * Text hint for `base`'s elision when there is no merge base (unrelated histories) AND this file's
 * hunks block is NOT rendered (elided, or the file has no hunks at all) — pointing at "the overlap
 * markers above" would be dead advice, since nothing is on screen for it to point at. This is also
 * the structured channel's `elided.base.ref` in EVERY no-merge-base case (see
 * {@link sideElisionHint}), so both channels agree on the bare fact even where the text
 * additionally mentions markers below.
 */
const NO_MERGE_BASE_HINT = 'no merge base (unrelated histories)';

/**
 * Text hint for `base`'s elision when there is no merge base (unrelated histories) but this file's
 * hunks block IS rendered alongside it (full overlap markers, not the elided placeholder, not an
 * empty `hunks: []`) — pointing at "the overlap markers above" refers to something actually on
 * screen. States the no-merge-base fact too, so the text is never silent about why `base` has no
 * ref of its own.
 */
const NO_MERGE_BASE_TEXT_HINT_WITH_MARKERS =
  'see the overlap markers above (no merge base — unrelated histories)';

/** The two top-level refs an elided side's `read_file(path, ref=...)` pointer embeds (`ours`
 * always reads `HEAD`, no ref of the report's own needed). Passed into the planner so it can
 * charge the pointer's REAL length — the same value `conflictText.ts` renders — instead of
 * guessing a length for a git ref name that has no fixed width. */
export interface ConflictRefs {
  mergeBase: string | null;
  rebasedOnto: string;
}

export type ConflictSideKey = 'base' | 'ours' | 'theirs';

/**
 * The `read_file(path, ref=...)` call that fetches one side of one conflicted file in full —
 * shared by the text hint (`renderConflictText`'s `baseHint`, and the `ours`/`theirs` hints) and
 * the structured `elided.<key>.ref` (`buildConflictFilePayload`'s `sideRef`), so both channels name
 * the exact same call and this module's cost accounting can charge its exact length. `null` only
 * for `base` with no merge base (unrelated histories) — {@link sideElisionHint} below supplies the
 * shared fallback in that case.
 */
export function readFileRefCall(
  path: string,
  key: ConflictSideKey,
  refs: ConflictRefs,
): string | null {
  if (key === 'ours') return `read_file("${path}", ref="HEAD")`;
  if (key === 'theirs') return `read_file("${path}", ref="${refs.rebasedOnto}")`;
  return refs.mergeBase ? `read_file("${path}", ref="${refs.mergeBase}")` : null;
}

/** The elision hint for one side of one file, in both channels — see {@link sideElisionHint}. */
export interface SideElisionHint {
  text: string;
  json: string;
}

/**
 * The hint an elided side shows in both channels: {@link readFileRefCall}'s pointer when a ref
 * exists, or — for `base` alone, when there is no merge base (unrelated histories) — the honest
 * no-merge-base wording. Shared by the render side (`conflictText.ts`'s `renderSide`/
 * `buildConflictFilePayload` calls) and the cost side ({@link sideElisionCost} below) the same way
 * {@link readFileRefCall} and {@link renderElidedHunkSpans} are, so the two can never select
 * different text for the same input.
 *
 * `hunksRendered` says whether THIS file's `hunks` block is showing full overlap markers on screen
 * right now — not merely present in the source, and not the elided placeholder or an empty
 * `hunks: []` — because only then does "see the overlap markers above" point at something real.
 * The JSON hint never varies with it: the structured channel states the bare fact regardless, so
 * both channels agree on WHAT happened even when the text additionally explains where to look.
 * Irrelevant to `ours`/`theirs` (whose ref is never null), but required of every caller regardless,
 * so a future call site cannot silently pick the wrong branch by omitting it.
 */
export function sideElisionHint(
  path: string,
  key: ConflictSideKey,
  refs: ConflictRefs,
  hunksRendered: boolean,
): SideElisionHint {
  const ref = readFileRefCall(path, key, refs);
  if (ref) return { text: ref, json: ref };
  // Only `base` with no merge base ever reaches here — readFileRefCall never returns null for
  // ours/theirs.
  return {
    text: hunksRendered ? NO_MERGE_BASE_TEXT_HINT_WITH_MARKERS : NO_MERGE_BASE_HINT,
    json: NO_MERGE_BASE_HINT,
  };
}

/**
 * `lines X-Y` per elided span, comma-joined, plus the `, +N more` suffix once `count` exceeds how
 * many spans survived the `CONFLICT_MAX_SPANS` cap — the exact text `renderHunksBlock` shows for
 * an elided `hunks` block. Exported so both the render side (`conflictText.ts`) and the cost side
 * (this module, for `HUNK_ELISION_TEXT_OVERHEAD`'s accompanying charge) produce/measure the same
 * string and can never drift apart.
 */
export function renderElidedHunkSpans(
  spans: Array<{ startLine: number; endLine: number }>,
  count: number,
): string {
  const spansText = spans.map((s) => `lines ${s.startLine}-${s.endLine}`).join(', ');
  const more = count > spans.length ? `, +${count - spans.length} more` : '';
  return `${spansText}${more}`;
}

/**
 * Extra characters `JSON.stringify` adds to `s` beyond its raw length and the two wrapping quotes
 * it always adds — i.e. what backslashes, double quotes, literal newlines, and control characters
 * cost once escaped. Zero for plain text; the reason a content-length-only charge under-counts
 * escape-heavy content (LaTeX is backslash-dense).
 */
function jsonEscapeOverhead(s: string): number {
  return JSON.stringify(s).length - s.length - 2;
}

/** Whether one part of one file is included in full, and its TRUE character count either way. */
export interface ConflictPartPlan {
  included: boolean;
  /**
   * The part's real CONTENT size (never the rendered-with-overhead cost used to decide inclusion,
   * and never a truncated/elided payload) — what a caller re-fetching it via `read_file` would
   * actually receive.
   */
  chars: number;
}

/** The `hunks` part carries extra context an elided render needs: how many, and where. */
export interface ConflictHunksPartPlan extends ConflictPartPlan {
  count: number;
  /** Capped at `CONFLICT_MAX_SPANS` — `count` above still reports the true, uncapped total. */
  spans: Array<{ startLine: number; endLine: number }>;
}

export interface ConflictFilePlan {
  path: string;
  /**
   * Allocated FIRST and cut LAST: once the rebase aborts, the marker file is gone from the working
   * tree, so a caller cannot cheaply re-derive the hunks — they would have to fetch all three sides
   * and perform their own 3-way merge. Hunks are the least recoverable part of the payload.
   */
  hunks: ConflictHunksPartPlan;
  /**
   * Cut FIRST: each side is recoverable in one call via `read_file(path, ref)` — `mergeBase`/
   * `HEAD`/`rebasedOnto` are exact refs, already present at the top level of the report.
   */
  base: ConflictPartPlan;
  ours: ConflictPartPlan;
  theirs: ConflictPartPlan;
}

export interface ConflictPayloadPlan {
  files: ConflictFilePlan[];
  /** True iff anything anywhere was elided OR any file was dropped by `CONFLICT_MAX_FILES`. */
  truncated: boolean;
  /** Human-readable explanation of what was cut and how to get it back; undefined when nothing was. */
  note?: string;
  /**
   * Paths of conflicted files beyond `CONFLICT_MAX_FILES` that got no per-file block at all. They
   * remain fully present in the report's own (never-capped) `conflictPaths` — this is only here so
   * `conflictText.ts` can say how many were omitted. Undefined in `detail: 'full'` and whenever
   * every file fit under the cap.
   */
  omittedFiles?: string[];
}

function fullHunkSpans(hunks: ConflictHunk[]): Array<{ startLine: number; endLine: number }> {
  return hunks.map((h) => ({ startLine: h.startLine, endLine: h.endLine }));
}

/** Capped at `CONFLICT_MAX_SPANS` — used only in `detail: 'auto'`, where eliding hunks to save
 * space must not itself emit an unbounded array. */
function hunkSpans(hunks: ConflictHunk[]): Array<{ startLine: number; endLine: number }> {
  return hunks
    .slice(0, CONFLICT_MAX_SPANS)
    .map((h) => ({ startLine: h.startLine, endLine: h.endLine }));
}

/** True CONTENT cost of a file's `hunks` — the overlap content itself, never the marker/JSON
 * boilerplate (that's `hunksRenderCost` below). This is what `ConflictHunksPartPlan.chars` reports. */
function hunksChars(hunks: ConflictHunk[]): number {
  return hunks.reduce((sum, h) => sum + h.local.join('\n').length + h.remote.join('\n').length, 0);
}

/** Sum of {@link jsonEscapeOverhead} over every element of a hunk's `local` or `remote` array —
 * escaping is purely per-character, so summing per element (rather than over the whole array
 * joined together) gives the exact total extra cost JSON-encoding each line as its own array
 * element adds, on top of the per-element quote pair `HUNK_LINE_ELEMENT_OVERHEAD` already charges. */
function lineArrayEscapeOverhead(lines: string[]): number {
  return lines.reduce((sum, l) => sum + jsonEscapeOverhead(l), 0);
}

/**
 * What ONE hunk actually costs once rendered, in the more expensive of the two channels — content
 * plus the digits of its own `startLine`/`endLine` plus whichever of the text-marker or
 * JSON-encoding overhead is larger. Taking the max (rather than summing, or picking one channel)
 * means a single shared budget bounds BOTH channels, since they're built from the same plan.
 *
 * The JSON side additionally charges the real escaping cost of every `local`/`remote` line
 * (backslashes, quotes, literal newlines, control characters) — without it, a hunk whose lines are
 * escape-heavy could be "at budget" by raw content length while its real JSON-encoded size runs
 * well past it.
 */
function hunkRenderCost(h: ConflictHunk): number {
  const contentChars = h.local.join('\n').length + h.remote.join('\n').length;
  const digits = String(h.startLine).length + String(h.endLine).length;
  const lineElements = h.local.length + h.remote.length;
  const textCost = contentChars + digits + HUNK_MARKER_OVERHEAD;
  const escapeOverhead = lineArrayEscapeOverhead(h.local) + lineArrayEscapeOverhead(h.remote);
  const jsonCost =
    contentChars +
    digits +
    HUNK_JSON_OVERHEAD +
    lineElements * HUNK_LINE_ELEMENT_OVERHEAD +
    escapeOverhead;
  return Math.max(textCost, jsonCost);
}

/** Rendered cost of a whole file's `hunks` block: each hunk's own cost plus the `\n`/`,` join
 * separators between them (one character each, same order in both channels). */
function hunksRenderCost(hunks: ConflictHunk[]): number {
  if (hunks.length === 0) return 0;
  const perHunk = hunks.reduce((sum, h) => sum + hunkRenderCost(h), 0);
  return perHunk + (hunks.length - 1);
}

function fullHunksPlan(hunks: ConflictHunk[]): ConflictHunksPartPlan {
  return {
    included: true,
    chars: hunksChars(hunks),
    count: hunks.length,
    spans: fullHunkSpans(hunks),
  };
}

function fullSidePlan(content: string | null): ConflictPartPlan {
  return { included: true, chars: content?.length ?? 0 };
}

function fullFilePlan(f: ConflictFileDetail): ConflictFilePlan {
  return {
    path: f.path,
    hunks: fullHunksPlan(f.hunks),
    base: fullSidePlan(f.base),
    ours: fullSidePlan(f.ours),
    theirs: fullSidePlan(f.theirs),
  };
}

const SIDE_KEYS: readonly ConflictSideKey[] = ['base', 'ours', 'theirs'];

/**
 * What eliding a file's whole `hunks` block actually costs to render — the note naming how many
 * hunks and where, in the more expensive of the two channels. Charged against the SAME budget as
 * inclusion (see {@link planConflictPayload}'s note on charging elision) so a run of starved,
 * all-elided files cannot render an unbounded amount of "here's what got cut" boilerplate for
 * free.
 */
function hunksElisionCost(
  count: number,
  chars: number,
  spans: Array<{ startLine: number; endLine: number }>,
): number {
  const spansText = renderElidedHunkSpans(spans, count);
  const textCost =
    HUNK_ELISION_TEXT_OVERHEAD + String(count).length + String(chars).length + spansText.length;
  // The structured shape is exactly `elided.hunks` in `buildConflictFilePayload` — measuring the
  // real JSON.stringify of that shape is exact by construction, the same technique Finding 1 uses
  // for escape-heavy content, and avoids hand-decomposing a nested array-of-objects into constants.
  const jsonCost = JSON.stringify({ chars, count, spans }).length;
  return Math.max(textCost, jsonCost);
}

/**
 * What eliding one side of one file actually costs to render — the `(N chars, elided —
 * read_file(...))` pointer (text) or the `elided.<key>` entry (structured), in the more expensive
 * of the two channels. Charged against the same budget as inclusion for the same reason as
 * {@link hunksElisionCost}. `hunksRendered` is threaded through to {@link sideElisionHint} so the
 * charge reflects whichever hint text will actually be rendered for `base` when there is no merge
 * base — the hunks pass (above) always runs first, so by the time this is called for a file's
 * sides, that file's `hunks.included` decision already exists to derive it from.
 */
function sideElisionCost(
  path: string,
  key: ConflictSideKey,
  chars: number,
  refs: ConflictRefs,
  hunksRendered: boolean,
): number {
  const hint = sideElisionHint(path, key, refs, hunksRendered);
  const textCost = SIDE_ELISION_OVERHEAD + String(chars).length + hint.text.length;
  // Real JSON.stringify of the exact `elided.<key>` shape `buildConflictFilePayload` builds — see
  // the note on `hunksElisionCost` above for why this is exact rather than decomposed further.
  const jsonCost = JSON.stringify({ chars, ref: hint.json }).length;
  return Math.max(textCost, jsonCost);
}

/**
 * Plan which parts of a conflict report to include in full.
 *
 * `detail: 'full'` is the escape hatch: everything included, nothing capped — not even
 * `CONFLICT_MAX_FILES` — for a caller that explicitly wants the complete payload and can take the
 * size.
 *
 * `detail: 'auto'` (the default a caller should use):
 *  0. Files beyond `CONFLICT_MAX_FILES` get no per-file block at all (they stay listed in the
 *     report's own `conflictPaths`, untouched by this planner).
 *  1. Every included file's header line is a mandatory, unconditional cost (it renders whether or
 *     not anything inside the file is elided) — charged up front against the budget.
 *  2. Allocate `hunks` against what's left of `CONFLICT_CONTENT_BUDGET` first, at RENDERED size —
 *     hunks get first claim because they are the least recoverable part (see
 *     {@link ConflictFilePlan.hunks}).
 *  3. Allocate `base`/`ours`/`theirs` against whatever budget remains, at RENDERED size, each ALSO
 *     capped individually at `CONFLICT_SIDE_CAP` (on raw content, regardless of remaining budget)
 *     — one huge side must never eat the whole budget and starve every other file's sides.
 *
 * Anything that does not fit is marked `included: false` with its true (untruncated) CONTENT
 * character count, never the truncated size or the rendered cost used to decide — an elided entry
 * that lied about its own size would be worse than showing nothing. Eliding is not free, either:
 * the pointer/note that replaces the dropped content is itself charged against the same budget
 * (via {@link hunksElisionCost} / {@link sideElisionCost}), so a conflict where nothing fits still
 * renders a bounded amount of "here's what got cut" text rather than one unbudgeted pointer per
 * part.
 */
export function planConflictPayload(
  files: ConflictFileDetail[],
  opts: { detail: 'auto' | 'full'; refs: ConflictRefs },
): ConflictPayloadPlan {
  if (opts.detail === 'full') {
    return { files: files.map(fullFilePlan), truncated: false };
  }
  const { refs } = opts;

  const cappedFiles = files.slice(0, CONFLICT_MAX_FILES);
  const omittedFiles = files.slice(CONFLICT_MAX_FILES).map((f) => f.path);

  let budgetRemaining = CONFLICT_CONTENT_BUDGET;
  // File headers are mandatory, not elidable — charge them up front so the passes below see what
  // is actually left for content.
  for (const f of cappedFiles) {
    budgetRemaining -= FILE_HEADER_OVERHEAD + f.path.length;
  }
  // True when the mandatory, unconditional header charge alone already exhausted the budget —
  // before any hunk or side was even considered. Recorded here (rather than inferred later from
  // `aggregateBudgetExceeded`) because it names a distinct cause: long paths, not a lot of content.
  const headersExhaustedBudget = budgetRemaining <= 0;

  let sideCapExceeded = false;
  let aggregateBudgetExceeded = false;

  // Pass 1: hunks, in file order, get first claim on the (rendered-size) budget. A file with NO
  // hunks (a pure add/delete conflict) is never "elided" — cost is 0 either way, and there is
  // nothing to report cutting — even once budgetRemaining has already gone negative from mandatory
  // headers alone. Indexed by POSITION (not a Map keyed by path) so pass 2 below can pair each
  // file with its hunks plan without a lookup that could silently miss a duplicate path.
  const hunksPlans: ConflictHunksPartPlan[] = [];
  for (const f of cappedFiles) {
    const chars = hunksChars(f.hunks);
    const cost = hunksRenderCost(f.hunks);
    const spans = hunkSpans(f.hunks);
    if (f.hunks.length === 0 || cost <= budgetRemaining) {
      budgetRemaining -= cost;
      hunksPlans.push({ included: true, chars, count: f.hunks.length, spans });
    } else {
      aggregateBudgetExceeded = true;
      budgetRemaining -= hunksElisionCost(f.hunks.length, chars, spans);
      hunksPlans.push({ included: false, chars, count: f.hunks.length, spans });
    }
  }

  // Pass 2: sides, in file order and base/ours/theirs order within a file, against what's left.
  const filePlans: ConflictFilePlan[] = cappedFiles.map((f, i) => {
    const hunksPlan = hunksPlans[i];
    if (!hunksPlan) {
      // Cannot happen: pass 1 above pushes exactly one entry per cappedFiles element, in order —
      // this is a programming error, not a runtime input the caller could trigger.
      throw new Error(
        `planConflictPayload: no hunks plan recorded for file ${i} (${f.path}) — pass 1 and ` +
          'pass 2 must iterate the same cappedFiles array in the same order',
      );
    }
    // Whether THIS file's hunks block is actually showing full overlap markers on screen — the
    // hunks pass above already decided this, so the no-merge-base hint (base only) can be honest
    // about it instead of guessing. `hunksRendered` is false for an empty `hunks: []` too (that
    // case is always `included: true` trivially, but there is nothing to point at either).
    const hunksRendered = f.hunks.length > 0 && hunksPlan.included;
    const sidePlans = {} as Record<ConflictSideKey, ConflictPartPlan>;
    for (const key of SIDE_KEYS) {
      const content = f[key];
      if (content === null) {
        // Absent on this side (added/deleted) — nothing to elide, nothing to budget.
        sidePlans[key] = { included: true, chars: 0 };
        continue;
      }
      const chars = content.length;
      if (chars > CONFLICT_SIDE_CAP) {
        sideCapExceeded = true;
        sidePlans[key] = { included: false, chars };
        budgetRemaining -= sideElisionCost(f.path, key, chars, refs, hunksRendered);
        continue;
      }
      // The structured channel is JSON: charge its real (escape-inclusive) length, not raw
      // `chars` — see the module header's third round of fixes.
      const cost = Math.max(chars + SIDE_LABEL_OVERHEAD, JSON.stringify(content).length);
      if (cost <= budgetRemaining) {
        budgetRemaining -= cost;
        sidePlans[key] = { included: true, chars };
      } else {
        aggregateBudgetExceeded = true;
        sidePlans[key] = { included: false, chars };
        budgetRemaining -= sideElisionCost(f.path, key, chars, refs, hunksRendered);
      }
    }
    return {
      path: f.path,
      hunks: hunksPlan,
      base: sidePlans.base,
      ours: sidePlans.ours,
      theirs: sidePlans.theirs,
    };
  });

  const isFileTruncated = (fp: ConflictFilePlan): boolean =>
    !fp.hunks.included || !fp.base.included || !fp.ours.included || !fp.theirs.included;
  const fileCapExceeded = omittedFiles.length > 0;
  const truncated = filePlans.some(isFileTruncated) || fileCapExceeded;
  if (!truncated) return { files: filePlans, truncated };

  const affectedFiles = filePlans.filter(isFileTruncated).length;
  const elidedParts = filePlans.reduce(
    (n, fp) =>
      n +
      (fp.hunks.included ? 0 : 1) +
      (fp.base.included ? 0 : 1) +
      (fp.ours.included ? 0 : 1) +
      (fp.theirs.included ? 0 : 1),
    0,
  );

  // Report only the reason(s) that actually fired — a file conflicted on three ~18k sides, each
  // cut individually by CONFLICT_SIDE_CAP, never touches the aggregate budget at all, and saying
  // it did would send a caller looking for a cause that isn't there.
  const reasons: string[] = [];
  if (headersExhaustedBudget) {
    // Distinct cause, named FIRST: the mandatory, unconditional per-file header charge alone
    // (long paths) already drove the budget to zero or below, before any hunk or side was even
    // considered — `aggregateBudgetExceeded` below is technically true too in this case (every
    // subsequent allocation sees a non-positive budget), but blaming only "the aggregate budget
    // was reached" would hide that the cause here is path length, not content.
    // Name the charge that actually fired — header boilerplate plus every path — not the path
    // characters alone, or the number can read as smaller than the budget it claims to have used.
    const totalHeaderChars = cappedFiles.reduce(
      (sum, f) => sum + FILE_HEADER_OVERHEAD + f.path.length,
      0,
    );
    reasons.push(
      `the ${cappedFiles.length}-file headers alone (${totalHeaderChars} chars of headers and paths) ` +
        `consumed the ${CONFLICT_CONTENT_BUDGET}-char budget, so no content could be inlined`,
    );
  }
  if (fileCapExceeded) {
    reasons.push(
      `only the first ${CONFLICT_MAX_FILES} of ${files.length} conflicted files are detailed ` +
        `below — the other ${omittedFiles.length} are still fully listed in conflictPaths`,
    );
  }
  if (sideCapExceeded) {
    reasons.push(
      `a base/ours/theirs over ${CONFLICT_SIDE_CAP} characters was elided regardless of ` +
        'remaining budget',
    );
  }
  if (aggregateBudgetExceeded) {
    reasons.push(
      `the ${CONFLICT_CONTENT_BUDGET}-char aggregate conflict payload budget was reached`,
    );
  }
  const noteParts = [`${reasons.join('; ')}.`];
  if (elidedParts > 0) {
    noteParts.push(
      `${elidedParts} part(s) across ${affectedFiles} detailed file(s) elided. An elided ` +
        "base/ours/theirs is fetchable in one call via read_file(path, ref) — see each file's " +
        'read_file pointer. An elided hunks block is named with its line spans instead; ' +
        'reconstruct it from the (fetched) sides.',
    );
  }
  return {
    files: filePlans,
    truncated,
    note: noteParts.join(' '),
    omittedFiles: fileCapExceeded ? omittedFiles : undefined,
  };
}

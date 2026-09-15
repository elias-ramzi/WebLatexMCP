import type { ConflictFileDetail, ConflictReport, RemoteCommit } from '../services/gitService.js';
import type { ConflictHunk } from './conflictParser.js';
import {
  planConflictPayload,
  renderElidedHunkSpans,
  sideElisionHint,
  CONFLICT_MAX_COMMITS,
  CONFLICT_MAX_COMMIT_FILES,
  type ConflictFilePlan,
  type ConflictHunksPartPlan,
  type ConflictPartPlan,
  type ConflictPayloadPlan,
  type ConflictRefs,
} from './conflictBudget.js';

/**
 * Render a {@link ConflictReport} into the plain text of the tool result — the part an MCP client
 * always shows the model — and into the per-file shape `push.ts` puts in `structuredContent`. Both
 * are built from the SAME {@link ConflictPayloadPlan} (see `conflictBudget.ts`), so a side or a
 * `hunks` block elided from one is elided from the other too — they can never disagree about what
 * got cut. Large parts are elided with a `read_file(path, ref)` pointer (sides) or a hunk
 * count/line-span note (hunks, which are not independently fetchable) to keep both payloads
 * bounded without losing the ability to reconstruct what was cut.
 */

/** The two report-level refs an elided side's pointer embeds, extracted once so both the plan and
 * the render below use the exact same values. */
function refsOf(report: ConflictReport): ConflictRefs {
  return { mergeBase: report.mergeBase, rebasedOnto: report.rebasedOnto };
}

function planFor(report: ConflictReport, opts?: { detail?: 'auto' | 'full' }): ConflictPayloadPlan {
  return planConflictPayload(report.files, {
    detail: opts?.detail ?? 'auto',
    refs: refsOf(report),
  });
}

/**
 * Guard shared by `renderConflictText` and `buildConflictFilePayload`: both index
 * `plan.files[i]` alongside `report.files[i]` under the assumption that the plan was built
 * FROM this exact report (in order) — a caller-supplied `plan` (see `renderConflictText`'s
 * `opts.plan`) could in principle be stale or built from a different report. Indexing past that
 * silently would render one file's plan (budget decisions, elision flags) against another
 * file's content — worse than a crash, since nothing about the output would look wrong. Throws
 * naming the index and both paths so the mismatch is obvious rather than a subtly wrong render.
 */
function assertPlanMatchesFile(i: number, fp: ConflictFilePlan, f: ConflictFileDetail): void {
  if (fp.path !== f.path) {
    throw new Error(
      `conflict payload plan does not match the report at index ${i}: plan path "${fp.path}" ` +
        `!== report path "${f.path}"`,
    );
  }
}

/**
 * The three side labels as rendered in the text channel. Exported (rather than left as inline
 * literals at each call site) so `conflictText.test.ts` can pin `SIDE_LABEL_OVERHEAD`
 * (`conflictBudget.ts`, sized off the longest of the three) against the real strings.
 */
export const SIDE_LABELS: Record<'base' | 'ours' | 'theirs', string> = {
  base: 'base (common ancestor)',
  ours: 'ours (local)',
  theirs: 'theirs (remote that landed)',
};

/**
 * Exported so `conflictText.test.ts` can pin `SIDE_ELISION_OVERHEAD` (`conflictBudget.ts`) against
 * this exact elided-branch template, the same way `renderHunkMarkers`/`fileHeaderLine` are exported
 * for their own constants.
 */
export function renderSide(
  label: string,
  content: string | null,
  part: ConflictPartPlan,
  hint: string,
): string {
  if (content === null) return `${label}: (absent — added or deleted on this side)`;
  if (!part.included) return `${label}: (${part.chars} chars, elided — ${hint})`;
  return `${label}:\n${content}`;
}

/**
 * Git-style `<<<<<<< ours / ======= / >>>>>>> theirs` blocks for the overlapping regions.
 * Exported so `conflictText.test.ts` can pin `HUNK_MARKER_OVERHEAD` (`conflictBudget.ts`) against
 * this exact template — the budget planner's rendered-size accounting depends on the two never
 * drifting apart.
 */
export function renderHunkMarkers(hunks: ConflictHunk[]): string {
  return hunks
    .map(
      (h) =>
        `<<<<<<< ours (lines ${h.startLine}-${h.endLine})\n${h.local.join('\n')}\n` +
        `=======\n${h.remote.join('\n')}\n>>>>>>> theirs`,
    )
    .join('\n');
}

/**
 * The `━━━━━ path ━━━━━` file separator line. Exported (and factored out of the inline template
 * it used to be) so `conflictText.test.ts` can pin `FILE_HEADER_OVERHEAD` (`conflictBudget.ts`)
 * against this exact format.
 */
export function fileHeaderLine(path: string): string {
  return `━━━━━ ${path} ━━━━━`;
}

/**
 * `overlap:` block for one file — the full marker view when hunks fit the budget, or (when they
 * do not) how many there were and the line span each covered, so the caller knows what to
 * reconstruct after fetching the (possibly also elided) sides. Once the rebase aborts, the marker
 * file is gone from the working tree, so this line-span note is the only clue left.
 *
 * Exported so `conflictText.test.ts` can pin `HUNK_ELISION_TEXT_OVERHEAD` (`conflictBudget.ts`)
 * against this exact elided-branch template, the same way `renderHunkMarkers`/`fileHeaderLine` are
 * exported for their own constants.
 */
export function renderHunksBlock(hunks: ConflictHunk[], part: ConflictHunksPartPlan): string {
  if (!part.included) {
    const spansText = renderElidedHunkSpans(part.spans, part.count);
    return (
      `overlap: (${part.count} hunk(s), ${part.chars} chars, elided — ${spansText}; ` +
      `fetch base/ours/theirs to reconstruct the merge)`
    );
  }
  return `overlap:\n${renderHunkMarkers(hunks)}`;
}

/**
 * Render a {@link ConflictReport} into the plain text of the tool result.
 *
 * `opts.plan`, when given, is used VERBATIM — no re-planning happens. This exists so `push.ts`
 * can call `planConflictPayload` exactly once and pass the SAME plan object to both this
 * function and `buildConflictFilePayload`, making the "both channels are built from one
 * decision" invariant hold by construction (one plan, two renderers) rather than by relying on
 * `planConflictPayload` being deterministic across two separate calls. Omit `opts.plan` to plan
 * from `report` here, exactly as before.
 */
export function renderConflictText(
  summary: string,
  report: ConflictReport,
  opts?: { detail?: 'auto' | 'full'; plan?: ConflictPayloadPlan },
): string {
  const plan = opts?.plan ?? planFor(report, opts);
  const out: string[] = [summary, '', report.guidance, ''];
  out.push(`remoteHead: ${report.remoteHead} (${report.remoteHead.slice(0, 8)})`);
  out.push('Pass remoteHead back as `expectedRemoteHead` when you resolve.');
  if (report.mergeBase) {
    out.push(`mergeBase: ${report.mergeBase} (${report.mergeBase.slice(0, 8)})`);
  }
  if (report.remoteCommits.length) {
    // Under conflictDetail: "full", structuredContent.remoteCommits DOES hold every commit (see
    // push.ts's safePushToolResult), so the default "(see structuredContent)" hint is the more
    // useful true statement there. Under "auto" (the default, opts.detail unset), that field is
    // itself capped, so point at status.behindCommits instead — see CONFLICT_COMMITS_MORE_HINT.
    const moreHint = opts?.detail === 'full' ? undefined : CONFLICT_COMMITS_MORE_HINT;
    out.push(
      '',
      `Landed upstream (${report.remoteCommits.length} commit(s)):`,
      ...renderCommitLines(report.remoteCommits, { moreHint }),
    );
  }
  out.push(
    '',
    `Conflicted file(s) (${report.conflictPaths.length}): ${report.conflictPaths.join(', ')}`,
  );
  if (plan.note) out.push(plan.note);
  // Fetch pointer for a side that's too large to inline — an exact ref, no shell needed.
  const refs = refsOf(report);
  // plan.files is capped at CONFLICT_MAX_FILES (in 'auto'; uncapped in 'full') and aligns
  // index-for-index with the FIRST plan.files.length entries of report.files.
  for (let i = 0; i < plan.files.length; i++) {
    const f = report.files[i]!;
    const fp = plan.files[i]!;
    assertPlanMatchesFile(i, fp, f);
    out.push('', fileHeaderLine(f.path));
    if (f.hunks.length || !fp.hunks.included) out.push(renderHunksBlock(f.hunks, fp.hunks));
    // Whether THIS file's hunks block is actually showing full overlap markers right now — see
    // `sideElisionHint`'s doc comment for why `base`'s no-merge-base hint needs to know this.
    const hunksRendered = f.hunks.length > 0 && fp.hunks.included;
    out.push(
      renderSide(
        SIDE_LABELS.base,
        f.base,
        fp.base,
        sideElisionHint(f.path, 'base', refs, hunksRendered).text,
      ),
    );
    out.push(
      renderSide(
        SIDE_LABELS.ours,
        f.ours,
        fp.ours,
        sideElisionHint(f.path, 'ours', refs, hunksRendered).text,
      ),
    );
    out.push(
      renderSide(
        SIDE_LABELS.theirs,
        f.theirs,
        fp.theirs,
        sideElisionHint(f.path, 'theirs', refs, hunksRendered).text,
      ),
    );
  }
  if (plan.omittedFiles && plan.omittedFiles.length) {
    out.push(
      '',
      `… ${plan.omittedFiles.length} more conflicted file(s) not detailed here — see ` +
        'conflictPaths above for their names.',
    );
  }
  return out.join('\n');
}

/** One elided part: its true (untruncated) size, and how to get the full content back. */
export interface ConflictElision {
  chars: number;
  /**
   * For a side: normally the `read_file(path, ref)` call that fetches it in full. With no merge
   * base (unrelated histories) there is no ref for `base`, so it states that instead of naming a
   * call the caller cannot make. Absent for `hunks`, which are not fetchable on their own.
   */
  ref?: string;
  /** `hunks` only: how many hunks and where, so the caller can reconstruct after fetching the sides. */
  count?: number;
  spans?: Array<{ startLine: number; endLine: number }>;
}

export interface ConflictFilePayload {
  path: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  hunks: ConflictHunk[];
  /**
   * Present iff some part of THIS file was dropped to fit the payload budget. A part's value is
   * `null` both when it is genuinely absent (added/deleted on that side) and when it was elided —
   * this record is what tells the two apart: `null` with no matching key here means absent, `null`
   * WITH a key here means elided for size (fetch it via `ref`).
   */
  elided?: {
    base?: ConflictElision;
    ours?: ConflictElision;
    theirs?: ConflictElision;
    hunks?: ConflictElision;
  };
}

/**
 * Build the structured (`push.ts`'s `structuredContent.conflictFiles`) shape from the same plan
 * `renderConflictText` uses — the two channels are built from one decision, not re-derived
 * independently, so they cannot drift apart on what got cut.
 */
export function buildConflictFilePayload(
  report: ConflictReport,
  plan: ConflictPayloadPlan,
): ConflictFilePayload[] {
  const refs = refsOf(report);

  // plan.files is capped at CONFLICT_MAX_FILES (in 'auto'; uncapped in 'full') — a file beyond the
  // cap gets no entry here at all, only in the report's own (uncapped) `conflictPaths`.
  return plan.files.map((fp, i) => {
    const f = report.files[i]!;
    assertPlanMatchesFile(i, fp, f);
    // See `renderConflictText`'s identical line — kept in sync with the text channel so both
    // select the same hint for `base` (see `sideElisionHint`'s doc comment).
    const hunksRendered = f.hunks.length > 0 && fp.hunks.included;
    const elided: NonNullable<ConflictFilePayload['elided']> = {};
    let anyElided = false;

    const sideValue = (key: 'base' | 'ours' | 'theirs'): string | null => {
      const content = f[key];
      if (content === null) return null; // genuinely absent — never marked `elided`
      const part = fp[key];
      if (!part.included) {
        anyElided = true;
        elided[key] = {
          chars: part.chars,
          ref: sideElisionHint(f.path, key, refs, hunksRendered).json,
        };
        return null;
      }
      return content;
    };

    const base = sideValue('base');
    const ours = sideValue('ours');
    const theirs = sideValue('theirs');

    let hunks = f.hunks;
    if (!fp.hunks.included) {
      anyElided = true;
      elided.hunks = { chars: fp.hunks.chars, count: fp.hunks.count, spans: fp.hunks.spans };
      hunks = [];
    }

    return { path: f.path, base, ours, theirs, hunks, ...(anyElided ? { elided } : {}) };
  });
}

/** Default `moreHint` for `renderCommitLines`'s trailing "… N more commit(s)" line — correct for
 * every caller whose OWN structuredContent field carrying these commits stays uncapped
 * (`renderRebasedOver`'s `rebasedOver`, `status`'s `behindCommits`/`aheadCommits`). The conflict
 * text overrides it (see {@link CONFLICT_COMMITS_MORE_HINT}) because that caller's
 * `structuredContent.remoteCommits` is, unlike those, itself capped — see `push.ts`'s
 * `capRemoteCommits`. */
const DEFAULT_COMMITS_MORE_HINT = '(see structuredContent)';

/** `moreHint` for the "Landed upstream" block in `renderConflictText`: pointing at
 * `structuredContent` would be misleading there, since `structuredContent.remoteCommits` is
 * ITSELF capped at `CONFLICT_MAX_COMMITS` (`capRemoteCommits` below, applied by `push.ts`) — unlike every other
 * caller of `renderCommitLines`, whose structured field lists every commit. `status.behindCommits`
 * is genuinely uncapped: after a conflict aborts the rebase, the clone is back at its pre-push
 * state, so `status` still sees (and lists) every commit the remote gained. */
const CONFLICT_COMMITS_MORE_HINT =
  '(see status.behindCommits — the clone is back at its pre-push state, so status lists them all)';

/**
 * Render commits (newest first) as text lines: `  <sha8> <subject>`, then each file the commit
 * touched as `      +<added>/-<removed> <path>` (capped at `maxFiles`, past which a "… N more
 * file(s)" line stands in), and past `maxCommits` a trailing "… N more commit(s) <moreHint>" line.
 * Shared by `renderRebasedOver` and the "Landed upstream" block below, and by `status`'s rendering
 * of the same shape. `maxCommits`/`maxFiles` default to `CONFLICT_MAX_COMMITS`/
 * `CONFLICT_MAX_COMMIT_FILES` (`conflictBudget.ts`) — named there so the structured channel's cap
 * (`capRemoteCommits` below, applied by `push.ts`) cannot drift from what this text renderer has always capped at.
 */
export function renderCommitLines(
  commits: RemoteCommit[],
  opts?: { maxCommits?: number; maxFiles?: number; moreHint?: string },
): string[] {
  const maxCommits = opts?.maxCommits ?? CONFLICT_MAX_COMMITS;
  const maxFiles = opts?.maxFiles ?? CONFLICT_MAX_COMMIT_FILES;
  const moreHint = opts?.moreHint ?? DEFAULT_COMMITS_MORE_HINT;
  const out: string[] = [];
  for (const c of commits.slice(0, maxCommits)) {
    out.push(`  ${c.hash.slice(0, 8)} ${c.message}`);
    for (const f of c.files.slice(0, maxFiles)) {
      out.push(`      +${f.added}/-${f.removed} ${f.path}`);
    }
    if (c.files.length > maxFiles) {
      out.push(`      … ${c.files.length - maxFiles} more file(s)`);
    }
  }
  if (commits.length > maxCommits) {
    out.push(`  … ${commits.length - maxCommits} more commit(s) ${moreHint}`);
  }
  return out;
}

/** One `RemoteCommit` as capped by {@link capRemoteCommits}: `files` truncated to
 * `CONFLICT_MAX_COMMIT_FILES`, with `filesOmitted` present (and only then) when that cut something. */
export interface CappedRemoteCommit extends RemoteCommit {
  filesOmitted?: number;
}

export interface CappedRemoteCommits {
  /** At most `CONFLICT_MAX_COMMITS` entries, newest first (same order as the input). */
  commits: CappedRemoteCommit[];
  /** How many commits beyond `CONFLICT_MAX_COMMITS` were dropped entirely — 0 when nothing was. */
  omitted: number;
}

/**
 * Cap a conflict's `remoteCommits` for `structuredContent` the same way `renderCommitLines` has
 * always capped them for the text channel: at most `CONFLICT_MAX_COMMITS` commits, each with at
 * most `CONFLICT_MAX_COMMIT_FILES` files. Never mutates `commits` or its entries — an untouched
 * commit is returned as-is; a commit whose files get cut is a fresh object carrying the true
 * `filesOmitted` count, never a truncated lie about how many files it touched.
 */
export function capRemoteCommits(commits: RemoteCommit[]): CappedRemoteCommits {
  const kept = commits.slice(0, CONFLICT_MAX_COMMITS);
  const capped: CappedRemoteCommit[] = kept.map((c) => {
    if (c.files.length <= CONFLICT_MAX_COMMIT_FILES) return c;
    return {
      ...c,
      files: c.files.slice(0, CONFLICT_MAX_COMMIT_FILES),
      filesOmitted: c.files.length - CONFLICT_MAX_COMMIT_FILES,
    };
  });
  return { commits: capped, omitted: Math.max(0, commits.length - CONFLICT_MAX_COMMITS) };
}

/** `remote-moved` text: what landed upstream, without calling it "rebased over" — nothing was replayed onto it. */
export function renderLandedUpstream(commits?: RemoteCommit[]): string {
  if (!commits || commits.length === 0) return '';
  return [`Landed upstream (${commits.length} commit(s)):`, ...renderCommitLines(commits)].join(
    '\n',
  );
}

/** Success text: the summary plus, when present, the remote commits the change was rebased over. */
export function renderRebasedOver(commits?: RemoteCommit[]): string {
  if (!commits || commits.length === 0) return '';
  return [
    `Rebased over ${commits.length} commit(s) that landed underneath:`,
    ...renderCommitLines(commits),
  ].join('\n');
}
